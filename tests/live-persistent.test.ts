/**
 * Opt-in real CLI proof of Pi-owned warm-process handoff and full-history replay.
 * Uses scratch workspaces; never loads native Claude project context.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { streamViaCli } from "../src/provider";
import * as processManager from "../src/process-manager";
import { startHandoffBroker, stopHandoffBroker } from "../src/handoff-broker";
import { retireAllCliProcesses } from "../src/cli-process";

const LIVE = process.env.PI_OWNED_LIVE === "1";

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

function runTurn(context: any, options: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const stream = streamViaCli(model, context, options);
    const events: any[] = [];
    (async () => {
      for await (const ev of stream as any) {
        events.push(ev);
        if (ev.type === "done") return resolve({ done: ev, events });
        if (ev.type === "error") return reject(new Error(String(ev.error)));
      }
      reject(new Error("stream ended without done"));
    })().catch(reject);
  });
}

const ourAssistant = (content: any) => ({
  role: "assistant",
  content,
  provider: "pi-claude-tether",
  api: "pi-claude-tether",
});

describe.skipIf(!LIVE)("live: persistent CLI process", () => {
  let cliSpawn: import("vitest").MockInstance<
    typeof processManager.spawnClaude
  >;
  let cwd: string;
  let stateDir: string;
  let schemaPath: string;
  let socketPath: string;

  beforeAll(async () => {
    cliSpawn = vi.spyOn(processManager, "spawnClaude");
    cwd = mkdtempSync(join(tmpdir(), "pcc-live-persist-"));
    execSync("git init -q && git commit -q --allow-empty -m init", { cwd });
    stateDir = mkdtempSync(join(tmpdir(), "pcc-live-state-"));
    process.env.PI_CLAUDE_TETHER_STATE_DIR = stateDir;
    schemaPath = join(cwd, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify([
        {
          name: "echo",
          description: "Echo the given text back. Use it when asked to echo.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ]),
    );
    socketPath = await startHandoffBroker();
  }, 30_000);

  afterAll(async () => {
    await retireAllCliProcesses();
    stopHandoffBroker();
    delete process.env.PI_CLAUDE_TETHER_STATE_DIR;
    cliSpawn.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const processCount = () => cliSpawn.mock.calls.length;

  it("keeps one Pi-owned process through a handoff and across a commit", async () => {
    const piSessionId = randomUUID();
    const opts = {
      sessionId: piSessionId,
      cwd,
      mcpConfig: { schemaPath, version: 1, handoffSocket: socketPath },
    };
    const before = processCount();

    // Turn 1: the model must call the custom tool → handoff to pi.
    // A tiny prompt is below Anthropic's minimum cacheable prompt length for
    // this model (a platform limit) and caches nothing, which made the cache
    // assertions unreachable. This fixture is sized past that minimum so the
    // first turn writes a cached prefix that the next turns can read.
    const ctx1 = {
      systemPrompt: [
        "You are terse.",
        ...Array.from(
          { length: 600 },
          (_, i) => `Reference note ${i}: answer only what was asked.`,
        ),
      ].join("\n"),
      messages: [
        {
          role: "user",
          content:
            'Call the mcp__custom-tools__echo tool with text "ping", then reply with only: ok',
        },
      ],
    };
    const t1 = await runTurn(ctx1, opts);
    expect(t1.done.reason).toBe("toolUse");
    const call = t1.done.message.content.find(
      (c: any) => c.type === "toolCall",
    );
    expect(call.name).toBe("echo");

    // pi "executes" the tool and calls back: same process, continuation.
    const ctx2 = {
      ...ctx1,
      messages: [
        ...ctx1.messages,
        ourAssistant(t1.done.message.content),
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: "echo",
          content: [{ type: "text", text: "ping" }],
          isError: false,
        },
      ],
    };
    const t2 = await runTurn(ctx2, opts);
    expect(t2.done.reason).toBe("stop");
    const afterHandoff = processCount();
    expect(afterHandoff - before).toBe(1); // ONE process so far
    // The fixture is cacheable: turn 1 wrote a prefix (guards a vacuous pass).
    const t1Prefix =
      t1.done.message.usage.cacheRead + t1.done.message.usage.cacheWrite;
    expect(t1Prefix).toBeGreaterThan(0);
    // The handoff continuation reads the whole warm prefix back, and writes
    // only what is new since then, never a rewrite of what it already had.
    expect(t2.done.message.usage.cacheRead).toBeGreaterThanOrEqual(t1Prefix);
    expect(t2.done.message.usage.cacheWrite).toBeLessThan(t1Prefix);
    expect(cliSpawn.mock.calls.at(-1)?.[1]).toContain("You are terse.");

    // A native project change cannot replace the explicit Pi context.
    execSync("git commit -q --allow-empty -m between", { cwd });
    const ctx3 = {
      ...ctx1,
      messages: [
        ...ctx2.messages,
        ourAssistant(t2.done.message.content),
        { role: "user", content: "Reply with only: ok2" },
      ],
    };
    const t3 = await runTurn(ctx3, opts);
    expect(t3.done.reason).toBe("stop");
    expect(processCount() - before).toBe(1); // STILL one process
    const t2Prefix =
      t2.done.message.usage.cacheRead + t2.done.message.usage.cacheWrite;
    expect(t3.done.message.usage.cacheRead).toBeGreaterThanOrEqual(t2Prefix);
    expect(t3.done.message.usage.cacheWrite).toBeLessThan(t2Prefix);
    expect(cliSpawn.mock.calls.at(-1)?.[1]).toContain("You are terse.");
    console.log(
      `[live] handoff continuation: read=${t2.done.message.usage.cacheRead} write=${t2.done.message.usage.cacheWrite}; ` +
        `turn after commit: read=${t3.done.message.usage.cacheRead} write=${t3.done.message.usage.cacheWrite}; processes=${processCount() - before}`,
    );
  }, 240_000);

  it("replays Pi history on fresh processes without rediscovering native project context", async () => {
    process.env.PI_CLAUDE_TETHER_KEEPALIVE_MS = "0";
    try {
      const before = processCount();
      const piSessionId = randomUUID();
      const opts = {
        sessionId: piSessionId,
        cwd,
        mcpConfig: { schemaPath, version: 1, handoffSocket: socketPath },
      };
      const ctx1 = {
        systemPrompt: "You are terse.",
        messages: [{ role: "user", content: "Reply with only: ok" }],
      };
      const t1 = await runTurn(ctx1, opts);
      const ctx2 = {
        ...ctx1,
        messages: [
          ...ctx1.messages,
          ourAssistant(t1.done.message.content),
          { role: "user", content: "Reply with only: ok2" },
        ],
      };
      const t2 = await runTurn(ctx2, opts); // fresh process, nothing changed: warm
      expect(t2.done.reason).toBe("stop");
      expect(processCount() - before).toBe(2);
      const initialPrompt = cliSpawn.mock.calls.at(-1)?.[1];
      execSync("git commit -q --allow-empty -m between2", { cwd });
      const ctx3 = {
        ...ctx1,
        messages: [
          ...ctx2.messages,
          ourAssistant(t2.done.message.content),
          { role: "user", content: "Reply with only: ok3" },
        ],
      };
      const t3 = await runTurn(ctx3, opts); // fresh process after a commit: Pi still supplies the same prompt
      console.log(
        `[live] Pi replay after commit: read=${t3.done.message.usage.cacheRead} write=${t3.done.message.usage.cacheWrite}`,
      );
      expect(t3.done.reason).toBe("stop");
      expect(processCount() - before).toBe(3);
      expect(cliSpawn.mock.calls.at(-1)?.[1]).toBe(initialPrompt);
      for (const call of cliSpawn.mock.calls.slice(before)) {
        expect(call[2]).not.toHaveProperty("resumeSessionId");
      }
    } finally {
      delete process.env.PI_CLAUDE_TETHER_KEEPALIVE_MS;
    }
  }, 240_000);
});
