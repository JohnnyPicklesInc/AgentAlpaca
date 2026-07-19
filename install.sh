#!/bin/sh
# Agent Alpaca CLI installer.
#
#   curl -fsSL https://raw.githubusercontent.com/JohnnyPicklesInc/AgentAlpaca/main/install.sh | sh
#
# Downloads the `alpaca` bridge CLI, installs its dependencies, and links an
# `alpaca` command onto your PATH. No npm account or global npm install needed.
#
# Env overrides:
#   ALPACA_REPO   owner/name        (default JohnnyPicklesInc/AgentAlpaca)
#   ALPACA_REF    branch/tag/sha    (default main)
#   ALPACA_HOME   install location  (default ~/.agentalpaca)
#   ALPACA_BIN    dir to link into  (default first writable of ~/.local/bin, /usr/local/bin)
set -eu

REPO="${ALPACA_REPO:-JohnnyPicklesInc/AgentAlpaca}"
REF="${ALPACA_REF:-main}"
HOME_DIR="${ALPACA_HOME:-$HOME/.agentalpaca}"
APP_DIR="$HOME_DIR/app"

say()  { printf '\033[1;35m🦙 %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[1;31m✗  %s\033[0m\n' "$1" >&2; exit 1; }

# --- prerequisites --------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is required (v18+). Install it from https://nodejs.org and re-run."
command -v npm  >/dev/null 2>&1 || die "npm is required (ships with Node.js)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node.js v18+ required; found $(node -v 2>/dev/null || echo none)."
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "curl or wget is required."

# --- fetch the cli --------------------------------------------------------
say "Downloading $REPO@$REF …"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TARBALL="https://codeload.github.com/$REPO/tar.gz/$REF"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$TARBALL" -o "$TMP/src.tgz" || die "Download failed: $TARBALL"
else
  wget -qO "$TMP/src.tgz" "$TARBALL" || die "Download failed: $TARBALL"
fi
tar -xzf "$TMP/src.tgz" -C "$TMP" || die "Could not extract archive."
SRC=$(find "$TMP" -maxdepth 2 -type d -name cli | head -n1)
[ -n "$SRC" ] && [ -f "$SRC/bin/alpaca.js" ] || die "cli/ not found in archive."

# --- install into place ---------------------------------------------------
say "Installing into $APP_DIR …"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -R "$SRC/." "$APP_DIR/"
( cd "$APP_DIR" && npm install --omit=dev --no-fund --no-audit ) || die "npm install failed."

# --- link onto PATH -------------------------------------------------------
chmod +x "$APP_DIR/bin/alpaca.js"
pick_bin() {
  if [ -n "${ALPACA_BIN:-}" ]; then echo "$ALPACA_BIN"; return; fi
  for d in "$HOME/.local/bin" "/usr/local/bin"; do
    if [ -d "$d" ] && [ -w "$d" ]; then echo "$d"; return; fi
  done
  echo "$HOME/.local/bin"
}
BIN_DIR=$(pick_bin)
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/bin/alpaca.js" "$BIN_DIR/alpaca"

say "Installed alpaca → $BIN_DIR/alpaca"
if command -v alpaca >/dev/null 2>&1; then
  say "Ready. Try:  alpaca -- claude"
else
  warn "$BIN_DIR is not on your PATH. Add this to your shell profile:"
  printf '    export PATH="%s:$PATH"\n' "$BIN_DIR"
  warn "Then restart your shell and run:  alpaca -- claude"
fi
