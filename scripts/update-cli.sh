#!/usr/bin/env bash
#
# Staged, self-tested Claude Code CLI update for pi-claude-tether.
#
# Installs the requested version into a staging prefix, probes it
# (version + a logged-out spawn-flags smoke in a sandbox HOME with no
# credentials), runs the stub e2e against it (the stub reports the
# candidate's real version string, so the provider's version gating runs
# against the candidate with zero live calls), and only then swaps the
# private CLI dir, keeping the previous one for rollback.
#
# Nothing here burns subscription spend: the sandbox HOME has no login, the
# smoke asserts the spawn fails on authentication (not on flag parsing),
# and the e2e uses the deterministic CLI stub under a disposable HOME.
#
# Usage:
#   scripts/update-cli.sh --version 2.1.310 [--target DIR] [--staging DIR]
#                          [--output-dir DIR] [--skip-e2e] [--yes]
#
# Defaults: --target is this package's real private install (derived from
# the package's own package.json name via scripts/package-dirs.sh, so the
# public tree targets its own pi-claude-tether prefix). Prove on a scratch
# prefix with an explicit --target (and --output-dir) instead; see docs/DETAILS.md.
set -euo pipefail

PCC_PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$PCC_PKG_DIR/scripts/package-dirs.sh"

VERSION=""
TARGET="$PCC_CLI_TARGET"
STAGING=""
OUTPUT_DIR=""
RUN_E2E=1
YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --staging) STAGING="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --skip-e2e) RUN_E2E=0; shift ;;
    --yes) YES=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "usage: update-cli.sh --version <semver> [--target DIR] [--staging DIR] [--output-dir DIR] [--skip-e2e] [--yes]" >&2
  exit 2
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "refusing non-semver version: $VERSION" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Stage on the target's filesystem: the swap below is a same-filesystem
# rename (atomic), never a cross-filesystem copy that an interruption or a
# full disk could leave half-written.
mkdir -p "$(dirname "$TARGET")"
# Cleanup is armed before anything is staged: every exit that did not finish
# a verified swap restores the previous install if the target went missing
# and removes staging this script created (a caller's --staging is kept).
OWN_STAGING=0
FINAL_STAGING=""
SWAP_DONE=0
SMOKE_HOME="" SMOKE_PROMPT="" SMOKE_ERR="" SMOKE_OUT=""
restore_prev() {
  if [[ $SWAP_DONE -eq 0 && ! -e "$TARGET" && -e "$TARGET.prev" ]]; then
    echo "    restoring $TARGET from $TARGET.prev" >&2
    mv "$TARGET.prev" "$TARGET" || true
  fi
  return 0
}
cleanup_on_exit() {
  if [[ $SWAP_DONE -eq 0 ]]; then
    restore_prev
    if [[ -n "$FINAL_STAGING" && -e "$FINAL_STAGING" ]]; then rm -rf "$FINAL_STAGING" || true; fi
    if [[ $OWN_STAGING -eq 1 && -n "$STAGING" && -e "$STAGING" ]]; then rm -rf "$STAGING" || true; fi
  fi
  for f in "$SMOKE_HOME" "$SMOKE_PROMPT" "$SMOKE_ERR" "$SMOKE_OUT"; do
    if [[ -n "$f" ]]; then rm -rf "$f" || true; fi
  done
}
trap cleanup_on_exit EXIT
trap 'echo "interrupted; target: $TARGET" >&2; exit 130' INT
trap 'echo "terminated; target: $TARGET" >&2; exit 143' TERM
if [[ -z "$STAGING" ]]; then
  STAGING="$(mktemp -d "$(dirname "$TARGET")/.staging-XXXXXX")"
  OWN_STAGING=1
else
  mkdir -p "$STAGING"
fi
if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pcc-cli-qualify-XXXXXX")"
  rmdir "$OUTPUT_DIR"
fi

CANDIDATE="$STAGING/node_modules/.bin/claude"

echo "==> installing @anthropic-ai/claude-code@$VERSION into $STAGING"
npm install --prefix "$STAGING" --no-save --no-audit --no-fund "@anthropic-ai/claude-code@$VERSION"

