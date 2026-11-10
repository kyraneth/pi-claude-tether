import { cliFixtureHome } from "./cli-path-fixture";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// Mock cross-spawn before importing process-manager
vi.mock("cross-spawn", async () => {
  const { cliProbe } = await import("./cli-probe-fixture");
  return {
    spawn: vi.fn(() => cliProbe("2.1.283 (Claude Code)")),
    default: vi.fn(() => {
      const EventEmitter = require("node:events");
      const proc = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.kill = vi.fn(() => {
        proc.killed = true;
      });
      proc.pid = 12345;
      return proc;
    }),
  };
});

// Mock subprocess execution for validation tests
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import spawn, { spawn as spawnProbe } from "cross-spawn";
import { execSync } from "node:child_process";
import { cliProbe } from "./cli-probe-fixture";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { packageCliBinDir, packageDataDir } from "../src/data-dir";
import {
  spawnClaude,
  verifyContextCli,
  sendInterrupt,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  validateCliPresence,
  validateCliAuth,
  forceKillProcess,
  registerProcess,
  killAllProcesses,
  cleanupSystemPromptFile,
} from "../src/process-manager";

describe("spawnClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isolates Pi-owned Claude from the inherited legacy profile", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/legacy-profile");
    (execSync as any).mockReturnValue("2.1.283 (Claude Code)");
    try {
      spawnClaude("claude-opus-5-5", "Test identity");
      const [, args, options] = (spawn as any).mock.calls.at(-1);
      // Package-derived: resolves the historical path in this tree.
      expect(options.env.CLAUDE_CONFIG_DIR).toBe(
        join(packageDataDir(), "claude-config"),
      );
      expect(args).toContain("--strict-mcp-config");
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/legacy-profile");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves the Pi-private CLI for version, auth and child without changing the parent PATH", async () => {
    vi.stubEnv("PATH", "/legacy/bin");
    vi.stubEnv("HOME", cliFixtureHome);
    // Package-derived: resolves the historical prefix in this tree.
    const privateBin = packageCliBinDir();
    mkdirSync(privateBin, { recursive: true });
    writeFileSync(join(privateBin, "claude"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
    const expectedPath = `${privateBin}${delimiter}/legacy/bin`;
    (execSync as any).mockReturnValue("2.1.283 (Claude Code)");
    try {
      spawnClaude("claude-opus-5-5");
      expect((spawn as any).mock.calls.at(-1)[2].env.PATH).toBe(expectedPath);
      await verifyContextCli();
      expect((spawnProbe as any).mock.calls.at(-1)[2].env.PATH).toBe(
        expectedPath,
      );
      validateCliPresence();
      authOutput('{"loggedIn":true,"authMethod":"claude.ai"}');
      expect(await validateCliAuth()).toBe(true);
      expect((spawnProbe as any).mock.calls.at(-1)[2].env.PATH).toBe(
        expectedPath,
      );
      expect(process.env.PATH).toBe("/legacy/bin");
    } finally {
      rmSync(join(privateBin, "claude"), { force: true });
      vi.unstubAllEnvs();
    }
  });

  it("spawns claude with all required CLI flags", () => {
    spawnClaude("claude-sonnet-4-5-20250929");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = (spawn as any).mock.calls[0];

    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-5-20250929");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
    // No TUI under -p, so an AskUserQuestion call can only ever come back
    // "The user did not answer the questions."
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("AskUserQuestion");
  });

  it("passes stream-json for both input-format and output-format", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    const inputFormatIdx = args.indexOf("--input-format");
    expect(args[inputFormatIdx + 1]).toBe("stream-json");

    const outputFormatIdx = args.indexOf("--output-format");
    expect(args[outputFormatIdx + 1]).toBe("stream-json");
  });

  it("sets stdio to pipe for stdin, stdout, and stderr", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const options = (spawn as any).mock.calls[0][2];
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("passes cwd from options when provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      cwd: "/custom/path",
    });
    const options = (spawn as any).mock.calls[0][2];
    expect(options.cwd).toBe("/custom/path");
  });

  it("writes system prompt to temp file and passes path via --system-prompt-file", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--system-prompt-file");
    const idx = args.indexOf("--system-prompt-file");
    expect(args[idx + 1]).toContain("pi-claude-tether-sysprompt");
  });

  it("stages the system prompt owner-only in the private runtime directory", () => {
    if (process.platform === "win32") return;
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const args = (spawn as any).mock.calls[0][1] as string[];
    const file = args[args.indexOf("--system-prompt-file") + 1];

    // It used to be a pid-named file straight in a world-readable /tmp, and
    // it carries pi's instructions plus the host's project context.
    expect(file).toMatch(
      /pi-claude-[^/]+\/pi-claude-tether-sysprompt[^/]*\.txt$/,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("passes the Pi prompt as a readable file, never literal-path text", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--append-system-prompt-file");
    expect(
      readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8"),
    ).toBe("You are a helpful assistant.");
  });

  it("temp file contains the system prompt text", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const args = (spawn as any).mock.calls[0][1] as string[];
    const tmpFile = args[args.indexOf("--system-prompt-file") + 1];
    expect(existsSync(tmpFile)).toBe(true);
    expect(readFileSync(tmpFile, "utf-8")).toBe("You are a helpful assistant.");
  });

  it("does not include --append-system-prompt when no system prompt", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("returns the spawned ChildProcess", () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    expect(proc).toBeDefined();
    expect(proc.pid).toBe(12345);
  });
});

