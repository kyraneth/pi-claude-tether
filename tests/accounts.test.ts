import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageDataDir } from "../src/data-dir";
import {
  PI_CLAUDE_CONFIG_DIR,
  parseAccountSet,
  selectedAccountName,
  failoverEnabled,
  accountConfigDir,
  isSingleDefaultAccountSet,
  isAccountExhausted,
  markAccountExhausted,
  selectFailoverAccount,
  pickInitialAccount,
  accountResetTimes,
} from "../src/accounts";

const FUTURE_RESETSAT = 1893456000; // 2030-01-01T00:00:00Z, fixed test data

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pcc-accounts-"));
  vi.stubEnv("PI_CLAUDE_TETHER_STATE_DIR", stateDir);
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "");
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "");
  vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("parseAccountSet", () => {
  it("is just the default profile when unset", () => {
    expect(parseAccountSet("")).toEqual(["default"]);
    expect(parseAccountSet(undefined)).toEqual(["default"]);
  });

  it("parses an ordered set with whitespace and blanks", () => {
    expect(parseAccountSet("default,b")).toEqual(["default", "b"]);
    expect(parseAccountSet(" b , default ,,")).toEqual(["b", "default"]);
  });

  it("dedupes while keeping first position", () => {
    expect(parseAccountSet("b,default,b")).toEqual(["b", "default"]);
  });

  it("rejects path separators and dot segments", () => {
    for (const bad of ["a/b", "../x", "..", ".", "a\\b", "a b", ""]) {
      if (bad === "") continue; // blank entries are skipped, not names
      expect(() => parseAccountSet(`default,${bad}`)).toThrow(
        /PI_CLAUDE_TETHER_ACCOUNTS/,
      );
    }
  });
});

describe("selectedAccountName", () => {
  it("is the default profile when unset", () => {
    expect(selectedAccountName(["default", "b"])).toBe("default");
  });

  it("picks a declared account", () => {
    expect(selectedAccountName(["default", "b"], "b")).toBe("b");
  });

  it("fails loudly for an undeclared account instead of guessing", () => {
    expect(() => selectedAccountName(["default", "b"], "c")).toThrow(
      /PI_CLAUDE_TETHER_ACCOUNT.*not in.*PI_CLAUDE_TETHER_ACCOUNTS/,
    );
  });

  it("fails loudly for an invalid name", () => {
    expect(() => selectedAccountName(["default"], "a/b")).toThrow(
      /PI_CLAUDE_TETHER_ACCOUNT/,
    );
  });
});

describe("failoverEnabled", () => {
  it("is off unless explicitly opted in", () => {
    expect(failoverEnabled()).toBe(false);
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "0");
    expect(failoverEnabled()).toBe(false);
  });

  it('is on for exactly "1"', () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    expect(failoverEnabled()).toBe(true);
  });

  it("rejects broader truthy spellings", () => {
    for (const value of ["true", "yes", "TRUE", "on", " 1", "1 "]) {
      vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", value);
      expect(failoverEnabled()).toBe(false);
    }
  });
});

describe("isSingleDefaultAccountSet", () => {
  it("is true only for the untouched legacy shape", () => {
    expect(isSingleDefaultAccountSet(["default"])).toBe(true);
    expect(isSingleDefaultAccountSet(["b"])).toBe(false);
    expect(isSingleDefaultAccountSet(["default", "b"])).toBe(false);
    expect(isSingleDefaultAccountSet([])).toBe(false);
  });
});

describe("accountConfigDir", () => {
  it("maps default to the existing profile (no re-login)", () => {
    // Package-derived: the legacy package name uses its fallback directory;
    // pi-claude-tether uses its own directory. No literal path is needed here.
    expect(accountConfigDir("default")).toBe(PI_CLAUDE_CONFIG_DIR);
    expect(PI_CLAUDE_CONFIG_DIR).toBe(join(packageDataDir(), "claude-config"));
  });

  it("maps other names under accounts/", () => {
    expect(accountConfigDir("b")).toBe(
      join(packageDataDir(), "accounts", "b", "claude-config"),
    );
  });
});

