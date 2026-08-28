#!/usr/bin/env bash
set -euo pipefail

with_heavy_lock() {
  local lock_path=${1:?lock path is required}
  shift
  if [[ ${1:-} != -- || $# -lt 2 ]]; then
    printf 'usage: %s -- command [arg ...]\n' "$0" >&2
    return 64
  fi
  shift

  exec flock --exclusive --nonblock --conflict-exit-code 75 "$lock_path" "$@"
}
