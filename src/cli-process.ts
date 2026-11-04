import { createLifecycleRevision } from "pi-tether-core/lifecycle";
/**
 * One Claude CLI process that outlives a single pi call.
 *
 * Before 0.7.0 a process lived exactly one pi call: spawn, one user message,
 * read until `result`, kill. Every custom (handoff) tool call and every user
 * turn therefore started a fresh `claude -p --resume`, and each fresh process
 * rebuilt its system prompt — including Claude Code's git snapshot — so any
 * commit, branch rename or untracked file between two processes re-billed the
 * whole context as cache write (src/handoff-broker.ts has the numbers).
 *
 * A CliProcess instead stays alive:
 * - through a handoff: pi's stream ends at message_stop so pi can run the
 *   tool, the CLI blocks on the proxied `tools/call`, and the next pi call
 *   attaches to the same process and answers it;
 * - between turns: after `result` the process is parked (idle timer) and the
 *   next user message is written to the same stdin.
 *
 * Exactly one "episode" (one pi call) is attached at a time. Lines that arrive
 * while nothing is attached are buffered and replayed to the next episode, so
 * the episode code sees the stream as if it were live. Permission requests
 * are answered here, attached or not — the CLI must never wait on one.
 */

import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { parseLine } from "./stream-parser.js";
import { matchesDerivativeImages, receiptImageHeader } from "./receipt-image.js";
import { removeSessionMcpConfig } from "./mcp-config.js";
import { handleControlRequest } from "./control-handler.js";
import {
  writeUserMessage,
  sendInterrupt,
  forceKillProcess,
} from "./process-manager.js";
import { createTaskTracker } from "./task-tracker.js";
import {
  registerHandoffTarget,
  unregisterHandoffTarget,
  errorResult,
  type HandoffCall,
  type HandoffResult,
  type HandoffTarget,
} from "./handoff-broker.js";
import type { NdjsonMessage } from "./types.js";
import type { HandoffReceiptMismatch, ReceiptContentMetadata, RequestLedger } from "./request-ledger.js";
import {
  thinkingControls,
  type CliThinking,
  type ThinkingControl,
} from "./thinking-config.js";

/** Refusal for a `tools/call` that names no live tool_use block of ours. */
export const UNMATCHED_CALL_MESSAGE =
  "pi could not match this tool call to an assistant tool_use block";

