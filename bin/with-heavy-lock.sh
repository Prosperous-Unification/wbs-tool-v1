#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != -- || $# -lt 2 ]]; then
  printf 'usage: %s -- command [arg ...]\n' "$0" >&2
  exit 64
fi
shift

lock_path=${WBS_HEAVY_LOCK:-/home/puni1/.cache/wbs-heavy-work.lock}
exec flock --exclusive --nonblock --conflict-exit-code 75 "$lock_path" "$@"
