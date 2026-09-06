# Verification

2026-09-06, refactoring worktree. No commit or broad gate run by this worker.

## Scoped runs

- Initial production tree/write query regressions: 0 pass, 2 fail. Tree materialized 41 assignments; the write replay materialized 40 unrelated assignments, each against an independent budget of 1.
- `bun test apps/be-01/src/repository/assignment-scope.db.test.ts apps/be-01/src/service/work-item.service.test.ts`: 100 pass, 0 fail, 234 assertions.
- Directory/query, work-item service, undo, directory service, capacity identity and priority identity suites: 258 pass, 0 fail, 10,870 assertions across 7 files. The initial command also named a nonexistent `service/saved-plan.db.test.ts` filter, which Bun silently did not collect; saved-plan coverage was then run explicitly below.
- `bun test apps/be-01/src/repository/saved-plan-capture.db.test.ts apps/be-01/src/repository/saved-plan-in-transaction.db.test.ts apps/be-01/src/service/saved-plan.service.db.test.ts apps/be-01/src/repository/assignment-scope.db.test.ts`: 35 pass, 0 fail, 167 assertions, after restoring all injected faults and switching capture to the project assignment projection.
- Final targeted ESLint across all ten changed repository/service/fixture files: exit 0.
- Prettier formatting completed for all changed files.
- `openspec validate project-assignment-reads --strict`: valid, exit 0; optional telemetry flush then reported DNS failure for edge.openspec.dev.
- `git diff --check`: exit 0.
- Parent-owned backend typecheck and workspace gate pending. No browser/deployment changes or checks.

## Failure proofs

Every fault was restored before subsequent checks. The row-count oracle records SELECTs issued by the production operation, then executes those statements against the same migrated fixture database and examines EXPLAIN QUERY PLAN. It does not assert a WHERE string. For the assignment write, replay occurs after the unassignment: the old global query sees 40 unrelated assignments rather than the original 41; the unindexable-predicate negative separately catches a scan whose final result is empty.

| Fault injected                                                                                                         | Test                                                                      | Actual observation                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| Restore the global assignment query and filter its returned rows to the project afterward, preserving the tree payload | materializes only assigned project rows and names during a tiny tree read | Expected at most 1 materialized row; received 41    |
| Restore listPeople() plus assigned-id filtering, preserving the tree payload                                           | same tree test                                                            | Expected at most 1 materialized person; received 41 |
| Remove single-work-item assignment predicate                                                                           | uses an indexed prior assignment read during one assignment write         | Expected at most 1 materialized row; received 40    |
| Replace indexed equality with work_item_id concatenated with the empty string, preserving query output                 | same assignment-write test                                                | SEARCH-plan assertion expected true; received false |
| Remove project filtering from the memory fixture                                                                       | names only the people assigned in the requested project                   | Received grace alongside ada for the first project  |

An initial index fault using a raw NOT INDEXED table expression failed in Drizzle's table membership validation, before the query oracle; it was discarded as evidence and replaced by the unindexable equality above.

## Scope and limits

No migration is needed: project reads use work_item_project_id_id, assignment's primary key, and person's primary key. Existing subset compatibility uses one indexed query per distinct requested work item; whole-project tree and capture paths use the joined project projection. Directory capture remains global deliberately, preserving saved-plan history. No load-latency or memory-budget claim was measured.

Parent checkpoint: `bunx nx typecheck be-01 --skip-nx-cache` (source and spec
projects) passed with R5/R6 held unchanged. Log:
`/private/tmp/wbs-refactoring-r5-r6-typecheck.log`. Independent review approved
after the saved-plan capture JSDoc correction; scoped re-review found no remaining
findings. Implementation committed as `20801719`; full workspace gate pending.
