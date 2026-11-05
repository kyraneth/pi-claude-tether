import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Native RPC proof fixture. No model calls, timers, shell commands or credentials. */
export default function (pi: ExtensionAPI) {
  const logPath = process.env.CONTINUITY_TOOL_LOG;
  if (!logPath) throw new Error("CONTINUITY_TOOL_LOG is required");
  let pending: { toolCallId: string; release: () => void } | undefined;
  const record = (ctx: ExtensionContext, data: Record<string, unknown>) => {
    const row = { at: new Date().toISOString(), monoNs: process.hrtime.bigint().toString(), ...data };
    appendFileSync(logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    // notify is a fire-and-forget native RPC event, not a dialog or model message.
    ctx.ui.notify(`CONTINUITY:${JSON.stringify(row)}`, "info");
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "rpc") throw new Error("Continuity proof requires native RPC mode");
    record(ctx, { type: "fixture_ready", piPid: process.pid });
  });
  pi.on("before_provider_request", (_event, ctx) => {
    record(ctx, { type: "pi_provider_request", provider: ctx.model?.provider, model: ctx.model?.id });
  });

  pi.registerCommand("continuity-steer", {
    description: "Queue native steering while the proof tool is still running, then release it",
    handler: async (_args, ctx) => {
      const current = pending;
      if (!current) throw new Error("No running steer tool; refusing idle steering");
      const message = "Do not call tools. Reply with exactly STEER-OK, not STEER-OLD.";
      pi.sendUserMessage(message, { deliverAs: "steer" });
      record(ctx, { type: "steer_queued", toolCallId: current.toolCallId, deliverAs: "steer", message });
      pending = undefined;
      current.release();
    },
  });

  pi.registerTool({
    name: "continuity_tool",
    label: "Continuity proof tool",
    description: "Synthetic continuity proof. plain returns immediately; abort waits for Pi's AbortSignal; steer waits for the external continuity-steer command.",
    parameters: Type.Object({ mode: Type.Union([Type.Literal("plain"), Type.Literal("abort"), Type.Literal("steer")]) }),
    async execute(toolCallId, { mode }, signal, _onUpdate, ctx) {
      if (pending) throw new Error("A continuity tool is already pending");
      if (mode === "plain") {
        record(ctx, { type: "tool_running", mode, toolCallId });
      } else {
        if (!signal) throw new Error("Native Pi tool AbortSignal missing");
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const release = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
          const onAbort = () => {
            if (pending?.toolCallId === toolCallId) pending = undefined;
            record(ctx, { type: "tool_abort_observed", mode, toolCallId });
            reject(new Error("Continuity tool observed native AbortSignal"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (mode === "steer") pending = { toolCallId, release };
          // This is emitted ONLY after the unresolved promise and abort listener exist.
          // The RPC controller never acts merely on tool_execution_start.
          record(ctx, { type: "tool_running", mode, toolCallId, signalAborted: signal.aborted });
        });
      }
      // A fresh result nonce cannot be guessed from prior markers or mode names.
      // Synthetic failure payload exercises Unicode and whitespace preservation.
      const shape = process.env.CONTINUITY_RECEIPT_SHAPE;
      if (shape === "long-error" && mode === "plain") {
        // 15,344 chars is the measured production error, not a transport cap.
        const text = ("ERROR_HEAD\\n" + "synthetic-error-data ".repeat(15344)).slice(0, 15334) + "ERROR_TAIL";
        record(ctx, { type: "tool_return", mode, toolCallId, resultText: text });
        throw new Error(text);
      }
      const syntheticError = (shape === "synthetic-error" || shape === "error-outer-whitespace") && mode === "plain";
      const syntheticRead = shape === "synthetic-read" && mode === "plain";
      const syntheticBody = "─".repeat(112) + "é".repeat(7) + "x".repeat(483);
      // Synthetic large read includes Unicode and a native-style truncation footer.
      const largeReadText = () => {
        const footer = "\n\n[238 more lines in file. Use offset=253 to continue.]";
        const unicode = "─".repeat(124) + "é".repeat(3);
        const ascii = "synthetic read body only ".repeat(Math.ceil(50992 / 25));
        const body = unicode + ascii.slice(0, 50992 - footer.length - 250 - unicode.length);
        const lines = Array.from({ length: 251 }, (_, i) => body.slice(Math.floor(i * body.length / 251), Math.floor((i + 1) * body.length / 251)));
        return lines.join("\n") + footer;
      };
      const resultText = syntheticRead ? largeReadText() : syntheticError ? "    " + syntheticBody.match(/.{43}/gu)!.join("\n") +
        (shape === "error-outer-whitespace" ? " \t\r\n" : "") :
        `CONTINUITY-TOOL-${mode.toUpperCase()}${mode === "steer" ? `:${randomUUID()}` : ""}`;
      record(ctx, { type: "tool_return", mode, toolCallId, resultText });
      return { content: [{ type: "text", text: resultText }], ...(syntheticError ? { isError: true } : {}), details: { mode, toolCallId } };
    },
  });

  pi.registerTool({
    name: "continuity_side",
    label: "Parallel receipt side result",
    description: "Synthetic side result for an explicitly requested parallel tool pair.",
    parameters: Type.Object({}),
    async execute(toolCallId, _args, _signal, _onUpdate, ctx) {
      record(ctx, { type: "tool_running", mode: "side", toolCallId });
      const resultText = "CONTINUITY-TOOL-SIDE";
      record(ctx, { type: "tool_return", mode: "side", toolCallId, resultText });
      return { content: [{ type: "text", text: resultText }], details: { toolCallId } };
    },
  });
}
