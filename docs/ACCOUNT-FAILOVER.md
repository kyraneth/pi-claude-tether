# Automatic account failover (opt-in)

> Opt-in only: automatic failover is OFF unless `PI_CLAUDE_TETHER_FAILOVER=1`.
> When off, a rejected subscription limit fails the turn exactly as before —
> no replay, no exhaustion is recorded, and no exhaustion file is consulted.
> Manual profile selection (`PI_CLAUDE_TETHER_ACCOUNT`, see README) works with
> or without this gate.

When a Claude subscription hits its limit mid-session, Pi 1.4.0 does not
retry: its classifier treats subscription-limit errors ("You've hit your
weekly limit · resets …", "You've hit your session limit · resets …") as
non-retryable, so the turn simply fails. With this gate on, the provider
itself moves that one request to the next healthy account instead of failing
the turn.

## Eligibility: the observed production shape only

A failover happens only when ALL of these hold for the current attempt:

- the CLI emitted a `rate_limit_event` with status `"rejected"` and a finite
  `resetsAt` (the structured signal, not error-text matching);
- the turn then failed having emitted NO assistant content and NO `tool_use`
  (the observed rows are zero-output `result_error`s);
- no handoff tool was delivered this turn (mode is not `handoff`, no
  unconfirmed handoff results pending).

If anything was emitted or a tool was handed off, the turn fails exactly as
before — a replay could double-execute a tool or present content the user
never saw answered. A rejection that arrives after a tool call, or after any
prose, never replays.

A turn billed to overage usage credits never replays onto another account
either: the usage-credit guard fails it before failover is considered (see
README "Usage credits (overage) guard").

## Mechanism

1. The failing account is marked exhausted until the `resetsAt` the CLI
   itself reported — one small JSON file per account under the existing
   state dir (`PI_CLAUDE_TETHER_STATE_DIR` or the package state dir from README,
   `account-exhausted-<name>.json`), written atomically (write + rename).
   No lock; values come from CLI events and the last writer wins.
2. The process is retired and the same request is re-run on the first
   account in `PI_CLAUDE_TETHER_ACCOUNTS` order that is neither exhausted nor
   already tried in this provider call, with a full history import, inside
   the same provider call — reusing the existing replay machinery, so pi
   sees a single turn. The tried set lives in memory and bounds the loop:
   each iteration tries a new account, so the call ends after at most one
   attempt per declared account with the all-exhausted error — even when a
   `resetsAt` is stale or an exhaustion write silently failed. The
   persisted files stay the cross-call signal only.
3. No switch-back mid-warm-process: a parked process keeps serving until it
   retires naturally. At the next spawn, selection returns to earlier
   accounts on its own once their exhaustion has expired.
4. If every account is exhausted, the turn fails with the original CLI
   error plus the per-account reset times.

## Expiry and limits

The only clock is the CLI-reported `resetsAt` (unix seconds, compared
against the current time). Nothing here invents a timeout, count,
threshold or budget — a rejected window without a usable `resetsAt` fails
the turn as before rather than guessing an expiry.

## Visibility

- The `claude-rate-limit` status payload and every request-ledger row
  carry the account NAME (never the config path) when multiple profiles
  are declared. Single-profile payloads and ledgers are unchanged.
- The startup auth probe checks every declared profile under its own
  `CLAUDE_CONFIG_DIR`, and the login hint names the exact directory that
  needs `CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai`.

## Cost and terms notes

The prompt cache is per account: a failover costs a full context reimport
plus a cache write on the other account. Users must check Anthropic's
current consumer terms themselves before enabling automatic failover
across subscriptions.

## Proof

Unit: `tests/accounts.test.ts` (parsing, selection, exhaustion expiry) and
`tests/account-failover.test.ts` (failover fires only with the gate on and
only for zero-output rejections; failover env unset → no replay; tool and
content cases → no replay; all-exhausted error). End to end: the
continuity-proof failover scenario (real installed Pi RPC, stub CLI
rejecting under the default profile and answering under account `b`).
