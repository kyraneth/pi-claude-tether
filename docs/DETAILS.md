# Technical details

Runs Pi on the official Claude Code CLI with your own subscription, keeping one live CLI process per session and account.

```bash
pi install npm:pi-claude-tether
```

Pick a model under `pi-claude-cli` with `/model`. The same default works in Pi's terminal and Pi-compatible front ends. No separate minimal mode or configuration is required.

Requires Node.js 22+, Pi, and a compatible Claude Code CLI (2.1.263+ for older models; Opus 5.5 requires 2.1.280+). Standalone tests use Pi 1.5.0; the inherited CLI compatibility ceiling is Claude Code 2.1.311 (the tested ceiling; see the version policy below). Subscription credentials stay in the official CLI; no API key extraction. In default Pi context, authenticate the dedicated profile with `CLAUDE_CONFIG_DIR="$HOME/.local/share/pi-claude-tether/claude-config" claude auth login --claudeai` (under `$XDG_DATA_HOME/pi-claude-tether/claude-config` when `XDG_DATA_HOME` is set). Running plain `claude auth login` targets a different profile and does **not** authenticate this extension. If the global CLI is too old, install an official version separately with `npm install --prefix "$HOME/.local/share/pi-claude-tether/cli" --no-save @anthropic-ai/claude-code@2.1.311`; the Pi provider prefers that executable while other Claude Code use retains the global version.

Startup checks CLI presence by executable lookup on the provider's PATH; authentication is checked asynchronously without delaying provider registration. Before a Pi-context spawn, an abortable asynchronous version probe verifies compatibility. Successful probes are reused for the same real binary and modification time; failures are not cached. These probes have no adapter deadline.

## Origin

