import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/process-manager", () => ({
  validateCliPresence: vi.fn(() => {
    throw new Error("seeded missing CLI");
  }),
  validateCliAuth: vi.fn(),
  killAllProcesses: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("removed configuration startup diagnostics", () => {
  it("warns once at the shipped entry point, including empty old vars, without aliases or values", async () => {
    vi.resetModules();
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "legacy");
    vi.stubEnv("PI_CLAUDE_CLI_ACCOUNT", "secret-old-account");
    vi.stubEnv("PI_CLAUDE_CLI_TIMEOUT_MS", "");
    vi.stubEnv("PI_CLAUDE_CLI_AUTOCOMPACT", "auto");
    vi.stubEnv("PI_CLAUDE_CLI_UNKNOWN_OPTION", "ignored");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: register } = await import("../index");
    const pi = { on: vi.fn(), registerProvider: vi.fn() };
    register(pi as any);
    register(pi as any);
    // Delivered at session_start through Pi's notification UI, once.
    const start = pi.on.mock.calls.find(
      (c: any[]) => c[0] === "session_start",
    )![1];
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { notify, setStatus: vi.fn() },
      sessionManager: { getBranch: () => [] },
    };
    await Promise.resolve(start({}, ctx)).catch(() => {});
    await Promise.resolve(start({}, ctx)).catch(() => {});
    const retired = notify.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("Ignored retired environment variables"),
    );
    expect(retired).toHaveLength(1);
    expect(retired[0][1]).toBe("warning");
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Ignored retired"),
    );
    const message = String(retired[0][0]);
    expect(message).toContain("start a new one");
    expect(message).toContain("PI_CLAUDE_CLI_CONTEXT: removed");
    expect(message).toContain(
      "PI_CLAUDE_CLI_ACCOUNT: use PI_CLAUDE_TETHER_ACCOUNT",
    );
    expect(message).toContain(
      "PI_CLAUDE_CLI_TIMEOUT_MS: use PI_CLAUDE_TETHER_TIMEOUT_MS",
    );
    expect(message).toContain("PI_CLAUDE_CLI_AUTOCOMPACT: removed");
    expect(message).not.toContain("use PI_CLAUDE_TETHER_AUTOCOMPACT");
    expect(message).toContain("PI_CLAUDE_CLI_UNKNOWN_OPTION: retired");
    expect(message).not.toContain("use PI_CLAUDE_TETHER_UNKNOWN_OPTION");
    expect(message).not.toContain("secret-old-account");
    expect(process.env.PI_CLAUDE_TETHER_ACCOUNT).not.toBe("secret-old-account");
    expect(process.env.PI_CLAUDE_TETHER_CONTEXT).not.toBe("legacy");
    expect(pi.registerProvider).not.toHaveBeenCalled();
    for (const event of [
      "session_start",
      "input",
      "before_agent_start",
      "session_before_compact",
    ])
      expect(pi.on).toHaveBeenCalledWith(event, expect.any(Function));
  });
});

