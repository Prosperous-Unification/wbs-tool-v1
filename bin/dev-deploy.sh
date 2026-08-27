#!/usr/bin/env bash
# Deploy the current HEAD to dev. Run this after pushing.
#
# There is no poller and no CI gate. The push happens on h1claw, so the trigger
# happens on h1claw too -- nothing runs between deploys, and there is no timer
# to notice has died. CI still runs and still reports; it is simply not in the
# path between a push and dev being current.
#
# The build host rule still holds: this builds nothing. It asks h2puni to move
# its checkout, and the watchers already running there do the rest.
set -euo pipefail

SHA=$(git rev-parse HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "refusing: working tree is dirty, so dev would not match any commit" >&2
  exit 1
fi

# Untracked files count as dirty here. They are invisible to `git diff`, so the
# original check passed while a new file existed only on this machine -- the
# deploy then reported a SHA whose tree is not what the author is looking at,
# which is the exact claim this script exists to make true.
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "refusing: untracked files present, so dev would not match ${SHA:0:8}" >&2
  git ls-files --others --exclude-standard | sed 's/^/  /' >&2
  exit 1
fi

# A SHA that exists only here cannot be fetched by h2puni. Without this the
# deploy fails on the remote with a bare "reference is not a tree", pointing at
# the wrong machine.
if ! git branch -r --contains "$SHA" >/dev/null 2>&1 || [ -z "$(git branch -r --contains "$SHA" 2>/dev/null)" ]; then
  echo "refusing: ${SHA:0:8} is not on any remote branch -- push first" >&2
  exit 1
fi

echo "[dev-deploy] $BRANCH @ ${SHA:0:8} -> dev"

# This checker is streamed from the triggering checkout before the live tree's
# old sync.ts is copied. The first deployment that introduces mcp-01 therefore
# cannot bypass its environment prerequisite. Its one-byte result comes from a
# persistent h2puni marker, so every post-cutover deploy runs semantic MCP health.
MCP_EXPOSURE_EXPECTED=$(ssh h2puni \
  "bash -s -- /home/puni1/wbs-dev/src/apps/mcp-01/.env /home/puni1/wbs-dev/state/mcp-exposure" \
  < "$(dirname "${BASH_SOURCE[0]}")/dev-mcp-preflight.sh")
export MCP_EXPOSURE_EXPECTED

# Run sync from a snapshot outside the checkout it is about to reset.
#
# Running it in place means the process rewrites its own source mid-run, and a
# commit that breaks sync.ts lands on disk successfully -- wedging every later
# deploy with no way to deploy the fix. The snapshot is taken before the reset,
# so a broken commit fails the run it arrived in and the previous good copy is
# still on disk at /home/puni1/wbs-dev/bin/sync.ts to deploy over it.
#
# SC2029 is disabled for this command, not silenced globally: $SHA is meant to
# expand here, on this machine. The remote has no such variable, and sending
# this machine's HEAD is the entire purpose of the call.
# shellcheck disable=SC2029
ssh h2puni "bash -lc '
  set -e
  mkdir -p /home/puni1/wbs-dev/bin
  cp /home/puni1/wbs-dev/src/tools/tool-devsync/src/sync.ts /home/puni1/wbs-dev/bin/sync.next.ts
  mv /home/puni1/wbs-dev/bin/sync.next.ts /home/puni1/wbs-dev/bin/sync.ts
  cd /home/puni1/wbs-dev/src && bun /home/puni1/wbs-dev/bin/sync.ts $SHA
'"

# No credential is fetched or sent. Dev's edge password was removed 2026-08-06;
# these checks now reach the same thing a browser does, which is the point of
# them. `/api/auth/me` below still answers 401-shaped JSON, because be-01's own
# auth is what guards the app and that has not changed.

# Printing a status code and exiting 0 regardless is how a 502 reads as a
# successful deploy. Each tier is asserted, and a miss fails the script.
#
# Each check retries to a deadline rather than asking once. A deploy that moved
# a restart path stops all three tiers and starts them again, so the first
# request lands on a Caddy that has nothing to proxy to: the single-shot
# version reported three 502s and a failed deploy for an environment that was
# healthy eleven seconds later. Retrying does not weaken the check -- the
# deadline still fails a tier that never comes back -- it only stops the script
# from measuring the restart it just caused.
DEADLINE_SECONDS=60
fail=0
check() { # expected url label
  local got deadline
  deadline=$((SECONDS + DEADLINE_SECONDS))
  while :; do
    got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$2")
    if [ "$got" = "$1" ]; then
      printf '[dev-deploy] %-28s %s\n' "$3" "$got"
      return
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf '[dev-deploy] %-28s %s (expected %s after %ss) FAIL\n' \
        "$3" "$got" "$1" "$DEADLINE_SECONDS" >&2
      fail=1
      return
    fi
    sleep 2
  done
}

# What each code proves, measured rather than assumed:
#
#   /            200 -- Vite served the app shell.
#   /api/health  404 -- be-01 ANSWERED. It mounts /health at its own root, so
#                       Caddy's un-stripped /api prefix reaches a route be-01
#                       does not have. The 404 is Elysia's. If be-01 were dead
#                       Caddy would return 502, which is the signal this
#                       catches. A 200 here would mean the route moved.
#   /ws          404 -- gw-01 answered a plain GET on the socket path. Same
#                       reasoning: 502 means dead.
#
# Do not "fix" the 404s into 200s without moving the routes -- the point is
# that a specific non-5xx code proves the right process replied.
check 200 https://dev.wbs.bulletpoints.club/ 'fe (app shell)'
check 404 https://dev.wbs.bulletpoints.club/api/health 'be (answered, not 502)'
check 404 https://dev.wbs.bulletpoints.club/ws 'gw (answered, not 502)'

# A status code alone cannot distinguish be-01's 404 from one Caddy generated
# for a route it could not match. This asserts a body only be-01 emits: the
# auth controller's own JSON for a request with no token. It proves the
# application layer is mounted, not merely that a process accepted a socket.
if ! "$(dirname "${BASH_SOURCE[0]}")/dev-be-probe.sh" https://dev.wbs.bulletpoints.club; then
  fail=1
fi

# MCP health is semantic, not a status-code probe: discovery must name the
# canonical resource and authorization server, and an anonymous tool request
# must return the RFC 9728 challenge that sends the client back to metadata.
if ! "$(dirname "${BASH_SOURCE[0]}")/dev-mcp-probe.sh" https://dev.wbs.bulletpoints.club; then
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "[dev-deploy] dev is NOT healthy at ${SHA:0:8} -- check: ssh h2puni 'docker logs --tail 50 wbs-dev-src'" >&2
  exit 1
fi
echo "[dev-deploy] dev healthy at ${SHA:0:8}"
