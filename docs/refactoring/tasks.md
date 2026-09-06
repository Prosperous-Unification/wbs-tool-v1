# Planned refactoring execution

Branch: `refactor/planned-project`; base: `f89ebf56` (2026-09-06).

Sources: [refactoring plan](../2026-09-02-refactoring-plan.md),
[ports-and-adapters plan](../2026-09-05-ports-and-adapters-plan.md).
Each implementation change keeps ordered slices and fresh evidence in its own
`tasks.md` and `verify.md`. Historical completion claims require code inspection.

## Execution queue

- [x] Create isolated worktree and branch; install locked dependencies.
- [x] Establish baseline unit tests and current collision inventory (full gates pending).
- [ ] W4-4: table modules committed (`281144a9`), 601 concept tests and review passed; full gates pending.
- [ ] R1: implemented/reviewed and integrated (`35576d79`), 220 focused regressions passed; full gates pending.
- [ ] R2: team removal revisions and audit stamps — implementation/review/typecheck done (`e9141949`); full gate pending.
- [ ] R3: authentication storage fault boundary — implementation/review/typecheck done (`271500c4`); full gate pending.
- [ ] R4: ingress committed (`ae1fc858`), 337 scoped tests and review passed; composed gate pending.
- [ ] R5: login admission committed (`47167984`), 131 scoped tests/review/typecheck passed; full gate pending.
- [ ] R6: scoped queries committed (`20801719`), scoped tests/review/typecheck passed; full gate pending.
- [ ] R7: scoped presence implemented/reviewed and integrated (`96c2cd6e`); 342 scoped tests passed, full gate pending.
- [ ] R8: bounded replay sweep committed (`5793763e`), 31 scoped tests/review passed; full gate pending.
- [ ] R9: backend/gateway cancellation implemented/reviewed and integrated (`d13b0330`, `f594a8fa`); full gates pending.
- [ ] R10: implementation started in isolated `refactor/measured-rendering`; preparing Chromium measurement fixtures.
- [ ] HTTP Wave 0: route/refusal/origin inventories and compiler baseline recorded; promotion reconciliation underway.
- [ ] HTTP Wave 1: shared endpoint shapes, adapter, document and typed clients.
- [ ] Store Wave 2: ports, write coordinator, unit of work, runtime ports and kits.
- [ ] Core Wave 3: extract packages and enforce rings with negative proofs.
- [ ] Namespacing: move packages and update gates.
- [ ] Review each implementation and resolve findings.
- [ ] Main `bf69132d` merged without conflicts and reviewed; 2610 backend/auth/domain/solver tests and forced BE/FE types passed. Fetch again before final gates.
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
