# Design — credential-free WebSocket request targets

## Context

The OIDC browser flow already stores its access token in the
`__Host-wbs_access` httpOnly cookie and gw-01 already validates that cookie and
Origin. A legacy fallback still accepted `query.token`; `@wbs/realtime` required
a JWT callback and appended its value on every reconnect. The smoke tool copied
the same shape. Query objects also carried trusted hook state under ordinary
string keys, so a URL could collide with an internal value.

## Decisions

### D1. OIDC uses the existing cookie boundary

gw-01 accepts an OIDC upgrade only when `appOrigin` is configured, the request
Origin matches it exactly, and the access cookie verifies. There is no
query-token compatibility branch. Missing `appOrigin` outside explicit local
mode answers 401 before a socket opens.

### D2. Local mode is configuration, not input

Explicit local boot supplies one fixed `localIdentity`. The upgrade hook writes
that identity to a module-private Symbol. Verified OIDC tokens use a second
module-private Symbol. Query keys such as `localIdentity` and `token` therefore
cannot impersonate hook-verified state even if Elysia exposes query properties
on the later open context.

### D3. Reconnect preserves the caller's URL

`createReconnectingWs` opens `opts.url` verbatim. It no longer accepts a JWT
callback, so neither the first connection nor a retry can synthesize a
credential-bearing request target. Browser cookies continue to ride the normal
upgrade automatically.

### D4. Smoke authenticates in headers

The direct Caddy handshake sends the exact `/ws` path, the deployment Origin,
and the access cookie. The URL-override path uses the same two headers. The
request-builder test inspects the complete HTTP upgrade text so a later
`?token=` regression is visible before deployment.

## Failure behavior

Missing auth configuration, missing/invalid cookie, foreign Origin, expired
cookie, and URL-only credentials are all refused before `open`. A verified
identity is rechecked before joining presence; a failed recheck joins nobody.
