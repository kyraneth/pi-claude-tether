# Legacy observer architecture

This document describes the explicit `PI_CLAUDE_CLI_CONTEXT=legacy` compatibility
path and the marker contracts needed to render old sessions. The default from
0.9.0 uses [pi-owned context and execution](CONTEXT-POLICY.md): all tools run in
pi, CLI sessions are disposable and pi owns compaction. The lifecycle/bridge
code is shared, but the native execution, saved pairing and CLI compaction
sections below do not describe the default.

How the legacy path turns the Claude Code CLI into a pi model provider, what
crosses the boundary in each direction, and why each non-obvious decision is
the way it is.

## The inversion

pi normally streams from a provider API. This extension implements pi's
`streamSimple` contract using a **persistent `claude -p` process per session**
and translating its stdout into pi stream events. Claude Code remains an
agent: it owns native tools, its default prompt, and a separate transcript
and compaction lifecycle. pi executes custom handoff tools and remains the
front-end's system of record.

The [default context policy](CONTEXT-POLICY.md) replaces this execution model.

Registration happens twice in `index.ts`, because pi 0.84 has two dispatch
paths:

- `pi.registerProvider()` — feeds pi's provider composer.
- `registerApiProvider()` from `@earendil-works/pi-ai/compat` — feeds pi-ai's
  global api registry, which pi's default stream fn resolves through. Print
  mode and nested agent loops take that path; without this they throw
  `No API provider registered for api: pi-claude-cli`.

The model list is pi's own Anthropic catalogue re-parented under the
`pi-claude-cli` provider id. Each model keeps pi's own `thinkingLevelMap`,
less `minimal` on adaptive models, where it would send exactly what `low`
sends (`cliThinkingLevelMap`). So pi offers only levels the model has, and
the result matches Claude Code's own per-model effort report on every model
(see "Thinking: the same request pi would send").

## One turn on the wire

```
pi agent loop
  └─ streamSimple(model, context, options)
       ├─ session-map     → resume the pi session's CLI session, or import
       ├─ prompt-builder  → delta (resume) or flattened history (import)
       ├─ cli-process     → the session's live process if one is parked
       │                    (0.7.0), else process-manager spawns claude -p …
       ├─ stream-parser   → NDJSON lines (never throws)
       ├─ event-bridge    → pi stream events; CLI-executed tools as markers,
       │                    HANDOFF (custom pi) tools as toolCall blocks
       ├─ control-handler → answers can_use_tool permission requests
       ├─ handoff         → pi's stream ends at message_stop; the CLI blocks on
       │                    the proxied tools/call (handoff-broker) until the
       │                    next pi call answers it on the same process
       └─ result          → the process is parked for the next turn, not killed
```

### Prompt in

