#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=bin/heavy-lock-lib.sh
source "$script_dir/heavy-lock-lib.sh"

# `status` answers the question a queued lane cannot answer for itself: who is
# holding the host, and how many runs are in front of me. Exactly one argument,
# so `status extra` falls through to the usage refusal below rather than being
# read as a request nobody made.
if [[ $# -eq 1 && $1 == status ]]; then
  # No `exit 0` before this returns: `set -e` carries a refusal's own exit code
  # (70) out of the script, and only a clean report reaches the line after it.
  report_heavy_lock_status "$(resolve_heavy_lock_path)"
  exit 0
fi

# The path is resolved per platform rather than hardcoded to h2puni's: this
# script is the only way to serialise heavy work, and a Linux-only path made it
# exit 127 on every Mac, which is why local runs bypassed it entirely.
with_heavy_lock "$(resolve_heavy_lock_path)" "$@"