/** Four token counters, the shape both `usage` and `modelUsage` reduce to. */
export interface Usage4 {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export const ZERO_USAGE: Usage4 = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export function addUsage(a: Usage4, b: Usage4): Usage4 {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

/** a − b, floored at zero per component. */
export function subUsage(a: Usage4, b: Usage4): Usage4 {
  return {
    input_tokens: Math.max(0, a.input_tokens - b.input_tokens),
    output_tokens: Math.max(0, a.output_tokens - b.output_tokens),
    cache_read_input_tokens: Math.max(
      0,
      a.cache_read_input_tokens - b.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: Math.max(
      0,
      a.cache_creation_input_tokens - b.cache_creation_input_tokens,
    ),
  };
}

export function maxUsage(a: Usage4, b: Usage4): Usage4 {
  return {
    input_tokens: Math.max(a.input_tokens, b.input_tokens),
    output_tokens: Math.max(a.output_tokens, b.output_tokens),
    cache_read_input_tokens: Math.max(
      a.cache_read_input_tokens,
      b.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: Math.max(
      a.cache_creation_input_tokens,
      b.cache_creation_input_tokens,
    ),
  };
}

/** What an attached episode receives. */
export interface EpisodeSink {
  onMessage(msg: NdjsonMessage): void;
  /** stdout closed or the process exited while attached. */
  onClose(code: number | null): void;
  onError(err: Error): void;
}

/**
 * Anthropic prompt-cache lifetimes (https://docs.claude.com/en/docs/build-with-claude/prompt-caching):
 * an entry lives 5 minutes unless written with the 1-hour TTL, and each read
 * refreshes it. The provider uses the TTL reported by the CLI; a process
 * that has reported nothing assumes the default.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const ONE_HOUR_CACHE_TTL_MS = 60 * 60_000;

/*
 * Lines a detached process emits are held whole until the next episode
 * attaches (no count cap by design). Dropping the oldest silently lost
 * content; the buffer lives only as long as the parked process, which the
 * cache TTL ends.
 */

/** Grace after ending stdin before a still-running CLI is SIGKILLed. */
const EXIT_GRACE_MS = 500;
/** Grace after an interrupt for the CLI to persist the turn and emit result. */
const INTERRUPT_GRACE_MS = 2_000;

let controlSeq = 0;

// Lifecycle events must retire attached processes too, not only the parked pool.
const liveProcesses = new Set<CliProcess>();
const lifecycleRevision = createLifecycleRevision();
/** A provider call cannot outlive a lifecycle invalidation, even between spawns. */
export function getCliLifecycleRevision(): number { return lifecycleRevision.current(); }

/** MCP and Anthropic spell text/image blocks differently; strict equality runs first. */
function canonicalHandoffContent(content: any): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [content];
  if (!content.length) return [{ type: "text", text: "" }];
  return content.map(block => {
    if (block?.type === "text") return { type: "text", text: block.text };
    if (block?.type === "image") return { type: "image", data: block.data ?? block.source?.data,
      mimeType: block.mimeType ?? block.source?.media_type, sourceType: block.source?.type ?? "base64" };
    return block;
  });
}

/** Physically verified on CLI 2.1.283: a single-text MCP error is echoed
 * as a string with only its outer whitespace trimmed. Do not trim the received
 * body; trimming successes, multi-block results or images is not qualified.
 */
function matchesTrimmedErrorEcho(result: HandoffResult, echo: any): boolean {
  if (!result.isError || typeof echo !== "string" || result.content.length !== 1) return false;
  const block = result.content[0];
  if (block.type !== "text") return false;
  const trimmed = block.text.trim();
  return trimmed.length > 0 && echo === trimmed;
}

/** Physically observed CLI error formatting: multiple text blocks become a
 * newline-joined string, optionally outer-trimmed (CLI 2.1.311).
 * Never trim the observed body or internal whitespace;
 * an empty trimmed placeholder is not a receipt.
 */
function matchesFlattenedErrorEcho(result: HandoffResult, echo: any): boolean {
  if (!result.isError || typeof echo !== "string" || result.content.length < 2 ||
      !result.content.every(block => block.type === "text" && typeof block.text === "string")) return false;
  const joined = result.content.map(block => (block as { text: string }).text).join("\n");
  if (echo === joined) return true;
  const trimmed = joined.trim();
  return trimmed.length > 0 && echo === trimmed;
}

/** Body-free diagnostics; hash full representations, never log a prefix/sample. */
function receiptMetadata(content: any, isError: boolean): ReceiptContentMetadata {
  const canonical = canonicalHandoffContent(content);
  const text = canonical.filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text);
  const raw = JSON.stringify(content) ?? "undefined";
  const encoded = JSON.stringify(canonical);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    representation: typeof content === "string" ? "string" : Array.isArray(content) ? "blocks" : "other",
    blockKinds: canonical.map(block => block?.type === "text" ? "text" : block?.type === "image" ? "image" : "other"),
    images: canonical.flatMap((block, blockIndex) => block?.type === "image" ? [{
      blockIndex,
      declaredMediaType: (["image/png", "image/jpeg", "image/webp", "image/gif"] as const)
        .find(media => media === block.mimeType) ?? "other",
      header: receiptImageHeader(block),
    }] : []),
    isError,
    textChars: text.reduce((sum, value) => sum + value.length, 0),
    textBytes: text.reduce((sum, value) => sum + Buffer.byteLength(value), 0),
    rawBytes: Buffer.byteLength(raw), rawSha256: hash(raw),
    canonicalBytes: Buffer.byteLength(encoded), canonicalSha256: hash(encoded),
  };
}

export class CliProcess implements HandoffTarget {
  readonly ledger?: RequestLedger;
  readonly proc: ChildProcess;
  readonly cliSessionId: string;
  /** Spawn parameters; a later call may only reuse the process if they match. */
  readonly signature: string;
  /** True when proxied handoffs are on for this process. */
  readonly allowHandoff: boolean;
  readonly getStderr: () => string;
  /** Pi history acknowledged by this disposable process, never a second ledger. */
  piHistory?: { length: number; hash: string };
  /** One settled failed episode that Pi may omit before its native retry. */
  recoverableFailure?: { hash: string; retry: boolean };
  /**
   * The thinking the CLI will use for its next user turn: the spawn flags,
   * then every change `applyThinking` got acknowledged.
   */
  thinking: CliThinking;

