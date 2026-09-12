#!/usr/bin/env bash
set -euo pipefail

repo=${1:?repository is required}
: "${2:?committed revision is required}"
cd "$repo"

bunx nx format:check --all
# Proof: dropping this exclusion made gate-entrypoints.test.ts lose the exact-once split and fail
# at `Expected to contain: --exclude=tool-wiki`; tool-wiki source lint is invoked below.
bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache --exclude=tool-wiki
bunx nx run-many -t test typecheck build -p tool-wiki --parallel=2 --skip-nx-cache
bunx nx run tool-wiki:lint:source --skip-nx-cache
WBS_RUN_SOLVER_ORPHAN_PROC=1 bunx nx run be-01:solver-image-smoke
