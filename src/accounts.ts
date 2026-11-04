/**
 * Claude account profiles: manual selection plus opt-in failover exhaustion.
 *
 * One Pi process uses exactly one account. The ordered set is declared with
 * PI_CLAUDE_CLI_ACCOUNTS (e.g. "default,b"); the account for this process is
 * chosen with PI_CLAUDE_CLI_ACCOUNT (e.g. a shell alias
 * `pi-b='PI_CLAUDE_CLI_ACCOUNT=b pi'`). Unset means the existing profile.
 * "default" is the existing PI_CLAUDE_CONFIG_DIR (no re-login); any other
 * name N resolves to <package-data-dir>/accounts/N/claude-config, where the
 * package data dir comes from src/data-dir.ts, which derives the directory
 * from the installed package name.
 *
 * Automatic failover between accounts is OFF unless PI_CLAUDE_CLI_FAILOVER=1.
 * When on, a rejected subscription limit marks that account exhausted until
 * the resetsAt the CLI itself reported, and the request is retried on the
 * next non-exhausted account. The expiry comes only from CLI events; nothing
 * here invents a timeout, count or threshold.
 *
 * Exhaustion is one small JSON file per account under the existing state dir,
 * written atomically (write + rename). No lock: values come from CLI events
 * and the last writer wins.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageDataDir } from "./data-dir.js";
import { stateDir } from "./session-map.js";

/** A separate Claude Code login and plugin store for Pi-owned turns. Never load ~/.claude. */
export const PI_CLAUDE_CONFIG_DIR = join(packageDataDir(), "claude-config");

/** Reserved name for the existing profile. Every other name is a subdirectory. */
export const DEFAULT_ACCOUNT = "default";

function checkName(name: string, variable: string, raw: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    throw new Error(
      `[pi-claude-cli] Invalid account name ${JSON.stringify(name)} in ${variable}=${JSON.stringify(raw)}: ` +
        `names must be non-empty, contain no path separators, and match [A-Za-z0-9._-].`,
    );
  }
}

/**
 * The declared ordered account set. Unset or blank means just the default
 * profile, which keeps single-account behavior byte-identical to before.
 */
export function parseAccountSet(
  raw: string | undefined = process.env.PI_CLAUDE_CLI_ACCOUNTS,
): string[] {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const deduped = [...new Set(names.length > 0 ? names : [DEFAULT_ACCOUNT])];
  for (const name of deduped) {
    checkName(name, "PI_CLAUDE_CLI_ACCOUNTS", raw ?? "");
  }
  return deduped;
}

/**
 * The account this Pi process uses. Unset means the default profile.
 * A named account must be a member of the declared set; anything else is a
 * configuration error, failed loudly rather than guessed.
 */
export function selectedAccountName(
  set: string[] = parseAccountSet(),
  raw: string | undefined = process.env.PI_CLAUDE_CLI_ACCOUNT,
): string {
  const name = (raw ?? "").trim();
  if (name.length === 0) return DEFAULT_ACCOUNT;
  checkName(name, "PI_CLAUDE_CLI_ACCOUNT", raw ?? "");
  if (!set.includes(name)) {
    throw new Error(
      `[pi-claude-cli] PI_CLAUDE_CLI_ACCOUNT=${JSON.stringify(name)} is not in ` +
        `PI_CLAUDE_CLI_ACCOUNTS=${JSON.stringify(set.join(","))}: declare it first.`,
    );
  }
  return name;
}

/**
 * True only for the untouched legacy shape: exactly the default profile.
 *
 * Only then do spawns, probes, ledgers and statuses omit the account and
 * inherit the surrounding environment. Any declared set — even a single
 * named entry — runs under the selected account's own CLAUDE_CONFIG_DIR
 * and names it, so a manual selection can never silently run elsewhere.
 */
export function isSingleDefaultAccountSet(set: string[]): boolean {
  return set.length === 1 && set[0] === DEFAULT_ACCOUNT;
}

/**
 * Whether a rejected subscription limit may replay on another account.
 *
 * Only the exact value "1" enables failover; other values leave it disabled.
 */
export function failoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PI_CLAUDE_CLI_FAILOVER ?? "") === "1";
}

/** The CLAUDE_CONFIG_DIR a spawn or probe for this account must use. */
export function accountConfigDir(name: string): string {
  if (name === DEFAULT_ACCOUNT) return PI_CLAUDE_CONFIG_DIR;
  return join(packageDataDir(), "accounts", name, "claude-config");
}

function exhaustionPath(name: string): string {
  return join(stateDir(), `account-exhausted-${name}.json`);
}

/**
 * Whether the account is exhausted now. Missing, corrupt or resetsAt-less
 * files mean "not exhausted": only a CLI-reported resetsAt in the future
 * pins an account.
 */
export function isAccountExhausted(
  name: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(exhaustionPath(name), "utf-8"));
  } catch {
    return false;
  }
  const resetsAt = (parsed as { resetsAt?: unknown } | null)?.resetsAt;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return false;
  return nowSeconds < resetsAt;
}

/** Record the CLI-reported resetsAt for an account. Best effort, never throws. */
export function markAccountExhausted(name: string, resetsAt: number): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const body = JSON.stringify({
      account: name,
      resetsAt,
      observedAt: Math.floor(Date.now() / 1000),
    });
    const tmp = `${exhaustionPath(name)}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, exhaustionPath(name));
  } catch {
    /* diagnostics only: the in-memory exclusion still protects this turn */
  }
}

/** The CLI-reported resetsAt per account, for the all-exhausted error. */
export function accountResetTimes(
  set: string[],
): Array<{ account: string; resetsAt: number | null }> {
  return set.map((account) => {
    let resetsAt: number | null = null;
    try {
      const parsed = JSON.parse(
        readFileSync(exhaustionPath(account), "utf-8"),
      ) as unknown;
      const value = (parsed as { resetsAt?: unknown } | null)?.resetsAt;
      if (typeof value === "number" && Number.isFinite(value)) resetsAt = value;
    } catch {
      /* missing or corrupt means unknown, not zero */
    }
    return { account, resetsAt };
  });
}

/**
 * First account in set order whose exhaustion has expired, skipping one
 * (the attempt that just failed) and any account already tried in this
 * provider call. The in-memory `attempted` set is the per-call termination
 * bound: persisted files stay the cross-call signal, but a stale resetsAt
 * or a silently failed write can never make the driver loop forever — once
 * every account was tried, the selection is empty. Undefined when every
 * account is exhausted or already tried.
 */
export function selectFailoverAccount(
  set: string[],
  exclude?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  attempted?: ReadonlySet<string>,
): string | undefined {
  return set.find(
    (name) =>
      name !== exclude &&
      !(attempted?.has(name) ?? false) &&
      !isAccountExhausted(name, nowSeconds),
  );
}

/**
 * The account a new provider call starts on. Always the manually selected
 * one, unless failover is on and it is still exhausted from an earlier
 * call — then the first fresh account in set order, so a later spawn
 * before resetsAt stays on the account that answered.
 */
export function pickInitialAccount(set: string[]): string {
  const pinned = selectedAccountName(set);
  if (!failoverEnabled()) return pinned;
  if (!isAccountExhausted(pinned)) return pinned;
  return selectFailoverAccount(set, pinned) ?? pinned;
}
