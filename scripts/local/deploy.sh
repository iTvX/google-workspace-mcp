#!/bin/zsh
# Deploy this checkout as the copy Claude Code runs (macOS).
#
# Claude Code starts ~/.local/lib/google-workspace-mcp/current/scripts/local/start-mcp.sh —
# a copy, not this checkout — so switching branches or editing code here never changes the
# server in use; only running this does. Each deploy gets its own folder (time + commit),
# `current` points at it, and earlier deploys are moved to the Trash: there is one version,
# the newest. A deploy still in use by a running session is left until that session ends.
#
# After deploying, start a new Claude Code session to pick it up.

set -euo pipefail

REPO="${0:A:h:h:h}"
RUNTIME="${GWS_RUNTIME_DIR:-$HOME/.local/lib/google-workspace-mcp}"
NPM="${GWS_NPM:-}"
if [[ -z "$NPM" ]]; then
  for candidate in /opt/homebrew/bin/npm /usr/local/bin/npm; do
    [[ -x "$candidate" ]] && { NPM="$candidate"; break; }
  done
fi
[[ -z "$NPM" ]] && NPM="$(command -v npm)"

cd "$REPO"
version="$(git rev-parse --short HEAD)"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  version="$version-dirty"
  print -u2 "deploy: warning: uncommitted changes in $REPO; deploying them as $version"
fi
dest="$RUNTIME/$(date +%Y%m%d-%H%M%S)-$version"

"$NPM" run build >/dev/null
# The build re-stamps src/version.ts; it is not a change of ours.
git diff --quiet -- src/version.ts || git checkout -- src/version.ts

mkdir -p "$dest/scripts"
cp -R build package.json package-lock.json "$dest/"
cp -R scripts/local "$dest/scripts/"
print -r -- "$(git rev-parse HEAD) $(git branch --show-current) ${version}" > "$dest/DEPLOYED_FROM"
(cd "$dest" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)

ln -sfn "$dest" "$RUNTIME/current"
print "deployed $version -> $RUNTIME/current ($(basename "$dest"))"

# One version only: move earlier deploys to the Trash, unless a session still has one open.
for old in "$RUNTIME"/*(N/); do
  [[ "$old" == "$dest" ]] && continue
  if lsof +D "$old" >/dev/null 2>&1; then
    print "kept $(basename "$old"): still in use by a running session"
  else
    mv "$old" "$HOME/.Trash/" && print "moved $(basename "$old") to the Trash"
  fi
done
