/** Metadata-only measurement. retire.log remains the single JSONL owner. */
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { packageLedgerDir } from "./data-dir.js";
import type { ReceiptImageHeader } from "./receipt-image.js";
import type { ErrorTruncation } from "./receipt-error.js";

// One ordered, best-effort writer. No request awaits it; no rotation or limits.
// Disk/write failure, host process.exit() or SIGKILL can lose pending rows;
// ordinary observed child exits/lifecycles are covered, not hard-exit durability.
let pending = Promise.resolve();
const retirementCauses = new Map<string, string[]>();
export function lastRetirementCause(piSessionId: string | undefined): string[] {
  return (piSessionId && retirementCauses.get(piSessionId)) || ["firstProcess"];
}
function append(row: Record<string, unknown>): void {
  try {
    const path = packageLedgerDir();
    const line =
      JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n";
    pending = pending
      .then(async () => {
        await mkdir(path, { recursive: true });
        const file = await open(
          join(path, "retire.log"),
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NONBLOCK,
          0o600,
        );
        try {
          // Also secure a pre-existing retire.log, not just newly created files.
          await file.chmod(0o600);
          await file.write(line);
        } finally {
          await file.close();
        }
      })
      .catch(() => {
        /* diagnostics must never affect a request */
      });
  } catch {
    /* diagnostics only */
  }
}

