/**
 * What `/claude-cli` reports: installed version, declared tested range,
 * and npm latest when online.
 *
 * The npm lookup runs only when the command runs — never polled in the
 * background. Any failure (offline, npm missing) reports "unknown", never
 * throws: version status must not break a session.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedCliVersion, resolveCliPath } from "./process-manager.js";
import {
  MIN_CONTEXT_CLI_VERSION,
  TESTED_CLI_MAX,
  isNewerThanTestedCli,
} from "./context-policy.js";

const NPM_CLI_PACKAGE = "@anthropic-ai/claude-code";

export type NpmView = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal },
) => Promise<{ stdout: string }>;

async function defaultNpmView(
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal },
): Promise<{ stdout: string }> {
  // Promisified per call so importing this module never touches
  // child_process (unit-test mocks may stub it wholesale).
  return promisify(execFile)(cmd, args, opts);
}

/**
 * Latest published version per the npm registry, or undefined when the
 * lookup fails (offline, npm missing, unexpected output). No deadline of
 * our own: the caller's abort signal is the only cancellation, and a hung
 * registry leaves the command hanging until Pi aborts it — reported as
 * unknown, not a version.
 */
export async function npmLatestCliVersion(
  signal?: AbortSignal,
  npmView: NpmView = defaultNpmView,
): Promise<string | undefined> {
  try {
    const { stdout } = await npmView(
      "npm",
      ["view", NPM_CLI_PACKAGE, "version"],
      { signal },
    );
    const version = stdout.trim().split("\n").pop()?.trim();
    return version !== undefined && /^\d+\.\d+\.\d+/.test(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

/** Installed CLI as observed by the provider, or the reason it is unknown. */
export type InstalledCli =
  { version: string; path: string | undefined } | { error: string };

async function observedInstalledCli(
  signal?: AbortSignal,
): Promise<InstalledCli> {
  try {
    return {
      version: await installedCliVersion(signal),
      path: resolveCliPath(),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Absolute path of the updater script in this installed copy.
 *
 * Derived from this module's location so the status line prints a runnable
 * path from any install layout: the npm package ships scripts/update-cli.sh
 * with its qualification fixture, and a GitHub checkout carries the same
 * relative layout. No filesystem access here — pure path arithmetic, so
 * the status renderer stays unit-testable.
 */
export function updateScriptPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "update-cli.sh",
  );
}

/** Pure rendering, so the status text is unit-testable without spawning. */
export function formatCliStatus(
  installed: InstalledCli,
  latest: string | undefined,
): string {
  const lines = ["Claude Code CLI:"];
  if ("error" in installed) {
    lines.push(`  installed: unknown (${installed.error})`);
  } else {
    lines.push(
      `  installed: ${installed.version}` +
        (installed.path ? ` (${installed.path})` : ""),
    );
  }
  lines.push(
    `  tested range: ${MIN_CONTEXT_CLI_VERSION}-${TESTED_CLI_MAX} ` +
      `(older errors; newer warns once and continues, ` +
      `PI_CLAUDE_TETHER_STRICT_VERSION=1 refuses)`,
  );
  if ("version" in installed && isNewerThanTestedCli(installed.version)) {
    lines.push(
      `  newer than tested: not yet qualified by this branch's suites`,
    );
  }
  lines.push(`  npm latest: ${latest ?? "unknown (offline?)"}`);
  lines.push(
    `  update: ${updateScriptPath()} --version <version> stages, self-tests, then swaps ` +
      `the package CLI dir (keeps the previous one for rollback)`,
  );
  return lines.join("\n");
}

/** Gather installed/tested/latest and render. The only npm call is here. */
export async function claudeCliStatus(signal?: AbortSignal): Promise<string> {
  const [installed, latest] = await Promise.all([
    observedInstalledCli(signal),
    npmLatestCliVersion(signal),
  ]);
  return formatCliStatus(installed, latest);
}
