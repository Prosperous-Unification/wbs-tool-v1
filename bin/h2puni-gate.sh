#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

# shellcheck source=bin/h2puni-gate-lib.sh
source "$repo_root/bin/h2puni-gate-lib.sh"

# Remote gates must not leave Nx daemon children behind when SSH disconnects.
# Exported deliberately, unlike HEAVY_LOCK_WAIT_SECONDS below: this one has to
# reach the Nx processes the gate steps launch, which is the whole point.
export NX_DAEMON=false

# The head to gate. Pass the sha explicitly — `bin/h2puni-gate.sh <sha>` — and
# do NOT check it out yourself first: the point of the argument is that the
# checkout happens inside the heavy lock, where no other lane sharing this tree
# can move the head out from under the steps. Checking out separately and then
# calling the gate re-opens exactly the hole this closes.
#
# Defaulting to `HEAD` keeps the no-argument callers in AGENTS.md and the
# runbooks working, and they lose nothing: the head is resolved here, once, and
# that resolved sha is what gets checked out under the lock.
target=${1:-HEAD}

# Queue rather than refuse. `heavy-lock-lib.sh` defaults to refusing with exit 75
# to preserve the contract this script was written against, and documents
# `HEAVY_LOCK_WAIT_SECONDS` as what "several agents sharing one Mac" want — which
# is exactly what these lanes are. The cost of refusing is not a retry: a worker
# has a 75-minute run box, a gate takes 14-18 minutes, and a worker that takes
# exit 75 and gives up burns the whole box having shipped nothing. Waiting 30
# minutes for a 15-minute gate ahead of us still leaves room to gate and land.
# Set it explicitly to override, including to 0 for the old refuse-now behaviour.
#
# NOT exported, deliberately. `with_heavy_lock` is a function in this same shell,
# so a plain shell variable reaches it while staying out of the environment the
# gate steps run under. Exporting it would put 1800 into every process the gate
# launches, and `bin/heavy-lock.test.sh`'s refusal cases forward
# `${HEAVY_LOCK_WAIT_SECONDS:-0}` from their environment — under a gate they
# would inherit 1800 and spin for half an hour instead of asserting an immediate
# refusal. `tools/tool-dagger/src/heavy-lock.test.ts:54` records that exact false
# red happening once already, from a lane launching the gate with the value set
# on its command line.
: "${HEAVY_LOCK_WAIT_SECONDS:=1800}"

gate_with_pinned_head "$repo_root" "$(resolve_heavy_lock_path)" "$target" -- bash -c '
  bunx nx format:check --all &&
  bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache &&
  WBS_RUN_SOLVER_ORPHAN_PROC=1 bunx nx run be-01:solver-image-smoke
'
