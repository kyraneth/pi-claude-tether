/**
 * Pi extension entry point for pi-claude-tether.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import { registerApiDispatch } from "pi-tether-core/register";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
} from "./src/process-manager.js";
import {
  parseAccountSet,
  accountConfigDir,
  isSingleDefaultAccountSet,
  selectAccount,
  restoreAccount,
  accountsForUpdate,
  writeAccounts,
  captureLaunchAccount,
  isAccountPending,
  migrateAccountsStore,
  failoverSetting,
} from "./src/accounts.js";
import { addStartupNotice, takeStartupNotices } from "./src/startup-notices.js";
import {
  ACCOUNT_ENTRY_TYPE,
  accountsReport,
  parseAccountArgs,
  manageAccount,
  sessionAccount,
} from "./src/account-command.js";
import { writeSchemaFile, cleanupMcpConfigFiles } from "./src/mcp-config.js";
import { startHandoffBroker, stopHandoffBroker } from "./src/handoff-broker.js";
import { cleanupRuntimeDir } from "./src/runtime-dir.js";
import { retireAllCliProcesses } from "./src/cli-process.js";
import { flushRequestLedger } from "./src/request-ledger.js";
import { claudeCliStatus } from "./src/cli-version.js";
import { cliThinkingLevelMap } from "./src/thinking-config.js";
import {
  catalogThinkingLevelMap,
  cliCatalogModels,
} from "./src/cli-catalog.js";
import { rewriteOverflowMessage } from "./src/overflow.js";
import {
  buildRateLimitPayload,
  rateLimitIdentity,
  withAccount,
} from "./src/rate-limit.js";
import { piContext } from "./src/pi-context.js";
import {
  guardRemovedSessionProvider,
  warnRemovedEnvironment,
} from "./src/removed-config.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);
// Remove the schema/config temp files this process staged in tmpdir
process.on("exit", cleanupMcpConfigFiles);
// Close the handoff socket and remove its file
process.on("exit", stopHandoffBroker);
// Last: take the private runtime directory itself, socket and secret included.
process.on("exit", cleanupRuntimeDir);
// Parked CLI processes hold their stdin from us: ending pi ends them (the
// pipe closes and the CLI exits), but retire cleanly when we can.
process.on("beforeExit", () => {
  void retireAllCliProcesses("beforeExit");
});

const PROVIDER_ID = "pi-claude-tether";

/**
 * Status key carrying account rate-limit state to the front-end. Neutral
 * (not host-specific) because any pi front-end can read it.
 */
const RATE_LIMIT_STATUS_KEY = "claude-rate-limit";

/**
 * The stream runs deep inside streamSimple, which has no ExtensionContext,
 * so the ctx handed to session_start is kept for its `ui.setStatus`.
 */
let uiContext:
  { ui?: { setStatus?(key: string, text?: string): void } } | undefined;
/** Last payload pushed — the CLI repeats this event on every turn. */
let lastRateLimitJson: string | undefined;

function publishRateLimit(
  info: Record<string, unknown>,
  account?: string,
): void {
  const setStatus = uiContext?.ui?.setStatus;
  if (typeof setStatus !== "function") return;
  const payload = withAccount(
    buildRateLimitPayload(info),
    // The account name rides the status when multiple profiles are declared
    // (never the config path), so a front-end can show which subscription
    // answered. Single-profile payloads keep their exact prior shape.
    account,
  );
  // Push only on change: the event repeats every turn, and a status that
  // rewrites itself constantly is noise for whatever renders it.
  const identity = rateLimitIdentity(payload);
  if (identity === lastRateLimitJson) return;
  lastRateLimitJson = identity;
  try {
    setStatus.call(
      uiContext!.ui,
      RATE_LIMIT_STATUS_KEY,
      JSON.stringify(payload),
    );
  } catch {
    /* never break a turn over a status push */
  }
}

/** Last staged schema, handed to every spawn; undefined until pi's registry is up. */
let mcpSchema: { schemaPath: string; version: number } | undefined;