describe("removed provider resume gate", () => {
  async function setup(branch: any[], virtualRegistered = false) {
    const { guardRemovedSessionProvider } =
      await import("../src/removed-config");
    const handlers = new Map<string, any>();
    const appendEntry = vi.fn();
    guardRemovedSessionProvider({
      on: (name: string, fn: any) => handlers.set(name, fn),
      appendEntry,
    } as any);
    const ctx = {
      model: { provider: "openai-codex", id: "wrong-fallback" },
      modelRegistry: {
        find: (provider: string, id: string) =>
          virtualRegistered && provider === "my-router" && id === "smart"
            ? { api: "pi-virtual" }
            : undefined,
      },
      sessionManager: { getBranch: () => branch },
      ui: { notify: vi.fn() },
      abort: vi.fn(),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handlers.get("session_start")({}, ctx);
    return { handlers, ctx, appendEntry };
  }

  it.each(["claude-haiku-5-5", "unknown-old-model"])(
    "blocks a missing provider for %s, including bypass/summary/cache paths",
    async (id) => {
      const branch = [
        { type: "model_change", provider: "pi-claude-cli", modelId: id },
      ];
      const { handlers, ctx, appendEntry } = await setup(branch);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(`pi-claude-tether/${id}`),
        "error",
      );
      expect(await handlers.get("input")({}, ctx)).toEqual({
        action: "handled",
      });
      await handlers.get("before_agent_start")({}, ctx);
      expect(ctx.abort).toHaveBeenCalledOnce();
      expect(await handlers.get("session_before_compact")({}, ctx)).toEqual({
        cancel: true,
      });
      expect(
        await handlers.get("session_before_tree")(
          { preparation: { userWantsSummary: true } },
          ctx,
        ),
      ).toEqual({ cancel: true });
      expect(await handlers.get("cache_warming_decision")({}, ctx)).toEqual({
        action: "stop",
      });
      expect(appendEntry).not.toHaveBeenCalled();
      // Pi 1.5's physical fallback is not recorded on aborted startup; restart remains blocked.
      const restarted = await setup(branch);
      expect(await restarted.handlers.get("input")({}, restarted.ctx)).toEqual({
        action: "handled",
      });
    },
  );

  it("honors explicit equal-model selection without model_select, permanently across resume and fork", async () => {
    const branch = [
      { type: "model_change", provider: "pi-claude-cli", modelId: "old" },
    ];
    const { handlers, ctx } = await setup(branch);
    // A configured new-provider default can itself be the automatic fallback.
    ctx.model = { provider: "pi-claude-tether", id: "new" };
    expect(await handlers.get("input")({}, ctx)).toEqual({ action: "handled" });
    await handlers.get("before_agent_start")({}, ctx);
    // Real Pi setModel always appends the change, but suppresses model_select for equal models.
    branch.push({
      type: "model_change",
      provider: "pi-claude-tether",
      modelId: "new",
    });
    expect(await handlers.get("input")({}, ctx)).toBeUndefined();
    expect(
      await handlers.get("session_before_compact")({}, ctx),
    ).toBeUndefined();
    const resumed = await setup([...branch]);
    expect(resumed.ctx.ui.notify).not.toHaveBeenCalled();
    expect(
      await resumed.handlers.get("input")({}, resumed.ctx),
    ).toBeUndefined();
  });

  it("never blocks a new session", async () => {
    const { handlers, ctx } = await setup([]);
    expect(await handlers.get("input")({}, ctx)).toBeUndefined();
    await handlers.get("before_agent_start")({}, ctx);
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it.each(["explicit", "physical-response"])(
    "does not block a current non-Claude selection (%s), despite old history",
    async (kind) => {
      const branch: any[] = [
        { type: "model_change", provider: "pi-claude-cli", modelId: "old" },
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "pi-claude-cli",
            model: "old",
          },
        },
        kind === "explicit"
          ? { type: "model_change", provider: "openai-codex", modelId: "new" }
          : {
              type: "message",
              message: {
                role: "assistant",
                provider: "openai-codex",
                model: "new",
              },
            },
      ];
      const { handlers, ctx } = await setup(branch);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(await handlers.get("input")({}, ctx)).toBeUndefined();
      await handlers.get("before_agent_start")({}, ctx);
      expect(ctx.abort).not.toHaveBeenCalled();
    },
  );

  it("preserves a registered virtual selection over historical physical Claude replies; removed router is a positive control", async () => {
    const branch = [
      { type: "model_change", provider: "my-router", modelId: "smart" },
      {
        type: "message",
        message: { role: "assistant", provider: "pi-claude-cli", model: "old" },
      },
    ];
    const current = await setup(branch, true);
    expect(
      await current.handlers.get("input")({}, current.ctx),
    ).toBeUndefined();
    expect(current.ctx.ui.notify).not.toHaveBeenCalled();
    const removed = await setup(branch, false);
    expect(await removed.handlers.get("input")({}, removed.ctx)).toEqual({
      action: "handled",
    });
  });

  it("skips virtual assistant envelopes rather than treating them as physical provider selection", async () => {
    const { handlers, ctx } = await setup([
      { type: "model_change", provider: "openai-codex", modelId: "new" },
      {
        type: "message",
        message: {
          role: "assistant",
          api: "pi-virtual",
          provider: "pi-claude-cli",
          model: "not-physical",
        },
      },
    ]);
    expect(await handlers.get("input")({}, ctx)).toBeUndefined();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
