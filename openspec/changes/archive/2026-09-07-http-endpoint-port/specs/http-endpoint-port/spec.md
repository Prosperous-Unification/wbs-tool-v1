## ADDED Requirements

### Requirement: Shared literal endpoint shapes

Every backend HTTP endpoint SHALL have a handler-free shape in contracts carrying literal method/path/operationId, ordered request policies, schemas and declared reply variants. A bound handler MUST retain exact parameter, principal and reply inference without framework types.

#### Scenario: Invalid handler assumptions fail compilation

- **WHEN** a handler reads a path parameter absent from its path, reads principal without an identity policy, returns a successful refusal, or pairs a refusal body with an undeclared status
- **THEN** the repository typecheck rejects the assumption at the handler line

#### Scenario: Shape has exactly one implementation

- **WHEN** a shape is added without a bound endpoint, an endpoint is duplicated, or an unlisted shape is bound
- **THEN** the binding completeness test fails independently of document generation

### Requirement: Validation and documents have one declaration

SchemaShape SHALL pair a Standard Schema validator with a JSON Schema descriptor generated from one ArkType declaration in its correct direction. Unsupported or unrepresentable conversion MUST fail explicitly rather than emit an unconstrained fallback.

#### Scenario: Nested commands remain fully described

- **WHEN** a body includes an array of command union arms with optional fields
- **THEN** its generated inline object descriptor preserves each arm, property and required/optional distinction for MCP

#### Scenario: Unrepresentable declaration is rejected

- **WHEN** a predicate or unvalidated morph cannot be represented faithfully
- **THEN** schema declaration fails explicitly rather than returning an empty or unconstrained descriptor

### Requirement: Request policies precede parsing

The Elysia adapter SHALL apply each endpoint's policies in order before body parsing, including internal identity, required user scopes and existing cookie-origin behavior. Modeled credential failures SHALL produce declared refusals; unexpected account-store failures MUST propagate to the server error boundary.

#### Scenario: Read-only malformed write is refused before parsing

- **WHEN** a read-only token sends malformed JSON to a write endpoint
- **THEN** it receives 403 insufficient_scope and neither body validation nor handler mutation runs

#### Scenario: Cookie origin cannot authorize a foreign write

- **WHEN** an unsafe project request carries a session cookie from a disallowed origin
- **THEN** it is refused before any project write

#### Scenario: Store failure is not an invalid token

- **WHEN** a valid token reaches an account lookup that throws
- **THEN** the failure remains unexpected rather than becoming 401 invalid_token

### Requirement: Strict requests and discriminated refusals

Every request schema SHALL reject undeclared keys throughout nested structures. Validation and modeled domain failures SHALL use the shared Refusal discriminant with code-specific detail and endpoint-specific status pairs. Batch at/kind SHALL belong only to applicable detail variants.

#### Scenario: Derived or nested unknown field is refused

- **WHEN** a command carries a derived number or an undeclared nested property
- **THEN** the adapter returns the declared refusal, including number_is_derived where applicable, and performs no mutation instead of stripping the property

#### Scenario: Context-specific refusal retains its detail

- **WHEN** a command batch or saved-plan operation produces a modeled failure
- **THEN** its declared status and relevant batch/quota/corruption detail survive serialization and validation

### Requirement: Replies preserve status and representation

Both adapter and client SHALL validate status-specific successful and refusal bodies. Modeled statuses SHALL include 405 callback method refusal, 429 throttling, 503 contention/dependency failure and landed 501 unsupported saved-plan body version. EMPTY, JSON null, text and redirects MUST remain distinct; headers SHALL preserve ordered repeated values.

#### Scenario: Control and null replies differ

- **WHEN** handlers return 204 EMPTY, 302 EMPTY with Location, or 200 JSON null
- **THEN** empty replies have no body, redirect keeps Location, and the JSON reply contains serialized null

#### Scenario: Multiple cookies survive

- **WHEN** an OIDC callback emits three Set-Cookie headers
- **THEN** the actual response getSetCookie method returns all three in order

#### Scenario: Build capability is not corruption or contention

