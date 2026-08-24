#!/usr/bin/env bash
set -euo pipefail

ORIGIN=${1:?usage: dev-mcp-probe.sh <origin>}
RESOURCE="$ORIGIN/mcp"
RESOURCE_METADATA="$ORIGIN/.well-known/oauth-protected-resource"
AUTHORIZATION_METADATA="$ORIGIN/.well-known/oauth-authorization-server/mcp/oauth"

protected=$(curl -fsS --max-time 15 "$RESOURCE_METADATA")
# shellcheck disable=SC2016 -- the embedded Bun program owns template interpolation.
printf '%s' "$protected" | ORIGIN="$ORIGIN" bun -e '
  const body = await Bun.stdin.json();
  const resource = `${process.env.ORIGIN}/mcp`;
  const authorizationServer = `${resource}/oauth`;
  if (body.resource !== resource) throw new Error(`unexpected MCP resource: ${String(body.resource)}`);
  if (JSON.stringify(body.authorization_servers) !== JSON.stringify([authorizationServer])) {
    throw new Error(`unexpected MCP authorization_servers: ${JSON.stringify(body.authorization_servers)}`);
  }
'

authorization=$(curl -fsS --max-time 15 "$AUTHORIZATION_METADATA")
# shellcheck disable=SC2016 -- the embedded Bun program owns template interpolation.
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
'

challenge=$(curl -sS --max-time 15 -o /dev/null \
  -w $'%{http_code}\n%header{www-authenticate}' -X POST "$RESOURCE")
expected_challenge=$(printf '401\nBearer resource_metadata="%s"' "$RESOURCE_METADATA")
if [ "$challenge" != "$expected_challenge" ]; then
  printf 'unexpected MCP challenge: %s\n' "$challenge" >&2
  exit 1
fi

printf '[dev-deploy] %-28s %s\n' 'MCP discovery and challenge' 'ok'
