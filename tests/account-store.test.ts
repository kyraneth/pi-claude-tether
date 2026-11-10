import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../src/accounts";
import {
  parseAccountArgs,
  observedAccountLimits,
  sessionAccount,
  ACCOUNT_ENTRY_TYPE,
} from "../src/account-command";
import { packageLedgerDir } from "../src/data-dir";
import { plainCliOutput } from "../src/account-login";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "account-store-"));
  vi.stubEnv("XDG_DATA_HOME", home);
  vi.stubEnv("XDG_STATE_HOME", home);
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
    mkdirSync(join(home, "pi-claude-tether"), { recursive: true });
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