`claude -p` accepts one user message, not a structured history, so
`prompt-builder.ts` flattens pi's `Context.messages` into a labeled
transcript (`USER:` / `ASSISTANT:` / `TOOL RESULT (historical <tool>):`).
Images in the **final** user message are translated from pi-ai's
`{data, mimeType}` shape to Anthropic's `{source:{type:"base64",…}}` blocks;
images earlier in history degrade to placeholder text. pi's system prompt
rides in through `--append-system-prompt-file` (a temp file path — the
unsuffixed `--append-system-prompt` takes a literal string, and handing it a
path silently makes the path itself the prompt; also avoids Windows
`ENAMETOOLONG`). pi 0.86+ leaves `Context.systemPrompt` empty and sends the
prompt as `system` messages; this path resolves it the same way the default
does ([CONTEXT-POLICY.md](CONTEXT-POLICY.md#request-contract)) and leaves
those messages out of the transcript.

### Spawn

```
claude -p --input-format stream-json --output-format stream-json
       --verbose --include-partial-messages
       --model <id> --permission-prompt-tool stdio
       (--session-id <pi session id> | --resume <pi session id>)
       [--thinking disabled | --max-thinking-tokens <n> --effort <level>
        --thinking-display summarized] [--mcp-config <tmp>]
       [--strict-mcp-config --setting-sources ""]   # hermetic mode
```

stdin stays **open** after the user message: the CLI sends permission
requests on stdout and expects answers on stdin mid-episode — and, since
0.7.0, the next turn's user message goes down the same stdin (see "One
process per pi session" below).

### Stream out

stdout is NDJSON. Five envelope types matter:

| Envelope          | Handling                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `stream_event`    | Raw Anthropic SSE — bridged 1:1 into pi stream events                                          |
| `assistant`       | Complete-block echo — used for CLI-side tool markers                                           |
| `user`            | Tool results the CLI feeds itself between cycles (markers with `PI_CLAUDE_CLI_TOOL_RESULTS=1`) |
| `control_request` | Permission prompt — answered on stdin                                                          |
| `result`          | Episode end: authoritative usage, final answer, errors                                         |

Two filters keep Claude Code's inner life out of pi's transcript: envelopes
with `parent_tool_use_id` set (the CLI's own sub-agents) are dropped, and
`tool_use` blocks for tools pi cannot execute are skipped by
`isPiKnownClaudeTool`.

## Episodes, not messages

**The single most important thing to understand.** One subprocess run is a
full agentic _episode_: N API calls ("cycles") with CLI-side tool
executions between them. SSE `content_block` indexes **reset every cycle**.

`event-bridge.ts` therefore keys tracked blocks by `(cycle, index)`. A
cycle counter increments on each top-level `message_start`; the previous
cycle's usage is banked at that moment, so per-cycle numbers accumulate
instead of overwriting. The final `result` envelope carries authoritative
cumulative usage and replaces the running sum when present. The **last**
cycle's `stop_reason` is the episode's stop reason.

Before this was understood, later-cycle content folded into earlier blocks,
usage reported roughly one cycle, and the final answer could be lost.

### Billed usage and context are different numbers (0.4.10)

`usage.input/output/cacheRead/cacheWrite` are **cumulative across cycles** —
that is what the account is charged for. `usage.totalTokens` is **not their
sum**: it carries the _last_ cycle's prompt size
(`input + cache_read + cache_creation`), because that is the only figure that
describes the conversation the model is actually holding.

The distinction is load-bearing, not cosmetic. pi's
`calculateContextTokens()` short-circuits on `totalTokens` and feeds it to
both the host's context gauge and `shouldCompact()`. Every cycle re-sends the
same cached prefix, so the sum counts that prefix once per cycle:

A repeated prefix is counted once in each cycle's billed usage, but only once
in the last cycle's context. A compaction boundary resets the context latch to
`postTokens`; `tests/multi-cycle.test.ts` and `tests/compaction.test.ts` cover
these contracts with synthetic data.

### Billing reads `modelUsage`, not `usage` (0.4.10)

`result.usage` describes the main agent, while `result.modelUsage` includes
sub-agent and helper-model usage. The bridge folds the latter when available.

Two caveats, both deliberate:

- Folded tokens are priced at the **session's** model rates. Exact for
  sub-agents, which inherit the session model; slightly off for a cheaper
  helper model, which is worth far less than the tokens it stops hiding.
- Older CLIs send no `modelUsage`. The bridge falls back to `result.usage`,
  and an empty object is treated as absent rather than as a zero bill.

### Thinking: the same request pi would send (0.10.0)

A pi thinking level reaches the model as the same request fields pi's own
Anthropic provider sends for it (pi-ai `streamSimple`). `thinking-config.ts`
mirrors that mapping:

| pi level      | Spawn flags                                                        | On a live process                                                     |
| ------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| off           | `--thinking disabled`                                              | `set_max_thinking_tokens 0`                                           |
| minimal … max | `--max-thinking-tokens B --effort E --thinking-display summarized` | `set_max_thinking_tokens B` + display, then `apply_flag_settings` `E` |

- **B** is pi's budget for the level (1,024 / 2,048 / 8,192 / 16,384; xhigh
  and max clamp to high), or the host's custom `thinkingBudgets`.
- **E** is the model's `thinkingLevelMap` entry when it names an effort,
  otherwise low / medium / high, as pi-ai's `mapThinkingLevelToEffort`.
- One flag set serves every model: budget models (Haiku 4.5, Opus 4.5,
  Sonnet 4.5) read the budget and ignore the effort; adaptive models read the
  effort and take any positive budget as "on". Verified on claude 2.1.283
  through a logging proxy; all four flags and both controls exist in 2.1.263,
  the pi-context floor.
- A model whose map says `off: null` gets no flags for `off`, the way pi-ai
  sends no `thinking` field there. pi does not offer `off` for those models.
- Levels offered: pi's map, less `minimal` on adaptive models. That equals
  what Claude Code's `initialize` reports per model (`supportedEffortLevels`,
  pinned in `tests/thinking-config.test.ts`). The report is not read at
  runtime: it adds nothing to pi's map, ignores `maxEffortLevel` limits, and
  its model list is Claude Code's picker rather than access (Opus 4.5 and
  Sonnet 4.5 are missing from it and run fine), so it cannot be used to hide
  models.
- `PI_CLAUDE_CLI_THINKING_DISPLAY=omitted` asks for no summaries. The default
  is `summarized`, as pi-ai's: billing counts the full thinking either way.

Before 0.10.0 only `--effort` was passed. Budget models ignored it and
thought with the CLI's 31,999-token default at every level, pi's `off` (which
pi passes as no level) reached the CLI as no flag, so Sonnet 5 ran adaptive
at effort `high`, and adaptive models streamed no thinking text because the
CLI's default display is `omitted`.

