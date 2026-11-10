# Changelog

## 0.12.0 — 2026-11-10

- New Claude models without waiting for a Pi release: models Claude Code's own catalog offers (for example Fable 5.2 on launch day) are added to `/model` next to Pi's built-in list, and a running Pi picks them up after the turn that refreshed the catalog.
- Complete `/claude-accounts` management: `add`/`login` drive the official CLI's URL-and-paste-code flow, `status` shows auth and age-labelled ledger observations, `switch --default` persists future-session selection, `remove` optionally delegates logout or confirms directory deletion, and `doctor` checks CLI/profile health without reading credentials. Failed adds remain visible as pending declarations but cannot receive turns or failover until verified. Runtime/session switching overrides the launch selection and is restored on resume; environment declarations are merged with the package's `accounts.json` UI store.
- Tested with Claude Code 2.1.321, the first CLI offering Fable 5.2.
- Clean provider/API rename to `pi-claude-tether` and environment prefix rename to `PI_CLAUDE_TETHER_`. No compatibility alias and no old environment-variable fallback. Old exports produce a migration warning rather than controlling execution.
- Removed CLI-owned legacy context mode. Pi owns prompt, tools, history and compaction unconditionally; native Claude tools cannot be enabled through a context switch. Old sessions require explicit migration or a fresh session, not silent fallback.

### 0.12.0 migration

Update any host integrations that reference the old provider first, then update settings and shell exports once, and restart open Claude tabs. This release does not edit settings, shell files, credentials or account directories automatically.

In `~/.pi/agent/settings.json`:

- In `enabledModels`, replace `pi-claude-cli/claude-opus-5-5`, `pi-claude-cli/claude-sonnet-5-5` and `pi-claude-cli/claude-haiku-5-5` with `pi-claude-tether/claude-opus-5-5`, `pi-claude-tether/claude-sonnet-5-5` and `pi-claude-tether/claude-haiku-5-5`. Apply the same provider-prefix replacement to any other scoped Claude entries you added.
- Rename the keys `compaction.modelOverrides["pi-claude-cli/claude-opus-5-5"]`, `compaction.modelOverrides["pi-claude-cli/claude-sonnet-5-5"]` and `compaction.modelOverrides["pi-claude-cli/claude-haiku-5-5"]` to their `pi-claude-tether/…` equivalents. Preserve each override object, including `reserveTokens`.
- If set, migrate `defaultProvider: "pi-claude-cli"` to `"pi-claude-tether"`. Keep model IDs unchanged.

In `~/.bashrc`, replace existing account/failover exports with:

```bash
export PI_CLAUDE_TETHER_ACCOUNTS="${PI_CLAUDE_TETHER_ACCOUNTS:-default,b}"
export PI_CLAUDE_TETHER_FAILOVER="${PI_CLAUDE_TETHER_FAILOVER:-1}"
```

Remove their old `PI_CLAUDE_CLI_ACCOUNTS` / `PI_CLAUDE_CLI_FAILOVER` definitions and unset old variables in existing shells (or start a new shell). For any optional exports, replace the `PI_CLAUDE_CLI_` prefix with `PI_CLAUDE_TETHER_` for these supported suffixes: `ACCOUNT`, `ACCOUNTS`, `FAILOVER`, `ALLOW_USAGE_CREDITS`, `HANDOFF_PROXY`, `HANDOFF_WAIT_MS`, `KEEPALIVE_MS`, `SETTINGS`, `STATE_DIR`, `STRICT_VERSION`, `THINKING_DISPLAY`, `TIMEOUT_MS`. No old variable is read as configuration. Remove the old `CONTEXT` switch instead of renaming it; there is no legacy mode to select. Remove the legacy-only `PI_CLAUDE_CLI_SYSTEM_PROMPT`, `PI_CLAUDE_CLI_AUTOCOMPACT`, `PI_CLAUDE_CLI_HERMETIC`, `PI_CLAUDE_CLI_STRICT_MCP`, `PI_CLAUDE_CLI_EPHEMERAL`, `PI_CLAUDE_CLI_TOOL_RESULTS`, `PI_CLAUDE_CLI_NO_AGENT_WAIT` and `PI_CLAUDE_CLI_AGENT_WAIT_MS` exports; their renamed spellings are not supported either. Pi always supplies isolation, owns compaction and executes tools.

