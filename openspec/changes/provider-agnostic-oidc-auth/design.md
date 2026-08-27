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

The pre-OIDC schema cannot represent a null password or issuer-bound identity.
Downgrade therefore copies every identity field into the additive
`oidc_identity_downgrade` recovery table and gives each passwordless row the
same non-guessable Argon2 digest used by the legacy login path for unknown
users. The old service preserves accounts and foreign keys but cannot password-
authenticate an OIDC-only account. Re-applying the migrations restores the
exact email, issuer, subject, and null-password state before OIDC serves again;
missing recovery owners or a mismatched restore aborts the transaction.

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

Claude supports both DCR and a custom OAuth client ID/secret entered in its
connector UI; the latter uses the fixed redirect URI
`https://claude.ai/api/mcp/auth_callback`. It is still a manual registration and
credential-entry path, so it fails this deployment's zero-manual requirement.
Okta's DCR endpoint requires an administrative credential and therefore must not
be exposed to arbitrary connector registration. The selected shape is a local
fronting authorization server in mcp-01: RFC 9728 resource metadata points to
mcp-01's RFC 8414 metadata; Claude registers there, uses PKCE, and receives a
short-lived token with issuer `https://dev.wbs.bulletpoints.club/mcp/oauth` and
audience `https://dev.wbs.bulletpoints.club/mcp`.

The local token never reaches be-01. During the same browser authorization,
mcp-01 completes the upstream Okta code flow and stores the resulting access
token against the local MCP session `jti`. For each tool call, mcp-01 verifies
the local token, loads that server-side upstream token, and sends only the Okta
token to be-01. be-01 remains a single-issuer verifier for the configured Okta
issuer and `api://wbs-dev` audience. This is neither OBO nor token exchange: the
downstream credential is the original token acquired interactively for the WBS
API, and the MCP token is a distinct resource credential.

The 2026-08-24 spike signed both token classes with independent RS256 keys and
ran the whole mapping on h2puni. The valid trace preserved subject and scopes;
be-01 rejected the local MCP token, mcp-01 rejected the upstream Okta token, and
mcp-01 rejected a valid local token after its server-side session mapping was
removed. Verdict: **VALIDATED**. Sources: Anthropic's official “Building custom
connectors via remote MCP servers” help article; MCP authorization specification
2025-06-18; Okta Dynamic Client Registration API reference.

### D8. Dev exposes MCP on the existing origin without rewriting its path

The public MCP resource is `https://dev.wbs.bulletpoints.club/mcp`. Caddy uses
path-preserving `handle`, never `handle_path`, so mcp-01 receives `/mcp` and
`/mcp/oauth/*` exactly as its HTTP router declares them. Three well-known
locations route to mcp-01 explicitly:
`/.well-known/oauth-protected-resource`,
`/.well-known/oauth-protected-resource/mcp`, and
`/.well-known/oauth-authorization-server/mcp/oauth`. A blanket
`/.well-known/*` matcher is forbidden because it would claim unrelated origin
metadata.

The existing `wbs-dev-src` supervisor adds mcp-01 on port 3300. Its gitignored
`apps/mcp-01/.env` contains only standalone mode, the localhost be-01 URL, the
canonical public URL, and the port; the existing mode-600 shared OIDC env
supplies the provider credential and audience. The Auth0 Regular Web
Application must allow the byte-exact upstream callback
`https://dev.wbs.bulletpoints.club/mcp/oauth/callback` before exposure.

Deployment health does not accept an arbitrary 200. It asserts the protected
resource and authorization-server JSON fields, then asserts an unauthenticated
`POST /mcp` returns the RFC 9728 challenge naming the canonical resource
metadata URL. The public Caddy candidate remains unapplied until the
main-session exposure review.

## Risks / Trade-offs

- In-memory stores lose sessions on restart; `TokenStore` keeps Redis possible.
- Cookie scope spans `/ws`, so Origin checks are mandatory rather than optional.
- The public cutover removes migration fallback only after Keycloak and real
  Okta acceptance; that exposure diff receives main-session review.
- MCP fronting-AS implementation is blocked until the token/audience trace is
  demonstrated, preventing two mutually untrusted token systems from shipping.
- mcp-01 keeps OAuth grants and local-token mappings in memory. A dev process
  restart therefore requires a fresh connector authorization; persistence is a
  later availability feature, not part of this exposure slice.
