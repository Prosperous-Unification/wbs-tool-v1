#!/usr/bin/env bash
# Deploy the current HEAD to dev. Run this after pushing.
#
# **Dev tracks `origin/main`, so this only holds for a commit that IS on main.**
# A poller on h2puni (`/home/puni1/wbs-dev/bin/poll.sh`, puni1's crontab, every
# minute) fetches `origin/main` and resets the checkout back to it whenever they
# differ -- so a branch deployed by hand is reverted within 60 seconds, and this
# script reports success before that happens. Watched on 2026-08-31: a branch
# landed at 15:26:58 and the poller pulled dev back to main at 15:27:02, four
# seconds later, while `dev healthy at <branch sha>` had already been printed.
# `docs/adr/0005-dev-deploys-itself-from-origin-main.md` is why the poller
# exists; the lines this replaced said there was none, which was true until
# 2026-08-19 and then stayed on disk for twelve days.
#
# What this script is still for: a commit already on main that the poller has
# not picked up yet, and any deploy where you want the output in front of you.
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

# Run the fetched target's sync from a snapshot outside the checkout it resets.
#
# Running the checkout's pre-reset copy wedges a later fix when that old copy
# fails before reset. The durable helper extracts this exact target SHA, so a
# repaired target supplies the deployer that can land it without skipping any
# sync.ts preflight or post-reset check.
#
# The candidate loader is streamed from this exact checkout, like the MCP
# preflight above. The first deployment of this recovery path therefore cannot
# depend on the helper already being installed on the host. Its managed Bun is
# installed with the durable poller pair and checked by the loader before the
# target tree is read.
#
# SC2029 is disabled for this command, not silenced globally: $SHA is meant to
# expand here, on this machine. The remote has no such variable, and sending
# this machine's HEAD is the entire purpose of the call.
# shellcheck disable=SC2029
ssh h2puni \
  "git -C /home/puni1/wbs-dev/src fetch --quiet origin && bash -s -- /home/puni1/wbs-dev/src /home/puni1/wbs-dev/bin /home/puni1/wbs-dev/bin/bun $SHA" \
  < "$(dirname "${BASH_SOURCE[0]}")/dev-poll-sync.sh"

# No credential is fetched or sent. Dev's edge password was removed 2026-08-06;
# these checks now reach the same thing a browser does, which is the point of
# them. `/api/auth/me` below answers the app's explicit anonymous-user JSON;
# rejected credentials still take the route's separate 401 path.

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
