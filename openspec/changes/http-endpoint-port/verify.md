# Verification Report — implementation in progress

Change: http-endpoint-port. Promoted with the OpenSpec CLI after frozen checkpoint gates. Initial source inventories are historical preflight records; the implementation sections below record fresh checks and observed faults. No full migration, full gate, or archive is claimed.

## Structural validation and task completion

CLI promotion completed (sdd-lean); apply instructions captured in `/private/tmp/wbs-http-apply.json`. Task completion is updated only after its named evidence and review. No specs synced or change archived. Capability overlap remains under reconciliation. Local template's historical no-CI statement is stale; use current config/LLM_README gate requirements.

## Before/after typecheck timing

| Target            | Before generic edits             | After foundation | After full migration | Commands/host/cache/samples                                                           |
| ----------------- | -------------------------------- | ---------------- | -------------------- | ------------------------------------------------------------------------------------- |
| be-01 source+spec | 8.409s / 8.365s; mean 8.387s     | pending          | pending              | `bunx tsc --build --force apps/be-01/tsconfig.json`; quiet local host, forced rebuild |
| fe-01 source+spec | 10.525s / 10.314s; mean 10.4195s | pending          | pending              | `bunx tsc --build --force apps/fe-01/tsconfig.json`; same window                      |

Do not substitute tiny preflight type probes or a concurrent gate's duration. Record comparable wall times; a doubled time triggers the normative PrincipalOf nullable/runtime fallback while ParamsOf remains.

## Failure-proof table

This initial matrix is a migration checklist; observed foundation faults are recorded in the implementation sections below. Rows still marked pending do not claim observation. Add exact production file/line, test name, diagnostic/assertion, restoration command and output during implementation; write Proof comments only then.

| Check                 | Named injected fault                                        | Production-path test                                     | Result                                       |
| --------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| literal typed handler | widen path/policy/reply or mismatched params schema         | actual bind type fixtures and source/spec target         | pending                                      |
| preparse identity     | delete policy / move after parser                           | app.handle malformed read-token write requires403        | pending; preflight late-parser output was400 |
| cookie origin         | delete project POST origin policy                           | foreign cookie write stays absent                        | pending                                      |
| strict nested input   | use shallow reject or delete extras                         | adapter derived-number/nested-command case               | pending                                      |
| faithful descriptor   | drop nested arm/property; fallback unconstrained conversion | declaration/emitter/MCP tests                            | pending                                      |
| reply status/body     | map429/503/501 to400; bypass validator                      | adapter and client status matrix                         | pending                                      |
| representation        | null treated EMPTY; cookie append replaced                  | real response null/204/302/text/getSetCookie             | pending                                      |
| binding completeness  | add shape without endpoint                                  | binding inventory                                        | pending                                      |
| mounted completeness  | skip mount while retaining shape                            | app.handle reachability                                  | pending                                      |
| MCP identity          | remove operationId                                          | tool derivation                                          | pending                                      |
| frontend typing       | rename shape response field                                 | actual screen's fe typecheck                             | pending                                      |
| additive tolerance    | response deep reject                                        | previous client renders added nested fields              | pending                                      |
| R1 generations/scopes | URL-only old GET sharing; lose pending scope                | held response and overlapping refresh production callers | pending migration rerun                      |
| R3 store failure      | move account resolution inside broad catch                  | auth/oidc valid token with store throw                   | pending migration rerun                      |
| R5 admission          | reserve after verification; omit release/global cap         | held verification production login requests              | pending migration rerun                      |

## Intentional wire assertion rewrites

Every actual changed assertion must be recorded with filename/test name, old response, new response, reason and passing run. Initial expected changes, not a claim of completed inventory:

| Existing behavior                                                 | Intended assertion                           | Status                  |
| ----------------------------------------------------------------- | -------------------------------------------- | ----------------------- |
| Smoke freeform validator-message error                            | named Refusal validation envelope            | pending exact test      |
| Extra body keys ignored/stripped, including name/settings objects | explicit refusal, no mutation                | pending exact tests     |
| Nested command extra keys tolerated                               | deep refusal retaining derived-field codes   | pending exact tests     |
| Framework compare-query validation report                         | shared Refusal envelope with declared status | pending exact test      |
| Unchecked/handwritten FE error payload                            | status-specific parsed Refusal/code detail   | pending exact consumers |

Preservation assertions must not be rewritten merely to get green: 501 future saved-plan version, 503 contention, 429 admission, R1 held-response windows, R3 unexpected failures and R5 active reservation/global limits. The saved-plan test at controller/saved-plan.controller.db.test.ts:434–471 explains and asserts 501 versus422; no new execution is claimed.

## Fetched feature/fix evidence update

Read git show4051512c,39e53dda,a91f831b only; no merged-tree inventory or tests. ../http-operations.md is explicitly pre-integration. Regenerate after parent integrates, including calendar-marker family and all conditional OIDC operations. Preserve landed405 method_not_allowed + Allow as well as501; update normative sketch after freeze. Add observed-fault rows during migration for arrived-method substitution, duplicate-key flattening/state-only guard, canceled-login exchange, log/description leakage, markerId MCP collision and marker semantic/isolation checks. Add exact wire rewrite rows for marker PATCH ignored-extra fields becoming refusals and OIDC bodiless400/401 becoming declared envelopes. New feature source ports are queued for Wave2, not extracted here.

## Evidence questions resolvable from the repository

1. Which exact command/parser codes and detail fields reach HTTP today? plan-commands.ts reason:string loses the union; trace constructors and every service outcome, including capacity/priority/undo, before closing RefusalCode. Which existing OpenSpec requirements need MODIFIED deltas rather than only the new capability?
2. What is the complete mounted shape set in password-only and OIDC-enabled configurations? Actual auth.routes additionally declares GET /api/auth/login, GET /api/auth/okta/callback, POST /api/auth/refresh and POST /api/auth/logout. Inventory their headers/query/body requirements and feature-mode behavior from app.ts composition and oidc.integration.test.ts; committed OpenAPI omits them.
3. What operationIds should new OIDC operations use, and which current tool names are asserted by MCP callers/tests? Keep the existing documented names where applicable; assign explicit new literals and pin them, never infer silently at runtime.
4. Which explicit direct dependency should provide StandardSchema types, and which MCP OpenAPI3.1 typing changes are needed? Resolve installed package exports/package.json and lockfile, using preflight conversion results; no dependency install during freeze.
5. Which build/emitter/tool consumers reference committed openapi.json or removed plugins? Enumerate actual imports/project targets/scripts before deletion. Which legacy body parser helpers still have domain-validation callers after schemas move?
6. Which R1 tests/commit become the mandatory FE migration baseline, and what exact clean host/command window provides comparable be/fe typecheck timing? Parent ownership ledger and completed R1 artifacts answer these; no user permission question is needed.

Resolved completeness correction: parent approved preserving existing501 unsupported_body_version and extending the normative status sketch after freeze. It is no longer an open question.

## Gate output

Pending all scoped tests, type negatives, fault restorations, contracts/backend/frontend/MCP source+spec typechecks and lint, workspace format/test/lint/typecheck/build, structural OpenSpec validation and full isolated browser gate. Parent owns freeze and gate orchestration; follow bin/h2puni-gate.sh host lock on h2puni. Record actual output and counts on implementation, not a generic success claim.

Decision: DRAFT ONLY; not verified, not implementation-complete, not ready to archive.

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
