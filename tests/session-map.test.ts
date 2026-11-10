import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stateDir, assertNoLegacySession } from "../src/session-map";

describe("read-only legacy session guard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tether-map-"));
    vi.stubEnv("PI_CLAUDE_TETHER_STATE_DIR", dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the shared state home without creating legacy state", () => {
    expect(stateDir()).toBe(dir);
    expect(() => assertNoLegacySession("new-pi")).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
    vi.stubEnv("PI_CLAUDE_TETHER_STATE_DIR", join(dir, "absent"));
    expect(() => assertNoLegacySession("new-pi")).not.toThrow();
    expect(existsSync(join(dir, "absent"))).toBe(false);
  });

  it.each(["cli-old", { cli: "cli-old", account: "other" }, null, ""])(
    "rejects any current Pi mapping unchanged: %j",
    (mapping) => {
      const path = join(dir, "session-map.json");
      const original = JSON.stringify({
        "pi-current": mapping,
        other: "cli-other",
      });
      writeFileSync(path, original);
      expect(() => assertNoLegacySession("pi-current")).toThrow(
        /fresh Pi session/,
      );
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(dir)).toEqual(["session-map.json"]);
    },
  );

  it("does not reject or modify another Pi session's mapping", () => {
    const path = join(dir, "session-map.json");
    const original = JSON.stringify({ other: "cli-other" });
    writeFileSync(path, original);
    expect(() => assertNoLegacySession("pi-current")).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("rejects an orphaned saved prompt keyed by the current Pi id, unchanged", () => {
    mkdirSync(join(dir, "sysprompt"));
    const path = join(dir, "sysprompt", "pi-current.txt");
    writeFileSync(path, "old prompt");
    expect(() => assertNoLegacySession("pi-current")).toThrow(/sysprompt/);
    expect(readFileSync(path, "utf8")).toBe("old prompt");
    expect(() => assertNoLegacySession("other")).not.toThrow();
  });

  it("reports corrupt JSON clearly instead of repairing or ignoring it", () => {
    const path = join(dir, "session-map.json");
    writeFileSync(path, "{not json");
    expect(() => assertNoLegacySession("pi-current")).toThrow(
      /Cannot validate.*session-map/,
    );
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it.each([null, [], "not a map", 42, false])(
    "rejects invalid sidecar shapes unchanged: %j",
    (value) => {
      const path = join(dir, "session-map.json");
      const original = JSON.stringify(value);
      writeFileSync(path, original);
      expect(() => assertNoLegacySession("pi-current")).toThrow(
        /Cannot validate.*session-map/,
      );
      expect(readFileSync(path, "utf8")).toBe(original);
    },
  );

  it("reports unreadable map state instead of treating it as absent", () => {
    mkdirSync(join(dir, "session-map.json"));
    expect(() => assertNoLegacySession("pi-current")).toThrow(
      /Cannot validate.*session-map/,
    );
    expect(readdirSync(join(dir, "session-map.json"))).toEqual([]);
  });
});
