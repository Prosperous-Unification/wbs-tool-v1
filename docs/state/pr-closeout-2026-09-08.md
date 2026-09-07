# Open pull-request closeout — 2026-09-08

This record decides the disposition of PRs #311, #308, #307, #302 and #67
against `main@5bb095a5`. The refactoring plans remain authoritative; this file
records why historical branches were merged, re-derived or closed.

| PR                            | Decision              | Relationship to current plans                                                                                                                                                    | Current-main action                                                                                                                                              |
| ----------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #311, salvage index           | Re-derive, then close | The branch-to-task provenance helps recover work, but its count is misstated and its unknown disposition for #67 was resolved by #313. It is recovery history, not a task queue. | Preserve a corrected, dated inventory in `salvage-index-2026-09-07.md`.                                                                                          |
| #308, scheduler consolidation | Re-derive, then close | The task-to-PR map and recovered optimizer branch help navigate `dual-optimized-scheduler`; host and queue status claims became stale after #303.                                | Preserve stable provenance in `scheduler-work-consolidation.md`; defer live status to the OpenSpec tasks and verification record.                                |
| #307, transport pin           | Merged                | The full-scope refresh had a method-level pin that could not see requests inside a method. HTTP Wave 1 did not remove that gap.                                                  | PR #307 added the exact request multiset over the real `httpProjectApi` object and proved both an extra request and a type-compatible directory miswire fail it. |
| #302, corpus boundary         | Merged, then harden   | The merged PR added merge-queue coverage and fixed push and dispatch boundaries, but its pull-request path retained a mutable branch fallback when the immutable SHA was absent. | Keep its event coverage and concurrency rule; move selection into a fail-closed executable hook and test every production boundary against real Git histories.   |
| #67, multi-team engine        | Keep closed           | The behavior landed through TASK-182 / #175 and the missing OpenSpec record landed through #313. Review found one claimed fixpoint case absent from current coverage.            | Restore the alternating-pool re-ask case on the current domain engine and correct the archived verification record.                                              |

No domain term or hard-to-reverse decision changes here, so `CONTEXT.md` and
the ADR set do not change. Ports Wave 2 is underway: its Gate, UnitOfWork and
EventLogStore slices are on `main`; this closeout changes none of them.
Scheduler runtime seams remain a named collision in `docs/refactoring/collisions.md`.
