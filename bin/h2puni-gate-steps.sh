#!/usr/bin/env bash
set -euo pipefail

repo=${1:?repository is required}
: "${2:?committed revision is required}"
cd "$repo"

openspec_report=$(mktemp)
trap 'rm -f -- "$openspec_report"' EXIT
# Proof: h2puni-gate.test.sh injects failed=1, passed="0", passed=1.5 and failed-then-passing
# documents. The loose jq check admitted the latter three and reached Nx; this exact contract
# refuses every injected fault before Nx while retaining the validator JSON in gate output.
bunx @fission-ai/openspec@1.3.0 validate --all --json | tee "$openspec_report"
jq -s -e '
  length == 1 and
  (.[0] | type == "object") and
  (.[0].summary.totals.failed | type == "number" and floor == . and . == 0) and
  (.[0].summary.totals.passed | type == "number" and floor == . and . > 0)
' "$openspec_report" >/dev/null
rm -f -- "$openspec_report"
trap - EXIT

bunx nx format:check --all
# Proof: dropping this exclusion made gate-entrypoints.test.ts lose the exact-once split and fail
# at `Expected to contain: --exclude=wiki-cli`; wiki-cli source lint is invoked below.
bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache --exclude=wiki-cli
bunx nx run-many -t test typecheck build -p wiki-cli --parallel=2 --skip-nx-cache
bunx nx run wiki-cli:lint:source --skip-nx-cache
WBS_RUN_SOLVER_ORPHAN_PROC=1 bunx nx run wbs-be-01:solver-image-smoke
