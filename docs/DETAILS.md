# Technical details

Runs Pi on the official Claude Code CLI with your own subscription, keeping one live CLI process per session and account.

```bash
pi install npm:pi-claude-tether
```

Pick a model under `pi-claude-tether` with `/model`. The list is Pi's built-in Claude models plus any newer model Claude Code's own catalog offers for your signed-in accounts (cached by the CLI under `<profile>/cache/model-catalog/`), so a model released after your Pi version appears once the CLI has seen it, without a Pi update and without restarting Pi. Pi's own entry wins when both exist; a catalog-only model has no per-token cost (subscription turns are not billed per token). The same default works in Pi's terminal and Pi-compatible front ends. No separate minimal mode or configuration is required.

Requires Node.js 22+, Pi, and a compatible Claude Code CLI (2.1.263+ for older models; Opus 5.5 requires 2.1.280+). Standalone tests use Pi 1.5.0; the CLI compatibility ceiling is Claude Code 2.1.321 (the tested ceiling; Fable 5.2 requires 2.1.321+; see the version policy below). Subscription credentials stay in the official CLI; no API key extraction. In default Pi context, authenticate the dedicated profile with `CLAUDE_CONFIG_DIR="$HOME/.local/share/pi-claude-tether/claude-config" claude auth login --claudeai` (under `$XDG_DATA_HOME/pi-claude-tether/claude-config` when `XDG_DATA_HOME` is set). Running plain `claude auth login` targets a different profile and does **not** authenticate this extension. If the global CLI is too old, install an official version separately with `npm install --prefix "$HOME/.local/share/pi-claude-tether/cli" --no-save @anthropic-ai/claude-code@2.1.321`; the Pi provider prefers that executable while other Claude Code use retains the global version.

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
- Explicit host hooks supplied with `PI_CLAUDE_TETHER_SETTINGS` and managed Claude policy remain in force. Do not use `--bare`: it disables subscription authentication and hooks.
- The `claude-rate-limit` status reports subscription state outside conversation content.
- The [metadata-only request ledger](REQUEST-LEDGER.md) extends `retire.log` with request counters, separate CLI result totals, emitted allowance state, spawn payload byte sizes and retirement causes. No prompt/tool bodies are logged. Its asynchronous writer is best-effort: disk/write failure, direct host `process.exit()` or SIGKILL can lose pending rows. Missing utilization is `null`, never zero or an inferred allowance percentage.
- One-shot hosts should set `PI_CLAUDE_TETHER_KEEPALIVE_MS=0` so a parked process does not delay exit.

## Configuration

The defaults above require no configuration at all.

### Where settings live

