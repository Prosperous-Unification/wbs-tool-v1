# Planned refactoring execution

**Implementation ledger last reconciled at `main` @ `e3c8aac3`, 2026-09-13.**
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
| W4-4 `WbsTable` split into fourteen modules      | `apps/wbs/fe-01/src/components/wbs/{use-plan-*,plan-columns/*,plan-cell-props,plan-live,…}.ts`, on `main` since `cbad68af`              | 10/10 tasks; [independent review](w4-4/verify.md#independent-review-2026-09-08) recorded 2026-09-08; 601 concept tests at merge; current `main` gate + four pixel shards green at `153c830a` |
| HTTP Wave 0, collision gate                      | [`collisions.md`](collisions.md)                                                                                                        | inventory at base `f89ebf56`, feature integration recorded 2026-09-06                                                                                                                        |
| HTTP Wave 1, `http-endpoint-port`                | `libs/wbs/domain/contracts/src/http/*`, be-01's `http/` binders and Elysia mount, typed clients; `openapi.json` no longer tracked       | change archived `openspec/changes/archive/2026-09-07-http-endpoint-port`, spec synced to `openspec/specs/http-endpoint-port`; TASK-347                                                       |
| R1 `plan-refresh`                                | `apps/wbs/fe-01/src/lib/` invalidation coordinator, `use-plan-read`                                                                     | 28/28 tasks; archived after the real two-browser peer rename and marker checks, complete Chromium, integration reconciliation, and explicit Darwin workspace-gate limits                     |
| R2 `team-removal-revisions`                      | be-01 service/repository                                                                                                                | 4/5 tasks; open 1.5 is touched suites/lint/typecheck and the parent verification report                                                                                                      |
| R3 `account-store-failures`                      | auth / be-01                                                                                                                            | 8/8 tasks                                                                                                                                                                                    |
| R4 `websocket-ingress`                           | gw-01                                                                                                                                   | 9/9 tasks                                                                                                                                                                                    |
| R5 `login-admission`                             | auth / be-01                                                                                                                            | 5/5 tasks                                                                                                                                                                                    |
| R6 `project-assignment-reads`                    | be-01 repository                                                                                                                        | 3/4 tasks; open 1.4 is touched checks, fresh evidence and the parent workspace status                                                                                                        |
| R7 `scoped-presence`                             | gw-01                                                                                                                                   | 12/12 tasks                                                                                                                                                                                  |
| R8 `bounded-replay-sweep`                        | gw-01 / realtime                                                                                                                        | 4/4 tasks                                                                                                                                                                                    |
| R9 `gateway-request-deadlines`                   | gw-01, be-01 cancellation                                                                                                               | 14/15 tasks; open 4.1 includes full gates, restoration, validation and review evidence                                                                                                       |
| The spec projects' type errors                   | in the gate: `typecheck` runs `tsc --build --force apps/wbs/<app>/tsconfig.json`, whose references include `tsconfig.spec.json`         | measured 2026-09-07 at `3e17fb01`: **0** errors across all 23 spec projects; a deliberate `const deliberatelyWrong: number = 'not a number'` in a test fails both                            |
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
- [x] **Archive R1–R9** — completed 2026-09-09 in the bounded
      [closeout order below](#r1r9-archival-closeout), including R1's two real-browser scenarios,
      evidence reconciliation and preservation of the shared-capability spec unions.
- [x] **Ports Wave 2 `store-port-and-unit-of-work`** — **done, 2026-09-08**, in six numbered
      slices plus the 3b ports/history follow-up; see [What Wave 2 landed](#what-wave-2-landed) below. The change is
      `openspec/changes/store-port-and-unit-of-work`; its `verify.md` carries the failure-proof
      table and the three checks-that-could-not-fail this wave caught. Nothing moved into
      `libs/` — that is Wave 3, and this wave's non-goal.
- [x] **Ports Wave 3 [core-lib-extraction](../../openspec/changes/archive/2026-09-10-core-lib-extraction/tasks.md)** —
      completed 2026-09-10. `libs/wbs/application/core`, `libs/wbs/adapters/store-sqlite`,
      `libs/wbs/adapters/store-memory` and `libs/wbs/application/conformance`
      now carry the application, adapter and certification boundaries; `be-01` retains its
      runtime binders, composition root and stable migration entrypoints. The fast-tier count
      moved with the code: 238 cases left `be-01` for `core`, and all 693 SQLite test nodes
      survived their 57-file relocation. The staged memory source certifies only its declared
      families and keeps one explicit estimate-capability skip; the remaining source families
      still belong to `source-conformance-completion`. ADR 0014 and ADR 0015 are accepted.
- [x] **[scheduler-runtime-port](../../openspec/changes/archive/2026-09-10-scheduler-runtime-port/tasks.md)** —
      completed on the same branch before the core consumer moves. Missing selected engines
      produce typed 409 reads and `plan_unavailable` publication; detached capture preserves
      the selected schedule or named absence without admitting a solve; the SQLite adapter
      retains the existing hash bytes and scheduler contract version.
- [ ] **A devsync oracle comparing `check.*` facts to their Nx manifests** — a target pinned
      by a `check.*` fact in `docs/wiki-policy/relationships.json` and
      `relationships.bootstrap.json` carries its WHOLE configuration in that fact, `inputs`
      included, and the declarations extractor refuses any drift. Changing a pinned target
      without updating both facts therefore breaks `wiki-cli:test`, and nothing says so until
      that ~15-minute suite runs: on 2026-09-16 the `affected-pr-gate` work added two workflow
      inputs to that target — then still named `tool-wiki:test` — and the h2puni smoke gate was
      what caught it, one round after the change had been reviewed. A tool-devsync oracle reading every `check.*` fact and
      comparing `expectedConfiguration` with the real manifest would fail in seconds instead,
      beside the other manifest oracles in `workspace-targets.test.ts`. Until it exists, any
      change to a fact-pinned target MUST update the fact in both files in the same commit.
- [ ] **Narrow `wiki-cli:lint` and `tool-devsync:test` inputs** — both declare
      `{workspaceRoot}/**/*`, so `nx show projects --affected` names them for EVERY file:
      measured 2026-09-16 before the wiki moved, `--files=LLM_README.md` answered
      `["tool-devsync","tool-wiki"]`; re-measured on this branch after the move, it answers
      `["tool-devsync","wiki-cli"]` — the same two projects under the new name.
      Two consequences for the affected PR gate (`openspec/changes/affected-pr-gate`): its
      `tool_wiki=skip` branch is unreachable today, and the per-PR saving is bounded well
      under the 38 minutes its proposal cites. Narrowing them is a wiki-policy decision about
      what the wiki's lint is really allowed to read, not a change the gate work may make on
      its own — `wiki-cli:lint`'s catch-all is what its admission model rests on. Needs its
      own change with the usual negatives before either input moves.
- [ ] **[source-conformance-completion](../../openspec/changes/source-conformance-completion/tasks.md)** —
      after core's source composition/staged memory. Complete the named 17 transactional
      plus two independent-history families, typed broken-source controls and honest
      execution/certification manifests. Does not silently implement every memory gap.
- [ ] **[repo-namespacing](../../openspec/changes/repo-namespacing/tasks.md)** (D18/D19) —
      implementation is at the landing candidate; Task 4.2 retains the earlier frozen-candidate
      runtime evidence. Production registry publication and the deploy dry-run remain explicitly
      deferred under OpenSpec 4.3, and the repaired landing SHA still awaits final exact-SHA gate
      and integration evidence. Do not claim deployment readiness or archive before both are done.
- [x] **W4-3 [plan-command-registry](../../openspec/changes/plan-command-registry/tasks.md)** —
      **merged in #430 as `e3c8aac3`, 2026-09-13**, 10/10 tasks. The contracts registry now
      owns all command kinds and structural descriptors; core derives semantic normalizers,
      normalized commands and kind-correlated bindings from it. HTTP refusal shapes and MCP
      tool generation consume the same registry while independently pinned kind inventories
      detect omissions and duplicates. The exact implementation head passed the provisioned
      h2puni workspace gate; PR checks recorded CodeQL and all four pixel shards green.
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
      19/29 tasks are checked through combined integration and recovery 5.2. Measured module
      indexes, finite trusted evidence, full-tree lint and shared-Git fenced admission are in
      place; trusted external binding, exhaustive catch-up and multi-model trials at 1/2/4/8
      workers remain. Reconcile stable module identities across namespacing. Experimental
      benefit remains unestablished.
      Precedents, Drift anchors and the extraction trigger:
      [plan](../plans/2026-09-13-tool-wiki-precedents-and-extraction.md).
- [ ] core↔store-memory cycle: all 27 core importers of `@wbs/store-memory` are under
      `libs/wbs/application/core/src/testing/` and `libs/wbs/application/core/testing/`. Move
      `src/testing/harness.ts`, `src/testing/writes-fixture.ts` and `testing/portable-composition.ts`
      into `libs/wbs/application/conformance` (already `ring:application`, already depends on
      both), then delete every `ignoredCircularDependencies` entry in `eslint.config.js`.
- [ ] Solver host tooling relocation: `tools/tool-remote-scripts/src/lib/solver-supervisor-*`,
      `src/materialize-solver-supervisor-config.ts`, `deploy/solver-supervisor/*` and
      `tools/dev/write-*-golden-corpus.ts` are WBS code in infra. Move them under `apps/wbs/`
      (a `wbs-host-tools` project, `ring:adapter`, `product:wbs`), then remove both entries from
      the `allow` list in `eslint.config.js` and the pinning test in eslint-boundaries.test.ts.
      The tools-scoped `allow` in eslint.config.js is keyed on the import specifier — each entry
      anchored, so it excuses that exact specifier and no subpath of it — which still leaves any
      other tool importing one of the two aliases excused too; the relocation closes that.
- [ ] Archive completed OpenSpec packets: ~120 unarchived `openspec/changes/*` directories still
      name pre-move roots; the handoff legacy-path scan therefore covers only the active packet.
      Archive every packet whose tasks are all checked and merged (`opsx:bulk-archive`), then
      widen `ACTIVE_OPENSPEC_PACKET` in repo-namespacing-handoff.test.ts to every unarchived packet.
- [ ] Derive fe-01's alias maps: `apps/wbs/fe-01` repeats the `@wbs/*`/`@shared/*` alias list in
      eight places (vite, vitest, four tsconfigs) with nothing comparing them to
      `tsconfig.base.json`; Task 1.3b had to add `@shared/validation` by hand. Generate the Vite
      alias map from `tsconfig.base.json` and pin equality in vite-config.test.ts.
- [ ] Make `shared-validation` buildable or drop tool-devsync's buildable status: tool-devsync's
      shellcheck `build` target makes Nx treat it as buildable, so its tests may not import the
      non-buildable `@shared/validation` without the eslint-disable in
      repo-namespacing-handoff.test.ts. Give shared-validation a `build` target or move
      shellcheck off the `build` name; then delete the disable.
- [ ] heavy lock: atomic dead-holder reclaim and holderless lock-dir recovery — four pre-existing
      shapes in `bin/heavy-lock-lib.sh` that the `fifo-heavy-lock` review found and deliberately
      did not touch. (1) A holder killed between its `mkdir` and `record_lock_holder` leaves a
      lock directory with no holder file; every later run reads that as a claim in progress and
      queues for ever, so one SIGKILL (or one ENOSPC) wedges the host until a human removes the
      directory. (2) The dead-holder reclaim is `rm -rf` then `mkdir`, which is not atomic: two
      runs reclaiming the same stale lock can both succeed. Fix by renaming out of the way —
      `mv "$lock_dir" "$lock_dir.stale.$$"` then removing the rename's result, so only the run
      that won the rename proceeds. (3) A holder has no deadline, only a pid, so a SIGKILLed
      holder whose pid the kernel reuses holds the lock for the whole life of the unrelated
      process; tickets already carry a deadline for exactly this reason. (4)
      `install_release_trap` replaces any INT/TERM trap the caller installed — the EXIT trap is
      chained, these two are not. Two operational items from the same lock, observed once it became
      visible: (5) `bin/h2puni-gate.sh`'s default `HEAVY_LOCK_WAIT_SECONDS` of 1800 cannot cover a
      second waiter behind a full gate — on 2026-09-16 two queued gates expired behind a 40-minute
      holder — so raise it to cover two gates and say what the number is derived from; (6)
      `bin/with-heavy-lock.sh status` could mark a waiter whose budget has run out as expired in
      its own right, since such a ticket is reclaimable and its owner has already given up.
- [ ] Wiki policy rule overlap: a `*.test.ts` under a `fixtures/` segment matches both the `test`
      (suffix) and `fixture` (segment) `contentRules` in `docs/wiki-policy/policy.json`, and
      `classify-entries` refuses the whole candidate. Give the `fixture` rule the
      `.test.ts`/`.test.tsx` exclusions its siblings carry, in a change that re-activates the
      trusted policy (W5).

## R1–R9 archival closeout

This is administrative/evidence work, not permission to rerun implementation or mark an
unobserved check green. Work one change at a time. Before each archive, read its tasks,
delta and verify record; compare the implemented contract at the named merged/current
revision; reconcile unchecked obligations with exact evidence or leave the change open.
Run the archive/sync workflow only after those obligations are met. Record historical
evidence as historical, including dead branch hashes carried by squash `cbad68af` and
any missing raw logs. Current-head checks, if needed, require fresh output and owned ports.

Before the first sync, record the exact requirement-heading/scenario sets from all nine
deltas and any existing main specs in [the preservation inventory](r1-r9-spec-inventory.md).
`authentication` and `realtime` contain overlapping
**ADDED** capabilities, not replacement documents. Sync sequentially; after each sync
assert the accumulated union and unrelated existing requirements are intact, validate
the resulting specs, then archive without a second destructive overwrite. Keep the
archive's original evidence limits. The bounded order is:

- [x] **A1 — R3 [`account-store-failures`](../../openspec/changes/archive/2026-09-08-account-store-failures/tasks.md)**: reconciled 8/8 and introduced
      `authentication` requirement “Account resolution failures remain server failures”.
- [x] **A2 — R5 [`login-admission`](../../openspec/changes/archive/2026-09-08-login-admission/tasks.md)**: reconciled 5/5 and appended “Password login reserves
      bounded verification capacity” and “Login reservations end with their attempts”.
      Assert all three authentication requirements and all their scenarios survive.
- [x] **A3 — R4 [`websocket-ingress`](../../openspec/changes/archive/2026-09-08-websocket-ingress/tasks.md)**: reconciled 9/9 and introduced `realtime`
      requirements “Gateway validates client frames before dispatch” and
      “Refused input does not disable a connection”.
- [x] **A4 — R7 [`scoped-presence`](../../openspec/changes/archive/2026-09-08-scoped-presence/tasks.md)**: reconciled 12/12 and appended “Presence changes identify
      affected projects”, “Initial and reset rosters are connection-specific”, and
      “Scoped presence preserves connection identity and isolation”. Assert all five
      realtime requirements and all their scenarios survive.
- [x] **A5 — R2 [`team-removal-revisions`](../../openspec/changes/archive/2026-09-08-team-removal-revisions/tasks.md)**: reconciled open 1.5's touched suites,
      lint/typecheck and parent report before syncing its distinct capability.
- [x] **A6 — R6 [`project-assignment-reads`](../../openspec/changes/archive/2026-09-08-project-assignment-reads/tasks.md)**: reconciled open 1.4's touched checks and
      parent report before syncing its distinct capability.
- [x] **A7 — R8 [`bounded-replay-sweep`](../../openspec/changes/archive/2026-09-08-bounded-replay-sweep/tasks.md)**: reconciled 4/4 and synced its distinct capability.
- [x] **A8 — R9 [`gateway-request-deadlines`](../../openspec/changes/archive/2026-09-08-gateway-request-deadlines/tasks.md)**: reconciled open 4.1's integrated full gates,
      restoration evidence, OpenSpec validation and independent review before sync.
- [x] **A9 — R1 [`plan-refresh`](../../openspec/changes/archive/2026-09-08-plan-refresh/tasks.md)**:
      added real two-browser peer rename and marker evidence, reconciled the full Chromium and
      workspace-gate results, recorded the original squash merge and synced its distinct
      capability. The preservation inventory and strict validation cover the complete nine-delta
      union.

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
`libs/wbs/domain/domain/src/contract-version.test.ts`; an unchecked combined feature task is not
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
