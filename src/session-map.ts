/**
 * pi session → Claude CLI session mapping.
 *
 * Observer mode keeps ONE CLI session per pi session AND account, resumed
 * across turns and restarts. pi stays the system of record: this sidecar is
 * derived state, and losing it only costs one full-history reimport.
 *
 * The account rides beside the CLI id so a `--resume` is never issued under
 * a different profile's CLAUDE_CONFIG_DIR: a mapping minted under another
 * account is ignored (the turn reimports) rather than resumed cross-profile.
 * Entries written before the account was recorded are plain strings; they
 * match only an account-agnostic read, so the first account-pinned turn
 * after the upgrade reimports once and then records the account.
 *
 * A flat JSON file rather than per-session files: entries are tiny, writes
 * are rare (one per created CLI session), and a single pi process owns a
 * given pi session at a time.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { packageStateDir } from "./data-dir.js";
import { isEphemeral } from "./env-flag.js";

/**
 * Shared state directory for the sidecar, exhaustion files and prompts.
 * Package-derived (src/data-dir.ts); `PI_CLAUDE_CLI_STATE_DIR` still
 * overrides, as before.
 */
export function stateDir(): string {
  return packageStateDir();
}

function mapPath(): string {
  return join(stateDir(), "session-map.json");
}

/** A recorded pairing. Plain strings predate account recording. */
type StoredMapping = string | { cliSessionId: string; account: string };

function readMap(): Record<string, StoredMapping> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mapPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Missing or corrupt — both mean "no mappings", which is always safe.
  }
  return {};
}

function writeMap(map: Record<string, StoredMapping>): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(mapPath(), JSON.stringify(map, null, 2), "utf-8");
  } catch {
    // Best effort: an unwritable sidecar degrades to reimport-per-restart.
  }
}

/**
 * CLI session id for a pi session, if one was created and recorded.
 *
 * Pass the account the current spawn runs under: a pairing minted under a
 * different account is ignored (never resumed cross-profile). Omitting the
 * account returns any recorded pairing, whatever profile minted it.
 */
export function getCliSession(
  piSessionId: string,
  account?: string,
): string | undefined {
  const entry = readMap()[piSessionId];
  if (typeof entry === "string") {
    // Predates account recording: only an account-agnostic read matches,
    // so the first pinned turn after the upgrade reimports once.
    return account === undefined ? entry : undefined;
  }
  if (
    entry &&
    typeof entry === "object" &&
    typeof entry.cliSessionId === "string"
  ) {
    if (account === undefined || entry.account === account) {
      return entry.cliSessionId;
    }
  }
  return undefined;
}

/**
 * Record which CLI session backs a pi session.
 *
 * A no-op under PI_CLAUDE_CLI_EPHEMERAL (src/env-flag.ts): there is no next
 * turn to resume, and the CLI was told not to keep its transcript, so a
 * recorded pairing could only ever point at a session that does not exist.
 * Clearing stays live — it only ever removes state.
 */
export function setCliSession(
  piSessionId: string,
  cliSessionId: string,
  account?: string,
): void {
  if (isEphemeral()) return;
  const map = readMap();
  map[piSessionId] =
    account === undefined ? cliSessionId : { cliSessionId, account };
  writeMap(map);
}

/** Forget a mapping so the next turn reimports from pi history. */
export function clearCliSession(piSessionId: string): void {
  const map = readMap();
  if (piSessionId in map) {
    delete map[piSessionId];
    writeMap(map);
  }
}

// ---------------------------------------------------------------------------
// Per-CLI-session system prompt.
//
// The CLI does NOT persist --system-prompt across --resume: a resumed session
// runs under Claude Code's DEFAULT prompt unless the flag is passed again.
// That is both a correctness bug (pi's instructions vanish from turn 2 on) and
// the single largest token cost in a pi session, because swapping the prompt
// invalidates the cached prefix and re-bills the whole transcript as cache
// WRITE.
//
// Re-passing is only cheap when the bytes are IDENTICAL, and rebuilding is not
// byte-stable — buildSystemPrompt() appends a tool-results paragraph the
// moment history contains a toolResult, and pi may restyle its own prompt
// between turns. So the prompt the session was CREATED with is stored here and
// replayed verbatim for the life of that CLI session.
//
// One file per session rather than a field in session-map.json: prompts run to
// tens of kilobytes, and the map is read on every spawn.
// ---------------------------------------------------------------------------

function systemPromptPath(cliSessionId: string): string {
  return join(stateDir(), "sysprompt", `${cliSessionId}.txt`);
}

/**
 * The system prompt a CLI session was created with, if it was recorded.
 *
 * Undefined for sessions created before this was stored, which correctly falls
 * back to rebuilding: less cache-stable than a verbatim replay, still far
 * better than sending no prompt at all.
 */
export function getSystemPrompt(cliSessionId: string): string | undefined {
  try {
    return readFileSync(systemPromptPath(cliSessionId), "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Store the prompt a CLI session was created with, for verbatim replay.
 *
 * A no-op under PI_CLAUDE_CLI_EPHEMERAL: only a resume reads it back, and an
 * ephemeral session is never resumed (see setCliSession).
 */
export function setSystemPrompt(cliSessionId: string, prompt: string): void {
  if (isEphemeral()) return;
  try {
    mkdirSync(join(stateDir(), "sysprompt"), { recursive: true });
    writeFileSync(systemPromptPath(cliSessionId), prompt, "utf-8");
  } catch {
    // Best effort: an unwritable sidecar degrades to rebuilding the prompt.
  }
}

/** Drop a stored prompt. Paired with clearCliSession on a resume miss. */
export function clearSystemPrompt(cliSessionId: string): void {
  try {
    rmSync(systemPromptPath(cliSessionId), { force: true });
  } catch {
    // Already gone, or unwritable — both are fine.
  }
}
