#!/usr/bin/env sh
# Derive this package's on-disk dirs from its own package.json name.
#
# pi-claude-tether uses ${XDG_DATA_HOME:-<home>/.local/share}/pi-claude-tether.
# Other package names use the legacy <home>/.local/share/pi-claude-cli path.
#
# This file is SOURCED, so it cannot use $0 for its own location. The caller
# sets PCC_PKG_DIR to the package root first:
#   PCC_PKG_DIR="$EXT_DIR" PCC_HOME="$TEST_HOME" . "$EXT_DIR/scripts/package-dirs.sh"
# Sets PCC_PKG_NAME, PCC_STATE_LEAF, PCC_DATA_DIR, PCC_CLI_TARGET.
# POSIX sh: no bashisms.
if [ -z "${PCC_PKG_DIR:-}" ]; then
  echo "package-dirs.sh: caller must set PCC_PKG_DIR to the package root" >&2
  return 1 2>/dev/null || exit 1
fi
: "${PCC_HOME:=$HOME}"
PCC_PKG_NAME=$(node -e 'console.log(require(process.argv[1]).name)' "$PCC_PKG_DIR/package.json")
if [ "$PCC_PKG_NAME" = "pi-claude-tether" ]; then
  PCC_STATE_LEAF="pi-claude-tether"
  PCC_DATA_DIR="${XDG_DATA_HOME:-$PCC_HOME/.local/share}/pi-claude-tether"
else
  PCC_STATE_LEAF="pi-claude-cli"
  PCC_DATA_DIR="$PCC_HOME/.local/share/pi-claude-cli"
fi
PCC_CLI_TARGET="$PCC_DATA_DIR/cli"
