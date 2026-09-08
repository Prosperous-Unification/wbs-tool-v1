# Planned refactoring execution

**State as of 2026-09-08, `main` @ `f64ceea4`.** This file is the one queue for the two plans;
the plans themselves stay normative for _what_ and _why_:
[refactoring plan](../2026-09-02-refactoring-plan.md) (W0–W4, §67 R1–R10) and
[ports-and-adapters plan](../2026-09-05-ports-and-adapters-plan.md) (Waves 0–3, namespacing).
Each implementation change keeps ordered slices and fresh evidence in its own `tasks.md` and
`verify.md` under `openspec/changes/`. Historical completion claims require code inspection.

The execution branch `refactor/planned-project` (base `f89ebf56`, 2026-09-06) was squash-merged
into `main` as `cbad68af` (PR #287, 2026-09-07). **Every branch-local hash the earlier version of
this file and the change-local `verify.md` files cite (`281144a9`, `35576d79`, `e9141949`, …) no
longer resolves**; `cbad68af` is the commit that carries all of them. Evidence for the merged
state is in [`verify.md`](verify.md) § "Merged state".

## What landed

| Item                                             | Where it is now                                                                                                                         | Evidence                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W4-4 `WbsTable` split into fourteen modules      | `apps/fe-01/src/components/wbs/{use-plan-*,plan-columns/*,plan-cell-props,plan-live,…}.ts`, on `main` since `cbad68af`                  | `openspec/changes/wbs-table-modules` 8/10 tasks; 601 concept tests at merge; `main` CI green at `a0c7cada` and `7aa61b09` (gate + pixels)                         |
| HTTP Wave 0, collision gate                      | [`collisions.md`](collisions.md)                                                                                                        | inventory at base `f89ebf56`, feature integration recorded 2026-09-06                                                                                             |
| HTTP Wave 1, `http-endpoint-port`                | `libs/contracts/src/http/*`, be-01's `http/` binders and Elysia mount, typed clients; `openapi.json` no longer tracked                  | change archived `openspec/changes/archive/2026-09-07-http-endpoint-port`, spec synced to `openspec/specs/http-endpoint-port`; TASK-347                            |
| R1 `plan-refresh`                                | `apps/fe-01/src/lib/` invalidation coordinator, `use-plan-read`                                                                         | 25/28 tasks; the 3 open are the frozen-tree gates, satisfied by `main`'s runs above                                                                               |
| R2 `team-removal-revisions`                      | be-01 service/repository                                                                                                                | 4/5 tasks; open item is the parent gate                                                                                                                           |
| R3 `account-store-failures`                      | auth / be-01                                                                                                                            | 8/8 tasks                                                                                                                                                         |
| R4 `websocket-ingress`                           | gw-01                                                                                                                                   | 9/9 tasks                                                                                                                                                         |
| R5 `login-admission`                             | auth / be-01                                                                                                                            | 5/5 tasks                                                                                                                                                         |
| R6 `project-assignment-reads`                    | be-01 repository                                                                                                                        | 3/4 tasks; open item is the parent gate                                                                                                                           |
| R7 `scoped-presence`                             | gw-01                                                                                                                                   | 12/12 tasks                                                                                                                                                       |
| R8 `bounded-replay-sweep`                        | gw-01 / realtime                                                                                                                        | 4/4 tasks                                                                                                                                                         |
| R9 `gateway-request-deadlines`                   | gw-01, be-01 cancellation                                                                                                               | 14/15 tasks; open item is the parent gate                                                                                                                         |
| The spec projects' type errors                   | in the gate: `typecheck` runs `tsc --build --force apps/<app>/tsconfig.json`, whose references include `tsconfig.spec.json`             | measured 2026-09-07 at `3e17fb01`: **0** errors across all 23 spec projects; a deliberate `const deliberatelyWrong: number = 'not a number'` in a test fails both |
| Toolchain (`toolchain-2026-09`, not a plan item) | Bun 1.4.2, Nx 23.2, TS 7 for `tsc`, Vite 8, Vitest 5, React 19.2, Table 9, drizzle 1.0.0-rc.4, ESLint 10, Prettier 3.9.6, dagger 0.21.9 | PR #248 merged as `98093d2d`; TASK-348                                                                                                                            |

The "parent gate" tasks left open in R1, R2, R6 and R9 asked for a frozen-tree full gate of the
branch. The branch is gone; the gate that stands in for it is `main`'s own CI at `a0c7cada` and
`7aa61b09`, both `gate: success` and `pixels: success`, with every slice merged. Tick those tasks
when the change is archived, citing those runs, or leave them as the record that the branch never
ran its own.

## Execution queue — what remains

Nothing below has an owning task in the external queue (`backlog/tasks/task-NNN …`) unless named.

- [x] **R10 `measured-rendering`** — **done, 2026-09-08**, 17/17 tasks. Explicit row readings and stable cell identities,
      deferred Find criteria, logical navigation, variable-height row and column windows, active-editor
      retention, drag/accessibility geometry, complete Gantt correspondence and the measured Chromium
      budgets are implemented. The optimized 12-configuration matrix and complete browser gate are
      recorded in the change's `verify.md`. A direct Chromium case now covers evicted-editor
      commit, Escape and refused-draft remounting. PR #353's exact implementation head passed the
      fully provisioned workspace gate and all four pixel shards; independent review found no
      Critical or Important issues, and the change validates cleanly against its parent.
- [ ] **W4-4 tasks 3.4–3.5** — the independent review and coordinated full browser gate the
      change asked for before its `live` contract is handed to R1/R10. `main`'s green runs cover
      the gate; the review is unrecorded.
- [ ] **Archive the nine R-slice changes** whose tasks are complete or gate-only
      (`opsx:archive`, syncing each delta spec into `openspec/specs/`). Only
      `http-endpoint-port` has been archived.
- [x] **Ports Wave 2 `store-port-and-unit-of-work`** — **done, 2026-09-08**, in six merged
      slices; see [What Wave 2 landed](#what-wave-2-landed) below. The change is
      `openspec/changes/store-port-and-unit-of-work`; its `verify.md` carries the failure-proof
      table and the three checks-that-could-not-fail this wave caught. Nothing moved into
      `libs/` — that is Wave 3, and this wave's non-goal.
- [ ] **Ports Wave 3 `core-lib-extraction`** — not started; `libs/` has `runtime-portable` and no
      `core` or `conformance`. Plan §3.3, §3.5. Wave 2 left it more moveable than it found it:
      the ports are declared (`repository/index.ts`, `service/{unit-of-work,runtime-ports}.ts`),
      the composition is two functions (`buildStores`, `servicesOver`), and the kits are already
      a file of their own under `testing/kits/`.
- [ ] **`repo-namespacing`** (D18/D19) — not started; after Wave 3.
- [ ] **W4-3's registry proper** in `libs/contracts` — its own OpenSpec change; depends on
      verifying Elysia's Standard Schema → JSON Schema export (handoff §58).
- [ ] **W2-3's plan snapshot** — architecture, its own change (plan §W2-3).
- [ ] **W2-1's write half** — narrowing which reads a local write triggers (plan §25, §67 R1
      carries the socket half).
- [ ] **W1-6 e2e seeding**; **W3-10 OIDC store adoption** — each refused pending its own change.
- [ ] **`plan-json-import`** — approved artifacts, no implementation
      ([`collisions.md`](collisions.md)); Dany's.

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

**Deliberately out, by the Wave 0 gate:** the `Scheduler` port, `engine_unavailable` and
`scheduleInputHash`'s move — `dual-optimized-scheduler` still holds unchecked slices on
`SCHEDULER_CONTRACT_VERSION` and the drain seams. They are the next change after it lands. Also
out: kits for the thirteen ports beyond step/estimate/directory/event-log, and
`brokenSource(source, fault)` as a named helper; the shape they plug into is merged and both
sources already run through it.

## Integration policy

Feature work stays on `main`; each remaining item is its own branch and PR, gated by CI at its
exact head (the toolchain and HTTP merges both carried PR bodies whose evidence predated the head;
`docs/state/TASK-347-http-endpoint-port.md` and `TASK-348-toolchain-2026-09.md` record that).
Parallel workers own disjoint files, and broad measurements require a frozen tree. Browser runs
must own their ports and cannot reuse another checkout's server.

The audit found TASK-262 already supplies framework-free routes and two binders; those were reused
by Wave 1, not reimplemented.