**Changing the level mid-session keeps the process.** Thinking is not part
of the reuse signature. Before writing a new user turn to a parked process,
`CliProcess.applyThinking` sends the control requests above, each with its
own `request_id`, and waits for every `control_response` (intercepted in
`handleLine`, never forwarded to an episode). If one is refused or not
answered within `THINKING_CONTROL_TIMEOUT_MS` (5 s), the process is retired
and a fresh one spawns with the new flags, so the turn is right either way.
`max_thinking_tokens` is always a number: on 2.1.263 an omitted value resets
the budget, on 2.1.283 it leaves it.

Claude Code reads thinking once per user turn. A change made while a tool
runs (a handoff) is not applied to the rest of that turn; it lands on the
next user turn, still on the same process. Verified live: a change sent
during a `sleep` tool call returned success, the continuation kept the old
budget, the next turn had the new one.

Cache cost is the API's: on adaptive models the effort and on/off state are
part of the prompt-cache key, so the first switch to a setting the session
has not used re-writes the prompt, and switching back reads it from cache.
Native pi pays the same, except on Opus 5, Opus 5.5 and Fable 5.1, where it
sends effort as mid-conversation messages behind a beta Claude Code does
not use.

`tests/live-thinking.test.ts` (`PI_OWNED_LIVE=1`) drives one pi session per
model through level changes and asserts, from the request bodies, that every
turn ran at the level set before it on exactly one CLI process.

### Effort maps 1:1, and never upward (0.4.12)

`--effort` used to be shifted up a rung for opus: `medium` became `high` and
`high` became `max`. That compensated for a cap the CLI no longer has, and it
made `high` unrequestable on opus at all.

The CLI accepts `--effort high`, `--effort xhigh` and `--effort max` as
distinct values.

Passing through the requested level also avoids unintentionally increasing effort.

Every level now passes through unchanged. `minimal` still floors at `low`
because the CLI has no effort rung below it (budget models get their own
1,024-token budget for it); that is a floor, and the invariant is
one-directional: **no level ever maps above what the host asked for**.

### Thinking blocks are materialized lazily (0.4.4)

Adaptive Claude models (fable-5, opus-5, sonnet-5) stream **encrypted**
thinking when the display is `omitted`, which is the CLI's default: a
multi-kilobyte `signature_delta` plus `thinking_delta` events whose text is
the empty string, and no plaintext ever. Haiku 4.5 sends plaintext either
way. Since 0.10.0 the provider asks for `summarized`, so every model streams
a summary, but `PI_CLAUDE_CLI_THINKING_DISPLAY=omitted` and thinking the
model chose to skip still produce signature-only blocks.

Materializing on `content_block_start` therefore produced thinking blocks
with a 3k signature and zero characters of text, which front-ends faithfully
render as a "thought" that expands to nothing. So a thinking block is now
created on the **first `thinking_delta` that actually carries text** — an
empty-string delta must not bring one into existence — and dropped at
`content_block_stop` if none ever arrived. A signature that precedes the
plaintext is buffered and applied on materialization, so genuine thinking
keeps its signature.

This is why `TrackedContentBlock` carries an explicit `contentIndex` instead
of a parallel-array invariant with `output.content`: a dropped block must not
shift the indexes of the blocks after it.

Sessions recorded before 0.4.4 still hold empty thinking blocks on disk
forever, so front-ends need their own guard regardless — a host skips them on
settled items.

## Tools: the three-way split

**Built-in name translation** (`tool-mapping.ts` is the single source of
truth): `Read→read` (`file_path→path`), `Write→write`, `Edit→edit`
(`old_string→oldText`, `new_string→newText`), `Bash→bash`, `Grep→grep`
(`head_limit→limit`), `Glob→find`. Claude proposes them under its names; pi
records their activity as markers; the CLI executes them natively.

**Custom pi tools** (anything a pi extension registered — a front-end's
artifact tools, MCP-adapter tools) cannot be renamed into Claude's
vocabulary, so they are advertised over MCP: `mcp-config.ts` writes every
non-built-in tool's schema to a temp file and points `--mcp-config` at
`mcp-schema-server.cjs`. Claude emits `mcp__custom-tools__<name>`; the bridge
strips the prefix and emits a pi `toolCall`; pi executes the real tool. The
server itself executes nothing: its `tools/call` handler forwards the request
over a local socket to `handoff-broker.ts` in pi's process and blocks until
pi has run the tool (0.7.0). Before that it could only refuse, and the
provider had to interrupt the CLI and resume a new process with the result
pasted in as user text — see "One process per pi session".

### The runtime directory and who may reach the broker

Anything that can reach the broker socket can ask pi to execute a tool, so the
socket is not a public surface. Every runtime artifact — the socket, the tool
schemas, each session's `--mcp-config`, each spawn's system prompt, the broker
secret — lives in one private per-process directory created by
`src/runtime-dir.ts`:

- `mkdtempSync(join(tmpdir(), "pi-claude-"))` — random name, mode `0700`, so
  the path cannot be derived from the pid and no other local user can traverse
  into it. Files inside are written `0600`, and the socket is `chmod`ded `0600`
  after bind (a bind honours the umask, so a stock `umask 022` box would
  otherwise leave it `0755`).
