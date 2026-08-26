## Why

The WebSocket client put a 12-hour session JWT in `/ws?token=...`. Access-log
redaction now hides that value at Caddy, but a URL still reaches browser history,
session restoration, intermediary logs, and copied links. Authentication must
move to the existing hardened browser cookie without retaining a query-string
fallback.

## What Changes

- Browser and shared reconnecting clients open the configured `/ws` URL
  verbatim and never accept a JWT callback.
- OIDC upgrades authenticate from `__Host-wbs_access` and exact Origin; explicit
  local mode keeps its fixed cookie-free identity.
- Missing authentication configuration fails closed. Query values cannot supply
  either a session token or the trusted local identity.
- Deployment smoke sends the cookie and Origin as headers while keeping the
  request target credential-free.
- Operator documentation removes the query-token procedure.

## Non-Goals

This change does not alter JWT lifetime, session issuance, refresh, cookie
attributes, or the OIDC provider. It does not add WebSocket subprotocol or
first-frame authentication because the hardened cookie path already exists.

## Constraints

- No compatibility window may restore a credential-bearing URL.
- Local development remains possible without an IdP only through explicit local
  mode.
- The production smoke must exercise the same cookie and Origin boundary as the
  browser.
- The public authentication path requires prod-mode review before merge.

## Capabilities

### New Capabilities

- `websocket-session-authentication`: credential-free WebSocket request targets
  with explicit local and OIDC trust boundaries

### Modified Capabilities

none

## Domain Terms

none

## Decisions Recorded

none — the implementation uses the existing browser session cookie contract.

## Impact

gw-01 authentication and integration fixtures; `@wbs/realtime`; frontend
socket callers; deployment smoke; local and dev-deploy runbooks.
