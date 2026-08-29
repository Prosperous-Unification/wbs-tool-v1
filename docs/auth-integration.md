# OIDC authentication integration

WBS uses standard OIDC discovery, Authorization Code + PKCE, RS256/JWKS token
verification, and provider-neutral claims. The provider is configuration, not
code: Keycloak is the local acceptance provider, Auth0 is the dev provider, and
the historical Okta setup uses the same contract.

## Shared provider contract

`AUTH_ISSUER_DISCOVERY_URL` is the **issuer URL** passed to OIDC discovery (the
name is historical). It is not the literal `/.well-known/openid-configuration`
URL. The issuer must be HTTPS; the OIDC client rejects plain HTTP, including
localhost.

The provider must supply:

- Authorization Code flow for a confidential client, with PKCE S256.
- RS256 access tokens with issuer, expiry, subject, and `AUTH_AUDIENCE` in `aud`.
- `email` and `email_verified=true` in the ID token for first-login linking.
- A string-array groups claim (default `wbs_groups`) containing environment-
  prefixed values such as `dev:wbs:read`, `dev:wbs:write`, and
  `dev:wbs:editor`.
- Refresh tokens when `offline_access` is requested (the default scope).

The registered redirect URI must match byte-for-byte and its path must be
`/api/auth/okta/callback`. Browser cookies are `Secure`, `HttpOnly`,
`SameSite=Lax`, `Path=/`, and `__Host-` prefixed, so browser acceptance also
requires an HTTPS application origin.

## Keycloak acceptance provider

The verified acceptance used Keycloak 26.3 behind an HTTPS reverse proxy. The
proxy terminates TLS for both `https://localhost:3443` (WBS) and
`https://localhost:38443` (Keycloak), and forwards the latter to Keycloak on
`127.0.0.1:38080`. Start Keycloak with forwarded-header processing so discovery
publishes the HTTPS issuer:

```sh
docker run --rm --name wbs-keycloak -p 127.0.0.1:38080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=change-me \
  -e KC_PROXY_HEADERS=xforwarded \
  quay.io/keycloak/keycloak:26.3 start-dev
```

Create this realm configuration in Keycloak:

1. Realm: `wbs`; Require SSL: `None` only because TLS terminates at the local
   proxy.
2. Confidential client: `wbs-client`; Standard flow enabled; client
   authentication enabled; valid redirect
   `https://localhost:3443/api/auth/okta/callback`; web origin
   `https://localhost:3443`.
3. Audience mapper: included client audience `wbs-api`; add it to access and ID
   tokens. Group-membership mapper: claim `wbs_groups`, full group path off;
   add it to access and ID tokens.
4. Add optional client scope `offline_access`. Assign the realm role
   `offline_access` to the acceptance user; without both, Keycloak refuses the
   code exchange with `Offline tokens not allowed for the user or client`.
5. Create groups `dev:wbs:read`, `dev:wbs:write`, and `dev:wbs:editor`, then add
   the acceptance user to all three. Give the user a verified email plus first
   and last name so Keycloak does not interrupt the flow with Verify Profile.

Verify discovery before starting WBS:

```sh
curl -fsS https://localhost:38443/realms/wbs/.well-known/openid-configuration \
  | jq -r '.issuer, .jwks_uri'
```

Both URLs must use `https://localhost:38443`. Processes that call this local
issuer must trust the proxy CA; for a Caddy `tls internal` acceptance proxy,
set `NODE_EXTRA_CA_CERTS` to its exported root certificate.

### WBS environment for Keycloak

Use this shared block for be-01, gw-01, and standalone mcp-01:

```dotenv
NODE_ENV=development
AUTH_ISSUER_DISCOVERY_URL=https://localhost:38443/realms/wbs
AUTH_CLIENT_ID=wbs-client
AUTH_CLIENT_SECRET=<Keycloak client secret>
AUTH_SCOPE=openid profile email offline_access
AUTH_AUDIENCE=wbs-api
AUTH_GROUPS_CLAIM=wbs_groups
```

be-01 and gw-01 additionally use:

```dotenv
AUTH_MODE=oidc
AUTH_REDIRECT_URI=https://localhost:3443/api/auth/okta/callback
```

Standalone mcp-01 uses:

```dotenv
MCP_AUTH_MODE=standalone
WBS_API_URL=http://localhost:3100
MCP_PUBLIC_URL=http://localhost:3300/mcp
```

The browser-facing frontend and gateway remain same-origin behind the HTTPS
proxy: `/api/*` goes to be-01, `/ws*` to gw-01, and everything else to fe-01.

### Acceptance trace

Drive the flow through fe-01, not directly through the callback:

1. Open the HTTPS WBS origin and choose **Continue with Okta**.
2. Sign in at Keycloak and confirm the browser returns to `/` with no token in
   JavaScript storage.
3. Confirm `GET /api/projects` returns 200 with the HttpOnly cookie and a
   `wss://<app-origin>/ws` connection opens.
4. Read the access cookie from the automation browser's privileged cookie jar
   (not page JavaScript) and send it as `Authorization: Bearer` to standalone
   mcp-01; an MCP `initialize` request must return 200.

Verified on h2puni, 2026-08-24, against Keycloak 26.3 and branch
`change/okta-auth-identity` at `649cc3a`: fe-01 signed in, cookie API 200,
WebSocket open, and standalone MCP initialize 200.

## Auth0 mapping

No provider-specific code is required. The dev tenant is
`dev-fzwagvg246jhid6a.us.auth0.com`; configure discovery from that tenant and
preserve the exact issuer, including its trailing slash:
`https://dev-fzwagvg246jhid6a.us.auth0.com/`.

Pass the issuer URL itself, not the literal
`/.well-known/openid-configuration` endpoint. That keeps the discovery
metadata's issuer-equality check enabled.

```dotenv
NODE_ENV=development
AUTH_MODE=oidc
AUTH_ISSUER_DISCOVERY_URL=https://dev-fzwagvg246jhid6a.us.auth0.com/
AUTH_CLIENT_ID=<WBS Tool (dev) client ID>
AUTH_CLIENT_SECRET=<WBS Tool (dev) client secret>
AUTH_REDIRECT_URI=https://dev.wbs.bulletpoints.club/api/auth/okta/callback
AUTH_SCOPE=openid profile email offline_access
AUTH_AUDIENCE=https://wbs.bulletpoints.club/api
AUTH_GROUPS_CLAIM=wbs_groups
```

`AUTH_SCOPE` and `AUTH_GROUPS_CLAIM` are optional — the code defaults to
exactly the values shown, and the deployed dev env omits both. Set them only to
override, and never to a different groups claim than the Action emits.

The Auth0 application is a Regular Web Application with Authorization Code +
PKCE and rotating refresh-token grants. Its callback remains
`https://dev.wbs.bulletpoints.club/api/auth/okta/callback`; `okta` is a
historical route name, not a provider dependency. Request `offline_access` and
the audience `https://wbs.bulletpoints.club/api`. Without that audience Auth0
returns an opaque user-info token instead of the RS256 JWT that WBS verifies.

The post-login Action maps Auth0 roles into the environment-prefixed group
claims WBS consumes. For example, `wbs-editor` becomes `dev:wbs:editor`:

```js
exports.onExecutePostLogin = async (event, api) => {
  const groups = (event.authorization?.roles ?? []).map((r) => 'dev:' + r.replace(/-/g, ':'));
  api.idToken.setCustomClaim('wbs_groups', groups);
  api.accessToken.setCustomClaim('wbs_groups', groups);
  api.idToken.setCustomClaim('studio_groups', groups);
  api.accessToken.setCustomClaim('studio_groups', groups);
};
```

This is the dev tenant's deployed Action, so `dev:` is intentional. A production
tenant must emit `prod:` instead; WBS matches the environment prefix exactly and
would otherwise issue a session with no scopes. The Action writes the same role
array to both claims; each app ignores values for the other app segment.

