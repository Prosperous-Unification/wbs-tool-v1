# Optimized scheduler — durable work map

Reconciled 2026-09-08 against `main@990ab4ae`. The live authority is
`openspec/changes/dual-optimized-scheduler/`: proposal, design, tasks,
verification, supervisor amendment and delta specification. Its checklist has
91 checked and 20 unchecked entries at this revision; a checkbox is navigation,
not evidence that behavior is present or absent.

## Landed task map

| Task                | Subject                                            | PR            |
| ------------------- | -------------------------------------------------- | ------------- |
| TASK-219 / TASK-254 | dual-objective solver and published-priority bound | #203          |
| TASK-220            | optimized coordinator cache                        | #216          |
| TASK-221            | schedule-selector comparison                       | #246          |
| TASK-260            | tied-sibling read order                            | #215          |
| TASK-261            | scheduler corpus and floor audit                   | #210          |
| TASK-268            | Retry and optimizer hardening                      | #253 and #276 |
| TASK-292            | dev deploy and solver supervisor preflight         | #250          |
| TASK-297            | solver quantum pinned in the schema                | #297          |

Remote branches for squash-merged PRs are not ancestors of `main`; `git branch
--no-merged` and `git cherry` therefore do not prove their work is absent.

## Recovered optimizer branch

The September 7 host scan preserved 19 previously local commits at
`wip/optimizer-terminal-minors-local-20260907`, tip `d7bcef41`. They cover Retry
failure stamping, recovery ownership, admission write fencing, bounded recovery
artifacts, the managed Bun pin, Docker cleanup edges and interrupted candidate
pruning.

They are useful provenance for the OpenSpec verification record, but no code is
owed from the branch. On this reconciliation:

- `optimization-generation.ts` and the real supervisor lifecycle process test
  have identical blob ids on the recovered branch and `main`;
- the coordinator differs only by current formatting;
- current supervisor lifecycle code adds later host-admission serialization and
  cleanup evidence; and
- #303 broadened the interrupted-candidate prune into a complete target commit
  candidate tree.

Do not merge or mechanically rebase the recovered branch. Re-read its commits
only when auditing the corresponding proof in the live OpenSpec record.

## Refactoring relationship

HTTP Wave 1 is merged and Ports Wave 2 is in progress under
`docs/2026-09-05-ports-and-adapters-plan.md`. Its landed Gate, UnitOfWork and
EventLogStore slices preserve the scheduler collision constraints recorded in
`docs/refactoring/collisions.md`. Host deployment state and queue status are
runtime observations and do not belong in this repository map.
