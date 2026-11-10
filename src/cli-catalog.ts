/**
 * Models Claude Code itself offers, read from the CLI's own model catalog.
 *
 * Pi's built-in Anthropic list only learns a new model when Pi is released.
 * Claude Code fetches its model catalog for the signed-in account and
 * caches it under `<CLAUDE_CONFIG_DIR>/cache/model-catalog/*-cc.json`. That
 * cache is the subscription's own statement of which models it offers, so
 * a model Pi does not know yet (Fable 5.2 on launch day) still reaches
 * `/model` as soon as the CLI has seen it.
 *
 * The catalog is not a credential: it holds model ids, names, limits and
 * effort levels. Reading it never touches a login. A missing, unreadable or
 * unexpected file contributes nothing; the built-in list stays as it is.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What the provider registers for one model. */
export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  /** Claude Code's effort levels for this model, in its own order. */
  effortLevels: string[];
}

interface RawCatalogModel {
  id?: unknown;
  name?: unknown;
  capabilities?: { mm_images?: unknown } | null;
  runtime?: {
    max_input_tokens?: unknown;
    max_output_tokens?: unknown;
    effort_levels?: unknown;
  } | null;
}

function parseModel(raw: RawCatalogModel): CatalogModel | undefined {
  const id = typeof raw.id === "string" ? raw.id : undefined;
  const contextWindow = raw.runtime?.max_input_tokens;
  const maxTokens = raw.runtime?.max_output_tokens;
  // Only entries carrying their own limits are usable: Pi needs a context
  // window and an output cap, and guessing either would mis-size compaction.
  if (
    id === undefined ||
    !/^claude-[a-z0-9-]+$/.test(id) ||
    typeof contextWindow !== "number" ||
    typeof maxTokens !== "number"
  ) {
    return undefined;
  }
  const effortLevels = Array.isArray(raw.runtime?.effort_levels)
    ? raw.runtime.effort_levels.filter(
        (level): level is string => typeof level === "string",
      )
    : [];
  return {
    id,
    // The catalog's short display name ("Fable 5.2") is prefixed like Pi's
    // own entries ("Claude Fable 5.2") so the picker reads consistently.
    name:
      typeof raw.name === "string" && raw.name.length > 0
        ? raw.name.startsWith("Claude ")
          ? raw.name
          : `Claude ${raw.name}`
        : id,
    reasoning: effortLevels.length > 0,
    input: raw.capabilities?.mm_images === true ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
    effortLevels,
  };
}

/** Every model in one catalog file, or nothing when it cannot be read. */
function readCatalogFile(path: string): CatalogModel[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      catalog?: { config?: { models?: unknown } };
    };
    const models = parsed.catalog?.config?.models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m) => parseModel((m ?? {}) as RawCatalogModel))
      .filter((m): m is CatalogModel => m !== undefined);
  } catch {
    return [];
  }
}

/**
 * The union of the Claude Code catalogs cached under the given config
 * directories, first occurrence of an id winning.
 */
export function cliCatalogModels(configDirs: string[]): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const dir of configDirs) {
    const catalogDir = join(dir, "cache", "model-catalog");
    let files: string[];
    try {
      files = readdirSync(catalogDir).filter((f) => f.endsWith("-cc.json"));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      for (const model of readCatalogFile(join(catalogDir, file))) {
        if (!byId.has(model.id)) byId.set(model.id, model);
      }
    }
  }
  return [...byId.values()];
}

/**
 * Pi's thinking-level map for a catalog-only model.
 *
 * Every Claude Code catalog model that reports effort levels takes an
 * effort, not a token budget (the catalog's `thinking.type` is "effort"),
 * so it is adaptive: `off` and `minimal` are not offered, and each level
 * Claude Code lists maps to itself. Levels it does not list are removed.
 */
export function catalogThinkingLevelMap(
  model: CatalogModel,
): Record<string, string | null> | undefined {
  if (!model.reasoning) return undefined;
  const map: Record<string, string | null> = { off: null, minimal: null };
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    map[level] = model.effortLevels.includes(level) ? level : null;
  }
  return map;
}
