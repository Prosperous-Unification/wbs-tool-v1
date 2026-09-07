#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

exec "$repo_root/bin/with-heavy-lock.sh" -- bash -c '
  bunx nx format:check --all &&
  bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache &&
  WBS_RUN_SOLVER_ORPHAN_PROC=1 bunx nx run be-01:solver-image-smoke
'
