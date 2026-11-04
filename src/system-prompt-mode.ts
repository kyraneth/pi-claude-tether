import { assertPromptMode, type PromptMode } from "pi-tether-core/system-prompt";

/**
 * Which system prompt the Claude CLI subprocess runs under.
 *
 * `claude` (the default) appends pi's prompt to Claude Code's own via
 * `--append-system-prompt-file`. Everything the CLI normally knows about its
 * built-in tools stays in place, and pi's instructions ride on top.
 *
 * `pi` replaces Claude Code's prompt outright via `--system-prompt-file`,
 * leaving only pi's — the point of a minimal harness being that it does not
 * inherit another agent's preamble.
 *
 * The `-file` suffix is not optional: the unsuffixed flags take a literal
 * string, so passing them a path makes the path itself the prompt. See
 * process-manager.ts.
 *
 * Tool schemas remain present under either prompt mode.
 *
 * The trade is real, which is why this is a choice and not a default flip:
 * Claude Code's prompt carries operating guidance for its own tools, so
 * dropping it means the model works from pi's instructions plus the tool
 * schemas alone. `rewritePiToolSections` compensates by restating pi's tool
 * documentation in Claude Code's names, but a model may still behave
 * differently. Default stays `claude`.
 */
/** Explicit family capability; legacy env parsing below remains unchanged. */
export const CLAUDE_PROMPT_CAPABILITIES = {
  promptModes: ["replace", "append"] as PromptMode[],
  instructionMechanisms: ["system-prompt-file", "append-system-prompt-file"],
};
export function assertClaudePromptMode(mode: PromptMode): void {
  assertPromptMode(CLAUDE_PROMPT_CAPABILITIES, mode);
}

export type SystemPromptMode = "claude" | "pi";

export const DEFAULT_SYSTEM_PROMPT_MODE: SystemPromptMode = "claude";

/**
 * Resolve the mode from the environment.
 *
 * Unset or unrecognised values fall back to the default rather than throwing:
 * a typo in a launcher's env should not stop a session from starting.
 */
export function resolveSystemPromptMode(
  env: NodeJS.ProcessEnv = process.env,
): SystemPromptMode {
  const raw = (env.PI_CLAUDE_CLI_SYSTEM_PROMPT ?? "").trim().toLowerCase();
  if (raw === "pi" || raw === "minimal") return "pi";
  if (raw === "claude" || raw === "append") return "claude";
  return DEFAULT_SYSTEM_PROMPT_MODE;
}
