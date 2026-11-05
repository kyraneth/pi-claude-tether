import { endStreamWithError } from "pi-tether-core/pi-stream";
import { requestSignature, matchesPrefix } from "pi-tether-core/request";
/**
 * Provider orchestration — observer mode with CLI-owned built-in tools.
 *
 * The Claude CLI owns its loop, its tools, and its session. streamViaCli:
 * 1. Resolves the pi session's CLI session (session-map) — resume, or
 *    create/import a fresh one from pi's full history
 * 2. Reuses the session's live CLI process when one is parked (0.7.0), or
 *    spawns `claude -p` and writes the turn's prompt to stdin as NDJSON
 * 3. Streams events to pi: prose/thinking verbatim; the CLI's own tool
 *    executions as `[Claude Code · Name]` markers; HANDOFF tools (custom pi
 *    tools) as real pi toolCall blocks
 * 4. On a handoff tool at message_stop: ends pi's stream with
 *    stopReason=toolUse so pi executes the tool, while the CLI blocks on the
 *    proxied `tools/call`; the next pi call answers it on the SAME process
 *    (src/handoff-broker.ts, src/cli-process.ts). Without the proxy (no pi
 *    session id, or PI_CLAUDE_CLI_HANDOFF_PROXY=0) it falls back to a clean
 *    `interrupt` — never a kill, which corrupts the CLI transcript
 * 5. After `result`: parks the process for the next turn (idle timer) instead
 *    of killing it, so the CLI's system prompt — and its git snapshot — is
 *    built once per session, not once per call
 * 6. Hardened lifecycle: inactivity timeout, exit handler, streamEnded
 *    guard, abort = interrupt + delayed SIGKILL backstop, process registry
 */

import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
} from "./prompt-builder.js";
import {
  parseAccountSet,
  pickInitialAccount,
  failoverEnabled,
  accountConfigDir,
  isSingleDefaultAccountSet,
  markAccountExhausted,
  selectFailoverAccount,
  accountResetTimes,
} from "./accounts.js";
import { resolveSystemPromptMode } from "./system-prompt-mode.js";
import {
  usesPiContext,
  assertContextPolicy,
  ContextPolicyError,
} from "./context-policy.js";
import {
  spawnClaude,
  verifyContextCli,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
  sendInterrupt,
} from "./process-manager.js";
import { createEventBridge } from "./event-bridge.js";
import { isTaskSubtype } from "./task-tracker.js";
import type {
  ClaudeModelUsage,
  ClaudeUsage,
  TaskTrackerState,
} from "./types.js";
import { resolveCliThinking } from "./thinking-config.js";
import { isHandoffClaudeTool, mapClaudeToolNameToPi } from "./tool-mapping.js";
import { resolveAutocompact } from "./autocompact.js";
import {
  getCliSession,
  setCliSession,
  clearCliSession,
  getSystemPrompt,
  setSystemPrompt,
  clearSystemPrompt,
} from "./session-map.js";
import { writeSessionMcpConfig, removeSessionMcpConfig } from "./mcp-config.js";
import {
  CliProcess,
  getCliLifecycleRevision,
  parkCliProcess,
  takeParkedCliProcess,
  addUsage,
  subUsage,
  maxUsage,
  ZERO_USAGE,
  type Usage4,
  type EpisodeSink,
} from "./cli-process.js";
import type { HandoffResult } from "./handoff-broker.js";
import { handoffSecretFile } from "./handoff-broker.js";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { RequestLedger, lastRetirementCause } from "./request-ledger.js";
import {
  allowUsageCredits,
  isOverageBilled,
  rateLimitHeaders,
} from "./rate-limit.js";

function schemaBytes(path: string | undefined): number | null {
  if (!path) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Field names of the parked-process signature, in order. */
const SIGNATURE_FIELDS = [
  "model",
  "systemPromptMode",
  "piContext",
  "systemPrompt",
  "cwd",
  "mcpConfigPath",
  "schemaPath",
  "toolSchemaVersion",
  "handoffSocket",
  "autocompact",
  "allowHandoff",
  "settings",
  // The Claude account profile: a warm process is never reused across accounts.
  "account",
] as const;

/**
 * Name the changed launch/history fields without recording their values.
 * These reasons also identify the replacement process's spawn cause.
 */
function retireReasons(r: {
  forceFullReplay: boolean;
  stale: boolean;
  historyMatches: boolean;
  previous: string;
  next: string;
  turnActive: boolean;
}): string[] {
  const reasons: string[] = [];
  if (r.forceFullReplay) reasons.push("forceFullReplay");
  if (r.stale) reasons.push("staleHistory");
  if (!r.historyMatches) reasons.push("historyMismatch");
  if (r.previous !== r.next) {
    const a = JSON.parse(r.previous) as unknown[];
    const b = JSON.parse(r.next) as unknown[];
    SIGNATURE_FIELDS.forEach((name, i) => {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) reasons.push(name);
    });
  }
  if (reasons.length === 0)
    reasons.push(r.turnActive ? "handoffDeltaNotContinuable" : "deltaShape");
  return reasons;
}
import {
  piContext as normalizePiContext,
  historyHash,
  replayPiMessages,
} from "./pi-context.js";

/**
 * Inactivity timeout. CLI-side tool executions (web search, user MCP
 * servers, sub-agents) can be silent on stdout for minutes, so the default
 * is generous and overridable via PI_CLAUDE_CLI_TIMEOUT_MS.
 */
const INACTIVITY_TIMEOUT_MS =
  Number(process.env.PI_CLAUDE_CLI_TIMEOUT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_TIMEOUT_MS)
    : 300_000;

/**
 * BACKGROUND SUB-AGENTS REPORT BACK, AND THIS IS WHY THEY DIDN'T.
 *
 * The CLI may emit `result` while background agents are still running.
 * It can resume model work after a background task reports, so closing the
 * process at that first result would discard pending agent work.
 *
 * So the fix is to stop killing: while `pendingAgents()` is non-zero, a
 * `result` is a cycle boundary, not the end of the episode. Two bounds keep a
 * runaway fan-out from holding a turn open forever — the inactivity timer
 * (which `task_progress` keeps resetting for as long as agents do real work)
 * and the wall clock below.
 */
const WAIT_FOR_AGENTS = process.env.PI_CLAUDE_CLI_NO_AGENT_WAIT !== "1";

/** Hard ceiling on holding a turn open for sub-agents. */
const AGENT_WAIT_TIMEOUT_MS =
  Number(process.env.PI_CLAUDE_CLI_AGENT_WAIT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_AGENT_WAIT_MS)
    : 900_000;

/**
 * THE CLI CAN ANSWER A PROMPT THAT IS NOT OURS, AND THAT USED TO EAT A TURN.
 *
 * On `--resume` the CLI drains its own queue first. A session whose previous
 * turn launched a background task gets a `<task-notification>` enqueued ahead
 * of our prompt ("background shell command task(s) from the previous session
 * have no completion record") — orphaned because the pre-0.7.0 provider
 * exited the CLI at the end of every turn. The CLI dequeues the notification,
 * decides it needs no reply, and emits `result` in under a second, having
 * never called the model. Our prompt is still queued behind it.
 *
 * Ending the episode on that `result` is what made the user's first message
 * (and often the second) do nothing: pi got an assistant message with empty
 * content and zero tokens, and the CLI transcript was left ending on an
 * unanswered user entry — so the NEXT `--resume` spliced "Continue from where
 * you left off." / "No response requested." filler in to repair it. That
 * filler changes the cached prefix, so the whole conversation re-billed as
 * cache WRITE.
 *
 * So a `result` that carried no content AND spent no tokens is a cycle
 * boundary, not the end of the episode (agustinsacco/pi-claude-cli#33,
 * folded in here). A persistent process makes the orphaning rare — the
 * process that launched the task usually still runs — but a retire-and-resume
 * can still hit it. It ends when the CLI's own queue drains (each empty
 * result consumes one queued prompt), or by the inactivity timer if the CLI
 * has genuinely gone quiet, or by pi's abort. No count cap by design: the
 * queue is finite. Not a guard against a CLI that emits empty results forever:
 * every output line counts as activity, so only pi's abort ends that case.
 */

/**
 * How long a parked CLI process waits for the next turn before it is retired.
 * By default exactly as long as its prompt cache lives: a
 * process kept past that would rebuild the cache anyway, and one retired
 * earlier throws away a warm cache the next turn could have read.
 * PI_CLAUDE_CLI_KEEPALIVE_MS overrides;
 * `0`/`off` parks nothing, as before 0.7.0 (handoffs still keep it alive).
 */
function keepaliveMs(cli: CliProcess): number {
  const raw = (process.env.PI_CLAUDE_CLI_KEEPALIVE_MS ?? "")
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "none")
    return 0;
  const n = Number(raw);
  if (raw !== "" && Number.isFinite(n) && n > 0) return n;
  // A turn that reported no usage still left whatever it cached at the default TTL.
  const expires = cli.cacheExpiresAt ?? Date.now() + cli.cacheTtlMs;
  return Math.max(0, expires - Date.now());
}

