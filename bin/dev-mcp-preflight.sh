#!/usr/bin/env bash
# Runs on h2puni from the triggering checkout before devsync snapshots the old tree.
set -euo pipefail

ENV_PATH=${1:?usage: dev-mcp-preflight.sh <env-path> <exposure-state-path>}
EXPOSURE_PATH=${2:?usage: dev-mcp-preflight.sh <env-path> <exposure-state-path>}

if [ ! -f "$ENV_PATH" ]; then
  printf 'missing MCP environment: %s\n' "$ENV_PATH" >&2
  exit 1
fi
if [ ! -r "$ENV_PATH" ]; then
  printf 'unreadable MCP environment: %s\n' "$ENV_PATH" >&2
  exit 1
fi
if [ "$(stat -c '%a' "$ENV_PATH")" != 600 ]; then
  printf 'MCP environment must have mode 600: %s\n' "$ENV_PATH" >&2
  exit 1
fi

for key in PORT MCP_AUTH_MODE WBS_API_URL MCP_PUBLIC_URL; do
  if ! grep -Eq "^${key}=.+$" "$ENV_PATH"; then
    printf 'missing required %s in MCP environment: %s\n' "$key" "$ENV_PATH" >&2
    exit 1
  fi
done

if [ ! -e "$EXPOSURE_PATH" ]; then
  printf '0\n'
  exit 0
fi
if [ ! -f "$EXPOSURE_PATH" ] || [ ! -r "$EXPOSURE_PATH" ]; then
  printf 'unreadable MCP exposure state: %s\n' "$EXPOSURE_PATH" >&2
  exit 1
fi

state=$(cat "$EXPOSURE_PATH")
case "$state" in
  enabled)
    printf '1\n'
    ;;
  *)
    printf 'malformed MCP exposure state: %s\n' "$EXPOSURE_PATH" >&2
    exit 1
    ;;
esac
