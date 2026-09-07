#!/usr/bin/env bash
set -euo pipefail

origin=${1:?usage: dev-be-probe.sh <origin>}
identity=$(curl -s --max-time 15 "${origin%/}/api/auth/me")

# Proof: be-probe.test.ts requires the anonymous user envelope; the old
# invalid_token-only probe was watched fail against that contract in TASK-299.
if [ "$identity" = '{"user":null}' ]; then
  printf '[dev-deploy] %-28s %s\n' 'be (auth routes mounted)' 'ok'
  exit 0
fi

printf '[dev-deploy] %-28s %s FAIL\n' 'be (auth routes mounted)' "$identity" >&2
exit 1