/**
 * Ceiling on a process blocked in a proxied handoff with no pi call coming
 * back (pi aborted the tool, crashed, or moved on). Sub-agent handoffs run
 * for a long time legitimately, so this is generous; the process is
 * interrupted and retired when it fires.
 */
const HANDOFF_WAIT_MS =
  Number(process.env.PI_CLAUDE_CLI_HANDOFF_WAIT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_HANDOFF_WAIT_MS)
    : 1_800_000;

/** Kill switch for the proxied handoff (falls back to interrupt-and-resume). */
function handoffProxyAllowed(): boolean {
  return process.env.PI_CLAUDE_CLI_HANDOFF_PROXY !== "0";
}

// Response-hook replay must not register an MCP tool-use twice, even when
// held frames move to the next episode. Weak references do not retain history.
const observedHandoffFrames = new WeakSet<object>();

export function isResponseBoundaryFrame(
  msg: { type?: string; subtype?: string },
  reused: boolean,
): boolean {
  // A fresh process acknowledges initialization. A parked process already
  // acknowledged it on an earlier turn and emits only new body frames.
  return (
    (msg.type === "system" && msg.subtype === "init") ||
    (reused && (msg.type === "stream_event" || msg.type === "result"))
  );
}

/** Extended stream options: pi's SimpleStreamOptions plus host plumbing. */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  /** Pre-built `--mcp-config` file used verbatim (tests, legacy hosts). */
  mcpConfigPath?: string;
  /**
   * The staged custom-tool schema and the handoff socket. The provider writes
   * one config file per CLI session from these so the schema server can route
   * proxied tool calls back to that session.
   */
  mcpConfig?: {
    schemaPath: string;
    /** Bumped whenever the schema file is rewritten. */
    version: number;
    /** Handoff socket path, or a promise of one (the broker starts lazily). */
    handoffSocket?: string | Promise<string | undefined>;
  };
  /** Build the MCP catalog from the effective (post-hook) request. */
  prepareMcpConfig?: (context: {
    messages: any[];
    systemPrompt?: string;
    tools?: any[];
  }) => Promise<StreamViaCLiOptions["mcpConfig"]>;
  /** Called with account rate-limit state as the CLI reports it. */
  onRateLimit?: (info: Record<string, unknown>, account?: string) => void;
  /**
   * Called with live sub-agent state as the CLI reports it. Ephemeral: this is
   * progress, not transcript, and must never be folded into turn content. The
   * durable half (start/finish) rides in the turn as markers instead.
   */
  onTaskProgress?: (state: TaskTrackerState) => void;
};

/**
 * The mapped CLI session is stale when pi's history moved on without it:
 * an assistant turn from another provider (model switch) after — or with no —
 * pi-claude-cli turn means the CLI never saw that exchange. Resuming would
 * answer from a conversation missing turns, so reimport instead.
 */
function cliSessionIsStale(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return !(m?.provider === "pi-claude-cli" || m?.api === "pi-claude-cli");
  }
  return false; // no assistant turns at all: nothing to be behind
}

/** Pi can append this local failure after aborting a tool, without a CLI call. */
function isUnsentPiFailure(message: any): boolean {
  return message?.role === "assistant" &&
    (message.provider === "pi-claude-cli" || message.api === "pi-claude-cli") &&
    (message.stopReason === "error" || message.stopReason === "aborted") &&
    Array.isArray(message.content) && message.content.length === 0 &&
    !!message.usage &&
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(k => message.usage[k] === 0);
}

/** Pi owns transient-error classification as well as its retry policy. */
function isTransientApiError(error: string): boolean {
  if (/(?:authentication|unauthorized|invalid.*key|context_length|prompt is too long)/i.test(error)) return false;
  return isRetryableAssistantError({ stopReason: "error", errorMessage: retryableDiagnostic(error) } as any);
}

/** Pi 1.1.0 recognizes connection error/server error, not ECONNRESET/529 alone. */
function retryableDiagnostic(error: string): string {
  if (/ECONNRESET|connection reset/i.test(error)) return `connection error: ${error}`;
  if (/\b529\b/.test(error) && !/overloaded/i.test(error)) return `server error: ${error}`;
  return error;
}

/** Messages after the last assistant turn: what this call adds. */
function deltaMessages(messages: any[]): any[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  return messages.slice(lastAssistantIdx + 1);
}

