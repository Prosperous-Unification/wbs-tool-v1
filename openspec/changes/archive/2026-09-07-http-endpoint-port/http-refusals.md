# HTTP request and refusal boundary

This records the implemented boundary. The declarations in
`libs/contracts/src/http/*-shapes.ts` are the source of truth for each endpoint;
`libs/contracts/src/http/refusal.ts` owns the shared finite vocabulary and detail
types. Controller bindings may return only the status/body pairs declared by their
shape.

## Shape and schema rules

Every modeled refusal is JSON with one discriminant:
`{ error: RefusalCode, ...endpointDetail }`. The supported refusal statuses are
400, 401, 403, 404, 405, 409, 422, 429, 501, and 503. A code does not imply one
global status: each endpoint shape pairs the applicable code, status, and detail
schema. For example, `invalid_credentials` is 401 for a bad password and 429 when
login admission is exhausted.

`requestSchema` rejects undeclared keys recursively. `responseSchema` requires and
validates every known field while ignoring additive fields from a newer peer. Both
carry the same ArkType validator and generated inline JSON Schema descriptor;
transforms, defaults, references, and input/output descriptor drift are refused at
declaration time.

Success alternatives retain their representation and status together: JSON
200/201, empty 204/302, or text 200/500. The server rejects an undeclared
status/body pair, a malformed success or refusal, and a success object carrying an
`error` field. Metrics' diagnostic 500 is a declared text response rather than a
JSON refusal. Unexpected handler, dependency, parser-stream, or account-store
failures remain 500s.

## Server execution order

`apps/be-01/src/http/elysia/mount.ts` applies this order on the production path:

1. Match the declared method/path, retaining the raw URL, arrived method, and
   headers in request metadata.
2. Apply ordered origin and identity policies before consuming the request body.
3. Run metadata-only prevalidation, such as callback HEAD and duplicate-query
   refusals.
4. Decode the declared media and validate params, query, and body. Undeclared
   query fields and nonempty undeclared bodies are refused.
5. Invoke the typed binding, validate its declared reply, and serialize the exact
   JSON, text, redirect, or empty representation.

Closed query declarations reject extra keys. The OIDC callback uses
`arbitrary-singleton`: provider extension keys remain open, but a repeated raw key
is refused before the URL is collapsed. Declared bodies default to JSON. Step,
project, saved-plan, password-auth, smoke, marker, and internal writes also declare
the form media they accept. A recognized malformed JSON body maps to
`invalid_json`; missing or unsupported media maps through the endpoint's declared
body refusal.

Request-failure classifiers can translate rejected external input into an
endpoint-specific declared refusal, preserving legacy distinctions such as a 422
credentials body, marker field detail, and command parser context. They cannot
admit input or call services. A classifier or policy response outside that shape's
declaration becomes 500.

## Policy refusals

- `signed-in` yields 401 `unauthenticated`; `read-scope` and `write-scope` yield
  401 `unauthenticated` or 403 `insufficient_scope`.
- `internal` yields 401 `unauthorized` and delivers an internal principal rather
  than a user principal.
- `always` origin policy protects password login and registration against any
  foreign origin. `always-unsafe-with-session-cookie` protects unsafe browser
  operations when a session cookie is present. Both yield 403 `invalid_origin`.
- Project ownership remains a domain 403 `forbidden`, distinct from policy
  admission. Unexpected identity-store failures are not converted to auth
  refusals.

The complete policy assignment is pinned against all 44 operation IDs in
`apps/be-01/src/app.routes.test.ts`. Health, metrics, OIDC entry/callback, password
session lookup, and smoke are public; project and directory reads require the
declared signed-in/read scope; mutations require write scope; the two gateway
operations require internal identity.

## Endpoint-specific details

The shared detail vocabulary remains closed, while each shape selects only its
reachable variants:

- Step deletion `in_use` carries `inUse`, including estimates, actuals,
  progress, measures, assignments, and assumed-assignee flips.
- Directory-command `in_use` carries `usage` with affected projects, work items,
  effects, and members. Directory-command `taken` carries the conflicting name.
- Calendar-marker `malformed` and `contrast` name the failing field. Addressed
  not-found/taken variants can name `markerId`; unrelated routes cannot acquire
  that field.