A scopeless session is not a rejected one. The prefix mismatch is silent at
sign-in: the OIDC callback still issues the `__Host-` cookies, and reading is
open to every authenticated account by design, so the user lands on a working
board and can list and open their own projects and receive WebSocket events.
Only the scope-guarded routes refuse them: mutations return
`403 insufficient_scope`, and so do the routes that ask for `read` explicitly
(the solution reader and the project export route). A wrong prefix
therefore reads as "the app is up but nothing saves", not as a login failure —
check the emitted group values before chasing a write bug.

Assign the WBS roles to each user and require `email_verified=true` before
first-login linking. Real dev credentials live only in
`/home/puni1/wbs-dev/oidc-dev.env` on the deployment host (mode 600). The prior
Okta values are retained only in `oidc-dev.env.okta.bak` until the trial expires
on 2026-09-22; delete that backup after the expiry.

As of 2026-08-24, discovery and the real Auth0 Universal Login page are verified.
Credentialed callback acceptance (`/api/auth/me`, WebSocket, MCP, and the emitted
editor scope) remains pending TASK-110's password-login path.

### Auth0-backed MCP on dev

`mcp-01` reuses the WBS Auth0 client and secret. Its deployment-only keys live
in `/home/puni1/wbs-dev/src/apps/mcp-01/.env` (mode 600):

```dotenv
PORT=3300
MCP_AUTH_MODE=standalone
WBS_API_URL=http://localhost:3100
MCP_PUBLIC_URL=https://dev.wbs.bulletpoints.club/mcp
```

Add this byte-exact Auth0 callback without replacing the browser callback:
`https://dev.wbs.bulletpoints.club/mcp/oauth/callback`. Dynamic registration
accepts only the Claude connector callback on `claude.ai`/`claude.com` or an
HTTP(S) loopback callback for tools such as MCP Inspector. Unproven clients
expire after 10 minutes of DCR inactivity. Starting authorization can extend an
unproven client only to an absolute 20-minute lifetime, and a new flow is
refused with 429 when that ceiling cannot cover the browser and code-exchange
window; a successful exchange promotes the client to 24 hours. Registration is
capped at 20 unproven and 100 proven clients per forwarding source plus 1,000
globally; pending authorization is capped at five per client and 1,000 globally;
unredeemed grants and live sessions are each capped at 1,000 globally. New
requests at capacity return 429 and never evict another connector's state. A
session-capacity refusal preserves the valid grant for retry until its five-
minute expiry. Claude users share Anthropic's forwarding egress, so a burst
above the per-source limits can return 429 until the oldest state expires.

Before cutover, the absent `/home/puni1/wbs-dev/state/mcp-exposure` marker makes
the MCP public probe skip. Cutover atomically writes `enabled` to that mode-600
marker. Every later deploy reads it before snapshotting devsync and must pass
the semantic MCP probe; malformed or unreadable state fails the deploy.
The probe requires Bun and verifies both RFC 9728 resource-metadata locations,
the RFC 8414 authorization-server metadata, and the unauthenticated challenge.

Cut over in this order:

1. Before merging, seed `/home/puni1/wbs-dev/src/apps/mcp-01/.env` with the four
   keys above and mode 600; the preflight deliberately blocks every dev deploy
   until this exists.
2. Merge the reviewed PR and let devsync start `mcp-01`; verify port 3300.
3. Add the exact Auth0 callback above.
4. Back up the live Caddy file, install the reviewed candidate, and validate it
   with the running Caddy version before reload.
5. Reload, then persist the successful cutover before its health check:
   `printf 'enabled\n' | install -m 600 /dev/stdin /home/puni1/wbs-dev/state/mcp-exposure`.
6. Run `bin/dev-deploy.sh` and verify the four MCP discovery/resource paths
   plus the existing app/API/WS probes. Do not pass a one-run environment flag;
   the persistent marker is the assertion.
7. If validation, reload, or any probe fails, restore the Caddy backup, reload,
   move the marker out of the state path, verify the original app/API/WS routes,
   and remove the added Auth0 callback.

## Historical Okta mapping

No code change is needed to reproduce the prior Okta configuration. Its mapping
was:

