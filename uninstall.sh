#!/usr/bin/env bash
#
# lain uninstaller — removes the `lain` launcher. Leaves your source checkout,
# config, credentials, and explorations (.db) untouched unless you pass flags.
#
#   bash uninstall.sh              # remove the launcher only
#   bash uninstall.sh --config     # also remove ~/.config/lain (keys!)
#
set -euo pipefail

BIN_DIR="${LAIN_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/lain"

if [ -f "$LAUNCHER" ]; then
  rm -f "$LAUNCHER"
  echo "✓ Removed launcher: $LAUNCHER"
else
  echo "· No launcher at $LAUNCHER"
fi

if [ "${1:-}" = "--config" ]; then
  rm -rf "$HOME/.config/lain"
  echo "✓ Removed ~/.config/lain (config + credentials)"
else
  echo "· Kept ~/.config/lain (use --config to remove keys)"
fi

echo "· Your exploration .db files were not touched."
