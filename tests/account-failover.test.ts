import "./cli-path-fixture";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same harness as multi-cycle: PassThrough stdout for readline, probes
// auto-complete, stream events captured.
vi.mock("cross-spawn", async () => {
  const { cliProbe } = await import("./cli-probe-fixture");
  return {
    spawn: vi.fn(() => cliProbe("2.1.283 (Claude Code)")),
    default: vi.fn(() => {
      const proc = new EventEmitter();
      const stdin = { write: vi.fn(), end: vi.fn() };
      const stdout = new PassThrough();
      const stderr = new PassThrough();
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
  execSync: vi.fn(() => Buffer.from("1.0.0")),
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

import spawn, { spawn as spawnProbe } from "cross-spawn";
import { streamViaCli } from "../src/provider";
import { resetCliProcessesForTests } from "../src/cli-process";
import { flushRequestLedger, RequestLedger } from "../src/request-ledger";
import { packageLeaf } from "../src/data-dir";
import { accountConfigDir, markAccountExhausted } from "../src/accounts";

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

const FUTURE_RESETSAT = 1893456000; // 2030-01-01T00:00:00Z, fixed test data
// A resetsAt already past when the rejection arrives: stale event or clock
// skew. The persisted file then reads "not exhausted" — only the
// in-memory tried set keeps the driver from looping.
const PAST_RESETSAT = 1000;
const WEEKLY_LIMIT_TEXT =
  "You've hit your weekly limit · resets Jan 1, 12am (Europe/Paris)";

let stateDir: string;
const childProcs = () => (spawn as any).mock.results.map((r: any) => r.value);
const spawnEnv = (index: number) =>
  (spawn as any).mock.calls[index]?.[2]?.env ?? {};

async function writeLine(proc: any, frame: unknown): Promise<void> {
  proc.stdout.write(JSON.stringify(frame) + "\n");
  await vi.advanceTimersByTimeAsync(0);
}

const rejectedEvent = (resetsAt: number) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    resetsAt,
    rateLimitType: "seven_day",
  },
});

const resultError = (
  text: string,
  usage = { input_tokens: 0, output_tokens: 0 },
) => ({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: [text],
  usage,
});

const resultSuccess = (text: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  usage: { input_tokens: 5, output_tokens: 3 },
});

async function initProc(proc: any): Promise<void> {
  // A fresh CLI acknowledges initialization; a warm one already did on an
  // earlier turn. Without this, pi's response hook holds every frame back.
  await writeLine(proc, {
    type: "system",
    subtype: "init",
    session_id: "test",
  });
}

async function textAnswer(proc: any, text: string): Promise<void> {
  await initProc(proc);
  const usage = {
    input_tokens: 5,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  for (const frame of [
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg-1", role: "assistant", model: "m", usage },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      },
    },
    { type: "stream_event", event: { type: "message_stop" } },
  ]) {
    await writeLine(proc, frame);
  }
  await writeLine(proc, resultSuccess(text));
}

function streamEvents(): any[] {
  return MockAssistantMessageEventStream.mock.instances[0]._events;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pcc-failover-"));
  resetCliProcessesForTests();
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubEnv("PI_CLAUDE_TETHER_STATE_DIR", stateDir);
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "default,b");
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "");
  vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("multi-account failover inside the provider", () => {
  it("replays a zero-output rejection on the next account inside one turn", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    const rateLimits: Array<{ info: unknown; account: unknown }> = [];
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      // Production always runs behind pi's response hook.
      onResponse: (async () => {}) as any,
      onRateLimit: ((info: unknown, account: unknown) =>
        rateLimits.push({ info, account })) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);

    const first = childProcs()[0];
    expect(spawnEnv(0).CLAUDE_CONFIG_DIR).toBe(accountConfigDir("default"));
    await initProc(first);
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    // Exactly one more spawn, under account b's profile.
    expect(childProcs()).toHaveLength(2);
    const second = childProcs()[1];
    expect(spawnEnv(1).CLAUDE_CONFIG_DIR).toBe(accountConfigDir("b"));
    // The replay reimports the full history on the new account.
    const writes = (second.stdin.write as any).mock.calls.map((c: any[]) =>
      String(c[0]),
    );
    expect(writes.some((w: string) => w.includes("hello"))).toBe(true);

    // Production repeats the rate-limit event every turn, on the new account.
    await writeLine(second, {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
    });
    await textAnswer(second, "B-ANSWER");
    await vi.advanceTimersByTimeAsync(10);

    // One Pi turn: a single done, no error.
    const events = streamEvents();
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const text = events
      .find((e) => e.type === "done")
      .message.content.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    expect(text).toContain("B-ANSWER");
    // Status carried the answering account name on each attempt.
    expect(rateLimits.map((r) => r.account)).toEqual(["default", "b"]);
  });

  it("does NOT replay when failover is off, even with two accounts listed", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(1);
    const events = streamEvents();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.error.errorMessage).toContain("weekly limit");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("does NOT replay when the rejected attempt already emitted content", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg-1", role: "assistant", model: "m", usage: {} },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "PARTIAL" },
      },
    });
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(1);
    const events = streamEvents();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.error.errorMessage).toContain("weekly limit");
  });

  it("does NOT replay a rejection that arrives after a handed-off tool", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg-1", role: "assistant", model: "m", usage: {} },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "mcp__custom-tools__continuity_tool",
          input: {},
        },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(1);
    const events = streamEvents();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.error.errorMessage).toContain("weekly limit");
  });

  it("carries the rejected result's usage-only spend into the replay", async () => {
    // When the rejected attempt streams nothing, its error result
    // carries usage.input_tokens=111. The replayed success must bill
    // 111 + its own 5, not the replay alone.
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(
      first,
      resultError(WEEKLY_LIMIT_TEXT, { input_tokens: 111, output_tokens: 0 }),
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(2);
    await textAnswer(childProcs()[1], "B-ANSWER");
    await vi.advanceTimersByTimeAsync(10);
    const done = streamEvents().find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done.message.usage.input).toBe(111 + 5);
  });

  it("carries streamed spend exactly once when the result adds nothing", async () => {
    // Account for 50 streamed input tokens followed by a zero-usage rejection.
    // Carrying the result must not double-count the streamed 50.
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg-1",
          role: "assistant",
          model: "m",
          usage: { input_tokens: 50, output_tokens: 0 },
        },
      },
    });
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(2);
    await textAnswer(childProcs()[1], "B-ANSWER");
    await vi.advanceTimersByTimeAsync(10);
    const done = streamEvents().find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done.message.usage.input).toBe(50 + 5);
  });

  it("fails with the original error plus per-account reset times when all are exhausted", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    markAccountExhausted("b", FUTURE_RESETSAT);
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    expect(spawnEnv(0).CLAUDE_CONFIG_DIR).toBe(accountConfigDir("default"));
    await initProc(first);
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(1);
    const events = streamEvents();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.error.errorMessage).toContain("weekly limit");
    expect(error.error.errorMessage).toContain(
      "all 2 Claude accounts exhausted",
    );
    expect(error.error.errorMessage).toContain("default");
    expect(error.error.errorMessage).toContain("b");
  });

  it("terminates on the declared set when every resetsAt is already past", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, rejectedEvent(PAST_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    // The past resetsAt marks nothing, but the account was still tried.
    expect(childProcs()).toHaveLength(2);
    const second = childProcs()[1];
    expect(spawnEnv(1).CLAUDE_CONFIG_DIR).toBe(accountConfigDir("b"));
    await initProc(second);
    await writeLine(second, rejectedEvent(PAST_RESETSAT));
    await writeLine(second, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    // Both accounts tried once: no third spawn, the all-exhausted error.
    expect(childProcs()).toHaveLength(2);
    const events = streamEvents();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.error.errorMessage).toContain(
      "all 2 Claude accounts exhausted",
    );
  });

  it("terminates on the declared set when exhaustion writes fail", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    // A state dir the provider cannot write to: marks are swallowed, so the
    // files can never shrink the selection — the in-memory tried set must.
    const blocker = join(stateDir, "blocker");
    writeFileSync(blocker, "not a directory");
    vi.stubEnv("PI_CLAUDE_TETHER_STATE_DIR", blocker);
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(2);
    const second = childProcs()[1];
    await initProc(second);
    await writeLine(second, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(second, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(2);
    const events = streamEvents();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.error.errorMessage).toContain(
      "all 2 Claude accounts exhausted",
    );
  });

  it("uses the manual account choice for spawns and probes", async () => {
    // A fresh name: the version-probe cache is per directory, so this
    // account's probe observably runs under its own CLAUDE_CONFIG_DIR.
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "default,c");
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "c");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(childProcs()).toHaveLength(1);
    expect(spawnEnv(0).CLAUDE_CONFIG_DIR).toBe(accountConfigDir("c"));
    const probeCalls = (spawnProbe as any).mock.calls.filter(
      (c: any[]) => c[1]?.[0] === "--version",
    );
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const call of probeCalls) {
      expect(call[2]?.env?.CLAUDE_CONFIG_DIR).toBe(accountConfigDir("c"));
    }
    await textAnswer(childProcs()[0], "B-OK");
    await vi.advanceTimersByTimeAsync(10);
    expect(streamEvents().find((e: any) => e.type === "done")).toBeDefined();
  });

  it("a single non-default account spawns and probes under its own directory", async () => {
    // The legacy shape is exactly ["default"]; a single NAMED entry is a
    // declared set, so its spawns, version probes and auth probes must run
    // under accounts/solo/claude-config, never the inherited environment.
    // A fresh name: the version-probe cache is per directory, so this
    // account's probe observably runs under its own CLAUDE_CONFIG_DIR.
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "solo");
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "solo");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(childProcs()).toHaveLength(1);
    expect(spawnEnv(0).CLAUDE_CONFIG_DIR).toBe(accountConfigDir("solo"));
    const probeCalls = (spawnProbe as any).mock.calls.filter(
      (c: any[]) => c[1]?.[0] === "--version",
    );
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const call of probeCalls) {
      expect(call[2]?.env?.CLAUDE_CONFIG_DIR).toBe(accountConfigDir("solo"));
    }
    await textAnswer(childProcs()[0], "B-OK");
    await vi.advanceTimersByTimeAsync(10);
    expect(streamEvents().find((e: any) => e.type === "done")).toBeDefined();
  });

  it("fails the turn loudly for an undeclared manual account", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "c");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(10);
    expect(childProcs()).toHaveLength(0);
    const error = streamEvents().find((e: any) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.error.errorMessage).toContain("PI_CLAUDE_TETHER_ACCOUNT");
  });

  it("stays on the fresh account for a later spawn before resetsAt", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    markAccountExhausted("default", FUTURE_RESETSAT);
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(childProcs()).toHaveLength(1);
    expect(spawnEnv(0).CLAUDE_CONFIG_DIR).toBe(accountConfigDir("b"));
    await textAnswer(childProcs()[0], "B-OK");
    await vi.advanceTimersByTimeAsync(10);
    expect(streamEvents().find((e: any) => e.type === "done")).toBeDefined();
  });

  it("keeps failover history Pi-owned without creating a session sidecar", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
      sessionId: "pi-account-pin",
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);
    expect(childProcs()).toHaveLength(2);
    expect(spawnEnv(1).CLAUDE_CONFIG_DIR).toBe(accountConfigDir("b"));
    await textAnswer(childProcs()[1], "B-PI");
    await vi.advanceTimersByTimeAsync(10);
    expect(streamEvents().find((e: any) => e.type === "done")).toBeDefined();
    expect(existsSync(join(stateDir, "session-map.json"))).toBe(false);
    expect(existsSync(join(stateDir, "sysprompt"))).toBe(false);
  });
});

