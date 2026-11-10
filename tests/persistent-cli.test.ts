/**
 * Pi-owned continuity: a warm CLI process survives proxied handoffs and turns.
 * Pi supplies the complete prompt and owns history; cold replacements replay it
 * without native Claude context, saved prompts, or on-disk transcript resumes.
 */
import "./cli-path-fixture";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  constants as fsConstants,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("cross-spawn", async () => {
  const { cliProbe } = await import("./cli-probe-fixture");
  return {
    spawn: vi.fn(() => cliProbe("2.1.263 (Claude Code)")),
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
        // A real ChildProcess reports termination after signal delivery.
        Promise.resolve().then(() => {
          (proc as any).signalCode = "SIGKILL";
          proc.emit("exit", null, "SIGKILL");
          stdout.end();
          proc.emit("close", null, "SIGKILL");
        });
        return true;
      });
      (proc as any).pid = 4242;
      return proc;
    }),
  };
});

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.263 (Claude Code)")),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open) };
});

const { MockStream } = vi.hoisted(() => {
  const MockStream: any = vi.fn(function (this: any) {
    const events: any[] = [];
    this.push = vi.fn((event: any) => events.push(event));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockStream };
});

vi.mock("@earendil-works/pi-ai", () => ({
  AssistantMessageEventStream: MockStream,
  createAssistantMessageEventStream: vi.fn(() => new MockStream()),
  calculateCost: vi.fn(),
}));

import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";
import {
  resetCliProcessesForTests,
  parkedCliProcessCount,
  retireAllCliProcesses,
} from "../src/cli-process";
import {
  dispatchHandoffCall as dispatchRawHandoffCall,
  resetHandoffBrokerForTests,
} from "../src/handoff-broker";
import type { HandoffCall, HandoffResult } from "../src/handoff-broker";
import { resetMcpConfigCache } from "../src/mcp-config";
import { flushRequestLedger } from "../src/request-ledger";

const model = {
  id: "claude-opus-5",
  name: "Claude Opus 5",
  api: "pi-claude-tether",
  provider: "pi-claude-tether",
  reasoning: true,
  input: "text",
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} as any;

const ourAssistant = (content: any) => ({
  role: "assistant",
  content,
  provider: "pi-claude-tether",
  api: "pi-claude-tether",
});

const line = (o: any) => JSON.stringify(o) + "\n";
const ev = (event: any) => line({ type: "stream_event", event });
const startCycle = (usage: any) =>
  ev({ type: "message_start", message: { usage } });
const text = (t: string) =>
  ev({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }) +
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: t },
  }) +
  ev({ type: "content_block_stop", index: 0 });
const rawHandoffToolUse = (id: string, name: string, raw: string, index = 0) =>
  ev({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: "" },
  }) +
  ev({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: raw },
  }) +
  ev({ type: "content_block_stop", index });
const handoffToolUse = (id: string, name: string, args: any, index = 0) =>
  rawHandoffToolUse(id, name, JSON.stringify(args), index);
const malformedToolUse = (id: string, index = 0) =>
  rawHandoffToolUse(
    id,
    "mcp__custom-tools__structured_output",
    '{"value":{"findings":[],"verified":[]}}}',
    index,
  );
const endCycle = (stop: string, output = 5) =>
  ev({
    type: "message_delta",
    delta: { stop_reason: stop },
    usage: { output_tokens: output },
  }) + ev({ type: "message_stop" });
const result = (extra: any = {}) =>
  line({ type: "result", subtype: "success", is_error: false, ...extra });

const procAt = (i: number) => (spawn as any).mock.results[i].value;
const spawnArgs = (i: number) => (spawn as any).mock.calls[i][1] as string[];
const cliIdOf = (i: number) => {
  const a = spawnArgs(i);
  const k = a.indexOf("--session-id");
  return a[k + 1];
};
const written = (proc: any): string[] =>
  (proc.stdin.write as any).mock.calls.map((c: any) => String(c[0]));
const doneOf = (n: number) =>
  MockStream.mock.instances[n]._events.find((e: any) => e.type === "done");
// Ordinary fixture calls model the CLI consuming the broker response. Transit
// race tests use dispatchRawHandoffCall and emit that receipt separately.
const dispatchHandoffCall = (id: string, call: HandoffCall) => {
  dispatchRawHandoffCall(id, {
    ...call,
    respond: (r) => {
      call.respond(r);
      const i = (spawn as any).mock.calls.findIndex(
        (_args: any, n: number) => cliIdOf(n) === id,
      );
      procAt(i).stdout.write(
        line({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call.toolUseId,
                content: r.content,
                is_error: !!r.isError,
              },
            ],
          },
        }),
      );
    },
  });
};

