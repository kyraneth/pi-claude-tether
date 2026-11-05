import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertContextPolicy,
  assertContextCliVersion,
  parseCliVersion,
  compareCliVersions,
  strictCliVersion,
  isNewerThanTestedCli,
  MIN_CONTEXT_CLI_VERSION,
  TESTED_CLI_MAX,
  PI_CONTEXT_MARKER,
  usesPiContext,
} from "../src/context-policy";
import { buildSystemPrompt } from "../src/prompt-builder";
import {
  piSystemPrompt,
  replayPiMessages,
  historyHash,
} from "../src/pi-context";

const suffix = `Pi documentation (read only when asked):
- Main documentation: /opt/example/.pi/docs

CUSTOM DIRECTIVES: Use edit with oldText; preserve this user-authored rule verbatim.

<project_context><project_instructions path="/repo/CLAUDE.md">PROJECT-SENTINEL .pi/config</project_instructions></project_context>

<available_skills><skill><name>audit</name><location>/opt/example/.pi/skills/audit/SKILL.md</location></skill></available_skills>`;
const prompt = `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
- read: Read files
- edit: Make edits
- bash: Execute commands
- grep: Search content
- find: Find files
- artifact_create: Publish an artifact
- mcp: Call the pi MCP gateway
- annotate: Custom annotations with oldText and newText

In addition to the tools above, you may have access to other custom tools.

Guidelines:
- Use read to examine files
- Use grep to search files
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing separate locations use edits[]
- Each edits[].oldText is matched against the original file, not after earlier edits are applied.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use artifact_create for substantial deliverables
- Theme: honor light and dark modes
- Custom annotations may use oldText and newText

${suffix}`;

afterEach(() => vi.unstubAllEnvs());

describe("pi context", () => {
  it("replays all history in order, including old images and all tool results", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image", data: "old-image", mimeType: "image/png" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "toolCall", id: "a", name: "edit", arguments: { edits: [] } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "a",
        toolName: "edit",
        isError: true,
        content: "denied",
      },
      { role: "user", content: "next" },
      {
        role: "toolResult",
        toolCallId: "b",
        toolName: "custom",
        content: "result",
      },
    ];
    const result = replayPiMessages(messages);
    expect(result[1].source.data).toBe("old-image");
    const text = JSON.stringify(result);
    expect(text).toContain("edits");
    expect(text).toContain("denied");
    expect(text.indexOf("denied")).toBeLessThan(text.indexOf("next"));
    expect(text).toContain("result");
    expect(text).not.toContain("private");
    expect(historyHash(messages)).toBe(
      historyHash(messages.map((m) => ({ ...m, timestamp: 1, usage: {} }))),
    );
    expect(historyHash(messages)).not.toBe(historyHash(messages.slice(1)));
  });
  it("requires a CLI that supports the tested isolation controls", () => {
    for (const version of ["2.1.263 (Claude Code)", "2.2.0", "3.0.0"])
      expect(() => assertContextCliVersion(version)).not.toThrow();
    for (const version of [
      "2.1.262",
      "2.0.999",
      "1.99.999",
      "unknown",
      "2.1.263-beta",
    ])
      expect(() => assertContextCliVersion(version)).toThrow(
        "Update Claude Code",
      );
  });
  it("parses the installed version out of `claude --version` output", () => {
    expect(parseCliVersion("2.1.283 (Claude Code)")).toBe("2.1.283");
    expect(parseCliVersion("2.1.283")).toBe("2.1.283");
    expect(parseCliVersion("  2.1.310 (Claude Code)  \n")).toBe("2.1.310");
    expect(parseCliVersion("unknown")).toBeUndefined();
    expect(parseCliVersion("")).toBeUndefined();
  });
  it("compares dotted versions numerically, not lexicographically", () => {
    expect(compareCliVersions("2.1.283", "2.1.283")).toBe(0);
    expect(compareCliVersions("2.1.9", "2.1.10")).toBeLessThan(0);
    expect(compareCliVersions("2.2.0", "2.1.310")).toBeGreaterThan(0);
    expect(compareCliVersions("3.0.0", "2.9.9")).toBeGreaterThan(0);
  });
  it("declares the tested range as floor plus newest qualified CLI", () => {
    expect(MIN_CONTEXT_CLI_VERSION).toBe("2.1.263");
    expect(
      compareCliVersions(TESTED_CLI_MAX, MIN_CONTEXT_CLI_VERSION),
    ).toBeGreaterThan(0);
    expect(isNewerThanTestedCli(TESTED_CLI_MAX)).toBe(false);
    expect(isNewerThanTestedCli("9.9.9")).toBe(true);
  });
  it('strict version mode is exactly "1"', () => {
    expect(strictCliVersion({} as any)).toBe(false);
    expect(strictCliVersion({ PI_CLAUDE_CLI_STRICT_VERSION: "1" } as any)).toBe(
      true,
    );
    expect(
      strictCliVersion({ PI_CLAUDE_CLI_STRICT_VERSION: "true" } as any),
    ).toBe(false);
  });
  it("defaults to pi ownership and rejects misspelled policies", () => {
    expect(usesPiContext({})).toBe(true);
    expect(usesPiContext({ PI_CLAUDE_CLI_CONTEXT: "" })).toBe(true);
    expect(usesPiContext({ PI_CLAUDE_CLI_CONTEXT: "  " })).toBe(true);
    expect(usesPiContext({ PI_CLAUDE_CLI_CONTEXT: "legacy" })).toBe(false);
    expect(usesPiContext({ PI_CLAUDE_CLI_CONTEXT: " PI " })).toBe(true);
    expect(() => usesPiContext({ PI_CLAUDE_CLI_CONTEXT: "typo" })).toThrow(
      "must be",
    );
  });

  it("does not rediscover this repository's AGENTS or add history-dependent prompt text", () => {
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
    const first = buildSystemPrompt(
      { systemPrompt: prompt, messages: [] },
      process.cwd(),
    );
    const next = buildSystemPrompt(
      { systemPrompt: prompt, messages: [{ role: "toolResult" }] },
      process.cwd(),
    );
    expect(first).toBe(piSystemPrompt(prompt));
    expect(next).toBe(first);
    expect(
      buildSystemPrompt(
        { systemPrompt: prompt, messages: [] },
        process.cwd(),
        "pi",
      ),
    ).toBe(first);
    expect(first.startsWith(prompt)).toBe(true);
    expect(first).toContain("edits[].oldText");
  });

  it("requires fresh sessions across policy boundaries, but permits same-policy resumes", () => {
    expect(() => assertContextPolicy("legacy prompt", false)).not.toThrow();
    expect(() => assertContextPolicy(undefined, false)).not.toThrow();
    expect(() =>
      assertContextPolicy(`${PI_CONTEXT_MARKER}\npi prompt`, true),
    ).not.toThrow();
    expect(() => assertContextPolicy("legacy prompt", true)).toThrow(
      "fresh pi session",
    );
    expect(() => assertContextPolicy(undefined, true)).toThrow(
      "fresh pi session",
    );
    expect(() =>
      assertContextPolicy(`${PI_CONTEXT_MARKER}\npi prompt`, false),
    ).toThrow("fresh pi session");
  });
});