- Saved-plan `quota` carries `refusal: { limit, asked, allowed }`. `corrupt`
  carries its finite integrity variant under `refusal`; comparison also names
  the affected side with a top-level `savedPlanId`.
  `unsupported_body_version` remains 501 with `savedPlanId`, body, version, and
  supported versions. `snapshot_busy` remains 503.
- Undo/redo 409 `nothing_to_undo` and `stale_undo` carry nullable detail.
- Health 503 is `dependency_unavailable` with the concrete status
  `migrating`, `database_unreachable`, or `schema_missing`, plus the nullable
  deployed commit.

## Command boundary

`planCommandSchema` is the strict discriminated union of all 36 plan and directory
command kinds. The batch body is `{ commands }`; semantic command parsing still
precedes the 200-command admission cap so historical error precedence is retained.

Parser refusals are a finite 400 family. A failure before an array index has only
`error`; a failure after an index but before a recognized kind has `error` and
`at`; a recognized command failure has `error`, `at`, and `kind`. The vocabulary
includes the literal parser codes and finite field-specific forms declared in
`ParserRefusalCode`; `deadline_must_be_a_date` and the capacity/priority-band
families are included rather than widened to arbitrary strings.

Runtime command refusals always carry `at` and the recognized `kind`:

| Status | Codes and extra detail                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `too_many_commands`, `project_required`, `unknown_ref`, `missing_id`, `duplicate_ref`, `name_required`, `strategy_required`, `has_children`, `not_before_reason_needs_a_date`, `invalid_kind`, `nothing_to_change` |
| 403    | `forbidden`                                                                                                                                                                                                        |
| 404    | `not_found` and the finite `unknown_step`, `unknown_metric`, `unknown_person`, `unknown_team`, `unknown_tag`, `unknown_service`, `unknown_type`, `unknown_system` family                                           |
| 409    | `cycle`, `frozen`, `rolled_up`, `ancestor`, `too_large`; `taken` also carries `name`, and `in_use` carries directory `usage`                                                                                       |
| 422    | `deadline_before_project_start` carries `workItemId` and `projectDayZero`                                                                                                                                          |

The directory endpoint accepts the same declared command union so a plan command
can retain its index and kind in `project_required`; the runner still admits only
directory kinds there.

## Authentication boundary

Password register/login validate origin and credentials before mode switches,
trusted proxy metadata, throttling, or service calls. Disabled password routes are
still mounted and return 404 `not_found`. Register preserves 409 `taken`, 429
`rate_limited`, and 400 `invalid_client`/`invalid`; login preserves 401 and 429
`invalid_credentials`. Session lookup returns 401 `invalid_token`.

The four OIDC shapes are mounted only in OIDC composition. Callback HEAD returns
405 `method_not_allowed` with `Allow: GET`; repeated query keys return 400
`duplicate_parameter`. Missing, expired, blank, or mismatched callback state uses
400 `invalid_oidc_callback`. A live mismatch retains its transaction and binding;
missing/expired/consumed-invalid cases clear settled bindings. Provider-declared
errors redirect with an allowlisted `auth_error` after successful consumption.
Exchange or claims failures return 401 `invalid_oidc_session`; unresolved account
identity returns 409 `oidc_identity_conflict`. Refresh uses the same 401 session
refusal and clears the session; logout deletes locally before optional upstream
revocation. Provider refresh/revoke and account/token-store exceptions still
propagate.

## Client and generated-document boundary

`clientFromShapes` derives one method per operation ID for either fetch or
in-process transports. Before transport it validates exact params, query, and body,
normalizes JSON, and honors cancellation. After transport it checks declared
status, representation, and the applicable success/refusal schema. Validated
application refusals return `kind: 'refusal'`; cancellation, transport errors,
invalid requests, unexpected statuses, invalid JSON, schema mismatch, and
representation mismatch return `kind: 'failure'`.

`documentFromShapes` emits OpenAPI 3.1 from the same descriptors. It refuses blank
or duplicate operation IDs, duplicate method/path pairs, unresolved schema
references, malformed body-media/query declarations, and parameter schemas that
cannot be flattened without losing constraints. Multiple JSON alternatives at one
status become `anyOf`; empty alternatives cannot be ambiguously combined. This
generated document is consumed by the backend build and MCP derivation, while the
running app publishes only the shapes its authentication configuration mounted.
