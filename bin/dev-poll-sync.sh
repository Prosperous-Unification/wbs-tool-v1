#!/usr/bin/env bash
# Extract and run the requested commit's deployer outside the checkout it may reset.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo 'usage: dev-poll-sync.sh <source-checkout> <installed-bin-dir> <bun> <target-sha>' >&2
  exit 2
fi

SRC=$1
BIN=$2
BUN=$3
SHA=$4

if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "refusing invalid target SHA: $SHA" >&2
  exit 2
fi

if [ ! -x "$BUN" ]; then
  echo "refusing: missing managed Bun 1.3.14 at $BUN; install the managed Bun 1.3.14 with the poller pair per docs/runbook-dev-deploy.md" >&2
  exit 1
fi
if [ "$("$BUN" --version)" != '1.3.14' ]; then
  echo "refusing: managed Bun at $BUN is not 1.3.14; reinstall it with the poller pair per docs/runbook-dev-deploy.md" >&2
  exit 1
fi

mkdir -p "$BIN"
SYNC_NEXT=$(mktemp "$BIN/sync.${SHA}.XXXXXXXX.ts")
SYNC="$BIN/sync.${SHA}.ts"

# Reading from the fetched target, rather than the checkout's pre-reset tree,
# is the recovery boundary. A broken target deployer can refuse this attempt,
# but its repaired successor is extracted on the next tick and can deploy
# itself. The candidate still runs sync.ts, so solver, restart, recreate and
# post-reset HEAD checks are never bypassed.
git -C "$SRC" show "$SHA:tools/tool-devsync/src/sync.ts" > "$SYNC_NEXT"
mv "$SYNC_NEXT" "$SYNC"
cd "$SRC"
exec "$BUN" "$SYNC" "$SHA"
