import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/process-manager", () => ({
  validateCliPresence: vi.fn(),
  validateCliAuth: vi.fn(),
  killAllProcesses: vi.fn(),
}));
vi.mock("../src/provider", () => ({ streamViaCli: vi.fn() }));
vi.mock("../src/cli-process", () => ({ retireAllCliProcesses: vi.fn() }));
vi.mock("../src/handoff-broker", () => ({
  startHandoffBroker: vi.fn(async () => "socket"),
  stopHandoffBroker: vi.fn(),
}));
vi.mock("../src/mcp-config", () => ({
  getCustomToolDefs: vi.fn(),
  writeSchemaFile: vi.fn(() => ({
    schemaPath: "schema",
    version: 1,
    changed: false,
  })),
  cleanupMcpConfigFiles: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({
  registerApiProvider: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: () => [
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      contextWindow: 200000,
      maxTokens: 8192,
    },
  ],
}));
import register from "../index";
import { streamViaCli } from "../src/provider";
import { retireAllCliProcesses } from "../src/cli-process";
import { writeSchemaFile } from "../src/mcp-config";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PI_CLAUDE_CLI_CONTEXT;
});

describe("pi ownership at registration", () => {
  it("never activates tools and advertises exactly the request's current tools, including none", async () => {
    const handlers = new Map<string, any>();
    const pi = {
      on: (event: string, fn: any) => handlers.set(event, fn),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      setActiveTools: vi.fn(),
      getAllTools: vi.fn(),
    };
    register(pi as any);
    const setStatus = vi.fn();
    await handlers.get("session_start")({}, { ui: { setStatus } });
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    const stream = pi.registerProvider.mock.calls[0][1].streamSimple;
    const tool = {
      name: "read",
      description: "pi read",
      parameters: { type: "object" },
    };
    stream({}, { systemPrompt: "pi", messages: [], tools: [tool] }, {});
    const firstPrepare =
      vi.mocked(streamViaCli).mock.calls[0][2]?.prepareMcpConfig;
    await firstPrepare?.({ systemPrompt: "pi", messages: [], tools: [tool] });
    expect(writeSchemaFile).toHaveBeenLastCalledWith([
      { name: "read", description: "pi read", inputSchema: tool.parameters },
    ]);
    stream({}, { systemPrompt: "pi", messages: [], tools: [] }, {});
    const secondPrepare =
      vi.mocked(streamViaCli).mock.calls[1][2]?.prepareMcpConfig;
    await secondPrepare?.({ systemPrompt: "pi", messages: [], tools: [] });
    expect(writeSchemaFile).toHaveBeenLastCalledWith([]);
    expect(pi.getAllTools).not.toHaveBeenCalled();
    expect(streamViaCli).toHaveBeenCalledTimes(2);
    for (const event of [
      "model_select",
      "session_tree",
      "session_compact",
      "session_shutdown",
    ]) {
      await handlers.get(event)({ type: event });
      expect(retireAllCliProcesses).toHaveBeenLastCalledWith(event);
    }
    expect(retireAllCliProcesses).toHaveBeenCalledTimes(5);
    expect(setStatus).toHaveBeenCalledWith("claude-rate-limit", undefined);
    expect(setStatus).toHaveBeenCalledWith("claude-subagents", undefined);
  });

  it("declares the prompt-cache lifetime and the warm decline for its provider", async () => {
    const localHandlers = new Map<string, any>();
    const pi = {
      on: (event: string, fn: any) => localHandlers.set(event, fn),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      setActiveTools: vi.fn(),
      getAllTools: vi.fn(),
    };
    register(pi as any);
    const models = pi.registerProvider.mock.calls[0][1].models;
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      // /session economics visibility: the lifetime Pi 1.4.0 documents for
      // anthropic models. No refresh is enabled through the CLI (below).
      expect(model.promptCache).toEqual({ short: 300, long: 3600 });
    }
    // The warm decline answers only for this provider's models.
    const decide = localHandlers.get("cache_warming_decision");
    expect(typeof decide).toBe("function");
    expect(await decide({}, { model: { provider: "pi-claude-cli" } })).toEqual({
      action: "stop",
    });
    expect(
      await decide({}, { model: { provider: "anthropic" } }),
    ).toBeUndefined();
    expect(await decide({}, {})).toBeUndefined();
    // The /claude-cli command reports installed/tested/latest.
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "claude-cli",
      expect.objectContaining({ description: expect.any(String) }),
    );
    const command = pi.registerCommand.mock.calls.find(
      ([name]: any[]) => name === "claude-cli",
    )?.[1];
    expect(typeof command?.handler).toBe("function");
  });

  it("probes the single non-default account's directory at startup", async () => {
    // index.ts mirrors the provider's isSingleDefaultAccountSet rule: a
    // single NAMED entry must probe under accounts/<name>/claude-config so
    // the login hint names the directory that needs `claude auth login`.
    // Only the untouched legacy shape inherits the environment (undefined).
    vi.stubEnv("PI_CLAUDE_CLI_ACCOUNTS", "solo");
    const { validateCliAuth } = await import("../src/process-manager");
    const { accountConfigDir } = await import("../src/accounts");
    const freshPi = () => ({
      on: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      setActiveTools: vi.fn(),
      getAllTools: vi.fn(),
    });
    register(freshPi() as any);
    expect(validateCliAuth).toHaveBeenCalled();
    for (const call of vi.mocked(validateCliAuth).mock.calls) {
      expect(call[1]).toBe(accountConfigDir("solo"));
    }
    // Control: exactly ["default"] keeps the inherited environment.
    vi.clearAllMocks();
    vi.stubEnv("PI_CLAUDE_CLI_ACCOUNTS", "default");
    register(freshPi() as any);
    expect(validateCliAuth).toHaveBeenCalled();
    for (const call of vi.mocked(validateCliAuth).mock.calls) {
      expect(call[1]).toBeUndefined();
    }
    vi.unstubAllEnvs();
  });
});
