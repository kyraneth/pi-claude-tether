#!/usr/bin/env bash
# End-to-end smoke through a real `pi` binary using the deterministic Claude
# CLI stub — no credentials or network model calls needed.
#
# Exercises: extension load, provider + api-registry registration (the print
# mode path from rchern/pi-claude-cli#32), subprocess spawn, stream-json
# NDJSON parsing, and the event bridge.
#
# Requires `pi` on PATH (npm i -g @earendil-works/pi-coding-agent).
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

STUB_DIR="$(mktemp -d)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR" "$WORK_DIR"' EXIT

# Fail closed: this smoke must never reach a real, logged-in Claude CLI. In Pi
# context the adapter prepends a package-local CLI under $HOME ahead of PATH.
# Run under a disposable HOME with the stub installed at that path too,
# unset Claude config/auth overrides, and require the stub's own
# invocation record after every run.
TEST_HOME="$WORK_DIR/home"
# Package-derived stub prefix: this tree's own data dir under the disposable
# HOME (scripts/package-dirs.sh reads this tree's package.json name).
PCC_PKG_DIR="$EXT_DIR" PCC_HOME="$TEST_HOME" . "$EXT_DIR/scripts/package-dirs.sh"
PRIVATE_BIN="$PCC_DATA_DIR/cli/node_modules/.bin"
mkdir -p "$PRIVATE_BIN"
# The stub itself may come from a checkout when the installed copy under
# test carries no tests/ directory (npm files manifest).
STUB_CJS="${CLAUDE_STUB_CJS:-$EXT_DIR/tests/e2e/claude-stub.cjs}"
INVOKED="$STUB_DIR/invoked"
cat >"$STUB_DIR/claude" <<WRAP
#!/usr/bin/env bash
echo "\$\$" >>"$INVOKED"
exec node "$STUB_CJS" "\$@"
WRAP
chmod +x "$STUB_DIR/claude"
cp "$STUB_DIR/claude" "$PRIVATE_BIN/claude"
unset CLAUDE_CONFIG_DIR ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN XDG_STATE_HOME XDG_CONFIG_HOME XDG_DATA_HOME

# Owned-engine selection: resolve the npm-installed devDependency engine via
# scripts/resolve-pi-cli.mjs (public module resolution plus that package's
# `bin` field; `<cli> --version` must equal the SDK manifest version). An
# explicit PI_BIN stays as an override only after the same `--version` check.
# There is no `which pi` fallback and no skip: a missing or mismatched engine
# fails with a named cause ([owned-pi-engine-unavailable] /
# [owned-pi-engine-version-mismatch]).
if [ -n "${PI_BIN:-}" ]; then
  PI_BIN="$(node "$EXT_DIR/scripts/resolve-pi-cli.mjs" --pi-bin "$PI_BIN")"
else
  PI_BIN="$(node "$EXT_DIR/scripts/resolve-pi-cli.mjs")"
fi
[ -n "$PI_BIN" ] || { echo "e2e FAILED: [owned-pi-engine-unavailable] resolve-pi-cli produced no path" >&2; exit 1; }
[ -x "$PI_BIN" ] || { echo "e2e FAILED: [owned-pi-engine-unavailable] owned Pi engine not executable: $PI_BIN" >&2; exit 1; }
echo "pi: $PI_BIN version: $("$PI_BIN" --version 2>/dev/null || true)"

require_stub() {
  if [ ! -s "$INVOKED" ]; then
    echo "e2e FAILED: the Claude stub was not invoked; refusing to trust output from another CLI" >&2
    exit 1
  fi
  : >"$INVOKED"
}

# macOS has neither `timeout` nor `gtimeout` unless coreutils is installed, so
# the guard is best-effort: supported systems get a watchdog; others run directly.
# `${TIMEOUT[@]+...}` because bash 3.2 (macOS) treats an empty array as unbound
# under `set -u`.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout 120)
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout 120)
else
  TIMEOUT=()
fi
# `-ne` is load-bearing, not tidiness: a developer whose pi settings already
# list `npm:@saccolabs/pi-claude-cli` gets the INSTALLED copy discovered
# alongside `-e`, and the published provider wins the name. The suite then
# silently tests the release instead of the working tree. Disable extension
# auto-discovery so the smoke test exercises only this checkout.
run_pi() {
  # `</dev/null` because print mode still reads stdin: inherit a pipe that
  # never closes (a CI runner, an agent shell) and pi waits on EOF forever.
  cd "$WORK_DIR" && HOME="$TEST_HOME" PI_CLAUDE_CLI_KEEPALIVE_MS=0 PATH="$STUB_DIR:$PATH" ${TIMEOUT[@]+"${TIMEOUT[@]}"} \
    "$PI_BIN" -ne -e "$EXT_DIR" -p --model "pi-claude-cli/claude-haiku-4-5" "$1" \
    </dev/null
}

OUT="$(run_pi "magic word")"
require_stub

echo "--- pi output ---"
echo "$OUT"
echo "-----------------"

if ! grep -q "PORT-OK" <<<"$OUT"; then
  echo "e2e FAILED: expected PORT-OK in output" >&2
  exit 1