/**
 * Stage pi's custom-tool schemas on first request, then keep them in step
 * with pi's tool registry. Not done at load time: pi.getAllTools() fails
 * while extensions are still loading.
 *
 * Re-checked on EVERY request rather than locked after the first. pi packages
 * register and unregister tools at runtime — pi-mcp-adapter re-registers its
 * `mcp` gateway with a fresh description whenever an MCP server is added,
 * enabled or disabled — and a locked snapshot left the CLI advertising a
 * turn-1 tool surface for the whole session. writeSchemaFile only touches
 * disk when the surface actually changed, so the steady-state cost is one
 * getAllTools() call and a string compare.
 *
 * The CLI reads the schema through --mcp-config at spawn, so a mid-session
 * change lands on the next spawn: the version bump retires a parked process
 * (its tool list is what it advertised at connect time) and the next call
 * resumes the CLI session in a fresh process.
 *
 * Uses warn-don't-block: failure logs a warning but does not
 * prevent the provider from functioning (built-ins still work).
 */
function ensureMcpSchema(
  pi: ExtensionAPI,
  context: Parameters<typeof piContext>[0],
): { schemaPath: string; version: number } | undefined {
  // The request, not the registry, is authoritative: inactive tools stay inactive.
  const toolDefs = piContext(context).tools.map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
  const { schemaPath, changed, version } = writeSchemaFile(toolDefs);
  mcpSchema = { schemaPath, version };
  if (changed) {
    console.error(
      `[pi-claude-tether] MCP config generated with ${toolDefs.length} tool(s)`,
    );
  }
  return mcpSchema;
}

/**
 * The handoff socket the schema server calls back into. Started once, on the
 * first turn; a failure to bind logs once and leaves proxied handoffs off (the
 * provider then falls back to interrupt-and-resume for custom tools).
 */
let handoffSocket: string | undefined;
let handoffSocketAttempted = false;
async function ensureHandoffSocket(): Promise<string | undefined> {
  if (handoffSocket || handoffSocketAttempted) return handoffSocket;
  handoffSocketAttempted = true;
  try {
    handoffSocket = await startHandoffBroker();
  } catch (err) {
    console.warn(
      "[pi-claude-tether] handoff socket unavailable, custom tools fall back to interrupt-and-resume:",
      err,
    );
  }
  return handoffSocket;
}

/** Deliver load-time configuration notices where the user can see them. */
function flushStartupNotices(ctx: unknown): void {
  const c = ctx as
    | { hasUI?: boolean; ui?: { notify?: (m: string, l: string) => void } }
    | undefined;
  for (const message of takeStartupNotices()) {
    if (c?.hasUI && c.ui?.notify)
      c.ui.notify(`pi-claude-tether: ${message}`, "warning");
    else console.warn(`[pi-claude-tether] ${message}`);
  }
}