  /**
   * When the prompt cache this process reads expires: the last request
   * refreshed it, and it lives for the longest TTL class the CLI has written.
   * Undefined until a request reports usage.
   */
  private cacheTouchedAt: number | undefined;
  cacheTtlMs = DEFAULT_CACHE_TTL_MS;
  get cacheExpiresAt(): number | undefined {
    return this.cacheTouchedAt === undefined ? undefined : this.cacheTouchedAt + this.cacheTtlMs;
  }

  /** Mid-turn users written to stdin but not yet confirmed by a CLI result. */
  private pendingSteers = new Set<string>();

  get hasPendingSteers(): boolean {
    return this.pendingSteers.size > 0;
  }

  /** A user message has been written and no `result` has followed yet. */
  turnActive = false;
  alive = true;
  exitCode: number | null | undefined;
  /** Retired by the pool or the provider; no episode may attach again. */
  retired = false;
  /** Strict receipt failure: the provider must reimport Pi history, never resume. */
  handoffReceiptMismatch?: HandoffReceiptMismatch;
  private retirement?: Promise<void>;
  /** Cause supplied before a forced exit can race the provider's retire call. */
  expectedExitReason?: string[];

  /**
   * Shared across episodes: call markers whose results may arrive later,
   * mapped to the tool each one named so its result marker can name it too.
   */
  readonly markedTools = new Map<string, string>();
  /** Shared across episodes: sub-agents live in the process, not the call. */
  readonly taskTracker = createTaskTracker();

  /**
   * `result.modelUsage` is cumulative for the process. Per-turn spend is the
   * delta against the previous result.
   */
  lastProcessTotals: Usage4 = ZERO_USAGE;
  /** Usage already handed to pi by earlier episodes of the current turn. */
  turnReported: Usage4 = ZERO_USAGE;

  private sink: EpisodeSink | undefined;
  private buffer: NdjsonMessage[] = [];
  /** Handoff tool_use ids seen in the current assistant message. */
  private awaiting = new Set<string>();
  /** pi tool name the model asked for, by tool_use id. */
  private awaitedNames = new Map<string, string>();
  /** `tools/call` arrived, pi has not answered yet. */
  private pending = new Map<string, HandoffCall>();
  /** pi answered, `tools/call` has not arrived yet. */
  private ready = new Map<string, HandoffResult>();
  /** Socket acceptance is not CLI consumption: wait for its tool_result echo. */
  private deliveryWaiters = new Map<string, { result: HandoffResult; settle: (delivered: boolean) => void }>();
  get hasUnconfirmedHandoffResults(): boolean { return this.deliveryWaiters.size > 0; }
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closeWaiters: Array<() => void> = [];
  private onExitHandlers: Array<(code: number | null) => void> = [];
  /** Our own control requests awaiting the CLI's answer, by request id. */
  private controlWaiters = new Map<string, (ok: boolean) => void>();

