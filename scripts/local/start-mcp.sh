#!/bin/zsh
# Launch the server for Claude Code on macOS, with the OAuth client taken from the Keychain.
#
# Register the DEPLOYED copy (see deploy.sh), not the development checkout:
#   claude mcp add google-workspace --scope user \
#     -e GWS_SERVICES=gmail -e GWS_DEFAULT_ACCOUNT=you@example.com -e GWS_SAFETY_POLICY=no-delete,audit \
#     -- ~/.local/lib/google-workspace-mcp/current/scripts/local/start-mcp.sh
#
# The server is found next to this script (../../build/index.js), so the launcher always
# runs the build it was deployed with.
#
# The OAuth client id and secret are read from the macOS Keychain, so they never sit in
# ~/.claude.json or any file. Store them once with:
#   security add-generic-password -s google-workspace-mcp-oauth -a client_id -w
#   security add-generic-password -s google-workspace-mcp-oauth -a client_secret -w
# (`-w` last makes `security` prompt for the value, so it stays out of shell history.)

set -u

ROOT="${0:A:h:h:h}"   # .../scripts/local/start-mcp.sh -> the deployed (or checked-out) root
SERVER="$ROOT/build/index.js"
KEYCHAIN_SERVICE="${GWS_KEYCHAIN_SERVICE:-google-workspace-mcp-oauth}"
LOG_DIR="$HOME/Library/Logs/google-workspace-mcp"
# One file per month: nothing is ever rotated away, and an old month is one file to delete.
LOG="$LOG_DIR/server-$(date +%Y-%m).log"

# Claude Code starts MCP servers with a minimal PATH, so look for node explicitly.
NODE="${GWS_NODE:-}"
if [[ -z "$NODE" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { NODE="$candidate"; break; }
  done
fi
[[ -z "$NODE" ]] && NODE="$(command -v node || true)"

mkdir -p "$LOG_DIR"

if [[ ! -f "$SERVER" ]]; then
  print -u2 "[start-mcp] No server build at $SERVER. Run scripts/local/deploy.sh (or npm run build) first."
  exit 1
fi
if [[ -z "$NODE" ]]; then
  print -u2 "[start-mcp] node not found; set GWS_NODE to its path."
  exit 1
fi

keychain() { /usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null }

export GOOGLE_CLIENT_ID="$(keychain client_id)"
export GOOGLE_CLIENT_SECRET="$(keychain client_secret)"

if [[ -z "$GOOGLE_CLIENT_ID" || -z "$GOOGLE_CLIENT_SECRET" ]]; then
  # Start anyway, so the tools still load; adding an account will fail with a clear error.
  print -u2 "[start-mcp] No OAuth client in Keychain service '$KEYCHAIN_SERVICE'. See the comment at the top of $0."
fi

# stderr carries the server's log, including the AUDIT line for every write (content
# redacted). Keep a timestamped copy on disk and still pass it through to Claude Code.
exec "$NODE" "$SERVER" 2> >(
  while IFS= read -r line; do print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $line"; done | tee -a "$LOG" >&2
)
