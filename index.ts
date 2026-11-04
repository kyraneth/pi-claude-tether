/**
 * Pi extension entry point for pi-claude-cli.
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
} from "./src/accounts.js";
import {
  getCustomToolDefs,
  writeSchemaFile,
  cleanupMcpConfigFiles,
} from "./src/mcp-config.js";
import { startHandoffBroker, stopHandoffBroker } from "./src/handoff-broker.js";
import { cleanupRuntimeDir } from "./src/runtime-dir.js";
import { retireAllCliProcesses } from "./src/cli-process.js";
import { flushRequestLedger } from "./src/request-ledger.js";
import { claudeCliStatus } from "./src/cli-version.js";
import { cliThinkingLevelMap } from "./src/thinking-config.js";
import { rewriteOverflowMessage } from "./src/overflow.js";
import {
  buildRateLimitPayload,
  rateLimitIdentity,
  withAccount,
} from "./src/rate-limit.js";
import type { TaskTrackerState } from "./src/types.js";
import { usesPiContext } from "./src/context-policy.js";
import { piContext } from "./src/pi-context.js";

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

const PROVIDER_ID = "pi-claude-cli";

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

/**
 * Live sub-agent state, on its own status key.
 *
 * Same reasoning as the rate-limit channel: this is state ABOUT the turn, not
 * content OF it. `task_progress` fires once per sub-agent tool call, so folding
 * frequent progress updates into the transcript would bury the turn and cost
 * context on every later replay. The durable half — one marker when a
 * sub-agent starts, one when it finishes —
 * goes in the turn instead, and needs no host change to render.
 */
const SUBAGENTS_STATUS_KEY = "claude-subagents";
/** Last payload pushed, so an unchanged snapshot does not rewrite the status. */
let lastSubagentsJson: string | undefined;

function publishTaskProgress(state: TaskTrackerState): void {
  const setStatus = uiContext?.ui?.setStatus;
  if (typeof setStatus !== "function") return;
  const json = JSON.stringify(state);
  if (json === lastSubagentsJson) return;
  lastSubagentsJson = json;
  try {
    // An empty snapshot means the episode is over: CLEAR the key rather than
    // pushing `{"tasks":[],...}`. A host reads a present status as live
    // state, so an empty one left standing is a strip that still claims
    // agents when there are none.
    setStatus.call(
      uiContext!.ui,
      SUBAGENTS_STATUS_KEY,
      state.tasks.length === 0 ? undefined : json,
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
  try {
    // The request, not the registry, is authoritative: inactive tools stay inactive.
    const toolDefs = usesPiContext()
      ? piContext(context).tools.map((t: any) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        }))
      : getCustomToolDefs(pi);

    const { schemaPath, changed, version } = writeSchemaFile(toolDefs);
    mcpSchema = { schemaPath, version };
    if (changed) {
      console.error(
        `[pi-claude-cli] MCP config generated with ${toolDefs.length} custom tool(s)`,
      );
    }
  } catch (err) {
    if (usesPiContext()) throw err;
    console.warn(
      "[pi-claude-cli] MCP config generation failed, custom tools unavailable:",
      err,
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
      "[pi-claude-cli] handoff socket unavailable, custom tools fall back to interrupt-and-resume:",
      err,
    );
  }
  return handoffSocket;
}

export default function (pi: ExtensionAPI) {
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
    const singleDefaultStartup = isSingleDefaultAccountSet(startupAccounts);
    for (const name of startupAccounts) {
      void validateCliAuth(
        authProbe.signal,
        singleDefaultStartup ? undefined : accountConfigDir(name),
      );
    }

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

    // Never change pi's active tools simply because this provider is installed.
    pi.on("session_start", async (_event: unknown, ctx: unknown) => {
      await retireAllCliProcesses("session_start");
      uiContext = ctx as typeof uiContext;
      lastRateLimitJson = undefined;
      lastSubagentsJson = undefined;
    });

    const retire = async (event: { type: string }) => {
      await retireAllCliProcesses(event.type);
      uiContext?.ui?.setStatus?.(RATE_LIMIT_STATUS_KEY, undefined);
      uiContext?.ui?.setStatus?.(SUBAGENTS_STATUS_KEY, undefined);
      lastRateLimitJson = undefined;
      lastSubagentsJson = undefined;
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
    pi.on("session_tree", retire);
    pi.on("session_compact", retire);

    // Never warm the cache through the CLI. Pi's own refresher re-sends
    // the request with a one-token cap through this provider: a real extra
    // billed turn (a full-history import on a new CLI process, or an
    // appended turn under legacy --resume, possibly re-running tools).
    // The declared lifetime above feeds /session economics visibility only:
    // refreshes for this provider are always declined here. Other providers
    // are untouched — returning nothing leaves their decision to Pi and
    // other extensions.
    pi.on("cache_warming_decision", (_event, ctx) => {
      if (ctx.model?.provider === PROVIDER_ID)
        return { action: "stop" as const };
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
        onTaskProgress: publishTaskProgress,
      });
    };

    // pi.registerProvider() feeds pi's provider composer, but pi 0.84's
    // default stream fn (@earendil-works/pi-agent-core setDefaultStreamFn) resolves
    // model.api against pi-ai's global api registry instead — print mode
    // and nested agent loops take that path and would throw
    // "No API provider registered for api: pi-claude-cli".
    // Register the custom api id there too.
    registerApiDispatch(PROVIDER_ID, streamFn);

    // Overflow recovery: rewrite provider-scoped context-limit errors to
    // the prefix pi's auto-compaction recognizes (see src/overflow.ts).

    (pi.on as any)("message_end", (event: any, ctx: any) => {
      return rewriteOverflowMessage(event?.message ?? {}, ctx?.model?.provider);
    });

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple: streamFn,
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
