# Changelog

## 0.11.0 — 2026-10-28

Prepared first public release as `pi-claude-tether` (not yet published).

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