| What                                | Where                                                                                                                      | When it is read                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Accounts, default account, failover | `~/.pi/agent/pi-claude-tether.json` (Pi's agent directory; `$PI_CODING_AGENT_DIR` when set), written by `/claude-accounts` | On every turn and command, so changes apply without restarting Pi |
| Claude logins                       | One directory per account under `~/.local/share/pi-claude-tether/` (`$XDG_DATA_HOME` when set), owned by the official CLI  | By the CLI, per account                                           |
| Optional overrides                  | `PI_CLAUDE_TETHER_*` environment variables (table below)                                                                   | Once, when Pi starts                                              |

Use `/claude-accounts` for accounts and failover; you do not need to edit shell files. Environment variables are optional per-launch overrides for scripts, aliases and special setups. A program receives its environment from the shell that starts it, so after editing `~/.bashrc` or a similar file, start Pi from a **new** shell: a shell that was already open, or a tmux/screen session (tmux keeps its own saved copy of the environment for new windows), still carries the old values. `/claude-accounts` shows when a variable is overriding the settings file. Configuration notices (an unrecognised value, retired variables) appear as Pi notifications when a session starts.

| Variable                               | Default      | Purpose                                                                                                           |
| -------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `PI_CLAUDE_TETHER_ACCOUNT`             | `default`    | This process's Claude profile; see Multiple Claude profiles                                                       |
| `PI_CLAUDE_TETHER_ACCOUNTS`            | `default`    | Extra declared profiles, e.g. `default,b`, listed before the settings file's accounts                             |
| `PI_CLAUDE_TETHER_FAILOVER`            | unset        | Overrides the settings file for this process: `1`/`true`/`yes` on, `0`/`false`/`no` off; other values are ignored |
| `PI_CLAUDE_TETHER_KEEPALIVE_MS`        | cache TTL    | Idle process lifetime; unset = until its prompt cache expires (1h on the subscription CLI); `0` for one-shot runs |
| `PI_CLAUDE_TETHER_SETTINGS`            | unset        | Explicit host Claude settings, including guard hooks                                                              |
| `PI_CLAUDE_TETHER_TIMEOUT_MS`          | `300000`     | Maximum stdout inactivity                                                                                         |
| `PI_CLAUDE_TETHER_HANDOFF_PROXY`       | enabled      | `0` disables proxy continuity; Pi still executes tools, with full-history reimports instead                       |
| `PI_CLAUDE_TETHER_HANDOFF_WAIT_MS`     | `1800000`    | Maximum wait for Pi tool execution                                                                                |
| `PI_CLAUDE_TETHER_THINKING_DISPLAY`    | `summarized` | `omitted` returns no thinking summaries                                                                           |
| `MCP_TOOL_TIMEOUT`                     | `3600000`    | CLI MCP call timeout                                                                                              |
| `PI_CLAUDE_TETHER_STRICT_VERSION`      | unset        | `1` refuses a CLI newer than the tested range instead of warning once and continuing                              |
| `PI_CLAUDE_TETHER_ALLOW_USAGE_CREDITS` | unset        | `1` allows turns billed to overage usage credits instead of failing them                                          |

Pi owns context and execution unconditionally in 0.12.0. There is no context-mode switch or native-tool compatibility mode. See the [migration checklist](../CHANGELOG.md#0120-migration) before upgrading old sessions or shell exports.

### Multiple Claude profiles

One Pi process uses exactly one Claude subscription at a time. Declare accounts with `/claude-accounts add <name>`, choose one with `/claude-accounts switch <name>` (add `--default` for future sessions), and let a limit move the turn to the next account with `/claude-accounts failover on`. All of this is stored in the settings file and needs no shell configuration.

Optionally, `PI_CLAUDE_TETHER_ACCOUNTS` (e.g. `default,b`) declares accounts from the environment, and `PI_CLAUDE_TETHER_ACCOUNT` chooses the profile a process starts on, so a shell alias starts Pi on a second account:

```bash
alias pi-b='PI_CLAUDE_TETHER_ACCOUNT=b pi'
pi-b --session <file>   # same Pi session file, account B
```

Inside Pi, `/claude-accounts` (or `list`/`ls`) lists accounts. The official CLI owns every sign-in and credential; the tether never reads credential files, exports tokens or queries a usage endpoint.

| Command                                        | Effect                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add <name> [--email e] [--sso] [--console]`   | Create a private directory (0700), show the official CLI's sign-in URL, and ask for the page's `code#state`. Default is Claude.ai; `--console` selects Console.                                                                                                  |
| `login <name>` / `login --all`                 | Re-login one account, or walk accounts needing login (including pending declarations) in declaration order.                                                                                                                                                      |
| `status [name]`                                | Auth status and requested/CLI-reported `configDirectory`, exhaustion, and last observed ledger utilization/reset with its age. These are observations, not live quota.                                                                                           |
| `switch <name> [--session]`                    | Select a verified account for subsequent turns and record a session custom entry (never sent to the model).                                                                                                                                                      |
| `switch <name> --default`                      | Also persist the default for future Pi sessions.                                                                                                                                                                                                                 |
| `failover [on\|off]`                           | Show, or persist in the settings file, whether a reached subscription limit moves the turn to the next ready account. Applies from the next turn. `PI_CLAUDE_TETHER_FAILOVER` overrides it for its process, and the output says so.                              |
| `remove <name> [--revoke] [--purge] [--force]` | Unregister, keeping the directory by default. `--revoke` invokes the CLI's `auth logout`; `--purge` deletes the directory only after confirmation. Active/last removal requires `--force`. Env-declared names must first be removed from the launch environment. |
| `doctor`                                       | CLI executable/version versus tested range, account directory existence, credential-file **presence only**, auth-status parse health and exhaustion.                                                                                                             |

The settings file `~/.pi/agent/pi-claude-tether.json` is the declaration/default/failover store: `{ "accounts": [{ "name": "work", "email": "…", "plan": "…", "addedAt": "…" }], "default": "work", "failover": true }`. Version 0.12.0 kept it at `~/.local/share/pi-claude-tether/accounts.json`; 0.12.1 moves that file once, with a notice, and never reads the old location again. The move never overwrites a newer file; on a filesystem without hard links it is left to you, and the notice says where. It contains no credentials; optional `console`/`sso` booleans retain the CLI login method for re-login. An added name is initially `pending: true`, visible for retry/removal but unavailable for switching, spawning or failover; only successful CLI completion followed by `auth status` verification clears pending and records identity metadata. A cancelled/failed add therefore remains safely removable. Login has no adapter deadline: the CLI completes, the user cancels the input, or the command signal aborts it.

Selection precedence is the latest session switch entry/runtime choice, then `PI_CLAUDE_TETHER_ACCOUNT` from launch, then the settings file's `default`, then `default`. This permits launching a `pi-b` alias and switching back to `default` inside Pi. A resumed session restores its choice; a no-longer-declared choice falls back to launch/default. Switching retires the warm CLI process. The original launch selection is captured once and never read back from the mutable environment. The effective selection is separately published to `PI_CLAUDE_TETHER_ACCOUNT` for child Pi processes, so subagents started after a switch inherit it; the parent's session custom entry remains its restoration owner.

Declarations and failover ordering are the env list first (its order preserved), then unique settings-file entries in file order; without a declaration file, the existing default-only behavior is unchanged. When env declarations are absent and the file exists, its entries alone declare the set, so unregistering the default (or forcing last removal) does not silently re-add it. The first UI declaration write preserves the currently declared set (including an implicit default), so adding or re-logging in an env-declared account does not silently unregister the other existing profiles. Pending accounts are skipped by failover. All names pass the same name gate.

`default` is the existing profile (`~/.local/share/pi-claude-tether/claude-config`, no re-login). Any other name `N` resolves to `~/.local/share/pi-claude-tether/accounts/N/claude-config` (under `$XDG_DATA_HOME` when set); authenticate it once with `CLAUDE_CONFIG_DIR=<that dir> claude auth login --claudeai`. Names must match `[A-Za-z0-9._-]` with no path separators, and a named account must be declared in `PI_CLAUDE_TETHER_ACCOUNTS` or the settings file; anything else fails the turn with an explicit configuration error. Each account's spawns, version probes and auth probes run under its own directory, and the account is part of the launch signature, so a warm process is never reused across profiles. Unset, or exactly `default`, behaves exactly as before; a single named entry runs under its own directory (`accounts/<name>/claude-config`).

The prompt cache is per account: a profile change costs a full context reimport plus a cache write on the other account. Keeping a process warm avoids resending history on follow-ups and tool handoffs; it does not send periodic requests, guarantee a cache hit, reduce token usage, or change your subscription allowance. Users must check Anthropic's current consumer terms themselves before operating more than one subscription.

### Claude Code CLI version policy

The supported range is declared in code (`MIN_CONTEXT_CLI_VERSION`, `TESTED_CLI_MAX` in `src/context-policy.ts`): the floor is the oldest CLI with the tested isolation controls, the ceiling is the newest CLI this package's suites actually pass against.

- Older than the floor: the turn errors and names the minimum version.
- Newer than the tested ceiling: the first spawn warns once per process and continues; nothing is refused by default. `PI_CLAUDE_TETHER_STRICT_VERSION=1` refuses a newer CLI instead, and the warning names the tested range.
- `/claude-cli` reports the installed version (through the same executable lookup the provider uses), the tested range, and the npm-published latest when online. The registry is only contacted when the command runs.

The CLI is never updated automatically. `<installed-package-dir>/scripts/update-cli.sh --version X` installs that version into a staging prefix, probes it (its version, plus a logged-out spawn-flags smoke in a sandbox HOME with no credentials), runs the stub e2e with the stub reporting the candidate version — so the provider's own version gating runs against it with zero live calls — and only then swaps the package CLI directory, keeping the previous one for rollback. The updater and its qualification files ([scripts/update-cli.sh](../scripts/update-cli.sh), [scripts/package-dirs.sh](../scripts/package-dirs.sh), [scripts/resolve-pi-cli.mjs](../scripts/resolve-pi-cli.mjs), [scripts/continuity-proof.py](../scripts/continuity-proof.py), [tests/e2e/continuity-extension.ts](../tests/e2e/continuity-extension.ts)) ship inside the npm package, so the path above works from any install; the same script runs from a GitHub checkout. Pass an explicit `--target` to prove it on a scratch prefix first. Packaged updater files: [update-cli.sh](../scripts/update-cli.sh), [package-dirs.sh](../scripts/package-dirs.sh), [resolve-pi-cli.mjs](../scripts/resolve-pi-cli.mjs), [continuity-proof.py](../scripts/continuity-proof.py), [continuity-extension.ts](../tests/e2e/continuity-extension.ts).

### Usage credits (overage) guard

When the CLI reports a turn billed to overage usage credits (`isUsingOverage`), the call ends with a non-retryable error unless `PI_CLAUDE_TETHER_ALLOW_USAGE_CREDITS=1` (same variable as other CLI-based providers: set it to continue after an overage charge). The message states what already happened: tool calls already executed through the broker keep their effects, tool calls not yet executed are abandoned with the failed turn, and streamed content stays in the transcript. Either way the turn is failed, so Pi does not treat the answer as successful. The guard is evaluated at the terminal result, never mid-stream.

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

The test suite covers Pi-owned execution with tests for tool selection, prompt changes, branch/compaction resets, provider round-trips, images, errors and cleanup.

The native continuity fixture uses installed Pi RPC with a fail-closed, credential-isolated CLI stub. It covers a genuinely running tool abort, during-tool native steering, warm follow-up and native transient retry, retaining per-event process and request-counter evidence:

```bash
npm run test:e2e:continuity
```

## Important limits

- CLI history imports preserve ordered content using role-labelled text and images; this is not byte-identical to a direct API provider's structured conversation.
- Pi remains responsible for compaction; Claude CLI auto-compaction is disabled in the default context.
- Warm process reuse does not survive every prompt/tool/history change, process crash or provider switch. A parked CLI also consumes memory; usage depends on CLI version and workload. Each Pi session may retain its own parked process.
- Abrupt termination such as SIGKILL can leave a private temporary runtime directory behind; normal cleanup is not a guarantee after forced termination.
- Usage beyond your subscription is governed by Anthropic's terms; this extension cannot grant extra allowance, reduce billed tokens, or assure billing outcomes.

## Provenance and license

MIT license, copyright (c) 2026 Rebecca Chernoff — see [LICENSE](../LICENSE). Upstream history is summarized in [SOURCE.md](../SOURCE.md).

## How I measured

The cache figures in the README come from short live tests of the packed release candidate on two machines, using Sonnet 5.5 in a real Pi session with a warm follow-up turn on one CLI process. The percentage is the input read from cache divided by all input on that turn. These tests show the cache works across a follow-up. They don't compare the tether with the direct API.

## Long tools: the step points, proved live

Each point below was verified in code and then passed once live: real installed `pi` in RPC mode with only this extension, the real Claude Code CLI (2.1.321), model `claude-haiku-5-5` (run under the provider id before the 0.12.0 rename), default account, scratch state dirs, and a Pi custom tool that sleeps a chosen duration and returns a marker. Times are UTC, 2026-11-10. The request ledger (`retire.log`) is metadata-only by design: it proves timing, episodes and causes, never bodies.

- **5-minute episode silence: Pi tools are exempt.** `INACTIVITY_TIMEOUT_MS` (`src/provider.ts`, default 300_000, `PI_CLAUDE_TETHER_TIMEOUT_MS` override; tether-chosen) kills an attached CLI episode after 5 minutes with no stdout. When Pi takes over a tool call, the episode detaches into the handoff park and the timer is cleared, so a running Pi tool never trips it. Proved: a 330 s tool returned `LONG-TOOL-OK-330s` after 330.0 s and the model replied `R1-DONE`; the ledger shows the spawn episode ending at tool start, no inactivity retire across 330 s of CLI silence, then a handoff episode (request then result) and `session_shutdown` at close. What you see: nothing — long tools just work past this point.

- **30-minute handoff park: retire and reimport.** `HANDOFF_WAIT_MS` (`src/provider.ts`, default 1_800_000, `PI_CLAUDE_TETHER_HANDOFF_WAIT_MS` override; tether-chosen "generous" ceiling for a process blocked waiting on Pi) interrupts and retires the blocked CLI process when it fires. This is not the between-turn parked lifetime, which follows prompt-cache expiry. Your Pi tool is unaffected and keeps running; when it returns, the next turn reimports full history into a fresh process and fresh CLI session. Proved: a 2010 s tool; ledger `retire ["handoff_wait_expiry"]` at 00:48:20Z, exactly 1800 s after the handoff park began, then process exit 1; the tool returned at 00:51:50; a new spawn (`spawnCause ["handoff_wait_expiry"]`, new CLI session) answered `R2-DONE`; follow-up `WARM-OK` ran warm as a turn on the same new process. What you see: the answer still arrives, but warmth is lost — full reimport, cache rebuild.

- **The 1-hour `MCP_TOOL_TIMEOUT` did not bind: contradiction with the code comment.** `DEFAULT_MCP_TOOL_TIMEOUT_MS` in `src/process-manager.ts` (`DEFAULT_MCP_TOOL_TIMEOUT_MS = 3_600_000`, injected into the CLI environment when unset) comments that it gives "the MCP client an hour before it gives up on a call". Observed, with a 3720 s tool and the provider wait extended to 70 min so only the vendor side could bind: the CLI ended its blocked turn at +30 min — a detached model request (221 output tokens) plus turn result (`numTurns` 2) at 00:48:20-21Z with no Pi episode attached (content unobserved: the ledger keeps no bodies). Nothing fired at the +60 min mark: zero ledger rows between 00:48:21 and the tool return at 01:20:19 — had the CLI emitted anything while detached it would have been buffered and flushed with original timestamps, and the flush held only the 00:48 rows. At tool return the tether retired the old process (`deltaShape`: the parked process was found with history and signature still matching, but its turn was already over so the result was not handoff-continuable — `src/provider.ts`) and reimported into a fresh process and session that answered `R3-DONE`; `WARM-OK` followed warm. So the effective CLI-side step is about 30 minutes, cause unidentified from outside (CLI 2.1.321's binary holds dozens of 1800000 constants, none attributable to the MCP path externally). The 1-hour default is real as injected environment but did not govern this run — plausibly it never got the chance, since no outstanding MCP call remained after the turn ended at +30 min — or it does not apply to the proxied path. Do not rely on an hour; finding the real limit is follow-up work. Note that the detached turn at +30 min is a real, billed model request whose content Pi never sees. What you see for tools past about 30 minutes is the same as the park-expiry case: the correct answer via reimport, warmth lost.

**Abort and steering during a long tool.**

| Case           | Observed                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abort mid-tool | 600 s tool aborted at +45 s (`tool_abort_observed`, elapsed 45.0 s); the run settled `aborted:true` with Pi's synthesized aborted assistant; the follow-up answered `ABORT-OK` warm on the same process and CLI session (no abort retire row; `session_shutdown` only at close). |
| Steer mid-tool | 300 s tool with native steering queued at +45 s (command `handled`); the tool ran to completion at 300.0 s; the model obeyed the newer instruction and replied `STEER-OK`.                                                                                                       |

Limits of this proof: one run per step, synthetic sleeps rather than real work, Haiku 5.5 only, CLI 2.1.321.

Pi's `onProviderStreamEvent` hook is currently **not called** by this tether. Claude CLI emits its own stream-json events rather than exposing the underlying HTTP stream; consumers cannot assume direct-API event visibility. The other provider hooks are separate.

For restricted children, the launcher must grant a short, writable runtime directory for sockets as well as the required Claude profile and state paths. A failed runtime allocation reports the underlying error and points to `TMPDIR`, `XDG_RUNTIME_DIR` and sandbox grants; a blocked optional session sidecar instead loses resume mapping and causes reimport. The tether does not repair sandbox grants or authenticate a profile.
