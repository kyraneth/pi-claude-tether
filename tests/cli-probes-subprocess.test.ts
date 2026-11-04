import { expect, it, vi } from "vitest";
vi.mock("cross-spawn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cross-spawn")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { spawn as spawnProbe } from "cross-spawn";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCliAuth, verifyContextCli } from "../src/process-manager";

it.skipIf(process.platform === "win32")(
  "Pi's abort terminates a real hung version-only stub subprocess",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "pcc-probe-child-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    // Absolute Node shebang and isolated HOME/PATH: this cannot reach real Claude.
    writeFileSync(
      join(bin, "claude"),
      `#!${process.execPath}\nconst fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== '--version') process.exit(1);
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(join(home, "stopped"))}, ''); process.exit(0); });
fs.writeFileSync(${JSON.stringify(join(home, "started"))}, '');
require("node:net").createServer().listen(${JSON.stringify(join(home, "wait.sock"))});
`,
      { mode: 0o700 },
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", bin);
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
    const exec = vi.mocked(spawnProbe);
    exec.mockClear();
    const watchers: ReturnType<typeof watch>[] = [];
    const marker = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const watcher = watch(home, (_event, filename) => {
          if (filename === name && existsSync(join(home, name))) {
            watcher.close();
            resolve();
          }
        });
        watcher.on("error", reject);
        watchers.push(watcher);
      });
    const started = marker("started");
    const stopped = marker("stopped");
    const controller = new AbortController();
    try {
      const probe = verifyContextCli(controller.signal);
      const rejection = expect(probe).rejects.toThrow("Request aborted");
      await started;
      controller.abort();
      await rejection;
      await stopped;
      expect(exec).toHaveBeenCalledWith(
        "claude",
        ["--version"],
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(exec.mock.calls[0][2]).not.toHaveProperty("timeout");
    } finally {
      controller.abort();
      for (const result of exec.mock.results) {
        if (result.type === "return" && result.value.exitCode === null)
          result.value.kill("SIGKILL");
      }
      for (const watcher of watchers) watcher.close();
      exec.mockClear();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

// A hung startup `claude auth status` must not keep Pi from exiting after
// session_shutdown. The probe is owned by the extension and ended by its signal.
it.skipIf(process.platform === "win32")(
  "the owner's abort ends a real hung auth-status probe, without a false warning",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "pcc-auth-child-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "claude"),
      `#!${process.execPath}\nconst fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(1);
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(join(home, "stopped"))}, ''); process.exit(0); });
fs.writeFileSync(${JSON.stringify(join(home, "started"))}, '');
require("node:net").createServer().listen(${JSON.stringify(join(home, "wait.sock"))});
`,
      { mode: 0o700 },
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", bin);
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watchers: ReturnType<typeof watch>[] = [];
    const marker = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const watcher = watch(home, (_event, filename) => {
          if (filename === name && existsSync(join(home, name))) {
            watcher.close();
            resolve();
          }
        });
        watcher.on("error", reject);
        watchers.push(watcher);
      });
    const started = marker("started");
    const stopped = marker("stopped");
    const controller = new AbortController();
    try {
      const probe = validateCliAuth(controller.signal);
      await started;
      controller.abort();
      expect(await probe).toBe(false);
      await stopped;
      expect(warn).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      warn.mockRestore();
      for (const watcher of watchers) watcher.close();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