```dotenv
NODE_ENV=development
AUTH_MODE=oidc
AUTH_ISSUER_DISCOVERY_URL=https://<okta-org>/oauth2/<authorization-server-id>
AUTH_CLIENT_ID=<WBS OIDC client id>
AUTH_CLIENT_SECRET=<WBS OIDC client secret>
AUTH_REDIRECT_URI=https://dev.wbs.bulletpoints.club/api/auth/okta/callback
AUTH_SCOPE=openid profile email offline_access
AUTH_AUDIENCE=<access-token audience configured on that authorization server>
AUTH_GROUPS_CLAIM=wbs_groups
```

In Okta, configure the same exact redirect URI, Authorization Code + refresh
token grants, PKCE, the audience used by `AUTH_AUDIENCE`, and a groups claim
named `wbs_groups` in both ID and access tokens. Group values must retain the
environment prefix; production uses `prod:wbs:*`, development uses
`dev:wbs:*`. Do not use the org authorization server if it cannot mint the
custom audience and groups claim required by WBS.

The archived dev values live only in
`/home/puni1/wbs-dev/oidc-dev.env.okta.bak` on the deployment host (mode 600)
until 2026-09-22. Never copy them into the repository, logs, tests, or issue
text.

## Local bypass

For ordinary local development without an IdP, use `AUTH_MODE=local` with
`NODE_ENV=development`. It supplies the fixed local identity and issues no OIDC
cookie. Startup refuses `AUTH_MODE=local` when `NODE_ENV=production`.

## Password login

Password login runs inside `AUTH_MODE=oidc`; it is a second route to the same
session, not a separate identity mechanism. A successful `POST /api/auth/login`
issues the same hardened `__Host-wbs_access` HttpOnly cookie as the OIDC
callback. `/api/auth/me` and gw-01 WebSocket upgrades therefore see the same
identity kind regardless of the sign-in route.

Both flags parse strictly as literal `true` or `false`:

```dotenv
AUTH_PASSWORD_LOGIN=true
AUTH_PASSWORD_REGISTER=false
```

`AUTH_PASSWORD_LOGIN` defaults to `true`; production may set it to `false`.
`AUTH_PASSWORD_REGISTER` defaults to `false`, so `POST /api/auth/register`
continues to return 404 in OIDC mode unless registration is explicitly enabled.
Startup refuses registration enabled while password login is disabled, because
that combination would create a session cookie the application then rejects.

The users table has no per-user role or scope column. Password identities
therefore receive the same scopes as `AUTH_MODE=local`: `read`, `write`, and
`editor`. No separate role system is implied.

Failed logins use bounded fixed-window counters keyed separately by normalized
username and client IP. Either key blocks after five failures for 60 seconds.
The bounded counter fails closed when it reaches capacity instead of evicting a
live lock. Enabled registration counts every attempt against the same IP limit
because password hashing is expensive even when registration succeeds.

Password verification uses the same bounded Argon2 cost for unknown,
OIDC-only, oversized, and wrong-password cases; they return the same
`invalid_credentials` response. In OIDC mode, password session creation also
requires the exact application `Origin` and the trusted edge's
`X-Forwarded-For` value. Session JWTs stay only in the hardened HttpOnly cookie,
including when registration is explicitly enabled.

### OIDC migration downgrade

Rolling back through `20260824010000_add_oidc_identity` keeps every user and
dependent row. Because the older four-column users table requires a password,
the down migration stores email, issuer, subject, and original password
nullability in `oidc_identity_downgrade`; passwordless accounts receive the
legacy login path's non-guessable dummy Argon2 digest. They remain present but
cannot use password login while the old release is active. Password accounts
retain their original hashes.

After the forward scripts re-apply, the migrator restores the saved identity
fields and changes originally passwordless accounts back to NULL. The recovery
table is retained for later downgrade cycles; its rows are consumed only after
an exact restore. A saved identity without its user, or any field that fails to
restore exactly, aborts startup without discarding the recovery state.

QA credentials live only in `/home/puni1/wbs-dev/qa-accounts.env` on the
deployment host, with mode 600, as `QA_USER` and `QA_PASS`. Never copy their
values into the repository, logs, tests, or issue text.
