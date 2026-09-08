## Context

W2-3's remaining item is repeated whole-plan reads inside command batches. Existing `servicesOver`, `UnitOfWork.run(scope)` and per-batch `AnnouncementCollector` are the seam. A saved-plan capture opens another connection and returns immutable detached input; it cannot read a batch's uncommitted writes. [ADR 0019](../../../docs/adr/0019-a-working-plan-belongs-to-one-admitted-batch.md) defines ownership.

## Goals / Non-Goals

Reduce full-project scans while retaining exact live-store results and all undo/publication behavior. Do not promise twenty total SQL statements for two hundred writes: the historical estimate conflated bulk reads with total statements. Do not change the schedule engine or the live tree's modeled scheduler refusal.

## Decisions

Create `createWorkingPlan(scope, projectId)` inside the unit-of-work callback after admission and before building its service graph, with this exact public contract:

```ts
interface WorkingPlan {
  readonly stores: PlanTransactionalStores;
  close(): void;
}
function createWorkingPlan(scope: Scope<PlanTransactionalStores>, projectId: string): WorkingPlan;
```

The runner needs only plan/directory stores, so the wrapper deliberately exposes no account capability; a full SQLite scope is structurally accepted without pretending the returned graph can authenticate. Build `stores` as an explicitly typed `PlanTransactionalStores` object delegating unwrapped members and replacing the named wrappers, with no generic cast. The graph factory consumes `{ stores: workingPlan.stores }` explicitly, never a process closure over SQLite's admitted stores. Closing in finally makes use after commit, rollback or throw an invariant error. Directory-only batches use ordinary scope stores. Ordinary route graphs, undo/redo and post-commit announce use fresh nonworking stores.

The working plan retains six project-scoped collections: labelled work items, estimates, actuals, progress, measures and dependencies. Load each once on first demand, not all before the first command: eager reads would move stored-state failures before existing admission/refusal checks. It delegates projects, steps, capacity, bands and all directory reads to the current scope. No snapshot of external/global directory state survives a write.

Read methods return detached arrays/records, including label and external-ref arrays. Retained maps replace entries, never mutate previously returned records. This is essential for `record` and `recordCollected`: their before images must still describe the earlier command after a later mutation. The working plan is internal to a single batch, but callers' borrowed values remain immutable in fact.

Persist each store write first. On success, update every affected retained collection before the wrapper method resolves; same-command reads therefore see it. On a modeled refusal do not advance the maps. On a thrown failure abandon the batch; never catch and keep using a partly advanced cache.

Use authoritative targeted rereads rather than duplicate SQLite revision, label, normalization or cascade logic. Add `WorkItemStore.listByIds(projectId: string, ids: readonly string[]): Promise<LabelledWorkItem[]>`. Add `listByWorkItems(projectId: string, ids: readonly string[])` to `EstimateStore`, `ActualStore`, `StepProgressStore`, `MeasureStore` and `DependencyStore`, each returning its existing `listByProject` element array type. Dependency results include edges with either endpoint in ids. Every source constrains the query by the supplied project id, joining through work items where the satellite has no project column; an id belonging to another project returns no row. Readers validate the same stored-state boundaries and preserve each store's existing ordering. Empty ids return an empty collection by contract. Missing requested rows are ordinary after deletion; malformed returned rows or unexpected ids throw.

The exact five return types are respectively `Promise<StoredEstimate[]>`,
`Promise<StoredActual[]>`, `Promise<StoredProgress[]>`, `Promise<StoredMeasure[]>`
and `Promise<StoredDependency[]>`; use those existing port values, not new row aliases.

A private `refreshRows(ids)` replaces/removes those identities in loaded collections using the current admitted stores and passes the captured `projectId` explicitly to every targeted reader. Missing cached ids are removed, and incident dependency edges are replaced as a set; unrelated entries remain. Each row/value/edge wrapper receives only its typed source ports and the working plan's project id/lifecycle callbacks; none recovers stores from a shared process closure. `listByProject` output retains the production store's ordering comparator, covered against that store.

