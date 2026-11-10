/**
 * Process manager for spawning and managing Claude CLI subprocesses.
 *
 * Handles subprocess lifecycle: spawn with correct CLI flags, write NDJSON
 * messages to stdin, force-kill after result (CLI hangs bug), and stderr capture.
 * Also provides startup validation for CLI presence and authentication.
 */

import spawn, { spawn as spawnProbe } from "cross-spawn";
import {
  accessSync,
  chmodSync,
  constants,
  realpathSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { runtimeFile, RUNTIME_FILE_MODE } from "./runtime-dir.js";
// The default profile path lives in accounts.js (single owner); everything
// here takes an explicit per-spawn directory instead of reading env itself.
import { PI_CLAUDE_CONFIG_DIR } from "./accounts.js";
import { packageCliBinDir } from "./data-dir.js";
import {
  ContextPolicyError,
  assertContextCliVersion,
  MIN_CONTEXT_CLI_VERSION,
  TESTED_CLI_MAX,
  parseCliVersion,
  isNewerThanTestedCli,
  strictCliVersion,
} from "./context-policy.js";
import { envFlag } from "./env-flag.js";
import { thinkingSpawnArgs, type CliThinking } from "./thinking-config.js";

/**
 * Spawn a Claude CLI subprocess with all required flags for stream-json communication.
 *
 * @param modelId - The model ID to pass via --model flag
 * @param systemPrompt - Pi's complete system prompt, staged through
 *   --system-prompt-file to replace Claude's own prompt.
 * @param options - Optional cwd, AbortSignal, thinking and MCP/account routing
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 */
/**
 * Where a spawn's system prompt is staged. Scoped to the CLI session so
 * concurrent turns in one pi process cannot clobber each other.
 */
/** One hour: the MCP tool-call timeout handed to the CLI when unset. */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 3_600_000;

/**
 * A separate Claude Code login and plugin store for Pi-owned turns. Never load ~/.claude.
 *
 * Single owner is accounts.js; re-exported here so existing import sites keep working.
 */
export { PI_CLAUDE_CONFIG_DIR };

/** Match cross-spawn/path-key's case-insensitive Windows PATH selection. */
function cliPathKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return (
    Object.keys(env)
      .reverse()
      .find((key) => key.toUpperCase() === "PATH") ?? "Path"
  );
}

export function cliEnvironment(claudeConfigDir?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Explicit account selection wins; otherwise use Pi's isolated default.
  if (claudeConfigDir !== undefined) {
    env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  } else {
    env.CLAUDE_CONFIG_DIR = PI_CLAUDE_CONFIG_DIR;
  }
  {
    // Prefer a Pi-private Claude Code install without changing the global binary
    // used by other Claude Code workflows. All probes and the child agree.
    // The directory is derived from the installed package name (src/data-dir.ts).
    const privateBin = packageCliBinDir();
    const pathKey = cliPathKey(env);
    env[pathKey] =
      `${privateBin}${process.platform === "win32" ? ";" : delimiter}${env[pathKey] ?? ""}`;
  }
  return env;
}

/** Resolve the same executable PATH the probes and child receive, without running it. */
function resolveCli(env: NodeJS.ProcessEnv): string {
  const windows = process.platform === "win32";
  // Match cross-spawn/which: cwd first on Windows, PATHEXT before an
  // extensionless fallback, and quoted PATH entries. Its fallback order is
  // .EXE;.CMD;.BAT;.COM when Windows has not supplied PATHEXT.
  const extensions = windows
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const directories = [
    ...(windows ? [process.cwd()] : []),
    ...(env[cliPathKey(env)] ?? "").split(windows ? ";" : delimiter),
  ];
  for (const pass of windows ? [extensions, [""]] : [extensions]) {
    for (const rawDirectory of directories) {
      const directory = /^".*"$/.test(rawDirectory)
        ? rawDirectory.slice(1, -1)
        : rawDirectory;
      for (const extension of pass) {
        const candidate = join(directory, `claude${extension}`);
        try {
          if (!windows) accessSync(candidate, constants.X_OK);
          if (statSync(candidate).isFile()) return realpathSync(candidate);
        } catch {
          // Missing, non-executable or inaccessible: try the next PATH entry.
        }
      }
    }
  }
  throw new Error("Claude Code CLI not found on PATH");
}

