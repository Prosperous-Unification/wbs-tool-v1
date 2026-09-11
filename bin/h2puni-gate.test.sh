#!/usr/bin/env bash
# Tests for the gate's head pinning.
#
# The bug these exist for was WATCHED, not theorised (TASK-328): every lane
# gates in one shared checkout on h2puni and each checked its own sha into that
# tree BEFORE calling the gate, so the checkout sat outside the mutex the gate
# steps run under. On 2026-09-07 lane b checked 9235c40d into ~/wbs-t267 26
# seconds into another lane's already-running gate; that gate then reported
# green about lane b's head, silently, and nothing failed loudly.
#
# Case 2 is the negative control: with the checkout back outside the lock it
# passes trivially, because moving the head while another run holds the lock is
# exactly what the old shape did.
#
# No heavy work runs here — the gate steps are an argument, so every case runs
# in well under a second against a scratch git repo.
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gate_lib="$repo_root/bin/h2puni-gate-lib.sh"

failures=0
fail() {
  printf '  FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}
pass() { printf '  ok: %s\n' "$1"; }

expect_status() {
  local want=$1 got=$2 what=$3
  if [[ $got -eq $want ]]; then pass "$what (exit $got)"; else fail "$what: want exit $want, got $got"; fi
}

expect_equal() {
  local want=$1 got=$2 what=$3
  if [[ $want == "$got" ]]; then pass "$what"; else fail "$what: want '$want', got '$got'"; fi
}

# A scratch repo with two commits, so a test can ask for one head while the
# working tree sits on the other.
make_repo() {
  local dir=$1
  git init -q -b main "$dir"
  git -C "$dir" config user.email gate-test@example.invalid
  git -C "$dir" config user.name 'gate test'
  printf 'a\n' >"$dir/f"
  git -C "$dir" add f
  git -C "$dir" commit -qm a
  printf 'b\n' >"$dir/f"
  git -C "$dir" commit -qam b
}

# The library entry point, given the lock path as an argument.
#
# The seam is that argument and nothing else, for the reason `heavy-lock-lib.sh`
# records: a caller able to choose its own lock path through the ENVIRONMENT is
# a caller able to opt out of the lock. Production takes the canonical path from
# `resolve_heavy_lock_path`.
run_gate() {
  local repo=$1 lock=$2 sha=$3
  shift 3
  # shellcheck disable=SC2016 # Single quotes are the point: `$1`/`$@` belong to
  # the inner shell, not to this one.
  local inner='source "$1"; shift; gate_with_pinned_head "$@"'
  HEAVY_LOCK_WAIT_SECONDS="${HEAVY_LOCK_WAIT_SECONDS:-0}" \
    bash -c "$inner" h2puni-gate-test "$gate_lib" "$repo" "$lock" "$sha" -- "$@"
}

scratch="${TMPDIR:-/tmp}/wbs-h2puni-gate-test.$$"
rm -rf "$scratch"
mkdir -p "$scratch"
trap 'rm -rf "$scratch"' EXIT

lock="$scratch/lock"
repo="$scratch/repo"
make_repo "$repo"
sha_a=$(git -C "$repo" rev-parse HEAD~1)
sha_b=$(git -C "$repo" rev-parse HEAD)

status=0

# 1. The steps run on the sha the caller asked for, not on whatever head the
# shared tree happened to be left on. This is the whole point: the tree is at B,
# the gate was asked for A, and the steps must see A.
run_gate "$repo" "$lock" "$sha_a" bash -c 'git rev-parse HEAD >"$0"' "$scratch/seen-1" || status=$?
expect_status 0 "$status" 'gate on a pinned sha succeeds'
expect_equal "$sha_a" "$(cat "$scratch/seen-1" 2>/dev/null)" 'steps run on the requested sha, not the tree head'
expect_equal "$sha_a" "$(git -C "$repo" rev-parse HEAD)" 'the tree is left on the gated sha'

# 2. NEGATIVE CONTROL, and the case that fails when the checkout moves back
# outside the lock. Someone else holds the lock, so a refused gate must not have
# touched the head at all — under the old shape the caller had already checked
# its sha in before the gate was ever invoked, which is how one lane's gate came
# to report about another lane's head.
git -C "$repo" checkout -q --detach "$sha_b"
mkdir -p "$lock.d"
printf '%s\n' "$$" >"$lock.d/holder" # this test process is alive, so not stale
status=0
HEAVY_LOCK_WAIT_SECONDS=0 run_gate "$repo" "$lock" "$sha_a" true 2>/dev/null || status=$?
expect_status 75 "$status" 'a gate refused for a held lock exits 75'
expect_equal "$sha_b" "$(git -C "$repo" rev-parse HEAD)" 'a refused gate leaves the head where it found it'
rm -rf "$lock.d"

# 3. The interleaving, closed: two gates race for one shared tree and each one's
# steps see its own sha. The second queues rather than refusing, which is what
# `HEAVY_LOCK_WAIT_SECONDS` buys.
(
  run_gate "$repo" "$lock" "$sha_a" bash -c 'git rev-parse HEAD >"$0"; sleep 3' "$scratch/seen-first"
) &
first=$!
# Wait for the first to actually hold the lock before racing it, rather than
# assuming a sleep is long enough.
for _ in $(seq 1 50); do
  [[ -d $lock.d ]] && break
  sleep 0.1
done
status=0
HEAVY_LOCK_WAIT_SECONDS=30 run_gate "$repo" "$lock" "$sha_b" bash -c 'git rev-parse HEAD >"$0"' "$scratch/seen-second" || status=$?
wait "$first"
expect_status 0 "$status" 'the second gate queues behind the first and runs'
expect_equal "$sha_a" "$(cat "$scratch/seen-first" 2>/dev/null)" 'the first gate ran on its own sha'
expect_equal "$sha_b" "$(cat "$scratch/seen-second" 2>/dev/null)" 'the second gate ran on its own sha, not the first one'

# 4. A sha that is not a commit in this repo is refused before the lock is taken,
# so a typo cannot park the host-wide mutex for the length of a gate.
status=0
run_gate "$repo" "$lock" 0000000000000000000000000000000000000000 true 2>/dev/null || status=$?
expect_status 64 "$status" 'an unknown sha is refused'
if [[ -d $lock.d ]]; then fail 'an unknown sha took the lock'; else pass 'an unknown sha never took the lock'; fi

# 5. Contract check: the shipped gate queues by default. A gate that refuses
# immediately burns the caller's whole run box (see the comment at that line).
if grep -q 'HEAVY_LOCK_WAIT_SECONDS:=[1-9]' "$repo_root/bin/h2puni-gate.sh"; then
  pass 'bin/h2puni-gate.sh defaults to queueing, not refusing'
else
  fail 'bin/h2puni-gate.sh does not set a non-zero HEAVY_LOCK_WAIT_SECONDS default'
fi

# 6. A pinned head is not a pinned tree. `checkout --detach` leaves
# non-conflicting tracked edits and every untracked file in place, and Nx reads
# the tree — so the gate must refuse rather than report a verdict about bytes the
# commit does not contain. Both shapes are checked, because they survive a
# checkout for different reasons.
git -C "$repo" checkout -q --detach "$sha_b"
printf 'local edit\n' >>"$repo/f"
status=0
run_gate "$repo" "$lock" "$sha_b" bash -c 'echo ran >"$0"' "$scratch/ran-dirty" 2>/dev/null || status=$?
expect_status 65 "$status" 'a tracked edit surviving the checkout is refused'
if [[ -e $scratch/ran-dirty ]]; then fail 'the steps ran over a modified tracked file'; else pass 'the steps never ran over a modified tracked file'; fi
git -C "$repo" checkout -q -- f

# 400 untracked files, so the refusal has to truncate. The status must still be
# the documented 65 and the listing must be bounded: an earlier cut of this code
# truncated with `printf … | head -10`, where a large enough listing makes the
# builtin `printf` take SIGPIPE and `set -euo pipefail` report 141 instead — the
# refusal replaced by a signal on the dirtiest trees. There is no pipe there now.
#
# This case is a real guard here, not merely a contract pin: restoring
# `printf "  %s\n" $dirty | head -10` in h2puni-gate-lib.sh was watched on this
# workstation failing three of its own assertions —
#   FAIL: an untracked file the commit does not contain is refused: want exit 65, got 141
#   FAIL: a 400-file refusal lists ten paths and says how many more: want '11', got '10'
#   FAIL: the refusal did not report the remaining count
# — at these 400 files with 200-character names, well under the 4,000,151-byte
# listing the round-3 peer needed. Observed 2026-09-10; the earlier note saying
# an 88 KB listing did not reproduce it is about a different pipe buffer, not
# about this case being unable to fail.
long_name=$(printf 'u%.0s' $(seq 1 200))
for i in $(seq 1 400); do printf 'stray\n' >"$repo/untracked-$i-$long_name.ts"; done
status=0
run_gate "$repo" "$lock" "$sha_b" bash -c 'echo ran >"$0"' "$scratch/ran-untracked" 2>"$scratch/refusal-stderr" || status=$?
expect_status 65 "$status" 'an untracked file the commit does not contain is refused'
if [[ -e $scratch/ran-untracked ]]; then fail 'the steps ran over an untracked file'; else pass 'the steps never ran over an untracked file'; fi
listed=$(grep -c '^  ' "$scratch/refusal-stderr" || true)
# Ten paths plus the "… and N more" line: bounded, and it says what it hid.
expect_equal 11 "$listed" 'a 400-file refusal lists ten paths and says how many more'
if grep -q '… and 390 more' "$scratch/refusal-stderr"; then pass 'the refusal counts the paths it did not print'; else fail 'the refusal did not report the remaining count'; fi
rm -f "$repo"/untracked-*.ts

# 7. Contract check: that default reaches the lock as a shell variable and stops
# there. Exported, it would enter every gate step's environment, and
# `bin/heavy-lock.test.sh`'s refusal cases forward `${HEAVY_LOCK_WAIT_SECONDS:-0}`
# from theirs — under a gate they would inherit 1800 and spin for half an hour
# instead of asserting an immediate refusal. That false red has been watched once
# already, from the command-line recipe (`tools/tool-dagger/src/heavy-lock.test.ts:54`).
if grep -q '^[[:space:]]*export[[:space:]]\+HEAVY_LOCK_WAIT_SECONDS' "$repo_root/bin/h2puni-gate.sh"; then
  fail 'bin/h2puni-gate.sh exports its wait default into the gate steps'
else
  pass 'the wait default stops at the lock and never enters the steps environment'
fi

if ((failures)); then
  printf '\n%d failing case(s)\n' "$failures" >&2
  exit 1
fi
printf '\nall cases passed\n'
