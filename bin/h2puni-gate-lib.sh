#!/usr/bin/env bash
set -euo pipefail

# Runs the gate steps on a head that cannot move while they run.
#
# `heavy-lock-lib.sh` serialises the STEPS. It never serialised the checkout the
# steps read, and on h2puni every lane gates in one shared tree (~/wbs-t267 is
# the one several lanes use), each checking its own sha in before invoking the
# gate. Two facts, one hole: lane X holds the lock and runs `nx run-many` in a
# tree whose head lane Y moved a second ago, and the gate reports green or red
# about a head nobody asked it about. Watched on 2026-09-07 — lane b checked
# 9235c40d into that tree 26 seconds into another lane's already-running gate,
# and nothing failed loudly. That is the whole problem.
#
# The fix is to make the checkout the first thing that happens INSIDE the mutex,
# so there is no window between choosing the head and reading it that another
# lane can reach. `bin/h2puni-gate.test.sh` case 2 is the negative control.

gate_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=bin/heavy-lock-lib.sh
source "$gate_lib_dir/heavy-lock-lib.sh"

# Check `$sha` out in `$repo` under the heavy lock at `$lock_path`, then run
# `command [arg ...]` there with that head pinned for the whole run.
#
# The lock path is an argument for the reason `heavy-lock-lib.sh` gives at
# length: a caller that can name its own lock is a caller that can opt out of
# the lock, so there is no environment override and production passes
# `resolve_heavy_lock_path`.
gate_with_pinned_head() {
  local repo=${1:?repo is required}
  local lock_path=${2:?lock path is required}
  local sha=${3:?sha is required}
  shift 3
  if [[ ${1:-} != -- || $# -lt 2 ]]; then
    printf 'usage: gate_with_pinned_head repo lock sha -- command [arg ...]\n' >&2
    return 64
  fi
  shift

  # Resolved BEFORE the lock. A sha that does not name a commit is a typo in the
  # caller, and finding that out after queueing would park the host-wide mutex
  # for as long as a gate to print a message the caller could have had at once.
  local pinned
  if ! pinned=$(git -C "$repo" rev-parse --verify --quiet "${sha}^{commit}"); then
    printf 'h2puni gate: %s is not a commit in %s\n' "$sha" "$repo" >&2
    return 64
  fi

  # `git checkout` runs inside the locked payload, not before it. Everything the
  # steps read is therefore chosen and consumed under one mutex.
  #
  # The head is echoed after the checkout rather than before: what a gate result
  # is ABOUT is the head the tree actually had when the steps ran, and printing
  # the intended sha instead is how a report can be honest and wrong at once.
  # `git checkout --detach` pins HEAD; it does not pin the BYTES. Non-conflicting
  # tracked edits survive it and untracked files are not touched at all, and Nx
  # reads the tree, not the commit — so a gate can report `running on <sha>` over
  # a lint failure in a file that sha does not contain. That verdict is worse
  # than a red one, because it is attributed to a commit.
  #
  # The refusal truncates its listing WITHOUT a pipe. `printf … | head -10` reads
  # naturally and is wrong here: `head` exits on the eleventh line, the builtin
  # `printf` takes SIGPIPE on a listing large enough to fill the pipe, and `set
  # -euo pipefail` then reports 141 where automation was promised 65 — the
  # refusal replaced by a signal, on exactly the dirtiest trees. The round-3 peer
  # reproduced that at a 4,000,151-byte listing (pipeline statuses `141,0`); an
  # 88 KB one did not, because the pipe on this host takes up to 1 MiB — so a
  # `|| true` beside the pipe would have been certified by a regression case that
  # never reaches its own failure. A `while read` over a here-doc rather than
  # `mapfile`, because macOS ships bash 3.2 as /bin/bash and has no `mapfile`.
  #
  # Nothing inside the payload may contain an apostrophe: it is a single-quoted
  # `bash -c` string, and one in a comment there was watched ending the quote and
  # breaking the file with `syntax error near unexpected token fi`. That is why
  # this note lives out here.
  #
  # Refused rather than cleaned: `git clean -fd` in a tree several lanes share
  # deletes work nobody asked us to delete, and this runs unattended. The gate
  # gates a COMMIT; anything else in the tree is a caller error with a name
  # printed next to it. Raised by the peer review of 75408058 (TASK-328).
  with_heavy_lock "$lock_path" -- bash -c '
    set -euo pipefail
    repo=$1
    pinned=$2
    shift 2
    original_commit=$(git -C "$repo" rev-parse HEAD)
    original_ref=
    if branch_ref=$(git -C "$repo" symbolic-ref --quiet HEAD); then
      original_ref=$branch_ref
    fi
    restore_saved_detached() {
      git -C "$repo" checkout --detach --quiet "$original_commit" || return 1
      if git -C "$repo" symbolic-ref --quiet HEAD >/dev/null; then return 1; fi
      [[ $(git -C "$repo" rev-parse HEAD) == "$original_commit" ]]
    }
    restore_rejected_checkout() {
      status=$?
      trap - EXIT
      if [[ $status -ne 0 ]]; then
        if [[ -n $original_ref ]]; then
          current_ref_commit=$(git -C "$repo" rev-parse --verify --quiet "${original_ref}^{commit}") || current_ref_commit=
          if [[ $current_ref_commit != "$original_commit" ]]; then
            if ! restore_saved_detached; then
              printf "h2puni gate: failed to preserve saved commit %s after original branch moved during gate: %s\n" "$original_commit" "$original_ref" >&2
              exit 74
            fi
            # Proof: h2puni-gate.test.sh moves the original branch during the production gate;
            # recovery leaves its new ref untouched, restores the saved commit detached, and exits 74.
            if [[ -z $current_ref_commit ]]; then
              printf "h2puni gate: failed to restore pre-gate checkout because original branch is missing; saved commit restored detached: %s at %s\n" "$original_ref" "$original_commit" >&2
            else
              printf "h2puni gate: original branch moved during gate; saved commit restored detached: %s was %s, now %s\n" "$original_ref" "$original_commit" "$current_ref_commit" >&2
            fi
            exit 74
          fi
          if ! restore_saved_detached ||
            ! git -C "$repo" symbolic-ref HEAD "$original_ref" ||
            [[ $(git -C "$repo" symbolic-ref --quiet HEAD) != "$original_ref" ]] ||
            [[ $(git -C "$repo" rev-parse HEAD) != "$original_commit" ]]; then
            if ! restore_saved_detached; then
              printf "h2puni gate: failed to preserve saved commit %s after checkout restore failure: %s\n" "$original_commit" "$original_ref" >&2
              exit 74
            fi
            printf "h2puni gate: failed to restore pre-gate checkout %s at %s; saved commit restored detached\n" "$original_ref" "$original_commit" >&2
            exit 74
          fi
        elif ! restore_saved_detached; then
          printf "h2puni gate: failed to restore pre-gate checkout detached at %s\n" "$original_commit" >&2
          exit 74
        fi
      fi
      exit "$status"
    }
    # Proof: h2puni-gate.test.sh rejects branch and detached candidates and observes both
    # exact checkout shapes restored; deleting the saved branch makes recovery exit 74 loudly.
    trap restore_rejected_checkout EXIT
    git -C "$repo" checkout --detach --quiet "$pinned"
    dirty=$(git -C "$repo" status --porcelain --untracked-files=normal)
    if [[ -n $dirty ]]; then
      printf "h2puni gate: %s is dirty after checking out %s; refusing to report a verdict about bytes that commit does not contain:\n" "$repo" "$pinned" >&2
      # No pipe here, and no apostrophes either: see the two notes above this
      # call, both of which are load-bearing and both of which were watched.
      shown=0
      while IFS= read -r line; do
        printf "  %s\n" "$line" >&2
        shown=$((shown + 1))
        if [[ $shown -ge 10 ]]; then
          break
        fi
      done <<EOF
$dirty
EOF
      total=$(printf "%s\n" "$dirty" | wc -l)
      if [[ $total -gt $shown ]]; then
        printf "  … and %s more\n" "$((total - shown))" >&2
      fi
      exit 65
    fi
    printf "h2puni gate: running on %s\n" "$(git -C "$repo" rev-parse HEAD)" >&2
    cd "$repo"
    "$@"
  ' h2puni-gate-under-lock "$repo" "$pinned" "$@"
}
