## ADDED Requirements

### Requirement: MCP delegates browser proof to the shared OIDC store

MCP SHALL use the shared store's digested binding lookup, timing-safe state comparison, expiry ordering and single-use consumption. Retained transaction keys and values SHALL NOT contain the raw browser binding.

#### Scenario: the authorization is retained

- **WHEN** a real MCP authorization request saves a pending login
- **THEN** both its correlation key and retained values exclude the browser-binding secret

#### Scenario: a matching callback is replayed

- **WHEN** a valid callback is followed by the same callback again
- **THEN** only the first invokes upstream exchange and the second is refused

### Requirement: A forged state does not burn a live login

A callback whose state does not match a live transaction SHALL refuse without consuming that transaction or clearing its browser binding. Expired transactions SHALL be removed even if the state also mismatches.

#### Scenario: an honest callback follows a forged callback

- **WHEN** a browser sends a wrong-state callback and then the real matching callback
- **THEN** the wrong state returns 400, leaves the cookie and record live, and the real callback exchanges once and redirects successfully

#### Scenario: a mismatched callback arrives after expiry

- **WHEN** a transaction has reached its deadline and the supplied state mismatches
- **THEN** the transaction and metadata are removed and the binding cookie is cleared

### Requirement: MCP metadata remains bounded and complete

Pending authorization metadata SHALL retain the current global and per-client limits without evicting live entries. Missing metadata for a consumed proof SHALL throw as a trusted-state failure.

#### Scenario: one client exhausts its pending quota

- **WHEN** the client starts another authorization at its per-client limit
- **THEN** that request is refused with the current capacity response, another client retains its available capacity, and the first live login can still finish

#### Scenario: metadata is missing after proof consumption

- **WHEN** the shared store consumes a matching transaction but its MCP metadata has been deliberately removed
- **THEN** callback execution throws before upstream exchange or grant issuance
