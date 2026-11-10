import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ACCOUNT_ENTRY_TYPE,
  parseAccountArgs,
  sessionAccount,
} from "../src/account-command";
import { selectAccount, selectedAccountName } from "../src/accounts";

beforeEach(() => {
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "default,b");
  vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNT", "");
  selectAccount("");
});
afterEach(() => vi.unstubAllEnvs());

const switched = (account: unknown) => ({
  type: "custom",
  customType: ACCOUNT_ENTRY_TYPE,
  data: { account },
});

describe("parseAccountArgs", () => {
  it("lists by default and on `list`", () => {
    expect(parseAccountArgs("")).toEqual({ action: "list" });
    expect(parseAccountArgs("  list ")).toEqual({ action: "list" });
  });
  it("switches to one named account", () => {
    expect(parseAccountArgs("switch b")).toEqual({
      action: "switch",
      account: "b",
    });
  });
  it("shows usage for anything else", () => {
    expect(parseAccountArgs("switch")).toEqual({ action: "usage" });
    expect(parseAccountArgs("b")).toEqual({ action: "usage" });
    expect(parseAccountArgs("switch b c")).toEqual({ action: "usage" });
  });
});

describe("selectAccount", () => {
  it("makes the next provider call use the named account", () => {
    expect(selectAccount("b")).toBe("b");
    expect(process.env.PI_CLAUDE_TETHER_ACCOUNT).toBe("b");
    expect(selectedAccountName()).toBe("b");
  });
  it("refuses an undeclared account and leaves the selection unchanged", () => {
    selectAccount("b");
    expect(() => selectAccount("c")).toThrow(
      /not in PI_CLAUDE_TETHER_ACCOUNTS/,
    );
    expect(selectedAccountName()).toBe("b");
  });
  it("an empty name restores the unset launch state exactly", () => {
    selectAccount("b");
    selectAccount("");
    expect(process.env.PI_CLAUDE_TETHER_ACCOUNT).toBe("default");
    expect(selectedAccountName()).toBe("default");
  });
});

describe("sessionAccount", () => {
  it("resumes on the session's last recorded switch", () => {
    const branch = [switched("b"), { type: "message" }, switched("default")];
    expect(sessionAccount(branch, "")).toBe("default");
    expect(sessionAccount(branch.slice(0, 2), "")).toBe("b");
  });
  it("uses the launch account when the session never switched", () => {
    expect(sessionAccount([{ type: "message" }], "b")).toBe("b");
    expect(sessionAccount([], "")).toBe("");
  });
  it("falls back to the launch account when the recorded one is gone", () => {
    vi.stubEnv("PI_CLAUDE_TETHER_ACCOUNTS", "default");
    expect(sessionAccount([switched("b")], "")).toBe("");
  });
});
