#!/usr/bin/env bash
#
# lain bootstrap — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Tetraslam/lain/main/bootstrap.sh | bash
#
# Clones (or updates) lain into a stable location, builds it, and puts a `lain`
# launcher on your PATH. Re-runnable. Never touches your explorations or config.
#
# Env overrides:
#   LAIN_HOME       where the source lives   (default: ~/.local/share/lain)
#   LAIN_BIN_DIR    where the launcher goes  (default: ~/.local/bin)
#   LAIN_REPO_URL   git remote               (default: https://github.com/Tetraslam/lain)
#   LAIN_BRANCH     branch                   (default: main)
#
set -euo pipefail

REPO_URL="${LAIN_REPO_URL:-https://github.com/Tetraslam/lain}"
BRANCH="${LAIN_BRANCH:-main}"
SRC_DIR="${LAIN_HOME:-$HOME/.local/share/lain}"

say() { printf '\033[38;2;187;154;247m%s\033[0m\n' "$*"; }   # lain purple
err() { printf '\033[38;2;247;118;142m%s\033[0m\n' "$*" >&2; } # red

say "lain bootstrap"
echo "  source: $SRC_DIR"
echo "  remote: $REPO_URL ($BRANCH)"
echo

# --- prerequisites -----------------------------------------------------------
command -v git >/dev/null 2>&1 || { err "✗ git is required."; exit 1; }
if ! command -v bun >/dev/null 2>&1; then
  err "✗ bun is required. Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# pnpm is required for the workspace build; provision it if missing.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found — provisioning..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable pnpm >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    bun install -g pnpm >/dev/null 2>&1 || true
    export PATH="$(bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin"):$PATH"
  fi
fi
command -v pnpm >/dev/null 2>&1 || { err "✗ pnpm is required and could not be auto-installed. See https://pnpm.io"; exit 1; }

echo "✓ git $(git --version | awk '{print $3}')   ✓ bun $(bun --version)   ✓ pnpm $(pnpm --version)"
echo

# --- clone or update ---------------------------------------------------------
if [ -d "$SRC_DIR/.git" ]; then
  echo "Updating existing checkout..."
  git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
else
  echo "Cloning lain..."
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi

# --- build + install launcher ------------------------------------------------
echo
bash "$SRC_DIR/install.sh"
