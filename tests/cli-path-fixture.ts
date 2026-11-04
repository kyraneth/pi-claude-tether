/** Filesystem-only CLI fixture for suites whose child processes are mocked. */
import { afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const cliFixtureHome = mkdtempSync(join(tmpdir(), "pcc-cli-path-"));
const bin = join(cliFixtureHome, "bin");
mkdirSync(bin);
const originalPath = process.env.PATH;
// Fail closed if a suite accidentally executes its presence fixture.
writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(cliFixtureHome, { recursive: true, force: true });
});
