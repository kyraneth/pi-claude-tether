import { describe, it, expect } from "vitest";
import {
  resolveSystemPromptMode,
  DEFAULT_SYSTEM_PROMPT_MODE,
  assertClaudePromptMode,
} from "../src/system-prompt-mode";
import {
  buildSystemPrompt,
  rewritePiToolSections,
} from "../src/prompt-builder";

/**
 * Synthetic prompt with the section boundaries used by the rewriter.
 */
const PI_PROMPT = [
  "You are an example assistant.",
  "Available tools:\n- read: read a file (path)\n- edit: replace text (path, oldText, newText)\n- ls: list a directory",
  "In addition to these tools, example tools may be available.",
  "Guidelines:\n- Prefer grep over bash\n- Use read before edit",
  "Example documentation.",
].join("\n\n");

describe("Claude family prompt capability", () => {
  it("admits replace and append, and rejects none without invoking a model", () => {
    expect(() => assertClaudePromptMode("replace")).not.toThrow();
    expect(() => assertClaudePromptMode("append")).not.toThrow();
    expect(() => assertClaudePromptMode("none")).toThrow(/Unsupported system prompt mode/);
  });
});

describe("resolveSystemPromptMode", () => {
  it("defaults to claude when unset", () => {
    expect(resolveSystemPromptMode({})).toBe("claude");
    expect(DEFAULT_SYSTEM_PROMPT_MODE).toBe("claude");
  });

  it("accepts pi and its alias", () => {
    expect(resolveSystemPromptMode({ PI_CLAUDE_CLI_SYSTEM_PROMPT: "pi" })).toBe(
      "pi",
    );
    expect(
      resolveSystemPromptMode({ PI_CLAUDE_CLI_SYSTEM_PROMPT: "minimal" }),
    ).toBe("pi");
  });

  it("accepts claude and its alias", () => {
    expect(
      resolveSystemPromptMode({ PI_CLAUDE_CLI_SYSTEM_PROMPT: "claude" }),
    ).toBe("claude");
    expect(
      resolveSystemPromptMode({ PI_CLAUDE_CLI_SYSTEM_PROMPT: "append" }),
    ).toBe("claude");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(
      resolveSystemPromptMode({ PI_CLAUDE_CLI_SYSTEM_PROMPT: "  PI  " }),
    ).toBe("pi");
  });

  it("falls back to the default on an unrecognised value rather than throwing", () => {
    expect(
      resolveSystemPromptMode({ PI_CLAUDE_CLI_SYSTEM_PROMPT: "banana" }),
    ).toBe("claude");
  });
});

describe("rewritePiToolSections", () => {
  it("replaces pi's tool names and params with Claude Code's", () => {
    const out = rewritePiToolSections(PI_PROMPT);
    expect(out).toContain("Read: Read file contents (key param: file_path)");
    expect(out).toContain("old_string");
    // Pi's own vocabulary must be gone — leaving it is worse than useless,
    // since the model is handed different schemas.
    expect(out).not.toContain("oldText");
    expect(out).not.toContain("- read: read a file");
    expect(out).not.toContain("- ls: list a directory");
  });

  it("keeps the surrounding blocks and their order", () => {
    const out = rewritePiToolSections(PI_PROMPT);
    expect(out.startsWith("You are an example assistant")).toBe(true);
    expect(out).toContain("Example documentation.");
    expect(out.indexOf("Available tools:")).toBeLessThan(
      out.indexOf("Example documentation."),
    );
  });

  it("returns the prompt untouched when the anchors are absent", () => {
    const foreign = "Some other harness prompt.\n\nWith no tool sections.";
    expect(rewritePiToolSections(foreign)).toBe(foreign);
  });

  it("returns the prompt untouched when the anchors are out of order", () => {
    const reversed = [
      "Intro.",
      "Guidelines:\n- a",
      "Available tools:\n- b",
    ].join("\n\n");
    expect(rewritePiToolSections(reversed)).toBe(reversed);
  });
});

describe("buildSystemPrompt mode plumbing", () => {
  const context = { systemPrompt: PI_PROMPT, messages: [] };

  it("leaves pi's wording alone in claude mode (it is appended, not replacing)", () => {
    const out = buildSystemPrompt(context, "/tmp", "claude");
    expect(out).toContain("- read: read a file");
    expect(out).toContain("oldText");
  });

  it("defaults to claude mode when no mode is given", () => {
    expect(buildSystemPrompt(context, "/tmp")).toBe(
      buildSystemPrompt(context, "/tmp", "claude"),
    );
  });

  it("rewrites the tool sections in pi mode", () => {
    const out = buildSystemPrompt(context, "/tmp", "pi");
    expect(out).toContain("file_path");
    expect(out).not.toContain("oldText");
  });

  it("swaps the tool blocks like for like, preserving the prompt's shape", () => {
    // Structural rather than size-based: the saving comes from dropping Claude
    // Code's own prompt via --system-prompt, not from this text, so asserting
    // on length would only measure the fixture. The replacement deliberately
    // mirrors pi's three-block layout (Available tools / In addition /
    // Guidelines), so the block count is unchanged and only the vocabulary moves.
    const before = PI_PROMPT.split("\n\n");
    const after = rewritePiToolSections(PI_PROMPT).split("\n\n");
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
    expect(after[after.length - 1]).toBe(before[before.length - 1]);
    expect(after[1]).toContain("file_path");
    expect(before[1]).toContain("oldText");
  });
});
