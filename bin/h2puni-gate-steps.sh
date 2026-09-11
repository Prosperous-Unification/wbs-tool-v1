#!/usr/bin/env bash
set -euo pipefail

repo=${1:?repository is required}
revision=${2:?committed revision is required}
gate_bin=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$repo"

# Proof: omitting this call made the stale-blob host fixture reach Nx and fail with
# `bun is unable to write files to tempdir: EROFS` instead of naming obligation.application.
bash "$gate_bin/tool-wiki-lint.sh" committed "$repo" "$revision"
bunx nx format:check --all
# Proof: dropping this exclusion made gate-entrypoints.test.ts lose the exact-once split and fail
# at `Expected to contain: --exclude=tool-wiki`; tool-wiki source lint is invoked below.
bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache --exclude=tool-wiki
bunx nx run-many -t test typecheck build -p tool-wiki --parallel=2 --skip-nx-cache
bunx nx run tool-wiki:lint:source --skip-nx-cache
WBS_RUN_SOLVER_ORPHAN_PROC=1 bunx nx run be-01:solver-image-smoke
