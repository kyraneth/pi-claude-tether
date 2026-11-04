/**
 * On-disk directories are derived from the package.json name, including the
 * legacy fallback for unrecognized names.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findPackageName,
  isPublicPackageName,
  ownPackageName,
  packageCliBinDir,
  packageDataDir,
  packageLeaf,
  packageLedgerDir,
  packageStateDir,
} from "../src/data-dir";

const LEGACY_DATA = join(
  homedir(),
  ".local",
  "share",
  "pi-claude-cli",
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("package name routing", () => {
  it("recognizes only the public package name", () => {
    expect(isPublicPackageName("pi-claude-tether")).toBe(true);
    expect(isPublicPackageName("@legacy/pi-claude-cli")).toBe(false);
    expect(isPublicPackageName("pi-claude-cli")).toBe(false);
    expect(isPublicPackageName(undefined)).toBe(false);
  });

  it("reads its own tree's package name", () => {
    // Whichever tree runs this suite, the module resolves that tree's manifest.
    expect(ownPackageName()).toMatch(/pi-claude/);
  });

  it("keeps legacy and unknown package names on the legacy layout", () => {
    expect(packageDataDir("@legacy/pi-claude-cli")).toBe(LEGACY_DATA);
    expect(packageDataDir("something-else")).toBe(LEGACY_DATA);
    expect(packageLeaf("@legacy/pi-claude-cli")).toBe("pi-claude-cli");
    expect(packageLeaf("something-else")).toBe("pi-claude-cli");
  });

  it("defaults omitted or undefined names to this package's own identity", () => {
    const publicPackage = isPublicPackageName(ownPackageName());
    const expectedData = publicPackage
      ? join(
          process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
          "pi-claude-tether",
        )
      : LEGACY_DATA;
    const expectedLeaf = publicPackage ? "pi-claude-tether" : "pi-claude-cli";
    expect(packageDataDir()).toBe(expectedData);
    expect(packageDataDir(undefined)).toBe(expectedData);
    expect(packageLeaf()).toBe(expectedLeaf);
    expect(packageLeaf(undefined)).toBe(expectedLeaf);
  });
});

describe("deep layouts", () => {
  it("walks past five levels to the filesystem root", () => {
    // A manifest seven levels above the start dir: the old `i < 5` bound
    // returned undefined here and fell back to the legacy layout.
    const root = mkdtempSync(join(tmpdir(), "pcc-deep-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "pi-claude-tether" }),
    );
    const deep = join(root, "a", "b", "c", "d", "e", "f", "g");
    mkdirSync(deep, { recursive: true });
    expect(findPackageName(deep)).toBe("pi-claude-tether");
    expect(packageDataDir(findPackageName(deep))).toBe(
      join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "pi-claude-tether",
      ),
    );
  });

  it("returns undefined when no manifest exists", () => {
    const root = mkdtempSync(join(tmpdir(), "pcc-nomanifest-"));
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(findPackageName(deep)).toBe(undefined);
  });

  it("skips unreadable manifests and keeps walking", () => {
    const root = mkdtempSync(join(tmpdir(), "pcc-badjson-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "pi-claude-tether" }),
    );
    const mid = join(root, "a", "b");
    mkdirSync(mid, { recursive: true });
    writeFileSync(join(mid, "package.json"), "{ not json");
    expect(findPackageName(join(mid, "c"))).toBe("pi-claude-tether");
  });
});

describe("generic legacy layout", () => {
  it("uses generic legacy data, cli, state and ledger paths", () => {
    vi.stubEnv("XDG_DATA_HOME", "/tmp/should-not-apply");
    vi.stubEnv("PI_CLAUDE_CLI_STATE_DIR", "");
    // XDG_DATA_HOME must not move the legacy layout.
    expect(packageDataDir("@legacy/pi-claude-cli")).toBe(LEGACY_DATA);
    expect(packageCliBinDir("@legacy/pi-claude-cli")).toBe(
      join(LEGACY_DATA, "cli", "node_modules", ".bin"),
    );
    expect(packageStateDir("@legacy/pi-claude-cli")).toBe(
      join(homedir(), ".pi", "agent", "pi-claude-cli"),
    );
    expect(packageLedgerDir("@legacy/pi-claude-cli")).toBe(
      join(
        process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
        "pi-claude-cli",
      ),
    );
  });

  it("honors PI_CLAUDE_CLI_STATE_DIR first", () => {
    vi.stubEnv("PI_CLAUDE_CLI_STATE_DIR", "/tmp/custom-state");
    expect(packageStateDir("@legacy/pi-claude-cli")).toBe("/tmp/custom-state");
  });
});

describe("public layout", () => {
  it("uses XDG_DATA_HOME with a home fallback", () => {
    vi.stubEnv("XDG_DATA_HOME", "/tmp/custom-data");
    expect(packageDataDir("pi-claude-tether")).toBe(
      "/tmp/custom-data/pi-claude-tether",
    );
    expect(packageCliBinDir("pi-claude-tether")).toBe(
      "/tmp/custom-data/pi-claude-tether/cli/node_modules/.bin",
    );
    expect(packageLeaf("pi-claude-tether")).toBe("pi-claude-tether");
    expect(packageStateDir("pi-claude-tether")).toBe(
      join(homedir(), ".pi", "agent", "pi-claude-tether"),
    );
    expect(packageLedgerDir("pi-claude-tether")).toBe(
      join(
        process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
        "pi-claude-tether",
      ),
    );
    vi.stubEnv("XDG_DATA_HOME", "");
    expect(packageDataDir("pi-claude-tether")).toBe(
      join(homedir(), ".local", "share", "pi-claude-tether"),
    );
  });
});
