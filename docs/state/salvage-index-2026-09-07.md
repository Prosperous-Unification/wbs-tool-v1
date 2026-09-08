# Salvage inventory — 2026-09-07 host scan

This is a dated recovery record, not a claim about current host state. The scan
preserved every worktree head it found on a remote branch. Squash merging means
commit ancestry and `git cherry` cannot by themselves distinguish missing work
from pre-squash history.

## Plan-relevant preserved refs

| Preserved ref                                          | Owning work         | Decision on 2026-09-08                                                                            |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------- |
| `wip/optimizer-terminal-minors-local-20260907`         | TASK-312 / TASK-320 | All 19 commits' behavior and proofs are on current `main`; retain as scheduler provenance only.   |
| `wip/salvage-ws-auth-review-20260907`                  | TASK-161 review     | Retain as review provenance. The shipped authentication and deploy runbooks remain authoritative. |
| `wip/salvage-corpus-version-lint-watched-red-20260907` | TASK-338 control    | Retain because the CI proof cites this real-history negative control.                             |
| `wip/salvage-deadline-copy-normative-20260907`         | TASK-241            | Consult only from the live `work-item-deadline` change; do not merge the stale branch.            |
| `wip/salvage-capacity-fit-spike-20260907`              | capacity-fit spike  | Historical experiment; `docs/capacity.md` and the scheduler OpenSpec own current behavior.        |
| `wip/salvage-resource-model-20260907`                  | resource model      | Historical input to `docs/plans/2026-08-09-resource-planning.md`; no direct merge.                |
| `wip/salvage-h2puni-capacity-review-20260907`          | capacity review     | Review provenance only; current capacity behavior and tests decide any reuse.                     |
| `wip/salvage-multi-team-engine-closed-pr67-20260907`   | TASK-364 / PR #67   | Superseded: behavior landed through #175 and the reconciled OpenSpec archive through #313.        |

Other `wip/salvage-*` refs from the scan are pre-squash merged history,
conflicted working state, review snapshots or completed-task residue. Their
remote preservation is sufficient; they are not inputs to the current
refactoring or product plans unless a named verification record cites them.

The original scan described 50 `wip/salvage-*` branches. The fetched namespace
actually contains 49 with that prefix plus the separately named
`wip/optimizer-terminal-minors-local-20260907`. This record uses the refs rather
than preserving the incorrect aggregate.
