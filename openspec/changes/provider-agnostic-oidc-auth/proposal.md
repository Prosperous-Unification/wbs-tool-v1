## Why

WBS authenticates browsers with a home-grown username/password token, WebSockets
with a token handshake, and MCP with one static account token. Those three paths
cannot move safely to BetterMe's Okta and Agentgateway environment, and the MCP
credential erases the caller's identity. Dany asked for one provider-agnostic
OIDC contract that works with Okta now and company infrastructure later.

## What Changes

**Browser and API authentication**

- From: 12-hour `x-wbs-token` credentials created by WBS
- To: Authorization Code + PKCE, server-side refresh state, a hardened session
  cookie, and RS256 access-token verification against issuer JWKS
- Impact: migration-compatible until the final public auth cutover
  **Identity and authorization**
- From: username/password accounts and owner-only edit checks
- To: issuer-bound OIDC identities linked only through verified email, plus
  read/write/editor scopes layered under the owner rule
- Impact: existing non-email usernames remain local and unlinked
  **MCP authentication**
- From: one static `WBS_TOKEN` forwarded for every call
- To: standalone JWT verification or an explicitly trusted gateway mode, then
  MCP OAuth discovery and a local fronting authorization server for Claude
- Impact: each call keeps a traceable caller; gateway trust must be explicit
  **Solution integration**
- Projects may reference a solution, resolve by solution slug, and export a
  read-scoped plan as JSON or Markdown.

## Non-Goals

No Okta SDK, Redis implementation, token exchange/OBO, Helm or Kubernetes work.
The initial MCP mode work does not guess the fronting-AS trust trace: the trace
must be measured before that authorization server is implemented.

## Constraints

- Provider and claim details are env-only; no Okta-specific value is hardcoded.
- Dev and tests run without an IdP in explicit local mode; production-local and
  missing/invalid modes fail closed.
- be-01 owns `/api/auth/okta/callback` because the deployed Caddy route sends
  `/api/*` there; the redirect path is asserted at boot.
- SQLite migrations remain blue/green compatible and reversible.
- Public exposure and fallback removal stop for main-session review.

## Capabilities

### New Capabilities

- `federated-authentication`: OIDC browser, API, WebSocket, and MCP identity
- `solution-integration`: solution lookup and read-scoped plan export

### Modified Capabilities

none

## Domain Terms

none

## Decisions Recorded

none — the reviewed decisions are recorded in `design.md` while the MCP trust
trace remains an explicit spike outcome.

## Impact

`libs/auth`; be-01, gw-01, fe-01, and mcp-01; SQLite migrations; dev/runtime
configuration; `openid-client`; auth integration docs and acceptance rigs.
