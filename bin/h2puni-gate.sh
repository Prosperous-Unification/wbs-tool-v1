#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

# shellcheck source=bin/h2puni-gate-lib.sh
# shellcheck disable=SC1091 # The `source=` directive above names the file; SC1091
# is shellcheck saying it will only FOLLOW it under `-x`, which is a fact about
# the invocation, not about this script. Without this, `shellcheck bin/*.sh` on
# any set that omits the library exits 1 on an info.
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

# The lane's name in the heavy lock's queue, which `bin/with-heavy-lock.sh
# status` prints beside its pid. A pid alone says a lane is holding the host; it
# does not say WHICH gate, and on a box where several lanes gate all day that is
# the only thing the next lane needs to know.
#
# Resolved here rather than left to `gate_with_pinned_head`, because the label
# has to exist before `with_heavy_lock` runs and the resolution lives inside it.
# It must be the resolved commit: every caller that types `HEAD` would otherwise
# label its lane `gate:HEAD`, naming every lane identically.
#
# Exported, unlike HEAVY_LOCK_WAIT_SECONDS below, and for the opposite reason: a
# nested heavy run started by a gate step should queue under the gate's own name
# rather than as `unlabeled`. It is a name, not a budget, so nothing downstream
# can act on it.
#
# A target that names no commit is NOT refused here. `gate_with_pinned_head`
# owns that refusal — before the lock is taken, exit 64, with the path and the
# sha named — and two places refusing the same thing is how one of them drifts.
# Resolved ONCE, and the resolved sha is what gets gated. `gate_with_pinned_head`
# resolves its argument the same way and before the same lock, so handing it the
# sha rather than the caller's `HEAD` changes no timing — what it removes is the
# possibility of the label naming one commit and the gate pinning another,
# because a branch that moves between the two resolutions would give exactly
# that. An unresolvable target keeps its ORIGINAL spelling here, so the refusal
# that follows names what the caller actually typed.
if gate_sha=$(git -C "$repo_root" rev-parse --verify --quiet "${target}^{commit}"); then
  export HEAVY_LOCK_LABEL="gate:${gate_sha:0:8}"
  target=$gate_sha
else
  export HEAVY_LOCK_LABEL="gate:unresolved"
fi

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

trusted_launcher_dir=$(mktemp -d)
trusted_launcher="$trusted_launcher_dir/tool-wiki-lint.sh"
trap 'rm -rf -- "$trusted_launcher_dir"' EXIT
activation_root=${TOOL_WIKI_ACTIVATION_ROOT:-}
if [[ -n "$activation_root" ]]; then
  if [[ ! -e "$activation_root/active-v1" ]]; then
    printf 'h2puni gate: configured activation has no external marker\n' >&2
    exit 78
  fi
  launcher_source=$(resolve_tool_wiki_launcher "$activation_root" "$repo_root")
  cp "$launcher_source" "$trusted_launcher"
  chmod 0555 "$trusted_launcher"
  # Proof: h2puni-gate.test.sh cases 19-21 exercise the production resolver's default,
  # missing-runtime refusal, and candidate-containment refusal.
  TOOL_WIKI_TRUSTED_NODE_MODULES=$(resolve_tool_wiki_modules \
    "$activation_root" "$repo_root" "${TOOL_WIKI_TRUSTED_NODE_MODULES:-}")
  export TOOL_WIKI_TRUSTED_NODE_MODULES
  export TOOL_WIKI_REQUIRE_CERTIFIED=1
else
  trusted_launcher=
fi

# The launcher bytes are captured before checkout. Candidate gate steps remain the ordinary
# repository gate, but cannot run until the preserved external-trust verifier has accepted HEAD.
# Proof: gate-entrypoints.test.ts commits exit-0 replacements for both candidate scripts and
# observes the externally selected launcher reject obligation.application before either runs.
# Positional parameters belong to the preserved inner shell.
# shellcheck disable=SC2016
gate_with_pinned_head "$repo_root" "$(resolve_heavy_lock_path)" "$target" -- \
  bash -c 'set -euo pipefail; if [[ -n "$1" ]]; then bash "$1" committed "$2" "$3"; else printf "%s\n" "{\"schemaVersion\":1,\"status\":\"inactive\",\"certified\":false,\"reason\":\"external activation marker is not provisioned\"}"; fi; exec bash "$4" "$2" "$3"' \
  h2puni-preserved-wiki "$trusted_launcher" "$repo_root" HEAD \
  "$repo_root/bin/h2puni-gate-steps.sh"
