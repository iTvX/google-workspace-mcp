# Running a local copy for Claude Code (macOS)

This fork runs as a **deployed copy**, not from the checkout, so editing code or switching
branches never changes the server Claude Code is using until you deploy.

| Script | What it does |
|---|---|
| `deploy.sh` | Builds this checkout, copies it to `~/.local/lib/google-workspace-mcp/<time>-<commit>`, points `current` at it, and moves earlier deploys to the Trash (skipping one still in use). |
| `start-mcp.sh` | The command Claude Code runs. Reads the OAuth client from the Keychain, starts the build next to it, and keeps a monthly log in `~/Library/Logs/google-workspace-mcp/`. |

## One-time setup

```sh
# OAuth client (Desktop app) from Google Cloud — each prompts for the value
security add-generic-password -s google-workspace-mcp-oauth -a client_id -w
security add-generic-password -s google-workspace-mcp-oauth -a client_secret -w

scripts/local/deploy.sh

claude mcp add google-workspace --scope user \
  -e GWS_SERVICES=gmail \
  -e GWS_DEFAULT_ACCOUNT=you@example.com \
  -e GWS_SAFETY_POLICY=no-delete,audit \
  -- ~/.local/lib/google-workspace-mcp/current/scripts/local/start-mcp.sh
```

Then, in a new session: `manage_accounts {operation: "authenticate", email: "you@example.com"}`
for each account.

## After a change

Commit, run `scripts/local/deploy.sh`, and start a new Claude Code session.

Optional overrides: `GWS_NODE`, `GWS_NPM`, `GWS_RUNTIME_DIR`, `GWS_KEYCHAIN_SERVICE`.