fi

# Background sub-agents must survive the turn's first `result`. The stub emits
# one there and only reports the agent afterwards, so a provider that kills on
# it prints LAUNCHED-WAITING and nothing else.
FAN="$(PI_CLAUDE_CLI_CONTEXT=legacy run_pi "fanout")"
require_stub

echo "--- fan-out output ---"
echo "$FAN"
echo "----------------------"

if ! grep -q "AGENT-REPORT" <<<"$FAN"; then
  echo "e2e FAILED: sub-agent never reported back (killed on the first result)" >&2
  exit 1
fi
if ! grep -q "Dig into the thing" <<<"$FAN"; then
  echo "e2e FAILED: expected a sub-agent lifecycle marker" >&2
  exit 1
fi
if grep -q "Search for a local checkout" <<<"$FAN"; then
  echo "e2e FAILED: an auto-backgrounded Bash was reported as a sub-agent" >&2
  exit 1
fi
# pi's thinking level must reach the CLI as the flags pi's own Anthropic
# provider would send: off as thinking disabled (pi passes no level for off),
# anything else as budget + effort + summaries.
ARGV_FILE="$WORK_DIR/argv.jsonl"
run_thinking() {
  : >"$ARGV_FILE"
  cd "$WORK_DIR" && HOME="$TEST_HOME" CLAUDE_STUB_ARGV_FILE="$ARGV_FILE" PI_CLAUDE_CLI_KEEPALIVE_MS=0 PATH="$STUB_DIR:$PATH" ${TIMEOUT[@]+"${TIMEOUT[@]}"} \
    "$PI_BIN" -ne -e "$EXT_DIR" -p --model "pi-claude-cli/claude-haiku-4-5" --thinking "$1" "magic word" \
    </dev/null >/dev/null
  require_stub >&2
  grep -- '--input-format' "$ARGV_FILE" | tail -1
}
OFF_ARGV="$(run_thinking off)"
HIGH_ARGV="$(run_thinking high)"
echo "--- thinking argv ---"
echo "off:  $OFF_ARGV"
echo "high: $HIGH_ARGV"
echo "---------------------"
if ! grep -q '"--thinking","disabled"' <<<"$OFF_ARGV" || grep -q -- '--effort' <<<"$OFF_ARGV"; then
  echo "e2e FAILED: pi's off did not reach the CLI as --thinking disabled" >&2
  exit 1
fi
if ! grep -q '"--max-thinking-tokens","16384","--effort","high","--thinking-display","summarized"' <<<"$HIGH_ARGV"; then
  echo "e2e FAILED: pi's high did not reach the CLI as budget 16384 + effort high + summaries" >&2
  exit 1
fi
# Native Pi sends a steer after its tool result, then a follow-up.
# Keep the CLI parked using its existing cache-derived lifetime (no test cap).
STEER_TRACE="$WORK_DIR/steer.jsonl"
STEER_STATE="$WORK_DIR/steer-state"
STEER_OUT="$(cd "$WORK_DIR" && HOME="$TEST_HOME" XDG_STATE_HOME="$STEER_STATE" \
  CLAUDE_STUB_STEER_TRACE="$STEER_TRACE" PATH="$STUB_DIR:$PATH" ${TIMEOUT[@]+"${TIMEOUT[@]}"} \
  "$PI_BIN" -ne -e "$EXT_DIR" -e "$EXT_DIR/tests/e2e/steer-extension.ts" \
  --mode json -p --model "pi-claude-cli/claude-haiku-4-5" "FIXTURE-START" </dev/null)"
require_stub
echo '--- native Pi steering + warm follow-up ---'
node - "$STEER_TRACE" "$STEER_STATE/$PCC_STATE_LEAF/retire.log" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const rows = path => fs.readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const trace = rows(process.argv[2]);
assert.equal(trace.filter(r => r.kind === 'spawn').length, 1);
assert.equal(new Set(trace.map(r => r.pid)).size, 1);
assert.deepEqual(trace.map(r => r.kind).sort(), ['followup', 'spawn', 'steer', 'tool_result']);
const ledger = rows(process.argv[3]);
assert.deepEqual(ledger.filter(r => r.type === 'episode_start').map(r => r.triggerMode), ['spawn', 'handoff', 'turn']);
assert.equal(ledger.filter(r => r.type === 'process_spawn').length, 1);
assert.equal(ledger.filter(r => r.type === 'request').length, 3);
assert.ok(!ledger.some(r => r.type === 'retire' && r.reasons.some(reason => ['historyMismatch', 'handoffDeltaNotContinuable', 'steer_unconfirmed'].includes(reason))));
console.log('steer: one real Pi session / CLI process, spawn → handoff+steer → warm follow-up');
NODE
if ! grep -q 'STEER-OK' <<<"$STEER_OUT" || ! grep -q 'FOLLOWUP-OK' <<<"$STEER_OUT"; then
  echo "e2e FAILED: missing steer or warm follow-up answer" >&2
  exit 1
fi
echo "e2e OK"
