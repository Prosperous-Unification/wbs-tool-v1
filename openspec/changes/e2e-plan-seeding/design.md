## Context

Historical §24 correctly refused a blanket seed rewrite. Current `create-project.ts` waits for the newly created project's rename arm to settle. `rendering-fixture.ts` already seeds commands through same-origin fetch while the table observer is unmounted, checks responses and verifies the actual tree. Playwright still uses one worker. Several comments claiming unique accounts are stale: fixtures wait for local-dev; global directory and project listing are shared.

## Goals / Non-Goals

Reduce prerequisite setup for named static scenarios without weakening browser interaction coverage. No direct SQL, test endpoints, bypassed authentication or unmeasured concurrency switch.

## Decisions

Add `e2e/plan-fixture.ts` exporting `seedPlan(page, recipe, identity): Promise<SeededPlan>` and `openSeededPlan(page, seeded)`. `SeededPlan` has projectId, row ids by caller ref, step ids by caller name, and expected authored values. `recipe` uses `PlanCommandWire` and explicit settings; no open string kind/index signature. Its batch compiler returns typed chunks of at most 200 commands and rewrites cross-chunk refs to previous chunks' returned ids. Duplicate recipe refs or impossible dependencies fail before a request.

Use shared contract `clientFromShapes` with a Page-backed same-origin transport, or the already generated client over `page.request` with matching cookies and Origin. Choose Page-backed fetch here because it matches current rendering setup and carries the browser's session/origin behavior. Validate response bodies with the shared schema. No unconstrained `as Promise<T>` helper survives the migration. Server refusals throw from setup with operationId/status and safe refusal code, never success-shaped defaults.

Create projects through the existing UI helper when the test is about the header/create gesture. The selected static fixture can create through the real project API, then navigate off the table during bulk writes and open the result through the real picker afterwards. Do not assign localStorage behind the app: select the returned project's unique name with the picker, then assert the exact project id selected and final server state before measuring.

All generated project and directory names carry a run token, worker index and test identity. Names are not reused across tests. A shared directory count is never an isolated oracle; assertions locate the exact fixture's ids/names. Tests that intentionally assert a global listing use a separate serial project and cannot run beside global writers unless they filter their assertions.

The initial adoption allowlist is `rendering-fixture.ts` and static setup in `plan-surface.spec.ts` only. All other specs retain UI setup, including `layout.spec.ts`, `keyboard.spec.ts`, `mobile.spec.ts`, `priority-ramp.spec.ts`, `slack-cell.spec.ts`, `gantt.spec.ts`, `hints.spec.ts` and `project-picker.spec.ts`. This is a decided narrow scope. Within plan-surface, any case asserting focus armed by creation still calls createProject and types its tested gesture. No generic preamble extraction merely to save eighteen lines.

After setup, independently GET the project's tree and settings and assert row identity/order, all requested estimates, edge endpoints and directory references. The expected shape comes from the recipe, not from the response being tested. Verify every batch response index/ref/id before using it. These checks execute before any timing sample and must fail on a dropped command even if HTTP returns 200.

## Concurrency Decision

Keep workers:1 until measurement completes. Run identical full suites at one and four workers, zero retries, three times each on a frozen checkout, fresh run database and owned safe ports. Accept four only if all six runs pass, no SQLITE_BUSY/locked responses occur, fixtures prove disjoint identities, and four-worker median wall time is at least 20% lower. Otherwise retain one and record the measured refusal. This is an executable decision rule, not an open architectural question. Existing global-state specs must be audited before the four-worker experiment; affected assertions are made fixture-specific or those files retain a separate serial lane.

## File Map and Migration Plan

`apps/fe-01/e2e/{plan-fixture.ts,plan-fixture.spec.ts,rendering-fixture.ts,rendering-fixture.spec.ts,plan-surface.spec.ts}`; `playwright.config.ts` and its root-level lint target only if adding a config helper or a worker lane. Shared command types come from contracts, independent of command-registry implementation. R10's baseline and implementation prerequisite is completed by #353 (`f66f73e8`). Preserve `rendering-baseline.spec.ts`'s logical readiness (`aria-rowcount` equals rows + 1), independent `renderingGeometry` counts, acceptance ceilings and all existing fault proofs. Its retained source/fixture-hashed measurements remain historical: changing fixture setup cannot silently relabel them as observations of the new harness.

## Risks / Trade-offs

A faster seed that bypasses the faulted interaction invalidates a scenario. Preserve the gesture each assertion is about, and fault that gesture again after conversion. No wall-time improvement is claimed from reading the code.

## Open Questions

None; worker count is selected by the acceptance rule above.
