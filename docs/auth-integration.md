# OIDC authentication integration

WBS uses standard OIDC discovery, Authorization Code + PKCE, RS256/JWKS token
verification, and provider-neutral claims. The provider is configuration, not
code: Keycloak is the local acceptance provider and Okta uses the same contract.

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

## Okta mapping

No code change is needed. Put the real values in the off-repo deployment env:

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

Real dev credentials live only in `/home/puni1/wbs-dev/oidc-dev.env` on the
deployment host (mode 600). Never copy them into the repository, logs, tests,
or issue text.

## Local bypass

For ordinary local development without an IdP, use `AUTH_MODE=local` with
`NODE_ENV=development`. It supplies the fixed local identity and issues no OIDC
cookie. Startup refuses `AUTH_MODE=local` when `NODE_ENV=production`.