/**
 * The resolved `claude` executable for the provider's PATH, without running
 * it. Undefined when no executable resolves (validateCliPresence throws
 * with install instructions instead).
 */
export function resolveCliPath(
  env: NodeJS.ProcessEnv = cliEnvironment(),
): string | undefined {
  try {
    return resolveCli(env);
  } catch {
    return undefined;
  }
}

/**
 * Installed CLI version (e.g. "2.1.283") through the same executable PATH
 * the probes and spawns use. Throws when missing or unparseable.
 */
export async function installedCliVersion(
  signal?: AbortSignal,
): Promise<string> {
  const output = await cliOutput(["--version"], cliEnvironment(), signal);
  const version = parseCliVersion(output);
  if (version === undefined) {
    throw new Error(
      `Could not parse Claude Code version from: ${JSON.stringify(output.trim().slice(0, 120))}`,
    );
  }
  return version;
}

/** cross-spawn preserves Windows .cmd support without blocking Pi's event loop. */
function cliOutput(
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Request aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const proc = spawnProbe("claude", args, {
        env,
        signal,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (data: string) => {
        stdout += data;
      });
      proc.on("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(Object.assign(error, { stdout }));
      });
      proc.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (code === 0) resolve(stdout);
        else
          reject(
            Object.assign(new Error("Claude CLI probe failed"), {
              code,
              stdout,
            }),
          );
      });
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

// Cache only successful probes. In-flight probes belong to their caller's signal:
// sharing one would let another request's abort cancel this request (or strand it).
const contextCliVersions = new Map<string, Promise<void>>();

/**
 * Newer-than-tested CLI versions warned about once per process.
 * Reset only by tests (see resetCliVersionWarningsForTests).
 */
const warnedNewerCliVersions = new Set<string>();

/** Forget warned versions. Test seam only: production warns once per process. */
export function resetCliVersionWarningsForTests(): void {
  warnedNewerCliVersions.clear();
}

/**
 * Warn-once-and-continue above the tested range; the strict opt-in refuses
 * instead. The floor still errors in assertContextCliVersion. Runs wherever
 * the version probe runs (pi-context spawns and the /claude-cli command).
 */
export function checkTestedCliVersion(
  output: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const version = parseCliVersion(output);
  if (version === undefined || !isNewerThanTestedCli(version)) return;
  if (strictCliVersion(env)) {
    throw new ContextPolicyError(
      `Claude Code ${version} is newer than the tested range ` +
        `${MIN_CONTEXT_CLI_VERSION}-${TESTED_CLI_MAX}. ` +
        `Unset PI_CLAUDE_TETHER_STRICT_VERSION to run it with a one-time warning, ` +
        `or update the CLI to a tested version (see README).`,
    );
  }
  if (!warnedNewerCliVersions.has(version)) {
    warnedNewerCliVersions.add(version);
    console.warn(
      `[pi-claude-tether] Claude Code ${version} is newer than the tested range ` +
        `${MIN_CONTEXT_CLI_VERSION}-${TESTED_CLI_MAX}; continuing with a one-time ` +
        `warning (not yet qualified). Set PI_CLAUDE_TETHER_STRICT_VERSION=1 to ` +
        `refuse newer CLIs instead.`,
    );
  }
}

/** Verify before a pi-context spawn; Pi's abort, not an adapter deadline, ends the probe. */
export async function verifyContextCli(
  signal?: AbortSignal,
  claudeConfigDir?: string,
): Promise<void> {
  signal?.throwIfAborted();
  const env = cliEnvironment(claudeConfigDir);
  const binary = resolveCli(env);
  const key = JSON.stringify([
    binary,
    statSync(binary).mtimeMs,
    env.CLAUDE_CONFIG_DIR ?? null,
  ]);
  const cached = contextCliVersions.get(key);
  if (cached) return cached;
  const probe = cliOutput(["--version"], env, signal).then((output) => {
    // Older than the floor errors as before; newer than tested warns once
    // (or refuses under the strict opt-in) and continues.
    assertContextCliVersion(output);
    checkTestedCliVersion(output);
  });
  await probe;
  signal?.throwIfAborted();
  contextCliVersions.set(key, probe);
}

