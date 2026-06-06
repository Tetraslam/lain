#!/usr/bin/env bash
#
# lain bootstrap — one-line installer that "just works".
#
#   curl -fsSL https://raw.githubusercontent.com/Tetraslam/lain/main/bootstrap.sh | bash
#
# Only needs curl + bash to start. It will auto-install bun, provision pnpm, and
# fetch lain (via git if present, else a tarball), then build it and put a
# `lain` launcher on your PATH. Re-runnable. Never touches explorations/config.
#
# Env overrides:
#   LAIN_HOME           source location      (default: ~/.local/share/lain)
#   LAIN_BIN_DIR        launcher location    (default: ~/.local/bin)
#   LAIN_REPO_URL       git remote           (default: https://github.com/Tetraslam/lain)
#   LAIN_BRANCH         branch               (default: main)
#   LAIN_FORCE_TARBALL  =1 to skip git and download a tarball
#
set -euo pipefail

REPO_URL="${LAIN_REPO_URL:-https://github.com/Tetraslam/lain}"
BRANCH="${LAIN_BRANCH:-main}"
SRC_DIR="${LAIN_HOME:-$HOME/.local/share/lain}"
TARBALL_URL="${REPO_URL%.git}/archive/refs/heads/${BRANCH}.tar.gz"

say() { printf '\033[38;2;187;154;247m%s\033[0m\n' "$*"; }
err() { printf '\033[38;2;247;118;142m%s\033[0m\n' "$*" >&2; }

say "lain bootstrap"
echo "  source: $SRC_DIR"
echo

# --- curl (we're probably already running through it, but be sure) -----------
command -v curl >/dev/null 2>&1 || { err "✗ curl is required to bootstrap."; exit 1; }

# --- bun: auto-install if missing --------------------------------------------
ensure_path() { case ":$PATH:" in *":$1:"*) ;; *) export PATH="$1:$PATH";; esac; }
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || { err "✗ bun install failed. See https://bun.sh"; exit 1; }
  ensure_path "${BUN_INSTALL:-$HOME/.bun}/bin"
fi
command -v bun >/dev/null 2>&1 || { err "✗ bun is required and could not be installed."; exit 1; }

# --- pnpm: provision if missing (corepack, else bun global) ------------------
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Provisioning pnpm..."
  if command -v corepack >/dev/null 2>&1; then corepack enable pnpm >/dev/null 2>&1 || true; fi
  if ! command -v pnpm >/dev/null 2>&1; then
    bun install -g pnpm >/dev/null 2>&1 || true
    ensure_path "$(bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin")"
  fi
fi
command -v pnpm >/dev/null 2>&1 || { err "✗ pnpm could not be provisioned. Install it: https://pnpm.io"; exit 1; }

echo "✓ bun $(bun --version)   ✓ pnpm $(pnpm --version)$(command -v git >/dev/null 2>&1 && echo "   ✓ git $(git --version | awk '{print $3}')" || echo "   · no git (tarball mode)")"
echo

# --- acquire source: git clone/update, else tarball --------------------------
fetch_tarball() {
  echo "Downloading lain tarball ($BRANCH)..."
  rm -rf "$SRC_DIR"
  mkdir -p "$SRC_DIR"
  curl -fsSL "$TARBALL_URL" | tar -xz -C "$SRC_DIR" --strip-components=1
}

if [ "${LAIN_FORCE_TARBALL:-0}" = "1" ] || ! command -v git >/dev/null 2>&1; then
  fetch_tarball
elif [ -d "$SRC_DIR/.git" ]; then
  echo "Updating existing checkout..."
  git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH" && git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
else
  echo "Cloning lain..."
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi

# --- build + install launcher ------------------------------------------------
echo
bash "$SRC_DIR/install.sh"
