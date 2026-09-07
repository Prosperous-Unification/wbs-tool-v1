#!/usr/bin/env bash
# Authoritative dev poller. Install this file and dev-poll-sync.sh together in
# /home/puni1/wbs-dev/bin; they stay outside the checkout that sync.ts resets.
set -euo pipefail

SRC=/home/puni1/wbs-dev/src
BIN=/home/puni1/wbs-dev/bin
BUN=/home/puni1/wbs-dev/bin/bun
CONTAINER=wbs-dev-src
LOG=/home/puni1/wbs-dev/logs/deploy.log
LOCK=/home/puni1/wbs-dev/state/poll.lock

# This outer lock covers fetch, candidate extraction, sync and the served-code
# proof. sync.ts holds its separate deploy lock around reset/install/restart.
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$SRC"
git fetch -q origin main
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse refs/remotes/origin/main)
[ "$local_sha" = "$remote_sha" ] && exit 0

read_served_commit() {
  docker exec "$CONTAINER" sh -c \
    'curl -s -m 5 http://127.0.0.1:3100/health' 2>/dev/null |
    sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p'
}

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ${local_sha:0:7} -> ${remote_sha:0:7}"

  # dev-poll-sync extracts sync.ts from remote_sha into BIN before executing
  # it. Therefore a pre-reset failure cannot pin the checkout forever: a later
  # repaired remote_sha supplies and runs its repaired deployer directly.
  "$BIN/dev-poll-sync.sh" "$SRC" "$BIN" "$BUN" "$remote_sha"

  served=''
  for attempt in 1 2 3 4 5 6; do
    served=$(read_served_commit || true)
    if [ "$served" = "$remote_sha" ]; then
      echo "--- serving ${remote_sha:0:7} (health, attempt ${attempt})"
      break
    fi
    sleep 10
  done
  if [ "${served:-}" != "$remote_sha" ]; then
    echo "!!! checkout is at ${remote_sha:0:7}, /health still says '${served:-<unreadable>}'"
  fi
} >> "$LOG" 2>&1