- **WHEN** a saved plan has an unsupported future body version
- **THEN** its response remains 501 unsupported_body_version with savedPlanId, body, version and supported details, distinct from 422 corrupt and 503 snapshot_busy

#### Scenario: Login capacity remains reserved while verification is pending

- **WHEN** concurrent requests exceed an account/IP or global verification limit
- **THEN** excess requests receive the existing declared 429 without starting verification and all settled or thrown attempts release their reservation

### Requirement: Documents and tools derive from mounted contracts

OpenAPI SHALL be a build output derived from shape descriptors, with explicit operationIds and inline MCP object bodies. MCP tool derivation SHALL consume shapes without backend handlers. Every shape, including conditional OIDC routes, health and text metrics, MUST be proven reachable through actual Elysia composition.

#### Scenario: Document completeness cannot hide an omitted mount

- **WHEN** the adapter skips mounting a shape that remains in the document
- **THEN** the real app.handle reachability test fails for that operation

#### Scenario: Tool identity cannot be invented

- **WHEN** an operation lacks its explicit operationId or required inline schema structure
- **THEN** MCP derivation fails explicitly rather than inventing a name or incomplete tool

### Requirement: Clients validate replies with additive tolerance

The frontend SHALL derive typed operations and refusal narrowing from shapes, validate successful and refusal responses before consumption, and tolerate undeclared response keys. Production transport and test fake SHALL share the same shape contract.

#### Scenario: Type drift is caught at the boundary

- **WHEN** the backend changes a known response field's type without updating the contract
- **THEN** the client reports a typed boundary failure before passing it to a screen

#### Scenario: Additive response remains readable

- **WHEN** the backend adds outer or nested response fields while an old frontend bundle remains open
- **THEN** the old client validates known fields and the screen still renders

#### Scenario: Malformed refusal cannot bypass validation

- **WHEN** a 429, 503 or 501 body lacks or mistypes required refusal detail
- **THEN** the client rejects the body at its boundary

### Requirement: Refresh ownership survives generated transport

The generated frontend transport MUST preserve R1's invalidation generations, accumulated pending resource scopes and mandatory trailing read; it SHALL NOT share a pre-edit GET solely by URL.

#### Scenario: Old read overlaps an edit

- **WHEN** a read started before an edit settles after its invalidation
- **THEN** the coordinator performs the required trailing read and installs the current state

#### Scenario: Refresh scopes overlap

- **WHEN** full, step and tree refresh requests overlap while work is pending
- **THEN** every accumulated resource scope is eventually refreshed and installed

### Requirement: Callback validation preserves single-use login state

The callback SHALL preserve arrived method and raw query cardinality. It MUST refuse HEAD with405 and Allow:GET and every repeated query parameter with400 duplicate_parameter before consuming the transaction or clearing cookies. Provider error processing SHALL occur after valid transaction consumption, preserve approved redirect reasons/log redaction, and keep account resolution outside the exchange catch.

#### Scenario: Polluted callback leaves honest login available

- **WHEN** HEAD or a callback with repeated state/code/other parameter arrives
- **THEN** it is refused without exchange or cookie clearing and the subsequent honest GET can complete

#### Scenario: Provider cancellation is a controlled redirect

- **WHEN** a valid consumed callback carries a nonempty provider error
- **THEN** no exchange occurs, the binding is cleared and a302 returns only an approved auth_error reason, without reflecting or logging error_description verbatim

### Requirement: Marker endpoints preserve annotation identity

Calendar marker shapes SHALL retain separate project-scoped endpoints, markerId wire identity, field-specific validation/refusals and exact-one-field PATCH semantics. They MUST preserve marker-only refresh, absolute date text and total ordering without adding markers to work-item scheduling, saved-plan bodies, revisions or command history.

#### Scenario: Marker body remains distinct from project path

- **WHEN** MCP derives a marker create tool
- **THEN** project id and optional markerId remain separate inputs without a flattened-name collision

#### Scenario: Strict PATCH preserves semantic validation

- **WHEN** a marker PATCH contains an undeclared date or both writable columns
- **THEN** it is refused without any write; valid name-only or color-only including null remains supported, with malformed and contrast field details preserved
