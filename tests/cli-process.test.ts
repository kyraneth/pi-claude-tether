import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CliProcess,
  parkCliProcess,
  takeParkedCliProcess,
  parkedCliProcessCount,
  resetCliProcessesForTests,
  addUsage,
  subUsage,
  maxUsage,
  UNMATCHED_CALL_MESSAGE,
} from "../src/cli-process";
import type { CliThinking } from "../src/thinking-config";
import {
  dispatchHandoffCall,
  resetHandoffBrokerForTests,
} from "../src/handoff-broker";
import type { HandoffCall, HandoffResult } from "../src/handoff-broker";
import type { NdjsonMessage } from "../src/types";
import { imageHeader, apiImage } from "./receipt-image-fixture";

function fakeProc() {
  const proc: any = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new PassThrough();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

function make(proc = fakeProc(), allowHandoff = true) {
  const cli = new CliProcess(proc, {
    cliSessionId: "cli-1",
    signature: "sig",
    allowHandoff,
    getStderr: () => "",
  });
  return { proc, cli };
}

function sink() {
  const messages: NdjsonMessage[] = [];
  const closes: Array<number | null> = [];
  return {
    messages,
    closes,
    s: {
      onMessage: (m: NdjsonMessage) => messages.push(m),
      onClose: (c: number | null) => closes.push(c),
      onError: vi.fn(),
    },
  };
}

function call(
  id: string,
  name = "search",
): { call: HandoffCall; answers: HandoffResult[] } {
  const answers: HandoffResult[] = [];
  return {
    answers,
    call: {
      toolUseId: id,
      name,
      arguments: {},
      respond: (r) => answers.push(r),
    },
  };
}

describe("CliProcess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers lines while detached and replays them to the next episode in order", async () => {
    const { proc, cli } = make();
    proc.stdout.write(
      JSON.stringify({ type: "system", subtype: "init" }) + "\n",
    );
    proc.stdout.write(
      JSON.stringify({ type: "assistant", message: { content: [] } }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    const a = sink();
    cli.attach(a.s);
    expect(a.messages.map((m) => m.type)).toEqual(["system", "assistant"]);
    // Live lines go straight through once attached.
    proc.stdout.write(JSON.stringify({ type: "user", message: {} }) + "\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(a.messages.map((m) => m.type)).toEqual([
      "system",
      "assistant",
      "user",
    ]);
  });

  it("keeps every line a detached process emits, oldest included (no count cap)", async () => {
    const { proc, cli } = make();
    const n = 20_001; // one past the old cap, which silently dropped the first line
    let chunk = "";
    for (let i = 0; i < n; i++)
      chunk +=
        JSON.stringify({ type: "assistant", message: { content: [], i } }) +
        "\n";
    proc.stdout.write(chunk);
    await vi.advanceTimersByTimeAsync(0);
    const a = sink();
    cli.attach(a.s);
    expect(a.messages).toHaveLength(n);
    expect((a.messages[0] as any).message.i).toBe(0);
  });

  it("answers permission requests itself, attached or not, and allows handoff tools when proxying", async () => {
    const { proc, cli } = make();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "r1",
        request: {
          subtype: "can_use_tool",
          tool_name: "mcp__custom-tools__x",
          input: { a: 1 },
        },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    const written = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(written.response.request_id).toBe("r1");
    expect(written.response.response.behavior).toBe("allow");
    // The request is not replayed to a later episode: it was already answered.
    const a = sink();
    cli.attach(a.s);
    expect(a.messages).toHaveLength(0);
  });

  it("denies handoff tools when the proxy is off (interrupt-and-replay fallback)", async () => {
    const { proc } = make(fakeProc(), false);
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "r1",
        request: {
          subtype: "can_use_tool",
          tool_name: "mcp__custom-tools__x",
          input: {},
        },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    const written = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(written.response.response.behavior).toBe("deny");
  });

  it("routes a tools/call that arrives BEFORE pi's result, and answers when it lands", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const c = call("t1");
    expect(dispatchHandoffCall("cli-1", c.call)).toBe(true);
    expect(c.answers).toHaveLength(0);
    expect(cli.canContinueHandoff(["t1"])).toBe(true);
    cli.deliverHandoffResult("t1", {
      content: [{ type: "text", text: "done" }],
    });
    expect(c.answers).toEqual([{ content: [{ type: "text", text: "done" }] }]);
  });

  it.each([
    {
      kind: "text string",
      content: [{ type: "text", text: "data" }],
      echo: "data",
    },
    {
      kind: "API image",
      content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      echo: [
        {
          type: "image",
          source: { type: "base64", data: "AA==", media_type: "image/png" },
        },
      ],
    },
  ])(
    "confirms canonical $kind receipts only at CLI stdout ingress",
    async ({ content, echo }) => {
      const { cli, proc } = make();
      cli.writeUser("go");
      cli.noteHandoffToolUse("t1");
      dispatchHandoffCall("cli-1", call("t1").call);
      const received = cli.deliverHandoffResult("t1", {
        content: content as any,
      });
      expect(cli.hasUnconfirmedHandoffResults).toBe(true);
      proc.stdout.write(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: echo },
            ],
          },
        }) + "\n",
      );
      expect(await received).toBe(true);
      expect(cli.hasUnconfirmedHandoffResults).toBe(false);
    },
  );

  describe("derivative receipt qualification", () => {
    const text = { type: "text" as const, text: "private-companion-unchanged" };
    const original = imageHeader("png", 2000, 1000);
    const derivative = apiImage(imageHeader("jpeg", 1000, 500));
    const errors = [
      { type: "text", text: "  private-error-a\r\n" },
      { type: "text", text: "private-error-b  " },
    ];
    const joined = errors.map((b) => b.text).join("\n");
    const cases = [
      ...(["png", "jpeg", "gif", "vp8", "vp8l", "vp8x"] as const).map(
        (format) => ({
          kind: `${format} derivative`,
          content: [text, original],
          echo: [text, apiImage(imageHeader(format, 1000, 500))],
          accepted: true,
        }),
      ),
      {
        kind: "same-size recompression",
        content: [original],
        echo: [apiImage(imageHeader("png", 2000, 1000, 1))],
        accepted: true,
      },
      {
        kind: "rounded aspect",
        content: [imageHeader("png", 2000, 1001)],
        echo: [apiImage(imageHeader("jpeg", 999, 500))],
        accepted: true,
      },
      {
        kind: "error image derivative",
        content: [text, original],
        echo: [text, derivative],
        isError: true,
        accepted: true,
      },
      {
        kind: "multiple image derivatives",
        content: [original, text, imageHeader("gif", 300, 600)],
        echo: [derivative, text, apiImage(imageHeader("vp8l", 150, 300))],
        accepted: true,
      },
      {
        kind: "three error texts including empty",
        content: [...errors, { type: "text", text: "" }],
        echo: joined + "\n",
        isError: true,
        accepted: true,
      },
      {
        kind: "exact error newline flatten",
        content: errors,
        echo: joined,
        isError: true,
        accepted: true,
      },
      {
        kind: "success flatten",
        content: errors,
        echo: joined,
        accepted: false,
      },
      {
        kind: "physically observed trimmed error flatten",
        content: errors,
        echo: joined.trim(),
        isError: true,
        accepted: true,
      },
      {
        kind: "empty trimmed error placeholder",
        content: [
          { type: "text", text: "  " },
          { type: "text", text: "\t\r\n" },
        ],
        echo: "",
        isError: true,
        accepted: false,
      },
      {
        kind: "observed padded trimmed flatten",
        content: errors,
        echo: joined.trim() + " ",
        isError: true,
        accepted: false,
      },
      {
        kind: "trimmed flatten internal CRLF mutation",
        content: errors,
        echo: joined.trim().replace("\r\n", "\n"),
        isError: true,
        accepted: false,
      },
      {
        kind: "trimmed success flatten",
        content: errors,
        echo: joined.trim(),
        accepted: false,
      },
      {
        kind: "changed error join",
        content: errors,
        echo: errors.map((b) => b.text).join(""),
        isError: true,
        accepted: false,
      },
      {
        kind: "error generic denial",
        content: errors,
        echo: "tool denied",
        isError: true,
        accepted: false,
      },
      {
        kind: "padded error join",
        content: errors,
        echo: joined + " ",
        isError: true,
        accepted: false,
      },
      {
        kind: "CRLF error join",
        content: errors,
        echo: errors.map((b) => b.text).join("\r\n"),
        isError: true,
        accepted: false,
      },
      {
        kind: "block error join",
        content: errors,
        echo: [{ type: "text", text: joined }],
        isError: true,
        accepted: false,
      },
      {
        kind: "flatten status loss",
        content: errors,
        echo: joined,
        isError: true,
        echoError: false,
        accepted: false,
      },
      {
        kind: "mixed error flatten",
        content: [errors[0], original],
        echo: errors[0].text,
        isError: true,
        accepted: false,
      },
      {
        kind: "image status loss",
        content: [original],
        echo: [derivative],
        isError: true,
        echoError: false,
        accepted: false,
      },
      {
        kind: "image denial",
        content: [original],
        echo: "tool denied",
        accepted: false,
      },
      {
        kind: "image dropped",
        content: [text, original],
        echo: [text],
        accepted: false,
      },
      {
        kind: "image added",
        content: [original],
        echo: [derivative, derivative],
        accepted: false,
      },
      {
        kind: "blocks reordered",
        content: [text, original],
        echo: [derivative, text],
        accepted: false,
      },
      {
        kind: "changed companion",
        content: [text, original],
        echo: [{ ...text, text: text.text + " " }, derivative],
        accepted: false,
      },
      {
        kind: "unknown block",
        content: [{ type: "resource" }, original],
        echo: [{ type: "resource" }, derivative],
        accepted: false,
      },
      {
        kind: "upscale",
        content: [original],
        echo: [apiImage(imageHeader("jpeg", 2002, 1001))],
        accepted: false,
      },
      {
        kind: "wrong aspect",
        content: [original],
        echo: [apiImage(imageHeader("jpeg", 1000, 501))],
        accepted: false,
      },
      {
        kind: "unparseable expected",
        content: [{ ...original, data: "AA==" }],
        echo: [derivative],
        accepted: false,
      },
      {
        kind: "unparseable observed",
        content: [original],
        echo: [
          { ...derivative, source: { ...derivative.source, data: "AA==" } },
        ],
        accepted: false,
      },
      {
        kind: "non-base64 image source",
        content: [original],
        echo: [
          { ...derivative, source: { ...derivative.source, type: "url" } },
        ],
        accepted: false,
      },
      {
        kind: "zero observed dimensions",
        content: [original],
        echo: [apiImage(imageHeader("png", 0, 500))],
        accepted: false,
      },
      {
        kind: "declared media mismatch",
        content: [original],
        echo: [
          {
            ...derivative,
            source: { ...derivative.source, media_type: "image/png" },
          },
        ],
        accepted: false,
      },
    ];
    it.each(cases)("$kind", async ({ content, echo, accepted, ...flags }) => {
      const isError = "isError" in flags && flags.isError;
      const { cli, proc } = make();
      cli.writeUser("go");
      cli.noteHandoffToolUse("t1");
      dispatchHandoffCall("cli-1", call("t1").call);
      const receipt = cli.deliverHandoffResult("t1", {
        content: content as any,
        isError,
      });
      expect(cli.hasUnconfirmedHandoffResults).toBe(true);
      const echoError = "echoError" in flags ? flags.echoError : isError;
      proc.stdout.write(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                is_error: echoError,
                content: echo,
              },
            ],
          },
        }) + "\n",
      );
      expect(await receipt).toBe(accepted);
      expect(cli.retired).toBe(!accepted);
    });

    it("does not acknowledge the wrong id or nested-agent derivative", async () => {
      const { cli, proc } = make();
      cli.writeUser("go");
      cli.noteHandoffToolUse("t1");
      const receipt = cli.deliverHandoffResult("t1", { content: [original] });
      const echo = (id: string, nested = false) =>
        proc.stdout.write(
          JSON.stringify({
            type: "user",
            ...(nested ? { parent_tool_use_id: "nested" } : {}),
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: id, content: [derivative] },
              ],
            },
          }) + "\n",
        );
      echo("wrong");
      echo("t1", true);
      expect(cli.hasUnconfirmedHandoffResults).toBe(true);
      expect(cli.retired).toBe(false);
      echo("t1");
      expect(await receipt).toBe(true);
    });

    it("reports only body-free image dimensions and media on mismatch", async () => {
      const { cli, proc } = make();
      cli.writeUser("go");
      cli.noteHandoffToolUse("t1");
      const receipt = cli.deliverHandoffResult("t1", {
        content: [text, original],
      });
      proc.stdout.write(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [text, apiImage(imageHeader("jpeg", 1000, 501))],
              },
            ],
          },
        }) + "\n",
      );
      expect(await receipt).toBe(false);
      const metadata = cli.handoffReceiptMismatch!;
      expect(metadata.expected.images).toEqual([
        {
          blockIndex: 1,
          declaredMediaType: "image/png",
          header: { mediaType: "image/png", width: 2000, height: 1000 },
        },
      ]);
      expect(metadata.observed.images).toEqual([
        {
          blockIndex: 1,
          declaredMediaType: "image/jpeg",
          header: { mediaType: "image/jpeg", width: 1000, height: 501 },
        },
      ]);
      expect(JSON.stringify(metadata)).not.toContain(text.text);
      expect(JSON.stringify(metadata)).not.toContain(original.data);
    });
  });

  it("confirms failed-bash receipt after CLI strips four leading spaces", async () => {
    const { cli, proc } = make();
    // Failed-bash receipt shape: 619 UTF-16 chars / 850 UTF-8 bytes / 13 LFs /
    // four leading spaces, isError=true. 112 three-byte + seven two-byte chars.
    const body = "─".repeat(112) + "é".repeat(7) + "x".repeat(483);
    const text = "    " + body.match(/.{43}/gu)!.join("\n");
    expect(text.length).toBe(619);
    expect(Buffer.byteLength(text)).toBe(850);
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    dispatchHandoffCall("cli-1", call("t1").call);
    const receipt = cli.deliverHandoffResult("t1", {
      content: [{ type: "text", text }],
      isError: true,
    });
    proc.stdout.write(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: text.trimStart(),
            },
          ],
        },
      }) + "\n",
    );
    expect(await receipt).toBe(true);
    expect(cli.retired).toBe(false);
  });

  it("confirms physically qualified error outer whitespace without trimming the observed body", async () => {
    const { cli, proc } = make();
    const text = "    body \t\r\n";
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const receipt = cli.deliverHandoffResult("t1", {
      content: [{ type: "text", text }],
      isError: true,
    });
    proc.stdout.write(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: text.trim(),
            },
          ],
        },
      }) + "\n",
    );
    expect(await receipt).toBe(true);
    expect(cli.retired).toBe(false);
  });

  it.each([
    {
      kind: "success whitespace loss",
      content: [{ type: "text", text: "    body" }],
      isError: false,
      echo: "body",
    },
    {
      kind: "error non-whitespace loss",
      content: [{ type: "text", text: "    body" }],
      isError: true,
      echo: "ody",
    },
    {
      kind: "error image loss",
      content: [
        { type: "text", text: "    body" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
      isError: true,
      echo: "body",
    },
    {
      kind: "error status loss",
      content: [{ type: "text", text: "body" }],
      isError: true,
      echo: "body",
      echoError: false,
    },
    {
      kind: "unexplained whitespace in echo",
      content: [{ type: "text", text: "    body" }],
      isError: true,
      echo: "body ",
    },
    {
      kind: "error CRLF normalization",
      content: [{ type: "text", text: "    body\r\nnext" }],
      isError: true,
      echo: "body\nnext",
    },
  ])(
    "rejects $kind rather than relaxing the receipt gate",
    async ({ content, isError, echo, echoError }) => {
      const { cli, proc } = make();
      cli.writeUser("go");
      cli.noteHandoffToolUse("t1");
      dispatchHandoffCall("cli-1", call("t1").call);
      const receipt = cli.deliverHandoffResult("t1", {
        content: content as any,
        isError,
      });
      proc.stdout.write(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                is_error: echoError ?? isError,
                content: echo,
              },
            ],
          },
        }) + "\n",
      );
      expect(await receipt).toBe(false);
      expect(cli.retired).toBe(true);
    },
  );

  it("holds pi's result when it arrives BEFORE the tools/call, and answers on arrival", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    expect(cli.canContinueHandoff(["t1"])).toBe(true);
    cli.deliverHandoffResult("t1", {
      content: [{ type: "text", text: "early" }],
    });
    const c = call("t1");
    dispatchHandoffCall("cli-1", c.call);
    expect(c.answers).toEqual([{ content: [{ type: "text", text: "early" }] }]);
  });

  it("refuses to continue a handoff for ids it never saw, or when no turn is active", () => {
    const { cli } = make();
    expect(cli.canContinueHandoff(["t1"])).toBe(false);
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    expect(cli.canContinueHandoff(["t1", "t2"])).toBe(false);
    expect(cli.canContinueHandoff([])).toBe(false);
  });

  it("requires every awaited result exactly once before accepting a steer", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("a");
    cli.noteHandoffToolUse("b");
    dispatchHandoffCall("cli-1", call("a").call);
    expect(cli.canContinueHandoff(["a"])).toBe(false);
    expect(cli.canContinueHandoff(["a", "a"])).toBe(false);
    expect(cli.canContinueHandoff(["b", "a"])).toBe(true);
  });

  it("refuses a steer inside an active CLI tool turn", () => {
    const { cli, proc } = make();
    cli.writeUser("go");
    expect(() => cli.writeSteer([{ type: "text", text: "steer" }])).toThrow(
      "settled CLI turn",
    );
    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
  });

  it("retires after a failed steer write, rather than reusing unconfirmed history", () => {
    const { cli, proc } = make();
    cli.writeUser("go");
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success" }) + "\n",
    );
    proc.stdin.write.mockImplementationOnce(() => {
      throw new Error("closed stdin");
    });
    expect(() => cli.writeSteer([{ type: "text", text: "steer" }])).toThrow(
      "closed stdin",
    );
    expect(cli.retired).toBe(true);
  });

  it("matches an untagged call to the single awaited handoff, and refuses when ambiguous", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const c = call("");
    dispatchHandoffCall("cli-1", c.call);
    cli.deliverHandoffResult("t1", { content: [{ type: "text", text: "ok" }] });
    expect(c.answers[0].content[0]).toEqual({ type: "text", text: "ok" });

    cli.noteHandoffToolUse("a");
    cli.noteHandoffToolUse("b");
    const d = call("");
    dispatchHandoffCall("cli-1", d.call);
    expect(d.answers[0].isError).toBe(true);
  });

  it("refuses a tool_use id this process never streamed, instead of parking it forever", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");

    // An id we never announced: a nested sub-agent block, a replay, or a peer
    // on the broker socket. It used to land in `pending`, where nothing would
    // ever answer it and the caller blocked until the MCP timeout.
    const c = call("toolu_forged");
    dispatchHandoffCall("cli-1", c.call);
    expect(c.answers).toHaveLength(1);
    expect(c.answers[0].isError).toBe(true);
    expect((c.answers[0].content[0] as any).text).toBe(UNMATCHED_CALL_MESSAGE);

    // The real handoff is untouched by the refusal.
    const good = call("t1");
    dispatchHandoffCall("cli-1", good.call);
    cli.deliverHandoffResult("t1", { content: [{ type: "text", text: "ok" }] });
    expect(good.answers[0].isError).toBeUndefined();
  });

  it("refuses a call that borrows a live tool_use id to run a different tool", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1", "search");

    const c = call("t1", "bash");
    dispatchHandoffCall("cli-1", c.call);
    expect(c.answers[0].isError).toBe(true);
    expect((c.answers[0].content[0] as any).text).toContain(
      'asked for "search", not "bash"',
    );

    // Still answerable by the tool the model actually asked for.
    const good = call("t1", "search");
    dispatchHandoffCall("cli-1", good.call);
    cli.deliverHandoffResult("t1", { content: [{ type: "text", text: "ok" }] });
    expect(good.answers[0].isError).toBeUndefined();
  });

  it("refuses a second call replaying an id already answered", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1", "search");
    const first = call("t1", "search");
    dispatchHandoffCall("cli-1", first.call);
    cli.deliverHandoffResult("t1", { content: [{ type: "text", text: "ok" }] });

    const replay = call("t1", "search");
    dispatchHandoffCall("cli-1", replay.call);
    expect(replay.answers[0].isError).toBe(true);
    expect((replay.answers[0].content[0] as any).text).toBe(
      UNMATCHED_CALL_MESSAGE,
    );
  });

  it("flips turnActive off before the episode sees the result, and fails calls left open", async () => {
    const { proc, cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const c = call("t1");
    dispatchHandoffCall("cli-1", c.call);
    let activeAtResult: boolean | undefined;
    cli.attach({
      onMessage: (m) => {
        if (m.type === "result") activeAtResult = cli.turnActive;
      },
      onClose: () => {},
      onError: () => {},
    });
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success" }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(activeAtResult).toBe(false);
    expect(c.answers[0].isError).toBe(true);
  });

  it("retire on an idle process ends stdin, then SIGKILLs after the grace period", async () => {
    const { proc, cli } = make();
    const done = cli.retire();
    expect(proc.stdin.end).toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null);
    await done;
    expect(cli.alive).toBe(false);
  });

  it("retire on a live turn interrupts first so the CLI can persist the turn", async () => {
    const { proc, cli } = make();
    cli.writeUser("go");
    void cli.retire();
    const written = proc.stdin.write.mock.calls
      .map((c: any) => String(c[0]))
      .join("");
    expect(written).toContain('"interrupt"');
    expect(proc.stdin.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(proc.stdin.end).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("a retired process answers new tools/call requests with an error", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    void cli.retire();
    const c = call("t1");
    expect(dispatchHandoffCall("cli-1", c.call)).toBe(false);
    expect(c.answers[0].isError).toBe(true);
  });

  it("stdout EOF ends the attached episode but only the process close marks it dead", async () => {
    const { proc, cli } = make();
    const a = sink();
    cli.attach(a.s);
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.closes).toEqual([null]);
    expect(cli.alive).toBe(true);
    proc.emit("close", 0);
    expect(cli.alive).toBe(false);
    // Not reported twice.
    expect(a.closes).toEqual([null]);
  });

  describe("pool", () => {
    it("parks, takes, and forgets a process whose idle timer fires", async () => {
      const { proc, cli } = make();
      parkCliProcess("pi-1", cli, 1000);
      expect(parkedCliProcessCount()).toBe(1);
      expect(takeParkedCliProcess("pi-1")).toBe(cli);
      expect(parkedCliProcessCount()).toBe(0);

      parkCliProcess("pi-1", cli, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(parkedCliProcessCount()).toBe(0);
      expect(cli.retired).toBe(true);
      expect(proc.stdin.end).toHaveBeenCalled();
    });

    it("drops a parked process that exits on its own", () => {
      const { proc, cli } = make();
      parkCliProcess("pi-1", cli, 60_000);
      proc.emit("close", 0);
      expect(takeParkedCliProcess("pi-1")).toBeUndefined();
    });

    it("parking a second process for the same session retires the first", () => {
      const a = make();
      const b = make();
      parkCliProcess("pi-1", a.cli, 60_000);
      parkCliProcess("pi-1", b.cli, 60_000);
      expect(a.cli.retired).toBe(true);
      expect(takeParkedCliProcess("pi-1")).toBe(b.cli);
    });
  });

  describe("usage arithmetic", () => {
    const u = (a: number, b: number, c: number, d: number) => ({
      input_tokens: a,
      output_tokens: b,
      cache_read_input_tokens: c,
      cache_creation_input_tokens: d,
    });
    it("adds, subtracts with a zero floor, and takes component-wise max", () => {
      expect(addUsage(u(1, 2, 3, 4), u(10, 20, 30, 40))).toEqual(
        u(11, 22, 33, 44),
      );
      expect(subUsage(u(1, 20, 3, 40), u(10, 2, 30, 4))).toEqual(
        u(0, 18, 0, 36),
      );
      expect(maxUsage(u(1, 20, 3, 40), u(10, 2, 30, 4))).toEqual(
        u(10, 20, 30, 40),
      );
    });
  });
});

