import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  accountsPath,
  accountsForUpdate,
  readAccounts,
  writeAccounts,
  parseAccountSet,
  selectAccount,
  restoreAccount,
  selectedAccountName,
  selectFailoverAccount,
  legacyAccountsPath,
  migrateAccountsStore,
  failoverEnabled,
  publishNoClobber,
} from "../src/accounts";
import { takeStartupNotices } from "../src/startup-notices";
import {
  parseAccountArgs,
  observedAccountLimits,
  sessionAccount,
  ACCOUNT_ENTRY_TYPE,
  manageAccount,
  failoverLine,
} from "../src/account-command";
import { packageLedgerDir } from "../src/data-dir";
import { plainCliOutput } from "../src/account-login";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "account-store-"));
  vi.stubEnv("XDG_DATA_HOME", home);
  vi.stubEnv("XDG_STATE_HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "default,b");
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "");
  selectAccount("");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "");
  selectAccount("");
  vi.unstubAllEnvs();
});

describe("account declaration contracts", () => {
  it("keeps missing-file declarations and merges env order then UI order", () => {
    expect(readAccounts()).toEqual({ accounts: [] });
    expect(parseAccountSet()).toEqual(["default", "b"]);
    writeAccounts({
      accounts: [{ name: "c" }, { name: "b" }, { name: "d" }],
      default: "c",
    });
    expect(parseAccountSet()).toEqual(["default", "b", "c", "d"]);
    expect(selectedAccountName()).toBe("c");
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "b");
    expect(selectedAccountName(undefined, "b")).toBe("b");
    selectAccount("c");
    expect(selectedAccountName()).toBe("c");
    expect(
      sessionAccount(
        [
          {
            type: "custom",
            customType: ACCOUNT_ENTRY_TYPE,
            data: { account: "c" },
          },
        ],
        "b",
      ),
    ).toBe("c");
  });
  it("first UI writes materialize existing env declarations before updating one account", () => {
    const store = accountsForUpdate();
    expect(store.accounts.map((a) => a.name)).toEqual(["default", "b"]);
    store.accounts[1] = { name: "b", email: "verified@example.com" };
    writeAccounts(store);
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "");
    expect(parseAccountSet()).toEqual(["default", "b"]);
  });
  it("uses the file as the declaration owner when env is unset, including empty after forced last removal", () => {
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "");
    expect(parseAccountSet()).toEqual(["default"]);
    writeAccounts({ accounts: [{ name: "work" }], default: "work" });
    expect(parseAccountSet()).toEqual(["work"]);
    expect(selectedAccountName()).toBe("work");
    writeAccounts({ accounts: [] });
    expect(parseAccountSet()).toEqual([]);
    expect(() => selectedAccountName()).toThrow(/declare it first/);
  });
  it("applies the same name gate to disk declarations and defaults", () => {
    mkdirSync(dirname(accountsPath()), { recursive: true });
    for (const body of [
      { accounts: [{ name: "../escape" }] },
      { accounts: [], default: "../escape" },
      { accounts: null },
      { accounts: [{ name: "pending", pending: "true" }] },
      {
        accounts: [{ name: "duplicate" }, { name: "duplicate", pending: true }],
      },
      { accounts: [{ name: "bad-email", email: 42 }] },
    ]) {
      writeFileSync(accountsPath(), JSON.stringify(body));
      expect(() => readAccounts()).toThrow();
    }
    rmSync(accountsPath());
  });
  it("pending declarations stay visible but cannot switch, start or fail over", () => {
    writeAccounts({ accounts: [{ name: "pending", pending: true }] });
    expect(parseAccountSet()).toContain("pending");
    expect(() => selectAccount("pending")).toThrow(/needs.*login pending/);
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "pending");
    expect(() => selectedAccountName(undefined, "pending")).toThrow(
      /needs.*login pending/,
    );
    expect(selectFailoverAccount(["pending"])).toBeUndefined();
    selectAccount("b");
    expect(() => restoreAccount("pending")).toThrow(/needs.*login pending/);
    expect(() => selectedAccountName()).toThrow(/needs.*login pending/);
    selectAccount("b");
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "");
  });
  it("strips ANSI and OSC-8 without removing the real URL text", () => {
    expect(
      plainCliOutput(
        "\x1b[31mVisit \x1b]8;;https://example.com\x07https://example.com\x1b]8;;\x07\x1b[0m",
      ),
    ).toBe("Visit https://example.com");
  });
  it("parses exact subcommands and refuses unknown flags", () => {
    expect(parseAccountArgs("add probe --email a@b --sso --console")).toEqual({
      action: "add",
      account: "probe",
      email: "a@b",
      sso: true,
      console: true,
    });
    expect(parseAccountArgs("switch b --default")).toEqual({
      action: "switch",
      account: "b",
      persistent: true,
    });
    expect(parseAccountArgs("login --all")).toEqual({
      action: "login",
      all: true,
    });
    expect(parseAccountArgs("add probe --email")).toEqual({ action: "usage" });
    expect(parseAccountArgs("remove probe --bad")).toEqual({ action: "usage" });
  });
  it("derives per-account last observations including legacy default rows", async () => {
    mkdirSync(packageLedgerDir(), { recursive: true });
    writeFileSync(
      join(packageLedgerDir(), "retire.log"),
      [
        {
          type: "rate_limit",
          at: "2026-11-01T00:00:00Z",
          utilization: 0.5,
          resetsAt: 2000000000,
        },
        {
          type: "rate_limit",
          account: "b",
          at: "2026-11-02T00:00:00Z",
          utilization: 0.75,
          resetsAt: 2000000001,
        },
        {
          type: "rate_limit",
          account: "b",
          at: "2026-11-01T00:00:00Z",
          utilization: 0.1,
        },
        {
          type: "request",
          account: "b",
          at: "2026-11-03T00:00:00Z",
          utilization: 1,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\nbroken\n",
    );
    const rows = await observedAccountLimits();
    expect(rows.get("default")?.utilization).toBe(0.5);
    expect(rows.get("b")?.utilization).toBe(0.75);
    expect(rows.get("b")?.resetsAt).toBe(2000000001);
  });
});