describe("persistent CLI process", () => {
  let stateDir: string;
  const opts = (sessionId: string, extra: any = {}) => ({
    sessionId,
    mcpConfig: {
      schemaPath: "/tmp/schema.json",
      version: 1,
      handoffSocket: "/tmp/handoff.sock",
    },
    ...extra,
  });

  beforeEach(async () => {
    await flushRequestLedger();
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
    resetMcpConfigCache();
    stateDir = mkdtempSync(join(tmpdir(), "pcc-persist-"));
    process.env.PI_CLAUDE_TETHER_STATE_DIR = stateDir;
    delete process.env.PI_CLAUDE_TETHER_KEEPALIVE_MS;
    delete process.env.PI_CLAUDE_TETHER_HANDOFF_PROXY;
  });

  afterEach(async () => {
    await flushRequestLedger();
    resetCliProcessesForTests();
    await vi.advanceTimersByTimeAsync(0);
    await flushRequestLedger();
    vi.useRealTimers();
    delete process.env.PI_CLAUDE_TETHER_STATE_DIR;
    delete process.env.PI_CLAUDE_TETHER_KEEPALIVE_MS;
    delete process.env.PI_CLAUDE_TETHER_HANDOFF_PROXY;
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("pi context continuity", () => {
    it("returns malformed MCP input to Pi for validation, then reimports instead of awaiting an impossible receipt", async () => {
      const ctx = { messages: [{ role: "user", content: "report findings" }] };
      streamViaCli(model, ctx, opts("malformed-handoff") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      // Historical Haiku structured_output failures: an extra closing brace.
      // Claude rejects malformed JSON before tools/call: no MCP receipt exists.
      const raw = '{"value":{"findings":[],"verified":[]}}}';
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          malformedToolUse("bad-json") +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(
        written(proc).some((s) => s.includes('"subtype":"interrupt"')),
      ).toBe(true);
      expect(doneOf(0)).toBeUndefined();
      proc.stdout.write(
        startCycle({ input_tokens: 2 }) +
          text("unpublished CLI continuation") +
          endCycle("end_turn") +
          result({ subtype: "error_during_execution", is_error: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(0)).toBeUndefined(); // A tail result is not observed close.
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(0)).toBeUndefined(); // Neither is stdout EOF.
      proc.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(0)).toBeUndefined(); // Wait for drained stdio / close.
      proc.emit("close", 0);
      await vi.advanceTimersByTimeAsync(0);
      const bad = doneOf(0).message;
      expect(bad.stopReason).toBe("toolUse");
      expect(
        bad.content.some((b: any) => b.text === "unpublished CLI continuation"),
      ).toBe(false);
      expect(
        bad.content.find((b: any) => b.type === "toolCall").arguments,
      ).toBe(raw);
      // Pi's validation error is authoritative; do not invent a successful result.
      const next = {
        messages: [
          ...ctx.messages,
          bad,
          {
            role: "toolResult",
            toolCallId: "bad-json",
            toolName: "structured_output",
            isError: true,
            content: [
              { type: "text", text: "Validation failed: root must be object" },
            ],
          },
        ],
      };
      streamViaCli(model, next, opts("malformed-handoff") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawnArgs(1)).not.toContain("--resume");
      expect(written(procAt(1)).join("")).toContain(
        "Validation failed: root must be object",
      );
      procAt(1).stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("repaired", "mcp__custom-tools__structured_output", {
            value: { findings: [], verified: [] },
          }) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(
        doneOf(1).message.content.find((b: any) => b.type === "toolCall")
          .arguments,
      ).toEqual({ value: { findings: [], verified: [] } });
    });
    it.each(["abort", "lifecycle"])(
      "honors %s while retiring malformed handoff input",
      async (kind) => {
        const controller = new AbortController();
        streamViaCli(
          model,
          { messages: [{ role: "user", content: "report" }] },
          opts("malformed-cancel", { signal: controller.signal }) as any,
        );
        await vi.advanceTimersByTimeAsync(0);
        const proc = procAt(0);
        proc.stdout.write(
          startCycle({ input_tokens: 10 }) +
            malformedToolUse("bad") +
            endCycle("tool_use"),
        );
        await vi.advanceTimersByTimeAsync(0);
        const shutdown =
          kind === "lifecycle"
            ? retireAllCliProcesses("session_shutdown")
            : undefined;
        if (kind === "abort") controller.abort();
        proc.stdout.write(
          result({ subtype: "error_during_execution", is_error: true }),
        );
        proc.stdout.end();
        proc.emit("exit", 0);
        proc.emit("close", 0);
        await shutdown;
        await vi.advanceTimersByTimeAsync(0);
        expect(
          MockStream.mock.instances[0]._events.find(
            (e: any) => e.type === "error",
          )?.reason,
        ).toBe("aborted");
        expect(doneOf(0)).toBeUndefined();
      },
    );

    it("executes a valid parallel sibling once and imports both real results after malformed retirement", async () => {
      const ctx = { messages: [{ role: "user", content: "report findings" }] };
      streamViaCli(model, ctx, opts("malformed-sibling") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 10 }) +
          handoffToolUse("good", "mcp__custom-tools__x", { command: "pwd" }) +
          malformedToolUse("bad", 1) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      // A CLI retirement cycle must not publish that sibling a second time.
      proc.stdout.write(
        startCycle({ input_tokens: 20 }) +
          handoffToolUse("good", "mcp__custom-tools__x", { command: "pwd" }) +
          endCycle("tool_use") +
          result(),
      );
      proc.stdout.end();
      proc.emit("exit", 0);
      proc.emit("close", 0);
      await vi.advanceTimersByTimeAsync(0);
      const out = doneOf(0).message;
      expect(
        out.content
          .filter((b: any) => b.type === "toolCall")
          .map((b: any) => b.id),
      ).toEqual(["good", "bad"]);
      // Narrow provider contract: consume every published call in both
      // episodes, just as Pi does. A duplicate publication repeats the effect.
      const executeSibling = vi.fn(() => "real pwd result");
      const executeCalls = (message: any) =>
        message.content
          .filter((b: any) => b.type === "toolCall")
          .map((b: any) => ({
            role: "toolResult",
            toolCallId: b.id,
            toolName: b.name,
            isError: b.id === "bad",
            content: [
              {
                type: "text",
                text:
                  b.id === "bad"
                    ? "Validation failed: root must be object"
                    : executeSibling(),
              },
            ],
          }));
      const results = executeCalls(out);
      streamViaCli(
        model,
        { messages: [...ctx.messages, out, ...results] },
        opts("malformed-sibling") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawnArgs(1)).not.toContain("--resume");
      expect(written(procAt(1)).join("")).toContain("real pwd result");
      expect(written(procAt(1)).join("")).toContain(
        "Validation failed: root must be object",
      );
      procAt(1).stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("recovered") +
          endCycle("end_turn") +
          result(),
      );
      await vi.advanceTimersByTimeAsync(0);
      executeCalls(doneOf(1).message);
      expect(executeSibling).toHaveBeenCalledTimes(1);
    });

    it("preserves malformed input with the handoff proxy disabled", async () => {
      process.env.PI_CLAUDE_TETHER_HANDOFF_PROXY = "0";
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "report" }] },
        opts("malformed-no-proxy") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 10 }) +
          malformedToolUse("bad") +
          endCycle("tool_use"),
      );
      proc.stdout.write(result());
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(0)).toBeUndefined();
      proc.stdout.end();
      proc.emit("exit", 0);
      proc.emit("close", 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(0).message.stopReason).toBe("toolUse");
      expect(
        doneOf(0).message.content.find((b: any) => b.type === "toolCall")
          .arguments,
      ).toBe('{"value":{"findings":[],"verified":[]}}}');
    });

    it.each([
      "nonzero exit",
      "process error",
      "result error",
      "process error without stderr",
    ])(
      "retains diagnostics from a %s during malformed retirement",
      async (failure) => {
        streamViaCli(
          model,
          { messages: [{ role: "user", content: "report" }] },
          opts("malformed-crash") as any,
        );
        await vi.advanceTimersByTimeAsync(0);
        const proc = procAt(0);
        proc.stdout.write(
          startCycle({ input_tokens: 10 }) +
            malformedToolUse("bad") +
            endCycle("tool_use"),
        );
        await vi.advanceTimersByTimeAsync(0);
        if (failure !== "process error without stderr")
          proc.stderr.emit(
            "data",
            "retirement transport crashed: diagnostic retained",
          );
        if (failure.startsWith("process error"))
          proc.emit("error", new Error("retirement transport error"));
        if (failure === "result error")
          proc.stdout.write(
            result({ subtype: "error_during_execution", is_error: true }),
          );
        await vi.advanceTimersByTimeAsync(0);
        expect(doneOf(0)).toBeUndefined();
        proc.stdout.end();
        proc.emit("exit", failure === "nonzero exit" ? 1 : 0);
        proc.emit("close", failure === "nonzero exit" ? 1 : 0);
        await vi.advanceTimersByTimeAsync(0);
        const out = doneOf(0).message;
        expect(out.stopReason).toBe("toolUse");
        expect(out.content.find((b: any) => b.type === "toolCall").id).toBe(
          "bad",
        );
        expect(
          out.content.some((b: any) =>
            b.text?.includes(
              failure === "process error without stderr"
                ? "retirement transport error"
                : "retirement transport crashed: diagnostic retained",
            ),
          ),
        ).toBe(true);
      },
    );

    it("ignores the already-armed inactivity callback while malformed retirement owns close", async () => {
      const timer = vi.spyOn(globalThis, "setTimeout");
      try {
        streamViaCli(
          model,
          { messages: [{ role: "user", content: "report" }] },
          opts("malformed-inactivity") as any,
        );
        await vi.advanceTimersByTimeAsync(0);
        const proc = procAt(0);
        proc.stdout.write(
          startCycle({ input_tokens: 10 }) +
            malformedToolUse("bad") +
            endCycle("tool_use"),
        );
        await vi.advanceTimersByTimeAsync(0);
        // Invoke the actual armed callback, not a new timeout value. This
        // isolates inactivity from the process owner's existing grace timers.
        const armed = timer.mock.calls
          .filter(([fn]) =>
            String(fn).includes("Claude CLI subprocess timed out"),
          )
          .at(-1)!;
        (armed[0] as () => void)();
        await vi.advanceTimersByTimeAsync(0);
        expect(
          MockStream.mock.instances[0]._events.some(
            (e: any) => e.type === "error",
          ),
        ).toBe(false);
        expect(proc.kill).not.toHaveBeenCalled();
        expect(doneOf(0)).toBeUndefined();
        proc.stdout.end();
        proc.emit("exit", 0);
        proc.emit("close", 0);
        await vi.advanceTimersByTimeAsync(0);
        expect(doneOf(0).message.stopReason).toBe("toolUse");
      } finally {
        timer.mockRestore();
      }
    });

    it.each([
      { raw: '"scalar"', when: "before" },
      { raw: '"scalar"', when: "after" },
      { raw: "[]", when: "before" },
      { raw: "[]", when: "after" },
    ])(
      "delivers Pi validation through a live valid-JSON $raw call arriving $when message_stop",
      async ({ raw, when }) => {
        const ctx = { messages: [{ role: "user", content: "report" }] };
        streamViaCli(model, ctx, opts("nonobject-live") as any);
        await vi.advanceTimersByTimeAsync(0);
        const proc = procAt(0);
        proc.stdout.write(
          startCycle({ input_tokens: 1 }) +
            rawHandoffToolUse(
              "nonobject",
              "mcp__custom-tools__structured_output",
              raw,
            ),
        );
        const answers: HandoffResult[] = [];
        const call = () =>
          dispatchHandoffCall(cliIdOf(0), {
            toolUseId: "nonobject",
            name: "structured_output",
            arguments: {},
            respond: (r) => answers.push(r),
          });
        if (when === "before") call();
        proc.stdout.write(endCycle("tool_use"));
        await vi.advanceTimersByTimeAsync(0);
        if (when === "after") call();
        expect(answers).toEqual([]);
        expect(
          doneOf(0).message.content.find((b: any) => b.type === "toolCall")
            .arguments,
        ).toBe(raw);
        const validation = {
          content: [
            {
              type: "text" as const,
              text: "Validation failed: root must be object",
            },
          ],
          isError: true,
        };
        streamViaCli(
          model,
          {
            messages: [
              ...ctx.messages,
              doneOf(0).message,
              {
                role: "toolResult",
                toolCallId: "nonobject",
                toolName: "structured_output",
                ...validation,
              },
            ],
          },
          opts("nonobject-live") as any,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(answers).toEqual([validation]);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(written(proc).join("")).not.toContain('"subtype":"interrupt"');
        proc.stdout.write(
          startCycle({ input_tokens: 1 }) +
            text("recovered validation") +
            endCycle("end_turn") +
            result(),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(doneOf(1).message.stopReason).toBe("stop");
      },
    );

    it("keeps the aligned prompt and warm process across follow-up turns", async () => {
      const ctx = {
        systemPrompt: "PI-PROJECT-SENTINEL",
        messages: [{ role: "user", content: "first" }],
      };
      streamViaCli(model, ctx, opts("pi-context") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      const saved = readFileSync(
        spawnArgs(0)[spawnArgs(0).indexOf("--system-prompt-file") + 1],
        "utf8",
      );
      expect(saved).toContain("PI-PROJECT-SENTINEL");
      expect(existsSync(join(stateDir, "sysprompt"))).toBe(false);
      expect(spawnArgs(0)).toContain("--no-session-persistence");
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      const next = {
        ...ctx,
        messages: [
          ...ctx.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, next, opts("pi-context") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(existsSync(join(stateDir, "sysprompt"))).toBe(false);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("two") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(1).message.stopReason).toBe("stop");
    });

    it("reuses the process after replay-equivalent Pi representation normalization", async () => {
      const ctx = { messages: [{ role: "user", content: "question" }] };
      streamViaCli(model, ctx, opts("normalized") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("answer") +
          endCycle("end_turn") +
          result(),
      );
      await vi.advanceTimersByTimeAsync(0);
      streamViaCli(
        model,
        {
          messages: [
            { role: "user", content: [{ type: "text", text: "question" }] },
            doneOf(0).message,
            { role: "user", content: "next" },
          ],
        },
        opts("normalized") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(proc.stdin.end).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(written(proc).join("")).toContain("next");
    });
  });

  describe("default pi ownership", () => {
    it("returns a structured abort before spawning", () => {
      const controller = new AbortController();
      controller.abort();
      streamViaCli(model, { messages: [] }, { signal: controller.signal });
      expect(spawn).not.toHaveBeenCalled();
      expect(MockStream.mock.instances[0]._events[0].error.stopReason).toBe(
        "aborted",
      );
    });

    it("surfaces the CLI error as an assistant error for pi retry/compaction", async () => {
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "go" }] },
        opts("error") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        result({ is_error: true, result: "prompt is too long" }),
      );
      await vi.advanceTimersByTimeAsync(10);
      const event = MockStream.mock.instances[0]._events.find(
        (e: any) => e.type === "error",
      );
      expect(event.error.stopReason).toBe("error");
      expect(event.error.errorMessage).toBe("prompt is too long");
      expect(parkedCliProcessCount()).toBe(0);
    });
    it.each(["native-turn", "branch", "compaction", "prompt"])(
      "reimports pi context after %s without stale history",
      async (change) => {
        const ctx = {
          systemPrompt: "old rules",
          messages: [{ role: "user", content: "original" }],
        };
        streamViaCli(model, ctx, opts("owned") as any);
        await vi.advanceTimersByTimeAsync(0);
        procAt(0).stdout.write(
          startCycle({ input_tokens: 1 }) +
            text("one") +
            endCycle("end_turn") +
            result(),
        );
        await vi.advanceTimersByTimeAsync(10);
        const messages: any[] = [
          ...ctx.messages,
          ourAssistant(doneOf(0).message.content),
        ];
        if (change === "native-turn")
          messages.push(
            { role: "user", content: "native question" },
            {
              role: "assistant",
              provider: "openai",
              content: [{ type: "text", text: "NATIVE FINDING" }],
            },
          );
        if (change === "branch")
          messages[0] = { role: "user", content: "edited root" };
        if (change === "compaction")
          messages.splice(0, 1, { role: "user", content: "compact summary" });
        messages.push({ role: "user", content: "follow-up" });
        streamViaCli(
          model,
          {
            systemPrompt: change === "prompt" ? "new rules" : ctx.systemPrompt,
            messages,
          },
          opts("owned") as any,
        );
        await vi.advanceTimersByTimeAsync(600);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(procAt(0).stdin.end).toHaveBeenCalled();
        expect(spawnArgs(1)).not.toContain("--resume");
        const replay = written(procAt(1)).join("");
        expect(replay).toContain("follow-up");
        if (change === "native-turn")
          expect(replay).toContain("NATIVE FINDING");
        if (change === "branch" || change === "compaction")
          expect(replay).not.toContain("original");
        procAt(1).stdout.write(
          startCycle({ input_tokens: 1 }) +
            text("two") +
            endCycle("end_turn") +
            result(),
        );
        await vi.advanceTimersByTimeAsync(10);
        expect(doneOf(1).message.stopReason).toBe("stop");
        expect(existsSync(join(stateDir, "sysprompt"))).toBe(false);
      },
    );
  });

  describe("proxied handoff", () => {
    it("hands the tool to pi WITHOUT interrupting, then answers the CLI's tools/call from the next pi call on the same process", async () => {
      const ctx1 = { messages: [{ role: "user", content: "search please" }] };
      streamViaCli(model, ctx1, opts("pi-A") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const proc = procAt(0);
      const cliId = cliIdOf(0);
      // The config file names this session so the schema server can route back.
      const cfgIdx = spawnArgs(0).indexOf("--mcp-config");
      expect(spawnArgs(0)[cfgIdx + 1]).toContain(cliId);

      proc.stdout.write(
        startCycle({
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
        }) +
          handoffToolUse("toolu_1", "mcp__custom-tools__search", { q: "x" }) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);

      // pi got the toolCall and the turn ended for pi…
      const done1 = doneOf(0);
      expect(done1.reason).toBe("toolUse");
      expect(
        done1.message.content.filter((c: any) => c.type === "toolCall"),
      ).toHaveLength(1);
      // …but the CLI was neither interrupted nor killed.
      expect(written(proc).join("")).not.toContain('"interrupt"');
      expect(proc.kill).not.toHaveBeenCalled();
      expect(parkedCliProcessCount()).toBe(1);

      // The CLI asks permission (allowed) and calls the tool over MCP.
      proc.stdout.write(
        line({
          type: "control_request",
          request_id: "perm-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "mcp__custom-tools__search",
            input: { q: "x" },
            tool_use_id: "toolu_1",
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const perm = written(proc)
        .map((w: string) => JSON.parse(w))
        .find((m: any) => m.type === "control_response");
      expect(perm.response.response.behavior).toBe("allow");

      const answers: HandoffResult[] = [];
      dispatchHandoffCall(cliId, {
        toolUseId: "toolu_1",
        name: "search",
        arguments: { q: "x" },
        respond: (r) => answers.push(r),
      });
      expect(answers).toHaveLength(0);

      // pi executed the tool and calls back with the result.
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(done1.message.content),
          {
            role: "toolResult",
            toolCallId: "toolu_1",
            toolName: "search",
            content: [{ type: "text", text: "three hits" }],
            isError: false,
          },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-A") as any);
      await vi.advanceTimersByTimeAsync(0);
      // Same process: no second spawn, no user message written, the call answered.
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(answers).toEqual([
        { content: [{ type: "text", text: "three hits" }] },
      ]);
      expect(
        written(proc).filter((w: string) => JSON.parse(w).type === "user"),
      ).toHaveLength(1);

      // The CLI continues in-process; its next cycle streams into the second pi call.
      proc.stdout.write(
        startCycle({
          input_tokens: 2,
          cache_read_input_tokens: 130,
          cache_creation_input_tokens: 20,
        }) +
          text("Found three.") +
          endCycle("end_turn", 7) +
          result({
            usage: {
              input_tokens: 12,
              output_tokens: 12,
              cache_read_input_tokens: 230,
              cache_creation_input_tokens: 25,
            },
          }),
      );
      await vi.advanceTimersByTimeAsync(10);
      const done2 = doneOf(1);
      expect(done2.reason).toBe("stop");
      expect(done2.message.content.map((c: any) => c.text).join("")).toContain(
        "Found three.",
      );
      // Parked for the next turn rather than killed.
      expect(proc.kill).not.toHaveBeenCalled();
      expect(parkedCliProcessCount()).toBe(1);
    });

    it("answers a tools/call that arrives before pi's result as soon as the result lands", async () => {
      const ctx1 = { messages: [{ role: "user", content: "go" }] };
      streamViaCli(model, ctx1, opts("pi-B") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      const cliId = cliIdOf(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("t2", "mcp__custom-tools__deploy", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      const answers: HandoffResult[] = [];
      // pi answers first…
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          {
            role: "toolResult",
            toolCallId: "t2",
            toolName: "deploy",
            content: [{ type: "text", text: "deployed" }],
          },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-B") as any);
      await vi.advanceTimersByTimeAsync(0);
      // …then the CLI's call comes in and is answered immediately.
      dispatchHandoffCall(cliId, {
        toolUseId: "t2",
        name: "deploy",
        arguments: {},
        respond: (r) => answers.push(r),
      });
      expect(answers[0].content[0]).toEqual({ type: "text", text: "deployed" });
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("falls back when a result names an unknown tool id, even with a trailing user", async () => {
      const ctx1 = { messages: [{ role: "user", content: "go" }] };
      streamViaCli(model, ctx1, opts("pi-C") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc1 = procAt(0);
      proc1.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("t3", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      // pi appends a user message after the tool result (a host injecting a screenshot, say).
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          {
            role: "toolResult",
            toolCallId: "unknown-t3",
            toolName: "x",
            content: [{ type: "text", text: "r" }],
          },
          { role: "user", content: "and look at this" },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-C") as any);
      await vi.advanceTimersByTimeAsync(0);
      // The live process is retired; its replacement replays Pi history.
      expect(written(proc1).join("")).toContain('"interrupt"');
      await vi.advanceTimersByTimeAsync(2600);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawnArgs(1)).not.toContain("--resume");
      const sent = JSON.parse(written(procAt(1))[0]).message.content;
      expect(JSON.stringify(sent)).toContain("unknown-t3");
      expect(JSON.stringify(sent)).toContain("r");
      expect(JSON.stringify(sent)).toContain("and look at this");
    });

    it.each(["error", "aborted"])(
      "continues an aborted Pi tool across a zero-usage %s assistant",
      async (stopReason) => {
        const ctx = { messages: [{ role: "user", content: "abort workload" }] };
        streamViaCli(model, ctx, opts("abort-gap") as any);
        await vi.advanceTimersByTimeAsync(0);
        const proc = procAt(0);
        proc.stdout.write(
          startCycle({ input_tokens: 1 }) +
            handoffToolUse("aborted-tool", "mcp__custom-tools__x", {}) +
            endCycle("tool_use"),
        );
        await vi.advanceTimersByTimeAsync(0);
        const answers: HandoffResult[] = [];
        dispatchHandoffCall(cliIdOf(0), {
          toolUseId: "aborted-tool",
          name: "x",
          arguments: {},
          respond: (r) => answers.push(r),
        });
        const next = {
          messages: [
            ...ctx.messages,
            doneOf(0).message,
            {
              role: "toolResult",
              toolCallId: "aborted-tool",
              toolName: "x",
              isError: true,
              content: [{ type: "text", text: "This operation was aborted" }],
            },
            {
              ...ourAssistant([]),
              stopReason,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
              },
            },
            { role: "user", content: "new instruction" },
          ],
        };
        streamViaCli(model, next, opts("abort-gap") as any);
        await vi.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(answers).toEqual([
          {
            isError: true,
            content: [{ type: "text", text: "This operation was aborted" }],
          },
        ]);
        expect(
          written(proc).filter((w) => JSON.parse(w).type === "user"),
        ).toHaveLength(1);
        proc.stdout.write(
          result({ subtype: "error_during_execution", is_error: true }),
        );
        await vi.advanceTimersByTimeAsync(0);
        const user = written(proc)
          .map((w) => JSON.parse(w))
          .filter((m) => m.type === "user")
          .at(-1);
        expect(JSON.stringify(user)).toContain("new instruction");
        expect(JSON.stringify(user)).not.toContain("abort workload");
        proc.stdout.write(
          line({ ...user, isReplay: true }) +
            startCycle({ input_tokens: 1 }) +
            text("NEW-OK") +
            endCycle("end_turn") +
            result({ num_turns: 1 }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(doneOf(1).message.content).toContainEqual({
          type: "text",
          text: "NEW-OK",
        });
        expect(parkedCliProcessCount()).toBe(1);
      },
    );

    it("waits for the CLI tool-result echo, not merely the broker write, before steering", async () => {
      const ctx = {
        messages: [{ role: "user", content: "tool-result receipt" }],
      };
      streamViaCli(model, ctx, opts("cli-receipt") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("receipt", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      const answers: HandoffResult[] = [];
      dispatchRawHandoffCall(cliIdOf(0), {
        toolUseId: "receipt",
        name: "x",
        arguments: {},
        respond: (r) => answers.push(r),
      });
      streamViaCli(
        model,
        {
          messages: [
            ...ctx.messages,
            doneOf(0).message,
            {
              role: "toolResult",
              toolCallId: "receipt",
              toolName: "x",
              content: [{ type: "text", text: "real body" }],
            },
            { role: "user", content: "new instruction" },
          ],
        },
        opts("cli-receipt") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(answers).toHaveLength(1);
      expect(written(proc).join("")).not.toContain('"interrupt"');
      proc.stdout.write(
        line({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "receipt",
                content: answers[0].content,
              },
            ],
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(written(proc).join("")).toContain('"interrupt"');
      proc.stdout.write(
        result({ subtype: "error_during_execution", is_error: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(
        written(proc).filter((w) => JSON.parse(w).type === "user"),
      ).toHaveLength(2);
    });

    it.each(["missing", "wrong-body", "wrong-error"])(
      "retires without reusing a %s CLI handoff receipt",
      async (kind) => {
        const ctx = {
          messages: [{ role: "user", content: "receipt integrity" }],
        };
        streamViaCli(model, ctx, opts("receipt-integrity") as any);
        await vi.advanceTimersByTimeAsync(0);
        const proc = procAt(0);
        proc.stdout.write(
          startCycle({ input_tokens: 1 }) +
            handoffToolUse("integrity", "mcp__custom-tools__x", {}) +
            endCycle("tool_use"),
        );
        await vi.advanceTimersByTimeAsync(0);
        const answers: HandoffResult[] = [];
        dispatchRawHandoffCall(cliIdOf(0), {
          toolUseId: "integrity",
          name: "x",
          arguments: {},
          respond: (r) => answers.push(r),
        });
        const isError = kind === "wrong-body";
        const users =
          kind === "wrong-error"
            ? []
            : [{ role: "user", content: "must not be sent" }];
        streamViaCli(
          model,
          {
            messages: [
              ...ctx.messages,
              doneOf(0).message,
              {
                role: "toolResult",
                toolCallId: "integrity",
                toolName: "x",
                content: [{ type: "text", text: "original body" }],
                isError,
              },
              ...users,
            ],
          },
          opts("receipt-integrity") as any,
        );
        await vi.advanceTimersByTimeAsync(0);
        if (kind !== "missing")
          proc.stdout.write(
            line({
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "integrity",
                    content: [{ type: "text", text: "wrong replacement" }],
                    is_error: kind === "wrong-error" || isError,
                  },
                ],
              },
            }),
          );
        proc.stdout.write(result());
        await vi.advanceTimersByTimeAsync(0);
        expect(
          written(proc).filter((w) => JSON.parse(w).type === "user"),
        ).toHaveLength(1);
        expect(
          MockStream.mock.instances[1]._events.some(
            (e: any) => e.type === "error",
          ),
        ).toBe(kind === "missing");
        expect(parkedCliProcessCount()).toBe(0);
      },
    );

    it.each(["wrong-body", "wrong-error", "image-loss"])(
      "transparently replays Pi history after a seeded %s receipt mismatch without failing the turn",
      async (kind) => {
        const ctx = {
          messages: [{ role: "user", content: "receipt recovery" }],
        };
        streamViaCli(model, ctx, opts("receipt-recovery") as any);
        await vi.advanceTimersByTimeAsync(0);
        const old = procAt(0);
        old.stdout.write(
          startCycle({ input_tokens: 1 }) +
            handoffToolUse("one", "mcp__custom-tools__x", {}) +
            handoffToolUse("two", "mcp__custom-tools__y", {}) +
            endCycle("tool_use"),
        );
        await vi.advanceTimersByTimeAsync(0);
        const answers: HandoffResult[] = [];
        for (const [id, name] of [
          ["one", "x"],
          ["two", "y"],
        ]) {
          dispatchRawHandoffCall(cliIdOf(0), {
            toolUseId: id,
            name,
            arguments: {},
            respond: (r) => answers.push(r),
          });
        }
        const expected: any[] = [
          { type: "text", text: "PI-AUTHORITATIVE-ONE" },
        ];
        if (kind === "image-loss")
          expected.push({ type: "image", data: "cGk=", mimeType: "image/png" });
        const next = {
          messages: [
            ...ctx.messages,
            doneOf(0).message,
            {
              role: "toolResult",
              toolCallId: "one",
              toolName: "x",
              content: expected,
            },
            {
              role: "toolResult",
              toolCallId: "two",
              toolName: "y",
              content: [{ type: "text", text: "PI-AUTHORITATIVE-TWO" }],
            },
            { role: "user", content: "NEWEST-QUEUED-USER" },
          ],
        };
        streamViaCli(model, next, opts("receipt-recovery") as any);
        await vi.advanceTimersByTimeAsync(0);
        expect(answers).toHaveLength(2);
        // Unverified body frames may race ahead of their tool-result receipt.
        old.stdout.write(
          startCycle({ input_tokens: 50 }) + text("UNSAFE-OLD-BODY"),
        );
        old.stdout.write(
          line({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "one",
                  is_error: kind === "wrong-error",
                  content: [
                    {
                      type: "text",
                      text:
                        kind === "wrong-body"
                          ? "CORRUPTED"
                          : "PI-AUTHORITATIVE-ONE",
                    },
                  ],
                },
              ],
            },
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(written(old).join("")).not.toContain("NEWEST-QUEUED-USER");
        old.emit("close", 0, null);
        await vi.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(spawnArgs(1)).not.toContain("--resume");
        const fresh = procAt(1);
        const replay = written(fresh).join("");
        for (const body of [
          "PI-AUTHORITATIVE-ONE",
          "PI-AUTHORITATIVE-TWO",
          "NEWEST-QUEUED-USER",
        ])
          expect(replay).toContain(body);
        expect(replay).not.toContain("CORRUPTED");
        if (kind === "image-loss") expect(replay).toContain("cGk=");
        fresh.stdout.write(
          startCycle({ input_tokens: 300 }) +
            text("RECOVERED") +
            endCycle("end_turn") +
            result(),
        );
        await vi.advanceTimersByTimeAsync(0);
        const events = MockStream.mock.instances[1]._events;
        expect(events.some((e: any) => e.type === "error")).toBe(false);
        expect(JSON.stringify(events)).not.toContain("UNSAFE-OLD-BODY");
        expect(doneOf(1).message.content).toEqual([
          { type: "text", text: "RECOVERED" },
        ]);
        expect(doneOf(1).message.usage.input).toBe(350); // Failed request's observed 50 + fresh 300, each once.
        expect(answers).toHaveLength(2); // Replay never re-dispatches completed tool effects.
        expect(parkedCliProcessCount()).toBe(1);
      },
    );

    it("writes a steer only after the tool turn's interrupted result, and accepts the real user echo", async () => {
      const ctx = {
        messages: [{ role: "user", content: "original workload" }],
      };
      streamViaCli(model, ctx, opts("real-steer") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("s", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      dispatchHandoffCall(cliIdOf(0), {
        toolUseId: "s",
        name: "x",
        arguments: {},
        respond: () => {},
      });
      const next = {
        messages: [
          ...ctx.messages,
          doneOf(0).message,
          {
            role: "toolResult",
            toolCallId: "s",
            toolName: "x",
            content: [{ type: "text", text: "TOOL-ONLY" }],
          },
          { role: "user", content: "STEER-ONLY" },
        ],
      };
      streamViaCli(model, next, opts("real-steer") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        written(proc).filter((w) => JSON.parse(w).type === "user"),
      ).toHaveLength(1);
      expect(written(proc).join("")).toContain('"interrupt"');
      proc.stdout.write(
        result({ subtype: "error_during_execution", is_error: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const user = written(proc)
        .map((w) => JSON.parse(w))
        .filter((m) => m.type === "user")
        .at(-1);
      expect(user.message.role).toBe("user");
      expect(JSON.stringify(user)).toContain("STEER-ONLY");
      expect(JSON.stringify(user)).not.toContain("TOOL-ONLY");
      expect(spawnArgs(0)).toContain("--replay-user-messages");
      proc.stdout.write(
        line({ ...user, isReplay: true }) +
          startCycle({ input_tokens: 1 }) +
          text("STEER-OK") +
          endCycle("end_turn") +
          result({ num_turns: 1 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1)).toBeDefined();
      expect(parkedCliProcessCount()).toBe(1);
      streamViaCli(
        model,
        {
          messages: [
            ...next.messages,
            doneOf(1).message,
            { role: "user", content: "followup" },
          ],
        },
        opts("real-steer") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("drains a running Pi-owned provider abort and takes the next user on the same CLI", async () => {
      const controller = new AbortController();
      const ctx = {
        messages: [{ role: "user", content: "cancel running response" }],
      };
      streamViaCli(
        model,
        ctx,
        opts("active-abort", { signal: controller.signal }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(startCycle({ input_tokens: 1 }) + text("partial"));
      controller.abort();
      expect(written(proc).join("")).toContain('"interrupt"');
      expect(proc.stdin.end).not.toHaveBeenCalled();
      proc.stdout.write(
        result({
          subtype: "error_during_execution",
          is_error: true,
          result: "OLD INTERRUPTED TEXT",
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const failed = MockStream.mock.instances[0]._events.find(
        (e: any) => e.type === "error",
      ).error;
      expect(failed.stopReason).toBe("aborted");
      expect(JSON.stringify(failed.content)).not.toContain(
        "OLD INTERRUPTED TEXT",
      );
      expect(parkedCliProcessCount()).toBe(1);
      streamViaCli(
        model,
        {
          messages: [
            ...ctx.messages,
            failed,
            { role: "user", content: "fresh instruction" },
          ],
        },
        opts("active-abort") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const prompt = written(proc)
        .map((w) => JSON.parse(w))
        .filter((m) => m.type === "user")
        .at(-1);
      expect(JSON.stringify(prompt)).toContain("fresh instruction");
      expect(JSON.stringify(prompt)).not.toContain("cancel running response");
    });

    it("an abort behind a deferred response hook waits for its own result, not a buffered old result", async () => {
      const ctx = { messages: [{ role: "user", content: "initial user" }] };
      streamViaCli(model, ctx, opts("buffered-abort") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("initial answer") +
          endCycle("end_turn") +
          result({ num_turns: 1 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      proc.stdout.write(
        startCycle({ input_tokens: 2 }) +
          text("old idle response") +
          endCycle("end_turn") +
          result({ num_turns: 1 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      const next = {
        messages: [
          ...ctx.messages,
          doneOf(0).message,
          { role: "user", content: "cancel new request" },
        ],
      };
      streamViaCli(
        model,
        next,
        opts("buffered-abort", {
          signal: controller.signal,
          onResponse: async () => {
            await gate;
          },
        }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      release();
      await vi.advanceTimersByTimeAsync(0);
      const errorOf = () =>
        MockStream.mock.instances[1]._events.find(
          (e: any) => e.type === "error",
        );
      expect(errorOf()).toBeUndefined();
      expect(parkedCliProcessCount()).toBe(0);
      proc.stdout.write(
        result({ subtype: "error_during_execution", is_error: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(errorOf().error.stopReason).toBe("aborted");
      expect(parkedCliProcessCount()).toBe(1);
      streamViaCli(
        model,
        {
          messages: [
            ...next.messages,
            errorOf().error,
            { role: "user", content: "following user" },
          ],
        },
        opts("buffered-abort") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
      "does not let buffered idle output acknowledge an unwritten user (response hook=%s)",
      async (hook) => {
        const ctx = { messages: [{ role: "user", content: "initial user" }] };
        streamViaCli(model, ctx, opts("buffered-idle") as any);
        await vi.advanceTimersByTimeAsync(0);
        const proc = procAt(0);
        proc.stdout.write(
          startCycle({ input_tokens: 1 }) +
            text("initial answer") +
            endCycle("end_turn") +
            result({ num_turns: 1 }),
        );
        await vi.advanceTimersByTimeAsync(0);
        proc.stdout.write(
          startCycle({ input_tokens: 2 }) +
            text("idle completed work") +
            endCycle("end_turn") +
            result({ num_turns: 1 }),
        );
        await vi.advanceTimersByTimeAsync(0);
        const onResponse = hook ? vi.fn(async () => {}) : undefined;
        streamViaCli(
          model,
          {
            messages: [
              ...ctx.messages,
              doneOf(0).message,
              { role: "user", content: "new user" },
            ],
          },
          opts("buffered-idle", { onResponse }) as any,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(doneOf(1)).toBeUndefined();
        expect(
          written(proc).filter((w) => JSON.parse(w).type === "user"),
        ).toHaveLength(2);
        proc.stdout.write(
          startCycle({ input_tokens: 3 }) +
            text("NEW USER ANSWER") +
            endCycle("end_turn") +
            result({ num_turns: 1 }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(JSON.stringify(doneOf(1).message.content)).toContain(
          "NEW USER ANSWER",
        );
        if (onResponse) expect(onResponse).toHaveBeenCalledTimes(1);
      },
    );

    it("waits for the late broker call before interrupting a steered handoff", async () => {
      const ctx = { messages: [{ role: "user", content: "late broker" }] };
      streamViaCli(model, ctx, opts("late-broker") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("late", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      streamViaCli(
        model,
        {
          messages: [
            ...ctx.messages,
            doneOf(0).message,
            {
              role: "toolResult",
              toolCallId: "late",
              toolName: "x",
              content: [{ type: "text", text: "real result" }],
            },
            { role: "user", content: "late steer" },
          ],
        },
        opts("late-broker") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(written(proc).join("")).not.toContain('"interrupt"');
      const answers: HandoffResult[] = [];
      dispatchHandoffCall(cliIdOf(0), {
        toolUseId: "late",
        name: "x",
        arguments: {},
        respond: (r) => answers.push(r),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(answers).toEqual([
        { content: [{ type: "text", text: "real result" }] },
      ]);
      expect(written(proc).join("")).toContain('"interrupt"');
      proc.stdout.write(
        result({ subtype: "error_during_execution", is_error: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(
        written(proc).filter((w) => JSON.parse(w).type === "user"),
      ).toHaveLength(2);
    });

    it.each([
      "API Error: Request timeout",
      "API Error: 529 overloaded",
      "API Error: ECONNRESET connection reset",
      "API Error: 503 service unavailable",
      "API Error: fetch failed",
    ])("keeps the warm CLI for Pi's retry after %s", async (error) => {
      const ctx = {
        messages: [{ role: "user", content: "original retry workload" }],
      };
      streamViaCli(model, ctx, opts("transient") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        result({
          subtype: "error_during_execution",
          is_error: true,
          result: error,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const failed = MockStream.mock.instances[0]._events.find(
        (e: any) => e.type === "error",
      ).error;
      expect(failed.errorMessage).toContain(error);
      expect(parkedCliProcessCount()).toBe(1);
      streamViaCli(
        model,
        { messages: [...ctx.messages, failed] },
        opts("transient") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const last = written(proc)
        .map((w) => JSON.parse(w))
        .filter((m) => m.type === "user")
        .at(-1);
      expect(JSON.stringify(last)).not.toContain("original retry workload");
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("RETRY-OK") +
          endCycle("end_turn") +
          result({ num_turns: 1 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1)).toBeDefined();
      expect(parkedCliProcessCount()).toBe(1);
    });

    async function steeredHandoff(extra: any = {}) {
      const ctx = { messages: [{ role: "user", content: "go" }] };
      streamViaCli(model, ctx, opts("steered", extra) as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("steer-tool", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      const answers: HandoffResult[] = [];
      dispatchHandoffCall(cliIdOf(0), {
        toolUseId: "steer-tool",
        name: "x",
        arguments: {},
        respond: (r) => answers.push(r),
      });
      const next = {
        messages: [
          ...ctx.messages,
          doneOf(0).message,
          {
            role: "toolResult",
            toolCallId: "steer-tool",
            toolName: "x",
            content: [{ type: "text", text: "r" }],
            isError: false,
          },
          { role: "user", content: "steer first" },
          {
            role: "user",
            content: [
              { type: "text", text: "steer second" },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
          },
        ],
      };
      streamViaCli(model, next, opts("steered", extra) as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(answers).toEqual([{ content: [{ type: "text", text: "r" }] }]);
      expect(
        written(proc)
          .map((w) => JSON.parse(w))
          .filter((m) => m.type === "user"),
      ).toHaveLength(1);
      expect(written(proc).join("")).toContain('"interrupt"');
      proc.stdout.write(
        result({ subtype: "error_during_execution", is_error: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const users = written(proc)
        .map((w: string) => JSON.parse(w))
        .filter((m: any) => m.type === "user");
      expect(users).toHaveLength(2);
      const steer = users[1];
      expect(steer.uuid).toEqual(expect.any(String));
      expect(steer.message.content).toEqual([
        { type: "text", text: "USER:" },
        { type: "text", text: "steer first" },
        { type: "text", text: "USER:" },
        { type: "text", text: "steer second" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
        },
      ]);
      return { proc, next, uuid: steer.uuid };
    }

    it.each(["list", "single"])(
      "absorbs trailing steers with %s UUID echo and preserves Pi's checkpoint",
      async (echo) => {
        const { proc, next, uuid } = await steeredHandoff();
        proc.stdout.write(
          startCycle({ input_tokens: 2 }) +
            text("steered answer") +
            endCycle("end_turn", 7) +
            result({
              num_turns: 2,
              ...(echo === "list"
                ? { user_message_uuids: [uuid] }
                : { user_message_uuid: uuid }),
              usage: { input_tokens: 3, output_tokens: 12 },
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(doneOf(1).reason).toBe("stop");
        expect(doneOf(1).message.usage.input).toBe(2);
        expect(doneOf(1).message.usage.output).toBe(7);
        streamViaCli(
          model,
          {
            messages: [
              ...next.messages,
              doneOf(1).message,
              { role: "user", content: "follow up" },
            ],
          },
          opts("steered") as any,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(written(proc).join("")).toContain("follow up");
      },
    );

    it("does not finish on a racing previous result or an empty queued result", async () => {
      const { proc, uuid } = await steeredHandoff();
      proc.stdout.write(result({ num_turns: 0, user_message_uuids: [uuid] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1)).toBeUndefined();
      proc.stdout.write(
        startCycle({ input_tokens: 2 }) +
          text("old answer") +
          endCycle("end_turn", 7) +
          result({
            num_turns: 1,
            user_message_uuid: "original-user",
            usage: { input_tokens: 3, output_tokens: 12 },
          }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1)).toBeUndefined();
      proc.stdout.write(
        startCycle({ input_tokens: 4 }) +
          text("steered answer") +
          endCycle("end_turn", 9) +
          result({
            num_turns: 1,
            user_message_uuids: [uuid],
            usage: { input_tokens: 4, output_tokens: 9 },
          }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1).message.usage.input).toBe(6);
      expect(doneOf(1).message.usage.output).toBe(16);
      expect(
        doneOf(1)
          .message.content.map((c: any) => c.text)
          .join(""),
      ).toContain("steered answer");
      expect(parkedCliProcessCount()).toBe(1);
    });

    it("retires without a consumption echo instead of waiting indefinitely or reusing unconfirmed history", async () => {
      const { proc } = await steeredHandoff();
      proc.stdout.write(
        startCycle({ input_tokens: 2 }) +
          text("answer") +
          endCycle("end_turn") +
          result({ num_turns: 1 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1)).toBeDefined();
      expect(parkedCliProcessCount()).toBe(0);
      expect(proc.stdin.end).toHaveBeenCalled();
    });

    it.each([
      "abort",
      "result-error",
      "stdout-close",
      "model_select",
      "session_compact",
    ])("retires a written but unconsumed steer on %s", async (exit) => {
      const controller = new AbortController();
      const { proc } = await steeredHandoff({ signal: controller.signal });
      if (exit === "abort") {
        controller.abort();
        proc.stdout.write(
          result({ subtype: "error_during_execution", is_error: true }),
        );
      } else if (exit === "result-error")
        proc.stdout.write(
          result({ subtype: "error_during_execution", is_error: true }),
        );
      else if (exit === "stdout-close") proc.stdout.end();
      else {
        const retired = retireAllCliProcesses(exit);
        await vi.advanceTimersByTimeAsync(2600);
        await retired;
      }
      await vi.advanceTimersByTimeAsync(2600);
      expect(parkedCliProcessCount()).toBe(0);
      expect(proc.stdin.end).toHaveBeenCalled();
    });

    it("does not park an interrupted result with an unconsumed steer; the next call reimports", async () => {
      const controller = new AbortController();
      const { proc, next } = await steeredHandoff({
        signal: controller.signal,
      });
      controller.abort();
      proc.stdout.write(
        result({
          subtype: "error_during_execution",
          is_error: true,
          num_turns: 1,
          user_message_uuid: "original-user",
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(parkedCliProcessCount()).toBe(0);
      streamViaCli(
        model,
        {
          messages: [
            ...next.messages,
            MockStream.mock.instances[1]._events.find(
              (e: any) => e.type === "error",
            ).error,
            { role: "user", content: "continue" },
          ],
        },
        opts("steered") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawnArgs(1)).not.toContain("--resume");
      const prompt = written(procAt(1)).join("");
      expect(prompt).toContain("steer first");
      expect(prompt).toContain("steer second");
    });

    it("keeps a written steer across another tool handoff without resending it", async () => {
      const { proc, next, uuid } = await steeredHandoff();
      proc.stdout.write(
        startCycle({ input_tokens: 2 }) +
          handoffToolUse("next-tool", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1).reason).toBe("toolUse");
      dispatchHandoffCall(cliIdOf(0), {
        toolUseId: "next-tool",
        name: "x",
        arguments: {},
        respond: () => {},
      });
      streamViaCli(
        model,
        {
          messages: [
            ...next.messages,
            doneOf(1).message,
            {
              role: "toolResult",
              toolCallId: "next-tool",
              toolName: "x",
              content: [{ type: "text", text: "r2" }],
            },
          ],
        },
        opts("steered") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(
        written(proc)
          .map((w: string) => JSON.parse(w))
          .filter((m: any) => m.uuid === uuid),
      ).toHaveLength(1);
      proc.stdout.write(
        startCycle({ input_tokens: 3 }) +
          text("answer") +
          endCycle("end_turn") +
          result({
            num_turns: 3,
            user_message_uuids: [uuid],
            usage: { input_tokens: 6, output_tokens: 15 },
          }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(2).reason).toBe("stop");
      expect(doneOf(2).message.usage.input).toBe(3);
    });

    it("retires an unconsumed steer if Pi aborts after another handoff", async () => {
      const controller = new AbortController();
      const { proc, next } = await steeredHandoff();
      proc.stdout.write(
        startCycle({ input_tokens: 2 }) +
          handoffToolUse("abort-tool", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      streamViaCli(
        model,
        {
          messages: [
            ...next.messages,
            doneOf(1).message,
            {
              role: "toolResult",
              toolCallId: "abort-tool",
              toolName: "x",
              content: [],
            },
          ],
        },
        opts("steered", { signal: controller.signal }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      proc.stdout.write(
        result({ subtype: "error_during_execution", is_error: true }),
      );
      await vi.advanceTimersByTimeAsync(2600);
      expect(parkedCliProcessCount()).toBe(0);
      expect(proc.stdin.end).toHaveBeenCalled();
    });

    it("PI_CLAUDE_TETHER_HANDOFF_PROXY=0 uses interrupt-and-replay handoff", async () => {
      process.env.PI_CLAUDE_TETHER_HANDOFF_PROXY = "0";
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "go" }] },
        opts("pi-D") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("t4", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(written(proc).join("")).toContain('"interrupt"');
      // The permission for the handoff tool is denied on this path.
      proc.stdout.write(
        line({
          type: "control_request",
          request_id: "p",
          request: {
            subtype: "can_use_tool",
            tool_name: "mcp__custom-tools__x",
            input: {},
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const perm = written(proc)
        .map((w: string) => JSON.parse(w))
        .find((m: any) => m.type === "control_response");
      expect(perm.response.response.behavior).toBe("deny");
    });
  });

  describe("large-read receipt verification", () => {
    async function prepare(extra: any = {}) {
      const ctx = { messages: [{ role: "user", content: "challenge" }] };
      streamViaCli(model, ctx, opts("challenge") as any);
      await vi.advanceTimersByTimeAsync(0);
      const old = procAt(0);
      old.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("one", "mcp__custom-tools__x", {}) +
          handoffToolUse("two", "mcp__custom-tools__y", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      const answers: any[] = [];
      for (const [id, name] of [
        ["one", "x"],
        ["two", "y"],
      ])
        dispatchRawHandoffCall(cliIdOf(0), {
          toolUseId: id,
          name,
          arguments: {},
          respond: (r) => answers.push(r),
        });
      const next = {
        messages: [
          ...ctx.messages,
          doneOf(0).message,
          {
            role: "toolResult",
            toolCallId: "one",
            toolName: "x",
            content: [{ type: "text", text: "ONE" }],
          },
          {
            role: "toolResult",
            toolCallId: "two",
            toolName: "y",
            content: [{ type: "text", text: "TWO" }],
          },
        ],
      };
      streamViaCli(model, next, opts("challenge", extra) as any);
      await vi.advanceTimersByTimeAsync(0);
      return { old, next, answers };
    }
    const receipt = (id: string, body: string) =>
      line({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: [{ type: "text", text: body }],
            },
          ],
        },
      });
    async function corrupt(old: any) {
      old.stdout.write(startCycle({ input_tokens: 50 }) + text("UNSAFE"));
      old.stdout.write(receipt("one", "CORRUPT"));
      await vi.advanceTimersByTimeAsync(0);
    }
    async function completeFresh() {
      procAt(1).stdout.write(
        startCycle({ input_tokens: 300 }) +
          text("RECOVERED") +
          endCycle("end_turn") +
          result(),
      );
      await vi.advanceTimersByTimeAsync(0);
    }
    it("does not start replacement until old process exit is observed", async () => {
      const { old } = await prepare();
      // Withhold the fake process's termination event, not the signal request.
      old.kill.mockReturnValue(true);
      await corrupt(old);
      expect(spawn).toHaveBeenCalledTimes(1);
      // Existing runtime grace path, not an invented timeout.
      await vi.advanceTimersByTimeAsync(2500);
      expect(old.kill).toHaveBeenCalledWith("SIGKILL");
      expect(old.exitCode).toBeNull();
      expect(spawn).toHaveBeenCalledTimes(1);
      old.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      await completeFresh();
    });
    it("keeps observed failed-attempt final counters during retirement", async () => {
      const { old } = await prepare();
      await corrupt(old);
      old.stdout.write(
        endCycle("end_turn", 17) +
          result({ usage: { input_tokens: 50, output_tokens: 17 } }),
      );
      old.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await completeFresh();
      expect(doneOf(1).message.usage).toMatchObject({ input: 350, output: 22 });
    });
    it("keeps failed-attempt counters when recovery is aborted", async () => {
      const controller = new AbortController();
      const { old } = await prepare({ signal: controller.signal });
      await corrupt(old);
      controller.abort();
      old.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const e = MockStream.mock.instances[1]._events.find(
        (e: any) => e.type === "error",
      );
      expect(e.reason).toBe("aborted");
      expect(e.error.usage.input).toBe(50);
    });
    it("respects lifecycle teardown during receipt recovery", async () => {
      const { old } = await prepare();
      await corrupt(old);
      const teardown = retireAllCliProcesses("session_shutdown");
      old.emit("close", 0, null);
      await teardown;
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("preserves recovered counters when the fresh attempt fails normally", async () => {
      const { old } = await prepare();
      await corrupt(old);
      old.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      const fresh = procAt(1);
      fresh.stdout.write(
        startCycle({ input_tokens: 300 }) +
          endCycle("end_turn", 7) +
          result({
            is_error: true,
            subtype: "error_during_execution",
            error: "unauthorized",
          }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const e = MockStream.mock.instances[1]._events.find(
        (e: any) => e.type === "error",
      );
      expect(e.error.usage.input).toBe(350);
    });

    it("prepares the effective Pi payload and tool catalog once per provider call", async () => {
      const onPayload = vi.fn((payload: any) => payload);
      const prepareMcpConfig = vi.fn(() => opts("challenge").mcpConfig);
      const { old } = await prepare({ onPayload, prepareMcpConfig });
      await corrupt(old);
      old.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await completeFresh();
      expect(onPayload).toHaveBeenCalledTimes(1);
      expect(prepareMcpConfig).toHaveBeenCalledTimes(1);
      expect(doneOf(1).message.usage.totalTokens).toBe(300);
    });
    it("quarantines successful parallel receipts behind asynchronous response hook", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hook = vi.fn(async () => {
        await gate;
      });
      const { old, answers } = await prepare({ onResponse: hook });
      old.stdout.write(
        startCycle({ input_tokens: 50 }) + text("SAFE") + endCycle("end_turn"),
      );
      old.stdout.write(receipt("one", "ONE"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hook).not.toHaveBeenCalled();
      expect(MockStream.mock.instances[1]._events).toHaveLength(0);
      old.stdout.write(receipt("two", "TWO") + result());
      await vi.advanceTimersByTimeAsync(0);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(MockStream.mock.instances[1]._events).toHaveLength(0);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1).message.content).toEqual([
        { type: "text", text: "SAFE" },
      ]);
      expect(answers).toHaveLength(2);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
    it("replays after partial parallel receipt success without dispatching completed effects", async () => {
      const { old, answers } = await prepare();
      old.stdout.write(receipt("one", "ONE"));
      old.stdout.write(startCycle({ input_tokens: 50 }) + text("UNSAFE"));
      old.stdout.write(receipt("two", "CORRUPT"));
      await vi.advanceTimersByTimeAsync(0);
      old.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await completeFresh();
      expect(answers).toHaveLength(2);
      expect(doneOf(1).message.content).toEqual([
        { type: "text", text: "RECOVERED" },
      ]);
      expect(
        JSON.stringify(MockStream.mock.instances[1]._events),
      ).not.toContain("UNSAFE");
      expect(doneOf(1).message.usage.input).toBe(350);
    });
    it("does not rebill recovered usage after a fresh-process handoff", async () => {
      const { old, next } = await prepare();
      await corrupt(old);
      old.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      const fresh = procAt(1);
      fresh.stdout.write(
        startCycle({ input_tokens: 300 }) +
          handoffToolUse("three", "mcp__custom-tools__z", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(doneOf(1).message.usage.input).toBe(350);
      dispatchHandoffCall(cliIdOf(1), {
        toolUseId: "three",
        name: "z",
        arguments: {},
        respond: () => {},
      });
      streamViaCli(
        model,
        {
          messages: [
            ...next.messages,
            doneOf(1).message,
            {
              role: "toolResult",
              toolCallId: "three",
              toolName: "z",
              content: [{ type: "text", text: "THREE" }],
            },
          ],
        },
        opts("challenge") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      fresh.stdout.write(
        startCycle({ input_tokens: 400 }) +
          text("DONE") +
          endCycle("end_turn", 10) +
          result({ usage: { input_tokens: 700, output_tokens: 15 } }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(doneOf(2).message.usage).toMatchObject({ input: 400, output: 10 });
    });

    describe("recovered-attempt usage accounting", () => {
      function init() {
        return line({
          type: "system",
          subtype: "init",
          session_id: "fresh",
          model: model.id,
        });
      }
      async function recovered(extra: any = {}) {
        const fixture = await prepare(extra);
        await corrupt(fixture.old);
        fixture.old.emit("close", 0, null);
        await vi.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(2);
        return { ...fixture, fresh: procAt(1) };
      }
      it("bills observed fresh-attempt usage when a deferred response hook rejects", async () => {
        let reject!: (e: Error) => void;
        const gate = new Promise<void>((_r, j) => (reject = j));
        const { fresh } = await recovered({
          onResponse: async () => {
            await gate;
          },
        });
        fresh.stdout.write(
          init() +
            startCycle({ input_tokens: 300 }) +
            text("QUARANTINED-FRESH") +
            endCycle("end_turn", 7) +
            result({ usage: { input_tokens: 300, output_tokens: 7 } }),
        );
        await vi.advanceTimersByTimeAsync(0);
        reject(new Error("hook rejected"));
        await vi.advanceTimersByTimeAsync(0);
        const e = MockStream.mock.instances[1]._events.find(
          (e: any) => e.type === "error",
        );
        expect(
          JSON.stringify(MockStream.mock.instances[1]._events),
        ).not.toContain("QUARANTINED-FRESH");
        expect(e.error.usage).toMatchObject({ input: 350, output: 7 });
      });
      it("bills fresh usage on abort after its result is buffered behind the response hook", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const controller = new AbortController();
        const { fresh } = await recovered({
          signal: controller.signal,
          onResponse: async () => {
            await gate;
          },
        });
        fresh.stdout.write(
          init() +
            startCycle({ input_tokens: 300 }) +
            text("QUARANTINED-FRESH") +
            endCycle("end_turn", 7) +
            result({ usage: { input_tokens: 300, output_tokens: 7 } }),
        );
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        release();
        await vi.advanceTimersByTimeAsync(0);
        const e = MockStream.mock.instances[1]._events.find(
          (e: any) => e.type === "error",
        );
        expect(e.reason).toBe("aborted");
        expect(
          JSON.stringify(MockStream.mock.instances[1]._events),
        ).not.toContain("QUARANTINED-FRESH");
        expect(e.error.usage).toMatchObject({ input: 350, output: 7 });
      });
      it("bills missing partial receipt terminal failure without accepting old bodies", async () => {
        const { old } = await prepare();
        old.stdout.write(receipt("one", "ONE"));
        old.stdout.write(
          startCycle({ input_tokens: 50 }) +
            text("UNCONFIRMED-BODY") +
            endCycle("end_turn", 17) +
            result({ usage: { input_tokens: 51, output_tokens: 22 } }),
        );
        await vi.advanceTimersByTimeAsync(0);
        const e = MockStream.mock.instances[1]._events.find(
          (e: any) => e.type === "error",
        );
        expect(e.reason).toBe("error");
        expect(
          JSON.stringify(MockStream.mock.instances[1]._events),
        ).not.toContain("UNCONFIRMED-BODY");
        expect(e.error.usage).toMatchObject({ input: 50, output: 17 });
        expect(spawn).toHaveBeenCalledTimes(1);
      });

      it("does not move the aborted hooked attempt's spend onto the next warm user", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const controller = new AbortController();
        const { fresh, next } = await recovered({
          signal: controller.signal,
          onResponse: async () => {
            await gate;
          },
        });
        const mu = (i: number, o: number) => ({
          [model.id]: {
            inputTokens: i,
            outputTokens: o,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        });
        fresh.stdout.write(
          init() +
            startCycle({ input_tokens: 300 }) +
            text("QUARANTINED-FRESH") +
            endCycle("end_turn", 7) +
            result({ modelUsage: mu(300, 7) }),
        );
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        release();
        await vi.advanceTimersByTimeAsync(0);
        const e = MockStream.mock.instances[1]._events.find(
          (e: any) => e.type === "error",
        );
        streamViaCli(
          model,
          {
            messages: [
              ...next.messages,
              e.error,
              { role: "user", content: "NEXT-WARM-USER" },
            ],
          },
          opts("challenge") as any,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(2);
        fresh.stdout.write(
          startCycle({ input_tokens: 400 }) +
            text("NEXT") +
            endCycle("end_turn", 11) +
            result({ modelUsage: mu(700, 18) }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(doneOf(2).message.usage).toMatchObject({
          input: 400,
          output: 11,
          totalTokens: 400,
        });
      });

      describe("deferred-hook usage ownership", () => {
        it.each(["abort", "lifecycle"])(
          "keeps start counters when %s freezes a deferred hook and CLI closes without a result",
          async (kind) => {
            let release!: () => void;
            const gate = new Promise<void>((r) => (release = r));
            const controller = new AbortController();
            const { fresh } = await recovered({
              signal: controller.signal,
              onResponse: async () => {
                await gate;
              },
            });
            fresh.stdout.write(
              init() +
                startCycle({ input_tokens: 300 }) +
                text("NEVER-PUBLISH"),
            );
            await vi.advanceTimersByTimeAsync(0);
            let shutdown: Promise<void> | undefined;
            if (kind === "abort") controller.abort();
            else shutdown = retireAllCliProcesses("session_shutdown");
            release();
            await vi.advanceTimersByTimeAsync(0);
            fresh.stdout.end();
            fresh.emit("close", null, "SIGKILL");
            if (shutdown) await shutdown;
            await vi.advanceTimersByTimeAsync(0);
            const events = MockStream.mock.instances[1]._events;
            expect(JSON.stringify(events)).not.toContain("NEVER-PUBLISH");
            const e = events.find((e: any) => e.type === "error");
            expect(e.reason).toBe("aborted");
            expect(e.error.usage).toMatchObject({
              input: 350,
              totalTokens: 300,
            });
          },
        );
        it("handles synchronous abort inside response observer with buffered result exactly once", async () => {
          const controller = new AbortController();
          const { fresh } = await recovered({
            signal: controller.signal,
            onResponse: async () => {
              controller.abort();
            },
          });
          fresh.stdout.write(
            init() +
              startCycle({ input_tokens: 300 }) +
              text("NEVER-PUBLISH") +
              endCycle("end_turn", 7) +
              result({
                modelUsage: {
                  [model.id]: { inputTokens: 300, outputTokens: 7 },
                },
              }),
          );
          await vi.advanceTimersByTimeAsync(0);
          const events = MockStream.mock.instances[1]._events;
          expect(events.filter((e: any) => e.type === "error")).toHaveLength(1);
          expect(events.some((e: any) => e.type === "done")).toBe(false);
          expect(JSON.stringify(events)).not.toContain("NEVER-PUBLISH");
          expect(
            events.find((e: any) => e.type === "error").error.usage,
          ).toMatchObject({ input: 350, output: 7, totalTokens: 300 });
        });
      });

      it("reduces duplicate cumulative result snapshots net of previously reported handoff", async () => {
        const { old } = await prepare();
        await corrupt(old);
        const snapshot = {
          modelUsage: {
            [model.id]: {
              inputTokens: 51,
              outputTokens: 22,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        };
        old.stdout.write(
          endCycle("end_turn", 17) + result(snapshot) + result(snapshot),
        );
        old.emit("close", 0, null);
        await vi.advanceTimersByTimeAsync(0);
        await completeFresh();
        expect(doneOf(1).message.usage).toMatchObject({
          input: 350,
          output: 22,
          totalTokens: 300,
        });
      });
      it("banks multiple detached cycles exactly once without their bodies", async () => {
        const { old } = await prepare();
        await corrupt(old);
        old.stdout.write(
          endCycle("end_turn", 17) +
            startCycle({ input_tokens: 70 }) +
            text("LATE-OLD-BODY") +
            endCycle("end_turn", 9) +
            result({
              modelUsage: {
                [model.id]: { inputTokens: 121, outputTokens: 31 },
              },
            }),
        );
        old.emit("close", 0, null);
        await vi.advanceTimersByTimeAsync(0);
        await completeFresh();
        expect(doneOf(1).message.usage).toMatchObject({
          input: 420,
          output: 31,
          totalTokens: 300,
        });
        expect(
          JSON.stringify(MockStream.mock.instances[1]._events),
        ).not.toContain("LATE-OLD-BODY");
      });
      it.each(["payload", "catalog", "socket"])(
        "fences lifecycle invalidation during awaited %s preparation",
        async (kind) => {
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          const options: any = opts("prep-lifecycle");
          if (kind === "payload")
            options.onPayload = async (payload: any) => {
              await gate;
              return payload;
            };
          if (kind === "catalog")
            options.prepareMcpConfig = async () => {
              await gate;
              return options.mcpConfig;
            };
          if (kind === "socket")
            options.mcpConfig = {
              ...options.mcpConfig,
              handoffSocket: gate.then(() => "/tmp/handoff.sock"),
            };
          streamViaCli(
            model,
            { messages: [{ role: "user", content: "new user" }] },
            options,
          );
          await vi.advanceTimersByTimeAsync(0);
          await retireAllCliProcesses("session_tree");
          release();
          await vi.advanceTimersByTimeAsync(0);
          expect(spawn).not.toHaveBeenCalled();
          expect(
            MockStream.mock.instances[0]._events.find(
              (e: any) => e.type === "error",
            ).reason,
          ).toBe("aborted");
        },
      );
      it("fences lifecycle while successful receipts wait behind asynchronous response hook", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { old } = await prepare({
          onResponse: async () => {
            await gate;
          },
        });
        old.stdout.write(
          receipt("one", "ONE") +
            receipt("two", "TWO") +
            startCycle({ input_tokens: 50 }) +
            text("AFTER-LIFECYCLE-BODY") +
            endCycle("end_turn", 17) +
            result({ usage: { input_tokens: 51, output_tokens: 22 } }),
        );
        await vi.advanceTimersByTimeAsync(0);
        const shutdown = retireAllCliProcesses("session_shutdown");
        old.emit("close", 0, null);
        await shutdown;
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(1);
        const events = MockStream.mock.instances[1]._events;
        expect(JSON.stringify(events)).not.toContain("AFTER-LIFECYCLE-BODY");
        const e = events.find((e: any) => e.type === "error");
        expect(e.reason).toBe("aborted");
        expect(e.error.usage).toMatchObject({ input: 50, output: 17 });
      });
    });
  });

  describe("thinking changes mid-session", () => {
    const after = (args: string[], flag: string) =>
      args.indexOf(flag) === -1 ? undefined : args[args.indexOf(flag) + 1];
    const wire = (proc: any) => written(proc).map((w: string) => JSON.parse(w));
    /** Our own thinking controls (never the CLI's permission answers). */
    const ours = (proc: any) =>
      wire(proc).filter(
        (m: any) =>
          m.type === "control_request" &&
          String(m.request_id).startsWith("pcc-"),
      );
    /** Acknowledge each control as it arrives; the provider sends them in order. */
    const ackAll = async (proc: any, subtype = "success") => {
      const answered = new Set<string>();
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(0);
        for (const c of ours(proc)) {
          if (answered.has(c.request_id)) continue;
          answered.add(c.request_id);
          proc.stdout.write(
            line({
              type: "control_response",
              response: { subtype, request_id: c.request_id },
            }),
          );
        }
      }
      await vi.advanceTimersByTimeAsync(0);
    };
    const finishTurn = async (proc: any, t: string) => {
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text(t) +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
    };
    /** Turn 1 at `level`, finished; returns the history for turn 2. */
    const firstTurn = async (session: string, level: any) => {
      const ctx = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx, opts(session, { reasoning: level }) as any);
      await vi.advanceTimersByTimeAsync(0);
      await finishTurn(procAt(0), "one");
      return [
        ...ctx.messages,
        ourAssistant(doneOf(0).message.content),
        { role: "user", content: "second" },
      ];
    };

    it("applies a new level to the warm process before the next user message", async () => {
      const messages = await firstTurn("think-1", "medium");
      expect(after(spawnArgs(0), "--effort")).toBe("medium");
      expect(after(spawnArgs(0), "--max-thinking-tokens")).toBe("8192");

      streamViaCli(
        model,
        { messages },
        opts("think-1", {
          reasoning: "high",
        }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      // Nothing is written to the CLI's turn until the change is acknowledged.
      expect(
        wire(procAt(0)).filter((m: any) => m.type === "user"),
      ).toHaveLength(1);
      await ackAll(procAt(0));

      expect(spawn).toHaveBeenCalledTimes(1);
      const lines = wire(procAt(0));
      expect(ours(procAt(0)).map((c: any) => c.request)).toEqual([
        {
          subtype: "set_max_thinking_tokens",
          max_thinking_tokens: 16384,
          thinking_display: "summarized",
        },
        { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
      ]);
      const lastControl = lines.lastIndexOf(ours(procAt(0))[1]);
      const secondUser = lines.findLastIndex((m: any) => m.type === "user");
      expect(secondUser).toBeGreaterThan(lastControl);
      await finishTurn(procAt(0), "two");
      expect(doneOf(1).message.stopReason).toBe("stop");
    });

    it("turns thinking off mid-session without a respawn", async () => {
      const messages = await firstTurn("think-2", "medium");
      streamViaCli(model, { messages }, opts("think-2") as any); // pi's off
      await ackAll(procAt(0));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ours(procAt(0)).map((c: any) => c.request)).toEqual([
        { subtype: "set_max_thinking_tokens", max_thinking_tokens: 0 },
      ]);
      await finishTurn(procAt(0), "two");
      expect(doneOf(1).message.stopReason).toBe("stop");
    });

    it("writes no controls when the level did not change", async () => {
      const messages = await firstTurn("think-3", "low");
      streamViaCli(
        model,
        { messages },
        opts("think-3", {
          reasoning: "low",
        }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(ours(procAt(0))).toHaveLength(0);
      expect(
        wire(procAt(0)).filter((m: any) => m.type === "user"),
      ).toHaveLength(2);
    });

    it("spawns with the new flags when the live process refuses the change", async () => {
      const messages = await firstTurn("think-4", "medium");
      streamViaCli(
        model,
        { messages },
        opts("think-4", {
          reasoning: "high",
        }) as any,
      );
      await ackAll(procAt(0), "error");
      await vi.advanceTimersByTimeAsync(600);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(procAt(0).stdin.end).toHaveBeenCalled();
      expect(after(spawnArgs(1), "--effort")).toBe("high");
      expect(after(spawnArgs(1), "--max-thinking-tokens")).toBe("16384");
      expect(written(procAt(1)).join("")).toContain("second");
      await finishTurn(procAt(1), "two");
      expect(doneOf(1).message.stopReason).toBe("stop");
    });

    it("a CLI slow to answer the change still gets it in place, and pi's abort ends the wait without a spawn", async () => {
      const messages = await firstTurn("think-slow", "medium");
      streamViaCli(
        model,
        { messages },
        opts("think-slow", { reasoning: "high" }) as any,
      );
      // The old 5s deadline respawned here and lost the warm process.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(spawn).toHaveBeenCalledTimes(1);
      await ackAll(procAt(0));
      await finishTurn(procAt(0), "two");
      expect(doneOf(1).message.stopReason).toBe("stop");
      expect(spawn).toHaveBeenCalledTimes(1);

      const controller = new AbortController();
      streamViaCli(
        model,
        {
          messages: [
            ...messages,
            ourAssistant(doneOf(1).message.content),
            { role: "user", content: "third" },
          ],
        },
        opts("think-slow", {
          reasoning: "low",
          signal: controller.signal,
        }) as any,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(600);
      const ended = MockStream.mock.instances[2]._events.find(
        (e: any) => e.type === "error",
      );
      expect(ended?.reason).toBe("aborted");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(procAt(0).stdin.end).toHaveBeenCalled();
    });

    it("an abort that lands before the thinking wait starts (inside an awaited payload hook) still ends the turn", async () => {
      const messages = await firstTurn("think-early-abort", "medium");
      const controller = new AbortController();
      streamViaCli(
        model,
        { messages },
        opts("think-early-abort", {
          reasoning: "high",
          signal: controller.signal,
          onPayload: async () => {
            controller.abort();
            return undefined;
          },
        }) as any,
      );
      await vi.advanceTimersByTimeAsync(600);
      const ended = MockStream.mock.instances[1]._events.find(
        (e: any) => e.type === "error",
      );
      expect(ended?.reason).toBe("aborted");
      expect(procAt(0).stdin.end).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("keeps a handoff's turn as is; the change lands on the next user turn", async () => {
      const ctx1 = { messages: [{ role: "user", content: "search please" }] };
      streamViaCli(
        model,
        ctx1,
        opts("think-5", { reasoning: "medium" }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("toolu_t", "mcp__custom-tools__search", { q: "x" }) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      const done1 = doneOf(0);
      const answers: HandoffResult[] = [];
      dispatchHandoffCall(cliIdOf(0), {
        toolUseId: "toolu_t",
        name: "search",
        arguments: { q: "x" },
        respond: (r) => answers.push(r),
      });
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(done1.message.content),
          {
            role: "toolResult",
            toolCallId: "toolu_t",
            toolName: "search",
            content: [{ type: "text", text: "hits" }],
            isError: false,
          },
        ],
      };
      // The level changed while the tool ran.
      streamViaCli(model, ctx2, opts("think-5", { reasoning: "high" }) as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(answers).toHaveLength(1);
      expect(ours(proc)).toHaveLength(0);
      await finishTurn(proc, "found");
      expect(doneOf(1).message.stopReason).toBe("stop");

      const ctx3 = {
        messages: [
          ...ctx2.messages,
          ourAssistant(doneOf(1).message.content),
          { role: "user", content: "and then?" },
        ],
      };
      streamViaCli(model, ctx3, opts("think-5", { reasoning: "high" }) as any);
      await ackAll(proc);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ours(proc).map((c: any) => c.request.subtype)).toEqual([
        "set_max_thinking_tokens",
        "apply_flag_settings",
      ]);
    });
  });

  describe("turn continuation", () => {
    it("writes the next user turn to the parked process instead of spawning", async () => {
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("pi-E") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({ usage: { input_tokens: 1, output_tokens: 5 } }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(0).reason).toBe("stop");
      expect(proc.kill).not.toHaveBeenCalled();

      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-E") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const users = written(proc)
        .map((w: string) => JSON.parse(w))
        .filter((m: any) => m.type === "user");
      expect(users).toHaveLength(2);
      expect(JSON.stringify(users[1].message.content)).toContain("second");
      expect(JSON.stringify(users[1].message.content)).not.toContain("first");

      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("two") +
          endCycle("end_turn") +
          result({ usage: { input_tokens: 1, output_tokens: 5 } }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(
        doneOf(1)
          .message.content.map((c: any) => c.text)
          .join(""),
      ).toContain("two");
    });

    it("bills each turn from the delta of the CLI's process-cumulative modelUsage", async () => {
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("pi-F") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      const mu = (inp: number, out: number, cr: number, cw: number) => ({
        "claude-opus-5": {
          inputTokens: inp,
          outputTokens: out,
          cacheReadInputTokens: cr,
          cacheCreationInputTokens: cw,
        },
      });
      proc.stdout.write(
        startCycle({ input_tokens: 10, cache_creation_input_tokens: 1000 }) +
          text("one") +
          endCycle("end_turn", 40) +
          result({ modelUsage: mu(10, 40, 0, 1000) }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(0).message.usage).toMatchObject({
        input: 10,
        output: 40,
        cacheRead: 0,
        cacheWrite: 1000,
      });

      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-F") as any);
      await vi.advanceTimersByTimeAsync(0);
      // Cumulative: turn 1 + turn 2 (turn 2 = 10 in, 30 out, 1000 read, 50 write).
      proc.stdout.write(
        startCycle({
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 50,
        }) +
          text("two") +
          endCycle("end_turn", 30) +
          result({ modelUsage: mu(20, 70, 1000, 1050) }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(1).message.usage).toMatchObject({
        input: 10,
        output: 30,
        cacheRead: 1000,
        cacheWrite: 50,
      });
    });

    it("bills a turn split across a handoff once: the finishing episode is net of what the first reported", async () => {
      const ctx1 = { messages: [{ role: "user", content: "go" }] };
      streamViaCli(model, ctx1, opts("pi-G") as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      const cliId = cliIdOf(0);
      proc.stdout.write(
        startCycle({ input_tokens: 10, cache_creation_input_tokens: 1000 }) +
          handoffToolUse("t", "mcp__custom-tools__x", {}) +
          endCycle("tool_use", 40),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(doneOf(0).message.usage).toMatchObject({
        input: 10,
        output: 40,
        cacheWrite: 1000,
      });
      dispatchHandoffCall(cliId, {
        toolUseId: "t",
        name: "x",
        arguments: {},
        respond: () => {},
      });
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          {
            role: "toolResult",
            toolCallId: "t",
            toolName: "x",
            content: [{ type: "text", text: "r" }],
          },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-G") as any);
      await vi.advanceTimersByTimeAsync(0);
      const mu = {
        "claude-opus-5": {
          inputTokens: 20,
          outputTokens: 70,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 1050,
        },
      };
      proc.stdout.write(
        startCycle({
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 50,
        }) +
          text("done") +
          endCycle("end_turn", 30) +
          result({ modelUsage: mu }),
      );
      await vi.advanceTimersByTimeAsync(10);
      // Whole turn was 20/70/1000/1050; the first episode already reported 10/40/0/1000.
      expect(doneOf(1).message.usage).toMatchObject({
        input: 10,
        output: 30,
        cacheRead: 1000,
        cacheWrite: 50,
      });
    });

    it("spawns fresh when the spawn parameters differ (model switch)", async () => {
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("pi-H") as any);
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      const other = { ...model, id: "claude-sonnet-5" };
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(other, ctx2, opts("pi-H") as any);
      await vi.advanceTimersByTimeAsync(600);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(procAt(0).stdin.end).toHaveBeenCalled();
      expect(spawnArgs(1)).not.toContain("--resume");
    });

    it.each([
      ["cwd", { cwd: "/different-cwd" }],
      [
        "schemaPath",
        {
          mcpConfig: {
            schemaPath: "/tmp/new-schema.json",
            version: 1,
            handoffSocket: "/tmp/handoff.sock",
          },
        },
      ],
      [
        "toolSchemaVersion",
        {
          mcpConfig: {
            schemaPath: "/tmp/schema.json",
            version: 2,
            handoffSocket: "/tmp/handoff.sock",
          },
        },
      ],
      [
        "handoffSocket",
        {
          mcpConfig: {
            schemaPath: "/tmp/schema.json",
            version: 1,
            handoffSocket: "/tmp/new-handoff.sock",
          },
        },
      ],
    ])(
      "logs the correct %s signature label asynchronously and nonblocking",
      async (field, extra) => {
        const write = vi.fn(async (_line: string) => undefined);
        await flushRequestLedger();
        const close = vi.fn(async () => undefined);
        const chmod = vi.fn(async () => undefined);
        const mkdir = vi
          .spyOn(fsPromises, "mkdir")
          .mockResolvedValue(undefined);
        const open = vi
          .spyOn(fsPromises, "open")
          .mockResolvedValue({ write, close, chmod } as any);
        try {
          const sessionId = `pi-retire-${field}`;
          const ctx1 = { messages: [{ role: "user", content: "first" }] };
          streamViaCli(model, ctx1, opts(sessionId) as any);
          await vi.advanceTimersByTimeAsync(0);
          procAt(0).stdout.write(
            startCycle({ input_tokens: 1 }) +
              text("one") +
              endCycle("end_turn") +
              result({}),
          );
          await vi.advanceTimersByTimeAsync(10);
          const ctx2 = {
            messages: [
              ...ctx1.messages,
              ourAssistant(doneOf(0).message.content),
              { role: "user", content: "second" },
            ],
          };
          streamViaCli(model, ctx2, opts(sessionId, extra) as any);
          await vi.advanceTimersByTimeAsync(600);
          expect(spawn).toHaveBeenCalledTimes(2);
          await flushRequestLedger();
          const { packageLeaf } = await import("../src/data-dir");
          const dir = join(process.env.XDG_STATE_HOME!, packageLeaf());
          expect(mkdir).toHaveBeenCalledWith(dir, { recursive: true });
          expect(open).toHaveBeenCalledWith(
            join(dir, "retire.log"),
            fsConstants.O_WRONLY |
              fsConstants.O_APPEND |
              fsConstants.O_CREAT |
              fsConstants.O_NONBLOCK,
            0o600,
          );
          const rows = write.mock.calls.map(([line]) => JSON.parse(line));
          expect(rows.filter((row) => row.type === "retire")).toEqual([
            expect.objectContaining({
              piSessionId: sessionId,
              reasons: [field],
            }),
          ]);
          expect(
            rows.find(
              (row) =>
                row.type === "process_spawn" && row.spawnCause.includes(field),
            ),
          ).toBeDefined();
          expect(chmod).toHaveBeenCalledWith(0o600);
          expect(close).toHaveBeenCalledTimes(write.mock.calls.length);
        } finally {
          await flushRequestLedger();
          mkdir.mockRestore();
          open.mockRestore();
        }
      },
    );

    it("retires the parked process after keepalive; the next turn replays Pi history", async () => {
      process.env.PI_CLAUDE_TETHER_KEEPALIVE_MS = "1000";
      const ctx1 = { messages: [{ role: "user", content: "first" }] };
      streamViaCli(model, ctx1, opts("pi-I") as any);
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(parkedCliProcessCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1600);
      expect(parkedCliProcessCount()).toBe(0);
      expect(procAt(0).kill).toHaveBeenCalledWith("SIGKILL");
      const ctx2 = {
        messages: [
          ...ctx1.messages,
          ourAssistant(doneOf(0).message.content),
          { role: "user", content: "second" },
        ],
      };
      streamViaCli(model, ctx2, opts("pi-I") as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawnArgs(1)).not.toContain("--resume");
    });

    it("PI_CLAUDE_TETHER_KEEPALIVE_MS=0 ends the process at result, as before 0.7.0", async () => {
      process.env.PI_CLAUDE_TETHER_KEEPALIVE_MS = "0";
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "first" }] },
        opts("pi-J") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        startCycle({ input_tokens: 1 }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(parkedCliProcessCount()).toBe(0);
      expect(procAt(0).stdin.end).toHaveBeenCalled();
      expect(procAt(0).kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("without a pi session id nothing is parked and nothing is proxied", async () => {
      streamViaCli(model, { messages: [{ role: "user", content: "go" }] }, {
        mcpConfig: opts("x").mcpConfig,
      } as any);
      await vi.advanceTimersByTimeAsync(0);
      const proc = procAt(0);
      proc.stdout.write(
        startCycle({ input_tokens: 1 }) +
          handoffToolUse("t", "mcp__custom-tools__x", {}) +
          endCycle("tool_use"),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(written(proc).join("")).toContain('"interrupt"');
      expect(parkedCliProcessCount()).toBe(0);
    });
  });

  // A parked process is worth keeping exactly while the prompt
  // cache it would read is still alive. A reported 1h TTL extends the
  // default ephemeral TTL of 5 minutes.
  describe("parked lifetime follows the observed cache TTL", () => {
    const MIN = 60_000;
    async function oneTurn(id: string, usage: any) {
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "go" }] },
        opts(id) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        startCycle(usage) + text("ok") + endCycle("end_turn") + result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(parkedCliProcessCount()).toBe(1);
    }

    it("a 1h cache write keeps the process parked past ten minutes until the cache expires", async () => {
      await oneTurn("pi-ttl-1h", {
        input_tokens: 1,
        cache_creation_input_tokens: 900,
        cache_creation: {
          ephemeral_1h_input_tokens: 900,
          ephemeral_5m_input_tokens: 0,
        },
      });
      await vi.advanceTimersByTimeAsync(59 * MIN);
      expect(parkedCliProcessCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      expect(parkedCliProcessCount()).toBe(0);
    });

    it("a 5m cache write retires the process once those five minutes pass", async () => {
      await oneTurn("pi-ttl-5m", {
        input_tokens: 1,
        cache_creation_input_tokens: 900,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 900,
        },
      });
      await vi.advanceTimersByTimeAsync(4 * MIN);
      expect(parkedCliProcessCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      expect(parkedCliProcessCount()).toBe(0);
    });

    it("a cache read keeps the TTL class of the entry it refreshed", async () => {
      const ctx = { messages: [{ role: "user", content: "first" }] } as any;
      streamViaCli(model, ctx, opts("pi-ttl-read") as any);
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(
        startCycle({
          input_tokens: 1,
          cache_creation_input_tokens: 900,
          cache_creation: {
            ephemeral_1h_input_tokens: 900,
            ephemeral_5m_input_tokens: 0,
          },
        }) +
          text("one") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(30 * MIN);
      streamViaCli(
        model,
        {
          messages: [
            ...ctx.messages,
            ourAssistant(doneOf(0).message.content),
            { role: "user", content: "second" },
          ],
        },
        opts("pi-ttl-read") as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      procAt(0).stdout.write(
        startCycle({ input_tokens: 1, cache_read_input_tokens: 900 }) +
          text("two") +
          endCycle("end_turn") +
          result({}),
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(59 * MIN);
      expect(parkedCliProcessCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      expect(parkedCliProcessCount()).toBe(0);
    });

    it("a cache read the CLI makes while parked extends the parked lifetime to the refreshed expiry", async () => {
      await oneTurn("pi-ttl-detached", {
        input_tokens: 1,
        cache_creation_input_tokens: 900,
        cache_creation: {
          ephemeral_1h_input_tokens: 900,
          ephemeral_5m_input_tokens: 0,
        },
      });
      await vi.advanceTimersByTimeAsync(30 * MIN);
      procAt(0).stdout.write(
        startCycle({ input_tokens: 1, cache_read_input_tokens: 900 }),
      );
      await vi.advanceTimersByTimeAsync(31 * MIN);
      expect(parkedCliProcessCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(parkedCliProcessCount()).toBe(0);
    });

    it("an explicit PI_CLAUDE_TETHER_KEEPALIVE_MS still wins over the observed TTL", async () => {
      process.env.PI_CLAUDE_TETHER_KEEPALIVE_MS = String(2 * MIN);
      await oneTurn("pi-ttl-env", {
        input_tokens: 1,
        cache_creation_input_tokens: 900,
        cache_creation: {
          ephemeral_1h_input_tokens: 900,
          ephemeral_5m_input_tokens: 0,
        },
      });
      await vi.advanceTimersByTimeAsync(3 * MIN);
      expect(parkedCliProcessCount()).toBe(0);
    });
  });
});
