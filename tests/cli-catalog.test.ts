import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogThinkingLevelMap, cliCatalogModels } from "../src/cli-catalog";

// The shape Claude Code 2.1.321 caches under
// <CLAUDE_CONFIG_DIR>/cache/model-catalog/<org>-<hash>-cc.json.
function catalog(models: unknown[]): string {
  return JSON.stringify({
    version: 2,
    fetchedAt: 1,
    catalog: { surface: "cc", config: { id: "cc", models } },
  });
}

const FABLE_5_2 = {
  id: "claude-fable-5-2",
  name: "Fable 5.2",
  capabilities: { mm_images: true },
  runtime: {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    effort_levels: ["low", "medium", "high", "xhigh", "max"],
  },
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pcc-catalog-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeCatalog(dir: string, file: string, body: string): void {
  mkdirSync(join(dir, "cache", "model-catalog"), { recursive: true });
  writeFileSync(join(dir, "cache", "model-catalog", file), body);
}

describe("cliCatalogModels", () => {
  it("reads a model Pi does not know from the CLI's cached catalog", () => {
    const a = join(root, "a");
    writeCatalog(a, "org-hash-cc.json", catalog([FABLE_5_2]));
    expect(cliCatalogModels([a])).toEqual([
      {
        id: "claude-fable-5-2",
        name: "Claude Fable 5.2",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000000,
        maxTokens: 128000,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
  });

  it("unions every account's catalog, first id winning", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    writeCatalog(a, "x-cc.json", catalog([{ ...FABLE_5_2, name: "From A" }]));
    writeCatalog(
      b,
      "y-cc.json",
      catalog([
        { ...FABLE_5_2, name: "From B" },
        { ...FABLE_5_2, id: "claude-sonnet-6", name: "Sonnet 6" },
      ]),
    );
    const models = cliCatalogModels([a, b]);
    expect(models.map((m) => [m.id, m.name])).toEqual([
      ["claude-fable-5-2", "Claude From A"],
      ["claude-sonnet-6", "Claude Sonnet 6"],
    ]);
  });

  it("skips entries without their own limits and unreadable files", () => {
    const a = join(root, "a");
    writeCatalog(a, "bad-cc.json", "{not json");
    writeCatalog(a, "other.json", catalog([FABLE_5_2])); // not a -cc catalog
    writeCatalog(
      a,
      "ok-cc.json",
      catalog([
        { id: "claude-no-limits", name: "No limits" },
        { ...FABLE_5_2, id: "not-a-claude-id" },
      ]),
    );
    expect(cliCatalogModels([a, join(root, "missing")])).toEqual([]);
  });

  it("offers only the effort levels Claude Code lists, never off/minimal", () => {
    const [model] = cliCatalogModels(
      (() => {
        const a = join(root, "a");
        writeCatalog(
          a,
          "z-cc.json",
          catalog([
            {
              ...FABLE_5_2,
              runtime: {
                ...FABLE_5_2.runtime,
                effort_levels: ["low", "medium", "high", "max"],
              },
            },
          ]),
        );
        return [a];
      })(),
    );
    expect(catalogThinkingLevelMap(model!)).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("is a non-reasoning model when the catalog lists no effort", () => {
    const a = join(root, "a");
    writeCatalog(
      a,
      "h-cc.json",
      catalog([
        {
          id: "claude-haiku-9",
          name: "Haiku 9",
          runtime: { max_input_tokens: 200000, max_output_tokens: 64000 },
        },
      ]),
    );
    const [model] = cliCatalogModels([a]);
    expect(model!.reasoning).toBe(false);
    expect(model!.input).toEqual(["text"]);
    expect(catalogThinkingLevelMap(model!)).toBeUndefined();
  });
});
