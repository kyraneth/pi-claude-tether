#!/usr/bin/env bash
# Pi-owned live context and actual Pi RPC tool/guard round-trip.
# Uses the REAL Claude CLI and subscription; spends tokens, never CI.
set -euo pipefail
cd "$(dirname "$0")/.."
PI_OWNED_LIVE=1 npx vitest run tests/live-context-policy.test.ts tests/live-pi-roundtrip.test.ts
