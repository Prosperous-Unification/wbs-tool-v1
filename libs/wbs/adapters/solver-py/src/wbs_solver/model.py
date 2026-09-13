"""The CP-SAT model and the three cost terms (tasks.md 5.2, first half).

WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT
----------------------------------------------------
This builds the constraint system and expresses `MAKESPAN`, `PRIORITY` and
`MOVEMENT` over its variables. It runs no solve, chooses no objective order and
knows nothing about stages: the staged lexicographic loop and design.md's
stage-status matrix are `solve.py`. The split is not tidiness — the matrix's
rows constrain a term *after* a stage has proved something about it, so the
terms have to be addressable objects before any staging code can exist, and a
module that both built and solved would have no seam at which to assert the
model alone is right.

THE CONSTRAINT SET IS READ OFF THE RE-VALIDATOR, NOT INVENTED HERE
------------------------------------------------------------------
`libs/contracts/solver/src/revalidate-solver-result.ts` is the Bun half of the
same contract: it re-derives every constraint from the request and refuses the
response when the returned offsets break one. Any rule this model is missing is
a solve that succeeds and is then thrown away as `invalid-output`; any rule this
model adds is a plan reported infeasible that Bun would have accepted. So each
constraint below names the re-validator clause it mirrors, and the two files are
meant to be read side by side.

Six clauses, in the re-validator's own order:

1. **Offset domain** — `0 <= start <= horizonUnits` (`offset-domain`). The
   horizon bounds the *start*, not the finish; a finish past the horizon is
   legal and is the makespan's business. `horizonUnits` is the serial bound
   `max(0, ...notBefore) + Σ duration`, so no feasible placement is excluded.
2. **Floors** — `start >= notBeforeUnits` (`floor-violated`), folded into the
   variable's own domain rather than added as a constraint: it is the same
   statement and it gives the presolve a tighter start.
3. **Edges** — `finish(pred) <= start(succ)` (`edge-violated`). Closed-then-open:
   a slice finishing exactly where its successor starts is a hand-off.
4. **Pools** — one `AddCumulative` per pool, demand `width`, capacity
   `pools[poolId]` (`pool-overcapacity`). The whole width is spent in *every*
   pool a slice names, so a two-pool slice is counted at full width in both.
5. **Assignees** — one `AddNoOverlap` per non-null `personId`
   (`assignee-double-booked`). A person is not a quantity: two slices naming one
   person overlap or they do not, whatever their widths.
6. **Deadlines** — `end + int(workItemIsMilestone) <= deadlineUnits` when non-null.
   A whole work item made only of zero-duration slices occupies the unit in
   which it stands. A zero step beside positive work does not extend that work
   item's projected span into the next unit. Bun carries the same clause
   in the real fractional domain, through the shared `isOnTime` predicate, in
   `revalidateOptimizedDeadlines` — a second entry point beside
   `revalidateSolverResult` rather than part of it. This is the clause that
   makes design.md's `INFEASIBLE, k = 1` row mean what it says.
   Deadlines enter the model *before* any objective term, so stage 1 is the one
   stage whose infeasibility can be a property of the user's plan rather than of
   the engine.

ZERO-DURATION SLICES OCCUPY NOTHING
-----------------------------------
A zero `durationUnits` is legal and is a real plan state. The re-validator's
sweep drops zero-length placements before counting, "because a pair at one
instant has no ordering that is both non-negative and non-occupying", so a
zero-duration slice can never oversubscribe a pool or double-book a person there
and must not be able to here either. It is therefore excluded from the interval
list feeding clauses 4 and 5 — not given a zero-size interval and left to
CP-SAT's own zero-length reading, which is a different decision made by a
different piece of software. It still has a start, an end, a floor, a deadline,
its edges and its full weight in all three cost terms.

THE TERMS ARE VARIABLES, NOT EXPRESSIONS
----------------------------------------
Each term is a bounded `IntVar` pinned to its definition by an equality, rather
than a `LinearExpr` handed to `Minimize`. The matrix needs to *constrain* a term
after a stage — `Tₖ = v` for OPTIMAL, `Tₖ <= v` otherwise — and a linear
expression cannot carry `MOVEMENT`'s absolute values, which need their own
variables regardless. One shape for all three keeps `solve.py` free of
per-term special cases, which is exactly where a lexicographic order gets
silently reordered.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from ortools.sat.python import cp_model

# The three term names, spelled exactly as `solver-wire.v1.json`'s
# `objectiveValues` spells them. Lowercase is derived rather than chosen: the
# schema's own `$comment` records that `MAKESPAN`/`PRIORITY`/`MOVEMENT` in
# design.md are mathematical names and these are the JSON keys.
MAKESPAN = "makespan"
PRIORITY = "priority"
MOVEMENT = "movement"

TERMS: tuple[str, str, str] = (MAKESPAN, PRIORITY, MOVEMENT)

# The lexicographic order each objective minimises, from the request's
# `objective` enum. `solver-wire.v1.json`: "pri minimises (PRIORITY, MAKESPAN,
# MOVEMENT) lexicographically; time minimises (MAKESPAN, PRIORITY, MOVEMENT)".
# MOVEMENT is last in both, which is why it is a tie-breaker and never a driver.
STAGE_ORDER: Mapping[str, tuple[str, str, str]] = {
    "pri": (PRIORITY, MAKESPAN, MOVEMENT),
    "time": (MAKESPAN, PRIORITY, MOVEMENT),
}


@dataclass(frozen=True)
class BuiltModel:
    """A model, its placement variables, and its three cost terms.

    `starts` and `ends` are keyed by slice key in the request's own slice order,
    which is the order `offsets` is emitted in. `terms` is keyed by the three
    wire spellings above.
    """

    model: cp_model.CpModel
    starts: dict[str, cp_model.IntVar]
    ends: dict[str, cp_model.IntVar]
    terms: dict[str, cp_model.IntVar]
    keys: tuple[str, ...]


def stage_order(objective: str) -> tuple[str, str, str]:
    """The three terms in the order this objective minimises them.

    Raises on an unknown objective rather than defaulting to one: the schema's
    enum already refused everything else, so reaching here with a third value
    means the schema and this module disagree, and picking a silent default
    would answer a different question than the caller asked.
    """
    try:
        return STAGE_ORDER[objective]
    except KeyError:  # pragma: no cover - unreachable behind the schema
        raise ValueError(f"unknown objective {objective!r}") from None


def build_model(request: Mapping[str, Any]) -> BuiltModel:
    """Build the constraint system and the three cost terms for one request.

    The request is assumed already validated — schema plus the four cross-field
    checks in `validate.py`. This function re-derives nothing about
    well-formedness and would build a nonsense model from a nonsense request,
    which is why `cli.main` validates first and unconditionally.
    """
    model = cp_model.CpModel()
    slices: Sequence[Mapping[str, Any]] = request["slices"]
    horizon: int = request["horizonUnits"]
    pools: Mapping[str, int] = request["pools"]
    baseline: Mapping[str, int] = request["baselineOffsets"]
    hint: Mapping[str, int] = request["fastHint"]

    keys = tuple(str(s["key"]) for s in slices)
    starts: dict[str, cp_model.IntVar] = {}
    ends: dict[str, cp_model.IntVar] = {}
    intervals: dict[str, cp_model.IntervalVar] = {}

    for entry in slices:
        key = str(entry["key"])
        duration = int(entry["durationUnits"])
        floor = int(entry["notBeforeUnits"])
        # Clause 1 and clause 2 in one domain. The upper bound is the horizon
        # because that bounds the start; the end's upper bound is therefore
        # `horizon + duration` and is deliberately not clamped back to the
        # horizon, which would refuse placements the re-validator accepts.
        start = model.new_int_var(floor, horizon, f"start[{key}]")
        end = model.new_int_var(floor + duration, horizon + duration, f"end[{key}]")
        model.add(end == start + duration)
        starts[key] = start
        ends[key] = end

        # Clause 6. `deadlineUnits` is the effective deadline, already folded
        # over the tree and already converted to (D + 1) × quantum. It bounds
        # the work item's projected finish. A work item made only of zero steps
        # is itself a milestone and gets one synthetic unit of occupancy.
        #
        # `end <= deadline` alone admits a milestone standing exactly ON the exclusive
        # `(D + 1) × quantum` boundary — which is the first instant of day
        # `D + 1`, a day past the deadline. The domain predicate
        # (`libs/domain/src/on-time.ts`, via `lastWorkdayOf`) reads that
        # milestone as occupying day `D + 1` and late, and Bun re-validates with
        # that reading. The two forms therefore disagreed, and the disagreement
        # surfaced the wrong way round: the solver called the plan feasible, Bun
        # refused the response as `deadline-violated`, and a deterministic
        # `plan-infeasible` verdict was reported as `invalid-output` and fell
        # back. `workItemIsMilestone` carries the distinction Bun derives while
        # it still has the work-item grouping; Python does not reconstruct it.
        deadline = entry["deadlineUnits"]
        if deadline is not None:
            model.add(end + int(entry["workItemIsMilestone"]) <= int(deadline))

        # Occupancy, for clauses 4 and 5 only. See the module docstring: a
        # zero-duration slice occupies nothing and gets no interval at all.
        if duration > 0:
            intervals[key] = model.new_interval_var(start, duration, end, f"span[{key}]")

        # 5.9's solution hint. The bound half of 5.9 belongs to the staging loop,
        # because it constrains stage 1's term and no term exists until below.
        # A hint is advice: CP-SAT is free to ignore it, so an infeasible hint
        # costs search time and never a wrong answer.
        if key in hint:
            model.add_hint(start, int(hint[key]))

    # Clause 3.
    for edge in request["edges"]:
        predecessor = str(edge["predecessorKey"])
        successor = str(edge["successorKey"])
        model.add(ends[predecessor] <= starts[successor])

    # Clause 4. One cumulative per pool, over the members that name it. A pool
    # nobody references is absent from this loop and constrains nothing, which
    # is what an unreferenced capacity means.
    for pool_id, capacity in pools.items():
        members = [
            (intervals[str(entry["key"])], int(entry["width"]))
            for entry in slices
            if pool_id in entry["poolIds"] and str(entry["key"]) in intervals
        ]
        if members:
            model.add_cumulative(
                [interval for interval, _ in members],
                [width for _, width in members],
                int(capacity),
            )

    # Clause 5.
    by_person: dict[str, list[cp_model.IntervalVar]] = {}
    for entry in slices:
        person = entry["personId"]
        key = str(entry["key"])
        if person is None or key not in intervals:
            continue
        by_person.setdefault(str(person), []).append(intervals[key])
    for members in by_person.values():
        if len(members) > 1:
            model.add_no_overlap(members)

    terms = _build_terms(model, slices, starts, ends, baseline, horizon)
    return BuiltModel(model=model, starts=starts, ends=ends, terms=terms, keys=keys)


def _build_terms(
    model: cp_model.CpModel,
    slices: Sequence[Mapping[str, Any]],
    starts: Mapping[str, cp_model.IntVar],
    ends: Mapping[str, cp_model.IntVar],
    baseline: Mapping[str, int],
    horizon: int,
) -> dict[str, cp_model.IntVar]:
    """The three cost terms, each an `IntVar` equal to its definition.

    Written to match `recomputeObjectives` in the re-validator statement for
    statement, because Bun recomputes all three from the published offsets and
    refuses the response on a one-unit disagreement. `finish` there is
    `start + durationUnits`, which is `ends[key]` here.
    """
    finish_ub = {
        str(entry["key"]): horizon + int(entry["durationUnits"]) for entry in slices
    }

    # MAKESPAN = max finish. `AddMaxEquality` rather than a chain of `>=`: the
    # matrix installs `Tₖ = v` after an OPTIMAL stage, and a term defined only by
    # lower bounds would let that equality be satisfied by a schedule whose real
    # maximum is smaller — an equality on a relaxation is not an equality.
    makespan = model.new_int_var(0, max(finish_ub.values(), default=0), "makespan")
    model.add_max_equality(makespan, [ends[key] for key in finish_ub])

    # PRIORITY = Σ priorityWeight(s) · finish(s).
    priority_ub = sum(
        int(entry["priorityWeight"]) * finish_ub[str(entry["key"])] for entry in slices
    )
    priority = model.new_int_var(0, priority_ub, "priority")
    model.add(
        priority
        == sum(
            int(entry["priorityWeight"]) * ends[str(entry["key"])] for entry in slices
        )
    )

    # MOVEMENT = Σ |start(s) − baselineOffsets[s]|. Each absolute value is its
    # own variable pinned with `AddAbsEquality`, not a pair of `>=` bounds: the
    # relaxation is only sound while the term is being minimised, and the matrix
    # also *constrains* this term in later stages, where a relaxation would admit
    # a deviation larger than the one it reports.
    deviations: list[cp_model.IntVar] = []
    movement_ub = 0
    for entry in slices:
        key = str(entry["key"])
        base = int(baseline[key])
        # The start is in `[notBefore, horizon]`, so the furthest it can sit
        # from the baseline is whichever end of that range is further away.
        span = max(base, horizon - base)
        movement_ub += span
        deviation = model.new_int_var(0, span, f"movement[{key}]")
        model.add_abs_equality(deviation, starts[key] - base)
        deviations.append(deviation)
    movement = model.new_int_var(0, movement_ub, "movement")
    model.add(movement == sum(deviations))

    return {MAKESPAN: makespan, PRIORITY: priority, MOVEMENT: movement}
