import "./cli-path-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("cross-spawn", async () => {
  const { cliProbe } = await import("./cli-probe-fixture");
  return {
    spawn: vi.fn(() => cliProbe("2.1.263 (Claude Code)")),
    default: vi.fn(() => ({})),
  };
});
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.263 (Claude Code)")),
}));
import spawn from "cross-spawn";
import { spawnClaude, cleanupSystemPromptFile } from "../src/process-manager";
import { handleControlRequest } from "../src/control-handler";

afterEach(() => {
  cleanupSystemPromptFile();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("default pi-owned launch", () => {
  it("replaces the prompt, disables native tools and persistence, preserves explicit guards and auth", () => {
    vi.stubEnv("PI_CLAUDE_TETHER_SETTINGS", "/host/guards.json");
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/account/selected");
    vi.stubEnv("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "0");
    spawnClaude("claude-haiku-4-5", "PI-CONTEXT", {
      mcpConfigPath: "/pi/bridge.json",
    });
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    const argv = args as string[];
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv).toContain("--no-chrome");
    expect(argv).toContain("--no-session-persistence");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/pi/bridge.json");
    expect(argv[argv.indexOf("--settings") + 1]).toBe("/host/guards.json");
    expect(
      readFileSync(argv[argv.indexOf("--system-prompt-file") + 1], "utf8"),
    ).toBe("PI-CONTEXT");
    for (const forbidden of [
      "--bare",
      "--safe-mode",
      "--append-system-prompt-file",
      "--autocompact",
      "--dangerously-skip-permissions",
    ])
      expect(argv).not.toContain(forbidden);
    expect(options?.env).toMatchObject({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/account/selected",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
    expect(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("0");
  });

  it("passes --no-session-persistence once, with or without PI_CLAUDE_TETHER_EPHEMERAL", () => {
    // The removed ephemeral knob cannot change the Pi-owned spawn policy.
    for (const ephemeral of ["", "1"]) {
      vi.stubEnv("PI_CLAUDE_TETHER_EPHEMERAL", ephemeral);
      spawnClaude("claude-haiku-4-5", "PI-CONTEXT", { newSessionId: "once" });
      const argv = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(
        argv.filter((arg) => arg === "--no-session-persistence"),
        `PI_CLAUDE_TETHER_EPHEMERAL=${ephemeral}`,
      ).toHaveLength(1);
      expect(argv[argv.indexOf("--session-id") + 1]).toBe("once");
    }
    cleanupSystemPromptFile("once");
  });

  it("ignores seeded retired provider settings at the actual spawn boundary", () => {
    spawnClaude("claude-haiku-4-5", "PI-ONLY", {
      mcpConfigPath: "/pi/bridge.json",
    });
    const [, baselineArgs, baselineOptions] = vi.mocked(spawn).mock.calls[0];
    for (const [key, value] of Object.entries({
      CONTEXT: "legacy",
      STATE_DIR: "/retired/state",
      ACCOUNT: "retired",
      ACCOUNTS: "retired,other",
      SETTINGS: "/retired/settings.json",
      SYSTEM_PROMPT: "claude",
      AUTOCOMPACT: "400k",
      TIMEOUT_MS: "1",
      STRICT_MCP: "0",
      HERMETIC: "0",
      EPHEMERAL: "0",
    }))
      vi.stubEnv(`PI_CLAUDE_CLI_${key}`, value);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/retired/profile");

    spawnClaude("claude-haiku-4-5", "PI-ONLY", {
      mcpConfigPath: "/pi/bridge.json",
    });
    const [, args, options] = vi.mocked(spawn).mock.calls[1];
    const argv = args as string[];
    expect(argv).toEqual(baselineArgs);
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(
      baselineOptions?.env?.CLAUDE_CONFIG_DIR,
    );
    expect(options?.env?.CLAUDE_CONFIG_DIR).not.toBe("/retired/profile");
    expect(options?.env?.PATH).toBe(baselineOptions?.env?.PATH);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--settings");
    expect(argv).not.toContain("--autocompact");
    expect(argv).not.toContain("--append-system-prompt-file");
    expect(
      readFileSync(argv[argv.indexOf("--system-prompt-file") + 1], "utf8"),
    ).toBe("PI-ONLY");
    expect(options?.env).toMatchObject({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      ENABLE_TOOL_SEARCH: "false",
    });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe("/retired/profile");
  });

  it("always stages the Pi prompt without a CLI resume", () => {
    spawnClaude("claude-haiku-4-5", undefined);
    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(argv).not.toContain("--resume");
    expect(argv).toContain("--system-prompt-file");
  });

  it("refuses non-pi execution even if a native permission request arrives", () => {
    const stdin = { write: vi.fn() };
    const request = {
      request_id: "x",
      request: { tool_name: "Bash", input: {} },
    } as any;
    expect(
      handleControlRequest(request, stdin as any, { allowHandoff: true }),
    ).toBe(false);
    request.request.tool_name = "mcp__custom-tools__bash";
    expect(
      handleControlRequest(request, stdin as any, { allowHandoff: true }),
    ).toBe(true);
  });
});
