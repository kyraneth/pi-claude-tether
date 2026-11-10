/** Read-only rejection of retired Claude-owned session state. Pi owns history. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageStateDir } from "./data-dir.js";
import { ContextPolicyError } from "./context-policy.js";

/** Shared account/exhaustion state home, including the retired sidecar location. */
export function stateDir(): string {
  return packageStateDir();
}

/** Never silently discard, migrate, or resume a legacy session. */
export function assertNoLegacySession(piSessionId: string): void {
  let map: unknown;
  try {
    map = JSON.parse(
      readFileSync(join(stateDir(), "session-map.json"), "utf8"),
    );
    if (!map || typeof map !== "object" || Array.isArray(map))
      throw new Error("Invalid retired session-map shape");
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      throw new ContextPolicyError(
        "Cannot validate retired Claude session-map state. Start a fresh Pi session with a clean state directory.",
      );
    }
  }
  if (
    (map && typeof map === "object" && Object.hasOwn(map, piSessionId)) ||
    existsSync(join(stateDir(), "sysprompt", `${piSessionId}.txt`))
  ) {
    throw new ContextPolicyError(
      "Legacy Claude context session-map/sysprompt state cannot be resumed: Claude-owned context is removed. Start a fresh Pi session. Existing state was left unchanged.",
    );
  }
}
