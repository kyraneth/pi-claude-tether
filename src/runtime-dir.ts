import { createRuntimeDirectory } from "pi-tether-core/runtime";
export { RUNTIME_FILE_MODE, HANDOFF_SOCKET_NAME } from "pi-tether-core/runtime";
export const { runtimeDir, existingRuntimeDir, runtimeFile, cleanupRuntimeDir, resetRuntimeDirForTests } = createRuntimeDirectory("pi-claude-");