echo "==> version probe: $CANDIDATE --version"
REPORTED="$("$CANDIDATE" --version)"
echo "    reported: $REPORTED"
if [[ "$REPORTED" != "$VERSION"* ]]; then
  echo "refusing: candidate reports '$REPORTED', wanted '$VERSION'" >&2
  exit 1
fi

# Spawn-flags smoke: run the candidate the way the provider does (print
# mode with the stream-json subset that must still parse), logged out, in a
# sandbox HOME with no credentials and no network-dependent state.
# Expected: failure naming authentication, never an unknown-flag error.
echo "==> logged-out spawn-flags smoke (sandbox HOME, no credentials)"
SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/pcc-cli-smoke-XXXXXX")"
SMOKE_PROMPT="$(mktemp "${TMPDIR:-/tmp}/pcc-cli-smoke-prompt-XXXXXX")"
printf "" > "$SMOKE_PROMPT"
SMOKE_ERR="$(mktemp "${TMPDIR:-/tmp}/pcc-cli-smoke-err-XXXXXX")"
SMOKE_OUT="$(mktemp "${TMPDIR:-/tmp}/pcc-cli-smoke-out-XXXXXX")"
set +e
# A real NDJSON user turn, as the provider writes it: with an empty stdin
# the CLI sees no turn and exits 0 having proven nothing about the flags.
printf '%s\n' '{"type":"user","message":{"role":"user","content":"ping"}}' \
  | env -i PATH="/usr/bin:/bin" HOME="$SMOKE_HOME" DISABLE_AUTOUPDATER=1 \
  "$CANDIDATE" -p --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages --model claude-haiku-4-5 \
  --strict-mcp-config --system-prompt-file "$SMOKE_PROMPT" \
  >"$SMOKE_OUT" 2>"$SMOKE_ERR"
SMOKE_CODE=$?
set -e
SMOKE_TEXT="$(cat "$SMOKE_OUT" "$SMOKE_ERR")"
echo "    exit: $SMOKE_CODE"
echo "    output (first 5 lines):"
echo "$SMOKE_TEXT" | head -5 | sed 's/^/      /'
if [[ $SMOKE_CODE -eq 0 ]]; then
  echo "refusing: logged-out smoke unexpectedly succeeded" >&2
  exit 1
fi
if echo "$SMOKE_TEXT" | grep -qiE "unknown (option|flag|argument)|error: unknown|unrecognized"; then
  echo "refusing: candidate rejects the provider's spawn flags" >&2
  exit 1
fi
if ! echo "$SMOKE_TEXT" | grep -qiE "login|auth|logged ?in|credential|api key|oauth|token"; then
  echo "refusing: smoke failed for a reason other than missing login:" >&2
  echo "$SMOKE_TEXT" | head -20 >&2
  exit 1
fi

if [[ $RUN_E2E -eq 1 ]]; then
  echo "==> stub e2e against the candidate (stub reports $VERSION; zero live calls)"
  # Engine selection for the qualification proof.
  #
  # This script ships in the public package and runs on user machines with
  # no devDependencies. Prefer the owned devDependency engine when this
  # checkout resolves one (scripts/resolve-pi-cli.mjs: public module
  # resolution plus the SDK package's `bin` field, `<cli> --version` must
  # equal the SDK manifest version). Otherwise use the user's installed `pi`
  # and print which one and why. Only this updater selects the explicit
  # installed-engine stub-qualification route; fixtures stay strict.
  PROOF_PI_FLAG=--pi-bin
  if OWNED_PI_BIN="$(env -u PI_BIN node "$SOURCE_DIR/scripts/resolve-pi-cli.mjs" --package-dir "$SOURCE_DIR" 2>/dev/null)"; then
    if [[ -n "${PI_BIN:-}" ]]; then
      PI_BIN="$(node "$SOURCE_DIR/scripts/resolve-pi-cli.mjs" --package-dir "$SOURCE_DIR" --pi-bin "$PI_BIN")"
      echo "    pi: explicit PI_BIN override $PI_BIN (version-checked against the owned SDK)"
    else
      PI_BIN="$OWNED_PI_BIN"
      echo "    pi: owned devDependency engine $PI_BIN"
    fi
  else
    PROOF_PI_FLAG=--installed-pi-bin
    if [[ -n "${PI_BIN:-}" ]]; then
      PI_BIN="$(realpath -e "$PI_BIN")"
      echo "    pi: explicit installed PI_BIN $PI_BIN (no owned devDependency engine in this tree; proof checks installed version)"
    else
      PI_BIN="$(which -a pi | grep -v '/node_modules/.bin/' | head -1 || true)"
      if [[ -z "$PI_BIN" ]]; then
        echo "refusing: no owned devDependency engine and no pi binary on PATH" >&2
        exit 1
      fi
      PI_BIN="$(realpath -e "$PI_BIN")"
      echo "    pi: user installed pi $PI_BIN (no owned devDependency engine in this tree; proof checks installed version)"
    fi
  fi
  CONTINUITY_STUB_VERSION="$VERSION" \
  python3 "$SOURCE_DIR/scripts/continuity-proof.py" \
    "$PROOF_PI_FLAG" "$PI_BIN" \
    --source-extension-dir "$SOURCE_DIR" \
    --output-dir "$OUTPUT_DIR/proof" \
    --stub --failover
  echo "    stub e2e passed: $OUTPUT_DIR/proof"