/** Test/proof readback seam, never used on the request path. */
export function flushRequestLedger(): Promise<void> {
  return pending;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Explicit projection: never serialize envelopes, content, args or results. */
function usage(value: any) {
  return {
    input: number(value?.input_tokens),
    cacheRead: number(value?.cache_read_input_tokens),
    cacheWrite: number(value?.cache_creation_input_tokens),
    output: number(value?.output_tokens),
    cacheWrite1h: number(value?.cache_creation?.ephemeral_1h_input_tokens),
    cacheWrite5m: number(value?.cache_creation?.ephemeral_5m_input_tokens),
  };
}

export interface ReceiptContentMetadata {
  representation: "string" | "blocks" | "other";
  blockKinds: Array<"text" | "image" | "other">;
  images: Array<{
    blockIndex: number;
    declaredMediaType: ReceiptImageHeader["mediaType"] | "other";
    header: ReceiptImageHeader | null;
  }>;
  isError: boolean;
  textChars: number;
  textBytes: number;
  rawBytes: number;
  rawSha256: string;
  canonicalBytes: number;
  canonicalSha256: string;
}
export interface HandoffReceiptMismatch {
  toolUseId: string;
  kinds: Array<"error_status" | "representation" | "content_length" | "content_hash">;
  expected: ReceiptContentMetadata;
  observed: ReceiptContentMetadata;
}

export type EpisodeMode = "spawn" | "turn" | "handoff";
export class RequestLedger {
  readonly processId = randomUUID();
  private episodeId: string | null = null;
  private mode: EpisodeMode | null = null;
  private detached: Array<{ type: string; fields: Record<string, unknown> }> =
    [];
  private request:
    | {
        requestId: string;
        startedAt: string;
        startedEpisodeId: string | null;
        startedTriggerMode: EpisodeMode | null;
        receivedDetached: boolean;
        physicalModel: string | null;
        usage: ReturnType<typeof usage>;
      }
    | undefined;

  constructor(
    private readonly metadata: {
      piSessionId: string | undefined;
      cliSessionId: string;
      requestedModel: string;
      pid: number | undefined;
      spawnCause: string[];
      systemPromptBytes: number;
      toolSchemaBytes: number | null;
      /** Account name, set only when multiple profiles are declared. */
      account?: string;
    },
  ) {
    this.record("process_spawn", {
      systemPromptBytes: metadata.systemPromptBytes,
      toolSchemaBytes: metadata.toolSchemaBytes,
    });
  }

  private record(type: string, fields: Record<string, unknown> = {}): void {
    // The account name rides every row when multiple profiles are declared,
    // so a reader can tell which subscription answered. Single-profile
    // ledgers keep their exact prior shape (no account key at all).
    const account =
      this.metadata.account !== undefined
        ? { account: this.metadata.account }
        : {};
    append({
      type,
      processId: this.processId,
      pid: this.metadata.pid ?? null,
      piSessionId: this.metadata.piSessionId ?? null,
      cliSessionId: this.metadata.cliSessionId,
      requestedModel: this.metadata.requestedModel,
      episodeId: this.episodeId,
      triggerMode: this.mode,
      spawnCause: this.metadata.spawnCause,
      ...account,
      ...fields,
    });
  }

  beginEpisode(mode: EpisodeMode): void {
    this.episodeId = randomUUID();
    this.mode = mode;
    this.record("episode_start");
    this.flushDetached();
  }
  endEpisode(): void {
    this.record("episode_end");
    this.episodeId = null;
    this.mode = null;
  }
  private measurement(type: string, fields: Record<string, unknown>): void {
    const stamped = { at: new Date().toISOString(), ...fields };
    if (this.episodeId) this.record(type, stamped);
    else this.detached.push({ type, fields: stamped });
  }
  private flushDetached(): void {
    for (const row of this.detached)
      this.record(row.type, { ...row.fields, receivedDetached: true });
    this.detached = [];
  }
  retire(reasons: string[], handoffReceiptMismatch?: HandoffReceiptMismatch): void {
    if (this.metadata.piSessionId)
      retirementCauses.set(this.metadata.piSessionId, reasons);
    this.flushDetached();
    this.record("retire", { reasons, ...(handoffReceiptMismatch ? { handoffReceiptMismatch } : {}) });
  }
  toolResultLoss(toolUseId: string, loss: ErrorTruncation): void {
    this.record("tool_result_vendor_truncation", { toolUseId, ...loss });
  }
  exit(code: number | null): void {
    this.flushDetached();
    this.record("process_exit", { exitCode: code });
  }

  /** Called once at stdout ingress, even detached; never on buffered replay. */
  observe(msg: any): void {
    if (!msg || msg.parent_tool_use_id) return;
    if (msg.type === "stream_event") {
      const event = msg.event;
      if (!event || typeof event !== "object") return;
      if (event.type === "message_start") {
        this.request = {
          requestId: randomUUID(),
          startedAt: new Date().toISOString(),
          startedEpisodeId: this.episodeId,
          startedTriggerMode: this.mode,
          receivedDetached: this.episodeId === null,
          physicalModel: string(event.message?.model),
          usage: usage(event.message?.usage),
        };
      } else if (event.type === "message_delta" && this.request) {
        const delta = usage(event.usage);
        // message_delta fields are final counters for this request, NOT additions.
        for (const key of Object.keys(delta) as Array<keyof typeof delta>) {
          if (delta[key] !== null) this.request.usage[key] = delta[key];
        }
      } else if (event.type === "message_stop" && this.request) {
        this.measurement("request", {
          ...this.request,
          usage: this.request.usage,
        });
        this.request = undefined;
      }
    } else if (msg.type === "system" && msg.subtype === "init") {
      this.measurement("process_init", {
        physicalModel: string(msg.model),
        reportedCliSessionId: string(msg.session_id),
      });
    } else if (msg.type === "result") {
      const modelUsage = Object.entries(msg.modelUsage ?? {}).map(
        ([model, value]: [string, any]) => ({
          physicalModel: model,
          input: number(value?.inputTokens),
          cacheRead: number(value?.cacheReadInputTokens),
          cacheWrite: number(value?.cacheCreationInputTokens),
          output: number(value?.outputTokens),
          costUsd: number(value?.costUSD),
        }),
      );
      // This is a separate raw envelope row, NEVER added to request usage.
      this.measurement("result", {
        usage: usage(msg.usage),
        cumulativeModelUsage: modelUsage,
        totalCostUsd: number(msg.total_cost_usd),
        numTurns: number(msg.num_turns),
        reportedCliSessionId: string(msg.session_id),
      });
    } else if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info;
      this.measurement("rate_limit", {
        utilization: number(info?.utilization),
        windowType: string(info?.rateLimitType),
        resetsAt: number(info?.resetsAt),
        status: string(info?.status),
        overageStatus: string(info?.overageStatus),
        isUsingOverage:
          typeof info?.isUsingOverage === "boolean"
            ? info.isUsingOverage
            : null,
      });
    }
  }
}