- Every request must carry the process's 32-byte `secret`, compared with
  `timingSafeEqual` **before** the session id reaches any routing table. The
  schema server receives the secret as a **file path**, never as a command-line
  argument: argv is world-readable through `ps` and `/proc`, which would hand
  the secret to exactly the user the directory mode keeps out.
- The directory is removed on exit. A `SIGKILL`ed process leaks it, but leaks a
  `0700` directory nobody else can open.

Until 0.8.2 these were pid-named files written straight into `os.tmpdir()` with
whatever the umask allowed — on Linux a `0755` socket and `0644` configs in a
world-readable `/tmp`, and the config names the socket and the CLI session id
(reported as agustinsacco/pi-claude-cli#35). macOS was unaffected in practice:
`TMPDIR` there is already a per-user `0700` directory.

Windows has no mode bits for a named pipe and Node exposes no ACL for one, so
there the random pipe name and the secret are the whole of the defence. That
asymmetry is why the secret check exists at all rather than relying on file
permissions alone.

**Everything else** — WebSearch, WebFetch, ToolSearch, `Task` sub-agents,
the user's own MCP servers — is executed **by the CLI itself**, mid-episode.
These are surfaced as one-line marker text blocks so transcripts show what
happened:

```
[Claude Code · WebSearch {"query":"news headline today 2026"}]
```

### The marker is a wire contract

Front-ends parse the marker string, so its shape is API:

```
[Claude Code · <ToolName>]              # no arguments
[Claude Code · <ToolName> <argsJson>]   # complete, parseable JSON
```

a host renders matches as activity rows and anything else as markdown prose,
so a format change that looks cosmetic here degrades rendering there.

`argsJson` is **complete JSON** as of 0.8.0, and `src/tool-markers.ts`
decides what goes in it. Before that it was `JSON.stringify(input)` cut at
120 characters: usually invalid JSON (so a consumer needed a fragment
scanner with its own escape decoder), cut at the END of values — so an
absolute path lost the filename, the one part a row shows — and easily
consumed whole by a single bulk argument (`Write`'s file contents, `Edit`'s
replacement, `Task`'s prompt). Now each tool contributes its identifying
arguments in priority order, values are clipped individually (paths from the
front, keeping the tail), bulk arguments are replaced by measurements
(`lines`, `bytes`, `edits`, and for `TodoWrite` the live item), and the
700-character budget is enforced by dropping trailing fields rather than by
cutting the document.

### Not yet surfaced (extension seams)

One thing the CLI reports is forwarded only on opt-in, and one is still
dropped:

- **Results of CLI-side tools — forwarded when `PI_CLAUDE_CLI_TOOL_RESULTS=1`.**
  The `user` envelopes between cycles carry `tool_result` blocks for tools the
  CLI executed itself. With the flag set, the call marker gains a
  `#<toolUseId>` tag and each result becomes a
  `[Claude Code · result #<toolUseId> {payload}]` marker
  (`handleUserEnvelope`), letting a front-end pair them and render CLI-side
  tools as expandable rows. The payload is complete JSON: `status`, the
  `tool` it answers, a printable `summary`, typed metrics, a capped `preview`
  and the full `length`. The metrics come from the CLI's own
  `tool_use_result` object — a read's `numLines`/`totalLines`, an edit's
  `structuredPatch`, a command's `stdout`/`stderr`/`interrupted`, a glob's
  `numFiles`, a failed command's exit code — so a row can say "419 lines" or
  "exit 1 · No such file" instead of just "ok". Only ids that produced a call
  marker are forwarded, so a handoff tool's replayed result (pi already has
  the real one) never renders twice. Without the flag the wire is unchanged:
  the id-tagged shapes are a contract change a consumer must know how to
  parse.
- **Sub-agent transcripts.** What a sub-agent actually did — its own tool
  calls and text — arrives with `parent_tool_use_id` set and is still
  filtered out in both `provider.ts` and `handleAssistantEnvelope`. Those
  events carry a full nested episode; a front-end that wanted a live
  sub-agent _tree_ would consume them there. Lifecycle and progress are
  surfaced (see below), so a consumer knows which agents ran, how long they
  took and what they cost — but not what they read or wrote.

### Sub-agent lifecycle rides its own channel (0.4.13)

Nested agent transcripts are filtered, so the provider uses the separate
lifecycle feed to make sub-agent activity visible without replaying its content.
The CLI publishes `system` envelopes with a `task_*` subtype. They arrive at **top level**
— `parent_tool_use_id` is null — even for agents nested several deep,
verified on claude 2.1.231 at spawn depth 2. `src/task-tracker.ts` folds
them, and the split is by durability:

| Envelope            | Where it goes                                    | Why                                                     |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `task_started`      | marker in the turn                               | durable: this agent ran                                 |
| `task_notification` | marker in the turn                               | durable: it finished, with tool count, tokens, duration |
| `task_progress`     | `onTaskProgress` → `claude-subagents` status key | ephemeral: fires once per sub-agent tool call           |
| `task_updated`      | `onTaskProgress`                                 | ephemeral status patch                                  |

Each tracked sub-agent contributes a start and a terminal marker. The
progress channel follows `claude-rate-limit`: state ABOUT the turn, never
folded into content, and never persisted.

`task_notification` carries the sub-agent's full report in `summary`. The
marker deliberately omits it — the model already receives it as the `Task`
tool's own result, and repeating it would duplicate kilobytes into every
later replay. The snapshot exposes `outputFile` instead, for a host that
wants the whole thing.

One honest limit remains. There is **no tree**: no task envelope names its
parent task, so a nested agent is indistinguishable from a top-level one and
the list is flat.

Two envelopes on this channel are **not** sub-agents, and both used to be
reported as ones:

- `task_started` carries `task_type`. The CLI auto-backgrounds a slow `Bash`
  into a `local_bash` task wearing the tool's own description. Only
  `local_agent` and `remote_agent` count. A
  missing `task_type` still counts, so an older CLI does not go silent.
- `task_notification` carries only `task_id` — no description, no
  `task_type`. A task started in an earlier episode notifies into a later
  one, and inventing a placeholder from the id emitted
  `{"status":"stopped","description":"example-task-001"}`. An id this
  episode never saw start is dropped.

Markers carry `task_id`, so a host can join `started` to `completed` rather
than matching on description. The description is clipped to 120 characters
before the whole-payload cap, because one long description used to eat the
preview and take `subagent_type` with it.

### The turn ends when the sub-agents do (0.4.14)

`Agent` backgrounds by default. The CLI answers such a call in milliseconds
with "Async agent launched successfully… you will be notified when it
completes", so the model ends its turn to wait — correctly, per its own tool
contract. The CLI then emits `result` for that turn **while the agents are
still running**, and this provider killed the subprocess on it.

The CLI can later emit a `task_notification`, resume the model, and produce
another `result` without another user prompt. Closing the process at the first
result would discard that pending work.

So while `pendingAgents()` is non-zero, a `result` is a cycle boundary, not
the end of the episode. `applyResult` per cycle stays correct because
`modelUsage` is cumulative for the CLI session, so the last snapshot wins
rather than summing cumulative snapshots.

Two timers bound the wait:

| Bound      | Default                | Reset by                          |
| ---------- | ---------------------- | --------------------------------- |
| inactivity | 300s of no stdout      | any output, incl. `task_progress` |
| wall clock | 15 min from first wait | never                             |

Both expiries end the turn on what it already has. An error there would
throw away the launch markers and the model's own words, which are real.
`PI_CLAUDE_CLI_NO_AGENT_WAIT=1` restores the old teardown;
`PI_CLAUDE_CLI_AGENT_WAIT_MS` moves the wall clock.

### Enforcement is belt-and-suspenders

The belt is `control-handler.ts`: custom-tools requests get
`{behavior:"deny"}` (so pi runs them), everything else `allow`. The
suspenders are the **handoff interrupt** in `provider.ts`: at the first
top-level `message_stop` after a HANDOFF `tool_use`
(`mcp__custom-tools__*` only), the provider sends the CLI's own `interrupt`
control request and freezes the stream until the result envelope arrives.
Built-in tools never trigger either mechanism — the CLI executes them
natively and pi renders the markers.

**Never SIGKILL a healthy turn.** A kill truncates the CLI's session file
before the assistant turn is written; every later `--resume` then splices a
synthetic `No response requested.` assistant turn into the replayed
transcript, which can affect subsequent model behavior. SIGKILL remains only as the abort
backstop (2s after an interrupt) and the post-result reaper.

### Empty arguments are `{}`, malformed arguments are the raw text

A handoff tool's arguments arrive as `input_json_delta` events and accumulate
into `partialJson`. A call with **no** arguments — `mcp({})`,
`artifact_list()` — produces no deltas at all, so the accumulator is still the
empty string when `content_block_stop` lands.

`event-bridge.ts` therefore treats empty and malformed as two different
things:

| accumulated payload                        | forwarded to pi                       |
| ------------------------------------------ | ------------------------------------- |
| `""` or whitespace                         | `{}`                                  |
| valid JSON object                          | the parsed object, after arg renaming |
| valid JSON non-object (`null`, `[]`, `12`) | the raw string                        |
| unparseable (truncated stream)             | the raw string                        |

The empty case must not fall into the parse-failure branch. `JSON.parse("")`
throws, and forwarding the raw `""` makes pi reject the call against the
tool's schema with `root: must be object` — which silently killed every
zero-argument handoff tool, including `mcp({})`, the documented first step for
checking MCP status.

The reverse is equally deliberate: a **non-empty** payload that cannot be used
is passed through as its raw string rather than coerced to `{}`. That text is
the only evidence of what actually arrived, and blanking it would turn a
visible failure into a tool that silently ran with no arguments.

## One process per pi session (0.7.0)

A persistent process avoids restarting the CLI between a proxied tool call
and its result, and allows later turns to reuse its warm prompt cache.
`src/cli-process.ts` therefore keeps the process:

- **Through a handoff.** The permission for `mcp__custom-tools__*` is now
  ALLOWED. The CLI calls `tools/call`; the schema server forwards it over the
  broker socket with the CLI session id, `_meta["claudecode/toolUseId"]` and
  the broker secret;
  pi's stream ends at `message_stop` with `stopReason: toolUse` exactly as
  before, pi runs the tool, and the next `streamSimple` call — whose delta is
  all unique toolResults for the awaited ids, optionally followed by user
  steers — attaches to the same process and answers the call. Trailing users
  go to the same stdin in one ordered, image-preserving UUID-tagged message.
  The CLI's default stream-json priority reads them once its running tools
  finish. A nonempty result must echo their UUID before turn-end reuse;
  missing confirmation retires the source. An earlier result or empty queued
  notification is not proof that the steer was consumed.
  Either order works: the call may arrive
  before pi's result (held as pending) or after (held as ready). The CLI
  transcript records a real `tool_result`; the rejected-tool /
  `[Request interrupted]` / `No response requested.` filler is gone.

  The `toolUseId` must name a `tool_use` block this process actually streamed
  and has not answered yet, and must ask for the tool that block named.
  Anything else is refused immediately. Before 0.8.2 an unmatched id was
  parked in `pending`, where nothing would ever deliver a result for it and
  the caller blocked until the MCP tool timeout — an hour by default. A
  sub-agent's nested custom-tool call lands here: pi never sees non-top-level
  `tool_use` ids, so it could never answer one. It now gets an error rather
  than a stall.

  A connection that sends no complete request within a minute is dropped
  (`HANDOFF_REQUEST_TIMEOUT_MS`). That bounds the request, not the call: once
  the request line arrives, the call stays open for as long as pi runs the
  tool, bounded only by the CLI's `MCP_TOOL_TIMEOUT` (an hour by default) and
  `PI_CLAUDE_CLI_HANDOFF_WAIT_MS`. Before 0.9.1 the timer kept running after
  the request, and under pi context every tool comes through here, `bash`
  included. So any tool slower than a minute (a build, a test suite) returned
  "pi closed the connection without a result" to the model while pi recorded
  the real output, and the next call usually had to respawn the process.

- **Across turns.** After `result` the process is parked
  until its prompt cache expires (last request + the longest TTL written:
  1h on the subscription CLI, else 5 min; `PI_CLAUDE_CLI_KEEPALIVE_MS`
  overrides). The next call whose delta
  is a user message writes it to the same stdin. The live persistent-process
  tests compare warm reuse with restarting the CLI.

Exactly one episode (pi call) is attached at a time; lines that arrive while
none is — a built-in tool's result during a handoff, a sub-agent event — are
buffered and replayed to the next episode. Permission requests are answered
attached or not. The process is retired (interrupt if a turn is live, then
stdin EOF, then SIGKILL after a grace) whenever the next call cannot use it:
different model/prompt mode/cwd, a thinking change the process refused
(see "Thinking"), a rewritten tool schema (`version`
bump — the CLI advertised the old surface at connect), a stale pi history, a
delta that is not the complete awaited tool results followed only by users,
unconfirmed steer consumption, or the idle timers
(`PI_CLAUDE_CLI_HANDOFF_WAIT_MS` for a handoff pi never answers). Retiring
falls back to the `--resume` path below, so nothing is lost — only the
cache-warm restart is.

**Billing across a long-lived process.** `result.usage` is per CLI turn, but
`result.modelUsage` — the figure the provider trusts, because it includes
sub-agents — is cumulative for the **process**. Each result is therefore
billed as the delta against the previous
result's totals, and a turn split across two episodes by a handoff is billed
once: the finishing episode reports the turn's delta net of what the first
episode already reported, floored at its own streamed cycles.

`PI_CLAUDE_CLI_HANDOFF_PROXY=0` restores the interrupt-and-resume handoff
(the schema server then answers `tools/call` with an error result). Without a
pi session id (print mode, tests) nothing is parked or proxied.

## Session model: one CLI session per pi session

pi's session JSONL is the **only** authoritative record; the CLI session is
the model's working memory. The sidecar map
`<package-state-dir>/session-map.json` (exact path in README;
`PI_CLAUDE_CLI_STATE_DIR` overrides; `src/session-map.ts`) links pi session
id → CLI session id, and
`sysprompt/<cliId>.txt` beside it holds the system prompt that session was
created with.

`PI_CLAUDE_CLI_EPHEMERAL=1` opts a one-shot out of all of it: the CLI runs with
`--no-session-persistence` and neither the pairing nor the prompt is recorded,
so every respawn in that pi session is a create/import and none is a resume.
Reuse of a parked process is unaffected — it needs no pairing.

When a matching CLI session cannot be resumed, the provider imports the
available pi history into a new CLI session.

Forks, model switches, copied machines and lost sidecars all collapse into
one recovery path: a single full-history import. Never a lost turn.

### The delta anchor is load-bearing (0.4.6)

`buildResumePrompt` anchors on the **last assistant message** and sends only
what follows it. It must not anchor on the last _user_ message: pi's tool
loop appends `[user, assistant(toolUse), toolResult, assistant(toolUse),
toolResult, …]`, so the single `user` entry stays at index 0 for the life of
the loop, and anchoring there replays the whole transcript on **every
iteration** — content the CLI already holds.

The delta begins after the last assistant entry, including any later tool
results or user messages that the CLI has not yet received.

The invariant to preserve: **delta size stays flat as the tool loop
deepens.** If a change makes the resume prompt grow with conversation
length, it has regressed.

## Errors and recovery

- Any `result` with a non-success subtype, `is_error`, or an error field
  ends pi's stream as an error (never a silent empty message).
- **Context overflow** is rewritten by a provider-scoped `message_end`
  handler (`overflow.ts`) to the `context_length_exceeded:` prefix pi's
  auto-compaction recognizes — so pi compacts and retries instead of
  failing. The matcher is deliberately narrow (Anthropic's two overflow
  phrasings) and never touches rate limits, which must stay on pi's
  retry/backoff path.
- An inactivity timer (default 300s, `PI_CLAUDE_CLI_TIMEOUT_MS`) kills hung
  subprocesses. It is generous because CLI-side tools are legitimately
  silent on stdout for minutes.
- pi's abort signal SIGKILLs mid-stream; a process registry cleans up
  orphans at exit.

## Usage and cost

Usage comes from `message_start` / `message_delta` per cycle and the
`result` envelope for the episode total, then runs through pi's own
`calculateCost`. **Token counts are real; the dollar figure is notional** —
it is computed at API list prices while the user is actually spending plan
quota.

## Account state: rate limits (0.4.5)

The CLI emits a `rate_limit_event` envelope describing the **account's**
plan window. This is not turn content and must never become any: it says
nothing about the answer being streamed, and folding it into the message
would put account state into the user's transcript and into pi's session
file. It travels a separate path end to end:

```
provider.ts   rate_limit_event → options.onRateLimit(info)   (never touches pi's stream)
index.ts      publishRateLimit → ctx.ui.setStatus("claude-rate-limit", json)
front-end     reads the status key, renders it however it likes
```

The key is **`claude-rate-limit`** — deliberately neutral rather than
namespaced to any one front-end, since it is account state any pi front-end
can use. The payload is JSON:

```jsonc
{
  "status": "allowed", // "rejected" once the window is capped
  "resetsAt": 1700003600, // example unix seconds
  "rateLimitType": "five_hour",
  "overageStatus": "rejected",
  "isUsingOverage": false,
  "observedAt": 1700000000,
} // when we saw it, not from the CLI
```

Two behaviors worth knowing before you build on it. The CLI repeats the
event **every turn**, so `publishRateLimit` pushes only when the payload
changes (comparing with `observedAt` stripped) — a status that rewrites
itself constantly is noise for whatever renders it. And `session_start`
stashes its `ctx` in module scope, because the stream runs deep inside
`streamSimple`, which has no `ExtensionContext` of its own.

**What this does not carry: utilization percentages.** The "12% of your 5-hour
limit" figures in Claude Code's own TUI come from
`anthropic-ratelimit-unified-*` **response headers**, which the CLI consumes
in-process and never forwards to stdout. So a consumer can honestly say
_when capacity returns_ and whether the account is capped or on overage —
never _how much is left_. Getting the percentages would mean making
authenticated Anthropic requests outside the CLI, which is exactly the line
this extension exists not to cross.

## Environment bleed

Unless hermetic mode is on, the subprocess runs in the user's full Claude
Code environment: personal/project MCP servers load and execute CLI-side,
hooks fire, project CLAUDE.md and memory are injected by the CLI, and skills
can load twice (natively via claude, and again via pi's own
`~/.claude/skills` support). `PI_CLAUDE_CLI_HERMETIC=1` adds
`--strict-mcp-config` and an empty `--setting-sources` to shut all of that
off; the schema-only custom-tools server and the subscription login are
unaffected.

## Compatibility notes

The CLI's control protocol changed between major lines. Claude Code **2.x**
expects `request_id` **inside** `response`, and allow decisions carry
`updatedInput`:

```jsonc
{ "type": "control_response",
  "response": { "subtype": "success", "request_id": "…",
                "response": { "behavior": "allow", "updatedInput": { … } } } }
```

The 1.x shape (`request_id` at the top level) is **silently ignored** by
2.1.x: the CLI keeps waiting, the episode stalls until the inactivity timer
fires, and the turn looks truncated. This was the root cause behind every
"web search / MCP turn returns only the preamble" report.

## Version history of behavioral fixes

| Version | Change                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.4.0   | Port to `@earendil-works` pi 0.84; api-registry registration; scoped release                                                                                                                                          |
| 0.4.1   | 2.x control protocol; cycle-aware bridge (ordering, cumulative usage, final-answer safety net); CLI-side tool markers; 300s timeout                                                                                   |
| 0.4.2   | Resume-miss → one full-replay retry (fixes forked sessions)                                                                                                                                                           |
| 0.4.3   | Overflow → `context_length_exceeded` rewrite (pi auto-compaction); hermetic mode                                                                                                                                      |
| 0.4.4   | Lazy thinking materialization (no empty blocks for encrypted thinking); explicit `contentIndex` per tracked block                                                                                                     |
| 0.4.5   | `rate_limit_event` → `claude-rate-limit` status key for front-ends                                                                                                                                                    |
| 0.4.6   | Resume delta anchors on the last **assistant** message — stops full-transcript replay on every tool iteration                                                                                                         |
| 0.4.9   | `utilization` on `claude-rate-limit` (percentage of the binding window)                                                                                                                                               |
| 0.4.10  | `usage.totalTokens` = last cycle's prompt, not the summed cycles (fixes inflated context gauges and premature auto-compaction); billing reads `modelUsage`, so sub-agent spend is no longer invisible                 |
| 0.4.12  | `--effort` maps 1:1 for every model; the opus up-shift (`high`→`max`) is gone, so a host asking for `high` gets `high`                                                                                                |
| 0.4.13  | Sub-agent lifecycle surfaced: `task_started`/`task_notification` as markers, `task_progress` on the `claude-subagents` status key                                                                                     |
| 0.4.14  | Background sub-agents run to completion and report back (a `result` with agents pending is a cycle, not the end); non-agent tasks and orphan notifications no longer reported as agents; `AskUserQuestion` disallowed |
| 0.4.15  | System prompt re-sent on `--resume` (the CLI drops it), replayed verbatim from the sidecar so the cached prefix survives                                                                                              |
| 0.4.16  | System prompt passed via the `-file` flag variants — the unsuffixed flags take a literal string, so pi's instructions had never reached the model                                                                     |
| 0.5.0   | `--autocompact 200000` by default (`PI_CLAUDE_CLI_AUTOCOMPACT`)                                                                                                                                                       |
| 0.5.1   | `PI_CLAUDE_CLI_STRICT_MCP`; the tool schema follows pi's registry instead of freezing at turn 1                                                                                                                       |
| 0.5.2   | A tool call with no arguments reaches pi as `{}`                                                                                                                                                                      |
| 0.6.0   | CLI-side tool results forwarded as paired `result` markers (`PI_CLAUDE_CLI_TOOL_RESULTS=1`)                                                                                                                           |
| 0.6.1   | A `result` with no content and no tokens (the CLI answering its own queued task notification) is a cycle boundary, not the turn's end                                                                                 |
| 0.7.0   | One CLI process per pi session: custom-tool calls proxied through the MCP server instead of interrupt-and-resume, process parked between turns — no more full-context re-bill after a commit or branch rename         |

## Testing

- `npm test` — unit suites with mocked `cross-spawn`; includes
  `tests/fixtures/multi-cycle-episode.jsonl`, a **synthetic 3-cycle
  episode** (claude 2.1.237) used to assert ordering, markers, and both
  usage modes; `tests/persistent-cli.test.ts` drives two pi calls through one
  mocked process (proxied handoff, turn continuation, delta billing, every
  retire condition); `tests/schema-server-proxy.test.ts` runs the real
  `mcp-schema-server.cjs` against a fake broker socket.
- `npm run test:e2e` — full pipeline through a real `pi` binary against a
  deterministic CLI stub (`tests/e2e/claude-stub.cjs`); no credentials.
- This tree does not include CI workflows; run these checks locally on each target OS.
- `scripts/e2e-live.sh` (= `PI_CLAUDE_CLI_LIVE=1 vitest run
tests/live-observer.test.ts`) — live observer-mode suite against the real
  CLI; spends plan quota, so it is opt-in. `PI_CLAUDE_CLI_LIVE=1 npx
vitest run tests/live-persistent.test.ts` proves the 0.7.0 cache properties
  (one process through a handoff and a commit; the legacy path re-billing
  after the same commit) using usage reported by the live CLI. Covers: a native multi-tool
  turn, a cheap resume of the same CLI session (asserts cacheRead > 5k and
  cacheWrite < 2k), the custom-tool handoff round-trip, a PreToolUse guard
  hook blocking an out-of-workspace read, and abort/steer + resume.