describe("thinking flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const argsOf = () => (spawn as any).mock.calls[0][1] as string[];
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("starts an enabled level with its budget, effort and display", () => {
    spawnClaude("claude-sonnet-5", undefined, {
      thinking: {
        kind: "enabled",
        budgetTokens: 8192,
        effort: "medium",
        display: "summarized",
      },
    });
    const args = argsOf();
    expect(after(args, "--max-thinking-tokens")).toBe("8192");
    expect(after(args, "--effort")).toBe("medium");
    expect(after(args, "--thinking-display")).toBe("summarized");
    expect(args).not.toContain("--thinking");
  });

  it("starts pi's off with thinking disabled and no budget or effort", () => {
    spawnClaude("claude-haiku-4-5", undefined, {
      thinking: { kind: "disabled" },
    });
    const args = argsOf();
    expect(after(args, "--thinking")).toBe("disabled");
    expect(args).not.toContain("--max-thinking-tokens");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--thinking-display");
  });

  it("passes no thinking flags for the CLI default or when none is given", () => {
    spawnClaude("claude-opus-5", undefined, { thinking: { kind: "default" } });
    spawnClaude("claude-opus-5", "system prompt", { cwd: "/path" });
    for (const call of (spawn as any).mock.calls) {
      const args = call[1] as string[];
      for (const flag of [
        "--thinking",
        "--max-thinking-tokens",
        "--effort",
        "--thinking-display",
      ])
        expect(args).not.toContain(flag);
    }
  });
});

describe("writeUserMessage", () => {
  it("writes correct NDJSON user message to stdin", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "Hello Claude");

    expect(mockStdin.write).toHaveBeenCalledTimes(1);
    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("Hello Claude");
  });

  it("appends newline to the JSON", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "test");

    const written = mockStdin.write.mock.calls[0][0] as string;
    expect(written.endsWith("\n")).toBe(true);
  });

  it("does NOT call stdin.end()", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "test");

    expect(mockStdin.end).not.toHaveBeenCalled();
  });

  it("sends string content in NDJSON when given string", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "hello");

    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(typeof parsed.message.content).toBe("string");
    expect(parsed.message.content).toBe("hello");
  });

  it("sends array content in NDJSON when given ContentBlock[]", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    const blocks = [
      { type: "text", text: "hello" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ];
    writeUserMessage(proc, blocks as any);

    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content).toEqual(blocks);
  });
});