This package started as a fork of [pi-claude-cli](https://github.com/rchern/pi-claude-cli), via the maintained fork at [agustinsacco/pi-claude-cli](https://github.com/agustinsacco/pi-claude-cli) ([@saccolabs/pi-claude-cli](https://www.npmjs.com/package/@saccolabs/pi-claude-cli)). Thanks to Rebecca Chernoff and Agustín Sacco for their work on the upstream project.

It grew from there: hardening fixes, prompt-cache continuity across cancelled tools, steering and retries, Pi-owned tool use with safe recovery, multiple Claude accounts with manual selection, a Claude Code CLI version policy with safe updates, a usage-credit guard, and rate-limit visibility.

## One owner: Pi

- **Prompt:** Pi's current system prompt replaces Claude Code's coding-agent prompt. A short binding explains the MCP tool-name prefix. Project instructions, skills and `.pi` paths remain unchanged; Claude does not independently discover them.
- **Tools:** only the current request's tools are advertised. All tools, including read/edit/bash, execute in Pi through the authenticated MCP bridge. Normal Pi tool hooks, schemas and complete results apply. The provider never enables inactive tools. Claude-native agents, planning, scheduling and web tools are not enabled.
- **Conversation:** Pi's current history is authoritative. A warm Claude process is reused only while the acknowledged history prefix and launch configuration match. Edits, compaction, provider changes, prompt changes or tool changes cause a clean reimport.
- **Storage:** default Claude processes use `--no-session-persistence`. No new Claude conversation file, resume pairing or saved system-prompt sidecar is created. Private temporary prompt and MCP files are removed when no longer needed; the runtime directory is removed on process exit. A SIGKILL can leave its private temporary directory behind.
- **Compaction:** Pi compacts its own history normally. CLI auto-compaction is disabled. Hosts must not switch off Pi compaction just because this provider is selected.

## Switching providers

Claude → native Pi → Claude uses the same Pi session. Switching models retires the parked Claude process and clears its UI status. Switching back imports Pi's current context, including native-provider turns, full tool results and images. Branch navigation and compaction cannot resume a stale Claude transcript.

A fresh CLI process costs a history import and may lose the previous prompt cache. Ordinary follow-ups and tool handoffs keep the warm process; Pi does not resend history on each tool call. Cancelled tools retain their awaited error result, steering drains the old turn before sending a separate user turn, and settled transient API failures stay parked for Pi's own retry. Dead processes, changed histories and unknown user consumption still retire safely.

**Not byte-identical to a direct API provider:** Claude Code's print interface accepts user messages, not an arbitrary structured conversation. Imports preserve message order and content using role-labelled text plus image blocks. Historical tool calls are records, not re-executed operations. Claude's internal runtime and service policies still apply.

## Host integration

See [the context contract](CONTEXT-POLICY.md).

- Keep Pi's project/skill discovery and auto-compaction enabled.
- Use Pi's normal tool and transcript UI. Historical `[Claude Code · ...]` markers remain readable for old sessions.
- Explicit host hooks supplied with `PI_CLAUDE_CLI_SETTINGS` and managed Claude policy remain in force. Do not use `--bare`: it disables subscription authentication and hooks.
- The `claude-rate-limit` status reports subscription state outside conversation content.
- The [metadata-only request ledger](REQUEST-LEDGER.md) extends `retire.log` with request counters, separate CLI result totals, emitted allowance state, spawn payload byte sizes and retirement causes. No prompt/tool bodies are logged. Its asynchronous writer is best-effort: disk/write failure, direct host `process.exit()` or SIGKILL can lose pending rows. Missing utilization is `null`, never zero or an inferred allowance percentage.
- One-shot hosts should set `PI_CLAUDE_CLI_KEEPALIVE_MS=0` so a parked process does not delay exit, and `PI_CLAUDE_CLI_EPHEMERAL=1` so a run on the legacy path leaves nothing behind either.

## Configuration

The defaults above require no environment variables.

| Variable                            | Default      | Purpose                                                                                                           |
| ----------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `PI_CLAUDE_CLI_ACCOUNT`             | `default`    | This process's Claude profile; see Multiple Claude profiles                                                       |
| `PI_CLAUDE_CLI_ACCOUNTS`            | `default`    | Ordered declared profile set, e.g. `default,b`                                                                    |
| `PI_CLAUDE_CLI_KEEPALIVE_MS`        | cache TTL    | Idle process lifetime; unset = until its prompt cache expires (1h on the subscription CLI); `0` for one-shot runs |
| `PI_CLAUDE_CLI_SETTINGS`            | unset        | Explicit host Claude settings, including guard hooks                                                              |
| `PI_CLAUDE_CLI_TIMEOUT_MS`          | `300000`     | Maximum stdout inactivity                                                                                         |
| `PI_CLAUDE_CLI_HANDOFF_WAIT_MS`     | `1800000`    | Maximum wait for Pi tool execution                                                                                |
| `PI_CLAUDE_CLI_THINKING_DISPLAY`    | `summarized` | `omitted` returns no thinking summaries                                                                           |
| `MCP_TOOL_TIMEOUT`                  | `3600000`    | CLI MCP call timeout                                                                                              |
| `PI_CLAUDE_CLI_STRICT_VERSION`      | unset        | `1` refuses a CLI newer than the tested range instead of warning once and continuing                              |
| `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS` | unset        | `1` allows turns billed to overage usage credits instead of failing them                                          |

`PI_CLAUDE_CLI_CONTEXT=pi` explicitly selects the default. `legacy` retains the old observer behavior for compatibility, with native Claude tools, a separate persistent transcript and CLI-owned compaction. `PI_CLAUDE_CLI_SYSTEM_PROMPT`, `PI_CLAUDE_CLI_AUTOCOMPACT`, `PI_CLAUDE_CLI_TOOL_RESULTS`, `PI_CLAUDE_CLI_HERMETIC` and `PI_CLAUDE_CLI_STRICT_MCP` configure that legacy path; they do not weaken Pi ownership in the default path. [Legacy architecture and wire contracts](ARCHITECTURE.md).

`PI_CLAUDE_CLI_EPHEMERAL=1` is for one-shots such as `pi -p --no-session` (session naming, health checks). On the legacy path it spawns the CLI with `--no-session-persistence` and records no resume pairing or stored system prompt, as the default already does. Do not switch it on part-way through a persisted legacy session: the CLI would not record those turns, and a later resume would silently miss them.

### Multiple Claude profiles

One Pi process uses exactly one Claude subscription. The ordered set is declared with `PI_CLAUDE_CLI_ACCOUNTS` (e.g. `default,b`); the profile for this process is chosen with `PI_CLAUDE_CLI_ACCOUNT`, so a shell alias starts Pi on a second account:

```bash
alias pi-b='PI_CLAUDE_CLI_ACCOUNT=b pi'
pi-b --session <file>   # same Pi session file, account B
```

`default` is the existing profile (`~/.local/share/pi-claude-tether/claude-config`, no re-login). Any other name `N` resolves to `~/.local/share/pi-claude-tether/accounts/N/claude-config` (under `$XDG_DATA_HOME` when set); authenticate it once with `CLAUDE_CONFIG_DIR=<that dir> claude auth login --claudeai`. Names must match `[A-Za-z0-9._-]` with no path separators, and a named account must be declared in `PI_CLAUDE_CLI_ACCOUNTS`; anything else fails the turn with an explicit configuration error. Each account's spawns, version probes and auth probes run under its own directory, and the account is part of the launch signature, so a warm process is never reused across profiles. Unset, or exactly `default`, behaves exactly as before; a single named entry runs under its own directory (`accounts/<name>/claude-config`).

The prompt cache is per account: a profile change costs a full context reimport plus a cache write on the other account. Keeping a process warm avoids resending history on follow-ups and tool handoffs; it does not send periodic requests, guarantee a cache hit, reduce token usage, or change your subscription allowance. Users must check Anthropic's current consumer terms themselves before operating more than one subscription.

### Claude Code CLI version policy

The supported range is declared in code (`MIN_CONTEXT_CLI_VERSION`, `TESTED_CLI_MAX` in `src/context-policy.ts`): the floor is the oldest CLI with the tested isolation controls, the ceiling is the newest CLI this package's suites actually pass against.

- Older than the floor: the turn errors and names the minimum version.
- Newer than the tested ceiling: the first spawn warns once per process and continues; nothing is refused by default. `PI_CLAUDE_CLI_STRICT_VERSION=1` refuses a newer CLI instead, and the warning names the tested range.
- `/claude-cli` reports the installed version (through the same executable lookup the provider uses), the tested range, and the npm-published latest when online. The registry is only contacted when the command runs.

The CLI is never updated automatically. `<installed-package-dir>/scripts/update-cli.sh --version X` installs that version into a staging prefix, probes it (its version, plus a logged-out spawn-flags smoke in a sandbox HOME with no credentials), runs the stub e2e with the stub reporting the candidate version — so the provider's own version gating runs against it with zero live calls — and only then swaps the package CLI directory, keeping the previous one for rollback. The updater and its qualification files ([scripts/update-cli.sh](../scripts/update-cli.sh), [scripts/package-dirs.sh](../scripts/package-dirs.sh), [scripts/resolve-pi-cli.mjs](../scripts/resolve-pi-cli.mjs), [scripts/continuity-proof.py](../scripts/continuity-proof.py), [tests/e2e/continuity-extension.ts](../tests/e2e/continuity-extension.ts)) ship inside the npm package, so the path above works from any install; the same script runs from a GitHub checkout. Pass an explicit `--target` to prove it on a scratch prefix first. Packaged updater files: [update-cli.sh](../scripts/update-cli.sh), [package-dirs.sh](../scripts/package-dirs.sh), [resolve-pi-cli.mjs](../scripts/resolve-pi-cli.mjs), [continuity-proof.py](../scripts/continuity-proof.py), [continuity-extension.ts](../tests/e2e/continuity-extension.ts).

### Usage credits (overage) guard

When the CLI reports a turn billed to overage usage credits (`isUsingOverage`), the call ends with a non-retryable error unless `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1` (same variable as other CLI-based providers: set it to continue after an overage charge). The message states what already happened: tool calls already executed through the broker keep their effects, tool calls not yet executed are abandoned with the failed turn, and streamed content stays in the transcript. Either way the turn is failed, so Pi does not treat the answer as successful. The guard is evaluated at the terminal result, never mid-stream.

### Prompt-cache visibility

Our models declare the prompt-cache lifetime Pi documents for anthropic models (`promptCache: { short: 300, long: 3600 }`). Pi's own machinery uses it for `/session` economics; without a declared lifetime the provider reads "cache economics unavailable". The CLI's rate-limit state is also forwarded to Pi's `after_provider_response` as `anthropic-ratelimit-unified-*` headers (the shape quota extensions read), in addition to the existing `claude-rate-limit` status entry. Pi may send its own refresh requests through the provider; this extension declines them for its provider, so the declared lifetime feeds visibility only — a refresh replayed through the provider would stage a real extra turn on a new CLI process and bill it.

## Development

This repository is standalone; no parent workspace is needed. It depends on exactly `pi-tether-core@0.1.0`. Use `npm install` in a source checkout. Development can also use a locally packed core tarball with `npm install --no-save --package-lock=false /path/to/pi-tether-core-0.1.0.tgz`; this does not change the registry dependency.

Run `npm test -- --no-file-parallelism`, `npm run typecheck`, `npm run lint`, `python3 -m unittest discover -s tests -p test_continuity_proof.py`, and `npm run test:e2e`. The e2e uses the locally installed Pi 1.5.0 and a credential-free Claude stub, not the global Pi or a subscription account. `npm run test:e2e:continuity` proves stub continuity through native Pi.

Receipt image matching validates supported headers, dimensions, block order and exact text companions, **not decoded pixels or full image integrity**. Multi-text error normalization admits only the exact newline join or its nonempty outer-trimmed form. Denials, body loss and changed companions remain mismatches; history-prefix guards remain separate.

```bash
npm install
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage
npm run test:e2e
```

The test suite retains explicit legacy fixtures and adds default-policy tests for tool selection, prompt changes, branch/compaction resets, provider round-trips, images, errors and cleanup.

The native continuity fixture uses installed Pi RPC with a fail-closed, credential-isolated CLI stub. It covers a genuinely running tool abort, during-tool native steering, warm follow-up and native transient retry, retaining per-event process and request-counter evidence:

```bash
npm run test:e2e:continuity
```

## Important limits

- CLI history imports preserve ordered content using role-labelled text and images; this is not byte-identical to a direct API provider's structured conversation.
- Pi remains responsible for compaction; Claude CLI auto-compaction is disabled in the default context.
- Warm process reuse does not survive every prompt/tool/history change, process crash or provider switch. A parked CLI also consumes memory; usage depends on CLI version and workload. Each Pi session may retain its own parked process.
- Abrupt termination such as SIGKILL can leave a private temporary runtime directory behind; normal cleanup is not a guarantee after forced termination.
- Explicit legacy mode does not provide the default Pi-tool-ownership guarantee.
- Usage beyond your subscription is governed by Anthropic's terms; this extension cannot grant extra allowance, reduce billed tokens, or assure billing outcomes.

## Provenance and license

MIT license, copyright (c) 2026 Rebecca Chernoff — see [LICENSE](../LICENSE). Upstream history is summarized in [SOURCE.md](../SOURCE.md).

## How I measured

The cache figures in the README come from short live tests of the packed release candidate on two machines, using Sonnet 5.5 in a real Pi session with a warm follow-up turn on one CLI process. The percentage is the input read from cache divided by all input on that turn. These tests show the cache works across a follow-up. They don't compare the tether with the direct API.

## Long tools and current limits

A Pi tool handoff can wait 30 minutes by default; if no continuation arrives, the tether interrupts and retires that blocked CLI process. A later continuation must reimport. This is **not** the ordinary parked-process lifetime: between completed turns the default follows the observed prompt-cache expiry. The official CLI also receives a default `MCP_TOOL_TIMEOUT` of one hour, unless already set. During an active CLI episode, five minutes without stdout triggers the tether's default inactivity timeout. These are code paths, not proof that a real tool survived each boundary. Abort and steering during tools beyond these boundaries remain unqualified.

Pi's `onProviderStreamEvent` hook is currently **not called** by this tether. Claude CLI emits its own stream-json events rather than exposing the underlying HTTP stream; consumers cannot assume direct-API event visibility. The other provider hooks are separate.

For restricted children, the launcher must grant a short, writable runtime directory for sockets as well as the required Claude profile and state paths. A failed runtime allocation reports the underlying error and points to `TMPDIR`, `XDG_RUNTIME_DIR` and sandbox grants; a blocked optional session sidecar instead loses resume mapping and causes reimport. The tether does not repair sandbox grants or authenticate a profile.
