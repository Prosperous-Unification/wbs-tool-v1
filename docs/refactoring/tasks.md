# Planned refactoring execution

**Implementation ledger last reconciled at `main` @ `14cc7367`, 2026-09-08.**
R10's completed PR #353 packet is preserved unchanged during integration.
Design preparation completed 2026-09-08, inspecting `339708fa` through `aca7a5c9`;
see [execution readiness](execution-readiness.md) for scope, assumptions and evidence limits.
This file is the one queue for the three scoped plans;
the plans themselves stay normative for _what_ and _why_:
[refactoring plan](../2026-09-02-refactoring-plan.md) (W0–W4, §67 R1–R10),
[ports-and-adapters plan](../2026-09-05-ports-and-adapters-plan.md) (Waves 0–3, namespacing), and
[agent-scalable LLM wiki](../plans/2026-09-08-agent-scalable-llm-wiki.md) (Radical Modularity).
Each implementation change keeps ordered slices and fresh evidence in its own `tasks.md` and
`verify.md` under `openspec/changes/`. Historical completion claims require code inspection.

The execution branch `refactor/planned-project` (base `f89ebf56`, 2026-09-06) was squash-merged
into `main` as `cbad68af` (PR #287, 2026-09-07). **Every branch-local hash the earlier version of
this file and the change-local `verify.md` files cite (`281144a9`, `35576d79`, `e9141949`, …) no
longer resolves**; `cbad68af` is the commit that carries all of them. Evidence for the merged
state is in [`verify.md`](verify.md) § "Merged state".

## What landed

| Item                                             | Where it is now                                                                                                                         | Evidence                                                                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W4-4 `WbsTable` split into fourteen modules      | `apps/fe-01/src/components/wbs/{use-plan-*,plan-columns/*,plan-cell-props,plan-live,…}.ts`, on `main` since `cbad68af`                  | 10/10 tasks; [independent review](w4-4/verify.md#independent-review-2026-09-08) recorded 2026-09-08; 601 concept tests at merge; current `main` gate + four pixel shards green at `153c830a` |
| HTTP Wave 0, collision gate                      | [`collisions.md`](collisions.md)                                                                                                        | inventory at base `f89ebf56`, feature integration recorded 2026-09-06                                                                                                                        |
| HTTP Wave 1, `http-endpoint-port`                | `libs/contracts/src/http/*`, be-01's `http/` binders and Elysia mount, typed clients; `openapi.json` no longer tracked                  | change archived `openspec/changes/archive/2026-09-07-http-endpoint-port`, spec synced to `openspec/specs/http-endpoint-port`; TASK-347                                                       |
| R1 `plan-refresh`                                | `apps/fe-01/src/lib/` invalidation coordinator, `use-plan-read`                                                                         | 25/28 tasks; 5.2 is a distinct real-browser scenario, 5.4 the full gate, and 5.5b integration/evidence reconciliation; historical CI does not establish 5.2                                  |
| R2 `team-removal-revisions`                      | be-01 service/repository                                                                                                                | 4/5 tasks; open 1.5 is touched suites/lint/typecheck and the parent verification report                                                                                                      |
| R3 `account-store-failures`                      | auth / be-01                                                                                                                            | 8/8 tasks                                                                                                                                                                                    |
| R4 `websocket-ingress`                           | gw-01                                                                                                                                   | 9/9 tasks                                                                                                                                                                                    |
| R5 `login-admission`                             | auth / be-01                                                                                                                            | 5/5 tasks                                                                                                                                                                                    |
| R6 `project-assignment-reads`                    | be-01 repository                                                                                                                        | 3/4 tasks; open 1.4 is touched checks, fresh evidence and the parent workspace status                                                                                                        |
| R7 `scoped-presence`                             | gw-01                                                                                                                                   | 12/12 tasks                                                                                                                                                                                  |
| R8 `bounded-replay-sweep`                        | gw-01 / realtime                                                                                                                        | 4/4 tasks                                                                                                                                                                                    |
| R9 `gateway-request-deadlines`                   | gw-01, be-01 cancellation                                                                                                               | 14/15 tasks; open 4.1 includes full gates, restoration, validation and review evidence                                                                                                       |
| The spec projects' type errors                   | in the gate: `typecheck` runs `tsc --build --force apps/<app>/tsconfig.json`, whose references include `tsconfig.spec.json`             | measured 2026-09-07 at `3e17fb01`: **0** errors across all 23 spec projects; a deliberate `const deliberatelyWrong: number = 'not a number'` in a test fails both                            |
| Toolchain (`toolchain-2026-09`, not a plan item) | Bun 1.4.2, Nx 23.2, TS 7 for `tsc`, Vite 8, Vitest 5, React 19.2, Table 9, drizzle 1.0.0-rc.4, ESLint 10, Prettier 3.9.6, dagger 0.21.9 | PR #248 merged as `98093d2d`; TASK-348                                                                                                                                                       |

Historical merged-state CI at `a0c7cada` (run `34148109854`) and `7aa61b09` (run
`34149386984`) records successful `gate` and `pixels` jobs with these slices merged. It
can document historical parent-gate disposition, not a fresh pass at `339708fa` or a
scenario those runs are not shown to contain. R1 5.2 specifically requires peer edit and
marker scenarios preserving the editor node, typed value, selection and installed output.
Its `verify.md` explicitly distinguishes composed transport tests from end-to-end browser
coverage. Reconcile each open task against its actual requirement before ticking it;
archival itself supplies no missing evidence.

## Execution queue — what remains

Nothing below has an owning task in the external queue (`backlog/tasks/task-NNN …`) unless named.

- [x] **R10 [measured-rendering](../../openspec/changes/measured-rendering/tasks.md)** — **merged in #353 as `f66f73e8`, 2026-09-08**, 17/17 tasks. Explicit row readings and stable cell identities,
      deferred Find criteria, logical navigation, variable-height row and column windows, active-editor
      retention, drag/accessibility geometry, complete Gantt correspondence and the measured Chromium
      budgets are implemented. The optimized 12-configuration matrix and complete browser gate are
      recorded in the change's `verify.md`. A direct Chromium case now covers evicted-editor
      commit, Escape and refused-draft remounting. PR #353's exact implementation head passed the
      fully provisioned workspace gate and all four pixel shards; independent review found no
      Critical or Important issues, and the change validates cleanly against its parent.
- [x] **W4-4 [final handoff 3.5](../../openspec/changes/archive/2026-09-08-wbs-table-modules/tasks.md)** —
      archived after recording the exact historical revisions, the later review-merge failure,
      and the receiving R1/R10 column-dependency, `PlanLive` and editor-identity obligations.
      No historical CI was relabelled as a pass on the current tree.
- [ ] **Archive R1–R9** — the bounded [closeout order below](#r1r9-archival-closeout)
      includes evidence reconciliation, R1's scenario gap and shared-capability spec unions.
      Within this refactoring programme, only `http-endpoint-port` is already archived.
- [x] **Ports Wave 2 `store-port-and-unit-of-work`** — **done, 2026-09-08**, in six numbered
      slices plus the 3b ports/history follow-up; see [What Wave 2 landed](#what-wave-2-landed) below. The change is
      `openspec/changes/store-port-and-unit-of-work`; its `verify.md` carries the failure-proof
      table and the three checks-that-could-not-fail this wave caught. Nothing moved into
      `libs/` — that is Wave 3, and this wave's non-goal.
- [ ] **Ports Wave 3 [core-lib-extraction](../../openspec/changes/core-lib-extraction/tasks.md)** — started: its tasks 1.1–1.4 and 2.1–2.2a
      are checked, and `libs/core/src/ports/{clock,runtime,write-stamp}.ts` exists at
      `339708fa`. `conformance`, `store-sqlite` and `store-memory` have not been extracted.
      Plan §3.3, §3.5. Wave 2 left it more moveable than it found it:
      the ports are declared (`repository/index.ts`, `service/{unit-of-work,runtime-ports}.ts`),
      the composition is two functions (`buildStores`, `servicesOver`), and the kits are already
      a file of their own under `testing/kits/`. Next is recursive project discovery 2.0,
      then neutral contracts/runtime and admitted-scope composition. Pause after
      2.2b–2.2b.4 for the scheduler packet before moving its consumers in 2.2c onward.
- [ ] **[scheduler-runtime-port](../../openspec/changes/scheduler-runtime-port/tasks.md)** —
      the explicit Wave 2 tail, after core's neutral contracts/runtime prerequisites and
      active optimizer interfaces settle; before core consumer moves/boundary closeout
      and JSON import. Includes D23 typed unavailable live reads/publication and faithful
      detached capture; not a new scheduler algorithm or version bump.
- [ ] **[source-conformance-completion](../../openspec/changes/source-conformance-completion/tasks.md)** —
      after core's source composition/staged memory. Complete the named 17 transactional
      plus two independent-history families, typed broken-source controls and honest
      execution/certification manifests. Does not silently implement every memory gap.
- [ ] **[repo-namespacing](../../openspec/changes/repo-namespacing/tasks.md)** (D18/D19) —
      prepared, implementation not started; after core. Preserve aliases and deploy
      identities while moving project paths/names/tags, migrations and build/gate consumers.
      Other packets use pre-namespacing paths; finish overlapping moves first or explicitly
      remap their exact file/target references at landing.
- [ ] **W4-3 [plan-command-registry](../../openspec/changes/plan-command-registry/tasks.md)** —
      after core. Shared `SchemaShape` already pairs ArkType validation with generated
      JSON Schema; the historical Elysia-export probe is no longer a blocker. Preserve
      structural/semantic parsing order and generated MCP/client contracts.
- [ ] **W2-3 [live-plan-snapshot](../../openspec/changes/live-plan-snapshot/tasks.md)** —
      after core and command registry. One `WorkingPlan` belongs to the admitted batch;
      refresh affected projections after each mutation, including same-command reads.
- [ ] **W2-1 [local-write-invalidation](../../openspec/changes/local-write-invalidation/tasks.md)** —
      the local-write half of R1. Account for each completed request, including a successful
      prefix before refusal; coordinate shared hook/row signatures with R10 and serialize
      their edits. No dependence on receiving one's own socket echo.
- [ ] **W1-6 [e2e-plan-seeding](../../openspec/changes/e2e-plan-seeding/tasks.md)** —
      R10's prerequisite is now completed by #353. Only the named static fixture allowlist changes;
      preserve each tested UI gesture and select worker count from the packet's trials.
- [ ] **W3-10 [mcp-oidc-store](../../openspec/changes/mcp-oidc-store/tasks.md)** —
      bounded MCP adoption of the shared store, preserved honest callback after mismatch,
      digested retained binding and existing timing-safe primitive. Serialize auth-file
      ownership with core's OIDC boundary move; no provider/browser-mode work.
- [ ] **[plan-json-import](../../openspec/changes/plan-json-import/tasks.md)** —
      approved, unimplemented; existing owner Dany. After core and scheduler capability,
      preserving atomic import, authored settings/directory closure and generated bindings.
- [ ] **[agent-scalable-llm-wiki](../../openspec/changes/agent-scalable-llm-wiki/tasks.md)** —
      Radical Modularity is separate additive scope, all five phases: measured module
      indexes, finite trusted evidence, full-tree lint, shared-Git admission and multi-model
      trials at 1/2/4/8 workers. Capture baselines before policy rollout; reconcile stable
      module identities across namespacing. Experimental benefit remains unestablished.

## R1–R9 archival closeout

This is administrative/evidence work, not permission to rerun implementation or mark an
unobserved check green. Work one change at a time. Before each archive, read its tasks,
delta and verify record; compare the implemented contract at the named merged/current
revision; reconcile unchecked obligations with exact evidence or leave the change open.
Run the archive/sync workflow only after those obligations are met. Record historical
evidence as historical, including dead branch hashes carried by squash `cbad68af` and
any missing raw logs. Current-head checks, if needed, require fresh output and owned ports.

Before the first sync, record the exact requirement-heading/scenario sets from all nine
deltas and any existing main specs. `authentication` and `realtime` contain overlapping
**ADDED** capabilities, not replacement documents. Sync sequentially; after each sync
assert the accumulated union and unrelated existing requirements are intact, validate
the resulting specs, then archive without a second destructive overwrite. Keep the
archive's original evidence limits. The bounded order is:

- [ ] **A1 — R3 `account-store-failures`**: reconcile 8/8 and introduce/merge
      `authentication` requirement “Account resolution failures remain server failures”.
- [ ] **A2 — R5 `login-admission`**: reconcile 5/5 and append “Password login reserves
      bounded verification capacity” and “Login reservations end with their attempts”.
      Assert all three authentication requirements and all their scenarios survive.
- [ ] **A3 — R4 `websocket-ingress`**: reconcile 9/9 and introduce/merge `realtime`
      requirements “Gateway validates client frames before dispatch” and
      “Refused input does not disable a connection”.
- [ ] **A4 — R7 `scoped-presence`**: reconcile 12/12 and append “Presence changes identify
      affected projects”, “Initial and reset rosters are connection-specific”, and
      “Scoped presence preserves connection identity and isolation”. Assert all five
      realtime requirements and all their scenarios survive.
- [ ] **A5 — R2 `team-removal-revisions`**: reconcile open 1.5's touched suites,
      lint/typecheck and parent report before syncing its distinct capability.
- [ ] **A6 — R6 `project-assignment-reads`**: reconcile open 1.4's touched checks and
      parent report before syncing its distinct capability.
- [ ] **A7 — R8 `bounded-replay-sweep`**: reconcile 4/4 and sync its distinct capability.
- [ ] **A8 — R9 `gateway-request-deadlines`**: reconcile open 4.1's integrated full gates,
      restoration evidence, OpenSpec validation and independent review before sync.
- [ ] **A9 — R1 `plan-refresh`**: map or collect the actual 5.2 real-browser peer/marker
      scenario evidence, then reconcile 5.4 full gates and 5.5b merged integration record.
      A generic green browser job alone cannot complete 5.2. Sync its distinct capability
      only when these obligations are met, then verify the complete nine-delta union.

W4-4 is a separate closeout: after its existing task 3.5 is satisfied, sync/archive its
own `wbs-table-modules` capability. Its review is not a missing tenth implementation task.

## What Wave 2 landed

| Slice                   | PR   | What                                                                   |
| ----------------------- | ---- | ---------------------------------------------------------------------- |
| artifacts + Wave 0 gate | #317 | the collision gate re-run at `d2e14214`                                |
| 1 the `Gate` port       | #319 | every write takes a turn; the batch's own admitted graph               |
| 2 the unit of work      | #320 | `run(act)` with `Decision`/`afterRollback`; `OuterTransaction` deleted |
| 3 the collector         | #321 | `AnnouncementCollector` per batch; `AsyncLocalStorage` gone            |
| 3b ports and history    | #323 | `EventLogStore`, `TransactionalStores`/`HistoryStores`, case (j)       |
| 4 references            | #324 | a broken reference is named by the store it broke in                   |
| 5 the kits              | #326 | `sourceConformance` over two sources, and the D29 allowlist            |
| 6 the runtime           | #327 | `PasswordHasher`, `TokenCodec`, `Digest`, and the last global default  |

**The intent was a live production gap and it is closed.** ADR 0007 said every be-01 write
waits behind the write lock while a batch is open; only the batch and publication took it, so a
route write landing inside an open batch was rolled back by somebody else's refusal while its
caller was told it worked. Watched on `main` before the fix existed:
`Expected to contain: "Wiring" · Received: [ "Dev", "QA" ]`.

**Deliberately out, by the Wave 0 gate:** `Scheduler`, `engine_unavailable` and the
`scheduleInputHash` move now belong to `scheduler-runtime-port`. Current inspected code
already exports `SCHEDULER_CONTRACT_VERSION = 8` and `contractVersionOf`, with tests in
`libs/domain/src/contract-version.test.ts`; an unchecked combined feature task is not
evidence that these are absent. Recheck the active optimizer/drain interfaces at landing,
not an obsolete claim that the version constant still needs implementing. The thirteen
remaining transactional port families, two history families, and named
`brokenSource(source, fault)` belong to `source-conformance-completion`; core first
provides the staged source/composition they require.

## Integration policy

Feature work stays on `main`; each remaining item is its own branch and PR, gated by CI at its
exact head (the toolchain and HTTP merges both carried PR bodies whose evidence predated the head;
`docs/state/TASK-347-http-endpoint-port.md` and `TASK-348-toolchain-2026-09.md` record that).
Parallel workers own disjoint files, and broad measurements require a frozen tree. Browser runs
must own their ports and cannot reuse another checkout's server.

The audit found TASK-262 already supplies framework-free routes and two binders; those were reused
by Wave 1, not reimplemented.

## Design preparation for medium-effort execution

Requested 2026-09-08: resolve the remaining architectural questions from documentation,
record assumptions without a further interview, and make every remaining task executable
in a bounded slice. These boxes record preparation, not implementation or passing gates.

- [x] Reconcile the full remaining scope against current code, change artifacts and all three scoped plans.
- [x] Resolve core, runtime, namespacing and command-contract decisions in their owning artifacts.
- [x] Resolve rendering, read consistency, import, seeding and OIDC decisions in their owning artifacts.
- [x] Supply ordered TDD slices with file/interface boundaries, prerequisites and meaningful fault oracles.
- [x] Audit complete scope coverage, artifact validity, local links and the distinction between planned and observed proof.
