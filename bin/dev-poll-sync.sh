#!/usr/bin/env bash
# Extract and run the requested commit's deployer outside the checkout it may reset.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo 'usage: dev-poll-sync.sh <source-checkout> <installed-bin-dir> <bun> <target-sha> <bun-version>' >&2
  exit 2
fi

SRC=$1
BIN=$2
BUN=$3
SHA=$4
EXPECTED_BUN_VERSION=$5

if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "refusing invalid target SHA: $SHA" >&2
  exit 2
fi
if [[ ! "$EXPECTED_BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "refusing invalid managed Bun version: $EXPECTED_BUN_VERSION" >&2
  exit 2
fi

if [ ! -x "$BUN" ]; then
  echo "refusing: missing managed Bun $EXPECTED_BUN_VERSION at $BUN; install it with the poller pair per docs/runbook-dev-deploy.md" >&2
  exit 1
fi
if [ "$("$BUN" --version)" != "$EXPECTED_BUN_VERSION" ]; then
  echo "refusing: managed Bun at $BUN does not match $EXPECTED_BUN_VERSION from .bun-version; after a version bump, reinstall the poller pair per docs/runbook-dev-deploy.md" >&2
  exit 1
fi

mkdir -p "$BIN"
# Commit candidates are recovery snapshots, not an archive. Bound inode use on
# the durable host while leaving recent targets available for diagnosis.
find "$BIN" -type f \( -name 'sync.*.ts' -o -name 'sync.*.ts.*' \) -mtime +7 -exec rm -f -- {} +

SYNC_NEXT=''
cleanup_candidate() {
  if [ -n "$SYNC_NEXT" ]; then rm -f -- "$SYNC_NEXT"; fi
}
trap cleanup_candidate EXIT HUP INT TERM
SYNC_NEXT=$(mktemp "$BIN/sync.${SHA}.ts.XXXXXXXX")
SYNC="$BIN/sync.${SHA}.ts"

# Reading from the fetched target, rather than the checkout's pre-reset tree,
# is the recovery boundary. A broken target deployer can refuse this attempt,
# but its repaired successor is extracted on the next tick and can deploy
# itself. The candidate still runs sync.ts, so solver, restart, recreate and
# post-reset HEAD checks are never bypassed.
git -C "$SRC" show "$SHA:tools/tool-devsync/src/sync.ts" > "$SYNC_NEXT"
mv "$SYNC_NEXT" "$SYNC"
SYNC_NEXT=''
trap - EXIT HUP INT TERM
cd "$SRC"
exec "$BUN" "$SYNC" "$SHA"
