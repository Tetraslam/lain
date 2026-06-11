#!/usr/bin/env bash
#
# lain installer — downloads the prebuilt single binary (fast path), and falls
# back to building from source if no binary fits your platform.
#
#   curl -fsSL https://tetraslam.github.io/lain/install | bash
#
# It needs only curl + bash. The binary is fully self-contained (Bun runtime +
# CLI + TUI + web all baked in) — no Node/pnpm/bun required to run it.
#
# By default it tracks the rolling "edge" channel — the binary rebuilt from the
# latest commit on main that passed CI — so installs stay as fresh as a git pull.
#
# Env overrides:
#   LAIN_FROM_SOURCE=1   skip the binary, build from source instead
#   LAIN_BIN_DIR         where to install the launcher (default: ~/.local/bin)
#   LAIN_REPO            owner/repo (default: Tetraslam/lain)
#   LAIN_VERSION_TAG     release tag to install (default: edge; e.g. v0.1.0, or "latest")
#
set -euo pipefail

REPO="${LAIN_REPO:-Tetraslam/lain}"
BIN_DIR="${LAIN_BIN_DIR:-$HOME/.local/bin}"
TAG="${LAIN_VERSION_TAG:-edge}"

say()  { printf '\033[38;2;187;154;247m%s\033[0m\n' "$*"; }
info() { printf '%s\n' "$*"; }
warn() { printf '\033[38;2;224;175;104m%s\033[0m\n' "$*" >&2; }
err()  { printf '\033[38;2;247;118;142m%s\033[0m\n' "$*" >&2; }

say "lain installer"

build_from_source() {
  info "Falling back to a source build (bun + node + pnpm, then compile)..."
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/bootstrap.sh?cb=$(date +%s)" | bash
  exit $?
}

command -v curl >/dev/null 2>&1 || { err "✗ curl is required."; exit 1; }
[ "${LAIN_FROM_SOURCE:-0}" = "1" ] && build_from_source

# --- detect platform → asset name --------------------------------------------
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) warn "Unsupported OS $(uname -s) for a prebuilt binary."; build_from_source ;;
esac
case "$(uname -m)" in
  x86_64|amd64)   ARCH=x64 ;;
  aarch64|arm64)  ARCH=arm64 ;;
  *) warn "Unsupported arch $(uname -m) for a prebuilt binary."; build_from_source ;;
esac
# Prebuilt targets: linux-x64, linux-arm64, darwin-arm64. Everything else
# (Intel macs, Alpine/musl) builds from source.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  warn "No prebuilt binary for Intel macOS — building from source."
  build_from_source
fi
if [ "$OS" = "linux" ] && ldd --version 2>&1 | grep -qi musl; then
  warn "musl libc detected — no prebuilt binary for musl yet."
  build_from_source
fi

ASSET="lain-${OS}-${ARCH}"
if [ "$TAG" = "latest" ]; then
  BASE="https://github.com/${REPO}/releases/latest/download"
else
  BASE="https://github.com/${REPO}/releases/download/${TAG}"
fi
URL="${BASE}/${ASSET}"

info "  platform: ${OS}-${ARCH}  →  ${ASSET}"
info "  source:   ${URL}"
echo

# --- download (fall back to source if there's no release / no asset) ---------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! curl -fsSL "$URL" -o "$TMP/lain"; then
  warn "No prebuilt binary available (no release yet, or none for ${ASSET})."
  build_from_source
fi

# --- verify checksum if published --------------------------------------------
if curl -fsSL "${URL}.sha256" -o "$TMP/lain.sha256" 2>/dev/null; then
  EXPECTED="$(awk '{print $1}' "$TMP/lain.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$TMP/lain" | awk '{print $1}')";
  else ACTUAL="$(shasum -a 256 "$TMP/lain" | awk '{print $1}')"; fi
  if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$ACTUAL" ]; then
    err "✗ checksum mismatch (expected $EXPECTED, got $ACTUAL). Aborting."
    exit 1
  fi
  info "✓ checksum verified"
fi

# --- install -----------------------------------------------------------------
mkdir -p "$BIN_DIR"
install -m 0755 "$TMP/lain" "$BIN_DIR/lain" 2>/dev/null || { cp "$TMP/lain" "$BIN_DIR/lain"; chmod 0755 "$BIN_DIR/lain"; }

VER="$("$BIN_DIR/lain" version 2>/dev/null | grep -oE 'v[0-9][^ ]*' | head -1 || true)"
say "✓ installed lain ${VER} → $BIN_DIR/lain"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    warn "⚠ $BIN_DIR is not on your PATH. Add this to your shell rc:"
    info "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo
info "Next:"
info "    lain init                              # configure your provider + key"
info "    lain \"a city that dreams\" --mission    # your first exploration"
info "    lain tui                               # interactive TUI"
info "    lain serve                             # web UI"
