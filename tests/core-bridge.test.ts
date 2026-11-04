import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect } from "node:net";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { createMcpBridge, type BridgeInvocation, type BridgeResult } from "pi-tether-core/mcp/bridge";
import { assertPromptMode, selectSystemPrompt } from "pi-tether-core/system-prompt";

const tools = [{ name: "work", description: "Pi tool", inputSchema: { type: "object", properties: { value: { type: "integer", minimum: 1 }, tag: { type: "string", pattern: "^ok" } }, required: ["value"], additionalProperties: false } }];
const bridges: ReturnType<typeof createMcpBridge>[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { const done = child.exitCode === null && child.signalCode === null ? new Promise<void>(r => child.once("exit", () => r())) : Promise.resolve(); child.kill(); await done; }
  await Promise.all(bridges.splice(0).map(b => b.retire()));
});
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
async function setup(onInvocation?: (i: BridgeInvocation) => void) {
  const queue: BridgeInvocation[] = [];
  const waiters: Array<(i: BridgeInvocation) => void> = [];
  const bridge = createMcpBridge({ sessionId: "pi-session", generation: "generation-1", tools, onInvocation(i) { onInvocation?.(i); const waiter = waiters.shift(); if (waiter) waiter(i); else queue.push(i); } });
  bridges.push(bridge);
  const descriptor = await bridge.start();
  const child = spawn(descriptor.command, descriptor.args, { env: { ...process.env, ...descriptor.env }, stdio: "pipe" });
  children.push(child);
  const replies = new Map<string | number, (v: any) => void>();
  createInterface({ input: child.stdout }).on("line", line => { const msg = JSON.parse(line); const reply = replies.get(msg.id); replies.delete(msg.id); reply?.(msg); });
  let id = 0;
  function request(method: string, params?: any) { const n = ++id; const d = deferred<any>(); replies.set(n, d.resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); return d.promise; }
  const config = JSON.parse(readFileSync(descriptor.args[1], "utf8"));
  const secret = readFileSync(config.secretPath, "utf8");
  function raw(overrides: Record<string, unknown>) {
    const socket = connect(config.socketPath); socket.setEncoding("utf8");
    return new Promise<any>((resolve, reject) => {
      let buffer = "";
      socket.on("error", reject);
      socket.on("close", () => resolve(undefined));
      socket.on("connect", () => socket.write(JSON.stringify({ type: "call", sessionId: config.sessionId, generation: config.generation, connectionId: "raw", requestId: 1, schemaHash: config.schemaHash, secret, name: "work", arguments: { value: 1 }, ...overrides }) + "\n"));
      socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { resolve(JSON.parse(buffer.split("\n")[0])); socket.destroy(); } });
    });
  }
  return { bridge, request, raw, descriptor, config, secret, queue, notify: (method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"), next: () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<BridgeInvocation>(r => waiters.push(r)) };
}
function journal(bridge: ReturnType<typeof createMcpBridge>, inv: BridgeInvocation, result: BridgeResult) { bridge.journalResult({ ...inv, journalEntryId: `pi-journal:${inv.piCallId}`, result }); }

describe("shared MCP bridge actual stdio → socket → Pi journal roundtrip", () => {
  it("advertises exact schemas without vendor annotations and stages private authenticated runtime", async () => {
    const s = await setup();
    expect((await s.request("initialize")).result.capabilities).toEqual({ tools: {} });
    expect((await s.request("tools/list")).result.tools).toEqual(tools);
    expect((await s.request("unsupported")).error.code).toBe(-32601);
    expect(statSync(dirname(s.descriptor.args[1])).mode & 0o777).toBe(0o700);
    for (const p of [s.descriptor.args[1], s.config.secretPath, s.config.socketPath]) expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(s.descriptor)).not.toContain(s.secret);
    expect("execute" in s.bridge).toBe(false);
  });
  it("parks parallel identical calls separately, preserves metadata, long/error/image results and exact receipts", async () => {
    const s = await setup();
    const p1 = s.request("tools/call", { name: "work", arguments: { value: 1 }, _meta: { callId: "opaque", progressToken: 12 } });
    const p2 = s.request("tools/call", { name: "work", arguments: { value: 1 } });
    const a = await s.next(), b = await s.next();
    expect(a.piCallId).not.toBe(b.piCallId);
    expect(a.identity.requestId).not.toBe(b.identity.requestId);
    expect(a.metadata).toEqual({ callId: "opaque", progressToken: 12 });
    expect(s.bridge.receipts().every(r => r.states.at(-1) === "surfaced_to_pi")).toBe(true);
    // Detaching the Pi episode retains the suspended MCP request, not an artificial turn.
    s.bridge.setAttached(false);
    expect(() => journal(s.bridge, a, { content: [] })).toThrow("not attached");
    s.bridge.setAttached(true);
    const image: BridgeResult = { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: "failed\n".repeat(20000) }], isError: true }; // Synthetic long result workload, not a transport limit.
    const text: BridgeResult = { content: [{ type: "text", text: "second" }], isError: false };
    journal(s.bridge, b, text); journal(s.bridge, a, image);
    expect((await p1).result).toEqual(image); expect((await p2).result).toEqual(text);
    expect(() => journal(s.bridge, a, image)).toThrow("settled");
    s.bridge.markHostAccepted(a);
    expect(s.bridge.verifyContent(a, image)).toBe(true);
    expect(s.bridge.receipts()[0].states).toEqual(["requested", "surfaced_to_pi", "result_journaled", "response_sent", "host_accepted", "content_verified"]);
    const copy = s.bridge.receipts(); copy[0].states.length = 0;
    expect(s.bridge.receipts()[0].states.at(-1)).toBe("content_verified");
  });
  it("rejects seeded authentication, generation, schema, tool and arguments before surfacing", async () => {
    const s = await setup();
    for (const seed of [ { secret: "wrong" }, { secret: 123 }, { generation: "stale" }, { sessionId: "other" }, { schemaHash: "changed" }, { connectionId: "" }, { requestId: null }, { name: "native_exec" }, { arguments: [] }, { arguments: {} }, { arguments: { value: 0 } }, { arguments: { value: "1" } }, { arguments: { value: 1, extra: true } }, { arguments: { value: 1, tag: "bad" } } ]) {
      expect((await s.raw(seed)).isError).toBe(true);
      expect(s.queue).toHaveLength(0);
      expect(s.bridge.receipts()).toHaveLength(0);
    }
    expect((await s.request("tools/call", { name: "work", arguments: [] })).result.isError).toBe(true);
    s.bridge.setAttached(false);
    expect((await s.raw({})).isError).toBe(true);
  });
  it("binds journal delivery to full pending identity, not tool/arguments, and refuses early receipt claims", async () => {
    const s = await setup(); const response = s.request("tools/call", { name: "work", arguments: { value: 1 } }); const inv = await s.next();
    const result: BridgeResult = { content: [{ type: "text", text: "journaled" }] };
    expect(() => s.bridge.markHostAccepted(inv)).toThrow();
    expect(() => s.bridge.verifyContent(inv, result)).toThrow();
    for (const seed of [ { piCallId: "wrong" }, { name: "other" }, { arguments: { value: 2 } }, { identity: { ...inv.identity, generation: "stale" } }, { identity: { ...inv.identity, connectionId: "other" } }, { identity: { ...inv.identity, requestId: "different" } } ]) expect(() => journal(s.bridge, { ...inv, ...seed }, result)).toThrow("identity mismatch");
    expect(() => s.bridge.journalResult({ ...inv, journalEntryId: "", result })).toThrow();
    journal(s.bridge, inv, result); expect((await response).result).toEqual(result);
    expect(s.bridge.verifyContent(inv, { content: [{ type: "text", text: "truncated" }] })).toBe(false);
    expect(s.bridge.receipts()[0].states.at(-1)).toBe("mismatch");
    expect(() => s.bridge.setAttached(true)).toThrow("fenced");
    expect((await s.request("tools/call", { name: "work", arguments: { value: 1 } })).result.isError).toBe(true);
  });
  it("rejects duplicate wire identity and retires pending calls as unknown without replay", async () => {
    const s = await setup();
    const pending = s.raw({}); const inv = await s.next();
    expect((await s.raw({})).isError).toBe(true);
    expect(s.bridge.receipts()).toHaveLength(1);
    await s.bridge.retire();
    // raw client's connection closes without any invented tool result.
    await pending;
    expect(s.bridge.receipts()[0].states.at(-1)).toBe("unknown");
    expect(() => journal(s.bridge, inv, { content: [] })).toThrow("not attached");
    await expect(s.bridge.start()).rejects.toThrow("retired");
  });
  it("refuses a staged schema mutation at server construction", async () => {
    const s = await setup();
    s.config.tools[0].inputSchema.required = [];
    writeFileSync(s.descriptor.args[1], JSON.stringify(s.config));
    const child = spawn(s.descriptor.command, s.descriptor.args, { stdio: "pipe" });
    children.push(child);
    const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
    expect(code).toBe(1);
    expect(s.bridge.receipts()).toEqual([]);
  });
  it("cancellation fences unknown effects and cannot be reattached for new invocations", async () => {
    const s = await setup();
    const response = s.request("tools/call", { name: "work", arguments: { value: 1 } });
    const inv = await s.next();
    s.notify("notifications/cancelled", { requestId: inv.identity.requestId });
    expect((await response).result.isError).toBe(true);
    expect((await s.raw({})).isError).toBe(true);
    expect(s.bridge.receipts()[0].states.at(-1)).toBe("unknown");
    expect(() => s.bridge.setAttached(true)).toThrow("fenced");
    expect(() => journal(s.bridge, inv, { content: [] })).toThrow("not attached");
  });
  it("freezes declarations across caller mutation and separates bridge generations", async () => {
    const s = await setup(); const other = await setup();
    expect(s.config.socketPath).not.toBe(other.config.socketPath);
    expect((await other.raw({ secret: s.secret })).isError).toBe(true);
    const advertised = (await s.request("tools/list")).result.tools;
    advertised[0].inputSchema.required = [];
    expect((await s.request("tools/list")).result.tools).toEqual(tools);
  });
});

describe("system prompt capability gate", () => {
  const append = { promptModes: ["append"] as const, instructionMechanisms: ["workspace"] };
  it("never substitutes append for replace and refuses unknown/no mechanisms before launch", () => {
    expect(() => assertPromptMode(append, "replace")).toThrow("Unsupported");
    expect(() => selectSystemPrompt(append, "append", "Pi", "vendor-default")).toThrow();
    expect(() => assertPromptMode({ promptModes: ["replace"], instructionMechanisms: [] }, "replace")).toThrow();
    expect(() => assertPromptMode(append, "unknown" as any)).toThrow();
  });
  it("preserves exact prompt bytes and requires explicit no-instructions mode", () => {
    const instructions = "  Pi\n\nUnicode Καλημέρα\n";
    expect(selectSystemPrompt(append, "append", instructions, "workspace")).toEqual({ mode: "append", instructions, mechanism: "workspace" });
    const none = { promptModes: ["none"] as const, instructionMechanisms: [] };
    expect(selectSystemPrompt(none, "none", "")).toEqual({ mode: "none", instructions: "" });
    expect(() => selectSystemPrompt(none, "none", "Pi")).toThrow();
  });
});