/** pi toolResult content → MCP tool result the CLI understands. */
export function toHandoffResult(msg: any): HandoffResult {
  const content: HandoffResult["content"] = [];
  const raw = msg?.content;
  if (typeof raw === "string") {
    content.push({ type: "text", text: raw });
  } else if (Array.isArray(raw)) {
    for (const block of raw) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        content.push({
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        });
      } else {
        try {
          content.push({ type: "text", text: JSON.stringify(block) });
        } catch {
          /* unserializable block — skip */
        }
      }
    }
  } else if (raw != null) {
    try {
      content.push({ type: "text", text: JSON.stringify(raw) });
    } catch {
      /* skip */
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return msg?.isError ? { content, isError: true } : { content };
}

function usage4(u: ClaudeUsage | undefined): Usage4 {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function sumModelUsage(
  modelUsage: Record<string, ClaudeModelUsage> | undefined,
): Usage4 | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.values(modelUsage);
  if (entries.length === 0) return undefined;
  let total = ZERO_USAGE;
  for (const e of entries) {
    total = addUsage(total, {
      input_tokens: e.inputTokens ?? 0,
      output_tokens: e.outputTokens ?? 0,
      cache_read_input_tokens: e.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: e.cacheCreationInputTokens ?? 0,
    });
  }
  return total;
}

function bridgeUsage4(output: any): Usage4 {
  const u = output?.usage ?? {};
  return {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: u.cacheWrite ?? 0,
  };
}

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: resolve/resume the CLI session,
 * reuse or spawn the process, write the prompt or answer the pending handoff,
 * parse NDJSON, bridge events, handle result, park or clean up.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and MCP plumbing
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string; tools?: any[] },
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const piOwned = usesPiContext();
  let replayUsage = ZERO_USAGE;
  let replayContextTokens = 0;
  const lifecycleRevision = getCliLifecycleRevision();
  let payloadPrepared = false;
  let effectiveMcpConfig: StreamViaCLiOptions["mcpConfig"];
  const invalidated = () => lifecycleRevision !== getCliLifecycleRevision();
  const cancelled = () => !!options?.signal?.aborted || invalidated();
  // pi 0.86+ sends its prompt and tools as system messages and leaves
  // systemPrompt empty. Both policies read the current ones from there.
  context = normalizePiContext(context);
  function applyReplayUsage(target: ReturnType<typeof createEventBridge>): void {
    if (!Object.values(replayUsage).some(value => value !== 0)) return;
    const latestContext = target.getOutput().usage.totalTokens || replayContextTokens;
    target.applyResult({ usage: addUsage(bridgeUsage4(target.getOutput()), replayUsage) } as any);
    // Spend adds across attempts; context occupancy belongs to the latest one.
    if (latestContext) target.getOutput().usage.totalTokens = latestContext;
  }
  function failPiRequest(error: string, reason: "error" | "aborted" = "error") {
    const bridge = createEventBridge(stream, model);
    applyReplayUsage(bridge);
    const message = bridge.getOutput();
    endStreamWithError(stream, message, error, reason);
  }
  if (piOwned && options?.signal?.aborted) {
    failPiRequest("Request aborted", "aborted");
    return stream;
  }

  // The Claude account this Pi process runs under: the manually selected
  // profile (PI_CLAUDE_CLI_ACCOUNT), defaulting to the existing one. A
  // configuration error fails the turn loudly instead of guessing a profile.
  let accountSet: string[];
  let attemptAccount: string;
  try {
    accountSet = parseAccountSet();
    attemptAccount = pickInitialAccount(accountSet);
  } catch (err: unknown) {
    failPiRequest(err instanceof Error ? err.message : String(err));
    return stream;
  }
  const multiAccount = accountSet.length > 1;
  // Only the untouched legacy shape omits the account. Any declared set —
  // even a single named entry — spawns, probes, ledgers and statuses under
  // the selected account's own directory, so a manual selection can never
  // silently run on another profile. Single-profile calls pass
  // undefined so both keep their exact prior shape.
  const singleDefault = isSingleDefaultAccountSet(accountSet);
  const accountLabel = (name: string): string | undefined =>
    singleDefault ? undefined : name;
  // The last zero-output rejection, for the all-exhausted error.
  let lastFailover: { error: string; from: string } | undefined;

  /**
   * One attempt. Returns "resume-miss" (without touching the stream) when the
   * sidecar pointed --resume at a CLI session that no longer exists on disk.
   * The driver below retries once with a fresh session imported from pi's
   * full history, re-recording the mapping.
   */
  async function runOnce(
    forceFullReplay: boolean,
  ): Promise<"ok" | "resume-miss" | "receipt-replay" | "account-failover"> {
    let cli: CliProcess | undefined;
    let abortHandler: (() => void) | undefined;
    let resumeMiss = false;
    let receiptReplay = false;
    let accountFailover = false;
    // Subscription-limit rejection reported by the CLI this attempt. Only a
    // zero-output failure may fail over; anything emitted keeps today's failure.
    let rejectedResetsAt: number | undefined;
    // Whether the CLI reported overage billing this attempt (usage-credit
    // guard). Independent of the rejection above: even a successful turn
    // billed to overage fails unless opted in.
    let overageBilled = false;
    // Latest rate-limit state observed this attempt, forwarded to Pi's
    // after_provider_response as anthropic-ratelimit-unified-* headers.
    let latestRateLimitInfo: Record<string, unknown> | undefined;
    /**
     * Record a rejected window's resetsAt. Separated so the early-failure
     * path can see queued rate-limit state before deciding the failure:
     * the response queue holds frames until pi's response hook settles, but
     * an error result jumps it (below), and a rejection reported before
     * that result must still be visible to the failover check.
     */
    function noteRateLimit(info: unknown): void {
      const rate = info as any;
      if (rate && typeof rate === "object") {
        if (rate.status === "rejected") {
          // A rejected window is the failover signal, but only when the
          // turn then fails having emitted nothing (checked at result).
          if (
            typeof rate.resetsAt === "number" &&
            Number.isFinite(rate.resetsAt)
          ) {
            rejectedResetsAt = rate.resetsAt;
          }
        }
        // Overage billing is the usage-credit guard signal, evaluated at
        // result time for error and success results alike.
        if (isOverageBilled(rate)) overageBilled = true;
        // The full state rides the after_provider_response headers below.
        latestRateLimitInfo = info as Record<string, unknown>;
      }
    }
    // Track HANDOFF tool_use blocks (custom pi tools) for the decision at
    // message_stop. Built-ins run natively and never end the episode.
    let sawHandoffTool = false;
    let malformedHandoff = false;
    // Set once we have asked the CLI to end the turn (legacy handoff or
    // abort): stream content is frozen and only the result envelope is awaited.
    let selfInterrupted = false;
    // Set on pi-initiated abort so the turn ends quietly, not as an error.
    let aborted = false;
    // CLI session this attempt staged its system prompt under, so the finally
    // below can remove the right file. Only set when this attempt spawned.
    let promptFileKey: string | undefined;
    // The pi session, for parking.
    const piSessionId = options?.sessionId;

    try {
      if (invalidated() || (forceFullReplay && options?.signal?.aborted)) {
        failPiRequest("Request aborted or invalidated by CLI lifecycle", "aborted");
        return "ok";
      }
      const cwd = options?.cwd ?? process.cwd();
      if (!payloadPrepared) {
        // Pi's provider hook is a mutating boundary, not a notification. Apply
        // its complete logical replacement before history, prompt and tools are
        // serialized or the CLI/MCP bridge is started.
        const replacement = await options?.onPayload?.(
          {
            // Wire-shaped system field: Core's provider observer and other Pi
            // extensions inspect this boundary, not a private systemPrompt key.
            system: context.systemPrompt,
            messages: context.messages,
            tools: context.tools,
          },
          model,
        );
        if (replacement !== undefined) {
          if (
            !replacement ||
            typeof replacement !== "object" ||
            Array.isArray(replacement)
          )
            throw new Error(
              "before_provider_request returned an invalid payload",
            );
          const payload = replacement as {
            system?: unknown;
            systemPrompt?: unknown;
            messages?: unknown;
            tools?: unknown;
          };
          if (
            !Array.isArray(payload.messages) ||
            (payload.system !== undefined &&
              typeof payload.system !== "string") ||
            (payload.systemPrompt !== undefined &&
              typeof payload.systemPrompt !== "string") ||
            (payload.tools !== undefined && !Array.isArray(payload.tools))
          )
            throw new Error(
              "before_provider_request returned an invalid prompt, messages or tools",
            );
          context = {
            systemPrompt: (payload.systemPrompt ?? payload.system) as
              string | undefined,
            messages: payload.messages,
            tools: payload.tools as any[] | undefined,
          };
        }
        effectiveMcpConfig = options?.prepareMcpConfig
          ? await options.prepareMcpConfig(context)
          : options?.mcpConfig;
        payloadPrepared = true;
      }
      const mcpConfig = effectiveMcpConfig;
      if (piOwned && piSessionId) {
        const oldId = getCliSession(piSessionId);
        if (oldId) {
          clearCliSession(piSessionId);
          clearSystemPrompt(oldId);
        }
      }
      const messages = context.messages as any[];
      const stale = cliSessionIsStale(messages);
      let delta = deltaMessages(messages);
      const thinking = resolveCliThinking(
        model,
        options?.reasoning,
        options?.thinkingBudgets,
      );
      const systemPromptMode = piOwned ? "pi" : resolveSystemPromptMode();
      const piContext = usesPiContext();
      // Never attach a new context policy to a transcript that still carries
      // the other loader's instructions. Leave that session available under
      // its original policy; the host/user must start a fresh pi session.
      // The pairing is account-pinned: a CLI session minted under another
      // profile is never resumed cross-profile (it reimports instead).
      const mappedContextId =
        !piOwned && piSessionId
          ? getCliSession(piSessionId, attemptAccount)
          : undefined;
      if (mappedContextId && !stale && !forceFullReplay) {
        assertContextPolicy(getSystemPrompt(mappedContextId), piContext);
      }
      const autocompact = resolveAutocompact();
      const handoffSocketPath = mcpConfig?.handoffSocket
        ? await mcpConfig.handoffSocket
        : undefined;
      // The proxy needs a pi session to route the continuation back to.
      const allowHandoff =
        handoffProxyAllowed() && !!piSessionId && !!handoffSocketPath;
      // Thinking is deliberately absent: a live process takes a new level
      // through control requests (step 1), so changing it mid-session no
      // longer costs a respawn and a full-history replay.
      // The account is part of the launch signature: a warm process is never
      // reused across profiles (failover retires and spawns instead).
      // Only the untouched legacy shape inherits the environment: any
      // declared set spawns under the selected account's own directory.
      const spawnConfigDir = singleDefault
        ? undefined
        : accountConfigDir(attemptAccount);
      const signature = requestSignature([
        model.id,
        systemPromptMode,
        piContext,
        piOwned ? context.systemPrompt : null,
        cwd,
        options?.mcpConfigPath ?? null,
        mcpConfig?.schemaPath ?? null,
        mcpConfig?.version ?? null,
        handoffSocketPath ?? null,
        autocompact ?? null,
        allowHandoff,
        process.env.PI_CLAUDE_CLI_SETTINGS ?? null,
        attemptAccount,
      ]);

      if (invalidated()) {
        failPiRequest("Request aborted or invalidated by CLI lifecycle", "aborted");
        return "ok";
      }

      // ---- 1. Reuse the session's parked process when this call continues it
      let mode: "spawn" | "turn" | "handoff" = "spawn";
      let spawnCause = forceFullReplay
        ? ["forceFullReplay"]
        : stale
          ? ["staleHistory"]
          : lastRetirementCause(piSessionId);
      let thinkingChangeFailed = false;
      const parkedCli = piSessionId
        ? takeParkedCliProcess(piSessionId)
        : undefined;
      if (parkedCli) {
        const checkpoint = parkedCli.piHistory;
        const historyMatches =
          !piOwned ||
          (!!checkpoint && matchesPrefix(messages, checkpoint, historyHash));
        if (
          !forceFullReplay &&
          !stale &&
          historyMatches &&
          parkedCli.signature === signature
        ) {
          // The checkpoint, not the last assistant, owns what this CLI has seen.
          // Pi appends an empty failure after cancelling a tool; slicing after
          // that entry loses the awaited result. A provider failure is skipped
          // only when this process recorded that exact failed assistant.
          if (piOwned && checkpoint) {
            delta = messages.slice(checkpoint.length).filter(m =>
              !isUnsentPiFailure(m) &&
              !(parkedCli.recoverableFailure && m?.role === "assistant" &&
                (m.provider === "pi-claude-cli" || m.api === "pi-claude-cli") &&
                (m.stopReason === "error" || m.stopReason === "aborted") &&
                historyHash([m]) === parkedCli.recoverableFailure.hash));
          }
          const toolResults = delta.filter((m) => m?.role === "toolResult");
          const userMessages = delta.filter((m) => m?.role === "user");
          if (parkedCli.turnActive) {
            // Pi delivers steers after tool results. Only this ordered shape
            // can answer the handoff and append users to the same live CLI.
            const ids = toolResults.map((m) => String(m.toolCallId ?? ""));
            if (
              delta
                .slice(0, toolResults.length)
                .every((m) => m?.role === "toolResult") &&
              delta
                .slice(toolResults.length)
                .every((m) => m?.role === "user") &&
              parkedCli.canContinueHandoff(ids)
            ) {
              mode = "handoff";
            }
          } else if (delta.every(m => m?.role === "user") &&
            (userMessages.length > 0 || parkedCli.recoverableFailure?.retry)) {
            mode = "turn";
          }
        }
        // A new user turn runs at the level pi asks for now. A handoff keeps
        // the turn it is continuing: the CLI reads thinking once per user
        // turn, so a change made mid-turn applies from the next one.
        if (mode === "turn") {
          // The CLI answers every control request; until it does, only pi's
          // abort ends the wait (no deadline by design). Abort retires
          // the process, which fails the change, and nothing is spawned.
          const stopWaiting = () => void parkedCli.retire(["abort"]);
          options?.signal?.addEventListener("abort", stopWaiting, { once: true });
          // An abort that landed before the listener (e.g. inside an awaited
          // payload hook) would otherwise never fire it.
          if (options?.signal?.aborted) stopWaiting();
          const applied = await parkedCli.applyThinking(thinking);
          options?.signal?.removeEventListener("abort", stopWaiting);
          if (invalidated()) {
            failPiRequest("Request invalidated by CLI lifecycle", "aborted");
            return "ok";
          }
          if (options?.signal?.aborted) {
            if (!parkedCli.retired) void parkedCli.retire(["abort"]);
            failPiRequest("Request aborted", "aborted");
            return "ok";
          }
          if (!applied) {
            thinkingChangeFailed = true;
            mode = "spawn";
          }
        }
        if (mode === "spawn") {
          // Different spawn parameters, stale history, or a delta the live
          // process cannot take: end it cleanly and start over via --resume.
          spawnCause = retireReasons({
            forceFullReplay,
            stale,
            historyMatches,
            previous: parkedCli.signature,
            next: signature,
            turnActive: parkedCli.turnActive,
          });
          if (thinkingChangeFailed) spawnCause = ["thinkingChangeFailed"];
          await parkedCli.retire(spawnCause);
        } else {
          cli = parkedCli;
        }
      }

      // ---- 2. Or spawn
      let resumeSessionId: string | undefined;
      let newCliId: string | undefined;
      if (!cli) {
        // One CLI session per pi session, resumed across turns and restarts.
        // Resume only when a mapping exists AND the CLI session is not behind
        // pi's history (a foreign-provider turn after our last one means the
        // CLI never saw that exchange). Anything else — first turn, fork,
        // model switch, lost sidecar, resume miss — is one reimport.
        // The mapping is account-pinned (see above): a foreign account
        // reimports rather than resuming another profile's CLI session.
        const mappedCliId =
          !piOwned && piSessionId
            ? getCliSession(piSessionId, attemptAccount)
            : undefined;
        resumeSessionId =
          !forceFullReplay && mappedCliId && !stale ? mappedCliId : undefined;
        // Fresh sessions get a provider-minted id, never pi's: the CLI refuses
        // a --session-id it has already seen, and forks reuse pi ids.
        newCliId = resumeSessionId ? undefined : randomUUID();
        const cliSessionId = (resumeSessionId ?? newCliId)!;
        promptFileKey = cliSessionId;

        // Resume sends only the delta since the last assistant turn (new user
        // text, handoff tool results). Create/import sends the full history.
        const prompt = piOwned
          ? replayPiMessages(messages)
          : resumeSessionId
            ? buildResumePrompt(context)
            : buildPrompt(context);
        // The CLI does not keep --system-prompt across --resume, so it goes on
        // EVERY spawn. On resume, replay the stored bytes rather than rebuilding
        // them: an identical prompt keeps the cached prefix, a drifted one
        // re-bills the whole transcript as cache write. See src/session-map.ts.
        const storedSystemPrompt = resumeSessionId
          ? getSystemPrompt(resumeSessionId)
          : undefined;
        const systemPrompt =
          storedSystemPrompt ??
          buildSystemPrompt(context, cwd, systemPromptMode);

        // The MCP config names this CLI session so proxied tool calls route
        // back here. A verbatim mcpConfigPath (tests, legacy hosts) wins.
        const mcpConfigPath =
          options?.mcpConfigPath ??
          (mcpConfig
            ? writeSessionMcpConfig(
                cliSessionId,
                mcpConfig.schemaPath,
                allowHandoff ? handoffSocketPath : undefined,
                allowHandoff ? handoffSecretFile() : undefined,
              )
            : undefined);

        if (piContext) await verifyContextCli(options?.signal, spawnConfigDir);
        if (invalidated() || ((piOwned || forceFullReplay) && options?.signal?.aborted)) {
          failPiRequest("Request aborted or invalidated by CLI lifecycle", "aborted");
          return "ok";
        }
        const proc = spawnClaude(model.id, systemPrompt || undefined, {
          cwd,
          signal: options?.signal,
          thinking,
          mcpConfigPath,
          resumeSessionId,
          newSessionId: newCliId,
          systemPromptMode,
          claudeConfigDir: spawnConfigDir,
        });
        // Record the mapping as soon as the session exists on disk. On a turn
        // that later errors, the mapping is cleared so the next turn reimports.
        // Pinned to this attempt's account so a later spawn under another
        // profile never --resumes this CLI session.
        if (!piOwned && piSessionId && newCliId)
          setCliSession(piSessionId, newCliId, attemptAccount);
        // Store the created prompt so every later turn re-passes these exact
        // bytes. Without it, resume falls back to a rebuild that can drift.
        if (!piOwned && newCliId && systemPrompt)
          setSystemPrompt(newCliId, systemPrompt);
        const getStderr = captureStderr(proc);
        // Register in global process registry for teardown cleanup
        registerProcess(proc);

        cli = new CliProcess(proc, {
          cliSessionId,
          signature,
          allowHandoff,
          getStderr,
          thinking,
          ledger: new RequestLedger({
            piSessionId,
            cliSessionId,
            requestedModel: model.id,
            pid: proc.pid,
            spawnCause,
            systemPromptBytes: Buffer.byteLength(systemPrompt ?? "", "utf8"),
            toolSchemaBytes: schemaBytes(mcpConfig?.schemaPath),
            account: accountLabel(attemptAccount),
          }),
        });
        cli.ledger?.beginEpisode(mode);
        cli.writeUser(prompt);
      }

      if (invalidated()) {
        failPiRequest("Request invalidated by CLI lifecycle", "aborted");
        return "ok";
      }
      const live = cli;
      if (mode !== "spawn") live.ledger?.beginEpisode(mode);
      const proc = live.proc;

      // ---- 3. The episode: one pi call's view of the process
      let publishEvents = true;
      const bridge = createEventBridge({ push(event) {
        if (publishEvents) stream.push(event);
      } }, model, { markedTools: live.markedTools });
      // Both unpublished gates belong to this episode. Metadata may be billed
      // without accepting a body or waiting for the gate to open.
      const responseQueue: any[] = [];
      const receiptQueue: any[] = [];
      const taskTracker = live.taskTracker;
      // Usage earlier episodes of this CLI turn already handed to pi. The
      // result's cumulative figures are reduced by this so the turn is billed
      // once across its episodes.
      const turnReportedBefore = live.turnReported;
      // Result deltas seen by THIS episode (a sub-agent wait yields several).
      let episodeResultTotals = ZERO_USAGE;
      const handoffUsers = mode === "handoff" ? delta.filter(m => m?.role === "user") : [];
      let queuedUsers: any[] | undefined = handoffUsers.length ? replayPiMessages(handoffUsers) : undefined;
      let drainingForUser = !!queuedUsers;
      let submittedTurn = mode !== "turn";
      if (drainingForUser) selfInterrupted = true;

      // Guard against double stream.end() and double error events.
      let streamEnded = false;
      let finished = false;
      let malformedRetirementError: string | undefined;
      let resolveFinished!: () => void;
      const finishedPromise = new Promise<void>((r) => (resolveFinished = r));

      /** Detach from the process and let the driver push done. */
      function finishEpisode() {
        if (finished) return;
        finished = true;
        live.ledger?.endEpisode();
        clearTimeout(inactivityTimer);
        clearTimeout(agentWaitTimer);
        live.detach();
        resolveFinished();
      }

      function recoverReceiptMismatch(): boolean {
        if (!live.handoffReceiptMismatch) return false;
        // The old CLI is already strictly retired. Its transcript, queued users
        // and any unverified body are not authoritative; only Pi's input is.
        receiptReplay = true;
        if (piSessionId) clearCliSession(piSessionId);
        clearSystemPrompt(live.cliSessionId);
        finishEpisode();
        return true;
      }

      /**
       * End the stream with an error, using a "done" event instead of "error".
       *
       * Why "done" not "error": AssistantMessageEventStream.extractResult()
       * returns event.error (a string) for error events, but agent-loop.js
       * then calls message.content.filter() on the result, crashing because
       * a string has no .content property. By pushing "done" with a valid
       * AssistantMessage (content:[]), pi gets a well-formed object.
       */
      function endStreamWithError(
        errMsg: string,
        retireReason = "episode_error",
        preserveProcess = false,
      ) {
        if (streamEnded || resumeMiss || receiptReplay || accountFailover) return;
        if (recoverReceiptMismatch()) return;
        aborted ||= cancelled();
        streamEnded = true;
        accountUnpublished([...responseQueue.splice(0), ...receiptQueue.splice(0)]);
        applyReplayUsage(bridge);
        const output = bridge.getOutput();
        const errorMessage = {
          ...output,
          content: output.content?.length
            ? output.content
            : [{ type: "text" as const, text: `Error: ${errMsg}` }],
          stopReason: "stop" as const,
        };
        const failedAssistant = { ...errorMessage,
          stopReason: aborted ? "aborted" as const : "error" as const,
          errorMessage: errMsg };
        if (piOwned && preserveProcess) {
          const acknowledged = !submittedTurn ? messages.slice(0, live.piHistory?.length ?? 0)
            : queuedUsers ? messages.slice(0, messages.length - handoffUsers.length) : messages;
          live.piHistory = { length: acknowledged.length, hash: historyHash(acknowledged) };
          live.recoverableFailure = { hash: historyHash([failedAssistant]), retry: !aborted };
        }
        stream.push(
          piOwned
            ? ({
                type: "error",
                reason: aborted ? "aborted" : "error",
                error: {
                  ...failedAssistant,
                },
              } as any)
            : ({
                type: "done",
                reason: "stop",
                message: errorMessage,
              } as any),
        );
        stream.end();
        // A settled transient/interrupt result ends a turn, not the process.
        // Pi owns retry policy/backoff; the next call sends only a continuation.
        if (piSessionId && (!live.alive || live.retired || live.hasUnconfirmedHandoffResults)) clearCliSession(piSessionId);
        if (preserveProcess) releaseProcess("turn-end");
        else void live.retire([aborted ? "abort" : retireReason]);
        finishEpisode();
      }

      /** The process is not coming back: drop it from every registry. */
      async function discardProcess(reason = "result_error") {
        if (piSessionId) {
          // Nothing to do — the pool never held it while attached.
        }
        await live.retire([reason]);
        removeSessionMcpConfig(live.cliSessionId);
      }

      function retireUnconfirmedSteer() {
        // Legacy disk resume must not skip a steer whose consumption is unknown.
        if (piSessionId) clearCliSession(piSessionId);
        void live.retire(["steer_unconfirmed"]);
      }

      /** Keep the process for the session's next call, or end it. */
      function releaseProcess(reason: "turn-end" | "handoff") {
        if (!live.alive || live.retired) return;
        if (!piSessionId) {
          void live.retire(["noPiSession"]);
          return;
        }
        if (reason === "handoff") {
          parkCliProcess(
            piSessionId,
            live,
            HANDOFF_WAIT_MS,
            "handoff_wait_expiry",
          );
          return;
        }
        if (live.hasUnconfirmedHandoffResults) {
          clearCliSession(piSessionId);
          void live.retire(["handoff_unconfirmed"]);
          return;
        }
        if (live.hasPendingSteers) {
          retireUnconfirmedSteer();
          return;
        }
        const idle = keepaliveMs(live);
        if (idle > 0)
          parkCliProcess(
            piSessionId,
            live,
            idle,
            // An explicit lifetime is fixed; only the cache-derived one follows refreshes.
            process.env.PI_CLAUDE_CLI_KEEPALIVE_MS?.trim()
              ? "keepalive_expiry"
              : "cache_expiry",
          );
        else
          void live.retire([
            process.env.PI_CLAUDE_CLI_KEEPALIVE_MS?.trim()
              ? "keepalive_disabled"
              : "cache_expired",
          ]);
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

      // Sub-agent wait state (see WAIT_FOR_AGENTS): the wall-clock wait that
      // stops waiting no matter what the agents are doing.
      let agentWaitTimer: ReturnType<typeof setTimeout> | undefined;
      let agentWaitExpired = false;
      let waitingForAgents = false;

      /**
       * End the episode on what it already has, without pushing an error.
       *
       * Only correct once a `result` has been seen. Before that, silence means
       * a wedged CLI and the turn has nothing — which is what the inactivity
       * timeout's error is for.
       */
      function endTurnOnPartialWork(reason = "agent_wait_expiry") {
        agentWaitExpired = true;
        // Agents may still be running inside the process; a fresh process
        // for the next turn is the safe outcome.
        void discardProcess(reason);
        finishEpisode();
      }

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          if (resumeMiss || finished || malformedHandoff) return;
          // Waiting on sub-agents is the one state where silence is not a
          // failed turn: the model already spoke and the result already
          // landed. An agent that dies without notifying must not convert
          // that into an error and throw the content away.
          if (waitingForAgents) {
            endTurnOnPartialWork("inactivity");
            return;
          }
          live.expectedExitReason = ["inactivity"];
          forceKillProcess(proc);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
            "inactivity",
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Drain an interrupt result before reusing the process. A Pi-owned
      // process is not disposable just because its caller cancelled a turn.
      if (options?.signal) {
        abortHandler = () => {
          aborted = true;
          selfInterrupted = true;
          if (piOwned && !live.turnActive) {
            endStreamWithError("Request aborted", "abort", true);
            return;
          }
          sendInterrupt(proc);
          if (piOwned) return;
          live.expectedExitReason = ["abort"];
          const backstop = setTimeout(() => forceKillProcess(proc), 2000);
          proc.once("close", () => clearTimeout(backstop));
        };

        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      /**
       * Nothing to hand pi: no content blocks and no tokens spent. Both halves
       * matter — a model that legitimately answers with silence still bills
       * for the call, so usage alone separates "said nothing" from "never
       * ran".
       */
      function episodeIsEmpty(): boolean {
        const output = bridge.getOutput();
        if (output.content.length > 0) return false;
        const u = output.usage;
        if (!u) return true;
        return (
          (u.input ?? 0) === 0 &&
          (u.output ?? 0) === 0 &&
          (u.cacheRead ?? 0) === 0 &&
          (u.cacheWrite ?? 0) === 0
        );
      }

      /** Bill this episode from a `result`, net of what the turn already reported. */
      function applyResultUsage(r: any, target = bridge, includeBody = !selfInterrupted) {
        const processTotals = sumModelUsage(r.modelUsage);
        let turnDelta: Usage4;
        if (processTotals) {
          turnDelta = subUsage(processTotals, live.lastProcessTotals);
          live.lastProcessTotals = processTotals;
        } else {
          // `usage` is per turn already (main agent only).
          turnDelta = usage4(r.usage);
        }
        episodeResultTotals = addUsage(episodeResultTotals, turnDelta);
        const own = bridgeUsage4(target.getOutput());
        const billed = maxUsage(
          subUsage(episodeResultTotals, turnReportedBefore),
          own,
        );
        target.applyResult({
          ...r,
          // Accounting-only drainage and interruption never publish prose.
          result: includeBody ? r.result : undefined,
          modelUsage: undefined,
          usage: billed,
        });
      }

      /** Replay only observed billing snapshots through the same cycle owner. */
      function accountUnpublished(frames: any[]): void {
        publishEvents = false;
        try {
          for (const msg of frames) {
            if (msg.type === "stream_event" && !msg.parent_tool_use_id &&
                ["message_start", "message_delta", "message_stop"].includes(msg.event?.type))
              bridge.handleEvent(msg.event);
            else if (msg.type === "result") applyResultUsage(msg, bridge, false);
          }
        } finally { publishEvents = true; }
      }

      // Steers must be independent user turns, never CLI priority=next tool
      // content. Interrupt the old turn and wait for its terminal envelope
      // before writing. No second queue or guessed acknowledgement deadline.
      // The response observer and all parallel receipts must settle before
      // bodies/completion can escape. Receipt confirmation still runs at ingress.
      let handoffDeliveryPending = mode === "handoff";
      let awaitingTurnWrite = mode === "turn";
      // Preserve pre-write provenance through the asynchronous response hook.
      const beforeTurnWrite = new WeakSet<object>();
      let responseReady = !options?.onResponse;
      let responsePending = false;
      let pendingClose: number | null | undefined;
      const sink: EpisodeSink = {
        onError(err) {
          if (resumeMiss || finished || accountFailover) return;
          if (malformedHandoff) {
            malformedRetirementError = err.message;
            return;
          }
          const stderr = live.getStderr();
          endStreamWithError(stderr || err.message);
        },
        onClose(code) {
          // Malformed MCP input is returned intact for Pi validation once
          // retirement observes close. It is not a provider/receipt failure.
          if (resumeMiss || finished || malformedHandoff || accountFailover) {
            return;
          }
          if (recoverReceiptMismatch()) return;
          if (responsePending && !responseReady) {
            pendingClose = code;
            return;
          }
          if (!responseReady) {
            const stderr = live.getStderr();
            endStreamWithError(
              stderr ||
                "Claude CLI exited before validated initialization/response observation",
            );
            return;
          }
          if (piOwned || (code !== 0 && code !== null)) {
            const stderr = live.getStderr();
            const message = stderr
              ? `Claude CLI exited with code ${code}: ${stderr.trim()}`
              : `Claude CLI exited unexpectedly with code ${code}`;
            endStreamWithError(message);
            return;
          }
          // stdout closed without a result: end on whatever was streamed.
          // The process is gone or going; it cannot serve another call.
          void live.retire(["stdout_closed"]);
          finishEpisode();
        },
        onMessage(msg) {
          if (resumeMiss || finished || accountFailover) return;
          if (malformedHandoff) {
            accountUnpublished([msg]);
            return;
          }
          if (recoverReceiptMismatch()) return;
          if (handoffDeliveryPending && msg.type !== "rate_limit_event" && msg.type !== "control_request") {
            resetInactivityTimer();
            receiptQueue.push(msg);
            // A terminal envelope cannot establish a missing receipt. Preserve
            // the existing missing-receipt failure rather than waiting forever.
            if (msg.type === "result" && live.hasUnconfirmedHandoffResults)
              endStreamWithError("CLI ended before confirming the handed-off tool result", "handoff_unconfirmed");
            return;
          }
          if (awaitingTurnWrite) beforeTurnWrite.add(msg);
          // Reset inactivity timer on each line of output, even while a
          // response observer is asynchronously inspecting initialization.
          resetInactivityTimer();
          // MCP calls can arrive while the response observer is pending. Keep
          // transport bookkeeping current, but publish no body before it settles.
          if (
            msg.type === "stream_event" &&
            !(msg as any).parent_tool_use_id &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const { id, name } = msg.event.content_block;
            if (name && isHandoffClaudeTool(name) && !beforeTurnWrite.has(msg)) {
              if (responseReady) sawHandoffTool = true;
              if (id && !observedHandoffFrames.has(msg)) {
                observedHandoffFrames.add(msg);
                live.noteHandoffToolUse(id, mapClaudeToolNameToPi(name));
              }
            }
          }
          if (!responseReady) {
            // An early failure has no validated response to announce; preserve
            // its actual CLI diagnostic. A result after init (or from a warm
            // process) must instead wait behind the observer like body frames.
            if (
              msg.type === "result" &&
              !responsePending &&
              (mode === "spawn" ||
                (msg as any).is_error ||
                (msg as any).subtype !== "success")
            ) {
              const r = msg as any;
              if (r.is_error || r.subtype !== "success") {
                responseReady = true;
                // The failure jumps the response queue. A rejected window
                // reported before this result is still the failover signal:
                // lift it out before deciding, leaving other queued frames
                // exactly where the response hook left them.
                for (let i = responseQueue.length - 1; i >= 0; i--) {
                  if (responseQueue[i]?.type === "rate_limit_event") {
                    noteRateLimit(responseQueue[i].rate_limit_info);
                    responseQueue.splice(i, 1);
                  }
                }
                sink.onMessage(msg);
              } else {
                endStreamWithError(
                  "Claude CLI returned success without a validated initialization",
                );
              }
              return;
            }
            responseQueue.push(msg);
            if (
              !responsePending &&
              isResponseBoundaryFrame(msg as any, mode !== "spawn")
            ) {
              responsePending = true;
              Promise.resolve()
                .then(() => {
                  // The CLI reports turn rate-limit state right after init,
                  // ahead of the frames this hook gates: lift it out first
                  // so the headers below carry the turn's actual state.
                  // Gating is unchanged — onResponse is still awaited
                  // before the drain below.
                  for (const frame of responseQueue) {
                    if (frame?.type === "rate_limit_event") {
                      noteRateLimit(frame.rate_limit_info);
                    }
                  }
                  return options!.onResponse!(
                    {
                      status: 200,
                      headers: latestRateLimitInfo
                        ? rateLimitHeaders(latestRateLimitInfo)
                        : {},
                    },
                    model,
                  );
                })
                .then(
                  () => {
                    if (finished || resumeMiss) return;
                    responseReady = true;
                    while (responseQueue.length && !finished && !resumeMiss)
                      sink.onMessage(responseQueue.shift());
                    // message_stop can hand the episode back to Pi. Any
                    // remaining frames still belong to the warm process.
                    if (responseQueue.length && !live.retired && !resumeMiss)
                      live.prependDetachedMessages(responseQueue.splice(0));
                    if (pendingClose !== undefined && !finished && !resumeMiss)
                      sink.onClose(pendingClose);
                  },
                  (error: unknown) => {
                    endStreamWithError(
                      `Pi after_provider_response handler failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  },
                );
            }
            return;
          }

          if (live.retired) selfInterrupted = true;
          if (msg.type === "stream_event") {
            // Only forward top-level events to pi's event bridge.
            // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
            const isTopLevel = !(msg as any).parent_tool_use_id;
            if (isTopLevel) {
              // Interruption suppresses bodies, never already observed billing.
              if (selfInterrupted) accountUnpublished([msg]);
              else bridge.handleEvent(msg.event);
            }

            if (
              isTopLevel &&
              msg.event.type === "message_stop" &&
              sawHandoffTool &&
              !selfInterrupted
            ) {
              // Syntactically invalid JSON cannot become tools/call. Keep
              // its raw arguments for Pi validation and reimport that result
              // after observed close. Valid JSON scalars/arrays also fail Pi
              // validation, but the schema server/broker can accept a call
              // for them: keep the ordinary proxy path (including late calls)
              // so Pi's real validation error answers that live call.
              if (bridge.getOutput().content.some(b => {
                if (b.type !== "toolCall" || typeof b.arguments !== "string") return false;
                try { JSON.parse(b.arguments); return false; }
                catch { return true; }
              })) {
                malformedHandoff = true;
                if (piSessionId) clearCliSession(piSessionId);
                clearSystemPrompt(live.cliSessionId);
                void live.retire(["malformed_handoff_input"]).then(() => {
                  if (finished) return;
                  const diagnostic = malformedRetirementError ||
                    (live.exitCode !== null && live.exitCode !== 0 ? `CLI exited with code ${live.exitCode}` : undefined);
                  const stderr = live.getStderr();
                  if (diagnostic || stderr) {
                    bridge.appendMarker(`[Claude CLI · malformed-input retirement diagnostic] ${[diagnostic, stderr].filter(Boolean).join("\n")}`);
                  }
                  if (cancelled()) {
                    endStreamWithError(options?.signal?.aborted ? "Request aborted" :
                      "Request invalidated by CLI lifecycle", "abort");
                    return;
                  }
                  // Retirement may observe another CLI cycle for billing. Its
                  // stop reason cannot hide the failed call Pi must validate.
                  bridge.getOutput().stopReason = "toolUse";
                  finishEpisode();
                });
                return;
              }
              if (live.allowHandoff) {
                // Proxied handoff: pi executes the tool while the CLI blocks
                // on `tools/call`. Hand the turn to pi now; the next call
                // answers the CLI on this same process. Nothing is written
                // to the CLI, so its transcript and cached prefix stay intact.
                live.turnReported = addUsage(
                  turnReportedBefore,
                  bridgeUsage4(bridge.getOutput()),
                );
                releaseProcess("handoff");
                finishEpisode();
                return;
              }
              // Legacy handoff: ask the CLI to end the turn CLEANLY so the
              // session file stays truthful and resumable, then wait for the
              // result envelope. Never SIGKILL here — a kill truncates the
              // transcript before the assistant turn is written, and every
              // later --resume then splices in synthetic "No response
              // requested." filler that the model eventually imitates.
              selfInterrupted = true;
              sendInterrupt(proc);
              return;
            }
          } else if (msg.type === "rate_limit_event") {
            // Account-level state, not turn content: hand it to the host so a
            // front-end can surface the window and its reset. Never touches
            // the assistant message.
            const info = (msg as any).rate_limit_info;
            if (info && typeof info === "object") {
              // A rejected window is the failover signal, but only when the
              // turn then fails having emitted nothing (checked at result).
              noteRateLimit(info);
              try {
                // Single-profile calls keep their exact prior shape (one
                // argument); the account rides only when declared.
                const label = accountLabel(attemptAccount);
                if (label === undefined) options?.onRateLimit?.(info);
                else options?.onRateLimit?.(info, label);
              } catch {
                /* a status push must never break a turn */
              }
            }
          } else if (
            msg.type === "system" &&
            (msg as any).subtype === "compact_boundary"
          ) {
            // The CLI compacted its own session and will carry on by itself.
            // The host needs two things from it: the context is now the
            // compacted size (the bridge resets its latch — otherwise pi is
            // told the pre-compaction figure and compacts its own record on
            // it), and the transcript should show where the cut happened.
            if (!selfInterrupted) bridge.handleCompactBoundary(msg as any);
          } else if (
            msg.type === "system" &&
            isTaskSubtype((msg as any).subtype)
          ) {
            // Sub-agent lifecycle. The agents' own envelopes carry
            // parent_tool_use_id and stay internal to the CLI, but these arrive
            // at top level even for deeply nested agents — the one channel that
            // makes a fan-out visible at all.
            if (!selfInterrupted) {
              const marker = taskTracker.apply(msg as any);
              if (marker) bridge.appendMarker(marker);
              try {
                options?.onTaskProgress?.(taskTracker.snapshot());
              } catch {
                /* a status push must never break a turn */
              }
            }
          } else if (msg.type === "assistant") {
            // Complete-block envelopes: marker text for the CLI's own tool
            // executions (built-ins, WebSearch, user MCP, …), which in observer
            // mode is every tool except handoffs.
            if (!selfInterrupted) bridge.handleAssistantEnvelope(msg as any);
          } else if (msg.type === "user") {
            // Tool results the CLI feeds back between cycles. Internal by
            // default; with PI_CLAUDE_CLI_TOOL_RESULTS=1 the bridge forwards
            // each one as a `result` marker paired to its call marker. Frozen
            // after an interrupt like every other content path.
            if (!selfInterrupted) bridge.handleUserEnvelope(msg as any);
          } else if (msg.type === "control_request") {
            // Answered by CliProcess (it must be, attached or not).
          } else if (msg.type === "result") {
            const r: any = msg as any;
            if (beforeTurnWrite.has(msg)) {
              // Detached idle work completed before this input was submitted.
              // Bill/retain it, but it cannot answer or acknowledge the new user.
              applyResultUsage(r);
              return;
            }
            // Usage-credit guard: the CLI billed this attempt to overage.
            // Fail the call now — before failover (no replay onto another
            // account), before resume-miss recovery (no reimport that bills
            // again), and before any success handling. Results are terminal,
            // so this never fires mid-stream; the message states what
            // already happened (executed tools stand, the rest is abandoned).
            // The wording is deliberately non-retryable ("billing", never
            // "rate limit"/"retry"): pi must fail fast, not back off.
            if (overageBilled && !allowUsageCredits()) {
              // Bill the failed turn from the terminal result first: spend
              // the CLI reports only here (result `usage`/`modelUsage` with
              // no streamed usage) must still reach Pi and the ledger.
              // Bodies stay suppressed — the turn is failed, not answered.
              applyResultUsage(r, bridge, false);
              const toolCalls = bridge
                .getOutput()
                .content.filter((c: any) => c.type === "toolCall").length;
              const guarded = [
                "Claude billed this turn to overage usage credits (overage billing).",
                "The usage-credit guard fails the turn; set PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1 to allow overage billing.",
              ];
              if (toolCalls > 0) {
                // Proxied tools executed through the broker during the turn;
                // a legacy interrupt never reaches a result with pi-side
                // calls still pending, so those were not executed.
                guarded.push(
                  live.allowHandoff && sawHandoffTool
                    ? `${toolCalls} tool call(s) in the failed turn already executed through the tool broker \u2014 their effects stand; the turn is failed so pi will not treat the answer as successful.`
                    : `${toolCalls} tool call(s) in the failed turn were not executed \u2014 the failed turn abandons them.`,
                );
              } else if (bridge.getOutput().content.length > 0) {
                guarded.push(
                  "Assistant content already streamed stays in the transcript; the turn is failed so pi will not treat it as successful.",
                );
              }
              const original =
                r.error ??
                (typeof r.result === "string" && r.is_error
                  ? r.result
                  : undefined) ??
                (Array.isArray(r.errors) && r.errors.length > 0
                  ? r.errors.join("; ")
                  : undefined);
              if (original) guarded.push(`The CLI also reported: ${original}`);
              endStreamWithError(guarded.join(" "));
              return;
            }
            const isError =
              r.subtype !== "success" ||
              r.is_error === true ||
              typeof r.error === "string" ||
              (Array.isArray(r.errors) && r.errors.length > 0);
            if (isError && !selfInterrupted && !aborted) {
              const errMsg =
                r.error ??
                (typeof r.result === "string" && r.is_error
                  ? r.result
                  : undefined) ??
                (Array.isArray(r.errors) && r.errors.length > 0
                  ? r.errors.join("; ")
                  : `Claude CLI returned ${r.subtype ?? "non-success result"}`);
              if (
                resumeSessionId &&
                /No conversation found with session ID/i.test(errMsg)
              ) {
                // Recoverable: the sidecar pointed at a CLI session that no
                // longer exists. Clear it; the driver reimports once.
                if (piSessionId) clearCliSession(piSessionId);
                clearSystemPrompt(resumeSessionId);
                resumeMiss = true;
                void discardProcess("resume_miss");
                finishEpisode();
                return;
              }
              if (
                failoverEnabled() &&
                multiAccount &&
                rejectedResetsAt !== undefined &&
                mode !== "handoff" &&
                !sawHandoffTool &&
                !live.hasUnconfirmedHandoffResults &&
                bridge.getOutput().content.length === 0
              ) {
                // Zero-output subscription-limit rejection (the observed
                // production shape): this account is exhausted until the
                // CLI-reported resetsAt. Retire the process; the driver
                // re-runs the same request on the next non-exhausted
                // account with a full history import, inside this same
                // provider call. Anything emitted or handed off fails
                // exactly as before (see below).
                markAccountExhausted(attemptAccount, rejectedResetsAt);
                lastFailover = { error: errMsg, from: attemptAccount };
                // Drain every unpublished gate through the same cycle owner
                // with publication muted, and carry the spend forward so the
                // replayed attempt bills the turn once, not zero times. The
                // rejected result rides along with bodies suppressed: spend
                // the CLI reports only in `result` (helper-model `modelUsage`
                // or a non-streamed `usage`) would otherwise vanish from a
                // turn pi bills as successful.
                accountUnpublished([
                  ...responseQueue.splice(0),
                  ...receiptQueue.splice(0),
                  ...live.takeDetachedMessages(),
                  r,
                ]);
                replayUsage = addUsage(
                  replayUsage,
                  bridgeUsage4(bridge.getOutput()),
                );
                replayContextTokens =
                  bridge.getOutput().usage.totalTokens || replayContextTokens;
                if (piSessionId) clearCliSession(piSessionId);
                clearSystemPrompt(live.cliSessionId);
                accountFailover = true;
                void discardProcess("account_exhausted");
                finishEpisode();
                return;
              }
              if (piOwned && !sawHandoffTool && !live.hasUnconfirmedHandoffResults &&
                  bridge.getOutput().content.length === 0 &&
                  [r.usage?.input_tokens, r.usage?.output_tokens, r.usage?.cache_read_input_tokens, r.usage?.cache_creation_input_tokens].every(value => value === 0) &&
                  /^Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh\./i.test(String(errMsg))) {
                // The CLI could not obtain credentials for this request. Retire
                // its session; Pi alone decides whether to retry the user turn.
                if (piSessionId) clearCliSession(piSessionId);
                clearSystemPrompt(live.cliSessionId);
                void discardProcess();
                endStreamWithError(`server error: ${errMsg}`);
                return;
              }
              if (piOwned && isTransientApiError(String(errMsg))) {
                applyResultUsage(r);
                live.turnReported = ZERO_USAGE;
                endStreamWithError(retryableDiagnostic(String(errMsg)), "result_error", true);
                return;
              }
              // A failed turn may leave the CLI session ending on a user
              // entry; resuming that would splice filler. Reimport next turn.
              if (piSessionId) clearCliSession(piSessionId);
              // This CLI session will never be resumed, so its stored prompt
              // is dead weight.
              clearSystemPrompt(live.cliSessionId);
              void discardProcess();
              endStreamWithError(errMsg);
              return;
            }
            // Authoritative episode usage. After a self-interrupt the result
            // is `error_during_execution` BY DESIGN — the turn content (the
            // handoff toolCall) is already accumulated; usage still applies.
            applyResultUsage(r);

            if (aborted && piOwned) {
              live.turnReported = ZERO_USAGE;
              endStreamWithError("Request aborted", "abort", true);
              return;
            }
            if (!live.alive || live.retired || live.hasUnconfirmedHandoffResults) {
              endStreamWithError("CLI ended before confirming the handed-off tool result", "handoff_unconfirmed");
              return;
            }
            if (drainingForUser) {
              drainingForUser = false;
              selfInterrupted = false;
              sawHandoffTool = false;
              live.writeSteer(queuedUsers!);
              queuedUsers = undefined;
              resetInactivityTimer();
              return;
            }

            // The CLI answered a queued prompt of its own (see THE CLI CAN
            // ANSWER A PROMPT THAT IS NOT OURS): nothing was said and nothing was
            // spent, and our prompt is still waiting. Keep reading; the turn
            // is still live for the process.
            if (
              !isError &&
              !selfInterrupted &&
              !aborted &&
              episodeIsEmpty()
            ) {
              live.resumeTurn();
              resetInactivityTimer();
              return;
            }

            // Default stream-json priority absorbs users at the next tool
            // boundary; a racing result may still answer the previous user.
            // Keep reading until a nonempty result echoes our steer UUID(s).
            // Missing echo metadata cannot justify waiting forever or reuse.
            const steers = live.confirmSteers(r);
            if (
              !isError &&
              !selfInterrupted &&
              !aborted &&
              steers === "pending"
            ) {
              live.resumeTurn();
              resetInactivityTimer();
              return;
            }
            if (steers === "unconfirmed") {
              retireUnconfirmedSteer();
              finishEpisode();
              return;
            }

            // Sub-agents still working: this result ends a CYCLE, not the
            // episode. Leave the CLI alive and keep reading — it re-invokes the
            // model itself once they report, and emits another result. See
            // WAIT_FOR_AGENTS describes the lifecycle contract.
            if (
              WAIT_FOR_AGENTS &&
              !isError &&
              !selfInterrupted &&
              !aborted &&
              !agentWaitExpired &&
              taskTracker.pendingAgents() > 0
            ) {
              waitingForAgents = true;
              live.resumeTurn();
              if (agentWaitTimer === undefined) {
                agentWaitTimer = setTimeout(() => {
                  // Give up waiting, but let the turn end on its own content:
                  // the launch markers and whatever the model already said are
                  // real, and an error here would throw them away.
                  endTurnOnPartialWork();
                }, AGENT_WAIT_TIMEOUT_MS);
                // A pending wait must never hold the host process open.
                agentWaitTimer.unref?.();
              }
              resetInactivityTimer();
              return;
            }

            // The turn is over. The process stays for the session's next
            // call unless the turn was interrupted for a legacy handoff (the
            // CLI transcript then ends on a rejected tool; only --resume with
            // the result pasted in can continue it).
            live.turnReported = ZERO_USAGE;
            if (selfInterrupted && !aborted) {
              void live.retire(["legacy_handoff_interrupt"]);
            } else {
              releaseProcess("turn-end");
            }
            finishEpisode();
          }
        },
      };

      // Attach: buffered lines (a handoff gap) replay first, then live ones.
      if (!finished) {
        live.attach(sink);
        resetInactivityTimer();
      }

      // Continue the parked process
      if (mode === "handoff") {
        const deliveries = delta.filter(m => m?.role === "toolResult")
          .map(m => live.deliverHandoffResult(String(m.toolCallId ?? ""), toHandoffResult(m)));
        // Socket writes do not prove the MCP child/CLI consumed the body. Failed
        // receipts end even non-steered handoffs; only confirmed ones may steer.
        void Promise.all(deliveries).then(delivered => {
          if (!delivered.every(Boolean)) {
            if (!finished) endStreamWithError("CLI turn ended before handoff result delivery", "handoff_unconfirmed");
            return;
          }
          handoffDeliveryPending = false;
          while (receiptQueue.length && !finished) sink.onMessage(receiptQueue.shift());
          if (receiptQueue.length && !live.retired) live.prependDetachedMessages(receiptQueue.splice(0));
          // A natural result can win: never interrupt its already-written user.
          if (!finished && drainingForUser && !aborted) sendInterrupt(proc);
        });
      } else if (mode === "turn" && !finished && !aborted) {
        awaitingTurnWrite = false;
        live.writeUser(
          piOwned ? (delta.length ? replayPiMessages(delta) :
            "Retry the failed request. Continue from the existing conversation; do not repeat completed tool actions.") : buildResumePrompt(context),
        );
        submittedTurn = true;
        live.recoverableFailure = undefined;
      }

      await finishedPromise;

      if (resumeMiss) return "resume-miss";
      if (accountFailover) return "account-failover";
      if (receiptReplay) {
        // Reuse retire's original completion promise, including its existing
        // force-kill path: never overlap the invalid process and its replacement.
        await live.retire();
        // Drain every unpublished gate and the retirement tail through the
        // existing cycle/result owner, with publication muted and bodies skipped.
        accountUnpublished([...responseQueue.splice(0), ...receiptQueue.splice(0), ...live.takeDetachedMessages()]);
        replayUsage = addUsage(replayUsage, bridgeUsage4(bridge.getOutput()));
        replayContextTokens = bridge.getOutput().usage.totalTokens || replayContextTokens;
        return "receipt-replay";
      }

      // Push done after the episode ends (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (!streamEnded) {
        applyReplayUsage(bridge);
        const output = bridge.getOutput();

        // If stopReason is toolUse but there are no pi-known tool calls in content,
        // it means only user MCP tools were called (filtered by event bridge).
        // Override to "stop" so pi doesn't try to execute non-existent tools.
        const piToolCalls = (output.content || []).filter(
          (c: any) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0
            ? "stop"
            : output.stopReason;

        if (piOwned) {
          live.recoverableFailure = undefined;
          const acknowledged = [...messages, output];
          live.piHistory = {
            length: acknowledged.length,
            hash: historyHash(acknowledged),
          };
        }
        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...output, stopReason: effectiveReason },
        });
        stream.end();
      }
      return "ok";
    } finally {
      // Clean up this attempt's abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      // Staged prompt file is per CLI session, so it is removed here where
      // the ids are in scope — a resume-miss retry stages a second one. The
      // CLI read it at spawn; a parked process no longer needs it.
      if (promptFileKey) cleanupSystemPromptFile(promptFileKey);
    }
  }

  (async () => {
    try {
      let forceFullReplay = false;
      // Accounts already tried in THIS provider call. The persisted
      // exhaustion files stay the cross-call signal; this set is the
      // per-call termination bound: when every account was tried once the
      // next selection is empty and the turn fails with the all-exhausted
      // error — even when a resetsAt is stale or a write silently failed.
      const attemptedAccounts = new Set<string>([attemptAccount]);
      for (;;) {
        const outcome = await runOnce(forceFullReplay);
        if (outcome === "ok") break;
        if (outcome === "resume-miss") {
          console.error(
            "[pi-claude-cli] CLI session missing for --resume — importing pi history into a fresh CLI session",
          );
        } else if (outcome === "account-failover") {
          // Same request, next untried account, full history import —
          // inside this same provider call, so pi sees a single turn. The
          // in-memory tried set (not the persisted files) bounds the loop:
          // each iteration tries a new account, so it ends after at most
          // one attempt per declared account with the all-exhausted error.
          attemptedAccounts.add(attemptAccount);
          const next = selectFailoverAccount(
            accountSet,
            attemptAccount,
            Math.floor(Date.now() / 1000),
            attemptedAccounts,
          );
          if (next === undefined) {
            const resets = accountResetTimes(accountSet)
              .map(({ account, resetsAt }) =>
                resetsAt === null
                  ? `${account}: resets unknown`
                  : `${account}: resets ${new Date(resetsAt * 1000).toISOString()}`,
              )
              .join("; ");
            failPiRequest(
              `${lastFailover?.error ?? "Claude CLI request failed"} ` +
                `(all ${accountSet.length} Claude accounts exhausted; ${resets})`,
            );
            break;
          }
          attemptAccount = next;
        }
        // No retry budget: every strict receipt mismatch retires and reimports
        // from the same authoritative Pi history; Pi's abort still ends work.
        forceFullReplay = true;
      }
    } catch (err: any) {
      if (piOwned) {
        failPiRequest(
          options?.signal?.aborted
            ? "Request aborted"
            : (err.message ?? "Unexpected error in streamViaCli"),
          options?.signal?.aborted ? "aborted" : "error",
        );
        return;
      }
      if (err instanceof ContextPolicyError) {
        // pi's stream result must be an AssistantMessage, not a raw error
        // string (agent-loop inspects .content even when a call failed).
        const message = createEventBridge(stream, model).getOutput();
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            ...message,
            content: [{ type: "text", text: err.message }],
            stopReason: "error",
            errorMessage: err.message,
          },
        } as any);
        stream.end();
        return;
      }
      stream.push({
        type: "error",
        reason: "error",
        error: err.message ?? "Unexpected error in streamViaCli",
      } as any);
      stream.end();
    } finally {
      // The sub-agent channel is state ABOUT a turn, so it must not outlive
      // one. Left standing, the last snapshot pins whatever the agents were
      // doing when the episode ended — a host then shows "running" for
      // agents that finished, or for agents that died, until the next turn
      // happens to publish something else.
      try {
        options?.onTaskProgress?.({ tasks: [], active: 0, completed: 0 });
      } catch {
        /* a status push must never break a turn */
      }
    }
  })();

  return stream;
}