describe("cleanupProcess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the process with SIGKILL after 500ms grace period", () => {
    const mockProc: any = {
      killed: false,
      exitCode: null,
      kill: vi.fn(() => {
        mockProc.killed = true;
      }),
    };

    cleanupProcess(mockProc as ChildProcess);

    // Not killed immediately
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Not killed at 400ms
    vi.advanceTimersByTime(400);
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Killed after 500ms grace period
    vi.advanceTimersByTime(100);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not kill if process is already killed", () => {
    const proc = {
      killed: true,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    cleanupProcess(proc);
    vi.advanceTimersByTime(500);

    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("captureStderr", () => {
  it("returns a function that accumulates stderr data", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);

    stderr.emit("data", Buffer.from("error line 1\n"));
    stderr.emit("data", Buffer.from("error line 2\n"));

    expect(getStderr()).toBe("error line 1\nerror line 2\n");
  });

  it("returns empty string when no stderr data", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);
    expect(getStderr()).toBe("");
  });
});

function authOutput(
  stdout: string,
  error: (Error & { code?: number }) | null = null,
): void {
  (spawnProbe as any).mockImplementation(() =>
    cliProbe(
      stdout,
      error?.code ?? (error ? 1 : 0),
      error && error.code === undefined ? error : undefined,
    ),
  );
}
describe("validateCliPresence", () => {
  it("does not throw when claude is executable on PATH", async () => {
    expect(() => validateCliPresence()).not.toThrow();
  });

  it("throws with install instructions when claude is absent from PATH", async () => {
    vi.stubEnv("PATH", "/nonexistent-pcc-bin");

    expect(() => validateCliPresence()).toThrow();
    try {
      validateCliPresence();
    } catch (e: any) {
      expect(e.message).toContain("Claude Code CLI not found");
      expect(e.message).toContain("npm install");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("validateCliAuth", () => {
  it("probes only the dedicated Pi-owned profile, not a legacy profile login", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/legacy-profile");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      authOutput('{"loggedIn":false}');
      expect(await validateCliAuth()).toBe(false);
      const [, , options] = (spawnProbe as any).mock.calls.at(-1);
      expect(options.env.CLAUDE_CONFIG_DIR).toBe(
        join(packageDataDir(), "claude-config"),
      );
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/legacy-profile");
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("returns true when claude auth status succeeds with non-JSON output", async () => {
    authOutput("Logged in");
    expect(await validateCliAuth()).toBe(true);
  });

  it("returns true when JSON output reports loggedIn:true even if exit is non-zero", async () => {
    // Simulate a transient warning that flips the exit code but still
    // produces valid JSON on stdout.
    authOutput(
      '{"loggedIn":true,"authMethod":"claude.ai"}',
      Object.assign(new Error("warning on stderr"), { code: 1 }),
    );
    expect(await validateCliAuth()).toBe(true);
  });

  it("returns false and warns when JSON output reports loggedIn:false", async () => {
    authOutput('{"loggedIn":false}');
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await validateCliAuth()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not authenticated"),
    );
    warnSpy.mockRestore();
  });

  it("returns false and warns when claude auth status fails with no JSON", async () => {
    authOutput("", new Error("not authenticated"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await validateCliAuth()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not authenticated"),
    );
    warnSpy.mockRestore();
  });
});

describe("CLI flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnClaude does NOT include --permission-mode or dontAsk in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("dontAsk");
  });

  it("spawnClaude includes --permission-prompt-tool followed by stdio in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--permission-prompt-tool");
    const idx = args.indexOf("--permission-prompt-tool");
    expect(args[idx + 1]).toBe("stdio");
  });
});

describe("mcp-config flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnClaude with mcpConfigPath includes --mcp-config followed by the path", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      mcpConfigPath: "/tmp/mcp-config.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--mcp-config");
    const idx = args.indexOf("--mcp-config");
    expect(args[idx + 1]).toBe("/tmp/mcp-config.json");
  });

  it("spawnClaude without mcpConfigPath does NOT include --mcp-config in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--mcp-config");
  });

  it("spawnClaude always includes --strict-mcp-config in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      mcpConfigPath: "/tmp/mcp-config.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--strict-mcp-config");
  });

  it("backward compatibility - existing calls with only thinking/cwd still work", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "system prompt", {
      cwd: "/path",
      thinking: {
        kind: "enabled",
        budgetTokens: 16384,
        effort: "high",
        display: "summarized",
      },
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--system-prompt-file");
    expect(args).toContain("--effort");
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("--permission-prompt-tool");
  });
});

