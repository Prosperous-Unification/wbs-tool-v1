## ADDED Requirements

### Requirement: WebSocket request targets contain no session credential

Every WebSocket client SHALL request `/ws` without a session credential in the
query string. This includes browser and reconnecting clients, integration
fixtures, and deployment smoke. A `token`, `localIdentity`, or other URL value
MUST NOT establish WebSocket identity.

#### Scenario: an OIDC browser opens a WebSocket

- **GIVEN** a valid access cookie from the configured application Origin
- **WHEN** the browser requests `/ws`
- **THEN** gw-01 SHALL verify the cookie and Origin before opening the socket
- **AND** the request target SHALL contain no session credential

#### Scenario: a valid token is supplied only in the URL

- **GIVEN** a valid signed session token in `/ws?token=...` and no access cookie
- **WHEN** the client requests a WebSocket upgrade
- **THEN** gw-01 SHALL refuse the upgrade

#### Scenario: a query value names a local identity

- **GIVEN** OIDC mode with a valid cookie for one user and
  `/ws?localIdentity=another-user`
- **WHEN** the socket opens
- **THEN** the verified cookie user SHALL be the connection identity
- **AND** the query value SHALL have no trusted meaning

### Requirement: WebSocket authentication mode is explicit

Explicit local mode SHALL use its configured fixed identity without a cookie.
OIDC mode SHALL require a valid access cookie and exact configured Origin. A
gateway configured for neither mode MUST refuse the upgrade.

#### Scenario: explicit local development opens a socket

- **GIVEN** gw-01 started in explicit local mode
- **WHEN** a client requests `/ws` without credentials
- **THEN** the socket SHALL open as the fixed local identity

#### Scenario: authentication is not configured

- **GIVEN** neither a fixed local identity nor an OIDC application Origin
- **WHEN** a client requests `/ws`
- **THEN** gw-01 SHALL answer unauthorized before opening the socket

### Requirement: reconnect and smoke preserve the credential-free target

The shared reconnecting client SHALL open its configured URL verbatim on every
attempt. Deployment smoke SHALL authenticate with the access cookie and exact
Origin headers and SHALL keep the request target credential-free.

#### Scenario: a reconnect is attempted

- **GIVEN** a reconnecting client configured with `wss://wbs.test/ws`
- **WHEN** it opens the first or a replacement socket
- **THEN** the WebSocket factory SHALL receive `wss://wbs.test/ws` verbatim

#### Scenario: deployment smoke builds the upgrade

- **GIVEN** a smoke session token and deployment hostname
- **WHEN** the smoke tool builds its WebSocket upgrade request
- **THEN** it SHALL send the access cookie and exact HTTPS Origin as headers
- **AND** its request line SHALL be `GET /ws HTTP/1.1`
