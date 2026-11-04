#!/usr/bin/env node
/**
 * Deterministic Claude Code CLI stub for pi-claude-cli e2e tests.
 * Speaks just enough of the stream-json NDJSON protocol:
 *   claude --version            -> version string
 *   claude auth status          -> JSON auth blob
 *   claude ... stream-json ...  -> reads one user message, streams "PORT-OK"
 *
 * A prompt containing "fanout" instead simulates a background
 * sub-agent turn: the model launches an
 * agent, the CLI emits `result` for that turn WHILE the agent runs, and only
 * later notifies and re-invokes the model with the findings. A provider that
 * kills on the first result never sees "AGENT-REPORT".
 */
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code stub)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, method: "stub" }));
  process.exit(0);
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// The e2e asserts which thinking flags pi's level turned into.
if (process.env.CLAUDE_STUB_ARGV_FILE) {
  require("node:fs").appendFileSync(
    process.env.CLAUDE_STUB_ARGV_FILE,
    JSON.stringify(args) + "\n",
  );
}

let responded = false;
const respond = () => {
  if (responded) return;
  responded = true;
  emit({ type: "system", subtype: "init", session_id: "stub-session" });
  emit({
    type: "stream_event",
    event: {
      type: "message_start",
      message: { usage: { input_tokens: 5, output_tokens: 0 } },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "PORT-OK" },
    },
  });
  emit({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  emit({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    },
  });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  emit({ type: "result", subtype: "success", is_error: false });
  process.exit(0);
};

/** One assistant cycle: message_start … message_stop, streaming `text`. */
const cycle = (text) => {
  emit({
    type: "stream_event",
    event: {
      type: "message_start",
      message: { usage: { input_tokens: 5, output_tokens: 0 } },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });
  emit({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  emit({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    },
  });
  emit({ type: "stream_event", event: { type: "message_stop" } });
};

const respondFanout = () => {
  if (responded) return;
  responded = true;
  emit({ type: "system", subtype: "init", session_id: "stub-session" });

  // The agent, and an auto-backgrounded Bash that is NOT one.
  emit({
    type: "system",
    subtype: "task_started",
    task_id: "aStubAgent1",
    task_type: "local_agent",
    tool_use_id: "toolu_stub_1",
    description: "Dig into the thing",
    subagent_type: "general-purpose",
  });
  emit({
    type: "system",
    subtype: "task_started",
    task_id: "bStubShell1",
    task_type: "local_bash",
    description: "Search for a local checkout",
  });

  cycle("LAUNCHED-WAITING");
  // The turn's result, with the agent still running. This is the kill point.
  emit({ type: "result", subtype: "success", is_error: false });

  setTimeout(() => {
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "bStubShell1",
      status: "completed",
    });
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "aStubAgent1",
      status: "completed",
      summary: "found it",
      usage: { total_tokens: 1234, tool_uses: 2, duration_ms: 900 },
    });
    // The CLI re-invokes the model itself once the agent reports.
    cycle("AGENT-REPORT");
    emit({ type: "result", subtype: "success", is_error: false });
    process.exit(0);
  }, 1500);
};

// Native Pi tool execution, broker socket, steer stdin, and warm follow-up.
// No model, SDK or network API call. A steer must arrive only after the old
// turn has emitted its interrupted result: default priority=next is unsafe.
let steerMode = false;
let handoffAnswered = false;
let steerMessage;
let steerAnswered = false;
let steerInterrupted = false;
const steerTrace = (kind, extra = {}) => {
  if (process.env.CLAUDE_STUB_STEER_TRACE)
    require("node:fs").appendFileSync(process.env.CLAUDE_STUB_STEER_TRACE,
      JSON.stringify({ kind, pid: process.pid, ...extra }) + "\n");
};
const answerSteer = () => {
  if (!handoffAnswered || !steerMessage || steerAnswered) return;
  steerAnswered = true;
  cycle("STEER-OK");
  emit({ type: "result", subtype: "success", is_error: false, num_turns: 2,
    usage: { input_tokens: 10, output_tokens: 6 } });
};
const startSteer = () => {
  steerMode = true;
  responded = true;
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
  const [, , socketPath, session, secretPath] = config.mcpServers["custom-tools"].args;
  steerTrace("spawn", { session });
  emit({ type: "system", subtype: "init", session_id: session });
  emit({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5 } } } });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id: "fixture-call", name: "mcp__custom-tools__fixture_steer_tool", input: {} } } });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } } });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  const socket = require("node:net").createConnection(socketPath);
  socket.on("connect", () => socket.write(JSON.stringify({ type: "call", session,
    toolUseId: "fixture-call", name: "fixture_steer_tool", arguments: {}, secret: fs.readFileSync(secretPath, "utf8") }) + "\n"));
  let reply = "";
  socket.on("data", (chunk) => {
    reply += chunk;
    if (!reply.includes("\n")) return;
    const result = JSON.parse(reply.split("\n")[0]);
    if (result.isError || result.content?.[0]?.text !== "FIXTURE-TOOL-RESULT")
      throw new Error("steer stub received the wrong handoff result");
    handoffAnswered = true;
    emit({ type: "user", message: { role: "user", content: [{ type: "tool_result",
      tool_use_id: "fixture-call", content: result.content }] }, parent_tool_use_id: null });
    steerTrace("tool_result");
    answerSteer();
  });
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // Thinking changes on a live process: acknowledge, as the CLI does.
    if (msg.type === "control_request") {
      if (steerMode && msg.request?.subtype === "interrupt") {
        steerInterrupted = true;
        emit({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1 });
      }
      emit({
        type: "control_response",
        response: { subtype: "success", request_id: msg.request_id },
      });
      continue;
    }
    if (msg.type !== "user") continue;
    if (line.includes("FIXTURE-START")) startSteer();
    else if (steerMode) {
      if (line.includes("FIXTURE-STEER")) {
        if (!steerInterrupted) throw new Error("steer arrived inside the active tool turn");
        if (!msg.uuid || steerMessage) throw new Error("missing or duplicate steer UUID");
        emit({ ...msg, isReplay: true });
        steerMessage = msg;
        steerTrace("steer");
        answerSteer();
      } else if (line.includes("FIXTURE-FOLLOWUP")) {
        if (!steerAnswered) throw new Error("follow-up arrived before the steer answer");
        steerTrace("followup");
        cycle("FOLLOWUP-OK");
        emit({ type: "result", subtype: "success", is_error: false, num_turns: 1,
          usage: { input_tokens: 5, output_tokens: 3 } });
      } else throw new Error("unexpected input/replay in steer stub");
    } else if (line.includes("fanout")) respondFanout();
    else respond();
  }
});
// Safety net: some callers write without trailing newline then wait.
setTimeout(respond, 3000);
