# Planned refactoring execution

Branch: `refactor/planned-project`; base: `f89ebf56` (2026-09-06).

Sources: [refactoring plan](../2026-09-02-refactoring-plan.md),
[ports-and-adapters plan](../2026-09-05-ports-and-adapters-plan.md).
Each implementation change keeps ordered slices and fresh evidence in its own
`tasks.md` and `verify.md`. Historical completion claims require code inspection.

## Execution queue

- [x] Create isolated worktree and branch; install locked dependencies.
- [ ] Establish baseline tests and current collision inventory.
- [ ] W4-4: extract table modules while preserving the live cell contract.
- [ ] R1: plan refresh coordinator; after W4-4, before client migration.
- [ ] R2: team removal revisions and audit stamps; before R6/store migration.
- [ ] R3: authentication storage fault boundary; before auth endpoint migration.
- [ ] R4: validate WebSocket ingress; before R7/R9 gateway edits.
- [ ] R5: reserve login capacity; after R3, before auth endpoint migration.
- [ ] R6: project-scoped assignments and assigned names; after R2.
- [ ] R7: project-scoped presence delivery; after R4.
- [ ] R8: bounded replay-buffer sweep; before store/runtime extraction.
- [ ] R9: bounded gateway transport deadlines; after gateway/auth owners release files.
- [ ] R10: measured viewport rendering and search isolation; after W4-4/R1.
- [ ] HTTP Wave 0: reconcile landed features and routes; inventory collision paths.
- [ ] HTTP Wave 1: shared endpoint shapes, adapter, document and typed clients.
- [ ] Store Wave 2: ports, write coordinator, unit of work, runtime ports and kits.
- [ ] Core Wave 3: extract packages and enforce rings with negative proofs.
- [ ] Namespacing: move packages and update gates.
- [ ] Review each implementation and resolve findings.
- [ ] Merge latest feature-bearing main into this branch; resolve semantic conflicts.
- [ ] Freeze final tree; full workspace/browser gates and whole-branch review.

## Integration policy

Feature work remains on `main`. This branch receives feature commits before its
final gates; it is not merged into `main` automatically. Parallel workers own
disjoint files, and all broad measurements require a frozen tree. Browser runs
must own their ports and cannot reuse another checkout's server.

The audit found TASK-262 already supplies framework-free routes and two binders;
those are reused and adapted, not reimplemented. The old handoff's excluded spec
projects no longer match current typecheck configuration; baseline output decides
whether those projects now pass.