describe("settings file location and failover command", () => {
  const ui = () => ({
    notify: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
  });

  it("lives in Pi's agent directory, not the data directory", () => {
    expect(accountsPath()).toBe(join(home, "agent", "pi-claude-tether.json"));
    expect(legacyAccountsPath()).toBe(
      join(home, "pi-claude-tether", "accounts.json"),
    );
  });

  it("moves a 0.12.0 store once and never reads the old path again", () => {
    takeStartupNotices();
    mkdirSync(dirname(legacyAccountsPath()), { recursive: true });
    writeFileSync(
      legacyAccountsPath(),
      JSON.stringify({ accounts: [{ name: "b" }], default: "b" }),
    );
    migrateAccountsStore();
    expect(existsSync(legacyAccountsPath())).toBe(false);
    expect(readAccounts()).toEqual({ accounts: [{ name: "b" }], default: "b" });
    expect(takeStartupNotices().join("\n")).toMatch(
      /Moved Claude account settings/,
    );
    // A later old file is ignored, named in a notice, and left in place.
    writeFileSync(
      legacyAccountsPath(),
      JSON.stringify({ accounts: [{ name: "x" }] }),
    );
    migrateAccountsStore();
    expect(readAccounts().accounts.map((a) => a.name)).toEqual(["b"]);
    expect(existsSync(legacyAccountsPath())).toBe(true);
    expect(takeStartupNotices().join("\n")).toMatch(/Ignoring old/);
  });

  it("failover on persists, keeps env-declared accounts, and needs no variable afterwards", async () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "");
    expect(parseAccountArgs("failover on")).toEqual({
      action: "failover",
      enabled: true,
    });
    expect(parseAccountArgs("failover")).toEqual({ action: "failover" });
    expect(parseAccountArgs("failover maybe")).toEqual({ action: "usage" });
    const u = ui();
    await manageAccount({ action: "failover", enabled: true }, u as any);
    expect(readAccounts()).toMatchObject({
      accounts: [{ name: "default" }, { name: "b" }],
      failover: true,
    });
    expect(String(u.notify.mock.calls.at(-1)?.[0])).toMatch(/Failover: on/);
    // A fresh process with no PI_CLAUDE_TETHER_* variables sees both and failover.
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "");
    expect(parseAccountSet()).toEqual(["default", "b"]);
    expect(failoverEnabled()).toBe(true);
    await manageAccount({ action: "failover", enabled: false }, u as any);
    expect(failoverEnabled()).toBe(false);
  });

  it("names the environment as the source without echoing its value", async () => {
    writeAccounts({ accounts: [{ name: "default" }], failover: true });
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "No");
    const line = failoverLine();
    expect(line).toMatch(/Failover: off \(set by PI_CLAUDE_TETHER_FAILOVER/);
    expect(line).toMatch(/overriding the settings file's on/);
    expect(line).not.toContain("No)");
    expect(line).not.toMatch(/=No/);
  });
});