describe("exhaustion state", () => {
  it("is not exhausted with no record", () => {
    expect(isAccountExhausted("default")).toBe(false);
  });

  it("marks and observes a future resetsAt", () => {
    markAccountExhausted("default", FUTURE_RESETSAT);
    const raw = JSON.parse(
      readFileSync(join(stateDir, "account-exhausted-default.json"), "utf8"),
    );
    expect(raw).toMatchObject({
      account: "default",
      resetsAt: FUTURE_RESETSAT,
    });
    expect(isAccountExhausted("default")).toBe(true);
  });

  it("expires once now passes resetsAt", () => {
    markAccountExhausted("default", FUTURE_RESETSAT);
    expect(isAccountExhausted("default")).toBe(true);
    expect(isAccountExhausted("default", FUTURE_RESETSAT + 1)).toBe(false);
  });

  it("treats corrupt or resetsAt-less files as not exhausted", () => {
    writeFileSync(join(stateDir, "account-exhausted-default.json"), "not json");
    expect(isAccountExhausted("default")).toBe(false);
    writeFileSync(
      join(stateDir, "account-exhausted-default.json"),
      JSON.stringify({ account: "default" }),
    );
    expect(isAccountExhausted("default")).toBe(false);
  });

  it("reports reset times per account, unknown when unrecorded", () => {
    markAccountExhausted("b", FUTURE_RESETSAT);
    expect(accountResetTimes(["default", "b"])).toEqual([
      { account: "default", resetsAt: null },
      { account: "b", resetsAt: FUTURE_RESETSAT },
    ]);
  });
});

describe("selectFailoverAccount", () => {
  it("takes the first fresh account in set order", () => {
    expect(selectFailoverAccount(["default", "b"])).toBe("default");
  });

  it("skips exhausted accounts and the just-failed one", () => {
    markAccountExhausted("default", FUTURE_RESETSAT);
    expect(selectFailoverAccount(["default", "b"], "b")).toBe(undefined);
    expect(selectFailoverAccount(["default", "b"], "default")).toBe("b");
  });

  it("is undefined when every account is exhausted", () => {
    markAccountExhausted("default", FUTURE_RESETSAT);
    markAccountExhausted("b", FUTURE_RESETSAT);
    expect(selectFailoverAccount(["default", "b"])).toBe(undefined);
  });

  it("never re-selects an account already tried in this provider call", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      selectFailoverAccount(["default", "b"], undefined, now, new Set()),
    ).toBe("default");
    expect(
      selectFailoverAccount(
        ["default", "b"],
        undefined,
        now,
        new Set(["default"]),
      ),
    ).toBe("b");
    // Fresh by the files, already tried in memory: still not re-selected.
    expect(
      selectFailoverAccount(
        ["default", "b"],
        undefined,
        now,
        new Set(["default", "b"]),
      ),
    ).toBe(undefined);
  });
});

describe("pickInitialAccount", () => {
  it("pins the manual selection", () => {
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "b");
    expect(pickInitialAccount(["default", "b"])).toBe("b");
  });

  it("defaults to the existing profile", () => {
    expect(pickInitialAccount(["default", "b"])).toBe("default");
  });

  it("with failover on, skips a still-exhausted pin for the first fresh account", () => {
    vi.stubEnv("PI_CLAUDE_TETHER_FAILOVER", "1");
    markAccountExhausted("default", FUTURE_RESETSAT);
    expect(pickInitialAccount(["default", "b"])).toBe("b");
  });

  it("with failover off, ignores exhaustion and pins as configured", () => {
    markAccountExhausted("default", FUTURE_RESETSAT);
    expect(pickInitialAccount(["default", "b"])).toBe("default");
  });
});
