/**
 * Drop this extension's own knobs before any test runs.
 *
 * Every `PI_CLAUDE_TETHER_*` variable changes what the provider does. A host
 * using this extension can pass settings into test subprocesses. Clear those
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

for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_CLAUDE_TETHER_") || key.startsWith("PI_CLAUDE_CLI_")) {
    delete process.env[key];
  }
}

// The read-only legacy guard must never inspect the developer's real sessions.
const sessionState = mkdtempSync(join(tmpdir(), "tether-test-sessions-"));
beforeEach(() => {
  process.env.PI_CLAUDE_TETHER_STATE_DIR = sessionState;
});