describe("CliProcess.applyThinking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
  });
  afterEach(() => {
    resetCliProcessesForTests();
    vi.useRealTimers();
  });

  const enabled = (budgetTokens: number, effort: any): CliThinking => ({
    kind: "enabled",
    budgetTokens,
    effort,
    display: "summarized",
  });
  const start = (thinking: CliThinking) => {
    const proc = fakeProc();
    const cli = new CliProcess(proc, {
      cliSessionId: "cli-t",
      signature: "sig",
      allowHandoff: false,
      getStderr: () => "",
      thinking,
    });
    return { proc, cli };
  };
  /** Control requests written to the CLI so far. */
  const controls = (proc: any) =>
    (proc.stdin.write as any).mock.calls
      .map((c: any) => JSON.parse(String(c[0])))
      .filter((m: any) => m.type === "control_request");
  const answer = async (proc: any, requestId: string, subtype = "success") => {
    proc.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: { subtype, request_id: requestId },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
  };
  const settled = async (p: Promise<boolean>) => {
    let value: boolean | undefined;
    void p.then((v) => (value = v));
    await vi.advanceTimersByTimeAsync(0);
    return value;
  };

  it("sends each control only after the previous one is acknowledged", async () => {
    const { proc, cli } = start(enabled(8192, "medium"));
    const p = cli.applyThinking(enabled(16384, "high"));
    await vi.advanceTimersByTimeAsync(0);
    expect(controls(proc).map((c: any) => c.request)).toEqual([
      {
        subtype: "set_max_thinking_tokens",
        max_thinking_tokens: 16384,
        thinking_display: "summarized",
      },
    ]);
    await answer(proc, controls(proc)[0].request_id);
    expect(controls(proc)[1].request).toEqual({
      subtype: "apply_flag_settings",
      settings: { effortLevel: "high" },
    });
    expect(await settled(p)).toBeUndefined();
    await answer(proc, controls(proc)[1].request_id);
    expect(await p).toBe(true);
    expect(cli.thinking).toEqual(enabled(16384, "high"));
    // Each request carries its own id.
    const ids = controls(proc).map((c: any) => c.request_id);
    expect(new Set(ids).size).toBe(2);
  });

  it("writes nothing when the process already runs that thinking", async () => {
    const { proc, cli } = start({ kind: "disabled" });
    expect(await cli.applyThinking({ kind: "disabled" })).toBe(true);
    expect(controls(proc)).toHaveLength(0);
  });

  it("keeps its own acknowledgements away from episodes, attached or not", async () => {
    const { proc, cli } = start(enabled(8192, "medium"));
    const p = cli.applyThinking({ kind: "disabled" });
    await vi.advanceTimersByTimeAsync(0);
    await answer(proc, controls(proc)[0].request_id); // detached: not buffered
    expect(await p).toBe(true);
    const q = cli.applyThinking(enabled(2048, "low"));
    await vi.advanceTimersByTimeAsync(0);
    const { messages, s } = sink();
    cli.attach(s);
    await answer(proc, controls(proc)[1].request_id); // attached
    await answer(proc, controls(proc)[2].request_id);
    expect(await q).toBe(true);
    // An answer to something else (an interrupt) still flows as before.
    await answer(proc, "int-someone-else");
    expect(messages.map((m) => m.type)).toEqual(["control_response"]);
    expect((messages[0] as any).response.request_id).toBe("int-someone-else");
  });

  it("fails and keeps the old thinking when the CLI refuses", async () => {
    const { proc, cli } = start(enabled(8192, "medium"));
    const p = cli.applyThinking(enabled(8192, "low"));
    await vi.advanceTimersByTimeAsync(0);
    await answer(proc, controls(proc)[0].request_id, "error");
    expect(await p).toBe(false);
    expect(cli.thinking).toEqual(enabled(8192, "medium"));
  });

  it("waits for the CLI's answer with no deadline; retiring the process fails it", async () => {
    const { cli } = start(enabled(8192, "medium"));
    const p = cli.applyThinking({ kind: "disabled" });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(await settled(p)).toBeUndefined();
    void cli.retire(["abort"]);
    expect(await p).toBe(false);
  });

  it("fails an outstanding change when the process exits", async () => {
    const { proc, cli } = start(enabled(8192, "medium"));
    const p = cli.applyThinking({ kind: "disabled" });
    await vi.advanceTimersByTimeAsync(0);
    proc.emit("close", 0);
    expect(await p).toBe(false);
  });

  it("refuses during a live turn without writing anything", async () => {
    const { proc, cli } = start(enabled(8192, "medium"));
    cli.writeUser("working");
    expect(await cli.applyThinking({ kind: "disabled" })).toBe(false);
    expect(controls(proc)).toHaveLength(0);
  });

  it("refuses a target only a spawn can reach", async () => {
    const { proc, cli } = start(enabled(8192, "medium"));
    expect(await cli.applyThinking({ kind: "default" })).toBe(false);
    expect(controls(proc)).toHaveLength(0);
  });
});
