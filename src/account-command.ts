import { existsSync, mkdirSync, rmSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  DEFAULT_ACCOUNT,
  accountConfigDir,
  accountResetTimes,
  parseAccountSet,
  selectedAccountName,
  checkName,
  readAccounts,
  writeAccounts,
  isAccountPending,
  accountsForUpdate,
  failoverSetting,
  accountsPath,
} from "./accounts.js";
import {
  cliAuthStatus,
  installedCliVersion,
  resolveCliPath,
} from "./process-manager.js";
import {
  MIN_CONTEXT_CLI_VERSION,
  TESTED_CLI_MAX,
  compareCliVersions,
} from "./context-policy.js";
import { packageLedgerDir } from "./data-dir.js";
import { accountAuth, type AccountUI } from "./account-login.js";

export const ACCOUNT_ENTRY_TYPE = "pi-claude-tether.account";
export const ACCOUNT_USAGE =
  "Usage: /claude-accounts [list|ls] | add <name> [--email e] [--sso] [--console] | login <name>|--all | status [name] | switch <name> [--session|--default] | remove <name> [--revoke] [--purge] [--force] | failover [on|off] | doctor";

export function sessionAccount(
  branch: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
  launchAccount: string,
  set: string[] = parseAccountSet(),
): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "custom" || entry.customType !== ACCOUNT_ENTRY_TYPE)
      continue;
    const account = (entry.data as { account?: unknown } | undefined)?.account;
    if (typeof account === "string" && set.includes(account)) return account;
    break;
  }
  return launchAccount || readAccounts().default || "";
}

/** Derive observations from the existing ledger; no duplicate usage store. */
export async function observedAccountLimits(
  signal?: AbortSignal,
): Promise<
  Map<string, { at: string; utilization?: number; resetsAt?: number }>
> {
  const rows = new Map<
    string,
    { at: string; utilization?: number; resetsAt?: number }
  >();
  const path = join(packageLedgerDir(), "retire.log");
  if (!existsSync(path)) return rows;
  const input = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.type !== "rate_limit" || typeof row.at !== "string") continue;
        const name =
          typeof row.account === "string" ? row.account : DEFAULT_ACCOUNT;
        const old = rows.get(name);
        if (old && Date.parse(old.at) > Date.parse(row.at)) continue;
        rows.set(name, {
          at: row.at,
          utilization:
            typeof row.utilization === "number" ? row.utilization : undefined,
          resetsAt: typeof row.resetsAt === "number" ? row.resetsAt : undefined,
        });
      } catch {
        /* incomplete legacy/diagnostic rows are not observations */
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return rows;
}

