#!/usr/bin/env bash
# Archived from the TASK-415 run (workspace .tmp/t415-sweep.sh), vendored here
# by TASK-423 so the per-case duration numbers cited in test comments can be
# re-derived from this repository instead of from a scratch path in another one.
# Usage: bin/../notes/t415-sweep.sh <project-dir> [<project-dir> ...]
# Expects a checkout at $HOME/wbs-t415; results land in /dev/shm/t415.
# TASK-415: per-case duration sweep, one full run per bun-test project, on the
# heavy lock, ranked by margin to the 5000ms default case budget.
set -u
root=$HOME/wbs-t415
out=/dev/shm/t415
mkdir -p "$out"
: > "$out/index.txt"
for pj in "$@"; do
  name=$(printf '%s' "$pj" | tr '/' '-')
  cd "$root/$pj" || { echo "$pj MISSING" >> "$out/index.txt"; continue; }
  start=$(date +%s)
  HEAVY_LOCK_WAIT_SECONDS=900 "$root/bin/with-heavy-lock.sh" \
    bun test --reporter=junit --reporter-outfile="$out/$name.xml" \
    > "$out/$name.log" 2>&1
  rc=$?
  echo "$pj rc=$rc secs=$(( $(date +%s) - start ))" >> "$out/index.txt"
done
echo done > "$out/sweep.done"
