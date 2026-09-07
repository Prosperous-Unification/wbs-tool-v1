## Historical Implementation

The original August checklist is represented here by the behavior that is
present on `main`. The implementation landed through TASK-182 / PR #175 rather
than PR #67.

- [x] Change `Slice.poolId` to `poolIds` and update all engine callers.
- [x] Reserve a block's whole width in every sized effective-team pool.
- [x] Add the joint-window fixpoint over the single-pool window search.
- [x] Accumulate blockers across pools and fixpoint rounds.
- [x] Re-ask every pool after another pool advances the candidate.
- [x] Clamp width to the narrowest sized effective team.
- [x] Name the binding team on capacity-floored slices.
- [x] Keep capacity predecessors causal and public float non-negative.
- [x] Preserve the single-pool identity contract and multi-pool corpus checks.
- [x] Carry `capacityTeamId` through the response and Gantt explanation.

## TASK-364 Record Reconciliation

- [x] Re-read `libs/domain/src/schedule.ts` at
      `main@0cb148afe85fb307effb7e4bae90968d65177b6b` and confirm
      `poolIds: readonly string[]` plus the joint search and reservation paths.
- [x] Locate current focused coverage at
      `libs/domain/src/schedule-joint-capacity.test.ts` and trace it through PR
      #175 to August commit `d8a09ce2`.
- [x] Correct the stale claims about code/test absence, production arity,
      engine location, UI readership, and PR #67's authority.
- [x] Restore the proposal, design, delta specification, tasks, and verification
      record directly under the archive.
- [x] Run the focused remote green gate and a matching remote negative control.
- [x] Validate the recovered OpenSpec record on h2puni.
- [ ] Land TASK-364 through a new PR, then close historical PR #67.
