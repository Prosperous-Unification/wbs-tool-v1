# Verification Report — verified

Change: `http-endpoint-port`. The implementation is complete and has passed its
focused, workspace, Linux solver, and isolated browser gates. The delta spec has
been synced to the canonical specification. Archival remains a separate action.

## Structural validation and task completion

All **33 of 33** tasks are complete. Strict validation reports one valid change
and zero issues. The final mounted inventory is **40 operations in local mode**
and **44 in OIDC mode**; the generated OIDC document contains **44 operations**.
The exact-binding and real `app.handle` inventories prove that each mounted shape
has one implementation and each route is reachable.

The final owned-file inventory contains **235 paths** in `owned-files.txt`. It
consolidates the per-wave ownership inventories after all upstream merges and
adds this closeout record plus the synced canonical spec. It includes deleted
paths so reviewers can audit removals as well as the final tree.

## Before/after typecheck timing

| Target            | Before generic edits             | After foundation           | After full migration     | Doubled threshold |
| ----------------- | -------------------------------- | -------------------------- | ------------------------ | ----------------- |
| be-01 source+spec | 8.409s / 8.365s; mean 8.387s     | 10.628s / 9.638s; 10.133s  | 15.31s / 15.04s; 15.175s | 16.774s           |
| fe-01 source+spec | 10.525s / 10.314s; mean 10.4195s | 12.016s / 11.258s; 11.637s | 17.40s / 17.35s; 17.375s | 20.839s           |

All samples used sequential `bunx tsc --build --force
apps/<app>/tsconfig.json` runs on the same macOS arm64 host with the existing
dependency installation and forced rebuilds. Both final means remain below the
approved fallback threshold. Deliberately wrong assignments were separately
observed failing in source and test projects, proving that these targets compile
the files they claim to check.

## Failure-proof table

Every row below was observed failing with its named production fault and passed
again after restoration. The checkpoint sections retain exact diagnostics,
commands, counts, and Proof-comment provenance.

| Check                 | Named injected fault                                | Production-path proof                               | Result           |
| --------------------- | --------------------------------------------------- | --------------------------------------------------- | ---------------- |
| literal typed handler | widen path/policy/reply or mismatch params schema   | actual bind fixtures plus source/spec typecheck     | failed, restored |
| preparse policy       | delete or delay identity/origin policy              | malformed read-token and foreign-cookie writes      | failed, restored |
| strict input          | strip or admit nested unknown fields                | mounted command/project/fake mutation cases         | failed, restored |
| descriptor identity   | drop an arm/property/operationId or emit a fallback | emitter and real MCP consumer                       | failed, restored |
| reply boundary        | bypass status/schema/media validation               | mounted adapter and shape-derived client matrices   | failed, restored |
| representation        | collapse null/EMPTY/text/redirect/cookie variants   | real response and `getSetCookie` checks             | failed, restored |
| binding/mount         | omit a binding separately from its mount            | exact inventory and `app.handle` reachability       | failed, restored |
| frontend boundary     | widen a known field or share old reads by URL       | consuming screen typecheck and held-refresh callers | failed, restored |
| auth safety           | broaden store catch or lose admission reservation   | valid-token store failure and held login requests   | failed, restored |

## Intentional wire assertion rewrites

The migrated wire changes were asserted on their production call paths:

| Previous behavior                   | Verified behavior                            | Result  |
| ----------------------------------- | -------------------------------------------- | ------- |
| Smoke freeform validator message    | named `Refusal` validation envelope          | passing |
| Extra body keys ignored or stripped | explicit refusal with no mutation            | passing |
| Nested command extras tolerated     | deep refusal retaining derived-field codes   | passing |
| Framework compare-query report      | shared declared-status `Refusal` envelope    | passing |
| Unchecked frontend error payload    | status-specific validated refusal and detail | passing |

The final gates preserve 501 future saved-plan version, 503 contention, 429
admission, R1 held-response windows, R3 unexpected failures, and R5 active
reservation/global limits.

## Fetched feature/fix evidence update

Available feature branches were merged before each port. Later upstream auth and
solver advances were merged, reconciled, and gated before closeout. The final
inventory includes calendar-marker endpoints, conditional OIDC operations,
callback 405 with `Allow`, and saved-plan 501. Historical operation counts below
describe the checkpoint at which they were observed; the final 40/44 inventory
above supersedes them.

## Gate output

The frozen exact-code gate at `40c555b1` ran `bunx nx format:check --all` and
`bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache
--exclude=solver-py`: Nx successfully ran all targets for **24 projects**. Key
totals were frontend **2,461 tests** plus **3 zoned tests**, backend **1,954
tests / 19,737 assertions**, contracts **370 tests**, auth **76 tests**, and
bootstrap **60 tests / 286 assertions**. One `tool-remote-scripts:test` task was
reported flaky by Nx but passed in the final target result. Frontend lint retained
its existing exhaustive-deps warning and had zero errors.

The isolated browser gate used `CI=1 E2E_PORT_SHIFT=1900 bunx nx run fe-01:e2e`
with dedicated backend, gateway, and frontend ports. Chromium reported **293
passed, 1 intentional skip, 0 failed** in 16.5 minutes. The Linux Docker solver
gate reported **195 passed**. The macOS host does not carry the supported solver
dependencies. The Linux-only peer-credential file was therefore run in the
installed `oven/bun:1.3.14-alpine` image with `docker run --rm ... bun test
./tools/tool-remote-scripts/src/lib/solver-supervisor-peer-credentials.test.ts`:
**3 passed, 0 failed, 6 assertions**, including the real Bun Unix-listener
`SO_PEERCRED` case.

Independent final review of the merged tree found no Critical or Important
issues. Decision: **VERIFIED; implementation complete; ready to archive.**

## Historical implementation checkpoints

The sections below are frozen records written as each slice completed. Their
present-tense pending statements and 38/42 operation counts describe those
earlier checkpoints; the final status, 40/44 inventory, and gate output above
supersede them.

## Pre-generic compiler baseline

Measured on the integration tree with362c29a8 plus merged b2bb095c deadline feature, before generic source edits; no full gate or worker test/build was running. Command per sample: `bunx tsc --build --force apps/<app>/tsconfig.json`, root source/spec (FE also e2e), two sequential rounds. Backend8.409s/8.365s; frontend10.525s/10.314s; all exit0. Means8.387s and10.4195s; doubled thresholds16.774s and20.839s. Logs `/private/tmp/wbs-http-baseline-*.log`; host/policy metadata `/private/tmp/wbs-http-typecheck-baseline.json`.

Each command then rejected a deliberately wrong assignment in BOTH src/refactoring-typecheck-probe.ts and src/refactoring-typecheck-probe.test.ts withTS2322, exit2. Both probes and generated probe files were removed in finally; logs `/private/tmp/wbs-http-typecheck-negative-*.log`. Thus the actual targets read source and test projects; no empty solution compile is being timed.

## Foundation task 1.5 — descriptor emitter and real MCP consumer

Bounded implementation checkpoint on 2026-09-06; this section supersedes the draft-only wording above for task1.5 only. Owned paths: contracts http/document-from-shapes.ts and its test, contracts public index export, and mcp-01/src/shape-document.test.ts. No routes, adapters, committed OpenAPI artifact, or MCP production consumer changed.

The generated document is serialized to a temporary OpenAPI file and read through the actual readDocument/toolsFromDocument consumer. The fixture covers all five exclusion classes and asserts the one remaining operation's name, method/path, summary, required/optional inputs and locations, strict body fields, and both nested command alternatives. Emitter tests cover non-object queries, missing declared route params, blank/duplicate operation names, normalized route collisions, multiple JSON/refusal alternatives at one status, text media, and empty-status ambiguity. The public export makes the fixture consume contracts through its normal package boundary. No validator internals are inspected. Unsupported ArkType conversion remains the declaration-boundary owner in schema-shape.test.ts; no conversion fallback was introduced here.

The parent scaffold already passed4 tests before this work. Added regressions passed against its behavior. Scoped lint then exposed inaccurate dictionary types: Record claimed every response/media key existed. Response entries now explicitly permit missing statuses, and media merging checks own-key presence. No lint suppression or widened any was used.

### Observed faults and restoration

| Fault in production emitter                                     | Observed failure                                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omit emitted operationId                                        | Both MCP fixture tests fail inside toolsFromDocument: POST /api/projects/{id}/commands has no operationId.                                                                |
| Remove optional label property while emitting body              | MCP input-locations assertion loses label:body; not an emitter/self-descriptor equality check.                                                                            |
| Remove second nested commands anyOf arm                         | MCP-derived commands schema assertion loses the entire rename arm, including kind/name requirements.                                                                      |
| Remove scalar/array query object check                          | Non-object-query test receives a document instead of an explicit refusal; query inputs are silently absent.                                                               |
| Remove missing declared parameter check                         | Missing-descriptor test receives inferred string id instead of refusing the mismatch.                                                                                     |
| Remove blank-name check; separately remove duplicate-name check | Each corresponding test receives a document instead of operationId refusal.                                                                                               |
| Remove normalized method/path collision check                   | Converted-path collision silently replaces the first operation rather than throwing.                                                                                      |
| Overwrite response schema instead of combining alternatives     | Response-alternatives test receives only the third JSON response; first/second arms disappear.                                                                            |
| Remove repeated-empty diagnostic                                | Test receives Object.entries-on-undefined rather than the named ambiguous204 error. This is a diagnostic proof, not a claim that removing it accepts an invalid document. |

All injected faults were restored. Adjacent Proof comments describe those observed failures. No unobservable extra guard was added.

### Fresh scoped verification

