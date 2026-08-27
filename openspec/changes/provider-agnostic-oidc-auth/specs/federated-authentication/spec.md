## ADDED Requirements

### Requirement: Authentication mode is explicit and fail-closed

Every service SHALL validate its authentication mode during startup. Local mode
SHALL fabricate a fixed development identity without an IdP and SHALL be
refused when the runtime environment is production. Missing and unknown modes
SHALL fail startup.

#### Scenario: development starts without an identity provider

- **GIVEN** a development runtime configured for local authentication
- **WHEN** be-01, gw-01, and mcp-01 start
- **THEN** they SHALL start without discovery or JWKS access
- **AND** requests SHALL receive the fixed local identity

#### Scenario: production-local is refused

- **GIVEN** a production runtime configured for local authentication
- **WHEN** a service starts
- **THEN** startup SHALL fail before it accepts traffic

### Requirement: Access tokens are verified against provider JWKS

Bearer and cookie access tokens SHALL be RS256-verified against the configured
remote JWKS with issuer, audience, signature, and expiry enforcement. JWKS
resolution MAY be cached; validation failures MUST remain failures.

#### Scenario: a valid access token is accepted

- **GIVEN** a signed, unexpired token carrying the configured issuer and audience
- **WHEN** a protected service verifies it
- **THEN** the verified claims SHALL become the request identity

#### Scenario: issuer, audience, expiry, or signature is wrong

- **GIVEN** a token that fails any required verification
- **WHEN** a protected service verifies it
- **THEN** authentication SHALL be refused

### Requirement: Browser login uses a bound one-time OIDC transaction

The browser login SHALL use Authorization Code with PKCE S256, state, and nonce.
The transaction SHALL be short-lived, bound to its initiating browser, consumed
atomically once, and exchanged only at the configured callback pathname.

#### Scenario: the browser completes login once

- **GIVEN** an unexpired transaction returned to its initiating browser
- **WHEN** the callback receives a valid code, state, and nonce
- **THEN** be-01 SHALL exchange the code and create one authenticated session
- **AND** reusing the transaction SHALL be refused

#### Scenario: the callback path drifts

- **GIVEN** an `AUTH_REDIRECT_URI` whose pathname is not the mounted callback
- **WHEN** be-01 starts
- **THEN** startup SHALL fail before an unreachable login flow is advertised

### Requirement: Browser sessions renew without exposing refresh tokens

The access token SHALL be held in a `__Host-` httpOnly Secure SameSite=Lax
cookie with Path `/`. Refresh tokens SHALL remain server-side behind a
`TokenStore`, rotate atomically, detect replay, and be deleted on logout.

#### Scenario: an expired access token has a live refresh record

- **GIVEN** a browser session whose access token expired and refresh record is valid
- **WHEN** the browser calls the refresh preflight
- **THEN** be-01 SHALL rotate the refresh token and replace the access cookie

#### Scenario: logout ends the session

- **GIVEN** an authenticated browser session
- **WHEN** a same-origin logout is accepted
- **THEN** local refresh state SHALL be deleted
- **AND** the access cookie SHALL be cleared with the same attributes

### Requirement: OIDC identity linking is collision-safe and issuer-bound

An OIDC account SHALL be keyed by issuer and subject. First login MAY link by a
normalized email only when the provider says the email is verified and the
legacy username is that email; otherwise it SHALL create a deterministic unique
OIDC account. Existing non-email local accounts SHALL remain unlinked.

#### Scenario: a verified legacy email is linked

- **GIVEN** no issuer-subject match and one legacy username equal to a verified email
- **WHEN** that identity logs in for the first time
- **THEN** the account SHALL be linked in one transaction

#### Scenario: an unverified or non-email identity cannot capture an account

- **GIVEN** an unverified email or a legacy username that is not that email
- **WHEN** the identity logs in
- **THEN** no legacy account SHALL be linked by email

#### Scenario: an OIDC identity survives a pre-OIDC downgrade

- **GIVEN** an OIDC-only account with dependent plans and no password hash
- **WHEN** the database rolls back through the OIDC identity migration
- **THEN** the account and every dependent row SHALL remain present
- **AND** the old password login SHALL have no usable credential for that account
- **AND** re-applying migrations SHALL restore its exact email, issuer, subject, and null password

### Requirement: Request scopes constrain writes and browser transports

The configured groups claim SHALL map environment-prefixed values to read,
write, and editor scopes on request context. Mutating routes MUST require write
scope in addition to the restricted-project owner rule. Cookie-authenticated
mutations MUST enforce Origin/CSRF, and WebSocket upgrades MUST enforce a valid
cookie token plus allowed Origin.

#### Scenario: a reader attempts a mutation

- **GIVEN** an authenticated identity with read scope but no write scope
- **WHEN** it calls a mutating route
- **THEN** the mutation SHALL be refused before domain state changes

#### Scenario: a cross-site WebSocket is attempted

- **GIVEN** a valid session cookie and an unapproved Origin
- **WHEN** the browser requests a WebSocket upgrade
- **THEN** gw-01 SHALL refuse the upgrade

#### Scenario: an expired WebSocket session reconnects

- **GIVEN** the access cookie is expired and its server-side refresh record is valid
- **WHEN** the browser needs to reconnect its WebSocket
- **THEN** it SHALL call be-01's refresh preflight before opening the replacement socket
- **AND** gw-01 SHALL refuse the expired cookie and never refresh it itself
- **AND** the replacement socket SHALL use the renewed access cookie

### Requirement: MCP preserves an explicit caller trust chain

Standalone MCP SHALL verify incoming Bearer tokens with the shared verifier.
Gateway mode SHALL parse already-verified claims only when trusted-gateway mode
is explicitly enabled. MCP SHALL expose separate liveness, readiness, and ALB
readiness probes and SHALL not use a static WBS account token.

#### Scenario: gateway trust is not enabled

- **GIVEN** MCP gateway mode without `MCP_TRUSTED_GATEWAY=true`
- **WHEN** mcp-01 starts
- **THEN** startup SHALL fail before unsigned claims can be accepted

#### Scenario: standalone MCP receives a caller token

- **GIVEN** standalone mode and a valid Bearer token
- **WHEN** an MCP tool calls be-01
- **THEN** the caller identity and scopes SHALL govern the call

### Requirement: Claude discovers and authorizes MCP without manual token steps

The MCP deployment SHALL publish protected-resource and authorization-server
metadata sufficient for a Claude connector to discover an authorization flow.
If the upstream provider cannot dynamically register Claude, mcp-01 SHALL
support local DCR and PKCE, keep its MCP token local, and forward only the
server-held upstream access token to be-01.

#### Scenario: Claude adds the dev MCP connector

- **GIVEN** the public dev MCP URL and no pasted token or client secret
- **WHEN** Claude discovers, registers, and completes the browser login
- **THEN** a tool call SHALL reach be-01 under Dany's upstream identity
- **AND** be-01 SHALL verify only its configured upstream issuer
