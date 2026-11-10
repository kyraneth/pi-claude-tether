# Architecture

Pi owns the prompt, tools, conversation, compaction and retry policy. Claude Code owns subscription authentication and model transport. There is no CLI-owned context mode in 0.12.0.

## Request path

`index.ts` registers provider and API identity `pi-claude-tether`. `src/provider.ts` projects Pi's current context, stages the active tool schemas, and sends user content through the official CLI's stream-json interface. The MCP server remains `custom-tools`: model tool names are `mcp__custom-tools__<name>`, independent of the provider identity. Tool receipts bind tool IDs and canonical content, not the old provider name.

The CLI runs with native tools disabled and session persistence disabled. All tools execute in Pi through the authenticated handoff broker. The provider validates tool-result echoes before acknowledging consumption; unknown consumption retires the process rather than replaying tools.

## Disposable process cache

A warm process belongs to one Pi session, account, model and launch configuration. Its acknowledged history prefix must match Pi's current history. Changed prompts, tools, branch history, compaction or account selection retire it and import Pi's authoritative context again. Restarting Pi does not resume a hidden Claude transcript.

Thinking changes are applied through CLI control requests on the next user turn; a refused update retires the process. Cancellation drains the CLI turn and retains safe cache continuity. Settled transient errors return to Pi's retry policy without an adapter retry loop.

## State ownership

Package data, Claude account profiles and ledger directories remain under `pi-claude-tether`; the provider rename does not move credentials or user data. Temporary prompt/MCP files are private and cleaned up on retirement/exit. Historical session maps and saved prompt sidecars do not enable a compatibility mode.

See [Context policy](CONTEXT-POLICY.md), [technical details](DETAILS.md), [account failover](ACCOUNT-FAILOVER.md) and [request ledger](REQUEST-LEDGER.md) for the full contracts.
