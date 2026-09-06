## Context

Draft only, based on the approved normative ports plan, current CONTEXT and ADR 0014/0015. See ./http-preflight.md for observed installed-library probes, ./http-operations.md for the limited committed-document inventory. TASK-262 extracted ten `controller/*.routes.ts` lists plus Elysia/in-process binders at the checkpoint. Fetched4051512c adds calendar-marker.routes as an eleventh family; integrate before final inventory. Those implementation filenames remain. Existing `*.controller.test.ts` names remain valid. No design interview is reopened.

## Goals / Non-Goals

Goals: one precise shape for validation, typed handler/client inference and generated documents; preparse policy enforcement; explicit modeled wire failures; direct literal handler tests and real Elysia mounting proof. Non-goals are the later waves, gateway runtime and a second HTTP adapter or exported kit.

## Decisions

### Shape boundary and types

`libs/contracts/src/http/` owns SchemaShape, EndpointShape, ParamsOf, RequestPolicy, RefusalCode/RefusalDetail and endpoint shapes, documentFromShapes and clientFromShapes. It imports no backend handler, service or repository. `apps/be-01/src/http/endpoint.ts` initially owns Endpoint, bind, EndpointInput, HttpReply, EMPTY and IdentityResolver; they move to core only in Wave 3. Keep exact shape literals through declaration/binding: paths, operationIds, policy tuples and status/schema pairs cannot widen to generic strings, arrays or independent unions. Params schemas must match path keys exactly, not merely structurally contain required keys.

The normative sketch's `principal: never` does not meet its own unreadable-principal requirement: the preflight compiled reading/assigning it successfully. Conditionally omit the property for a tuple without identity; negative fixtures use actual bind inference. If measured typecheck time doubles, apply the approved `Identity | null` plus runtime check fallback, recording the deliberate change in the type guarantee. ParamsOf stays. Reply arms must be shape-specific: JSON null is serialized null, EMPTY is an empty 204/302, text belongs only to a TextResponse shape, success cannot carry a refusal, and every refusal retains its declared status/schema pairing. Ordered header tuples append three Set-Cookie values.

### Schema declaration boundary

Author each wire schema once in ArkType; produce validator and JSON Schema descriptor there. Requests use deep reject, including command union arms and nested arrays. Client response validation uses deep ignore, retaining additive fields while refusing incorrect known types. Async Standard Schema validation is supported even when ArkType currently validates synchronously. Translate issues to the declared refusal without serializing validator internals/original sensitive input.

ArkType accepts an array for an optional-only object while emitting a JSON Schema
`type: object`. `SchemaShape` therefore compiles each emitted descriptor once with
the directly declared Ajv 2020 validator and applies it, without coercion or
defaults, before Standard Schema validation for both requests and replies. A
partial container walker was rejected because union branches can differ by
discriminators and constraints; it can accept a value through the wrong branch.
This adds declaration-time compilation and client bundle cost, which the final
type/build/browser measurements must include. Tests inspect real emitted union
arms because ArkType may simplify a declaration before `SchemaShape` receives it.

Installed ArkType 2.2.0 supports generated nested inline object/array/anyOf descriptors, defaults and directional conversion, but a custom predicate throws and an unvalidated morph output can silently become an unconstrained descriptor. Initial wire declarations should stay transform/default-free unless the wrapper explicitly models input/output and proves representability. Merely catching converter errors is insufficient. DocumentFromShapes reads descriptors only, never validator internals. Resolve the explicit StandardSchema type dependency at promotion; `@standard-schema/spec` is absent, `@ark/schema` exports the types, ArkType exports JsonSchema. Draft-2020-12 descriptors require an OpenAPI 3.1-compatible emitter/MCP type boundary; installed conversion rejects openapi-3.0.

### Preparse policy matrix

Policies run in declared order in Elysia onRequest, before body parsing. An identity resolver distinguishes modeled invalid credentials/scope from unexpected account-store failures. Endpoint handlers receive the resolved principal and no framework context. Request URL/method/Headers remain available for OIDC callback logic.