describe("ledger account visibility", () => {
  it("carries the account name on every row when declared, and omits the key otherwise", async () => {
    const ledgered = new RequestLedger({
      piSessionId: "pi-1",
      cliSessionId: "cli-1",
      requestedModel: model.id,
      pid: 1,
      spawnCause: ["firstProcess"],
      systemPromptBytes: 10,
      toolSchemaBytes: null,
      account: "b",
    });
    ledgered.beginEpisode("spawn");
    ledgered.endEpisode();
    const plain = new RequestLedger({
      piSessionId: "pi-1",
      cliSessionId: "cli-2",
      requestedModel: model.id,
      pid: 2,
      spawnCause: ["firstProcess"],
      systemPromptBytes: 10,
      toolSchemaBytes: null,
    });
    plain.beginEpisode("spawn");
    plain.endEpisode();
    await flushRequestLedger();
    const ledgerPath = join(
      process.env.XDG_STATE_HOME as string,
      packageLeaf(),
      "retire.log",
    );
    const rows = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const withAccount = rows.filter((r) => r.cliSessionId === "cli-1");
    const withoutAccount = rows.filter((r) => r.cliSessionId === "cli-2");
    expect(withAccount.length).toBeGreaterThan(0);
    for (const row of withAccount) expect(row.account).toBe("b");
    for (const row of withoutAccount) expect("account" in row).toBe(false);
  });
});