  constructor(
    proc: ChildProcess,
    options: {
      cliSessionId: string;
      signature: string;
      allowHandoff: boolean;
      getStderr: () => string;
      thinking?: CliThinking;
      ledger?: RequestLedger;
    },
  ) {
    this.proc = proc;
    this.ledger = options.ledger;
    liveProcesses.add(this);
    this.cliSessionId = options.cliSessionId;
    this.signature = options.signature;
    this.allowHandoff = options.allowHandoff;
    this.getStderr = options.getStderr;
    this.thinking = options.thinking ?? { kind: "default" };

    if (this.allowHandoff) registerHandoffTarget(this.cliSessionId, this);

    const rl = createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
      terminal: false,
    });
    // 'line' rather than `for await`: the async iterator batches lines and
    // breaks real-time streaming to pi.
    rl.on("line", (line: string) => this.handleLine(line));
    // stdout EOF ends the episode's view; only the process's own close ends
    // the process (a host may see EOF first, or — with mocks — only EOF).
    rl.on("close", () => this.handleStdoutClose());
    proc.on("error", (err: Error) => {
      this.sink?.onError(err);
    });
    proc.on("close", (code: number | null) => {
      this.exitCode = code;
      this.handleProcClose(code);
    });
  }

  // ---- episode attachment -------------------------------------------------

  attach(sink: EpisodeSink): void {
    if (this.retired) throw new Error("CliProcess is retired");
    this.clearIdleTimer();
    this.sink = sink;
    const queued = this.buffer;
    this.buffer = [];
    for (const msg of queued) sink.onMessage(msg);
    if (!this.alive || this.stdoutClosed) sink.onClose(this.exitCode ?? null);
  }

  detach(): void {
    this.sink = undefined;
  }

  /** Preserve frames held by a provider observer after its episode detaches. */
  prependDetachedMessages(messages: NdjsonMessage[]): void {
    this.buffer = [...messages, ...this.buffer];
  }

  /** Drain detached frames after retirement; bodies must never be republished. */
  takeDetachedMessages(): NdjsonMessage[] {
    const queued = this.buffer;
    this.buffer = [];
    return queued;
  }

  get attached(): boolean {
    return this.sink !== undefined;
  }

  private observeCache(msg: NdjsonMessage): void {
    if ((msg as any).type !== "stream_event") return;
    const event = (msg as any).event;
    const usage = event?.type === "message_start" ? event.message?.usage
      : event?.type === "message_delta" ? event.usage : undefined;
    if (!usage) return;
    // Reads and writes both refresh the cached prefix from this request on.
    if (event.type === "message_start") this.cacheTouchedAt = Date.now();
    if (usage.cache_creation?.ephemeral_1h_input_tokens > 0)
      this.cacheTtlMs = Math.max(this.cacheTtlMs, ONE_HOUR_CACHE_TTL_MS);
  }

  /** Retire this process when nobody comes back for `ms`. */
  startIdleTimer(ms: number, onExpire: () => void): void {
    this.clearIdleTimer();
    if (!(ms > 0)) return;
    this.idleTimer = setTimeout(onExpire, ms);
    this.idleTimer.unref?.();
  }

  clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  onExit(handler: (code: number | null) => void): void {
    this.onExitHandlers.push(handler);
  }

  // ---- turn I/O -----------------------------------------------------------

  writeUser(prompt: string | any[]): void {
    this.turnActive = true;
    writeUserMessage(this.proc, prompt);
  }

  /** Called only after the preceding turn's result: a real independent user. */
  writeSteer(blocks: any[]): void {
    if (this.turnActive) throw new Error("Steering requires a settled CLI turn");
    const uuid = randomUUID();
    try {
      this.pendingSteers.add(uuid);
      this.turnActive = true;
      writeUserMessage(this.proc, blocks, uuid);
    } catch (error) {
      // An uncertain/failed write cannot leave a reusable CLI behind.
      void this.retire(["steer_write_error"]);
      throw error;
    }
  }

  /** Process-owned acknowledgements run once at stdout ingress, before hooks. */
  confirmUserEcho(message: any): void {
    if (message.type !== "user" || message.message?.role !== "user" || message.parent_tool_use_id) return;
    if (typeof message.uuid === "string") this.pendingSteers.delete(message.uuid);
    for (const block of Array.isArray(message.message.content) ? message.message.content : []) {
      if (block?.type !== "tool_result") continue;
      const receipt = this.deliveryWaiters.get(block.tool_use_id);
      if (!receipt) continue;
      const sameError = !!block.is_error === !!receipt.result.isError;
      const expectedContent = canonicalHandoffContent(receipt.result.content);
      const observedContent = canonicalHandoffContent(block.content);
      const sameContent = JSON.stringify(observedContent) === JSON.stringify(expectedContent);
      if (!sameError || (!sameContent &&
          !matchesTrimmedErrorEcho(receipt.result, block.content) &&
          !matchesFlattenedErrorEcho(receipt.result, block.content) &&
          !matchesDerivativeImages(expectedContent, observedContent))) {
        // A same-ID generic denial is not the Pi result, even for isError=true.
        const expected = receiptMetadata(receipt.result.content, !!receipt.result.isError);
        const observed = receiptMetadata(block.content, !!block.is_error);
        const kinds: HandoffReceiptMismatch["kinds"] = [];
        if (!sameError) kinds.push("error_status");
        if (expected.representation !== observed.representation ||
          JSON.stringify(expected.blockKinds) !== JSON.stringify(observed.blockKinds)) kinds.push("representation");
        if (expected.canonicalBytes !== observed.canonicalBytes) kinds.push("content_length");
        if (expected.canonicalSha256 !== observed.canonicalSha256) kinds.push("content_hash");
        void this.retire(["handoff_receipt_mismatch"], { toolUseId: block.tool_use_id, kinds, expected, observed });
        return;
      }
      this.deliveryWaiters.delete(block.tool_use_id);
      receipt.settle(true);
    }
  }

  /** Confirm consumption, not just a successful stdin write. */
  confirmSteers(result: any): "confirmed" | "pending" | "unconfirmed" {
    if (!this.hasPendingSteers) return "confirmed";
    // Empty queued notifications cannot acknowledge a steer.
    if (result.num_turns === 0) return "pending";
    const ids = Array.isArray(result.user_message_uuids)
      ? result.user_message_uuids
      : typeof result.user_message_uuid === "string"
        ? [result.user_message_uuid]
        : undefined;
    if (!ids) return "unconfirmed";
    for (const id of ids) this.pendingSteers.delete(id);
    return this.hasPendingSteers ? "pending" : "confirmed";
  }

  /**
   * Move the process to `desired` thinking before its next user turn.
   *
   * Resolves true once every control request is acknowledged. False means
   * the process cannot take the change in place (a live turn, a dead or
   * retired process, a CLI refusal, the process exiting or being retired
   * before it answers — pi's abort does that — or a target only a spawn can
   * reach). There is no answer deadline: the CLI answers every control request. The
   * caller then retires it and spawns with the right flags, so the next turn
   * is correct either way; only the warm process is lost.
   *
   * Only called between turns: the CLI reads thinking once per user turn, so
   * a change sent mid-turn would not reach the rest of that turn anyway
   * (verified on 2.1.283 with a change sent during a tool call).
   */
  async applyThinking(desired: CliThinking): Promise<boolean> {
    const controls = thinkingControls(this.thinking, desired);
    if (controls === undefined) return false;
    for (const control of controls) {
      if (!(await this.sendControl(control))) return false;
    }
    this.thinking = desired;
    return true;
  }

  private sendControl(request: ThinkingControl): Promise<boolean> {
    const stdin = this.proc.stdin;
    if (
      !this.alive ||
      this.retired ||
      this.turnActive ||
      this.stdoutClosed ||
      !stdin
    )
      return Promise.resolve(false);
    const requestId = `pcc-${(++controlSeq).toString(36)}-${Date.now().toString(36)}`;
    return new Promise<boolean>((resolve) => {
      const settle = (ok: boolean) => {
        this.controlWaiters.delete(requestId);
        resolve(ok);
      };
      this.controlWaiters.set(requestId, settle);
      try {
        stdin.write(
          JSON.stringify({
            type: "control_request",
            request_id: requestId,
            request,
          }) + "\n",
        );
      } catch {
        settle(false);
      }
    });
  }

  /** Answer every outstanding control request with a failure. */
  private failControlWaiters(): void {
    for (const settle of [...this.controlWaiters.values()]) settle(false);
  }

  /**
   * The episode decided a `result` was not the end of the turn (the CLI
   * answered a queued prompt of its own, or sub-agents are still running):
   * the turn is live again for the process.
   */
  resumeTurn(): void {
    if (this.alive && !this.retired) this.turnActive = true;
  }

  // ---- handoff bookkeeping ------------------------------------------------

  /**
   * A handoff tool_use block streamed in the current assistant message.
   *
   * `piToolName` is what the model actually asked for. Recording it lets
   * `onHandoffCall` refuse a call that names a different tool than the block
   * it claims to answer — a peer on the broker socket cannot borrow a live
   * tool_use id to get some other tool executed.
   */
  noteHandoffToolUse(toolUseId: string, piToolName?: string): void {
    this.awaiting.add(toolUseId);
    if (piToolName) this.awaitedNames.set(toolUseId, piToolName);
  }

  /** Can pi's toolResults for these ids continue the running turn? */
  canContinueHandoff(toolUseIds: string[]): boolean {
    if (!this.alive || this.retired || !this.turnActive) return false;
    const expected = new Set([...this.awaiting, ...this.pending.keys()]);
    const supplied = new Set(toolUseIds);
    return (
      expected.size > 0 &&
      supplied.size === toolUseIds.length &&
      supplied.size === expected.size &&
      toolUseIds.every((id) => expected.has(id))
    );
  }

  /** Deliver pi's result. Answers the CLI now or when its call arrives. */
  deliverHandoffResult(toolUseId: string, result: HandoffResult): Promise<boolean> {
    const receipt = new Promise<boolean>(settle => this.deliveryWaiters.set(toolUseId, { result, settle }));
    const call = this.pending.get(toolUseId);
    if (call) {
      this.pending.delete(toolUseId);
      call.respond(result);
    } else {
      this.awaiting.delete(toolUseId);
      this.ready.set(toolUseId, result);
    }
    return receipt;
  }

  /** HandoffTarget: the schema server forwarded a `tools/call`. */
  onHandoffCall(call: HandoffCall): void {
    const id = call.toolUseId;
    if (!id) {
      // No id tag (older CLI). Fall back to the single awaited handoff if the
      // shape is unambiguous, otherwise refuse rather than guess.
      const ids = [...this.awaiting, ...this.ready.keys()];
      if (ids.length !== 1) {
        call.respond(errorResult(UNMATCHED_CALL_MESSAGE));
        return;
      }
      this.routeCall(ids[0], call);
      return;
    }
    // An id must name a tool_use block this process actually streamed and has
    // not answered yet. Anything else — an id from a sub-agent's nested block,
    // a replayed id, a value invented by whoever reached the socket — is
    // refused. It used to land in `pending`, where nothing would ever deliver
    // a result for it and the caller blocked until the MCP timeout (an hour).
    if (!this.awaiting.has(id) && !this.ready.has(id)) {
      call.respond(errorResult(UNMATCHED_CALL_MESSAGE));
      return;
    }
    const expected = this.awaitedNames.get(id);
    if (expected && call.name && call.name !== expected) {
      call.respond(
        errorResult(
          `pi refused this tool call: tool_use ${id} asked for "${expected}", not "${call.name}"`,
        ),
      );
      return;
    }
    this.routeCall(id, call);
  }

  private routeCall(id: string, call: HandoffCall): void {
    this.awaiting.delete(id);
    this.awaitedNames.delete(id);
    const ready = this.ready.get(id);
    if (ready) {
      this.ready.delete(id);
      call.respond(ready);
      return;
    }
    this.pending.set(id, call);
  }

  /** Answer every open call with an error; used on retire and turn end. */
  private failPendingCalls(message: string): void {
    for (const call of this.pending.values())
      call.respond(errorResult(message));
    this.pending.clear();
    this.awaiting.clear();
    this.awaitedNames.clear();
    this.ready.clear();
    for (const receipt of this.deliveryWaiters.values()) receipt.settle(false);
    this.deliveryWaiters.clear();
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * End the process for good. A live turn is interrupted first so the CLI
   * persists its transcript (a SIGKILL mid-turn poisons every later resume
   * with synthetic filler). Resolves once the process has closed or been
   * force-killed.
   */
  retire(reasons: string[] = ["retire"], handoffReceiptMismatch?: HandoffReceiptMismatch): Promise<void> {
    if (this.retired) return this.retirement ?? this.waitClosed();
    this.handoffReceiptMismatch = handoffReceiptMismatch;
    this.retired = true;
    this.pendingSteers.clear();
    // Keep lifecycle ownership until observed close, including recovery waits.
    this.ledger?.retire(reasons, handoffReceiptMismatch);
    removeSessionMcpConfig(this.cliSessionId);
    this.clearIdleTimer();
    unregisterHandoffTarget(this.cliSessionId, this);
    this.failPendingCalls("pi abandoned this tool call.");
    this.failControlWaiters();
    if (!this.alive) return Promise.resolve();

    // Signal delivery is not termination. Replacement and lifecycle callers
    // await observed close; existing timers still request the necessary kill.
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    this.closeWaiters.push(() => settle());

    // Timers, not awaits: the kill must fire from the timer callback itself
    // so a host driving fake timers (and a wedged CLI) sees it promptly.
    const endThenKill = () => {
      if (!this.alive) return;
      try {
        this.proc.stdin?.end();
      } catch {
        /* already closed */
      }
      const killTimer = setTimeout(() => {
        if (this.alive) forceKillProcess(this.proc);
      }, EXIT_GRACE_MS);
      killTimer.unref?.();
      this.closeWaiters.push(() => clearTimeout(killTimer));
    };
    if (this.turnActive && !this.stdoutClosed) {
      // Let the CLI persist the interrupted turn before stdin goes away.
      sendInterrupt(this.proc);
      const graceTimer = setTimeout(endThenKill, INTERRUPT_GRACE_MS);
      graceTimer.unref?.();
      this.closeWaiters.push(() => clearTimeout(graceTimer));
    } else {
      endThenKill();
    }
    return this.retirement = settled;
  }

  private waitClosed(): Promise<void> {
    if (!this.alive) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  private handleLine(line: string): void {
    const msg = parseLine(line);
    if (!msg) return;
    this.ledger?.observe(msg);
    this.observeCache(msg);
    if (msg.type === "user") this.confirmUserEcho(msg);

    // The answer to a control request of ours goes to whoever sent it, never
    // to an episode or the detached buffer: it is not part of any turn.
    if (msg.type === "control_response") {
      const settle = this.controlWaiters.get(msg.response?.request_id);
      if (settle) {
        settle(msg.response.subtype === "success");
        return;
      }
    }

    if (msg.type === "control_request") {
      // Answered here so a permission prompt is never left waiting while no
      // episode is attached (the CLI runs built-in tools during a handoff).
      handleControlRequest(msg, this.proc.stdin!, {
        allowHandoff: this.allowHandoff,
      });
    }

    // The turn is over before the episode sees the result, so an episode that
    // retires the process on it does not interrupt a turn that has ended.
    if (msg.type === "result") this.turnActive = false;

    if (this.sink) {
      this.sink.onMessage(msg);
    } else if (msg.type !== "control_request") {
      this.buffer.push(msg);
    }

    if (msg.type === "result") {
      // Nothing the CLI asked for during the turn can be answered any more.
      this.failPendingCalls("the turn ended before pi delivered this result.");
    }
  }

  private stdoutClosed = false;
  private handleStdoutClose(): void {
    if (this.stdoutClosed) return;
    this.stdoutClosed = true;
    // No more output means no result is coming: the turn is over.
    this.turnActive = false;
    this.failControlWaiters();
    if (!this.closed) this.sink?.onClose(this.exitCode ?? null);
  }

  private closed = false;
  private handleProcClose(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    liveProcesses.delete(this);
    if (!this.retired) {
      this.retired = true;
      this.ledger?.retire(this.expectedExitReason ?? ["process_exit"]);
    }
    this.ledger?.exit(code);
    removeSessionMcpConfig(this.cliSessionId);
    this.alive = false;
    this.turnActive = false;
    this.clearIdleTimer();
    unregisterHandoffTarget(this.cliSessionId, this);
    this.failPendingCalls("the Claude CLI process exited.");
    this.failControlWaiters();
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const w of waiters) w();
    for (const h of this.onExitHandlers) h(code);
    if (!this.stdoutClosed) this.sink?.onClose(code);
    this.stdoutClosed = true;
  }
}

