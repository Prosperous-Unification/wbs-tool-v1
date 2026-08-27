# A multi-team work item spends every named team's pool

Dany's 2026-08-27 approval that a work item may explicitly carry several teams
reverses the 2026-08-15 one-team decision and restores the earlier multi-team
meaning: the effective team set is one indivisible label set, and a scheduled
slice spends its width in every named team that has a stated capacity. It starts
only where all such pools have room and clamps its width to the narrowest one;
empty remains unstated and inherits. This uses the completed, previously closed
PR #67 design as the behavioral oracle, while TASK-182 implements against current
main and receives fresh gates and review.
