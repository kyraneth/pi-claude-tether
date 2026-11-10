import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Diagnostics only: retired variables never configure the provider. */
const ACTIVE_SUFFIXES = new Set([
  "ACCOUNT",
  "ACCOUNTS",
  "FAILOVER",
  "STATE_DIR",
  "STRICT_VERSION",
  "SETTINGS",
  "TIMEOUT_MS",
  "KEEPALIVE_MS",
  "HANDOFF_PROXY",
  "HANDOFF_WAIT_MS",
  "ALLOW_USAGE_CREDITS",
  "THINKING_DISPLAY",
]);
const REMOVED_SUFFIXES = new Set([
  "CONTEXT",
  "SYSTEM_PROMPT",
  "HERMETIC",
  "STRICT_MCP",
  "AUTOCOMPACT",
  "EPHEMERAL",
  "TOOL_RESULTS",
  "NO_AGENT_WAIT",
  "AGENT_WAIT_MS",
]);
let warned = false;
export function warnRemovedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (warned) return;
  const names = Object.keys(env)
    .filter(
      (name) => name.startsWith("PI_CLAUDE_CLI_") && env[name] !== undefined,
    )
    .sort();
  if (names.length === 0) return;
  warned = true;
  console.warn(
    `[pi-claude-tether] Ignored retired environment variables: ${names
      .map((name) => {
        const suffix = name.slice("PI_CLAUDE_CLI_".length);
        if (REMOVED_SUFFIXES.has(suffix))
          return `${name}: removed; Pi owns context (no replacement)`;
        return ACTIVE_SUFFIXES.has(suffix)
          ? `${name}: use PI_CLAUDE_TETHER_${suffix} instead`
          : `${name}: retired; consult the migration guide (no supported replacement known)`;
      })
      .join("; ")}. No old-name aliases are supported.`,
  );
}

type SelectionEntry = {
  type?: string;
  provider?: string;
  modelId?: string;
  message?: { role?: string; api?: string; provider?: string; model?: string };
};
type ModelLookup = (
  provider: string,
  modelId: string,
) => { api?: string } | undefined;

/** Mirror Pi 1.5's getBranchSelection, including virtual selection ownership. */
export function missingSessionProvider(
  branch: readonly SelectionEntry[],
  getModel: ModelLookup,
): string | undefined {
  let selection: { provider?: string; modelId?: string } | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "model_change") {
      selection = entry;
      break;
    }
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      entry.message.api === "pi-virtual"
    )
      continue;
    selection = {
      provider: entry.message.provider,
      modelId: entry.message.model,
    };
    for (let j = i - 1; j >= 0; j--) {
      const change = branch[j];
      if (change.type !== "model_change") continue;
      if (
        change.provider &&
        change.modelId &&
        getModel(change.provider, change.modelId)?.api === "pi-virtual"
      )
        selection = change;
      break;
    }
    break;
  }
  return selection?.provider === "pi-claude-cli"
    ? `Provider missing: pi-claude-cli was removed. This session cannot resume using Pi's fallback model. Explicitly select /model pi-claude-tether/${selection.modelId ?? "<model-id>"} (or another installed provider) before continuing. No provider alias or automatic migration is available.`
    : undefined;
}

/**
 * Pi 1.5 silently selects a runtime fallback for a missing saved provider.
 * Lifecycle throws are swallowed, so refuse input/summary and abort bypass runs.
 * Re-read Pi's branch rather than keeping a second selection/latch: physical
 * fallback selection is not recorded by Pi's _recordModelSelection, while even
 * equal-model explicit setModel records model_change (without model_select).
 * No retired provider registration or session-state migration is needed.
 */
export function guardRemovedSessionProvider(pi: ExtensionAPI): void {
  const missing = (ctx: ExtensionContext) =>
    missingSessionProvider(ctx.sessionManager.getBranch(), (provider, id) =>
      ctx.modelRegistry.find(provider, id),
    );
  const report = (ctx: ExtensionContext): boolean => {
    const error = missing(ctx);
    if (!error) return false;
    console.error(`[pi-claude-tether] ${error}`);
    ctx.ui.notify(error, "error");
    return true;
  };
  pi.on("session_start", (_event, ctx) => {
    report(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    report(ctx);
  });
  pi.on("input", (_event, ctx) => {
    if (report(ctx)) return { action: "handled" };
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (report(ctx)) ctx.abort();
  });
  pi.on("session_before_compact", (_event, ctx) => {
    if (report(ctx)) return { cancel: true };
  });
  pi.on("session_before_tree", (event, ctx) => {
    if (event.preparation.userWantsSummary && report(ctx))
      return { cancel: true };
  });
  pi.on("cache_warming_decision", (_event, ctx) => {
    if (missing(ctx)) return { action: "stop" };
  });
}