// ---- pool ------------------------------------------------------------------

const parked = new Map<string, CliProcess>();

/** Park a process for its pi session; an existing entry is retired. */
export function parkCliProcess(
  piSessionId: string,
  cli: CliProcess,
  idleMs: number,
  expiryReason = "keepalive_expiry",
): void {
  const previous = parked.get(piSessionId);
  if (previous && previous !== cli) void previous.retire(["pool_replaced"]);
  parked.set(piSessionId, cli);
  cli.onExit(() => {
    if (parked.get(piSessionId) === cli) parked.delete(piSessionId);
  });
  const onIdle = (): void => {
    // A request the CLI made while parked refreshed the cache: keep waiting
    // until that refreshed entry expires.
    const left = (cli.cacheExpiresAt ?? 0) - Date.now();
    if (expiryReason === "cache_expiry" && left > 0) {
      cli.startIdleTimer(left, onIdle);
      return;
    }
    if (parked.get(piSessionId) === cli) parked.delete(piSessionId);
    void cli.retire([expiryReason]);
  };
  cli.startIdleTimer(idleMs, onIdle);
}

/** Take the parked process for a pi session out of the pool, if any. */
export function takeParkedCliProcess(
  piSessionId: string,
): CliProcess | undefined {
  const cli = parked.get(piSessionId);
  if (!cli) return undefined;
  parked.delete(piSessionId);
  cli.clearIdleTimer();
  if (!cli.alive || cli.retired) return undefined;
  return cli;
}

export function parkedCliProcessCount(): number {
  return parked.size;
}

/** Test seam: drop and force-kill every live process synchronously. */
export function resetCliProcessesForTests(): void {
  lifecycleRevision.invalidate();
  for (const cli of liveProcesses) {
    cli.clearIdleTimer();
    (cli as any).retired = true;
    unregisterHandoffTarget(cli.cliSessionId, cli);
    if (cli.alive) forceKillProcess(cli.proc);
  }
  parked.clear();
  liveProcesses.clear();
}

/** Retire every live process (extension lifecycle, tests). */
export async function retireAllCliProcesses(
  reason = "teardown",
): Promise<void> {
  lifecycleRevision.invalidate();
  const all = [...liveProcesses];
  parked.clear();
  await Promise.all(all.map((cli) => cli.retire([reason])));
}
