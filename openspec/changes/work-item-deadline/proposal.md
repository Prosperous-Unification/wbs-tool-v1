<!--
INTENT. Hard cap: 400 words excluding these comments. Change name is proposal.md (OpenSpec CLI hardcodes it).
-->

## Why

A plan can say when work may **start** (`start_no_earlier_than`) and cannot say when it must **finish**. Every deadline in a WBS today lives outside the tool, so no schedule — Fast or optimized — can tell the user they are late, and the optimizer has no way to be told that a date is not negotiable.

## What Changes

**One field, one name**

- From: nothing.
- To: `deadline`, nullable and date-only, on any work item, leaf or parent. **Work item deadline** in UI copy, `deadline` in domain, database, API, canonical input, events and solver wire. No `finishNoLaterThan` or other alias.

**Inclusive, against the End date already printed**

- From: n/a.
- To: the normative predicate is `lastWorkdayOf(start, finish) <= deadlineOffset` — the same arithmetic behind the End column — not `finish <= deadline`. Conversion is a **new** `deadlineOffsetOf`, because `workdaysBetween` rolls a non-working date forward and clamps a pre-start date to zero: safe for a floor, a silently relaxed ceiling here.

**Hierarchy**

- From: n/a.
- To: a leaf's deadline constrains its last slice; a parent's constrains every leaf in its subtree; where both apply the earliest wins. Empty subtrees constrain nothing.

**Fast stays best-effort**

- From: ready work ordered by priority tie-breaks.
- To: minimum slack, then earliest effective deadline, then the existing tie-breaks. Misses report `Late by N workdays`. A missed Fast deadline is never presented as a satisfied optimized baseline.

**PRI and Time gain a hard constraint**

- From: two objectives over an unconstrained feasible set.
- To: every effective deadline is `startUnits + max(durationUnits, 1) <= (D + 1) × quantum`, added before the objective terms. `max(·, 1)` is what keeps a zero-duration milestone inside its own day.

**`plan-infeasible` is a real answer**

- From: solver outcomes are `ok` or a failure.
- To: `plan-infeasible` is a typed, cached state naming every offending work item and its **effective** deadline. It never shows `Retry`. Malformed or deadline-violating solver output remains `invalid-output`, an engine failure.

**Contract**

- From: six canonical-input arguments.
- To: seven. `SCHEDULER_CONTRACT_VERSION` bumps, which evicts every cache row; the Fast golden corpus must be byte-identical under an empty deadline map.

## Impact

`work_item.deadline` migration (**prod mode**, reviewed PR, isolated slice). Amends `dual-optimized-scheduler`: canonical input, wire schema, status matrix, revalidator, retention. Renames TASK-221's `Same deadline …` copy to `Same project deadline …`.
