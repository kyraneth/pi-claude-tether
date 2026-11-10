import "./cli-path-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("cross-spawn", async () => {
  const { cliProbe } = await import("./cli-probe-fixture");
  return {
    spawn: vi.fn(() => cliProbe("2.1.284 (Claude Code)")),
    default: vi.fn(() => {
      const proc: any = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = {
        write: vi.fn(),
        end: vi.fn(() => queueMicrotask(() => proc.emit("close", 0))),
      };
      proc.exitCode = null;
      proc.killed = false;
      proc.pid = 4242;
      proc.kill = vi.fn(() => {
        proc.killed = true;
        proc.emit("close", 0);
      });
      return proc;
    }),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.284 (Claude Code)")),
}));
import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";
import {
  CliProcess,
  resetCliProcessesForTests,
  retireAllCliProcesses,
} from "../src/cli-process";
import { flushRequestLedger, RequestLedger } from "../src/request-ledger";
import { dispatchHandoffCall } from "../src/handoff-broker";
import { packageLeaf } from "../src/data-dir";
import { imageHeader, apiImage } from "./receipt-image-fixture";

const model = {
  id: "claude-haiku-4-5",
  api: "pi-claude-tether",
  provider: "pi-claude-tether",
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
} as any;
// Hand-written synthetic three-cycle stream; see multi-cycle.test.ts.
const recorded = readFileSync(
  new URL("./fixtures/multi-cycle-episode.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const LEAK = "SEEDED_PRIVATE_BODY_DO_NOT_LOG";
const send = (proc: any, frames: any[]) =>
  proc.stdout.write(
    frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
  );
const starts = recorded.filter(
  (frame) =>
    frame.type === "stream_event" && frame.event.type === "message_start",
);
const minimal = [
  starts[0],
  ...recorded
    .filter(
      (frame) =>
        frame.type === "stream_event" &&
        ["message_delta", "message_stop"].includes(frame.event.type),
    )
    .slice(0, 2),
  recorded.at(-1),
];

let dir: string;
let path: string;
const options = (sessionId: string) => ({ sessionId });
async function rows(): Promise<any[]> {
  await flushRequestLedger();
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
function requests(all: any[]) {
  return all.filter((row) => row.type === "request");
}
function assertMetadataOnly(all: any[]) {
  const serialized = JSON.stringify(all);
  expect(serialized).not.toContain(LEAK);
  // Only counters from result envelopes survive; no result, permission denials or bodies.
  expect(serialized).not.toContain("permission_denials");
  expect(serialized).not.toContain("thinking_tokens");
  expect(serialized).not.toContain("MULTI-DONE");
  expect(serialized).not.toContain("news headline");
}

beforeEach(async () => {
  await flushRequestLedger();
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetCliProcessesForTests();
  dir = mkdtempSync(join(tmpdir(), "pcc-ledger-"));
  vi.stubEnv("XDG_STATE_HOME", dir);
  path = join(dir, packageLeaf(), "retire.log");
});
afterEach(async () => {
  resetCliProcessesForTests();
  await flushRequestLedger();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("request measurement at adapter stream ingress", () => {
  it("records body-free mismatch kind, representations, lengths and hashes on the retire row", async () => {
    const proc: any = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.kill = vi.fn();
    const ledger = new RequestLedger({
      piSessionId: "mismatch",
      cliSessionId: "mismatch-cli",
      requestedModel: model.id,
      pid: 4242,
      spawnCause: ["firstProcess"],
      systemPromptBytes: 0,
      toolSchemaBytes: 0,
    });
    const cli = new CliProcess(proc, {
      cliSessionId: "mismatch-cli",
      signature: "sig",
      allowHandoff: true,
      getStderr: () => "",
      ledger,
    });
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const receipt = cli.deliverHandoffResult("t1", {
      content: [{ type: "text", text: LEAK }],
      isError: true,
    });
    send(proc, [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: LEAK.slice(1),
            },
          ],
        },
      },
    ]);
    expect(await receipt).toBe(false);
    const all = await rows();
    const row = all.find((r) => r.type === "retire");
    expect(row.reasons).toEqual(["handoff_receipt_mismatch"]);
    expect(row.handoffReceiptMismatch).toMatchObject({
      toolUseId: "t1",
      kinds: ["representation", "content_length", "content_hash"],
      expected: {
        representation: "blocks",
        blockKinds: ["text"],
        textChars: LEAK.length,
        isError: true,
      },
      observed: {
        representation: "string",
        blockKinds: ["text"],
        textChars: LEAK.length - 1,
        isError: true,
      },
    });
    expect(row.handoffReceiptMismatch.expected.rawSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(row.handoffReceiptMismatch.expected.canonicalSha256).not.toEqual(
      row.handoffReceiptMismatch.observed.canonicalSha256,
    );
    assertMetadataOnly(all);
    expect(JSON.stringify(all)).not.toContain(LEAK.slice(1));
  });
  it("persists image header diagnostics without image bytes or unrecognized media strings", async () => {
    const proc: any = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.kill = vi.fn();
    const ledger = new RequestLedger({
      piSessionId: "image-mismatch",
      cliSessionId: "image-cli",
      requestedModel: model.id,
      pid: 4242,
      spawnCause: ["firstProcess"],
      systemPromptBytes: 0,
      toolSchemaBytes: 0,
    });
    const cli = new CliProcess(proc, {
      cliSessionId: "image-cli",
      signature: "sig",
      allowHandoff: true,
      getStderr: () => "",
      ledger,
    });
    const original = imageHeader("png", 2000, 1000);
    const malformed = apiImage({
      ...imageHeader("jpeg", 1000, 500),
      mimeType: LEAK,
    });
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const receipt = cli.deliverHandoffResult("t1", { content: [original] });
    send(proc, [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [malformed] },
          ],
        },
      },
    ]);
    expect(await receipt).toBe(false);
    const all = await rows();
    const metadata = all.find(
      (r) => r.type === "retire",
    ).handoffReceiptMismatch;
    expect(metadata.expected.images).toEqual([
      {
        blockIndex: 0,
        declaredMediaType: "image/png",
        header: { mediaType: "image/png", width: 2000, height: 1000 },
      },
    ]);
    expect(metadata.observed.images).toEqual([
      { blockIndex: 0, declaredMediaType: "other", header: null },
    ]);
    assertMetadataOnly(all);
    expect(JSON.stringify(all)).not.toContain(LEAK);
    expect(JSON.stringify(all)).not.toContain(original.data);
    expect(JSON.stringify(all)).not.toContain(malformed.source.data);
  });
  it("records every request in a recorded multi-request episode without adding the separate result totals", async () => {
    mkdirSync(join(dir, packageLeaf()));
    writeFileSync(path, "", { mode: 0o644 });
    const context = {
      systemPrompt: LEAK,
      messages: [{ role: "user", content: LEAK }],
    };
    const stream = streamViaCli(model, context, options("recorded-multi"));
    await vi.advanceTimersByTimeAsync(0);
    const proc = vi.mocked(spawn).mock.results[0].value;
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const promptBytes = statSync(
      args[args.findIndex((arg) => arg.endsWith("system-prompt-file")) + 1],
    ).size;
    // Seed unrelated fields inside envelopes AND usage to challenge projection.
    const frames = recorded.map((frame) => ({
      ...frame,
      secretBody: LEAK,
      ...(frame.type === "result"
        ? { result: LEAK, usage: { ...frame.usage, secretBody: LEAK } }
        : {}),
    }));
    // Nested requests are internal: replaying a complete tagged request must not add a row.
    send(proc, [
      ...frames.slice(0, 3),
      ...minimal
        .filter((frame) => frame.type === "stream_event")
        .map((frame) => ({ ...frame, parent_tool_use_id: "nested" })),
      ...frames.slice(3),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await stream.result();
    const all = await rows();
    const req = requests(all);
    expect(req.map((row) => row.usage)).toEqual([
      {
        input: 2,
        cacheRead: 21,
        cacheWrite: 11,
        cacheWrite1h: 11,
        cacheWrite5m: 0,
        output: 5,
      },
      {
        input: 3,
        cacheRead: 22,
        cacheWrite: 12,
        cacheWrite1h: 12,
        cacheWrite5m: 0,
        output: 6,
      },
      {
        input: 4,
        cacheRead: 23,
        cacheWrite: 13,
        cacheWrite1h: 13,
        cacheWrite5m: 0,
        output: 7,
      },
    ]);
    expect(new Set(req.map((row) => row.requestId)).size).toBe(3);
    expect(new Set(req.map((row) => row.episodeId)).size).toBe(1);
    expect(
      req.every(
        (row) =>
          row.triggerMode === "spawn" &&
          row.physicalModel === "claude-haiku-4-5-20251001" &&
          row.piSessionId === "recorded-multi",
      ),
    ).toBe(true);
    const result = all.find((row) => row.type === "result");
    expect(all.find((row) => row.type === "process_init")).toMatchObject({
      physicalModel: recorded.find(
        (frame) => frame.type === "system" && frame.subtype === "init",
      ).model,
      reportedCliSessionId: recorded.at(-1).session_id,
    });
    expect(result).toMatchObject({
      reportedCliSessionId: recorded.at(-1).session_id,
      usage: { input: 9, cacheRead: 66, cacheWrite: 36, output: 18 },
      totalCostUsd: 0.03,
      numTurns: 3,
    });
    expect(result.cumulativeModelUsage).toEqual([
      {
        physicalModel: "claude-haiku-4-5-20251001",
        input: 8,
        cacheRead: 0,
        cacheWrite: 0,
        output: 9,
        costUsd: 0.01,
      },
      {
        physicalModel: "claude-haiku-4-5",
        input: 9,
        cacheRead: 66,
        cacheWrite: 36,
        output: 18,
        costUsd: 0.02,
      },
    ]);
    expect(req.reduce((total, row) => total + row.usage.output, 0)).toBe(
      result.usage.output,
    );
    expect(all.find((row) => row.type === "rate_limit")).toMatchObject({
      utilization: null,
      windowType: "five_hour",
      resetsAt: 946684800,
      status: "allowed",
    });
    expect(all.find((row) => row.type === "process_spawn")).toMatchObject({
      systemPromptBytes: promptBytes,
      toolSchemaBytes: null,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    assertMetadataOnly(all);
    // A seeded leak/sum must be rejected by these same row-level assertions.
    expect(() => assertMetadataOnly([...all, { content: LEAK }])).toThrow();
    expect(() =>
      expect(
        req.map((row) => row.usage.output).concat(result.usage.output),
      ).toEqual([5, 6, 7]),
    ).toThrow();
  });

  it("keeps handoff/turn episode identities and cumulative results separate on one process, including detached frames", async () => {
    const schemaPath = join(dir, "schema.json");
    const schema = JSON.stringify([
      { name: "read", description: LEAK, inputSchema: { type: "object" } },
    ]);
    writeFileSync(schemaPath, schema);
    const opts = {
      sessionId: "handoff",
      mcpConfig: {
        schemaPath,
        version: 1,
        handoffSocket: join(dir, "unused.sock"),
      },
    };
    const context: any = {
      systemPrompt: `é-${LEAK}`,
      messages: [{ role: "user", content: LEAK }],
      tools: [],
    };
    const first = streamViaCli(model, context, opts);
    await vi.advanceTimersByTimeAsync(0);
    const proc: any = vi.mocked(spawn).mock.results[0].value;
    // Recorded first request, with ToolSearch renamed to a Pi-proxied read.
    const firstStop = recorded.findIndex(
      (frame) =>
        frame.type === "stream_event" && frame.event.type === "message_stop",
    );
    const firstFrames = recorded.slice(0, firstStop + 1).map((frame) => {
      const copy = structuredClone(frame);
      if (
        copy.type === "stream_event" &&
        copy.event.content_block?.type === "tool_use"
      )
        copy.event.content_block.name = "mcp__custom-tools__read";
      return copy;
    });
    send(proc, firstFrames);
    await vi.advanceTimersByTimeAsync(0);
    const firstOutput = await first.result();
    expect(firstOutput.stopReason).toBe("toolUse");
    const tool: any = firstOutput.content.find(
      (block: any) => block.type === "toolCall",
    );
    context.messages.push(firstOutput, {
      role: "toolResult",
      toolCallId: tool.id,
      toolName: "read",
      content: [{ type: "text", text: LEAK }],
    });
    const second = streamViaCli(model, context, opts);
    await vi.advanceTimersByTimeAsync(0);
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    dispatchHandoffCall(args[args.indexOf("--session-id") + 1], {
      toolUseId: tool.id,
      name: "read",
      arguments: {},
      respond: (r) =>
        send(proc, [
          {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: tool.id,
                  content: r.content,
                  is_error: !!r.isError,
                },
              ],
            },
          },
        ]),
    });
    send(proc, recorded.slice(firstStop + 1));
    await vi.advanceTimersByTimeAsync(0);
    const secondOutput = await second.result();
    // Record an account event while detached; buffering/replay must not duplicate it.
    send(proc, [
      {
        type: "rate_limit_event",
        rate_limit_info: {
          utilization: 0.42,
          rateLimitType: "seven_day",
          resetsAt: 946684800,
          status: "allowed",
          body: LEAK,
        },
      },
    ]);
    context.messages.push(secondOutput, { role: "user", content: LEAK });
    const third = streamViaCli(model, context, opts);
    await vi.advanceTimersByTimeAsync(0);
    const cumulative = structuredClone(recorded.at(-1));
    cumulative.modelUsage["claude-haiku-4-5"].outputTokens += 5;
    send(proc, [...minimal.slice(0, -1), cumulative]);
    await vi.advanceTimersByTimeAsync(0);
    await third.result();
    expect(spawn).toHaveBeenCalledTimes(1);
    const all = await rows();
    expect(requests(all).map((row) => row.triggerMode)).toEqual([
      "spawn",
      "handoff",
      "handoff",
      "turn",
    ]);
    expect(new Set(requests(all).map((row) => row.episodeId)).size).toBe(3);
    expect(new Set(all.map((row) => row.processId)).size).toBe(1);
    expect(
      all
        .filter((row) => row.type === "result")
        .map((row) => row.cumulativeModelUsage[1].output),
    ).toEqual([18, 23]);
    expect(requests(all).map((row) => row.usage.output)).toEqual([5, 6, 7, 5]);
    expect(
      all.filter(
        (row) => row.type === "rate_limit" && row.utilization === 0.42,
      ),
    ).toHaveLength(1);
    expect(all.find((row) => row.type === "process_spawn")).toMatchObject({
      toolSchemaBytes: Buffer.byteLength(schema),
      systemPromptBytes: expect.any(Number),
    });
    assertMetadataOnly(all);
  });

  it("attributes buffered measurements to the receiving episode without claiming it started detached work", async () => {
    const ledger = new RequestLedger({
      piSessionId: "detached",
      cliSessionId: "cli-detached",
      requestedModel: model.id,
      pid: 4242,
      spawnCause: ["firstProcess"],
      systemPromptBytes: 0,
      toolSchemaBytes: null,
    });
    ledger.beginEpisode("spawn");
    ledger.endEpisode();
    expect(() => ledger.observe({ type: "stream_event" })).not.toThrow();
    for (const frame of minimal) ledger.observe(frame);
    ledger.beginEpisode("handoff");
    const all = await rows();
    const episode = all.filter((row) => row.type === "episode_start").at(-1);
    expect(requests(all)).toEqual([
      expect.objectContaining({
        episodeId: episode.episodeId,
        triggerMode: "handoff",
        receivedDetached: true,
        startedEpisodeId: null,
        startedTriggerMode: null,
      }),
    ]);
    // A request starting detached but stopping after attachment preserves origin too.
    ledger.endEpisode();
    ledger.observe(minimal[0]);
    ledger.beginEpisode("turn");
    ledger.observe(minimal[1]);
    ledger.observe(minimal[2]);
    expect(requests(await rows()).at(-1)).toMatchObject({
      triggerMode: "turn",
      receivedDetached: true,
      startedEpisodeId: null,
    });
    ledger.endEpisode();
    for (const frame of minimal) ledger.observe(frame);
    ledger.retire(["keepalive_expiry"]);
    expect(requests(await rows()).at(-1)).toMatchObject({
      episodeId: null,
      triggerMode: null,
      receivedDetached: true,
    });
  });

  it("never waits for a blocked diagnostic append before completing the adapter request", async () => {
    let unblock!: (value: any) => void;
    let opened!: () => void;
    const reachedOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const blocked = new Promise<any>((resolve) => {
      unblock = resolve;
    });
    const open = vi.spyOn(fsPromises, "open").mockImplementationOnce(() => {
      opened();
      return blocked;
    });
    try {
      const stream = streamViaCli(
        model,
        { messages: [{ role: "user", content: "go" }] },
        options("blocked-writer"),
      );
      await vi.advanceTimersByTimeAsync(0);
      send(vi.mocked(spawn).mock.results[0].value, minimal);
      await vi.advanceTimersByTimeAsync(0);
      expect((await stream.result()).stopReason).toBe("stop");
      await reachedOpen;
      unblock({
        chmod: async () => {},
        write: async () => {},
        close: async () => {},
      });
      await flushRequestLedger();
    } finally {
      open.mockRestore();
    }
  });

  it("logs cache expiry when the observed cache TTL ends and carries its cause into the next spawn", async () => {
    const stream = streamViaCli(
      model,
      { messages: [{ role: "user", content: "go" }] },
      options("idle"),
    );
    await vi.advanceTimersByTimeAsync(0);
    send(vi.mocked(spawn).mock.results[0].value, minimal);
    await vi.advanceTimersByTimeAsync(0);
    await stream.result();
    // The recorded request wrote a 1h cache entry: parked past the
    // old ten minutes, retired when that entry expires.
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await rows()).filter((row) => row.type === "retire")).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000_000);
    expect((await rows()).filter((row) => row.type === "retire")).toEqual([
      expect.objectContaining({ reasons: ["cache_expiry"] }),
    ]);
    const next = streamViaCli(
      model,
      { messages: [{ role: "user", content: "again" }] },
      options("idle"),
    );
    await vi.advanceTimersByTimeAsync(0);
    send(vi.mocked(spawn).mock.results[1].value, minimal);
    await vi.advanceTimersByTimeAsync(0);
    await next.result();
    expect(
      (await rows()).filter((row) => row.type === "process_spawn").at(-1)
        .spawnCause,
    ).toEqual(["cache_expiry"]);
  });

  it.each([
    "model_select",
    "session_compact",
    "session_tree",
    "session_shutdown",
  ])("logs lifecycle retirement %s once", async (reason) => {
    const stream = streamViaCli(
      model,
      { messages: [{ role: "user", content: "go" }] },
      options(reason),
    );
    await vi.advanceTimersByTimeAsync(0);
    send(vi.mocked(spawn).mock.results[0].value, minimal);
    await vi.advanceTimersByTimeAsync(0);
    await stream.result();
    await retireAllCliProcesses(reason);
    expect((await rows()).filter((row) => row.type === "retire")).toEqual([
      expect.objectContaining({ reasons: [reason] }),
    ]);
    expect(
      (await rows()).filter((row) => row.type === "process_exit"),
    ).toHaveLength(1);
  });

  it("records an unrequested process exit and inactivity retirement", async () => {
    const first = streamViaCli(
      model,
      { messages: [{ role: "user", content: "go" }] },
      options("exited"),
    );
    await vi.advanceTimersByTimeAsync(0);
    const proc: any = vi.mocked(spawn).mock.results[0].value;
    proc.emit("close", 1);
    await vi.advanceTimersByTimeAsync(0);
    await first.result();
    const next = streamViaCli(
      model,
      { messages: [{ role: "user", content: "go" }] },
      options("silent"),
    );
    await vi.advanceTimersByTimeAsync(0);
    // Advance past the provider's configured inactivity period.
    await vi.advanceTimersByTimeAsync(300_000);
    await next.result();
    expect(
      (await rows())
        .filter((row) => row.type === "retire")
        .map((row) => row.reasons),
    ).toEqual([["process_exit"], ["inactivity"]]);
  });
});