| Input/path class                                                      | Required assertion before handler/body parsing                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Anonymous request to signed-in/read/write endpoint                    | Declared 401 envelope, no handler call                                                                    |
| Read-only token on unsafe write route with malformed JSON             | 403 insufficient_scope before parser; moving policy late currently yields 400, not the plan's guessed 422 |
| Read token on permitted read; write token on write                    | Allowed subject to declared scope; preserve per-project domain permission checks                          |
| Unsafe request with session cookie and foreign/missing invalid origin | Existing hasInvalidCookieOrigin semantics enforced; project write remains absent                          |
| Unsafe request without session cookie                                 | Cookie-origin rule does not invent a new bearer restriction                                               |
| Login/register                                                        | Always-on origin rule, including their existing client/mode checks                                        |
| Internal route                                                        | Required internal identity/header policy; malformed payload cannot bypass auth                            |
| Valid token with account store throwing                               | Unexpected server failure; never invalid_token/401                                                        |
| Public smoke/solution/health/metrics                                  | No invented principal; explicit applicable origin policy still follows unsafe-cookie rule                 |

Pin GET/HEAD/OPTIONS safe-method handling and conditional auth modes against actual mounted composition. Existing Route.preflight runs after Elysia parsing and cannot be the new policy runner. Keep old binders only while unmigrated route lists need them; delete callerGuard/global inline policy only once all shape policies are mounted and tested.

### Request and refusal inventory

This is a source-backed family inventory, not an assertion that all schemas/statuses are already enumerated. Literal operations in ./http-operations.md omit OIDC GET login, callback, POST refresh/logout, and lack status schemas. Build the final inventory from route factories, feature-mode composition, parsers, service outcomes and tests.

| Family / existing source           | Request declaration inputs                                                                                                                                                        | Reply/refusal details requiring explicit shapes                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| smoke.routes                       | body text:string                                                                                                                                                                  | echoed:string; replace freeform validator-message error with declared validation code                                                                                                                        |
| step.routes                        | id, stepId; create/rename name; delete cascade query semantics                                                                                                                    | step/result/empty; StepRefusal, in_use detail, auth and 422 invalid_body                                                                                                                                     |
| work-item.routes                   | id; commands arrays and every parseCommand kind; directory commands; undo/redo bodies as currently consumed                                                                       | tree and command replies; number_is_derived and other parser codes; batch at/kind; service-specific detail; stale undo detail and 400/403/404/409 distinctions                                               |
| history.routes                     | id; optional workItemId/kind strings                                                                                                                                              | events; unknown kinds stay an empty filter result, not a new validation refusal; not_found/auth                                                                                                              |
| solution.routes                    | slug                                                                                                                                                                              | solution lookup payload or 404 not_found                                                                                                                                                                     |
| saved-plan.routes                  | id; optional save name versus required nonempty rename name; compare left/right required nonempty strings; list filters from callers                                              | header/body/compare; quota refusal detail, corrupt refusal detail, savedPlanId on missing comparison side, 503 snapshot_busy; unsupported_body_version currently 501 with savedPlanId/body/version/supported |
| project.routes                     | create name; patch name/restricted/estimateMethod/depReach/pertWeights/estimateRounding/startDate/solutionRef/optimizationEnabled/scheduleEngine/scheduleObjective; export format | project/list/export, empty opened result; unsupported_format, optimizer_unavailable, invalid_body, not_found, forbidden and service outcomes                                                                 |
| directory.routes                   | six authenticated GET shapes, no command bodies here                                                                                                                              | teams/people/tags/services/workItemTypes/externalSystems arrays; commands live in work-item.routes and carry DirectoryRefusal plus usage/name                                                                |
| internal.routes                    | InternalForwardRequest and InternalResumeRequest from contracts                                                                                                                   | forward ack/resume statuses; unauthorized; malformed trusted response handling remains explicit                                                                                                              |
| auth.routes                        | username/password; client headers; OIDC query/state/code and raw URL; cookie-bearing refresh/logout                                                                               | token/user; invalid_client/origin/token/credentials, rate_limited/taken/invalid and route-specific statuses; 429 admission; 302 Location+EMPTY; 204+EMPTY; cookie multimap                                   |
| app health / observability metrics | no body                                                                                                                                                                           | structured health including dependency 503; text metrics with declared content type                                                                                                                          |