- `bun test libs/contracts/src/http/document-from-shapes.test.ts apps/mcp-01/src/shape-document.test.ts apps/mcp-01/src/openapi-tools.test.ts`:36pass,0fail,234assertions after dictionary correction/restoration. Log:/private/tmp/http-emitter-consumer-tests.log.
- `bunx nx run-many -t typecheck --projects=contracts,mcp-01 --skip-nx-cache`:both source+spec targets passed after dictionary correction. Log:/private/tmp/http-emitter-typecheck.log.
- Scoped ESLint on the four owned TypeScript files passed after import ordering and dictionary corrections.
- Owned TypeScript formatting and diff checks passed; no whole-file rewrite of this shared verify artifact.

Held for independent review, without commit. This foundation does not claim the committed OpenAPI document has migrated, every route is represented/reachable, HTTP client migration is complete, or any full workspace/browser gate has passed. Broad migration, adapter checks, timing-after comparisons and the final gate remain parent-owned.

## Implemented adapter foundation — 2026-09-06

This section supersedes the draft-only status **for the adapter foundation alone**. Production route migration, generated clients/documents, bootstrap wiring, full gates and archival remain pending under parent ownership. Worktree: `.worktrees/refactoring`, branch `refactor/planned-project`. No commits or broad gates were run by this worker.

Owned changes: `apps/be-01/src/http/elysia/mount.ts`, `mount.test.ts`, and the approved one-member addition `invalid_params` in `libs/contracts/src/http/refusal.ts`. The new no-detail code describes a declared params-schema refusal; its status comes from that endpoint's refusal schema, demonstrated at 422. No existing business route has yet changed its wire behavior.

Installed Elysia's `onRequest` runs before routing/parsing and propagates into a parent `.use(...)`. Its local `onError` does not cover the propagated pre-routing hook: the initial standalone fix passed while the added composed-app outage test received 200 instead of 500. The final error hook follows requests into composition and applies only when this adapter selected the request. A legacy sibling still returns its parser's 400, and an unmatched path remains 404. Explicit `parse: 'none'` lets the adapter decode JSON once after ordered policies and await Standard Schema request/reply validation. Unexpected resolver, decoder, validator and handler failures remain 500.

Fresh checks after restoration and formatting:

- `bun test ./apps/be-01/src/http/elysia/mount.test.ts ./apps/be-01/src/http/endpoint.test.ts ./libs/contracts/src/http/refusal.test.ts`: **28 passed, 0 failed, 104 assertions**, 3 files, 1476ms. Adapter alone contains 25 cases; the other three verify endpoint representation and closed refusal typing. Log: `/private/tmp/http-mount-final-tests.log`.
- `bunx tsc -p /private/tmp/http-mount-type-probe.json`: passed, no diagnostics. The bounded configuration includes `mount.test.ts` and its actual production imports, extending the existing backend spec configuration. Log: `/private/tmp/http-mount-final-types.log`. No new root compiler run or timing comparison is claimed; the prior root source/spec coverage evidence above remains the gate evidence.
- Scoped ESLint for both adapter files and `refusal.ts`: passed, no diagnostics, `/private/tmp/http-mount-final-lint.log`. Scoped Prettier and diff checks are recorded in the worker's final report.

All 32 injected faults below failed their actual mounted tests and were restored before the final checks. The mutation runner saves the original source and restores it in `finally`; it does not leave a fault in production. Exact per-fault output is `/private/tmp/http-mount-fault-<name>.log`; 31 cases are indexed by `/private/tmp/http-mount-faults.json`, and the decoder case is `/private/tmp/http-mount-fault-decoder.log`. Proof comments were added only after those failures were observed.

| Fault name / injected change                               | Actual mounted test observing it                                                      | Observed failure                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| early-parse: decode malformed JSON before policies         | refuses malformed JSON with a read-only token before parsing or writing               | expected403, received400                                     |
| identity: omit identity policies                           | same read-token test; internal identity test                                          | expected403/401, received400                                 |
| origin: omit invalid-origin refusal                        | cookie origins; login-style origin                                                    | expected403, received400/200                                 |
| policy-order: reverse policy order                         | delivers resolved user and internal principals and follows declared policy order      | expected403, received401                                     |
| principal-delivery: omit resolved principal                | same principal-delivery test                                                          | expected200, received500                                     |
| principal-kind: omit resolver-kind check                   | rejects resolver principal mismatches before handler invocation                       | expected500, received200                                     |
| admission: omit endpoint/admission identity check          | refuses a second binding that disagrees with its admitted endpoint                    | expected500, received200; conflicting binding runs           |
| static-order: omit static-segment priority                 | admits static and parameter siblings with their own ordered policies                  | expected200, received401                                     |
| arrived-method: substitute GET for HEAD                    | preserves decoded params, last query value, raw duplicates, headers and arrived HEAD  | metadata method GET instead of HEAD                          |
| query-last: reverse query entries before building record   | same metadata test                                                                    | first query value instead of last; raw URL remains available |
| params: omit modeled params refusal                        | uses declared validation status and refuses invalid params before the handler         | expected422, received500                                     |
| query: omit modeled query refusal                          | metadata test's extra query field                                                     | expected400, received200                                     |
| body: omit modeled body refusal                            | refuses unknown nested request fields and malformed JSON with declared envelopes      | expected400, received500                                     |
| deep-request: bypass request validation entirely           | same nested-field test; constrained params test                                       | expected400/422, received200                                 |
| async-request: omit validation await                       | awaits asynchronous request and reply validators and preserves validator outages      | expected200, received500                                     |
| async-reply: omit successful reply validation await        | same asynchronous test's invalid reply                                                | expected500, received200                                     |
| async-refusal: omit refusal validation await               | validates both successful and refusal replies against their declared status           | expected500, received429                                     |
| refusal-schema: bypass refusal status/schema validation    | same reply-validation test                                                            | expected500, received429                                     |
| success-schema: bypass successful body validation          | same reply-validation test                                                            | expected500, received200                                     |
| success-status: use first response regardless of status    | rejects undeclared statuses and mismatched empty, text and JSON representations       | expected500, received201                                     |
| empty: remove EMPTY check                                  | same representation test                                                              | expected500, received204                                     |
| text: remove required text representation check            | same representation test                                                              | expected500, received200                                     |
| body-representation: coerce absent body to JSON null       | refuses a text representation on a JSON null endpoint                                 | expected500, received200                                     |
| success-error: remove successful error-envelope refusal    | refuses successful error envelopes even when the JSON schema is permissive            | expected500, received200                                     |
| cookies: replace append with set                           | preserves redirect Location and all three Set-Cookie headers                          | first two cookies missing; only three=3 remains              |
| json-null: serialize null as empty                         | keeps empty and JSON-null replies distinct                                            | expected text "null", received ""                            |
| error-status: omit explicit500 response                    | preserves an unexpected account-store failure                                         | expected500, received200                                     |
| error-scope: make error hook local                         | retains preparse policies and repeated headers when composed into a parent Elysia app | expected500, received200                                     |
| error-isolation: handle unrelated requests' errors         | leaves an unrelated legacy route parser and error boundary intact                     | expected400, received500; unmatched404 also became500        |
| validation-status: hardcode validation status400           | constrained params test                                                               | expected422, received500 because400 is undeclared            |
| undeclared-validation: default an undeclared refusal to400 | throws for missing validation refusals and unexpected handler failures                | expected500, received400                                     |
| decoder: broaden SyntaxError catch to every exception      | preserves unexpected decoder failures instead of labeling them malformed JSON         | injected decoder outage expected500, received400             |

### Remaining protocol integration decisions

The adapter preserves `request.url` as a URL with every query occurrence and `request.method` as the arrived verb. A declared generic query schema reads the existing last-value record; an absent query declaration yields `undefined` while raw URL metadata remains available. This is **not** proof that OIDC callback migration is ready: its HEAD405 and duplicate_parameter400 checks must run before generic query rejection and before transaction consumption. The approved design requires an explicit shape/policy decision for that precedence; do not flatten duplicate keys and silently claim callback preservation. Other wrong methods remain ordinary router misses rather than a new global405 rule. No controller, service, live socket or browser migration proof is claimed by these adapter tests.

## Origin composition — partial implementation

Local startup now requires explicit APP_ORIGIN; OIDC uses the configured callback URL. The common value is required by boot/buildApp. Login/register origin checks run before parsing in non-OIDC composition too; unsafe session-cookie requests use the same trusted origin. Caller fixtures carry explicit origins. Deploy/browser carriers are still being completed separately.

Fresh scoped config/origin/auth/OIDC run: **89 passed, 0 failed, 282 assertions**, 3.15s; `/private/tmp/wbs-http-origin-focused.log`. Existing local setup diagnoses the missing origin without overwriting configuration. Setup restoration before final assertion cleanup: **9 passed, 16 assertions**; fresh post-cleanup run pending. No broad origin gate or review yet.

Observed faults, all restored: always-origin removed -> login/register 400 instead of403; cookie-origin removed ->200 instead of403; local path/query/fragment guard removed -> invalid configured origins accepted; credential URL guard removed -> credential-bearing origin accepted; callback path guard removed -> /other accepted; existing-env check removed -> setup resolves with missing origin; readFile failure swallowed -> unreadable setup resolves instead of rejecting. Logs `/private/tmp/wbs-http-origin-fault-*.log`. Subsequent assertion cleanup awaits restoration rerun before final evidence.

R1/R9 integration: new broadcaster-order test now supplies R9's explicit timers/5s attempt/15s overall dependencies; **1 passed, 5 assertions**, `/private/tmp/wbs-r1-r9-order-integration.log`.

Emitter review correction: index-signature/object-level parameter descriptors must be refused, because named OpenAPI parameters cannot express them. Removing the constraint check was observed accepting an indexed query instead of throwing (`/private/tmp/wbs-http-emitter-review-fault.log`); restored emitter/MCP run passed. Reviewer approved this correction; later focused restoration totals pending.