describe("usage-credit guard", () => {
  const overageEvent = (isUsingOverage: boolean) => ({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      resetsAt: FUTURE_RESETSAT,
      rateLimitType: "overage",
      utilization: 1.01,
      isUsingOverage,
    },
  });

  async function guardError(): Promise<any> {
    const { isRetryableAssistantError: isRetryable } = await vi.importActual<
      typeof import("@earendil-works/pi-ai")
    >("@earendil-works/pi-ai");
    const events = streamEvents();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    const message = error.error.errorMessage as string;
    // Non-retryable by Pi's own classifier: "billing" matches, and nothing
    // retryable ("rate limit", "retry", 429/5xx, timeout) may appear.
    expect(message).toContain("overage billing");
    expect(
      isRetryable({
        stopReason: "error",
        errorMessage: message,
      } as any),
    ).toBe(false);
    return error;
  }

  it("fails an overage-billed success turn and never replays it (guard beats failover)", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "default,b");
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, overageEvent(true));
    await textAnswer(first, "BILLED-ANSWER");
    await vi.advanceTimersByTimeAsync(10);

    // One attempt only: a billed turn never replays onto another account.
    expect(childProcs()).toHaveLength(1);
    const error = await guardError();
    expect(error.error.errorMessage).toContain(
      "PI_CLAUDE_TETHER_ALLOW_USAGE_CREDITS=1",
    );
    // Streamed content stays, but the turn is failed, not answered.
    expect(error.error.errorMessage).toContain("stays in the transcript");
    expect(streamEvents().some((e) => e.type === "done")).toBe(false);
  });

  it("applies the result's usage to the guarded turn when nothing streamed", async () => {
    // The guard must not drop spend the CLI reports only in the terminal
    // result: with no streamed usage, the failed turn still bills 111 in /
    // 7 out, so Pi and the ledger see the real spend (bodies suppressed).
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, overageEvent(true));
    await writeLine(first, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "BILLED-ANSWER",
      usage: { input_tokens: 111, output_tokens: 7 },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(1);
    const error = await guardError();
    expect(error.error.usage?.input).toBe(111);
    expect(error.error.usage?.output).toBe(7);
    expect(streamEvents().some((e) => e.type === "done")).toBe(false);
  });

  it("fails an overage-billed rejection instead of failing over", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, overageEvent(true));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(1);
    const error = await guardError();
    expect(error.error.errorMessage).toContain("The CLI also reported");
    expect(error.error.errorMessage).toContain("weekly limit");
  });

  it("fires the guard instead of failing over on a rejected+overage turn", async () => {
    // Both flags set at once: the CLI billed this attempt to overage AND
    // reported a rejected limit with a future resetsAt — on two accounts
    // with failover armed. The guard runs before failover, so the turn
    // fails on the first account with no replay. With the guard removed
    // this same shape replays onto account b (2 spawns).
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "default,b");
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, overageEvent(true));
    await writeLine(first, rejectedEvent(FUTURE_RESETSAT));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(1);
    const error = await guardError();
    expect(error.error.errorMessage).toContain(
      "PI_CLAUDE_TETHER_ALLOW_USAGE_CREDITS=1",
    );
    expect(streamEvents().some((e) => e.type === "done")).toBe(false);
  });

  it("states abandoned tools when the billed turn already handed one off", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg-1", role: "assistant", model: "m", usage: {} },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "mcp__custom-tools__continuity_tool",
          input: {},
        },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 0,
      },
    });
    await writeLine(first, overageEvent(true));
    await writeLine(first, resultError(WEEKLY_LIMIT_TEXT));
    await vi.advanceTimersByTimeAsync(10);

    expect(childProcs()).toHaveLength(1);
    const error = await guardError();
    // Legacy interrupt path: pi never ran the handed-off call, and the
    // failed turn abandons it instead of executing it after the failure.
    expect(error.error.errorMessage).toContain("1 tool call(s)");
    expect(error.error.errorMessage).toContain("were not executed");
  });

  it("states standing effects for a proxied tool billed to overage", async () => {
    // allowHandoff on (session + broker socket), tool_use streamed, then an
    // overage success result with no message_stop: the guard reports the
    // recorded call as already executed through the broker.
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
      sessionId: "pi-overage",
      prepareMcpConfig: async () => ({
        schemaPath: "schema",
        version: 1,
        handoffSocket: Promise.resolve("sock"),
      }),
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await initProc(first);
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "mcp__custom-tools__continuity_tool",
          input: {},
        },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
    });
    await writeLine(first, {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    await writeLine(first, overageEvent(true));
    await writeLine(first, resultSuccess("BILLED-ANSWER"));
    await vi.advanceTimersByTimeAsync(10);

    const error = await guardError();
    expect(error.error.errorMessage).toContain("1 tool call(s)");
    expect(error.error.errorMessage).toContain("their effects stand");
  });

  it("lets an overage-billed turn succeed with PI_CLAUDE_TETHER_ALLOW_USAGE_CREDITS=1", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_ALLOW_USAGE_CREDITS", "1");
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await writeLine(first, overageEvent(true));
    await textAnswer(first, "BILLED-OK");
    await vi.advanceTimersByTimeAsync(10);

    const done = streamEvents().find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(
      done.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join(""),
    ).toContain("BILLED-OK");
    expect(streamEvents().some((e) => e.type === "error")).toBe(false);
  });

  it("ignores a non-overage window (allowed_warning without isUsingOverage)", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async () => {}) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    await writeLine(first, overageEvent(false));
    await textAnswer(first, "PLAN-OK");
    await vi.advanceTimersByTimeAsync(10);

    const done = streamEvents().find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(streamEvents().some((e) => e.type === "error")).toBe(false);
  });
});