`refusal-status.ts` currently maps codes contextually with a route default: do not invent a global one-code-one-status map. `plan-commands.ts` currently types reasons as string and detail as a bag; trace every constructor/caller to close the wire union without unchecked casts or importing service implementation into contracts. Batch at/kind belong to relevant RefusalDetail variants, not mandatory global envelope fields. Preserve optional-versus-null semantics on patch bodies and full domain validation, including capacities, priority ladders, weights, dates, measures and command reference resolution.

Completeness refinement approved by the parent from landed evidence: extend RefusalStatus with 501 and preserve unsupported_body_version detail (savedPlanId/body/version/supported). `saved-plan.routes.ts::refusingUnknownBodyVersion` and `saved-plan.controller.db.test.ts` distinguish a build capability gap from corrupt records (422) and temporary contention (503). This follows D26's status-specific modeled-refusal intent; it is not a new product decision. Do not remap the existing feature. The parent will correct the normative sketch after the freeze when Wave 1 starts. Add 501 to server/client status validation and preserve its existing negative.

### Emission, clients and timing

Two independent completeness oracles: every shape has exactly one bound endpoint with no extras; real app.handle reaches every mounted shape (including conditional auth configurations). Skipping a mount must fail reachability even when the document remains correct. MCP uses explicit operationIds, inline object body properties/required and nested command arrays; pin tool names, optional fields, each union arm and missing-operationId refusal. openapi.json becomes a build output; delete plugin and obsolete duplicate schemas only after all consumers/build paths move. No handler table crosses the contracts ring.

clientFromShapes is parameterized by transport and validates both success and refusal status arms before screens receive values. Production fetch and shape-driven in-process fake use the same contracts. Replace the actual three FE modules api.ts/wbs-api.ts/saved-plan-api.ts and two existing fakes; the plan's prose saying four modules is stale. Convert error-string branches to discriminated switches. Do not add URL-only request sharing: R1 owns generations, pending resource scopes and mandatory trailing reads, and must land before this migration.

Record be-01 and fe-01 source+spec typecheck wall time immediately before generic edits and after, same commands/host/cache policy/tree and no concurrent gate load. Earlier standalone type probes are not a baseline. Use multiple comparable samples if timing noise obscures the doubled-time threshold; record actual values and apply PrincipalOf fallback if doubled. Frozen checkpoint verification is separate evidence, not a performance baseline automatically.

### Fetched-commit supplement — pre-integration only

Read-only git show evidence from4051512c (calendar markers),39e53dda (callback method/cardinality),a91f831b (provider refusal handling). These commits are fetched, not claimed integrated into the frozen checkpoint; no new tests were run. Reconcile their touched source/test/config files after merge, then regenerate inventory once.

**Calendar markers.** Add calendar-marker.routes.ts immediately after project.routes in the migration queue, before directory. Four shapes: GET/POST /api/projects/:id/calendar-markers and PATCH/DELETE /api/projects/:id/calendar-markers/:markerId. POST body is {markerId?:string,date:string,name:string,color?:string|null}; domain maps markerId to id. PATCH names exactly one of name or color, with null meaning automatic and absence meaning no request. GET returns {markers}, POST201/PATCH200 return {marker}, DELETE204 is EMPTY. Preserve total list order(date,createdAt,id), absolute IsoDate text, UUIDv4 markerId, Unicode code-point name bound, hex-shape-before-contrast validation, and error field detail: malformed/contrast422 with field; taken409/not_found404 field markerId; forbidden403 without field.

The four MCP operationIds are getApiProjectsByIdCalendar-markers, postApiProjectsByIdCalendar-markers, patchApiProjectsByIdCalendar-markersByMarkerId and deleteApiProjectsByIdCalendar-markersByMarkerId. Retain wire markerId: MCP flattens path/body keys and id is already the project, so renaming it id reintroduces a real collision. Current marker PATCH ignores unknown date/markerId, even mistyped ones; deep strict requests intentionally change this to refusal and must name the exact changed tests. Marker PATCH's exactly-one-field union must retain MCP inline object compatibility; domain contrast predicates cannot silently disappear because JSON Schema cannot encode them. Use representable structural wire schemas plus explicit modeled semantic validation with field-specific Refusal detail; do not feed unsupported arbitrary predicates into the converter and fallback.

