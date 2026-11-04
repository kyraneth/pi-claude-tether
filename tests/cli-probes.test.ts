import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.283 (Claude Code)")),
}));
vi.mock("cross-spawn", () => ({
  spawn: vi.fn(),
  default: vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
      proc.exitCode = 0;
      proc.emit("exit", 0);
      return true;
    });
    return proc;
  }),
}));
vi.mock("@earendil-works/pi-ai", () => ({
  createAssistantMessageEventStream: () => {
    const events: any[] = [];
    return { push: (event: any) => events.push(event), end: vi.fn(), events };
  },
  calculateCost: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: () => [],
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({
  registerApiProvider: vi.fn(),
}));

import { execSync } from "node:child_process";
import spawn, { spawn as spawnProbe } from "cross-spawn";
import { cliProbe } from "./cli-probe-fixture";
import register from "../index";
import { streamViaCli } from "../src/provider";
import { resetCliProcessesForTests } from "../src/cli-process";
import {
  validateCliPresence,
  verifyContextCli,
  checkTestedCliVersion,
  resetCliVersionWarningsForTests,
} from "../src/process-manager";

const model = {
  id: "claude-haiku-4-5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;
let home: string;
let binary: string;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function hungProbe(): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new PassThrough();
  return proc;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCliProcessesForTests();
  home = mkdtempSync(join(tmpdir(), "pcc-probes-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  binary = join(bin, "claude");
  // Filesystem fixture only. All process execution in this file is mocked.
  writeFileSync(binary, "", { mode: 0o700 });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", bin);
  vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
  (spawnProbe as any).mockImplementation(() => cliProbe());
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  resetCliProcessesForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
function start(signal?: AbortSignal): any {
  return streamViaCli(
    model,
    { messages: [{ role: "user", content: "hello" }] } as any,
    { signal },
  );
}
async function finishSpawn(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  const proc = vi.mocked(spawn).mock.results.at(-1)!.value as any;
  proc.stdout.write(
    JSON.stringify({ type: "result", subtype: "success", usage: {} }) + "\n",
  );
  await vi.advanceTimersByTimeAsync(0);
}

describe("CLI probes without adapter deadlines", () => {
  it("a hung version probe ends the provider stream as aborted, without spawning", async () => {
    // No close/error even after abort: the wrapper must end its own wait.
    (spawnProbe as any).mockImplementation(hungProbe);
    const controller = new AbortController();
    const stream = start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnProbe).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(stream.end).not.toHaveBeenCalled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.end).toHaveBeenCalledTimes(1);
    expect(stream.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        reason: "aborted",
        error: expect.objectContaining({ stopReason: "aborted" }),
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it("probes once across spawns and PATH aliases, then re-probes when binary mtime changes", async () => {
    start();
    await finishSpawn();
    const alias = join(home, "alias");
    mkdirSync(alias);
    symlinkSync(binary, join(alias, "claude"));
    vi.stubEnv("PATH", alias);
    start();
    await finishSpawn();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawnProbe).toHaveBeenCalledTimes(1);
    // Fixture mutation, not a delay: every changed mtime invalidates the key.
    utimesSync(binary, new Date(0), new Date(0));
    start();
    await finishSpawn();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawnProbe).toHaveBeenCalledTimes(2);
  });
  it("extension load registers without synchronous execution, even while auth is pending", () => {
    (spawnProbe as any).mockImplementation(hungProbe);
    const pi = {
      on: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
    } as any;
    register(pi);
    // Compare count rather than printing inherited process environment on red.
    expect(vi.mocked(execSync).mock.calls.length).toBe(0);
    expect(pi.registerProvider).toHaveBeenCalledTimes(1);
    expect(spawnProbe).toHaveBeenCalledWith(
      "claude",
      ["auth", "status"],
      expect.not.objectContaining({ timeout: expect.anything() }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it("presence rejects a non-executable or directory and retains install instructions", () => {
    chmodSync(binary, 0o600);
    expect(validateCliPresence).toThrow(
      "Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code",
    );
    rmSync(binary);
    mkdirSync(binary);
    expect(validateCliPresence).toThrow(
      "Then authenticate by running `claude` and using `/login`.",
    );
    expect(execSync).not.toHaveBeenCalled();
    expect(spawnProbe).not.toHaveBeenCalled();
  });
  it("a rejected version is not cached and retains the context-policy error", async () => {
    (spawnProbe as any).mockImplementationOnce(() => cliProbe("1.0.0"));
    await expect(verifyContextCli()).rejects.toThrow("2.1.263");
    await expect(verifyContextCli()).resolves.toBeUndefined();
    expect(spawnProbe).toHaveBeenCalledTimes(2);
  });
  it("a newer-than-tested CLI warns once per process and continues", async () => {
    // Seeded red: without the max check this probe resolves silently.
    resetCliVersionWarningsForTests();
    const warned: string[] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: any[]) => {
        warned.push(args.join(" "));
      });
    try {
      (spawnProbe as any).mockImplementationOnce(() =>
        cliProbe("9.9.9 (Claude Code)"),
      );
      await verifyContextCli();
      // Successes cache: force a re-probe to prove the warning is once.
      utimesSync(binary, new Date(0), new Date(0));
      (spawnProbe as any).mockImplementationOnce(() =>
        cliProbe("9.9.9 (Claude Code)"),
      );
      await verifyContextCli();
    } finally {
      spy.mockRestore();
    }
    expect(spawnProbe).toHaveBeenCalledTimes(2);
    expect(warned.filter((w) => w.includes("9.9.9"))).toHaveLength(1);
  });
  it("PI_CLAUDE_CLI_STRICT_VERSION=1 refuses a newer-than-tested CLI", async () => {
    resetCliVersionWarningsForTests();
    vi.stubEnv("PI_CLAUDE_CLI_STRICT_VERSION", "1");
    (spawnProbe as any).mockImplementationOnce(() =>
      cliProbe("9.9.9 (Claude Code)"),
    );
    await expect(verifyContextCli()).rejects.toThrow(
      "newer than the tested range",
    );
  });
  it("a tested CLI probes silently", async () => {
    resetCliVersionWarningsForTests();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await verifyContextCli();
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it("checkTestedCliVersion ignores unparseable output (the floor already threw)", () => {
    resetCliVersionWarningsForTests();
    expect(() => checkTestedCliVersion("unknown")).not.toThrow();
  });
  it.each([false, true])(
    "a second caller can abort without cancelling the first or clearing its success (firstComplete=%s)",
    async (firstComplete) => {
      const children: any[] = [];
      (spawnProbe as any).mockImplementation(() => {
        const proc = hungProbe();
        children.push(proc);
        return proc;
      });
      const completeFirst = () => {
        children[0].stdout.emit("data", "2.1.283");
        children[0].emit("close", 0);
      };
      const first = new AbortController();
      const second = new AbortController();
      const firstProbe = verifyContextCli(first.signal);
      const secondProbe = verifyContextCli(second.signal);
      const aborted = expect(secondProbe).rejects.toThrow("Request aborted");
      if (firstComplete) {
        completeFirst();
        await firstProbe;
      }
      second.abort();
      await aborted;
      if (!firstComplete) completeFirst();
      await firstProbe;
      await verifyContextCli();
      expect(spawnProbe).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["legacy", "pi"])(
    "Windows Path-only environment is preserved for presence and probes (%s)",
    async (mode) => {
      Object.defineProperty(process, "platform", {
        ...originalPlatform,
        value: "win32",
      });
      vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", mode);
      vi.stubEnv("PATH", undefined);
      vi.stubEnv("Path", join(home, "bin"));
      vi.stubEnv("PATHEXT", ".EXE;.CMD;.BAT;.COM");
      writeFileSync(`${binary}.CMD`, "", { mode: 0o600 });
      validateCliPresence();
      await verifyContextCli();
      const env = vi.mocked(spawnProbe).mock.calls[0][2]!.env!;
      expect(env.Path).toContain(join(home, "bin"));
      expect(env.PATH).toBeUndefined();
      if (mode === "pi")
        expect(env.Path!.split(";")[0]).toContain("node_modules/.bin");
      expect(vi.mocked(execSync).mock.calls.length).toBe(0);
    },
  );

  it("Windows presence and cache select the .cmd shim before the extensionless npm shim", async () => {
    // Simulated Windows resolver; the process boundary stays mocked on Linux.
    Object.defineProperty(process, "platform", {
      ...originalPlatform,
      value: "win32",
    });
    vi.stubEnv("PATHEXT", ".EXE;.CMD;.BAT;.COM");
    vi.stubEnv("PATH", `"${join(home, "bin")}"`);
    const cmd = `${binary}.CMD`;
    writeFileSync(cmd, "", { mode: 0o600 });
    validateCliPresence();
    await verifyContextCli();
    await verifyContextCli();
    expect(spawnProbe).toHaveBeenCalledTimes(1);
    utimesSync(cmd, new Date(0), new Date(0));
    await verifyContextCli();
    expect(spawnProbe).toHaveBeenCalledTimes(2);
    expect(spawnProbe).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.not.objectContaining({ timeout: expect.anything() }),
    );
    expect(vi.mocked(execSync).mock.calls.length).toBe(0);
  });
});
