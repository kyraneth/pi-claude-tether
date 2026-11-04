# Observer mode

The Claude Code CLI runs its native tools and agent loop; Pi remains the conversation's system of record. Native tool activity is represented by markers in Pi's stream, while custom Pi tools use the MCP handoff bridge. Native tool calls are governed by CLI hooks rather than Pi extension hooks.

## Session and handoff

The package maps Pi session IDs to CLI session IDs. When a compatible process is available it can be reused; otherwise a valid CLI session can be resumed with the stored system prompt and the history delta. If the mapping is missing or stale, the provider imports the available Pi history into a new session. See `src/session-map.ts` and `src/prompt-builder.ts`.

The schema-only MCP server forwards custom tool calls through the handoff broker. Pi executes the tool, and the next Pi call returns its result to the waiting CLI process. The interrupt-and-resume path remains a fallback when proxying is disabled or no Pi session ID is available. The bridge checks result consumption and retires an unsafe process rather than silently dropping a result. Native tools execute inside the CLI and are not exposed as Pi tool calls.

For detailed lifecycle, cache, steering, and recovery behavior, see [Architecture](ARCHITECTURE.md) and [Context policy](CONTEXT-POLICY.md). Public tests use synthetic fixtures; live tests require an explicitly enabled subscription and can consume quota.
