import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

it("reports not-applied without private policy and still blocks generic credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "scanner-public-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync("scripts/check-public-tree.mjs", join(root, "scripts/check-public-tree.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "scanner-fixture", version: "1.0.0", files: ["README.md"] }));
  writeFileSync(join(root, "README.md"), "Neutral public fixture");
  writeFileSync(join(root, "scripts/export-manifest"), `
const fs = require("node:fs"), crypto = require("node:crypto");
console.log(JSON.stringify({files: ["README.md","package.json"].map(path => {
 const body = fs.readFileSync(path);
 return {path,bytes:body.length,sha256:crypto.createHash("sha256").update(body).digest("hex")};
})}));
`);
  const env = { ...process.env, PUBLIC_SCAN_POLICY: join(root, "absent.mjs") };
  const run = () => spawnSync(process.execPath, ["scripts/check-public-tree.mjs"], { cwd: root, env, encoding: "utf8" });
  const clean = run();
  expect(clean.status).toBe(0);
  expect(JSON.parse(clean.stdout)).toMatchObject({ status: "not-applied", policyApplied: false, findings: [] });
  writeFileSync(join(root, "README.md"), ["gh", "p_", "x".repeat(40)].join(""));
  const blocked = run();
  expect(blocked.status).toBe(1);
  expect(JSON.parse(blocked.stdout)).toMatchObject({ status: "blocked", policyApplied: false });
  expect(JSON.parse(blocked.stdout).findings.some((f: {kind: string}) => f.kind === "credential")).toBe(true);
});