Preserve calendar-marker.controller.db.test.ts, calendar-marker-identity.db.test.ts, repository marker/migration tests, saved-plan-capture exclusion checks, broadcast tests, wbs-api tests/fake, Gantt browser and zoned-date regressions. Markers remain separate from work items, PlanRead, scheduling, saved-plan capture, command journal and revisions; same UUID as a work item must not cross route families. Successful writes emit calendar_markers_changed only after storage succeeds; refusals emit nothing. FE transport migration includes new list/create/rename/recolor/delete methods and preserves marker-only refresh instead of full plan rereads. Wave2 later includes CalendarMarkerStore(listFor/create/rename/recolor/remove), its repository/service/composition and scoped write coordinator/runtime injection. It is transactional source state, not independent saved-plan history; preserve exact date/order/project ownership and D29 explicit memory debt if lagging. Do not perform that extraction in Wave1.

**OIDC callback method and cardinality.** New RouteRequest.receivedMethod records the arrived verb while method retains the registered verb; both binders are changed and binder.contract.test.ts pins their difference. New EndpointInput.request.method must preserve the actual arrived method, independently of shape.method. HEAD on callback must remain405 method_not_allowed + Allow:GET, with no Set-Cookie, transaction consumption or exchange; a later honest GET still completes. Add405 to the modeled status union as a landed-contract completeness correction like501. Other wrong verbs still miss GET registration and receive404; do not generalize callback's405 to every route.

Read the raw URL before lossy query-object parsing: refuse every repeated query key, not only state, as400 duplicate_parameter before consume and without clearing cookies. Preserve parameter cardinality (getAll/iteration), not first/last selection or array coercion. The current query record loses repeats, so a generic schema decoder cannot replace this check after flattening. Incoming d08a6ad6 (TASK-276), reviewed before integration, supersedes the former delete-before-comparison contract. Consume checks expiry first and removes expired records; a live state mismatch retains the record and returns state_mismatch; only a matching state consumes once. Missing state/binding and missing/expired consume outcomes return bodiless400 and clear the binding. A live mismatch returns the same bodiless400 without Set-Cookie, so the honest callback can still finish. Under Wave1's one-envelope rule, explicitly rewrite these body assertions to the same declared public Refusal status/body while preserving the distinct cookie and transaction timing; do not expose internal consume outcomes as new wire error codes. Callback query allowlisting must account for provider protocol fields and extensions read by the existing client; inventory them after merge before claiming strict-query coverage.

**Provider error callbacks.** After successful consume, nonempty error skips exchange and redirects302 EMPTY to /?auth_error=<allowlisted reason>, clearing only binding. Allowlist: access_denied, account_selection_required, consent_required, interaction_required, login_required, temporarily_unavailable; everything else maps provider_error. Blank error currently gives bodiless400 and binding clear without exchange. Provider error_description is never reflected or logged verbatim; log raw error code, has_description and auth_error at info for published codes, warn otherwise. Exchange rejection is logged with err then currently bodiless401 + binding clear; this narrow exchange catch must not grow around account lookup/identity resolution (R3). Deferred502/503 classification is not introduced by HTTP migration. Existing OIDC bare400/401 bodies intentionally gain the unified envelope; redirect destinations and no-description/log fields remain unchanged.

The fetched app.ts logger wiring and authRouteLog port must survive composition. Preserve named tests: refuses a callback carrying two states without spending the transaction; refuses a callback carrying two codes with the transaction still unspent; refuses a HEAD callback with405 and Allow, before consuming or exchanging; answers a cancelled login by returning to the sign-in page without reaching the provider; refuses a blank error code at the boundary instead of at the provider; answers a failed exchange with a typed refusal rather than a framework500. Also preserve the forged-then-honest callback test from d08a6ad6, including deriving the honest request cookie from the forged response, and the store tests for retained mismatch, replay after successful consume, and expiry before mismatch. Re-run after merge/migration; commit messages' historical test counts are not this branch's fresh evidence.

### Decision scope map

D3/D13/D16/D21/D25/D26 govern this implementation; D4 keeps characterization local; D5 limits apps; D7–D9 govern wave packaging; D14 informs boundaries without prematurely moving projects. D1/D2/D6/D10–D12/D20/D22–D24/D27–D29 are preserved later-wave constraints, not new work in HTTP. D15 is superseded by D24. D17 browser mode and D18/D19 namespace/ring layout are not built here. Link ADR rationale rather than duplicate it.