describe("rate-limit header forwarding", () => {
  it("carries the turn's rate-limit state to after_provider_response as unified headers", async () => {
    let observed:
      { status: number; headers: Record<string, string> } | undefined;
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async (response: unknown) => {
        observed = response as typeof observed;
      }) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const first = childProcs()[0];
    // The event arrives before init, as it does on a real cold turn right
    // after it: the pre-hook scan lifts it out of the gated queue.
    await writeLine(first, {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: FUTURE_RESETSAT,
        rateLimitType: "seven_day",
        utilization: 1.01,
        isUsingOverage: false,
      },
    });
    await initProc(first);
    await textAnswer(first, "LIMIT-OK");
    await vi.advanceTimersByTimeAsync(10);

    expect(observed).toBeDefined();
    expect(observed!.status).toBe(200);
    expect(observed!.headers).toMatchObject({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(FUTURE_RESETSAT),
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-7d-utilization": "1.01",
      "anthropic-ratelimit-unified-7d-reset": String(FUTURE_RESETSAT),
    });
    // A success turn still completes; the existing status entry is untouched
    // (published through onRateLimit, asserted in the failover tests).
    expect(streamEvents().find((e) => e.type === "done")).toBeDefined();
  });

  it("sends empty headers when the CLI reported no rate-limit state", async () => {
    let observed:
      { status: number; headers: Record<string, string> } | undefined;
    streamViaCli(model, { messages: [{ role: "user", content: "hello" }] }, {
      onResponse: (async (response: unknown) => {
        observed = response as typeof observed;
      }) as any,
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    await textAnswer(childProcs()[0], "PLAIN-OK");
    await vi.advanceTimersByTimeAsync(10);

    expect(observed).toBeDefined();
    expect(observed!.headers).toEqual({});
  });
});