function systemPromptFilePath(sessionKey?: string): string {
  // In the private 0700 runtime directory, written 0600: the prompt carries
  // pi's instructions and the host's project context, which used to sit in a
  // world-readable /tmp file under a pid-derived name.
  const suffix = sessionKey
    ? `-${sessionKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128)}`
    : "";
  return runtimeFile(`pi-claude-tether-sysprompt${suffix}.txt`);
}

export function spawnClaude(
  modelId: string,
  systemPrompt?: string,
  options?: {
    cwd?: string;
    signal?: AbortSignal;
    /** The thinking this process starts with; see src/thinking-config.ts. */
    thinking?: CliThinking;
    mcpConfigPath?: string;
    newSessionId?: string;
    /** The account profile this spawn must run under. Unset keeps prior behavior. */
    claudeConfigDir?: string;
  },
): ChildProcess {
  if (envFlag("CLAUDE_CODE_SIMPLE") || envFlag("CLAUDE_CODE_SAFE_MODE")) {
    throw new ContextPolicyError(
      "Unset CLAUDE_CODE_SIMPLE/CLAUDE_CODE_SAFE_MODE: pi context requires subscription authentication and the explicit MCP bridge.",
    );
  }
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Acknowledge actual stdin user turns; result UUID lists may be incomplete.
    "--replay-user-messages",
    "--model",
    modelId,
    "--permission-prompt-tool",
    "stdio",
    // `AskUserQuestion` renders a picker in the CLI's own TUI, and `-p` has
    // no TUI. The call therefore cannot be answered by anyone: it returns
    // "The user did not answer the questions." after a full round trip, and
    // the model reads that as a person who declined and falls back to asking
    // in prose. Take the tool away so the
    // model asks in prose the first time — the host's UI shows prose, and
    // the user can answer it.
    "--disallowedTools",
    "AskUserQuestion",
  ];

  // Pi owns tools, instructions and history; Claude is an isolated transport.
  args.push(
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-chrome",
    "--tools",
    "",
  );

  if (options?.newSessionId) {
    // The id routes this live process's MCP handoffs; it is never persisted.
    args.push("--session-id", options.newSessionId);
  }

  // Each live process is a disposable cache of Pi history, never a disk resume.
  args.push("--no-session-persistence");

  {
    // Write the system prompt to a temp file and pass the FILE flags.
    //
    // `--system-prompt` / `--append-system-prompt` take a literal string, NOT
    // a path: handing them a path makes the path itself the system prompt, so
    // pi's instructions never reach the model and the session silently runs on
    // Claude Code's defaults. Verified on claude 2.1.231 — with a path the
    // model denied having the codename its prompt assigned; with
    // `--system-prompt-file` it answered correctly. The file variants also keep
    // the prompt off the command line, which is what avoids ENAMETOOLONG on
    // Windows.
    //
    // Keyed by CLI session, not just pid: the prompt goes on every spawn
    // (see provider.ts), and pi can run two turns of one process at once —
    // its own sub-agents do. A shared per-pid path would let one turn
    // overwrite the prompt another turn is about to read.
    const tmpFile = systemPromptFilePath(options?.newSessionId);
    writeFileSync(tmpFile, systemPrompt ?? "", {
      encoding: "utf-8",
      mode: RUNTIME_FILE_MODE,
    });
    chmodSync(tmpFile, RUNTIME_FILE_MODE);
    // Always replace Claude's own prompt with Pi's prepared instructions.
    args.push("--system-prompt-file", tmpFile);
  }

  // Host-supplied Claude Code settings (hooks, permissions). This is how a
  // host injects PreToolUse guards — e.g. a host's worktree-paths guard —
  // without pi intercepting the CLI's native tool execution.
  const settingsPath = process.env.PI_CLAUDE_TETHER_SETTINGS;
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }

  // A later turn may change these on the live process through control
  // requests (CliProcess.applyThinking), so they are the starting point, not
  // part of what makes a process reusable.
  if (options?.thinking) {
    args.push(...thinkingSpawnArgs(options.thinking));
  }

  if (options?.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  // Proxied custom tools block inside the CLI's MCP client until pi has run
  // the tool (src/handoff-broker.ts). Sub-agents and long shell tools take
  // minutes, so unless the host set its own limit, give the MCP client an
  // hour before it gives up on a call. Config, not context: it never touches
  // the prompt cache.
  const env = cliEnvironment(options?.claudeConfigDir);
  {
    // Do not use --bare: it disables subscription OAuth/keychain reads.
    // Empty setting sources drop user/project/local hooks, but explicit
    // host --settings (including safety guards) and managed policy survive.
    Object.assign(env, {
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
  }
  if (!env.MCP_TOOL_TIMEOUT)
    env.MCP_TOOL_TIMEOUT = String(DEFAULT_MCP_TOOL_TIMEOUT_MS);

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd ?? process.cwd(),
    env,
  });

  return proc as ChildProcess;
}

