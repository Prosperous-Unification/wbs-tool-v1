#!/usr/bin/env bash
set -euo pipefail

ORIGIN=${1:?usage: dev-mcp-probe.sh <origin>}
RESOURCE="$ORIGIN/mcp"
RESOURCE_METADATA="$ORIGIN/.well-known/oauth-protected-resource"
RESOURCE_METADATA_PATH="$ORIGIN/.well-known/oauth-protected-resource/mcp"
AUTHORIZATION_METADATA="$ORIGIN/.well-known/oauth-authorization-server/mcp/oauth"

case ${MCP_EXPOSURE_EXPECTED:-0} in
  0)
    printf '[dev-deploy] %-28s %s\n' 'MCP exposure not expected' 'skip'
    exit 0
    ;;
  1) ;;
  *)
    printf 'MCP_EXPOSURE_EXPECTED must be 0 or 1\n' >&2
    exit 1
    ;;
esac

if [ "${MCP_PROBE_ONCE:-0}" != 1 ]; then
  probe_deadline_seconds=${MCP_PROBE_DEADLINE_SECONDS:-60}
  case $probe_deadline_seconds in
    ''|*[!0-9]*)
      printf 'MCP_PROBE_DEADLINE_SECONDS must be a non-negative integer\n' >&2
      exit 1
      ;;
  esac
  probe_deadline=$((SECONDS + probe_deadline_seconds))
  while :; do
    if MCP_PROBE_ONCE=1 "$0" "$ORIGIN"; then
      exit 0
    else
      probe_result=$?
    fi
    if [ "$SECONDS" -ge "$probe_deadline" ]; then
      exit "$probe_result"
    fi
    sleep 2
  done
fi

for metadata_url in "$RESOURCE_METADATA" "$RESOURCE_METADATA_PATH"; do
  protected=$(curl -fsS --max-time 15 "$metadata_url")
  # The embedded Bun program owns template interpolation.
  # shellcheck disable=SC2016
  printf '%s' "$protected" | ORIGIN="$ORIGIN" bun -e '
    const body = await Bun.stdin.json();
    const resource = `${process.env.ORIGIN}/mcp`;
    const authorizationServer = `${resource}/oauth`;
    if (body.resource !== resource) throw new Error(`unexpected MCP resource: ${String(body.resource)}`);
    if (JSON.stringify(body.authorization_servers) !== JSON.stringify([authorizationServer])) {
      throw new Error(`unexpected MCP authorization_servers: ${JSON.stringify(body.authorization_servers)}`);
    }
  '
done

authorization=$(curl -fsS --max-time 15 "$AUTHORIZATION_METADATA")
# The embedded Bun program owns template interpolation.
# shellcheck disable=SC2016
printf '%s' "$authorization" | ORIGIN="$ORIGIN" bun -e '
  const body = await Bun.stdin.json();
  const issuer = `${process.env.ORIGIN}/mcp/oauth`;
  const expected = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    jwks_uri: `${issuer}/jwks`,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value) throw new Error(`unexpected MCP ${key}: ${String(body[key])}`);
  }
  const expectedArrays = {
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
  for (const [key, value] of Object.entries(expectedArrays)) {
    if (JSON.stringify(body[key]) !== JSON.stringify(value)) {
      throw new Error(`unexpected MCP ${key}: ${JSON.stringify(body[key])}`);
    }
  }
'

challenge=$(curl -sS --max-time 15 -o /dev/null \
  -w $'%{http_code}\n%header{www-authenticate}' -X POST "$RESOURCE")
expected_challenge=$(printf '401\nBearer resource_metadata="%s"' "$RESOURCE_METADATA")
if [ "$challenge" != "$expected_challenge" ]; then
  printf 'unexpected MCP challenge: %s\n' "$challenge" >&2
  exit 1
fi

printf '[dev-deploy] %-28s %s\n' 'MCP discovery and challenge' 'ok'