## Trusted-origin carriers — browser and rendered deployment checkpoint

Owned carrier changes: apps/fe-01/playwright.config.ts/playwright-config.test.ts; tools/tool-remote-scripts/src/lib/docker.ts/docker.test.ts and swap.test.ts; approved extension tools/tool-compose/src/templates/tier.compose.tmpl, render.ts and render.test.ts. Backend config/app/boot and tools/dev setup remain parent-owned. No private operator env contents were inspected; origin/config child probes receive explicit synthetic configuration and disable automatic dotenv loading with --no-env-file.

### Source-backed composition decisions

- Shifted Playwright backend APP_ORIGIN follows actual fePort. Its test loads the real backend config and app in Bun, then posts login with literal Origin http://localhost:4700 for shift500. A401 means the request reached authentication, while the named fixed4200 fault receives403. This is a real backend route probe, not a same-expression comparison; no browser stack is started by this test.
- Blue/green startGreen renders backend-only APP_ORIGIN from validated layout.siteAddress into Compose's environment block. Compose environment overrides env_file, so existing operator files need no new mandatory origin key to obtain the public deployment origin. Bare Caddy hosts use automatic HTTPS; explicit http/https origins retain scheme and port. Credentials, whitespace, wildcard hosts, paths, queries, fragments and non-HTTP schemes are refused. No arriving request header participates.
- APP_ORIGIN is accepted only by the backend app-config allowlist, not gateway, frontend, shared OIDC provider or derived secrets carriers. The actual startGreen test exercises allowlist admission, written Compose and ordering before Docker invocation.
- Existing source-dev compose explicitly supplies AUTH_MODE=oidc and NODE_ENV=development. OIDC continues deriving its browser origin from AUTH_REDIRECT_URI, even if the rendered APP_ORIGIN differs; the actual backend config probe verifies that. Published backend Dockerfile sets NODE_ENV=production, and authModeOf already refuses local mode there. No claim about a private live mode setting is made. No new mandatory provider environment key was introduced.
- Packaged Playwright starts only static FE Caddy, with no backend/gateway/auth carrier. It needs no origin change.
- Text-inclusive inventory of FE e2e and tool-smoke sources found no direct login/register POST callers. header.spec.ts carries an OIDC GET-login href and mocked navigation; ordinary browser authentication supplies its own Origin. No broad e2e/smoke callsite changes were made.
- Bootstrap configure.sh remains unchanged: origin wiring is supplied by the actual rendered container, and existing OIDC mode behavior does not require a newly provisioned origin secret. No bootstrap 16-minute suite was run for this bounded carrier change.

### Observed production-path faults

| Fault                                           | Observed failure                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin Playwright APP_ORIGIN to4200 at shift500    | Actual backend login route returns403, expected401 in playwright-config.test.ts.                                                                                                      |
| Omit ENVIRONMENT placeholder from tier template | Rendered-environment local backend configuration probe exits1, expected0. Earlier RED rendered-Compose tests also received missing APP_ORIGIN instead of the literal prod/dev origin. |
| Remove APP_ORIGIN from backend allowlist        | Actual startGreen call throws outside-tier-allowlist before Compose/Docker effects.                                                                                                   |
| Remove parsed-origin validation                 | Credential-bearing siteAddress renders instead of throwing in Docker test.                                                                                                            |
| Remove whitespace validation                    | URL normalizes the newline-bearing hostname and renders it instead of refusing.                                                                                                       |

All faults restored before latest checks; Proof comments written from observed outputs. Redundant empty-string/empty-host checks were not retained: URL parsing already rejects those states. No check is claimed from mere helper equality or from a command exit that cannot establish its effect.

### Fresh scoped verification

- From apps/fe-01: `bunx vitest run --config vitest.node.config.ts playwright-config.test.ts`:7pass,0fail, including real backend shifted-origin login probe. Initial root invocation used the wrong suite root and collected no tests; corrected app-root command supplies the evidence.
- `bun test tools/tool-remote-scripts/src/lib/docker.test.ts tools/tool-remote-scripts/src/swap.test.ts tools/tool-compose/src/render.test.ts`:131pass,0fail,217assertions after final restoration and dotenv-isolated probes. Log:/private/tmp/http-origin-tool-tests.log.
- `bunx nx run-many -t typecheck --projects=fe-01,tool-remote-scripts,tool-compose --skip-nx-cache`:all three passed, including source/spec projects. Log:/private/tmp/http-origin-final-types.log.
- Scoped ESLint and formatting on owned TypeScript files passed; owned diff check passed.

Held for independent carrier review, no commit. No Docker daemon/deployment, full browser stack, bootstrap sweep or workspace full gate was run or claimed. Parent owns route/config migration and final frozen gate.

## Adapter review corrections — 2026-09-06

Independent review identified two foundation defects: reply selection stopped at the first declaration with a matching status, rejecting valid later alternatives; and a mixed user/internal policy tuple could replace a user principal with an internal principal despite its inferred user type. New tests were red before these corrections. The response matrix now considers every applicable representation/status/schema alternative, awaiting later schemas. Literal mixed identity tuples are rejected by `defineEndpointShape`, and the adapter refuses incompatible erased tables at mount time. A single variable identity requirement derives a distributive principal union; the actual bind fixture requires narrowing before reading user fields and permits kind-based narrowing.

Parent also approved strictness corrections: a nonempty stream with no body schema receives the declared `invalid_body` refusal without JSON parsing; an undeclared nonempty query receives the declared `invalid_query` refusal. An empty stream remains undefined; GET/HEAD streams are not read. Path parameters without a schema remain derived strings. **The earlier section's absent-query behavior is superseded:** only an empty query may now yield undefined. OIDC must declare its query contract and preserve the already-recorded protocol ordering; raw metadata alone is not a validation exemption.

Missing applicable validation refusals remain malformed trusted declarations, explicitly demonstrated as configuration errors500. Before migrating production routes, the parent must validate the production shape inventory for applicable invalid_query/body/json/params arms so malformed client requests consistently receive4xx. No undeclared400 fallback was added.

Fresh final scoped run: `bun test ./apps/be-01/src/http/elysia/mount.test.ts ./apps/be-01/src/http/endpoint.test.ts ./libs/contracts/src/http/refusal.test.ts` — **32 passed, 0 failed, 135 assertions**, 3 files, 1432ms; `/private/tmp/http-mount-review-final-tests.log`. Both bounded compiler configurations (`http-mount-type-probe.json`, `http-endpoint-type-probe.json`) passed after formatting, including actual production dependencies and all18 endpoint type-negative fixtures. Scoped ESLint passed for the five source/test files. No root build, broad gate or commit was run by this worker.

Review-round fault observations, all restored in `finally` before final verification; logs `/private/tmp/http-mount-review-fault-<name>.log`:

| Fault                                                       | Test / observed failure                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| later-json: restrict response alternatives to first arm     | same-status alternative matrix expected200, received500                                              |
| later-refusal: restrict refusal alternatives to first arm   | same matrix's later refusal expected400, received500                                                 |
| later-text: skip text alternatives                          | same matrix's text arm expected200, received500                                                      |
| mixed-runtime: delete incompatible-policy check             | erased-table test failed because function did not throw                                              |
| mixed-types: omit CompatibleIdentity constraint             | actual-shape fixtures reported TS2578 at observed lines126 and132                                    |
| principal-union: restore whole-policy conditional           | actual-bind fixture reported TS2578 at observed line117; narrowing also lost its precise output type |
| undeclared-body: omit absent-schema/nonempty-stream refusal | undeclared-body test expected400, received200                                                        |
| undeclared-query: omit absent-schema/nonempty-query refusal | undeclared-query test expected400, received200                                                       |

The initial review-red run had25 passing and2 failing adapter cases; the undeclared-body and query negatives then independently failed400 versus200 before implementation. No proof comment was written from a guessed diagnostic. The prior32 fault observations remain historical foundation evidence; this round adds8 restored observations against the revised implementation.

## Quiet measurement window

R10 runs in a separate worktree at 35576d79. Parent heavy checks are paused for its Chromium timing matrix. Smoke migration tests have been prepared but **not run**; no production smoke implementation was changed before observing RED. Backend-origin source review is in progress; new direct-client precondition assertions await the next focused restoration. Do not interpret prepared fixtures as passing tests.

### Inline descriptor reference boundary — 2026-09-06

Installed ArkType conversion was exercised with a recursive `node` declaration:
`toJsonSchema()` produced semantic `$ref` references. The initial inline HTTP/MCP
contract therefore explicitly refuses recursive/reference-bearing wire schemas at
both declaration and structural-descriptor emission. This is an unsupported
representation, not a reference resolver. The walker follows the schema-valued
keywords represented by the installed JsonSchema subset; it preserves literal
`$ref` property names and objects inside const/default/examples. Existing strict
request and tolerant reply behavior remains covered. No validator is inspected by
the emitter.

Fresh scoped verification:

- `bun test ./libs/contracts/src/http/schema-shape.test.ts ./libs/contracts/src/http/document-from-shapes.test.ts ./apps/mcp-01/src/shape-document.test.ts ./apps/mcp-01/src/openapi-tools.test.ts`: **51 pass, 0 fail, 280 assertions**.
- `bunx nx run-many -t typecheck --projects=contracts,mcp-01 --skip-nx-cache`: both source/spec project targets passed.
- Scoped ESLint on schema-shape, document-from-shapes and their tests plus the MCP shape-document test passed; formatting checked on the same owned paths.

Initial RED was 21 passing / 5 failing tests before implementation. The restored
faults below were observed separately after green; declaration timing is asserted
so the emitter's second boundary cannot conceal a missing declaration check.

