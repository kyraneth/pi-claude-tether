/** Configurable context has one loader; execution remains Claude-native. */

export const PI_CONTEXT_MARKER = '<pi_context_policy version="1">';
export class ContextPolicyError extends Error {}
export const MIN_CONTEXT_CLI_VERSION = "2.1.263";
/**
 * Newest CLI version in the declared tested range.
 *
 * Together with MIN_CONTEXT_CLI_VERSION this is the declared TESTED range.
 * A newer CLI is not refused by default: it warns once per process and
 * continues (PI_CLAUDE_CLI_STRICT_VERSION=1 refuses instead). Raised only
 * when the full suite plus the stub e2es pass against the newer version
 * (see README "Claude Code CLI version policy").
 *
 * The declared ceiling is 2.1.311. Qualification includes installation,
 * version probing, a logged-out spawn-flags smoke, the full test suite,
 * and the stub continuity and failover e2es described in README.
 */
export const TESTED_CLI_MAX = "2.1.311";

/** Parse "2.1.283 (Claude Code)" to "2.1.283". Undefined when unparseable. */
export function parseCliVersion(output: string): string | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(?=\s|$)/.exec(output.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

/** Numeric dotted-version compare: negative when a < b, positive when a > b. */
export function compareCliVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Opt-in: refuse to run on a CLI newer than TESTED_CLI_MAX. */
export function strictCliVersion(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.PI_CLAUDE_CLI_STRICT_VERSION ?? "") === "1";
}

/** True when the version is above the tested range (not yet qualified). */
export function isNewerThanTestedCli(version: string): boolean {
  return compareCliVersions(version, TESTED_CLI_MAX) > 0;
}

/** Do not assume older CLIs honor memory/skill isolation environment controls. */
export function assertContextCliVersion(output: string): void {
  const version = parseCliVersion(output);
  if (
    version === undefined ||
    compareCliVersions(version, MIN_CONTEXT_CLI_VERSION) < 0
  ) {
    throw new ContextPolicyError(
      `Pi context requires Claude Code ${MIN_CONTEXT_CLI_VERSION}+ (the tested isolation controls). Update Claude Code before using this policy.`,
    );
  }
}

export function usesPiContext(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.PI_CLAUDE_CLI_CONTEXT ?? "pi").trim().toLowerCase();
  if (!value || value === "pi") return true;
  if (value === "legacy") return false;
  throw new ContextPolicyError(
    "PI_CLAUDE_CLI_CONTEXT must be 'pi' or 'legacy'.",
  );
}

/** A policy change cannot safely reuse the CLI's hidden history/pinned prompt. */
export function assertContextPolicy(
  storedPrompt: string | undefined,
  piContext: boolean,
): void {
  if ((storedPrompt?.startsWith(PI_CONTEXT_MARKER) ?? false) !== piContext) {
    throw new ContextPolicyError(
      "Claude context policy changed (or its saved prompt is missing). Start a fresh pi session; the existing Claude transcript was not migrated.",
    );
  }
}