## Risks / Trade-offs

The deliberate wire break is deep rejection and one envelope, not permission to weaken domain guards. Preserve R3 valid-token/store-failure regressions and R5 in-flight/global-cap release behavior during auth migration. Watch each changed safety test fail on its production path before writing Proof comments. No current check is claimed complete by this draft; resolve the evidence checklist in verify.md before implementation promotion.

### Trusted browser origin after integration

The merged-source inventory in `./http-origin.md` establishes that common HTTP origin policy currently lacks a composition value outside OIDC. Introduce required backend `appOrigin`: OIDC derives it from its already-validated configured callback URL; local mode requires explicit nonsecret `APP_ORIGIN`. Validate the latter as an HTTP(S) origin at startup. Never derive trust from incoming Host, forwarded host, or Origin. Login/register use this common value regardless of authentication mode; unsafe session-cookie writes use the approved conditional policy. Keep gateway-local authentication behavior unchanged.

Wire the configuration boundary in the same migration slice: config/main/boot/buildApp fixtures, public backend example, existing-checkout setup handling, backend deploy allowlist and rendered deployment configuration, and shifted Playwright server env. Preserve unrelated environment keys and surface unreadability. Existing deployment OIDC configurations retain their callback-derived source. Tests and smoke callers explicitly send the configured browser Origin for login/register. Production-path negatives must cover the missing local-mode check, startup refusal, the actual rendered config, and a shifted browser login with a deliberately incorrect fixed4200 origin. No runtime proof is claimed by this draft.

### Contextual request refusals and protocol prevalidation

Approved backend-only binding options preserve existing refusal contracts without weakening `SchemaShape`. `bind(shape, handler, options?)` may provide a request-failure classifier and metadata-only prevalidation. Both return only that shape's declared refusal status/body alternatives; prevalidation alone may return null to continue. They receive no Elysia context and perform no service writes. The shared declaration, descriptor and successful request type remain unchanged.

Run ordered origin/identity policies first, then metadata prevalidation before params/query/body checks. This seat can refuse an arrived HEAD with405/Allow or duplicate callback query keys with400 before validation/transaction consumption. The handler remains responsible for actual callback consumption; the hook cannot supply a body or principal.

Classify a failed request part using its rejected unknown value, Standard Schema issues when available, and preserved request metadata. The classifier cannot admit a request or replace input. Return its refusal through the normal declared reply validator; absent hooks retain existing generic validation codes. Unexpected hook failures remain500. This failure-only boundary supports command at/kind and legacy precedence, including an earlier semantic command refusal ahead of a later structural error. Never derive domain codes from validator message text or first union-issue ordering; use pure family-local classification. Syntactically invalid JSON supplies source text with no schema issues, distinct from schema-invalid decoded bodies. Missing schema declarations likewise have no schema issues.

## Body media preservation

Each declared body may name a nonempty bodyMedia tuple of application/json,
application/x-www-form-urlencoded and multipart/form-data; omitted metadata means
JSON. The declaration, adapter, emitter and JSON fetch client share bodyMediaFor.
A bodyless declaration cannot name media. Proven step name and smoke text bodies
name all three; nested command bodies stay JSON-only. One ArkType body schema
validates the decoded value, with no form-specific shadow schema or coercion.
Repeated form fields remain arrays and files remain Files, so string-name schemas
refuse both. Unknown fields still fail deep request strictness.

Legacy characterization covered126 requests through actual old/new adapters and
services. Missing/unrecognized Content-Type produced invalid_body on old step
writes, even when the bytes looked like JSON; recognized malformed JSON keeps its
distinct invalid_json refusal. Unsupported media uses the declared invalid_body
classification rather than attempting JSON. Policies and metadata prevalidation
precede the single request-byte read. Modeled multipart syntax failures are
refused; unrelated parser/stream errors remain unexpected failures.

The JSON fetch client refuses a trusted declaration that offers no JSON. This
refinement preserves accepted wire formats and makes the generated document agree
with the adapter. Optional empty saved-plan save bodies require separate presence
modeling before that family migrates; an absent optional body must not be confused
with an unsupported nonempty body. No OpenAPI3.0/3.1 compatibility cast is introduced
into the interim legacy publisher.
