/**
 * Drop this extension's own knobs before any test runs.
 *
 * Every `PI_CLAUDE_CLI_*` variable changes what the provider does. A host
 * using this extension can pass context, MCP, and autocompaction settings
 * into test subprocesses. Inherited Pi-context settings activate the version
 * gate before spawn and can bypass the mocked spawn path. Clear those
 * settings so each test explicitly controls the behavior it exercises.
 *
 * Tests that need a knob set it themselves (and restore it), so clearing the
 * environment here can only remove ambient state.
 */
import { beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Diagnostics such as retire.log must not land in the developer's real state.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "pcc-test-state-"));

// Existing observer-mode fixtures exercise the explicitly supported legacy path.
// Pi-owned suites unset this in their own beforeEach to test the real default.
beforeEach(() => {
  process.env.PI_CLAUDE_CLI_CONTEXT = "legacy";
});

for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_CLAUDE_CLI_")) delete process.env[key];
}
