/**
 * Claude account profiles: manual selection plus opt-in failover exhaustion.
 *
 * One Pi process uses exactly one account. The ordered set is declared with
 * PI_CLAUDE_TETHER_ACCOUNTS (e.g. "default,b") plus settings-file entries.
 * Selection follows runtime/session choice, captured launch account, stored
 * default, then the existing profile. Launch example:
 * `pi-b='PI_CLAUDE_TETHER_ACCOUNT=b pi'`.
 * "default" is the existing PI_CLAUDE_CONFIG_DIR (no re-login); any other
 * name N resolves to <package-data-dir>/accounts/N/claude-config, where the
 * package data dir comes from src/data-dir.ts, which derives the directory
 * from the installed package name.
 *
 * Automatic failover between accounts is OFF unless enabled in the settings
 * file (`failover: true`, set with /claude-accounts failover on) or, per
 * process, by PI_CLAUDE_TETHER_FAILOVER. A recognised variable overrides it.
 * When on, a rejected subscription limit marks that account exhausted until
 * the resetsAt the CLI itself reported, and the request is retried on the
 * next non-exhausted account. The expiry comes only from CLI events; nothing
 * here invents a timeout, count or threshold.
 *
 * Exhaustion is one small JSON file per account under the existing state dir,
 * written atomically (write + rename). No lock: values come from CLI events
 * and the last writer wins.
 */

import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { packageDataDir, packageLeaf } from "./data-dir.js";
import { addStartupNotice } from "./startup-notices.js";
import { stateDir } from "./session-map.js";

export interface AccountDeclaration {
  name: string;
  email?: string;
  plan?: string;
  addedAt?: string;
  pending?: boolean;
  console?: boolean;
  sso?: boolean;
}
export interface AccountsStore {
  accounts: AccountDeclaration[];
  default?: string;
  failover?: boolean;
}
let sessionSelection: string | undefined;
let launchSelection: { account: string } | undefined;

/** Capture once before publishing runtime choices to the child environment. */
export function captureLaunchAccount(): string {
  launchSelection ??= { account: process.env.PI_CLAUDE_TETHER_ACCOUNT ?? "" };
  return launchSelection.account;
}

/**
 * The declaration/default/failover store, in Pi's agent directory like other
 * extension settings (`<agent-dir>/pi-claude-tether.json`, honouring
 * PI_CODING_AGENT_DIR). Claude login directories stay in the data directory.
 */
export function accountsPath(): string {
  return join(getAgentDir(), `${packageLeaf()}.json`);
}

/** 0.12.0 kept the store at <data-dir>/accounts.json. */
export function legacyAccountsPath(): string {
  return join(packageDataDir(), "accounts.json");
}

/**
 * Move a 0.12.0 store to the agent directory once. The old path is never read
 * as configuration; if both exist, the new one wins and the old one is named.
 */
export function migrateAccountsStore(): void {
  const from = legacyAccountsPath();
  const to = accountsPath();
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  const published = publishNoClobber(from, to);
  if (published === "unsupported") {
    addStartupNotice(
      `Could not move ${from} to ${to} automatically: this filesystem has no hard links, needed to move it without risking a newer file. Move it yourself; until then the old file is not read.`,
    );
    return;
  }
  if (!published) {
    addStartupNotice(
      `Ignoring old ${from}; account settings now live in ${to}. Delete the old file once you have checked it.`,
    );
    return;
  }
  unlinkSync(from);
  addStartupNotice(`Moved Claude account settings from ${from} to ${to}.`);
}

/**
 * Publish `from` at `to` only if `to` does not exist, atomically: a hard link
 * fails with EEXIST instead of replacing a file another Pi process wrote, and
 * readers never see a partly written file. Across filesystems the copy is
 * staged next to `to` and linked from there. Returns false when `to` already
 * exists and "unsupported" when the filesystem has no hard links; the source
 * is never removed here.
 */