/**
 * Clean up the temp system prompt file created by spawnClaude.
 * Safe to call multiple times or when no file exists.
 *
 * Pass the same CLI session key the spawn used; omitting it cleans the
 * unscoped path, which is all a spawn without a session id creates.
 */
export function cleanupSystemPromptFile(sessionKey?: string): void {
  try {
    unlinkSync(systemPromptFilePath(sessionKey));
  } catch {
    // File doesn't exist or already deleted — ignore
  }
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Does NOT call stdin.end() -- stdin stays open for control_response in Phase 2.
 *
 * Accepts both string (text-only prompt) and array (ContentBlock[] with images)
 * content. JSON.stringify handles both natively. The stream-json protocol
 * supports either format in the content field.
 *
 * @param proc - The Claude subprocess
 * @param prompt - The prompt text or ContentBlock[] to send
 */
export function writeUserMessage(
  proc: ChildProcess,
  prompt: string | any[],
  uuid?: string,
): void {
  const message = {
    type: "user",
    ...(uuid ? { uuid } : {}),
    message: {
      role: "user",
      content: prompt,
    },
  };
  proc.stdin!.write(JSON.stringify(message) + "\n");
}

/**
 * Ask the CLI to end the current turn cleanly — the same interrupt a human
 * Esc produces. Unlike SIGKILL this lets the CLI persist the turn, so the
 * session stays resumable without transcript corruption. The turn then ends
 * with a `result` of subtype `error_during_execution`, which callers must
 * treat as expected.
 */
export function sendInterrupt(proc: ChildProcess): void {
  // `exitCode != null` (loose): undefined means "has not exited" on mocks and
  // some stream wrappers, and must count as alive.
  if (proc.killed || proc.exitCode != null || !proc.stdin) return;
  const request = {
    type: "control_request",
    request_id: `int-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    request: { subtype: "interrupt" },
  };
  try {
    proc.stdin.write(JSON.stringify(request) + "\n");
  } catch {
    // stdin already closed — the force-kill fallback will handle it.
  }
}

/**
 * Force-kill a subprocess immediately via SIGKILL.
 * No-ops if the process is already dead (killed or exited).
 * Cross-platform safe: Node.js treats SIGKILL as forceful termination on Windows.
 *
 * @param proc - The subprocess to force-kill
 */
export function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGKILL");
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Register a subprocess in the global process registry.
 * The process is automatically removed from the registry when it exits.
 *
 * @param proc - The subprocess to track
 */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/**
 * Force-kill all registered subprocesses and clear the registry.
 * Safe to call multiple times -- no-ops on already-dead processes.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    forceKillProcess(proc);
  }
  activeProcesses.clear();
}

/**
 * Force-kill the subprocess after a 500ms grace period.
 * The Claude CLI hangs after emitting the result message (known bug).
 * Brief grace period allows final stdout flushing before force-kill.
 *
 * @param proc - The Claude subprocess to clean up
 */
export function cleanupProcess(proc: ChildProcess): void {
  setTimeout(() => {
    forceKillProcess(proc);
  }, 500);
}

/**
 * Attach a data listener to stderr and accumulate output into a buffer.
 *
 * @param proc - The Claude subprocess
 * @returns A function that returns the accumulated stderr string
 */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr!.on("data", (data: Buffer) => {
    buffer += data.toString();
  });
  return () => buffer;
}

/**
 * Validate that the Claude CLI is installed and on PATH.
 * Throws with install instructions if not found.
 */
export function validateCliPresence(): void {
  try {
    resolveCli(cliEnvironment());
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code\n" +
        "Then authenticate by running `claude` and using `/login`.",
    );
  }
}

/**
 * Validate that the Claude CLI is authenticated.
 * Returns false and warns if not authenticated.
 *
 * Claude Code 2.x emits machine-readable JSON on `auth status` when stdout
 * is not a TTY, e.g. `{ "loggedIn": true, "authMethod": "claude.ai", ... }`.
 * We parse it and trust `loggedIn` rather than relying solely on the exit
 * code, because some transient warnings (e.g. token-refresh notices on
 * stderr) can produce a non-zero exit even when the user is signed in.
 *
 * Older CLIs that don't emit JSON fall back to exit-code semantics.
 *
 * @returns true if authenticated, false otherwise
 */
export async function validateCliAuth(
  signal?: AbortSignal,
  claudeConfigDir?: string,
): Promise<boolean> {
  let stdout: string | Buffer = "";
  let exitCode: number | null = null;
  const env = cliEnvironment(claudeConfigDir);
  try {
    stdout = await cliOutput(["auth", "status"], env, signal);
    exitCode = 0;
  } catch (err) {
    // Ended by its owner (session shutdown): no verdict, so no warning.
    if (signal?.aborted) return false;
    const e = err as { code?: number | string; stdout?: Buffer | string };
    exitCode = typeof e.code === "number" ? e.code : null;
    stdout = e.stdout ?? "";
  }

  const trimmed = (
    typeof stdout === "string" ? stdout : stdout.toString()
  ).trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { loggedIn?: boolean };
      if (parsed.loggedIn === true) return true;
      warnUnauth(env.CLAUDE_CONFIG_DIR);
      return false;
    } catch {
      // fall through to exit-code semantics
    }
  }

  if (exitCode === 0) return true;
  warnUnauth(env.CLAUDE_CONFIG_DIR);
  return false;
}

/**
 * `claude auth status` for one profile directory, as the CLI reports it
 * (logged in, email, plan), or undefined when the CLI gives no JSON. The
 * CLI reads its own login; nothing here touches a credential.
 */
export async function cliAuthStatus(
  claudeConfigDir: string,
  signal?: AbortSignal,
): Promise<
  | {
      loggedIn: boolean;
      email?: string;
      subscriptionType?: string | null;
      configDirectory?: string;
      authMethod?: string;
      orgName?: string;
    }
  | undefined
> {
  let stdout: string | Buffer = "";
  try {
    stdout = await cliOutput(
      ["auth", "status"],
      cliEnvironment(claudeConfigDir),
      signal,
    );
  } catch (err) {
    // A logged-out profile exits 1 but still prints its JSON.
    stdout = (err as { stdout?: Buffer | string }).stdout ?? "";
  }
  try {
    const parsed: unknown = JSON.parse(
      (typeof stdout === "string" ? stdout : stdout.toString()).trim(),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { loggedIn?: unknown }).loggedIn !== "boolean"
    )
      return undefined;
    const row = parsed as Record<string, unknown>;
    const text = (key: string) =>
      typeof row[key] === "string" ? (row[key] as string) : undefined;
    return {
      loggedIn: row.loggedIn as boolean,
      email: text("email"),
      subscriptionType: text("subscriptionType"),
      configDirectory: text("configDirectory"),
      authMethod: text("authMethod"),
      orgName: text("orgName"),
    };
  } catch {
    return undefined;
  }
}

function warnUnauth(configDir: string | undefined): void {
  console.warn(
    "[pi-claude-tether] Dedicated Pi Claude profile is not authenticated. " +
      `On this node run: CLAUDE_CONFIG_DIR="${configDir ?? PI_CLAUDE_CONFIG_DIR}" claude auth login --claudeai`,
  );
}