The mutation matrix is normative:

| Successful store call                           | Identities refreshed before return                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| workItems.insert                                | inserted row, parent, respaced siblings                                                                               |
| workItems.patch                                 | target row (including label/external-ref joins)                                                                       |
| workItems.move                                  | target, old/new parent, respaced siblings                                                                             |
| workItems.setFrozenNumbers                      | every update id                                                                                                       |
| workItems.remove                                | removed ids, promoted children and their old/new parents                                                              |
| estimates/actuals/progress/measures set/remove  | affected work item                                                                                                    |
| those four stores moveAll                       | source and destination                                                                                                |
| dependencies.add/remove                         | predecessor and successor                                                                                             |
| dependencies.removeAllFor                       | doomed ids plus every surviving endpoint of a removed edge, collected before deletion                                 |
| subtrees.insertSubtree                          | copy rows, respaced/reparented rows and their old/new parents, ids in removed value keys, all inserted edge endpoints |
| directory.assign                                | its workItemId, including the authoritative assignment-induced revision; assignment reads stay delegated              |
| DirectoryStore global entry/membership mutation | reload every already-loaded collection immediately after success; excludes the project-scoped assign method           |
| other delegated store mutations                 | no cached collection changes under the command vocabulary; an added command must extend this matrix first             |

Parents and surviving endpoints matter because operations can bump rows other than the obvious target. Capture old parent/incident endpoints before delegation from loaded values or targeted live reads; do not use a full-project reload to discover affected ids on the ordinary fast path. Store methods still enforce their own atomicity and references.

Global directory entry/membership mutations are deliberately conservative barriers: team/person/tag/type/service deletion can cascade labels, assignments, satellite-derived revisions and capacity across projects. After success reload this batch's loaded collections from its own scope before dispatch continues. `DirectoryStore.assign` is a project-scoped write despite its current port location: on `{ ok: true }` target-refresh its work item only; `unknown_step`/`unknown_person` leave retained values unchanged. Assignment reads remain delegated, so they observe the new person immediately without a cached assignment collection. Global directory reads are never cached, so a createPerson followed by setAssignee sees the new person immediately. A global directory command may cause a full reread; setAssignee is still a plan-only command covered by the bounded-full-read contract.

## File Map and Migration Plan

After core extraction and command bindings: `libs/core/src/service/working-plan.ts`; focused wrappers `working-plan-rows.ts`, `working-plan-values.ts`, `working-plan-edges.ts`; `ports/{work-item,estimate,actual,step-progress,measure,dependency}-store.ts`; `service/plan-commands.ts`; `compose.ts`. Source implementations: `libs/store-sqlite/src/{work-item,estimate,actual,step-progress,step-measure,dependency}.ts` and corresponding store-memory modules. Readers first pass both source kits, then wrappers, then runner wiring. No schema migration. Do not modify `SavedPlanCaptureStore` or its read connection.

## Risks / Trade-offs

Targeted reads still cost statements. Record full-project SELECTs, targeted SELECTs, writes and elapsed time separately for homogeneous and mixed 200-command batches. Acceptance is one full-project read per loaded collection for a plan-only batch, no correctness change, and the following runtime bound. On a frozen workload, checkout and host, collect twenty paired warm uncached/cached samples for each fixture, alternating order deterministically by pair index. Restore identical initial authored state before each sample, outside the timed interval. Retain every sample and report median and range for each mode/fixture. Cached median must be at most `1.10 × uncached median` independently for both homogeneous and mixed fixtures. This ten-percent tolerance is an authorized design assumption, not a measured claim. Exceeding it is failed acceptance; report the shortfall rather than marking implementation complete, discarding outliers or adding a different optimization without a new scoped decision.

## Open Questions

None. Every mutation row needs its planned source-path negative before a performance claim. Added store methods discovered during implementation must first be classified against the closed matrix; an unclassified mutation is an implementation defect, not permission for stale reads.