export function publishNoClobber(
  from: string,
  to: string,
  link: (source: string, target: string) => void = linkSync,
): boolean | "unsupported" {
  const linkOnce = (source: string): boolean | "unsupported" => {
    try {
      link(source, to);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP")
        return "unsupported";
      throw error;
    }
  };
  const direct = linkOnce(from);
  if (direct !== "unsupported") return direct;
  const staged = `${to}.${process.pid}.migrate`;
  copyFileSync(from, staged, constants.COPYFILE_EXCL);
  try {
    return linkOnce(staged);
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Only our declaration file, never the CLI's credential store. */
export function readAccounts(): AccountsStore {
  let body: string;
  try {
    body = readFileSync(accountsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { accounts: [] };
    throw error;
  }
  const parsed = JSON.parse(body) as AccountsStore;
  if (!parsed || !Array.isArray(parsed.accounts))
    throw new Error("Invalid accounts.json: expected accounts array");
  const seen = new Set<string>();
  for (const a of parsed.accounts) {
    if (!a || typeof a.name !== "string")
      throw new Error("Invalid accounts.json account");
    checkName(a.name, "accounts.json", a.name);
    if (seen.has(a.name))
      throw new Error(`Duplicate accounts.json account ${a.name}`);
    seen.add(a.name);
    for (const field of ["pending", "console", "sso"] as const) {
      if (a[field] !== undefined && typeof a[field] !== "boolean")
        throw new Error(`Invalid accounts.json ${field}`);
    }
    for (const field of ["email", "plan", "addedAt"] as const) {
      if (a[field] !== undefined && typeof a[field] !== "string")
        throw new Error(`Invalid accounts.json ${field}`);
    }
  }
  if (parsed.default !== undefined) {
    if (typeof parsed.default !== "string")
      throw new Error("Invalid accounts.json default");
    checkName(parsed.default, "accounts.json default", parsed.default);
  }
  if (parsed.failover !== undefined && typeof parsed.failover !== "boolean")
    throw new Error("Invalid accounts.json failover: expected true or false");
  return parsed;
}

/** First UI write preserves the currently declared set, including the implicit legacy default. */
export function accountsForUpdate(): AccountsStore {
  const store = readAccounts();
  if (!existsSync(accountsPath()))
    store.accounts = parseAccountSet().map((name) => ({ name }));
  return store;
}

/** Atomic declaration update; no credential or cached authentication state. */
export function writeAccounts(store: AccountsStore): void {
  mkdirSync(dirname(accountsPath()), { recursive: true });
  const tmp = `${accountsPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, accountsPath());
}

/** A separate Claude Code login and plugin store for Pi-owned turns. Never load ~/.claude. */
export const PI_CLAUDE_CONFIG_DIR = join(packageDataDir(), "claude-config");

/** Reserved name for the existing profile. Every other name is a subdirectory. */
export const DEFAULT_ACCOUNT = "default";

export function checkName(name: string, variable: string, raw: string): void {
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
      `[pi-claude-tether] Invalid account name ${JSON.stringify(name)} in ${variable}=${JSON.stringify(raw)}: ` +
        `names must be non-empty, contain no path separators, and match [A-Za-z0-9._-].`,
    );
  }
}

/**
 * Env declarations first, then file entries. Without the file, an unset or
 * blank env retains the implicit legacy default exactly. Once present, the
 * file owns UI declarations, including an explicitly empty set.
 */
export function parseAccountSet(
  raw: string | undefined = process.env.PI_CLAUDE_TETHER_ACCOUNTS,
): string[] {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const deduped = [
    ...new Set(
      names.length > 0
        ? names
        : existsSync(accountsPath())
          ? []
          : [DEFAULT_ACCOUNT],
    ),
  ];
  for (const name of deduped) {
    checkName(name, "PI_CLAUDE_TETHER_ACCOUNTS", raw ?? "");
  }
  return [
    ...new Set([...deduped, ...readAccounts().accounts.map((a) => a.name)]),
  ];
}

/**
 * Runtime/session choice, then captured launch, stored default, legacy default.
 * A named account must be a member of the declared set; anything else is a
 * configuration error, failed loudly rather than guessed.
 */
export function selectedAccountName(
  set: string[] = parseAccountSet(),
  raw: string | undefined = launchSelection?.account ??
    process.env.PI_CLAUDE_TETHER_ACCOUNT,
): string {
  const choice = sessionSelection || raw?.trim() || readAccounts().default;
  const name = choice || DEFAULT_ACCOUNT;
  if (isAccountPending(name))
    throw new Error(
      `Account ${name} needs /claude-accounts login ${name} before use`,
    );
  if (!choice && !existsSync(accountsPath())) return DEFAULT_ACCOUNT;
  checkName(name, "PI_CLAUDE_TETHER_ACCOUNT", raw ?? "");
  if (!set.includes(name)) {
    throw new Error(
      `[pi-claude-tether] PI_CLAUDE_TETHER_ACCOUNT=${JSON.stringify(name)} is not in ` +
        `PI_CLAUDE_TETHER_ACCOUNTS=${JSON.stringify(set.join(","))}: declare it first.`,
    );
  }
  return name;
}

/**
 * Make `name` the account this Pi process uses from its next provider call.
 *
 * Runtime selection overrides the captured launch environment. Publish the
 * effective selection for child Pi sessions, but never read that publication
 * back as the launch choice. The session custom entry owns restoration.
 * The name must be declared and verified.
 * Warm CLI processes never cross accounts (the account is
 * part of the launch signature), so the next turn spawns on the new one.
 */
/** Restore a session's intent even if it now needs login; never retain a prior session's choice. */
export function restoreAccount(
  name: string,
  set: string[] = parseAccountSet(),
): string {
  captureLaunchAccount();
  sessionSelection = name.trim() || undefined;
  const selected = selectedAccountName(set);
  process.env.PI_CLAUDE_TETHER_ACCOUNT = selected;
  return selected;
}

export function selectAccount(
  name: string,
  set: string[] = parseAccountSet(),
): string {
  const previous = sessionSelection;
  try {
    return restoreAccount(name, set);
  } catch (error) {
    sessionSelection = previous;
    throw error;
  }
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

// Pi's own boolean environment vocabulary (PI_TELEMETRY).
const ENV_ON = new Set(["1", "true", "yes"]);
const ENV_OFF = new Set(["0", "false", "no"]);
let warnedFailoverValue = false;

/**
 * Whether a rejected subscription limit may replay on another account, and
 * which setting decided it.
 *
 * PI_CLAUDE_TETHER_FAILOVER decides for this process when it is 1/true/yes or
 * 0/false/no; any other non-empty value is ignored with a notice. Otherwise
 * the settings file's `failover: true` enables. The file is read on each call, so a change made
 * with /claude-accounts applies from the next turn without restarting Pi.
 */
export function failoverSetting(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  source: "environment" | "accounts" | "default";
} {
  const value = (env.PI_CLAUDE_TETHER_FAILOVER ?? "").trim().toLowerCase();
  if (ENV_ON.has(value)) return { enabled: true, source: "environment" };
  if (ENV_OFF.has(value)) return { enabled: false, source: "environment" };
  if (value !== "" && !warnedFailoverValue) {
    warnedFailoverValue = true;
    addStartupNotice(
      "Ignoring PI_CLAUDE_TETHER_FAILOVER: expected 1, true, yes, 0, false or no. Using /claude-accounts failover instead.",
    );
  }
  if (readAccounts().failover === true)
    return { enabled: true, source: "accounts" };
  return { enabled: false, source: "default" };
}

export function failoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return failoverSetting(env).enabled;
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
export function isAccountPending(name: string): boolean {
  return readAccounts().accounts.some(
    (a) => a.name === name && a.pending === true,
  );
}

export function selectFailoverAccount(
  set: string[],
  exclude?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  attempted?: ReadonlySet<string>,
): string | undefined {
  return set.find(
    (name) =>
      name !== exclude &&
      !isAccountPending(name) &&
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
export function pickInitialAccount(
  set: string[],
  failover: boolean = failoverEnabled(),
): string {
  const pinned = selectedAccountName(set);
  if (!failover) return pinned;
  if (!isAccountExhausted(pinned)) return pinned;
  return selectFailoverAccount(set, pinned) ?? pinned;
}
