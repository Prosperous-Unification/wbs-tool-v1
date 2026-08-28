#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=bin/heavy-lock-lib.sh
source "$script_dir/heavy-lock-lib.sh"

with_heavy_lock /home/puni1/.cache/wbs-heavy-work.lock "$@"