| Injected fault                   | Production-path test                       | Observed failure                                                              |
| -------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Omit declaration reference check | MCP recursive-declaration publication      | Emission reached: expected false, received true                               |
| Bypass emitter reference checks  | MCP structural-descriptor publication      | Function did not throw; returned a tool containing unresolved tree references |
| Skip schema-map children         | Same MCP structural-descriptor publication | Function did not throw; returned the unresolved tool                          |
| Skip schema-array branches       | Emitter schema-keyword cases               | Function returned a document instead of refusing anyOf reference              |

All four faults were restored before final checks and Proof comments. Evidence
logs: `/private/tmp/http-reference-red.log`,
`/private/tmp/http-reference-fault-{declaration,emitter,nested-map,array}.log`,
`/private/tmp/http-reference-final-{tests,types}.log`.

Two fixture-only type mismatches (scoped ArkType generic and params/refusal
validator output types) were corrected before the successful final typecheck.
An earlier directory-filter Bun invocation accidentally collected generated
`dist/out-tsc` test copies and failed a copied compiler probe resolving TypeScript
from the wrong root; final verification uses explicit `./` source files and does
not count that invocation as evidence. No full backend/workspace/browser gate was
run for this bounded slice. Independent review remains pending.

## Backend request-preservation hooks — 2026-09-06

Implemented the approved design/tasks refinement before source changes. `bind` now accepts optional backend `BindingOptions<S>` with `classifyRequestFailure` and `prevalidate`; both remain restricted to the shape's declared refusal alternatives, and only prevalidation may continue with null. The shared SchemaShape and document emitter were not changed. A classifier receives failed part, generic boundary code, rejected external value, Standard Schema issues when available, and request metadata; it cannot admit or replace input. Prevalidation receives only metadata, after ordered policies and before params/query/body validation. Its response and every classified refusal pass the endpoint's normal status/body validation, including the erased callback's refusal-only check. Unexpected callback failures remain500.

Initial mounted test run was29 passed/3 failed, demonstrating missing classification, callback precedence, and hook-return validation. Final focused run after fault restoration: `bun test ./apps/be-01/src/http/elysia/mount.test.ts ./apps/be-01/src/http/endpoint.test.ts ./libs/contracts/src/http/refusal.test.ts` — **37 passed, 0 failed, 186 assertions**, 3 files, 1.65s; `/private/tmp/http-hooks-final-tests.log`. Adapter alone now has34 cases. Both bounded actual-dependency compiler configurations passed after formatting: `/private/tmp/http-hooks-final-type-fixtures.log` and `/private/tmp/http-hooks-final-types.log`. Scoped lint/format/diff results accompany the worker final report. No worker root build, broad gate or commit.

The callback test checks HEAD405/Allow and duplicate-key400 before query rejection or consumption, no cookies on those refusals, anonymous401 before prevalidation, and a subsequent valid request consuming exactly once. The held asynchronous prevalidation test checks the request stream is unread before release and remains unread after refusal. Boundary-value coverage checks params/query/body values, raw malformed JSON, issue presence/absence and request metadata. The command case is a **foundation classification control**, selecting an earlier semantic refusal when a later command fails structure; production command parsers and OIDC handlers are not yet migrated by this slice.

Eight hook faults were observed and restored in finally before Proof comments. Logs: `/private/tmp/http-hooks-fault-<name>.log`.

| Fault                   | Actual observed failure                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| no-classifier           | earlier-command semantic classification expected400, received500                           |
| no-prevalidation        | callback HEAD expected405, received400                                                     |
| late-prevalidation      | callback HEAD expected405, received400                                                     |
| before-policies         | anonymous callback HEAD expected401, received405                                           |
| successful-boundary     | broken callback returning success expected500, received200                                 |
| unvalidated-boundary    | wrong refusal status/body expected500, received429; callback Allow header was also lost    |
| classifier-success-type | widening DeclaredRefusal to HttpReply caused TS2578 at actual-bind fixture lines131 and135 |
| classifier-status-type  | widening to erased refusal caused TS2578 at actual-bind fixture line144                    |

The first formatting pass moved three type-negative diagnostics to object properties. The directives were moved to those actual diagnostic lines, the restored compiler passed, and widening faults were then observed at the corrected locations. No unrelated type error is counted as a successful proof.

## Reviewed foundation checkpoint before incoming merge — 2026-09-06

Tasks1.1–1.5 are complete at foundation scope: SchemaShape strict/tolerant conversion and unsupported-representation checks; actual-bind type negatives; ordered mounted policies; reply alternatives/status/schema/cookie validation; and the descriptor fixture through the real MCP consumer. Evidence is the foundation emitter/adapter sections, the restored32-test/135-assertion review checkpoint, the51-test/280-assertion reference-boundary run, and the37-test/186-assertion preservation-hook run above, including their observed widening and production-path faults. Independent bounded reviews approved the restored foundations. Production routes, family classifiers, generated-document replacement and frontend transport remain unchecked. Prepared smoke migration tests are not evidence of a migrated production route.

Parent completed the frozen backend source-directory suite with `env -u HEAVY_LOCK_WAIT_SECONDS bin/with-heavy-lock.sh -- bun test ./apps/be-01/src`: **1765 passed, 0 failed, 15716 assertions**,136 files,106.30s. Inspected output: `/private/tmp/wbs-http-origin-backend-full.log`. Parent also reports successful `bunx tsc --build --force apps/be-01/tsconfig.json`; its inspected diagnostic log is empty: `/private/tmp/wbs-http-foundation-be-types.log`. The source freeze manifest is `/private/tmp/wbs-http-origin-gate-manifest.json`; parent checked2126 tracked/new source file hashes before/after the backend gate. These results precede integration of bf69132d and do not establish the incoming feature's merged behavior.

Post-foundation compiler timing uses the same macOS26.5 arm64 host, existing dependency installation and sequential `bunx tsc --build --force apps/<app>/tsconfig.json` commands as the pre-generic baseline. Parent measured elapsed wall time with Python perf_counter in a quiet source freeze, two samples per app, and reported all commands successful. Inspected samples in `/private/tmp/wbs-http-typecheck-foundation.json`: backend10.628s/9.638s (mean10.133s), frontend12.016s/11.258s (mean11.637s). Both remain below doubled baseline thresholds16.774s/20.839s; the simplification trigger has not fired at foundation scope. Diagnostic logs: `/private/tmp/wbs-http-foundation-{be-01,fe-01}-{1,2}.log`; baseline host/policy/success metadata: `/private/tmp/wbs-http-typecheck-baseline.json`. Full-migration timing remains pending under task0.2.

Incoming d08a6ad6 was reviewed from source and tests, without executing upstream proofs. Design, preflight and refusal inventory now name live mismatch retention and the distinct cookie behavior, with the same public invalid-transaction refusal envelope planned across consume outcomes. Its integration and regression run remain pending. No full workspace or isolated browser gate is claimed by this checkpoint.

Documentation reconciliation checks: `bunx openspec validate http-endpoint-port --strict` reported the change valid and exited0; the CLI separately reported telemetry DNS failure for edge.openspec.dev. Prettier check passed for the five edited HTTP documents, and `git diff --check -- openspec/changes/http-endpoint-port` exited0. No source files were edited by this documentation pass.

## Smoke migration in progress after feature integration

Feature head bf69132d is integrated as034d5eb2. Parent evidence records2610 passing
backend/auth/domain/solver tests,228 Gantt tests and forced BE/FE typechecks. The
operation inventory was refreshed to40 baseline plus4 conditional OIDC operations;
marker detail/color and scheduled-slice lateBy changes are preserved requirements.

Before implementation, `bun test ./apps/be-01/src/controller/smoke.integration.test.ts`
failed3 cases and passed1 (`/private/tmp/wbs-http-smoke-red.log`): missing text returned
the legacy freeform Validation failed message instead of invalid_body; an unknown
extra object returned200 rather than400; direct `.handle` was absent on the old
route. Production smoke binding and mounting were written only after this RED.

Intentional wire rewrites: malformed/schema-invalid text becomes a stable declared
invalid_body envelope at400; extra body properties are refused rather than ignored;
malformed JSON becomes invalid_json400; undeclared query fields become invalid_query400.
Valid text remains200 `{ echoed }`. Cookie-origin403 still precedes parsing. Echo
has no semantic refusal for a validated text, so literal-handler coverage is success;
request refusals belong to the adapter and are exercised through actual app.handle.

The rendering worker owns a six-minute quiet timing window while smoke/identity/client
source is prepared. New smoke GREEN, new identity RED/GREEN, fault proofs and current
source typechecks remain pending. No claim is made from source preparation alone.

### Smoke observed faults and restoration

Initial composed GREEN exposed only a document order mismatch (21pass1fail). The
typed smoke mount now precedes legacy families, preserving the existing document
order without rewriting the committed artifact. Expanded controls passed23 tests
with100 assertions before mutations. Each fault below ran through actual app.handle
or the production binding table; every source was restored in finally.

| Fault                                               | Observed failure                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| Tolerant wrapper replaces strict smoke body         | Extra object returns200, expected400.                            |
| echoed schema widened to unknown                    | Injected invalid service representation returns200, expected500. |
| Remove smoke origin policy                          | Cookie + malformed JSON returns400, expected403.                 |
| Mount empty typed table, retain binding/declaration | Valid smoke returns404, expected200.                             |
| Remove smoke binding, retain declaration            | Binding parity receives length0, expected1.                      |

Logs: `/private/tmp/wbs-http-smoke-fault-{extra,reply,origin,mount,binding}.log`.
Proof comments were written from these inspected failures. The legacy app guard
delegates migrated method/path pairs to their own policies, making the smoke
origin policy observable rather than hidden behind a duplicate earlier guard.
Final restoration checks, independent review and task closure remain pending.

Smoke/identity combined restoration passed31 tests,0 failures,165 assertions across
5 files in1.193s (`/private/tmp/wbs-http-smoke-restored.log`): smoke.integration,
app.routes, openapi-document, origin.integration, http/elysia/identity. The first
owned lint pass found only two import-sort errors, fixed with ESLint; latest owned
lint pass is recorded below after review.