export default function (pi: ExtensionAPI) {
  warnRemovedEnvironment();
  try {
    migrateAccountsStore();
    failoverSetting(); // validates the variable once, raising a notice if unrecognised
  } catch (error) {
    addStartupNotice(
      `Claude account settings unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Registered before provider setup so notices still arrive when it fails
  // (for example, a missing CLI).
  pi.on("session_start", (_event: unknown, ctx: unknown) =>
    flushStartupNotices(ctx),
  );
  guardRemovedSessionProvider(pi);
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    // Warns asynchronously; never holds up registration. Owned by this
    // extension's lifecycle: session_shutdown ends the probe, so a hung
    // `claude auth status` cannot keep Pi from exiting.
    const authProbe = new AbortController();
    // Every declared profile is probed under its own CLAUDE_CONFIG_DIR so
    // the login hint names the exact directory that needs `claude auth login`.
    // Only the untouched legacy shape inherits the environment.
    const startupAccounts = parseAccountSet();
    // The account Pi was launched with: what a session without its own
    // recorded switch uses.
    const launchAccount = captureLaunchAccount();
    const singleDefaultStartup = isSingleDefaultAccountSet(startupAccounts);
    for (const name of startupAccounts) {
      void validateCliAuth(
        authProbe.signal,
        singleDefaultStartup ? undefined : accountConfigDir(name),
      );
    }

    // Pi's built-in Claude models plus any newer ones Claude Code offers.
    // Rebuilt after each run so a model the CLI just learned about reaches
    // /model without restarting Pi.
    const buildModels = () => {
      const models = getModels("anthropic").map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        // Best-effort prompt-cache lifetime in seconds per retention tier,
        // the shape Pi 1.4.0 documents (models.md "Prompt Cache Lifetimes")
        // and pi-cache-optimizer writes for anthropic models (short 300,
        // long 3600: Anthropic's documented 5m/1h, the values Pi ships for its
        // own Claude models). Declaring it lets Pi's own machinery see the
        // cache: /session economics instead of "cache economics unavailable".
        // It does not enable any refresh through the CLI — this extension
        // declines Pi-driven refreshes for its provider (see below), so the
        // lifetime feeds visibility only.
        promptCache: { short: 300, long: 3600 },
        // pi's own per-model map, less `minimal` on adaptive models (it would
        // send what `low` sends), so the selector offers only levels the model
        // has, and each maps to the effort pi uses (resolveCliThinking reads
        // it). It used to be widened to { xhigh, max } for every model, which
        // offered xhigh/max on budget models that ignore effort, xhigh on
        // Opus/Sonnet 4.6, and `off` on models whose thinking cannot be off.
        thinkingLevelMap: cliThinkingLevelMap(model),
      }));

      // Models Claude Code offers that this Pi release does not know yet
      // (a model launched after Pi shipped). Pi's own entry wins whenever it
      // exists; the CLI's cached catalog only adds what is missing. Cost is
      // not in the catalog and is left at zero rather than guessed: these
      // turns are billed to the subscription, not per token.
      const known = new Set(models.map((m) => m.id));
      for (const entry of cliCatalogModels(
        startupAccounts.map((name) => accountConfigDir(name)),
      )) {
        if (known.has(entry.id)) continue;
        models.push({
          id: entry.id,
          name: entry.name,
          reasoning: entry.reasoning,
          input: entry.input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          promptCache: { short: 300, long: 3600 },
          thinkingLevelMap: catalogThinkingLevelMap(entry),
        } as (typeof models)[number]);
      }
      return models;
    };
    let models = buildModels();

    const restoreSessionAccount = (ctx: unknown) => {
      // Resume on the account this session last switched to, or the one Pi
      // was launched with. A no longer declared account falls back too.
      const branch =
        (
          ctx as {
            sessionManager?: {
              getBranch?(): Array<{
                type?: string;
                customType?: string;
                data?: unknown;
              }>;
            };
          }
        )?.sessionManager?.getBranch?.() ?? [];
      try {
        restoreAccount(sessionAccount(branch, launchAccount));
      } catch {
        // Invalid/pending restored intent keeps failing loudly at the first turn.
      }
    };
    // Never change pi's active tools simply because this provider is installed.
    pi.on("session_start", async (_event: unknown, ctx: unknown) => {
      await retireAllCliProcesses("session_start");
      uiContext = ctx as typeof uiContext;
      restoreSessionAccount(ctx);
      lastRateLimitJson = undefined;
    });

    const retire = async (event: { type: string }) => {
      await retireAllCliProcesses(event.type);
      uiContext?.ui?.setStatus?.(RATE_LIMIT_STATUS_KEY, undefined);
      lastRateLimitJson = undefined;
    };
    pi.on("model_select", retire);
    pi.on("session_shutdown", async (event: { type: string }) => {
      authProbe.abort();
      await retire(event);
      // Orderly shutdown owns the ledger's durability: retire rows are queued
      // best-effort writes, and a process exit can otherwise lose exactly the
      // retirement rows proofs read back (flushRequestLedger is the seam).
      await flushRequestLedger();
    });
    pi.on("session_tree", async (event, ctx) => {
      await retire(event);
      restoreSessionAccount(ctx);
    });
    pi.on("session_compact", retire);

    // Never warm the cache through the CLI. Pi's own refresher re-sends
    // the request with a one-token cap through this provider: a real extra
    // billed turn, potentially importing history and re-running tools.
    // The declared lifetime above feeds /session economics visibility only:
    // refreshes for this provider are always declined here. Other providers
    // are untouched — returning nothing leaves their decision to Pi and
    // other extensions.
    pi.on("cache_warming_decision", (_event, ctx) => {
      if (ctx.model?.provider === PROVIDER_ID)
        return { action: "stop" as const };
    });

    pi.registerCommand("claude-accounts", {
      description:
        "Manage official CLI accounts: list, add, login, status, switch, remove, failover, doctor",
      getArgumentCompletions: (prefix: string) => {
        const options = [
          "list",
          "add",
          "login --all",
          "status",
          "doctor",
          "failover on",
          "failover off",
          ...parseAccountSet()
            .filter((name) => !isAccountPending(name))
            .map((name) => `switch ${name}`),
        ];
        const items = options
          .filter((o) => o.startsWith(prefix))
          .map((o) => ({ value: o, label: o }));
        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        const parsed = parseAccountArgs(args);
        flushStartupNotices(ctx);
        try {
          if (parsed.action === "switch") {
            const account = selectAccount(parsed.account);
            if (parsed.persistent) {
              const store = accountsForUpdate();
              if (!store.accounts.some((a) => a.name === account))
                store.accounts.push({ name: account });
              store.default = account;
              writeAccounts(store);
            }
            pi.appendEntry(ACCOUNT_ENTRY_TYPE, { account });
            // Warm processes belong to the old account; the next turn spawns
            // on the new one and imports the history (a cache write there).
            await retire({ type: "account_switch" });
            ctx.ui.notify(
              await accountsReport(ctx.signal ?? undefined),
              "info",
            );
          } else {
            await manageAccount(parsed, ctx.ui, ctx.signal ?? undefined, () =>
              retire({ type: "account_auth_or_remove" }),
            );
          }
        } catch (err) {
          ctx.ui.notify(
            err instanceof Error ? err.message : String(err),
            "error",
          );
        }
      },
    });

    pi.registerCommand("claude-cli", {
      description:
        "Show the installed Claude Code CLI version, the tested range, and npm latest",
      handler: async (_args, ctx) => {
        ctx.ui.notify(await claudeCliStatus(ctx.signal ?? undefined), "info");
      },
    });

    const streamFn = (
      model: Parameters<typeof streamViaCli>[0],
      context: Parameters<typeof streamViaCli>[1],
      options?: Parameters<typeof streamViaCli>[2],
    ) => {
      // Build the MCP catalog only after the provider applies any Pi
      // before_provider_request replacement. A replacement tool set must be
      // the one Claude is offered, not merely the one the hook observed.
      return streamViaCli(model, context, {
        ...options,
        prepareMcpConfig: async (effectiveContext) => {
          const schema = ensureMcpSchema(pi, effectiveContext);
          return schema
            ? { ...schema, handoffSocket: ensureHandoffSocket() }
            : undefined;
        },
        onRateLimit: publishRateLimit,
      });
    };

    // pi.registerProvider() feeds pi's provider composer, but pi 0.84's
    // default stream fn (@earendil-works/pi-agent-core setDefaultStreamFn) resolves
    // model.api against pi-ai's global api registry instead — print mode
    // and nested agent loops take that path and would throw
    // "No API provider registered for api: pi-claude-tether".
    // Register the custom api id there too.
    registerApiDispatch(PROVIDER_ID, streamFn);

    // Overflow recovery: rewrite provider-scoped context-limit errors to
    // the prefix pi's auto-compaction recognizes (see src/overflow.ts).

    (pi.on as any)("message_end", (event: any, ctx: any) => {
      return rewriteOverflowMessage(event?.message ?? {}, ctx?.model?.provider);
    });

    const registerProvider = () =>
      pi.registerProvider(PROVIDER_ID, {
        baseUrl: "pi-claude-tether",
        apiKey: "unused",
        api: "pi-claude-tether",
        models,
        streamSimple: streamFn,
      });
    registerProvider();

    // A run may have refreshed Claude Code's catalog (it does on a real
    // turn). Re-register only when the model set actually changed;
    // registration after startup takes effect immediately.
    pi.on("agent_end", () => {
      const next = buildModels();
      const ids = (list: typeof models) => list.map((m) => m.id).join(",");
      if (ids(next) === ids(models)) return;
      models = next;
      registerProvider();
    });
  } catch (err) {
    console.error(`[pi-claude-tether] Failed to register provider:`, err);
  }
}