else
  echo "==> skipping stub e2e (--skip-e2e)"
fi

echo "==> self-test green; swapping $TARGET"
echo "    candidate: $CANDIDATE ($REPORTED)"
REAL_PRIVATE_DIR="$PCC_CLI_TARGET"
# Compare canonical spellings: --target <real>/./cli is the real dir too.
CANON_TARGET="$(realpath -m "$TARGET")"
CANON_REAL="$(realpath -m "$REAL_PRIVATE_DIR")"
if [[ $YES -eq 0 && "$CANON_TARGET" == "$CANON_REAL" && ! -t 0 ]]; then
  echo "refusing: non-interactive swap into the real private dir needs --yes" >&2
  exit 3
fi
if [[ $YES -eq 0 && -t 0 ]]; then
  printf "    swap %s -> %s.prev and stage into place? [y/N] " "$TARGET" "$TARGET"
  read -r answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "aborted; nothing swapped"
    exit 3
  fi
fi
mkdir -p "$(dirname "$TARGET")"
# The tree renamed into place must live on the target's filesystem, so the
# swap below is always a rename. The default staging already is such a
# sibling; an explicit --staging elsewhere is copied into one first.
SWAP_SOURCE="$STAGING"
if [[ "$(stat -c %d "$STAGING")" != "$(stat -c %d "$(dirname "$TARGET")")" ]]; then
  echo "    staging is on another filesystem; copying into $(dirname "$TARGET") first"
  FINAL_STAGING="$(mktemp -d "$(dirname "$TARGET")/.staging-XXXXXX")"
  cp -a "$STAGING/." "$FINAL_STAGING/"
  SWAP_SOURCE="$FINAL_STAGING"
fi
# An interruption or failure between the two renames must never leave the
# target absent or partial: the EXIT trap restores the previous install when
# the target is missing, and a broken swap never retires the old copy.
fail_swap() {
  echo "refusing: $1; restoring previous install" >&2
  rm -rf "$TARGET"
  exit 1
}
if [[ -e "$TARGET.prev" ]]; then
  echo "    removing previous rollback copy $TARGET.prev"
  rm -rf "$TARGET.prev"
fi
if [[ -e "$TARGET" ]]; then
  mv "$TARGET" "$TARGET.prev"
fi
mv "$SWAP_SOURCE" "$TARGET"
# Post-swap verification before the swap is final: the swapped tree must run
# and report the requested version, or it is torn down and the previous
# install restored. Only a verified swap retires the old copy to rollback duty.
if ! INSTALLED="$("$TARGET/node_modules/.bin/claude" --version)"; then
  fail_swap "swapped CLI failed to run"
fi
if [[ "$INSTALLED" != "$VERSION"* ]]; then
  fail_swap "swapped CLI reports '$INSTALLED', wanted '$VERSION'"
fi
SWAP_DONE=1
echo "    swapped tree reports: $INSTALLED"
echo "==> installed. rollback: mv '$TARGET' '$TARGET.bad' && mv '$TARGET.prev' '$TARGET'"

