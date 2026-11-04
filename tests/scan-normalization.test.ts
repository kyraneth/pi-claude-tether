import { describe, it, expect } from "vitest";
// @ts-expect-error The public scanner is a standalone JavaScript CLI.
import { normalizeForScan, scanText } from "../scripts/check-public-tree.mjs";

describe("scanner encoded text and separated literals", () => {
  const term = ["reserved", "marker"].join("-");
  const policy = { bannedTerms: [term], privatePatterns: [] };
  const quote = (text: string) => JSON.stringify(text);
  const left = quote(term.slice(0, 9)), right = quote(term.slice(9));
  const seeds = [
    Buffer.from(term).toString("base64"),
    Buffer.from(term).toString("base64").replace(/=+$/, ""),
    Buffer.from(Buffer.from(term).toString("base64")).toString("base64"),
    "String.fromCharCode(" + [...term].flatMap(character => [character.charCodeAt(0), 0]).join(",") + ")",
    left + " /* fixture */ + " + right,
    left + " + /* fixture */ " + right,
    left + " /* fixture */ " + right,
    left + " \n " + right,
    left + " // fixture\n + " + right,
  ];
  for (const [index, seed] of seeds.entries()) {
    it(`detects encoded or separated form ${index}`, () => {
      expect(normalizeForScan(seed)).toContain(term);
      expect(scanText(seed, policy).some((finding: {kind: string}) => finding.kind === "banned-term")).toBe(true);
    });
  }
  it("ignores non-text base64 and malformed Unicode without throwing", () => {
    expect(() => normalizeForScan("//// \\u{ffffff}")).not.toThrow();
  });
});

describe("decoded candidate boundaries and reserved examples", () => {
  it("never forms a match across independently decoded candidates", () => {
    const prose = "appended after the final placeholder";
    const token = Buffer.from(": ok").toString("base64");
    const policy = { bannedTerms: [], privatePatterns: [{ kind: "seam", source: "placeholder\\s*[:=]" }] };
    expect(scanText("placeholder: ok", policy)).toEqual([{ kind: "seam" }]);
    expect(scanText(token + " " + prose, policy)).toEqual([]);
  });
  it("allows reserved example email domains", () => {
    expect(scanText("author@example.com author@example.net author@example.org", {})).toEqual([]);
  });
});

describe("multiline encoded text", () => {
  it("decodes textual newlines after joining quoted literals", () => {
    const block = ["reserved", "marker"].join("\n");
    const midpoint = Math.floor(block.length / 2);
    const quoted = JSON.stringify(block.slice(0, midpoint)) + " + " + JSON.stringify(block.slice(midpoint));
    const numeric = "String.fromCharCode(" + [...block].map(character => character.charCodeAt(0)).join(",") + ")";
    for (const encoded of [quoted, numeric]) {
      expect(normalizeForScan(encoded)).toContain(block);
      expect(scanText(encoded, { bannedTerms: [block] }).some((finding: {kind: string}) => finding.kind === "banned-term")).toBe(true);
    }
  });
});
