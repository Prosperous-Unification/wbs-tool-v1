#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
image="wbs-be-01:solver-smoke"
request="$repo_root/libs/contracts/solver/fixtures/request/valid-quantised-baseline.json"

docker build --file "$repo_root/apps/be-01/Dockerfile" --tag "$image" "$repo_root"

docker run --rm --interactive --entrypoint wbs-solver "$image" <"$request" >/dev/null

deadline_epoch_ms="$(( $(date +%s) * 1000 + 30000 ))"
{
  printf 'bound\n'
  cat "$request"
} | docker run --rm --interactive --entrypoint wbs-solver-launcher "$image" \
  --attempt-token 0123456789abcdef0123456789abcdef \
  --child-deadline-epoch-ms "$deadline_epoch_ms" >/dev/null
