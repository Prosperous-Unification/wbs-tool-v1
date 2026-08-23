# Design — provider-agnostic OIDC authentication

## Context

The deployed origin routes `/api/*` to be-01 and `/ws*` to gw-01. The registered
Okta callback is `/api/auth/okta/callback`. WBS uses SQLite, existing accounts
have usernames but no email column, and none of the 20 current dev usernames is
email-shaped. MCP currently forwards a static WBS account token.

## Goals / Non-Goals

**Goals:** one issuer/audience contract across API, WebSocket, and standalone
MCP; a browser-bound OIDC transaction and renewable session; collision-safe
identity linking; explicit request scopes; a measured zero-manual Claude MCP
flow; read-scoped solution integration.
**Non-Goals:** Okta SDKs, Redis now, OBO/token exchange, weakening cookies for
plain HTTP, or letting a gateway mode become an implicit signature bypass.

## Decisions

### D1. be-01 owns the browser flow; verification is shared

be-01 mounts login, callback, refresh, and logout under `/api/auth`. A shared
`@wbs/auth` library owns mode validation, claim parsing, and RS256/JWKS token
verification so be-01, gw-01, and mcp-01 enforce the same issuer and audience.
`AUTH_REDIRECT_URI` is env-only and its pathname must be the mounted callback.

### D2. Transactions and sessions are server-side

The initiating browser receives a short-lived transaction cookie bound to a
single-use `{state, nonce, verifier}` record. Atomic consume prevents replay.
The access token is in a `__Host-` httpOnly Secure SameSite=Lax cookie; refresh
tokens stay behind `TokenStore`, keyed by a hashed session correlation and
rotated atomically. Logout removes local state, attempts upstream revocation,
and clears the cookie with identical attributes.

### D3. Cookie authentication carries browser-origin defenses

All cookie-authenticated mutations verify Origin/CSRF. WebSocket upgrade checks
the cookie token and same-origin or an explicit allowlist. gw-01 never refreshes
a session; the client calls be-01 refresh preflight before reconnecting.

### D4. Identity is issuer-bound and email linking is narrow

The durable key is `(idp_issuer, idp_sub)`. First login checks that key first,
then a lowercased email only when `email_verified=true`, in one transaction.
Only a legacy username that itself parses as that email may auto-link. Existing
non-email accounts remain local; new OIDC usernames are deterministic and
collision-safe. `password_hash` becomes nullable through a reversible SQLite
table rebuild.

### D5. Authorization is additive

An env-selected groups claim parses only values in the configured environment
namespace into read, write, and editor scopes. Every mutating be-01 route needs
write scope; the existing restricted-project owner rule remains stricter and is
applied on top.

### D6. MCP has two explicit trust modes

Standalone mode verifies a Bearer token with the shared verifier. Gateway mode
may decode already-verified claims only when `MCP_TRUSTED_GATEWAY=true`; boot
otherwise fails. A caller token is forwarded only when be-01 trusts that issuer
and audience. Health has separate liveness, readiness, and ALB-readiness paths.

### D7. Claude OAuth needs a measured fronting-AS trace

Okta does not offer open dynamic client registration. Before implementation, a
spike checks whether Claude accepts a pre-registered client. If it does not,
mcp-01 exposes RFC 9728/8414 metadata, DCR, PKCE, and its own short-lived tokens.
The MCP-scoped token stays local; the upstream Okta token acquired during login
is stored server-side and is the only token forwarded to be-01. This is not OBO.

## Risks / Trade-offs

- In-memory stores lose sessions on restart; `TokenStore` keeps Redis possible.
- Cookie scope spans `/ws`, so Origin checks are mandatory rather than optional.
- The public cutover removes migration fallback only after Keycloak and real
  Okta acceptance; that exposure diff receives main-session review.
- MCP fronting-AS implementation is blocked until the token/audience trace is
  demonstrated, preventing two mutually untrusted token systems from shipping.
