import { createRuntimeDirectory } from "pi-tether-core/runtime";
export { RUNTIME_FILE_MODE, HANDOFF_SOCKET_NAME } from "pi-tether-core/runtime";

const runtime = createRuntimeDirectory("pi-claude-");
export const {
  existingRuntimeDir,
  cleanupRuntimeDir,
  resetRuntimeDirForTests,
} = runtime;

/** Name the failing boundary without claiming an unrelated login is broken. */
export function runtimeDir(): string {
  try {
    return runtime.runtimeDir();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Claude tether runtime directory unavailable: ${detail}. Check TMPDIR and XDG_RUNTIME_DIR and the sandbox write grants.`,
      { cause: error },
    );
  }
}

export function runtimeFile(name: string): string {
  // Ensure allocation failures get the same diagnostic on every entry path.
  runtimeDir();
  return runtime.runtimeFile(name);
}