A corrupt `session-map.json` in the state directory now fails closed instead of being ignored, and blocks every Claude turn, including in new sessions, until it is repaired or removed. The error names the state directory; starting a fresh Pi session alone does not clear it.

Package data/profile/state directories already use `pi-claude-tether`: do not move them or re-login merely for the rename. The MCP namespace remains `mcp__custom-tools__`; tool receipts do not depend on the former provider ID. Historical changelog entries, fork attribution and retained internal evidence keep their original names.

A saved `pi-claude-cli` session cannot silently resume on another provider. Select `pi-claude-tether/<model>` deliberately or start a fresh Pi session. CLI-owned legacy transcripts and saved prompts are not migrated or replayed.

## 0.11.1 — 2026-11-05

- A pre-model OAuth refresh collision ("another Claude Code process is refreshing it") now retires the process and returns a transient error, so Pi's own retry decides, instead of killing the turn.
- Long error tool results that the official client clips (head 5000, marker, tail 5000) are accepted as that exact projection and recorded as declared-lossy, instead of forcing a full cache rewrite. Any other change still fails.
- An empty `PI_CLAUDE_CLI_CONTEXT` selects Pi-owned mode rather than the old CLI-owned mode. Stored prompt files are written with restricted permissions.
- Runtime allocation errors name the boundary that failed.

## 0.11.0 — 2026-10-28

First public release as `pi-claude-tether`.

- Explicit public export and npm allowlists; policy-backed public-tree scan.
- Public data, state and ledger roots remain unchanged. Unknown package names now use a generic legacy data directory; no automatic credential migration.

- Accept qualified derivative-image receipts with exact companion text and compatible supported headers/dimensions, and exact newline-joined multi-text error receipts (including nonempty outer-trimmed joins). Image equivalence is not pixel identity; missing images, denials, changed companions and error status remain strict.
- Standalone development setup and Pi 1.5.0 tests; test fixtures derive ledger paths from the package name.

- Runs Pi on the official Claude Code CLI with your own subscription, keeping one live CLI process per session and account. Pi owns the prompt, tools, conversation and compaction; the CLI handles authentication and model access.
- Warm CLI reuse only while the acknowledged history prefix and launch configuration match. Cancelled tools, steering during running tools, and settled transient failures keep prompt-cache continuity; anything else retires safely and reimports.
- Multiple Claude accounts with manual selection: `PI_CLAUDE_CLI_ACCOUNTS` declares the ordered set, `PI_CLAUDE_CLI_ACCOUNT` picks this process's profile. Each profile is a separate clean Claude login under the package data directory; the prompt cache is per account.
- Claude Code CLI version policy: declared tested range (floor plus newest qualified CLI); newer warns once and continues unless `PI_CLAUDE_CLI_STRICT_VERSION=1`; older errors. The bundled `scripts/update-cli.sh` stages a version, self-tests, then swaps the package CLI directory, keeping the previous one for rollback.
- Usage-credit guard: turns billed to overage fail non-retryably unless `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1`; the error states which effects stand.
- Rate-limit visibility: CLI rate-limit state forwarded as `anthropic-ratelimit-unified-*` headers; prompt-cache lifetimes declared for Pi's own session economics. Pi-driven refreshes are declined for this provider.
- Tested with pi 1.4.0 and Claude Code 2.1.311.

Honest limits: history imports are not byte-identical to a direct API provider; warm reuse does not survive every change, crash or provider switch; a parked CLI consumes memory; SIGKILL can leave a private temporary directory behind. Keeping a process warm does not guarantee a cache hit, reduce token usage, or change your subscription allowance. Check Anthropic's current terms yourself.