describe("review regressions: upgrade steps and no-clobber move", () => {
  it("failover on records env-declared accounts even when the file already exists", async () => {
    writeAccounts({
      accounts: [{ name: "default", email: "kept@example.com" }],
    });
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "default,b");
    await manageAccount({ action: "failover", enabled: true }, {
      notify: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
    } as any);
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "");
    expect(parseAccountSet()).toEqual(["default", "b"]);
    expect(readAccounts().accounts[0]).toEqual({
      name: "default",
      email: "kept@example.com",
    });
  });

  it("never overwrites a destination another process published first", () => {
    const dir = join(home, "nc");
    mkdirSync(dir, { recursive: true });
    const from = join(dir, "old.json");
    const to = join(dir, "new.json");
    writeFileSync(from, "old");
    // Another Pi publishes `to` between our decision and our publication.
    const racing = (source: string, target: string) => {
      writeFileSync(target, "newer");
      linkSync(source, target);
    };
    expect(publishNoClobber(from, to, racing)).toBe(false);
    expect(readFileSync(to, "utf8")).toBe("newer");
    expect(existsSync(from)).toBe(true);
  });

  it("stages across filesystems and still refuses to clobber", () => {
    const dir = join(home, "xdev");
    mkdirSync(dir, { recursive: true });
    const from = join(dir, "old.json");
    const to = join(dir, "new.json");
    writeFileSync(from, "old");
    let calls = 0;
    const crossDevice = (source: string, target: string) => {
      calls++;
      if (source === from)
        throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      linkSync(source, target);
    };
    expect(publishNoClobber(from, to, crossDevice)).toBe(true);
    expect(readFileSync(to, "utf8")).toBe("old");
    expect(calls).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["new.json", "old.json"]);
    writeFileSync(from, "again");
    expect(publishNoClobber(from, to, crossDevice)).toBe(false);
    expect(readFileSync(to, "utf8")).toBe("old");
    expect(readdirSync(dir).sort()).toEqual(["new.json", "old.json"]);
  });
});

it("without hard links, keeps the old file and never exposes a partial one", () => {
  const dir = join(home, "nolink");
  mkdirSync(dir, { recursive: true });
  const from = join(dir, "old.json");
  const to = join(dir, "new.json");
  writeFileSync(from, "old");
  const noLinks = () => {
    throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
  };
  expect(publishNoClobber(from, to, noLinks)).toBe("unsupported");
  expect(existsSync(to)).toBe(false);
  expect(readdirSync(dir)).toEqual(["old.json"]);
});
