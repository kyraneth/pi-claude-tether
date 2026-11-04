import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
const core = dirname(createRequire(import.meta.url).resolve("pi-tether-core/runtime"));
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(resolve(dir, e.name)) : /\.[cm]?[jt]s$/.test(e.name) ? [resolve(dir, e.name)] : []); }
describe("core dependency boundary", () => {
  it("imports no Claude protocol or sibling-engine module", () => {
    const violations: string[] = [];
    for (const path of files(core)) {
      const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(n: ts.Node) {
        let m: ts.Expression | undefined;
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) m = n.moduleSpecifier;
        if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) m = n.arguments[0];
        if (m) {
          if (!ts.isStringLiteral(m)) violations.push(`${path}: dynamic dependency`);
          else if (/claude/i.test(m.text) || (m.text.startsWith(".") && !resolve(dirname(path), m.text).startsWith(core + "/")) || (!m.text.startsWith(".") && !m.text.startsWith("node:") && !m.text.startsWith("@earendil-works/pi-ai"))) violations.push(`${path}: ${m.text}`);
        }
        ts.forEachChild(n, visit);
      }
      visit(ast);
    }
    expect(violations).toEqual([]);
  });
});
