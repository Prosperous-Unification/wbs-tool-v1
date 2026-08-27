#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
sha=$(git rev-parse HEAD)

exec "$repo_root/bin/with-heavy-lock.sh" -- \
  env WBS_SHA="$sha" bun run tools/tool-dagger/src/main.ts "$@"
