/**
 * Package-derived on-disk identity. Public installs use their own data,
 * state and ledger roots. Unknown names use the generic legacy layout;
 * this standalone package does not migrate other packages' credentials.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The published public package name. Everything else uses the legacy layout. */
export const PUBLIC_PACKAGE_NAME = "pi-claude-tether";

/** Short on-disk leaf for Pi agent state and state-home diagnostics. */
export type PackageLeaf = "pi-claude-tether" | "pi-claude-cli";

/** The `name` field of the nearest package.json above `startDir`, if any.
 *
 * Walks to the filesystem root: the loop already terminates on
 * `parent === dir`, so no depth bound is needed and deeply nested copies
 * (vendored trees, unusual bundling) resolve exactly like shallow ones.
 */
export function findPackageName(startDir: string): string | undefined {
  try {
    let dir = startDir;
    for (;;) {
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf-8"),
        );
        const name = (parsed as { name?: unknown } | null)?.name;
        if (typeof name === "string" && name.length > 0) return name;
      } catch {
        /* not this directory — keep walking up */
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    /* fall through to the default below */
  }
  return undefined;
}

/** The `name` field of this package's own package.json, if readable. */
export function ownPackageName(): string | undefined {
  try {
    return findPackageName(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return undefined;
  }
}

/** True only for the published public package name. */
export function isPublicPackageName(name: string | undefined): boolean {
  return name === PUBLIC_PACKAGE_NAME;
}

/** On-disk leaf for Pi agent state and state-home diagnostics. */
export function packageLeaf(
  name: string | undefined = ownPackageName(),
): PackageLeaf {
  // Historical unknown-package storage only, not a provider or env alias.
  return isPublicPackageName(name) ? "pi-claude-tether" : "pi-claude-cli";
}

/**
 * The package's data directory: Claude profile, account profiles, CLI install.
 *
 * Public: `${XDG_DATA_HOME:-~/.local/share}/pi-claude-tether`.
 * Generic historical storage (any unknown package name):
 * `~/.local/share/pi-claude-cli`. Never move existing credentials implicitly.
 */
export function packageDataDir(
  name: string | undefined = ownPackageName(),
): string {
  if (isPublicPackageName(name)) {
    const base =
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(base, "pi-claude-tether");
  }
  return join(homedir(), ".local", "share", "pi-claude-cli");
}

/** The preferred private Claude Code executable directory for this package. */
export function packageCliBinDir(
  name: string | undefined = ownPackageName(),
): string {
  return join(packageDataDir(name), "cli", "node_modules", ".bin");
}

/**
 * The package's Pi agent state directory (session map, exhaustion records,
 * stored system prompts). `PI_CLAUDE_TETHER_STATE_DIR` still overrides, as before.
 */
export function packageStateDir(
  name: string | undefined = ownPackageName(),
): string {
  return (
    process.env.PI_CLAUDE_TETHER_STATE_DIR ||
    join(homedir(), ".pi", "agent", packageLeaf(name))
  );
}

/** The package's state-home diagnostics directory (metadata-only ledger). */
export function packageLedgerDir(
  name: string | undefined = ownPackageName(),
): string {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    packageLeaf(name),
  );
}
