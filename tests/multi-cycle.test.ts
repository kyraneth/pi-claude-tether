import "./cli-path-fixture";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Same harness as provider.test.ts: PassThrough stdout for readline.
vi.mock("cross-spawn", async () => {
  const { cliProbe } = await import("./cli-probe-fixture");
  return {
    spawn: vi.fn(() => cliProbe("2.1.283 (Claude Code)")),
    default: vi.fn(() => {
      const proc = new EventEmitter();
      const stdin = { write: vi.fn(), end: vi.fn() };
      const stdout = new PassThrough();
      const stderr = new EventEmitter();
      (proc as any).stdin = stdin;
      (proc as any).stdout = stdout;
      (proc as any).stderr = stderr;
      (proc as any).killed = false;
      (proc as any).exitCode = null;
      (proc as any).kill = vi.fn(() => {
        (proc as any).killed = true;
      });
      (proc as any).pid = 99999;
      return proc;
    }),
  };
});

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.283 (Claude Code)")),
}));

const { MockAssistantMessageEventStream } = vi.hoisted(() => {
  const MockAssistantMessageEventStream: any = vi.fn(function (this: any) {
    const events: any[] = [];
    this.push = vi.fn((event: any) => events.push(event));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockAssistantMessageEventStream };
});

vi.mock("@earendil-works/pi-ai", () => ({
  AssistantMessageEventStream: MockAssistantMessageEventStream,
  createAssistantMessageEventStream: vi.fn(
    () => new MockAssistantMessageEventStream(),
  ),
  calculateCost: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: vi.fn(() => []),
}));

import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";
import { resetCliProcessesForTests } from "../src/cli-process";

const model = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  api: "pi-claude-tether",
  provider: "pi-claude-tether",
  reasoning: true,
  input: "text",
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200000,
  maxTokens: 8192,
} as any;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Hand-written three-cycle stream exercising tool and usage contracts. */
const EPISODE = readFileSync(
  join(__dirname, "fixtures", "multi-cycle-episode.jsonl"),
  "utf8",
);

describe("multi-cycle episodes", () => {
  beforeEach(() => {
    resetCliProcessesForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runEpisode(): Promise<any> {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    for (const line of EPISODE.split("\n")) {
      if (line.trim()) proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    return { message: done.message, events: mockStream._events };
  }

  it("keeps every cycle's content in order and never loses the final answer", async () => {
    const { message } = await runEpisode();
    const kinds = message.content.map((c: any) => c.type);

    // Three thinking blocks (one per cycle), no cross-cycle folding.
    expect(kinds.filter((k: string) => k === "thinking")).toHaveLength(3);

    // The final text block is the episode's actual answer, positioned last.
    const texts = message.content.filter((c: any) => c.type === "text");
    const finalText = texts[texts.length - 1].text;
    expect(finalText).toContain("Example final answer.");
    expect(message.content[message.content.length - 1].type).toBe("text");

    // The safety net must not duplicate text the SSE stream already carried.
    const occurrences = texts.filter((t: any) =>
      t.text.includes("Example final answer."),
    );
    expect(occurrences).toHaveLength(1);
  });

  it("bills every model the episode used, not just the main agent", async () => {
    const { message } = await runEpisode();

    // The result includes usage for a second synthetic model.
    expect(message.usage.input).toBe(9 + 8);
    expect(message.usage.output).toBe(18 + 9);
    expect(message.usage.cacheRead).toBe(66);
    expect(message.usage.cacheWrite).toBe(36);
  });

  it("reports context as the last cycle's prompt, not the summed cycles", async () => {
    const { message } = await runEpisode();

    // Context uses the last cycle, not cumulative usage.
    expect(message.usage.totalTokens).toBe(4 + 23 + 13);
    expect(message.usage.totalTokens).not.toBe(9 + 18 + 66 + 36);
    expect(message.usage.totalTokens).toBeLessThan(message.usage.cacheRead);
  });

  it("preserves per-cycle usage on a Pi error when the CLI closes without a result envelope", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    // Two SSE-only cycles (break-early style: killed before `result`).
    const lines = EPISODE.split("\n").filter((l) => {
      if (!l.trim()) return false;
      const rec = JSON.parse(l);
      return rec.type === "stream_event";
    });
    // First two cycles = everything up to the second message_stop.
    let stops = 0;
    for (const line of lines) {
      proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
      if (JSON.parse(line).event.type === "message_stop" && ++stops === 2)
        break;
    }
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "error");
    // A missing terminal result fails closed, retaining the observed counters.
    expect(done.error.stopReason).toBe("error");
    expect(done.error.usage.input).toBe(5);
    expect(done.error.usage.output).toBe(11);
    expect(done.error.usage.cacheRead).toBe(21 + 22);
    expect(done.error.usage.cacheWrite).toBe(11 + 12);
    // Context still tracks the newest cycle even with no result envelope.
    expect(done.error.usage.totalTokens).toBe(3 + 22 + 12);
  });
});

describe("rate limit forwarding (account state, not turn content)", () => {
  beforeEach(() => {
    resetCliProcessesForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("hands rate_limit_event to the host and keeps it out of the message", async () => {
    const seen: Array<Record<string, unknown>> = [];
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] }, {
      onRateLimit: (info: Record<string, unknown>) => seen.push(info),
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    // Synthetic rate-limit event.
    proc.stdout.write(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1700001000,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          isUsingOverage: false,
        },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success", result: "hi" }) +
        "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      rateLimitType: "five_hour",
      resetsAt: 1700001000,
    });

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    const text = (done.message.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).not.toContain("rate_limit");
    expect(text).not.toContain("five_hour");
  });

  it("survives a host callback that throws", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] }, {
      onRateLimit: () => {
        throw new Error("host blew up");
      },
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    proc.stdout.write(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "still here",
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    expect(
      mockStream._events.find((e: any) => e.type === "done"),
    ).toBeDefined();
  });
});

/**
 * Sub-agents report back — the reason a fan-out used to be a dead end.
 *
 * The CLI answers a background `Agent` call immediately and the model ends
 * its turn to wait for the notification it was promised. The CLI emits
 * `result` for THAT turn while the agents are still working, and killing on
 * it took the agents down mid-tool-call.
 *
 * These synthetic tests exercise two results within one turn.
 */
