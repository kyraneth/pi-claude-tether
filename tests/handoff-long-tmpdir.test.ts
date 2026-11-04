import { afterEach, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { cleanupRuntimeDir, runtimeDir } from "../src/runtime-dir";
import {
  handoffSecret,
  handoffSecretFile,
  registerHandoffTarget,
  startHandoffBroker,
  stopHandoffBroker,
} from "../src/handoff-broker";

const originalTmp = process.env.TMPDIR;
const originalXdg = process.env.XDG_RUNTIME_DIR;
let root: string | undefined;
afterEach(() => {
  stopHandoffBroker();
  cleanupRuntimeDir();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (originalTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmp;
  if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalXdg;
});

for (const base of ["tmp", "xdg", "unusable-xdg", "long-xdg"]) {
  it.skipIf(process.platform === "win32")(
    `listens and completes a handoff under long TMPDIR (${base})`,
    async () => {
      root = mkdtempSync("/tmp/pcc-long-tmp-");
      // Long-TMPDIR reproduction: TMPDIR alone exceeds 120 characters, before the
      // per-process suffix and handoff.sock (Linux sun_path is only 108 bytes).
      process.env.TMPDIR = join(root, "member-scratch-".repeat(10));
      mkdirSync(process.env.TMPDIR, { recursive: true });
      const xdg = base === "long-xdg" ? process.env.TMPDIR : join(root, "xdg");
      delete process.env.XDG_RUNTIME_DIR;
      if (base !== "tmp") {
        if (base === "unusable-xdg") writeFileSync(xdg, "not a directory");
        else mkdirSync(xdg, { recursive: true });
        process.env.XDG_RUNTIME_DIR = xdg;
      }
      const socket = await startHandoffBroker();
      expect(Buffer.byteLength(socket)).toBeLessThan(
        process.platform === "darwin" ? 104 : 108,
      );
      expect(dirname(socket)).toBe(runtimeDir());
      expect(dirname(dirname(socket))).toBe(base === "xdg" ? xdg : "/tmp");
      expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      expect(statSync(handoffSecretFile()).mode & 0o777).toBe(0o600);
      registerHandoffTarget("long-tmp", {
        onHandoffCall: (call) =>
          call.respond({
            content: [{ type: "text", text: "handoff succeeded" }],
          }),
      });
      const response = await new Promise<string>((resolve, reject) => {
        const peer = connect(socket);
        let result = "";
        peer.setEncoding("utf8");
        peer.on("error", reject);
        peer.on("connect", () =>
          peer.write(
            JSON.stringify({
              type: "call",
              session: "long-tmp",
              name: "read",
              toolUseId: "one",
              arguments: {},
              secret: handoffSecret(),
            }) + "\n",
          ),
        );
        peer.on("data", (data) => {
          result += data;
        });
        peer.on("end", () => resolve(result));
      });
      expect(JSON.parse(response).content).toEqual([
        { type: "text", text: "handoff succeeded" },
      ]);
    },
  );
}
