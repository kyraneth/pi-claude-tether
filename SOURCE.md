# pi-claude-tether — source provenance

This package is based on MIT-licensed [`@saccolabs/pi-claude-cli` 0.10.0](https://github.com/agustinsacco/pi-claude-cli) (upstream tag `v0.10.0`, commit `964ae7180d88bda1ee9266a2ff45074765f06195`), itself a maintained fork of [rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli). The original copyright and license are retained verbatim in `LICENSE`.

What changed relative to upstream 0.10.0:

- Package identity: renamed to `pi-claude-tether`; on-disk state moved from the old shared location to the package's own data directory (`${XDG_DATA_HOME:-~/.local/share}/pi-claude-tether/`), derived at runtime from the package's own `package.json` name (`src/data-dir.ts`).
- Pi-owned history/prompt/tools/compaction and warm CLI reuse are upstream architecture, retained.
- Continuity hardening: prompt-cache continuity across cancelled Pi tools, native steering during running tools, and settled transient retries; safe retirement/reimport otherwise.
- Receipt confirmation and recovery without repeating completed tool effects; malformed MCP input returns through Pi validation.
- Pi request/response hooks, a dedicated clean Claude profile per account, restrictive-umask permissions and long Unix socket-path handling.
- Multiple Claude accounts with manual selection (`PI_CLAUDE_CLI_ACCOUNT` / `PI_CLAUDE_CLI_ACCOUNTS`); the prompt cache is per account.
- Claude Code CLI version policy: a declared tested range, installed-vs-latest status, and a safe tested update path (`scripts/update-cli.sh`). The CLI is never updated automatically.
- Usage-credit guard: turns the CLI bills to overage stop with a non-retryable error unless explicitly opted in.
- Rate-limit visibility: CLI rate-limit state forwarded to Pi's `after_provider_response` as `anthropic-ratelimit-unified-*` headers, plus prompt-cache lifetime declarations for Pi's own session economics.

Warm-process retention is passive: keeping a compatible CLI process avoids reimporting history. It is not periodic cache refreshing, not a cache-hit guarantee, and not a billing change. Server-side caching and subscription policies remain outside the extension's control.