# Production endpoint identity resolver evidence

2026-09-06, bounded http-endpoint-port prerequisite. Owned production path:
`apps/be-01/src/http/identity.ts`. Parent approved moving the new integration test
from `http/identity.test.ts` to `http/elysia/identity.test.ts`: existing lint rules
forbid Elysia and adapter imports in the framework-free http directory. No lint
exception, app/controller edit, or shared verify edit belongs to this slice.

API: `identityResolver(auth, internalAuthSecret): IdentityResolver`.
User requirements delegate once to existing userFromHeaders/AuthService;
signed-in accepts any authenticated account, read/write require their own scope.
Internal requests compare only x-internal-auth to the explicitly supplied secret,
matching legacy equality semantics, and never authenticate or invent a user.
Unknown account/verifier failures reject unchanged. Origin remains the mounted
shape's independent policy, not this resolver's responsibility.

Tests use AuthService-issued password JWTs against actual fixture accounts and
cryptographically signed/verified OIDC JWTs resolved through the actual account
service. No authenticate stub returns fabricated principals. The one local-mode
case explicitly supplies localIdentity, preserving that existing composition.
Cookie separators are percent-encoded so decoding is observable; a valid cookie
beats another account's Bearer token, malformed encoding permits Bearer fallback,
a decoded but invalid cookie blocks Bearer fallback, and x-wbs-token is ignored.

Initial RED: missing module, 0 pass / 1 failure / 1 module-load error. This was a
scaffold failure, not behavioral proof. Minimal implementation then gave 8 pass /
65 assertions. The behavioral proofs below were injected after that green run,
independently and within a parent-coordinated mutation window. All were restored
before comments and subsequent checks.

| Fault                                                        | Mounted production-path case                | Observed                                                |
| ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------- |
| Disable read scope check                                     | scoped token matrix                         | expected403, received200                                |
| Disable write scope check                                    | scoped token matrix                         | expected403, received200                                |
| Bypass internal secret comparison                            | internal secret                             | expected401, received200                                |
| Return fabricated principal when authentication returns null | absent/invalid/retired credentials          | expected401, received200                                |
| Read Bearer directly instead of shared credential boundary   | cookie precedence                           | expected account ada, received grace (IDs differed too) |
| Resolve credentials twice                                    | password requirement matrix                 | expected1 authenticate call, received2                  |
| Catch account errors as null                                 | password lookup and OIDC account resolution | both expected500, received401                           |

Logs: `/private/tmp/http-identity-fault-{read-scope,write-scope,internal-secret,principal-fallback,cookie-bypass,double-auth,catch-account}.log`.

Verification at writing: identity+mount tests42 pass,245 assertions. Initial BE
source/spec typecheck found two test-only HeadersInit inference errors; arrays
were annotated, and final verification is pending the parent's brief smoke fault
restoration. No full backend/workspace/browser gate claimed.

Final restored verification completed:

- `bun test ./apps/be-01/src/http/elysia/identity.test.ts ./apps/be-01/src/http/elysia/mount.test.ts`: **42 pass,0 fail,245 assertions** (`/private/tmp/http-identity-tests.log`).
- `bunx nx typecheck be-01 --skip-nx-cache`: **passed**, source and spec references (`/private/tmp/http-identity-types.log`).
- `bunx eslint apps/be-01/src/http/identity.ts apps/be-01/src/http/elysia/identity.test.ts`: passed.
- Prettier check on both owned files: passed. `git diff --check`: passed.

No production changes after the fault-restoration notice beyond observed Proof
comments. Parent's combined smoke/app/origin/OpenAPI restoration checks and
independent review remain outside this bounded result. No commits made.

Smoke and identity independent review approved without findings. Complete backend
restoration then passed1804 tests,0 failures,17057 assertions across138 files in
106.46s: `env -u HEAVY_LOCK_WAIT_SECONDS bin/with-heavy-lock.sh -- bun test
./apps/be-01/src` (`/private/tmp/wbs-http-smoke-backend-full.log`). Owned ESLint
restoration emitted no errors (`/private/tmp/wbs-http-smoke-lint-restored.log`); strict
OpenSpec validation passed. Full workspace/browser gates and remaining production
endpoint migrations are still pending.

# HTTP client foundation evidence

Worktree: `.worktrees/refactoring`, branch `refactor/planned-project`. Ownership is confined to new `libs/contracts/src/http/client*` source/test files. No index exports, frontend callers, shared schema APIs, or active OpenSpec documents are edited by this worker.

Approved task4.1 creates operationId methods, exact shape-derived inputs and status-specific success/refusal replies. `clientFromShapes(shapes, transport)` accepts Fetch Responses or explicitly tagged normalized in-process json/text/empty replies, avoiding a backend EMPTY import. `fetchTransport(baseUrl, send)` uses an explicit base URL, preserves caller headers and AbortSignal, and sets redirect:manual so redirects remain visible when Fetch exposes them. Browser opaque manual redirects can produce status0; that is an explicit undeclared-status boundary failure, not a successful302 claim.

The result union distinguishes success, validated refusal, and typed client-boundary failure. Finite boundary codes currently cover cancellation, transport errors (preserving cause), invalid client input, undeclared status, and invalid response JSON/schema/representation. Unexpected validator failures propagate. Query values are the server adapter's string-valued field map, with undefined optional fields omitted; bodies are normalized to their actual JSON representation before strict validation, consistently for fetch and in-process transports. No request sharing/cache is introduced.

Read source before edits: approved ports plan D13/D16/D17 transport/client section; http-endpoint-port task4.1 and design; endpoint-shape/schema-shape; frontend lib/api.ts, wbs-api.ts and saved-plan-api.ts. Existing api.ts's proxy WWW-Authenticate distinction motivates preserving status and Headers on boundary failures. No frontend behavior is claimed migrated.

Initial missing-module test run:0pass1fail1error. First implementation:13pass0fail43assertions. Added cancellation-during-validation, optional query and successful-error-envelope checks:17pass3fail; fixes restored20pass0fail60assertions. Optional undefined body fields then failed before normalization, restoring21pass0fail62assertions. These are interim runtime observations only.

R10 quiet window: checks paused on request and resumed only after parent release. Trusted fetch configuration failures now propagate as ClientConfigurationError; unknown-status Fetch bodies are canceled and cleanup failures propagate; blank operation IDs reject; normalized text values are checked.

## Final scoped evidence

Quiet window released. Runtime before faults: `bun test ./libs/contracts/src/http/client.test.ts ./libs/contracts/src/http/client-types.test.ts`: 30 passed, 0 failed, 82 assertions. Bounded actual-production-client compiler fixture `/private/tmp/http-client-types.json`: exit 0. Scoped ESLint: exit 0. Final post-comment checks recorded below after execution.

24 faults were injected independently and restored after each run; all failed. Raw outputs `/private/tmp/http-client-fault-<name>.log`; structured summary `/private/tmp/http-client-fault-summary.json`. No fault remains active. Runtime faults used `bun test ./libs/contracts/src/http/client.test.ts`; type faults used `bunx tsc -p /private/tmp/http-client-types.json`.