describe("forceKillProcess", () => {
  it("calls proc.kill('SIGKILL') on live process", () => {
    const proc = {
      killed: false,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("no-ops when proc.killed is true", () => {
    const proc = {
      killed: true,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("no-ops when proc.exitCode is not null", () => {
    const proc = {
      killed: false,
      exitCode: 0,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("process registry", () => {
  beforeEach(() => {
    // Clear registry between tests
    killAllProcesses();
    vi.clearAllMocks();
  });

  it("registerProcess adds proc and killAllProcesses kills it", () => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });

    registerProcess(proc as unknown as ChildProcess);
    killAllProcesses();

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("proc exit event removes from registry", () => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });

    registerProcess(proc as unknown as ChildProcess);

    // Simulate natural exit
    proc.exitCode = 0;
    proc.emit("exit", 0, null);

    // Clear mock to check killAllProcesses doesn't call kill again
    proc.kill.mockClear();
    proc.killed = false;
    proc.exitCode = null;

    killAllProcesses();

    // Should NOT have been killed since it was removed on exit
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("killAllProcesses clears set and handles already-dead processes", () => {
    const EventEmitter = require("node:events");
    const proc1 = new EventEmitter();
    proc1.killed = true; // already dead
    proc1.exitCode = null;
    proc1.kill = vi.fn();

    const proc2 = new EventEmitter();
    proc2.killed = false;
    proc2.exitCode = 1; // already exited
    proc2.kill = vi.fn();

    const proc3 = new EventEmitter();
    proc3.killed = false;
    proc3.exitCode = null; // alive
    proc3.kill = vi.fn(() => {
      proc3.killed = true;
    });

    registerProcess(proc1 as unknown as ChildProcess);
    registerProcess(proc2 as unknown as ChildProcess);
    registerProcess(proc3 as unknown as ChildProcess);

    killAllProcesses();

    // Already dead -- forceKillProcess should no-op
    expect(proc1.kill).not.toHaveBeenCalled();
    expect(proc2.kill).not.toHaveBeenCalled();
    // Live process should be killed
    expect(proc3.kill).toHaveBeenCalledWith("SIGKILL");

    // Calling again should not kill anything (set was cleared)
    proc3.kill.mockClear();
    proc3.killed = false;
    proc3.exitCode = null;
    killAllProcesses();
    expect(proc3.kill).not.toHaveBeenCalled();
  });
});

describe("PI_CLAUDE_TETHER_SETTINGS passthrough", () => {
  const original = process.env.PI_CLAUDE_TETHER_SETTINGS;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PI_CLAUDE_TETHER_SETTINGS;
    else process.env.PI_CLAUDE_TETHER_SETTINGS = original;
    vi.clearAllMocks();
  });

  it("passes --settings when the env var is set (hook injection point)", () => {
    process.env.PI_CLAUDE_TETHER_SETTINGS = "/etc/example/claude-settings.json";
    spawnClaude("claude-haiku-4-5");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).toContain("--settings");
    expect(args[args.indexOf("--settings") + 1]).toBe(
      "/etc/example/claude-settings.json",
    );
  });

  it("omits --settings when unset", () => {
    delete process.env.PI_CLAUDE_TETHER_SETTINGS;
    spawnClaude("claude-haiku-4-5");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain("--settings");
  });
});

describe("sendInterrupt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes an interrupt control_request to stdin", () => {
    const proc = spawnClaude("claude-haiku-4-5");
    sendInterrupt(proc);
    const written = (proc.stdin!.write as any).mock.calls
      .map((c: any) => String(c[0]))
      .join("");
    const line = written.trim().split("\n").pop()!;
    const msg = JSON.parse(line);
    expect(msg.type).toBe("control_request");
    expect(msg.request.subtype).toBe("interrupt");
    expect(msg.request_id).toBeTruthy();
  });

  it("no-ops on a dead process", () => {
    const proc = spawnClaude("claude-haiku-4-5");
    (proc as any).killed = true;
    sendInterrupt(proc);
    expect((proc.stdin!.write as any).mock.calls).toHaveLength(0);
  });

  it("mints distinct request ids", () => {
    const proc = spawnClaude("claude-haiku-4-5");
    sendInterrupt(proc);
    sendInterrupt(proc);
    const ids = (proc.stdin!.write as any).mock.calls.map(
      (c: any) => JSON.parse(String(c[0])).request_id,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("cleanupSystemPromptFile", () => {
  it("deletes the temp file when it exists", () => {
    // Create the file by spawning with a system prompt
    (spawn as any).mockClear();
    spawnClaude("claude-sonnet-4-5-20250929", "test prompt");
    const args = (spawn as any).mock.calls[0][1] as string[];
    const tmpFile = args[args.indexOf("--system-prompt-file") + 1];
    expect(existsSync(tmpFile)).toBe(true);

    cleanupSystemPromptFile();
    expect(existsSync(tmpFile)).toBe(false);
  });

  it("does not throw when file does not exist", () => {
    // Ensure file doesn't exist
    cleanupSystemPromptFile();
    // Call again — should not throw
    expect(() => cleanupSystemPromptFile()).not.toThrow();
  });
});

describe("removed ephemeral variable is ignored", () => {
  const originalEnv = process.env.PI_CLAUDE_TETHER_EPHEMERAL;

  afterEach(() => {
    if (originalEnv === undefined)
      delete process.env.PI_CLAUDE_TETHER_EPHEMERAL;
    else process.env.PI_CLAUDE_TETHER_EPHEMERAL = originalEnv;
  });

  it.each(["1", "true", "YES"])(
    "always disables persistence even with the removed variable set to %s",
    (value) => {
      process.env.PI_CLAUDE_TETHER_EPHEMERAL = value;
      spawnClaude("claude-haiku-4-5", undefined, {});
      const args = (spawn as any).mock.calls.at(-1)[1] as string[];
      expect(args.filter((a) => a === "--no-session-persistence")).toHaveLength(
        1,
      );
    },
  );

  it("keeps --session-id alongside it, so the spawn stays keyed", () => {
    // The id still names the staged prompt file and the MCP config; the CLI
    // honours it without writing a transcript (verified on 2.1.280).
    process.env.PI_CLAUDE_TETHER_EPHEMERAL = "1";
    spawnClaude("claude-haiku-4-5", undefined, { newSessionId: "eph-1" });
    const args = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(args[args.indexOf("--session-id") + 1]).toBe("eph-1");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
  });

  it("still disables persistence when the ephemeral knob is unset or falsy", () => {
    delete process.env.PI_CLAUDE_TETHER_EPHEMERAL;
    spawnClaude("claude-haiku-4-5", undefined, { newSessionId: "s-1" });
    const unset = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(unset).toContain("--no-session-persistence");

    process.env.PI_CLAUDE_TETHER_EPHEMERAL = "0";
    spawnClaude("claude-haiku-4-5", undefined, { newSessionId: "s-1" });
    const falsy = (spawn as any).mock.calls.at(-1)[1] as string[];
    expect(falsy).toEqual(unset);
  });
});
