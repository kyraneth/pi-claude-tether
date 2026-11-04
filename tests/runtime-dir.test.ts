import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupRuntimeDir, runtimeDir } from "../src/runtime-dir";
import {
  cleanupMcpConfigFiles,
  resetMcpConfigCache,
  writeMcpConfig,
  writeSchemaFile,
  writeSessionMcpConfig,
} from "../src/mcp-config";
import { handoffSecretFile } from "../src/handoff-broker";

const originalUmask = process.umask();
afterEach(() => {
  process.umask(originalUmask);
  cleanupMcpConfigFiles();
  cleanupRuntimeDir();
  resetMcpConfigCache();
});

it("cleanup is non-allocating before use, repeatedly, and after runtime teardown", () => {
  cleanupRuntimeDir();
  const base = mkdtempSync(join(tmpdir(), "cleanup-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = base;
  try {
    cleanupMcpConfigFiles();
    cleanupMcpConfigFiles();
    expect(readdirSync(base)).toEqual([]);
    const { schemaPath } = writeSchemaFile([]);
    const { configPath } = writeMcpConfig([]);
    const sessionPath = writeSessionMcpConfig("cleanup-test", schemaPath);
    expect([schemaPath, configPath, sessionPath].every(existsSync)).toBe(true);
    cleanupMcpConfigFiles();
    expect([schemaPath, configPath, sessionPath].some(existsSync)).toBe(false);
    cleanupRuntimeDir();
    cleanupMcpConfigFiles();
    expect(readdirSync(base)).toEqual([]);
  } finally {
    cleanupRuntimeDir();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

it("real owned Pi list-models exits without shutdown exceptions in an unwritable short TMPDIR", () => {
  const selected = spawnSync("node", ["scripts/resolve-pi-cli.mjs"], {
    encoding: "utf8",
  });
  expect(selected.status, selected.stderr).toBe(0);
  const base = mkdtempSync(join(tmpdir(), "exit-"));
  const denied = join(base, "denied");
  // Create before chmod, with the same allowed storage as all other fixtures.
  const made = mkdtempSync(join(base, "denied-"));
  chmodSync(made, 0o500);
  try {
    const result = spawnSync(
      selected.stdout.trim(),
      [
        "-ne",
        "-e",
        resolve("."),
        "--list-models",
        "pi-claude-cli",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: base,
          PI_CODING_AGENT_DIR: denied,
          TMPDIR: made,
          XDG_RUNTIME_DIR: "",
          JITI_FS_CACHE: "false",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("pi-claude-cli");
    // Pi explicitly exits zero even when an exit listener throws.
    expect(result.stderr).toBe("");
    expect(readdirSync(made)).toEqual([]);
  } finally {
    chmodSync(made, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

it("stages searchable 0700 runtime directories and readable 0600 files under restrictive umasks", () => {
  process.umask(0o117);
  const dir = runtimeDir();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  // Remove owner read/write at creation too: explicit file chmod must restore both.
  process.umask(0o777);
  const { schemaPath } = writeSchemaFile([]);
  const { configPath } = writeMcpConfig([]);
  const sessionPath = writeSessionMcpConfig("umask-test", schemaPath);
  const secretPath = handoffSecretFile();
  expect(schemaPath.endsWith("/mcp-schemas.json")).toBe(true);
  expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual([]);
  for (const path of [schemaPath, configPath, sessionPath, secretPath]) {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
  }
});