- `request-schema`: exit 1; (fail) client request and transport boundary > validates request input before invoking transport and does not share calls [2.88ms]; (fail) client request and transport boundary > validates request input before invoking transport and does not share calls [2.88ms]
- `success-schema`: exit 1; (fail) shape-derived client response boundary > refuses a backend-only known field type change [0.36ms]; (fail) shape-derived client response boundary > awaits asynchronous validators and throws unexpected validator errors [0.33ms]
- `refusal-schema`: exit 1; (fail) shape-derived client response boundary > validates refusal at status 429 and rejects malformed details [0.45ms]; (fail) shape-derived client response boundary > validates refusal at status 503 and rejects malformed details [0.11ms]
- `async-schema`: exit 1; (fail) shape-derived client response boundary > validates an in-process response while retaining additive nested fields [1.40ms]; (fail) shape-derived client response boundary > refuses a backend-only known field type change [4.34ms]
- `success-alternatives`: exit 1; Expected: "success"; Received: "failure"
- `refusal-alternatives`: exit 1; (fail) shape-derived client response boundary > validates refusal at status 503 and rejects malformed details [0.30ms]; (fail) shape-derived client response boundary > validates refusal at status 501 and rejects malformed details [0.17ms]
- `refusal-status`: exit 1; (fail) shape-derived client response boundary > refuses undeclared statuses and mismatched refusal status/body pairs [0.51ms]; (fail) refuses a successful refusal envelope even with a permissive success schema [3.58ms]
- `blank-id`: exit 1; (fail) rejects blank operation identifiers consistently with shape document emission [3.51ms]; (fail) rejects blank operation identifiers consistently with shape document emission [3.51ms]
- `duplicate-id`: exit 1; (fail) client request and transport boundary > refuses duplicate operation identifiers instead of replacing a method [0.23ms]; (fail) client request and transport boundary > refuses duplicate operation identifiers instead of replacing a method [0.23ms]
- `params`: exit 1; (fail) refuses missing, extra and URL dot-segment params before transport [0.65ms]; (fail) refuses missing, extra and URL dot-segment params before transport [0.65ms]
- `path-encoding`: exit 1; Expected: "https://example.test/project%20notes/a%2Fb%20%3F%23?filter=x%26y"; Received: "https://example.test/project%20notes/a/b%20?filter=x%26y#"
- `body-normalization`: exit 1; Expected: "success"; Received: "failure"
- `undefined-body`: exit 1; (fail) reports non-JSON client bodies before transport without hiding unexpected serialization failures [1.76ms]; (fail) reports non-JSON client bodies before transport without hiding unexpected serialization failures [1.76ms]
- `cancellation`: exit 1; Expected: false; Received: true
- `success-envelope`: exit 1; (fail) refuses a successful refusal envelope even with a permissive success schema [2.02ms]; (fail) refuses a successful refusal envelope even with a permissive success schema [2.02ms]
- `text-type`: exit 1; (fail) rejects malformed normalized text before returning a typed text success [0.45ms]; (fail) rejects malformed normalized text before returning a typed text success [0.45ms]
- `configuration`: exit 1; (fail) preserves transport encoding failures when a composed transport corrupts validated input [0.45ms]; (fail) throws for a trusted query declaration that cannot be represented on the wire [1.26ms]
- `cleanup`: exit 1; Expected: true; Received: false
- `serialization-errors`: exit 1; (fail) reports non-JSON client bodies before transport without hiding unexpected serialization failures [1.85ms]; (fail) reports non-JSON client bodies before transport without hiding unexpected serialization failures [1.85ms]
- `params-type`: exit 2; libs/contracts/src/http/client-types.test.ts(54,3): error TS2578: Unused '@ts-expect-error' directive.
- `body-type`: exit 2; libs/contracts/src/http/client-types.test.ts(60,3): error TS2578: Unused '@ts-expect-error' directive.; libs/contracts/src/http/client.test.ts(248,38): error TS2345: Argument of type '{ params: { id: string; }; body: { name: string; extra: boolean; }; }' is not assignable to parameter of type 'ClientInput<{ readonly method: "POST"; readonly path: "/projects/:id"; readonly operationId: "writeProject"; readonly policies: readonly []; readonly body: SchemaShape<{ name: string; }>; readonly responses: readonly [...]; readonly refusals: readonly []; readonly document: { ...; }; }>'.
- `query-type`: exit 2; libs/contracts/src/http/client-types.test.ts(56,3): error TS2578: Unused '@ts-expect-error' directive.; libs/contracts/src/http/client.test.ts(449,57): error TS2322: Type 'undefined' is not assignable to type 'string'.
- `response-type`: exit 2; libs/contracts/src/http/client-types.test.ts(69,5): error TS2578: Unused '@ts-expect-error' directive.; libs/contracts/src/http/client.test.ts(72,32): error TS2769: No overload matches this call.
- `status-type`: exit 2; libs/contracts/src/http/client-types.test.ts(72,47): error TS2339: Property 'supported' does not exist on type '{ error: "rate_limited"; } | { error: "unsupported_body_version"; savedPlanId: string; body: "input"; version: number; supported: number[]; }'.; libs/contracts/src/http/client-types.test.ts(93,3): error TS2578: Unused '@ts-expect-error' directive.

The success-validator bypass also timed out the held-validator case because that dependency was deliberately bypassed; its known-field assertion failed immediately and is the validation proof. Type proofs explicitly observed TS2578 on negative fixtures, not merely unrelated compiler errors. No frontend caller migration, exports, whole-workspace gate, browser run, or integration review is claimed. Parent owns those follow-up steps.

Final restored post-format/comment verification: runtime 30 passed / 0 failed / 82 assertions (199ms), bounded actual-client source plus type-fixture compile exit 0, scoped ESLint exit 0. Logs `/private/tmp/http-client-final-{tests,types,lint}.log`. All six new client files are frozen and released for independent review; no commits or index exports.

Independent client review approved without findings and re-ran30 tests/82assertions
and the actual-client type fixture. Parent exported the reviewed client functions
and types from the contracts barrel; FE caller conversion remains task4.2.

History migration runs independently beside step after the same completed foundation.
Its RED passed6 existing cases and failed2: unknown query returned200 instead of400;
the old route had no typed handle (`/private/tmp/wbs-http-history-red.log`). The new
shape preserves opaque historical before/after JSON while validating event metadata.
Legacy OpenAPI output loses migrated per-route metadata until task3.2 publishes from
shapes; its freshness/metadata checks are explicitly pending during this transition.
The shared emitter's metadata tests remain required for each migrated family.

### History migration checkpoint

Initial expanded control had one test-fixture scoping failure (events was local to
beforeEach); the held fixture is now explicit in describe scope. Restored controls
passed10 tests before five fault injections, all restored in finally:

| Fault                                 | Observed failure                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Tolerant history query                | Unknown query returns200, expected400.                                          |
| Omit query declaration                | Emitted parameter list loses kind and workItemId.                               |
| Split kinds on semicolon              | Filter returns[] instead of[cleared,set].                                       |
| Missing project becomes empty success | Literal handler returns200/events instead of404/error.                          |
| Narrow historical before to string    | Historical JSON case fails in response.json: SyntaxError: Failed to parse JSON. |

Logs `/private/tmp/wbs-http-history-fault-{strict,query,filter,refusal,historical}.log`.
The last failure occurs before the status assertion because the helper reads JSON
first; it is not recorded as an observed status assertion. All sources restored.
Independent history/step source review approved without findings. The restored
combined history and step run passed 65 tests / 284 assertions, and fresh contracts
plus be-01 source/spec typechecks passed. The production OpenAPI check remains
intentionally red until task 3.2 replaces the transitional legacy publisher: its
freshness comparison differs and its old hand-written step-body metadata is absent
(`/private/tmp/wbs-http-incremental-openapi.log`).

# Step shape migration evidence

2026-09-06, bounded task2.2 within http-endpoint-port. Owned paths:

- libs/contracts/src/http/step-shapes.ts and step-shapes.test.ts
- apps/be-01/src/controller/step.routes.ts and step.routes.test.ts
- apps/be-01/src/controller/step.controller.db.test.ts

Parent owns barrel/shape registry/app mount/committed OpenAPI integration.
Adapter media preservation belongs to audit_migration. No shared verify edit or
commit made by this worker.

Exports addStep/renameStep/removeStep retain the exact committed operationIds.
stepRoutes(steps) returns a const tuple of typed bindings; AuthService no longer
belongs to the handler factory. Service name trimming and name_required422,
not_found404, forbidden403, taken409, full in_use409 payload and empty204 remain.
Origin then write-scope runs before parsing, with a single authenticated account
resolution. Missing or malformed name shapes remain422; malformed JSON gets the
approved400 invalid_json envelope. Unknown bodies/query fields are now strict,
with actual SQLite writes/retained rows checked by the controller suite.

Legacy cascade characterization used real legacy bindings and StepService with
memory usage fixtures: repeated values are last-value-wins. New real SQLite
regression pins true&false409 and retains usage, false&true204 deletes. No invented
duplicate guard. Literal cascade1 remains unconfirmed, not a Boolean conversion.

Initial wire RED after correcting a fixture-scope mistake:1 pass,3 fail,22
assertions. Repeated-cascade passed; extra name body was200 instead of422,
unknown query deleted with204 instead of400, malformed JSON had a non-JSON legacy
envelope. Direct binding tests initially failed because the legacy handlers have
no typed handle member;3 descriptor tests passed,4 direct cases failed. New bindings
then produced30 passing direct/shape/controller tests,167 assertions.

Type investigation: broad `never` inference initially obscured an incompatible
Refusal code union. Explicit type arguments exposed forbidden and name_required
being combined with codes lacking their closed context variants. Separate schema
arms fixed the real issue; ordinary defineEndpointShape inference works, with no
foundation change or generic/cast workaround retained. Scoped ESLint then passed.

Observed step-only faults, all restored in finally before Proof comments:

| Fault                                | Production-path case                  | Observed                                            |
| ------------------------------------ | ------------------------------------- | --------------------------------------------------- |
| Tolerant name wrapper                | undeclared name body controller case  | expected422, received200                            |
| Tolerant cascade query wrapper       | unknown cascade query controller case | expected400, received204                            |
| Remove origin policy                 | mounted step policy ordering          | expected403, received400                            |
| Weaken write-scope to signed-in      | same ordering case, scoped account    | expected403, received400                            |
| Boolean cascade conversion           | existing cascade1 refusal             | expected409, received204                            |
| Omit measures from usage reply       | mounted full usage refusal            | expected409, received500                            |
| Catch add-store outage as not_found  | direct binding unknown-failure case   | expected original Error, received modeled404 object |
| Use first raw repeated cascade value | true&false DB regression              | expected409, received204                            |

Fault logs `/private/tmp/step-fault-{name-strictness,query-strictness,origin,write-scope,cascade-truthiness,usage-field,unknown-catch,first-cascade}.log`.

Media compatibility is required, not silently waived. Legacy JSON, URL-encoded and
multipart name writes all returned200 with trimmed names. Existing advertised forms
are actually used by the route parser, not merely documentation. Three new real
controller form tests currently RED against JSON-only adapter: valid forms on both
writes, duplicate/unknown fields, and File name. Duplicates/files must remain422
invalid_body; unknown fields intentionally become strict422. Adapter owner is
implementing preservation; final source/types/scoped regression evidence pending.

No full backend/workspace/browser gate claimed. Committed OpenAPI parity is pending
parent's document migration and must not be described as passing from these tests.

Media restoration landed from adapter owner: all three real form cases now pass,
including URL-encoded/multipart POST and PATCH, duplicate fields, unknown fields
and file-valued names. No step-specific decoder or duplicate guard was added.
The shared adapter owns those semantics; its additional injected decoder faults
are recorded by that owner rather than attributed to this slice.

Final test typing was corrected without changing production contracts: Bun's
strict equality matcher could not correlate status/error tuples across the case
matrix, so each awaited reply is compared as an unknown runtime envelope while
the actual binding call remains fully typed. The nullable store read comparison
was reversed so its expected value is non-null. No casts or foundation weakening
were needed. Scoped ESLint passed on all five owned files after that change.

Final restored checks:

- `bun test ./libs/contracts/src/http/step-shapes.test.ts ./apps/be-01/src/controller/step.routes.test.ts ./apps/be-01/src/controller/step.controller.db.test.ts ./apps/be-01/src/service/step.service.db.test.ts`: **55 pass, 0 fail, 264 assertions** (`/private/tmp/step-final-tests.log`).
- `bunx nx run-many -t typecheck --projects=contracts,be-01 --skip-nx-cache`: **both passed**, including BE source/spec references (`/private/tmp/step-final-types.log`).
- Scoped ESLint on all five owned files: passed.
- Prettier check on all five owned files: passed. `git diff --check`: passed.

Held for independent review, no commit. Parent app/registry migration is integrated
in these runs; whole generated OpenAPI/whole workspace/browser gates remain
pending parent-owned migration/checkpoints and are not implied by this result.

# HTTP adapter media preservation evidence

Ownership: apps/be-01/src/http/elysia/{mount.ts,mount.test.ts,form.ts}. No shared contracts, emitter, production step bindings, or active verify.md edited. Parent approved preserving legacy declared-body JSON, URL encoded, and multipart media without a new shape API. Unknown-field rejection remains the approved strictness change.

Read-first compatibility probe: step-media/report.md and observations.json. Valid form POST/PATCH historically 200; pre-fix mounted forms were 400 invalid_json. Adapter RED: `bun test ./apps/be-01/src/http/elysia/mount.test.ts` produced 35 pass / 2 fail, valid form expected200/received400 and malformed multipart expected invalid_body/received invalid_json. Queue independently observed three actual-step form RED tests.

Implementation reads request.arrayBuffer once after policies and metadata prevalidation. Byte buffering keeps multipart files intact and separates stream failures from syntax errors. Declared form bodies decode before the same strict schema; duplicate fields become arrays, Files stay Files, unknown fields stay present for refusal. No input coercion or unknown-field deletion. Undeclared nonempty bodies still invalid_body. JSON SyntaxError remains invalid_json. URLSearchParams implements the existing forgiving URL-encoded decoder; malformed multipart maps to declared invalid_body. Other content types retain the previous JSON-decoding behavior.

Bun parser boundary measured directly: malformed `multipart/form-data` without boundary throws TypeError `Can't decode form data from body because of incorrect MIME type/boundary`; broken bytes with boundary=abc throw TypeError `FormData parse error missing final boundary`. Helper catches the exact first message or Bun's `FormData parse error ` syntax family; every other error propagates. Mounted tests inject generic TypeError parser unavailable and a stream TypeError; both produce500. This is deliberately Bun-specific runtime knowledge, documented on decodeForm. A runtime update changing syntax-error messages will fail the malformed request tests rather than silently broaden the catch.

Scoped restored mount runtime: 37 passed / 0 failed / 210 assertions. Final output /private/tmp/step-adapter-media-final.log. Scoped eslint command explicitly covers all three owned files; output /private/tmp/step-adapter-media-lint.log. Initial bounded compiler found test-only RequestInit.duplex unsupported; removed that unnecessary property. Queue owns the combined contracts/backend source+spec compile after source release; no whole gates run by this worker.

Six independent faults were observed and restored. Commands: `bun test ./apps/be-01/src/http/elysia/mount.test.ts`; logs /private/tmp/step-media-fault-<name>.log, summary /private/tmp/step-media-fault-summary.json.

- media-disabled: exit 1; Expected: 200; Received: 400; (fail) decodes declared URL encoded and multipart bodies without coercing or dropping fields [2.19ms]
- duplicates-flattened: exit 1; Expected: 400; Received: 200; (fail) decodes declared URL encoded and multipart bodies without coercing or dropping fields [4.03ms]
- files-coerced: exit 1; Expected: 400; Received: 200; (fail) decodes declared URL encoded and multipart bodies without coercing or dropping fields [5.92ms]
- malformed-unmodeled: exit 1; Expected: 400; Received: 500; (fail) models malformed multipart syntax but preserves unexpected parser and stream failures [2.29ms]
- parser-errors-hidden: exit 1; Expected: 500; Received: 400; (fail) models malformed multipart syntax but preserves unexpected parser and stream failures [3.35ms]
- strict-body-bypassed: exit 1; Expected: 400; Received: 500; (fail) endpoint request and response boundaries > refuses unknown nested request fields and malformed JSON with declared envelopes [3.30ms]

Proof comments were added only after those observations. The schema-bypass fault also exercises existing nested-request/async validation checks; source restoration precedes queue integration checks. Policies and metadata refusals leave multipart Request.bodyUsed false. No full-workspace/browser run or completed emitter media update is claimed; parent owns document consistency and independent review.

## Explicit declaration revision after review

Additional legacy probe: 126 requests total, /private/tmp/step-media-extended.json. For missing Content-Type (header explicitly deleted), text/plain, application/x-custom and application/octet-stream, both valid JSON name and invalid `{` returned legacy422 invalid_body. JSON sniffing in the first adapter therefore broadened accepted input; it is now removed.

EndpointShape.bodyMedia is an optional nonempty tuple of the three supported media literals. Default is JSON when a body schema exists. Declaring media without a body schema fails the actual defineEndpointShape type boundary and runtime erased-table consumers. bodyMediaFor is shared by mount, emitter and JSON fetch transport; document content contains exactly the resolved media and one identical inline schema per media. Parent marks proven step/name and smoke/text shapes with all three media. Missing/unsupported request media maps through the endpoint's existing invalid_body refusal. JSON client requests against form-only declarations throw ClientConfigurationError before sending.

Saved-plan save's optional/empty body semantics are a required later inventory item. This slice does not invent optional-body schema emission or change its still-legacy binding; current shape emitter always declares required bodies. Parent must settle that model before migrating that endpoint.

Additional watched faults (all restored):

- selection: exit 1; Expected: 400; Received: 200; (fail) refuses missing or undeclared body media without guessing JSON from the bytes [4.04ms]
- emission: exit 1; (fail) declares exactly the accepted body media while retaining one inline schema [2.04ms]; (fail) declares exactly the accepted body media while retaining one inline schema [2.04ms]
- client-json: exit 1; (fail) refuses JSON fetch configuration for a form-only declaration before sending [0.26ms]; (fail) refuses JSON fetch configuration for a form-only declaration before sending [0.26ms]
- nonempty: exit 1; (fail) refuses malformed erased body media declarations before emitting a document [1.44ms]; (fail) rejects malformed erased media configuration when mounting [0.46ms]; (fail) refuses malformed erased body media declarations before emitting a document [1.44ms]
- body-required: exit 1; (fail) refuses malformed erased body media declarations before emitting a document [0.34ms]; (fail) rejects malformed erased media configuration when mounting [0.48ms]; (fail) refuses malformed erased body media declarations before emitting a document [0.34ms]
- known-media: exit 1; (fail) refuses malformed erased body media declarations before emitting a document [0.42ms]; (fail) rejects malformed erased media configuration when mounting [0.50ms]; (fail) refuses malformed erased body media declarations before emitting a document [0.42ms]
- declaration-seat: exit 1; (fail) refuses malformed erased body media declarations before emitting a document [0.31ms]; (fail) refuses malformed erased body media declarations before emitting a document [0.31ms]
- mount-seat: exit 1; (fail) rejects malformed erased media configuration when mounting [0.45ms]; (fail) rejects malformed erased media configuration when mounting [0.45ms]
- media-types: exit 2; libs/contracts/src/http/document-from-shapes.test.ts(293,3): error TS2578: Unused '@ts-expect-error' directive.; libs/contracts/src/http/document-from-shapes.test.ts(295,3): error TS2578: Unused '@ts-expect-error' directive.
- body-types: exit 2; libs/contracts/src/http/document-from-shapes.test.ts(299,3): error TS2578: Unused '@ts-expect-error' directive.

Final runtime `bun test ./libs/contracts/src/http/document-from-shapes.test.ts ./libs/contracts/src/http/client.test.ts ./apps/be-01/src/http/elysia/mount.test.ts`: 84 passed / 0 failed / 375 assertions. Scoped lint all eight owned files exit0. Bounded compile /private/tmp/body-media-types.json includes actual mount, client and document fixtures with production dependencies; final result recorded after test-only indexed property access fix. Logs /private/tmp/body-media-final{,-types,-lint}.log. Initial compile exposed TS4111 in new emitter test, corrected to indexed [post] access. No broad gate or regenerated production document claimed.

Final bounded compile after indexed-access correction: exit0. All media source files are frozen for independent review.

### Directory reads checkpoint

The six global directory reads now use typed shapes and bindings with their existing
operation IDs and signed-in policy. Teams require `serviceIds`; people require
`kind` and `teamIds`; all response declarations tolerate additive audit fields.
The restored scoped run passed 36 tests / 116 assertions. Nine production-path
faults were observed and restored: missing identity, tolerant query admission,
missing binding, four missing or widened row fields, swallowed store failure, and
strict response additions. Exact commands and failures are recorded in
`.superpowers/sdd/2026-09-02-refactoring-plan/directory-evidence.md`.

Independent source/evidence review approved all six declarations, handlers, app
wiring, producer fields, strict query behavior, response tolerance and outage
propagation. GET bodies cannot be constructed through the standard `Request` API,
so this slice does not claim a separate raw-socket body rejection proof. Fresh
root typechecks and broader integration remain parent-owned.

### Solution lookup checkpoint

The solution lookup now binds `getPlansBy-solutionBySlug` through a shared shape
and a reusable complete `projectWithSteps` response declaration. The response
requires every current `Project` and `Step` field, validates the closed scheduling
vocabularies, and retains additive response fields. Read scope, exact slug
forwarding, not-found behavior and unknown store failures are preserved.

The restored scoped run passed 39 tests / 140 assertions. Eight faults were
observed and restored: weakened read scope, lost slug forwarding, missing
`depReach`, swallowed store failure, tolerant query admission, strict response
additions, missing binding and missing slug descriptor. Exact failures are in
`.superpowers/sdd/2026-09-02-refactoring-plan/solution-evidence.md`. Parent review
found no source discrepancy.

