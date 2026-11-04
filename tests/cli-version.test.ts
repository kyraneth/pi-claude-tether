import { describe, it, expect } from "vitest";
import {
  formatCliStatus,
  npmLatestCliVersion,
  type NpmView,
} from "../src/cli-version";
import { TESTED_CLI_MAX } from "../src/context-policy";

describe("formatCliStatus", () => {
  it("reports installed, tested range and npm latest", () => {
    const text = formatCliStatus(
      { version: TESTED_CLI_MAX, path: "/private/bin/claude" },
      "2.1.310",
    );
    expect(text).toContain(`installed: ${TESTED_CLI_MAX}`);
    expect(text).toContain("tested range:");
    expect(text).toContain(TESTED_CLI_MAX);
    expect(text).toContain("npm latest: 2.1.310");
    expect(text).toContain("scripts/update-cli.sh");
    expect(text).toContain("update-cli.sh --version");
    expect(text).toContain("the package CLI dir");
    expect(text).not.toContain("newer than tested");
  });

  it("flags a newer-than-tested install without refusing it", () => {
    const text = formatCliStatus(
      { version: "9.9.9", path: undefined },
      "9.9.9",
    );
    expect(text).toContain("newer than tested");
  });

  it("reports unknown instead of throwing", () => {
    const text = formatCliStatus(
      { error: "Claude Code CLI not found" },
      undefined,
    );
    expect(text).toContain("installed: unknown");
    expect(text).toContain("npm latest: unknown");
  });
});

describe("npmLatestCliVersion", () => {
  const view =
    (stdout: string): NpmView =>
    async () => ({ stdout });

  it("returns the published version", async () => {
    expect(await npmLatestCliVersion(undefined, view("2.1.310\n"))).toBe(
      "2.1.310",
    );
  });

  it("returns undefined on lookup failure, garbage or absence", async () => {
    const failing: NpmView = async () => {
      throw new Error("offline");
    };
    expect(await npmLatestCliVersion(undefined, failing)).toBeUndefined();
    expect(
      await npmLatestCliVersion(undefined, view("nope\n")),
    ).toBeUndefined();
    expect(await npmLatestCliVersion(undefined, view(""))).toBeUndefined();
  });

  it("asks npm for exactly the CLI package version", async () => {
    let seen: [string, string[]] | undefined;
    const recording: NpmView = async (cmd, args) => {
      seen = [cmd, args];
      return { stdout: "2.1.310\n" };
    };
    await npmLatestCliVersion(undefined, recording);
    expect(seen).toEqual([
      "npm",
      ["view", "@anthropic-ai/claude-code", "version"],
    ]);
  });
});