export async function accountsReport(
  signal?: AbortSignal,
  only?: string,
  doctor = false,
): Promise<string> {
  const set = parseAccountSet();
  if (only && !set.includes(only))
    throw new Error(`Account ${only} is not declared`);
  let selected: string | undefined;
  let selectionError: string | undefined;
  try {
    selected = selectedAccountName(set);
  } catch (error) {
    selectionError = error instanceof Error ? error.message : String(error);
  }
  const limits = await observedAccountLimits(signal);
  const resets = new Map(
    accountResetTimes(set).map((r) => [r.account, r.resetsAt]),
  );
  const lines = ["Claude accounts (* = this session):", failoverLine()];
  if (selectionError) lines.push(`Selection unavailable: ${selectionError}`);
  if (!set.length)
    lines.push("No accounts declared. Use /claude-accounts add <name>.");
  if (doctor) {
    try {
      const version = await installedCliVersion(signal);
      const tested =
        compareCliVersions(version, MIN_CONTEXT_CLI_VERSION) >= 0 &&
        compareCliVersions(version, TESTED_CLI_MAX) <= 0;
      lines.push(
        `CLI ${resolveCliPath()} version ${version}; tested ${MIN_CONTEXT_CLI_VERSION}–${TESTED_CLI_MAX}: ${tested ? "in tested range" : "outside tested range"}`,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      lines.push(
        `CLI ${resolveCliPath() ?? "not found"}; version probe failed; tested ${MIN_CONTEXT_CLI_VERSION}–${TESTED_CLI_MAX}`,
      );
    }
  }
  for (const name of only ? [only] : set) {
    const dir = accountConfigDir(name);
    const status = await cliAuthStatus(dir, signal);
    if (signal?.aborted) throw new Error("Account status cancelled");
    const auth = isAccountPending(name)
      ? `pending; needs /claude-accounts login ${name}`
      : status === undefined
        ? "login unknown (auth status parse failed)"
        : status.loggedIn
          ? `ready: ${status.email ?? "logged in"}${status.subscriptionType ? ` (${status.subscriptionType})` : ""}`
          : "not logged in";
    lines.push(
      `${name === selected ? "*" : " "} ${name}  ${auth}`,
      `  configDirectory: ${status?.configDirectory ?? dir}${status?.configDirectory ? " (CLI reported)" : " (requested; not reported by CLI)"}`,
    );
    if (status?.authMethod)
      lines.push(
        `  authMethod: ${status.authMethod}${status.orgName ? `; org: ${status.orgName}` : ""}`,
      );
    const reset = resets.get(name);
    if (reset && reset > Date.now() / 1000)
      lines.push(`  exhausted until ${new Date(reset * 1000).toISOString()}`);
    const observed = limits.get(name);
    lines.push(
      observed
        ? `  last observed utilization: ${observed.utilization === undefined ? "unknown" : `${observed.utilization * 100}%`}; resetsAt: ${observed.resetsAt ?? "unknown"}; seen ${Math.max(0, (Date.now() - Date.parse(observed.at)) / 1000)} s ago (${observed.at}); not live usage`
        : "  last observed utilization: unknown (no ledger observation; not live usage)",
    );
    if (doctor)
      lines.push(
        `  directory: ${existsSync(dir) ? "present" : "missing"}; .credentials.json presence only: ${existsSync(join(dir, ".credentials.json")) ? "present" : "absent"}; auth status parse: ${status ? "healthy" : "failed"}`,
      );
  }
  return lines.join("\n");
}

/** Failover state and the setting that decided it. */
export function failoverLine(): string {
  const { enabled, source } = failoverSetting();
  const file = readAccounts().failover;
  if (source === "environment")
    return `Failover: ${enabled ? "on" : "off"} (set by PI_CLAUDE_TETHER_FAILOVER in this Pi's environment${file === undefined ? "" : `, overriding the settings file's ${file ? "on" : "off"}`}; unset it and start Pi from a new shell to use /claude-accounts failover)`;
  if (source === "accounts") return `Failover: on (${accountsPath()})`;
  return "Failover: off (enable with /claude-accounts failover on)";
}

type Parsed =
  | { action: "list" | "doctor" | "usage" }
  | { action: "failover"; enabled?: boolean }
  | { action: "status"; account?: string }
  | { action: "switch"; account: string; persistent?: true }
  | {
      action: "add";
      account: string;
      email?: string;
      sso?: boolean;
      console?: boolean;
    }
  | { action: "login"; account: string }
  | { action: "login"; all: true }
  | {
      action: "remove";
      account: string;
      revoke: boolean;
      purge: boolean;
      force: boolean;
    };
export function parseAccountArgs(args: string): Parsed {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const action = words.shift() ?? "list";
  if (["list", "ls", "doctor"].includes(action) && !words.length)
    return { action: action === "doctor" ? "doctor" : "list" };
  if (action === "failover" && words.length <= 1) {
    if (!words.length) return { action };
    if (words[0] === "on" || words[0] === "off")
      return { action, enabled: words[0] === "on" };
    return { action: "usage" };
  }
  if (action === "status" && words.length <= 1 && !words[0]?.startsWith("--"))
    return { action, ...(words[0] ? { account: words[0] } : {}) };
  const account = words.shift();
  if (!account) return { action: "usage" };
  if (action === "login" && !words.length)
    return account === "--all" ? { action, all: true } : { action, account };
  if (account.startsWith("--")) return { action: "usage" };
  if (
    action === "switch" &&
    (!words.length ||
      (words.length === 1 && ["--session", "--default"].includes(words[0]!)))
  )
    return {
      action,
      account,
      ...(words[0] === "--default" ? { persistent: true as const } : {}),
    };
  if (
    action === "remove" &&
    words.every((w) => ["--revoke", "--purge", "--force"].includes(w))
  )
    return {
      action,
      account,
      revoke: words.includes("--revoke"),
      purge: words.includes("--purge"),
      force: words.includes("--force"),
    };
  if (action === "add") {
    const result: Extract<Parsed, { action: "add" }> = { action, account };
    while (words.length) {
      const flag = words.shift();
      if (flag === "--email" && words[0] && !words[0].startsWith("--"))
        result.email = words.shift();
      else if (flag === "--sso") result.sso = true;
      else if (flag === "--console") result.console = true;
      else return { action: "usage" };
    }
    return result;
  }
  return { action: "usage" };
}

/** Non-switch mutations; selection/session entries stay with index.ts. */
export async function manageAccount(
  parsed: Exclude<Parsed, { action: "switch" }>,
  ui: AccountUI,
  signal?: AbortSignal,
  beforeChange?: () => Promise<void>,
): Promise<void> {
  if (parsed.action === "usage") {
    ui.notify(ACCOUNT_USAGE, "warning");
    return;
  }
  if (
    parsed.action === "list" ||
    parsed.action === "doctor" ||
    parsed.action === "status"
  ) {
    ui.notify(
      await accountsReport(
        signal,
        parsed.action === "status" ? parsed.account : undefined,
        parsed.action === "doctor",
      ),
      "info",
    );
    return;
  }
  if (parsed.action === "failover") {
    if (parsed.enabled !== undefined) {
      const store = accountsForUpdate();
      // Record every currently declared account (including env-declared
      // ones) so dropping the shell exports afterwards loses nothing.
      for (const name of parseAccountSet())
        if (!store.accounts.some((a) => a.name === name))
          store.accounts.push({ name });
      store.failover = parsed.enabled;
      writeAccounts(store);
    }
    ui.notify(failoverLine(), "info");
    return;
  }
  if (parsed.action === "login" && "all" in parsed) {
    for (const account of parseAccountSet()) {
      const status = await cliAuthStatus(accountConfigDir(account), signal);
      if (!status?.loggedIn || isAccountPending(account))
        await manageAccount(
          { action: "login", account },
          ui,
          signal,
          beforeChange,
        );
    }
    return;
  }
  if (!("account" in parsed)) return;
  const name = parsed.account;
  checkName(name, "command", name);
  const set = parseAccountSet();
  const store = accountsForUpdate();
  const dir = accountConfigDir(name);
  if (parsed.action === "remove") {
    if (!set.includes(name)) throw new Error(`Account ${name} is not declared`);
    let active: string | undefined;
    try {
      active = selectedAccountName(set);
    } catch {
      /* invalid selection has no active account */
    }
    if (!parsed.force && (name === active || set.length === 1))
      throw new Error(
        "Refusing to remove active or last account without --force",
      );
    if (
      (process.env.PI_CLAUDE_TETHER_ACCOUNTS ?? "")
        .split(",")
        .map((n) => n.trim())
        .includes(name)
    )
      throw new Error(
        `Account ${name} is declared by PI_CLAUDE_TETHER_ACCOUNTS; remove it from the launch environment first`,
      );
    if (
      parsed.purge &&
      !(await ui.confirm(
        "Purge Claude account directory?",
        `${dir}\nThis deletes the CLI-owned login and data.`,
      ))
    )
      return;
    await beforeChange?.();
    if (parsed.revoke) await accountAuth(dir, "logout", ui, {}, signal);
    if (signal?.aborted) throw new Error("Account removal cancelled");
    if (parsed.purge) rmSync(dir, { recursive: true, force: true });
    const current = accountsForUpdate();
    current.accounts = current.accounts.filter((a) => a.name !== name);
    if (current.default === name) delete current.default;
    writeAccounts(current);
    ui.notify(
      `Unregistered ${name}; directory ${parsed.purge ? "purged" : "kept"}`,
      "info",
    );
    return;
  }
  if (parsed.action === "add" && name === DEFAULT_ACCOUNT)
    throw new Error(
      "default is the reserved existing profile; declare it and use /claude-accounts login default",
    );
  if (parsed.action === "add" && set.includes(name))
    throw new Error(`Account ${name} already declared; use login ${name}`);
  if (parsed.action === "login" && !set.includes(name))
    throw new Error(`Account ${name} is not declared`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (
    parsed.action === "add" &&
    parsed.email &&
    store.accounts.some((a) => a.email === parsed.email)
  )
    ui.notify("This email is already declared on another account", "warning");
  // Register the intent before login so a failed/cancelled attempt can be retried
  // or removed through this same UI. Authentication is never claimed here.
  if (parsed.action === "add") {
    store.accounts.push({
      name,
      pending: true,
      console: parsed.console,
      sso: parsed.sso,
      addedAt: new Date().toISOString(),
    });
    writeAccounts(store);
  }
  await beforeChange?.();
  const declaration = store.accounts.find((a) => a.name === name);
  await accountAuth(
    dir,
    "login",
    ui,
    parsed.action === "add"
      ? parsed
      : {
          email: declaration?.email,
          console: declaration?.console,
          sso: declaration?.sso,
        },
    signal,
  );
  const status = await cliAuthStatus(dir, signal);
  if (signal?.aborted) throw new Error("Account authentication cancelled");
  if (!status?.loggedIn)
    throw new Error(
      "CLI login completed but auth status did not verify loggedIn=true",
    );
  const current = accountsForUpdate();
  const verified = {
    name,
    console: parsed.action === "add" ? parsed.console : declaration?.console,
    sso: parsed.action === "add" ? parsed.sso : declaration?.sso,
    email: status.email,
    plan: status.subscriptionType ?? undefined,
    addedAt:
      store.accounts.find((a) => a.name === name)?.addedAt ??
      new Date().toISOString(),
  };
  const index = current.accounts.findIndex((a) => a.name === name);
  if (index === -1) current.accounts.push(verified);
  else current.accounts[index] = verified;
  writeAccounts(current);
  ui.notify(await accountsReport(signal, name), "info");
}