### Saved-plan checkpoint

All six saved-plan operations now use typed shapes and bindings. Save retains its
required object with optional non-empty name; rename requires a non-empty name.
Compare preserves last-value query behavior, optional side-specific not-found
detail, opaque differences, corrupt-plan detail, quota409, snapshot-busy503 and
unsupported-version501. Only the SavedPlanService operation is inside the version
catch; project lookups and post-commit announcements still propagate unexpected
failures as500.

The final saved-plan run passed 49 tests / 191 assertions. Nineteen original
faults were observed and restored. Independent review then reproduced three more
faults against the reviewed source: project and announcement version-shaped
errors were501 instead of500, and a numeric comparison `savedPlanId` was admitted
as404 instead of failing response validation500. The narrowed service-call catch
and single optional-string404 schema fixed all three; the reviewer reran49/191
and approved without Important/Critical findings. Exact evidence is in
`.superpowers/sdd/2026-09-02-refactoring-plan/saved-plan-evidence.md` and
`saved-plan-independent-review.md`.

### Internal protocol checkpoint

Forward and resume now use typed internal-identity bindings. Identity runs before
parsing; forward payloads and trace/context headers remain opaque; resume retains
both record and legacy numeric-array cursor forms, including fractional values
and -1. Callback and validator failures remain unexpected500s. Response schemas
validate finite replay points, denial reasons and the surrounding event envelope
without narrowing historical message JSON.

The restored internal run passed 39 tests / 100 assertions. Eleven production
faults were observed and restored. The ordered-schema boundary's type proof
separately widened its inferred output to unknown and observed TS2578 at the
consumer before restoration; the identical bounded compiler then passed. Exact
evidence is in `.superpowers/sdd/2026-09-02-refactoring-plan/internal-evidence.md`.

### Combined migration checkpoint

After source freeze, `bunx nx run-many -t typecheck --projects=contracts,be-01
--skip-nx-cache` passed both projects. The explicit 27-file contracts/backend run
passed 294 tests / 1266 assertions. It includes the client, schema/emitter/media,
directory, history, internal, saved-plan, solution and step boundaries plus their
mounted controller paths. A stale legacy-route inventory case initially expected
saved-plan compare in `mountedRouteLists`; compare now lives in the typed endpoint
table, whose exact one-binding parity test passed, so the obsolete legacy-only
preflight assertion was removed rather than replaced with an empty check.

Generated committed OpenAPI parity, the full workspace gate and browser gate are
still pending. The existing OpenAPI failure remains the declared task3.2
transition and is not counted as green here.

### Project, work-item and calendar-marker checkpoint

Tasks 2.3, 2.7 and 2.7a are frozen after feature-first integration at merge
commit `4dec2ab8`. Work-item has five typed endpoints, project has six, and
calendar markers have four. The app/shape registry binds each family once.

Work-item's final owned run passed **262 tests / 1079 assertions** across 13
files. Its bounded source/spec compiler, 16-file lint and format checks passed.
The independent review found that create/duplicate producers could erase their
kind before proving a required minted id. All seven minting kinds now require
and validate that id; removing the runtime guard returned 200 instead of the
expected 500, and widening the internal variants produced two TS2578 failures.
The exact parser, producer, deadline, transaction and undo fault table is in
`.superpowers/sdd/2026-09-02-refactoring-plan/work-item-http-evidence.md`.

Calendar-marker's restored run passed **79 tests / 383 assertions**; the final
shape/MCP/Elysia consumer run passed **5 tests / 54 assertions**. FE API and
Gantt passed **275** cases plus the Auckland zoned case. Contracts, backend and
MCP bounded compilers, scoped lint and formatting passed. Twelve fault variants
were observed and restored. Independent review found tolerant bare 404/409
schemas accepting malformed known `field` values; the corrected single
optional-`markerId` variants fail malformed replies at the response boundary.

Project plus its shared Elysia adapter passed **95 tests / 499 assertions**.
The related settings/optimizer/capacity/priority run passed **23 tests / 82
assertions**. Nineteen owner faults were restored. Independent review then
measured one deliberate strict-boundary correction: legacy
`application/octet-stream` PATCH bytes became an empty object, returned 200 and
called `update({})`; the typed boundary returns 422 and makes no call. The new
production regression failed with expected 422/received 200 when the adapter
was faulted to recreate that empty object, then passed after restoration.

The frozen combined 26-file run passed **395 tests / 1709 assertions**. Fresh
Nx typecheck passed for contracts, be-01, mcp-01 and fe-01; fresh Nx lint passed
for contracts, be-01 and mcp-01. Generated OpenAPI parity, auth migration, the
full workspace gate and isolated browser gate remain pending and are not
claimed by this checkpoint.

### Authentication checkpoint

Password register, login and session reads now use three typed bindings in both
local and OIDC compositions. OIDC adds four typed bindings only when provider
options exist. The callback declares an open string query map while the adapter
refuses every repeated raw key before query collapse, validation or transaction
consumption. The production app supplies its logger before constructing the
OIDC bindings. No auth route remains mounted through the legacy route-list
adapter.

The restored auth/config/app run passed **201 tests / 1039 assertions** across
16 files. It covers local and OIDC boot, both direct binding families, mounted
transport, origin ordering, password admission, callback recovery, repository
identity linking and generated query representation. Independent review then
passed **87 tests / 504 assertions** and approved the seven-route migration with
no Important or Critical finding. `bunx nx run-many -t typecheck
--projects=contracts,be-01 --skip-nx-cache` and the matching lint command passed.
`env OPENSPEC_TELEMETRY=0 bunx openspec validate http-endpoint-port --strict
--json` reported one valid change and zero issues.

The intentional envelope revision is explicit. Callback invalid-transaction and
blank-error 400 answers now carry `{ error: 'invalid_oidc_callback' }`; callback
exchange, missing-claim and refresh 401 answers carry
`{ error: 'invalid_oidc_session' }`; account conflict 409 carries
`{ error: 'oidc_identity_conflict' }`. Missing binding, missing transaction,
expired transaction and live state mismatch expose the same public 400 body;
their cookie retention/clearing behavior remains distinct. Redirect 302 and
session 204 answers remain bodyless through `EMPTY`, with ordered repeated
`Set-Cookie` headers.

Thirty-four production-path faults were observed and restored before this
checkpoint: four open-query declaration/duplicate faults; eleven password
origin, strict-body, mode, proxy, throttle, capacity-release, cookie and store
failure faults; sixteen OIDC method, cardinality, transaction, provider,
logging, catch-scope, cookie, rotation, callback-origin and logout-order faults;
one omitted OIDC composition; and two same-status invalid-transaction body
substitutions. The composition fault made `app.routes.test.ts` receive 38
bindings instead of 42. The two envelope substitutions each returned
`invalid_query` where the mounted test required `invalid_oidc_callback`, proving
the absent-binding and missing/expired-transaction branches separately.

### Generated document and exact binding checkpoint

Tasks 3.1–3.3 are complete. The production app derives its published OpenAPI
document from the exact endpoint table it mounts: local mode published 38 at
this historical checkpoint and excluded the four unavailable OIDC operations;
OIDC mode published 42. The exact-binding test and real `app.handle` reachability
fixtures distinguish each route from a generic 404. Their restored run passed
**3 tests / 326 assertions** after separately observing an omitted binding and
an omitted mount.

The full shared descriptor registry remains the source for the build artifact
and MCP tools. The MCP suite pins 32 public tool names while 36 command
descriptions come from their shapes. Its primary restored run passed **139 tests
/ 592 assertions** after seven descriptor/tool faults. Independent review found
two further production gaps: local OpenAPI advertised four unmounted OIDC
operations (**expected 38, received 42**) and the backend build emitted no
`openapi.json` (**expected the emitter command, received no command list**).
Both faults were observed before correction. The local document now receives the
mounted shapes, and the sequential backend build emits
`dist/apps/be-01/openapi.json`; the corrected document/build/app run passed **9
tests / 342 assertions**. Independent review then passed its **10 tests / 23
assertions** and found no Important or Critical issue. Detailed records are in
`.superpowers/sdd/2026-09-02-refactoring-plan/generated-document-evidence.md`.

The committed generated document, legacy binders, route-owned body/query/schema
documentation and duplicated plan command declaration are deleted. Direct
`@elysiajs/openapi` and `@sinclair/typebox` dependencies are removed. The backend
build passed and emitted `main.js` plus a 42-operation generated document at
this historical checkpoint; MCP
and frontend builds also passed. Fresh contracts tests passed **342 tests / 942
assertions** and the MCP suite passed **113 tests / 444 assertions**.

The broad source checks passed for contracts, backend, MCP and frontend:
typecheck and lint were green, with the existing frontend exhaustive-deps
warning unchanged. The full frontend unit gate passed **2372 tests** in UTC and
**3 tests** in Auckland. Integration of the newer WBS API feature exposed a
stale tier manifest (**expected 93 DOM-free suites, received 92**); adding the
now DOM-free suite restored its focused **47-test** run. The frontend session
client slice itself passed **99 tests** after five restored production faults.

The unrestricted backend gate passed **1860 tests / 19016 assertions** across
154 files in 127.91 seconds. Its first unrestricted run passed 1859 and timed out
one service-wiring case at five seconds while the suite was contended; that file
then passed **4/4** in 7.76 seconds, including the timed-out case in 140 ms, and
the unchanged full rerun passed. The initial sandboxed run's 13 listener errors
were environment refusals, resolved by the unrestricted run. Health/metrics,
callerGuard removal, browser isolation and the frozen workspace gate were
completed in later checkpoints and are recorded in the final gate section above.
