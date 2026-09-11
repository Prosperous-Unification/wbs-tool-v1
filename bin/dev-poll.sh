#!/usr/bin/env bash
# Authoritative dev poller. Its installed shell stays outside the checkout that
# sync.ts resets; every tick streams the target commit's candidate loader.
set -euo pipefail

SRC=/home/puni1/wbs-dev/src
BIN=/home/puni1/wbs-dev/bin
BUN=/home/puni1/wbs-dev/bin/bun
BUN_VERSION_FILE=/home/puni1/wbs-dev/bin/bun-version
CONTAINER=wbs-dev-src
LOG=/home/puni1/wbs-dev/logs/deploy.log
LOCK=/home/puni1/wbs-dev/state/poll.lock

if ! read -r BUN_VERSION < "$BUN_VERSION_FILE"; then
  echo "refusing: missing managed Bun version file at $BUN_VERSION_FILE; reinstall the poller pair per docs/runbook-dev-deploy.md" >&2
  exit 1
fi

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

  # Read the loader from remote_sha, not from the installed poller generation.
  # The loader changed from a narrow archive to a complete Git tree in the same
  # change that first required Git identity, so an installed older copy cannot
  # materialize a target its sync.ts is able to run. A later repaired target
  # likewise supplies the recovery path before the live checkout moves.
  git show "$remote_sha:bin/dev-poll-sync.sh" |
    bash -s -- "$SRC" "$BIN" "$BUN" "$remote_sha" "$BUN_VERSION"

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
