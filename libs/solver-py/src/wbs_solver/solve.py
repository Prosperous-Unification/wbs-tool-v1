"""The staged lexicographic loop (tasks.md 5.2, second half).

THE MATRIX IS THE AUTHORITY AND THIS MODULE IS ITS TRANSCRIPTION
----------------------------------------------------------------
design.md's stage-status matrix decides, for every stage outcome, what
constraint the later stages carry, whether staging continues, what is published
and what each term reports. `tasks.md` 5.2 and 5.8 say in as many words that they
restate none of it. Neither does this docstring: every rule below is a lookup,
and where the code needs a sentence it names the row rather than paraphrasing
it. The one thing worth saying here is *why* it is one table — two rules that
could pick different outcomes for the same run is the defect the matrix was
written to close.

WHAT CP-SAT ACTUALLY RETURNS, AND THE ONE ROW THAT COLLAPSES
-------------------------------------------------------------
The matrix distinguishes `FEASIBLE, incumbent v` from `UNKNOWN with incumbent
v`, because it is written for the general anytime contract and some solvers
report an incumbent alongside an unknown verdict. CP-SAT does not: it answers
`FEASIBLE` whenever the search found a solution and stopped before proving
optimality, and `UNKNOWN` only when it found none. **The two rows are not in
conflict about that** — they prescribe the identical constraint `Tₖ ≤ v` and the
identical per-term `status: 'feasible'` — so this module keys on *whether the
stage produced an incumbent* rather than on which of the two names the solver
used, and the collapse changes no outcome. The rows that genuinely differ are
the two `UNKNOWN, no incumbent` rows and the two `INFEASIBLE` rows, and both
pairs differ only by `k`, which is tracked explicitly.

A LATER-STAGE INFEASIBLE IS NOT A RESPONSE
------------------------------------------
`INFEASIBLE, k > 1` is the one outcome with no encoding on the wire, decided in
the response schema's own `$comment`: every constraint a later stage adds is
already satisfied by the previous incumbent, so reaching it means the solver
holds a counterexample to its own answer. It raises, `cli.main` turns that into a
non-zero exit with nothing on stdout, and the coordinator records the run as
`invalid-output` — which is the disposition the matrix assigns that row anyway.

THE BUDGET IS A WORST CASE PER STAGE, NOT A RESERVATION
--------------------------------------------------------
`stageBudgetSplit` is dimensionless fractions of `budgetMs`, and a stage that
finishes early donates its remainder to the next (design.md; the Bun half is
`stage-budget.ts`). Donation is measured from the solver's own `wall_time`
rather than from a clock read here, so a stage that returns instantly hands its
whole share forward and the three shares are shares of a worst case.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from ortools.sat.python import cp_model

from .model import MAKESPAN, MOVEMENT, PRIORITY, TERMS, build_model, stage_order

WIRE_VERSION = 1

# Response-level statuses. A RUN-OUTCOME vocabulary of exactly three values, and
# a different question from the per-term status: this one says whether a
# schedule is being returned at all. `optimal` is deliberately absent — see
# solver-wire.v1.json's response `$comment`.
STATUS_FEASIBLE = "feasible"
STATUS_UNKNOWN = "unknown"
STATUS_INFEASIBLE = "infeasible"

# Per-term statuses, from the matrix's last column. Proof strength, never a
# claim about the published schedule.
TERM_OPTIMAL = "optimal"
TERM_FEASIBLE = "feasible"
TERM_UNKNOWN = "unknown"


# The matrix's own rows, named by what they make this module do. `solve_request`
# is a dispatch over these and decides nothing itself, so a row's behaviour can
# be read in one place and asserted as an argument rather than reproduced.
ROW_EQUALITY = "equality"  # OPTIMAL: constrain `Tₖ = v`, continue
ROW_BOUND = "bound"  # FEASIBLE / UNKNOWN-with-incumbent: `Tₖ ≤ v`, continue
ROW_STOP_NO_SOLUTION = "stop-no-solution"  # UNKNOWN, no incumbent, k = 1
ROW_STOP_PUBLISH = "stop-publish"  # UNKNOWN, no incumbent, k > 1
ROW_STOP_PLAN_INFEASIBLE = "stop-plan-infeasible"  # INFEASIBLE, k = 1
ROW_STOP_INVALID = "stop-invalid"  # INFEASIBLE, k > 1, and anything unmapped


def stage_disposition(status: int, stage: int, has_incumbent: bool) -> str:
    """Which matrix row a stage outcome lands on.

    Pure, and exported for that reason: four of the six rows are unreachable
    through a real solve on a fixture small enough to be an oracle — a budget
    that reliably exhausts is the flake 5.6 exists to avoid, and a later-stage
    INFEASIBLE cannot be produced at all without a wrong model. Keeping the
    decision in a function over three scalars is what lets every row be asserted
    as an argument instead of reproduced in prose.

    `has_incumbent` is passed rather than derived from `status` because the
    matrix distinguishes `UNKNOWN` with and without one. CP-SAT never reports
    the first — it answers `FEASIBLE` when the search found a solution and
    stopped early — but the two rows prescribe identical behaviour, so honouring
    the flag costs nothing and the collapse is a property of this solver rather
    than of the table.
    """
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) or (
        status == cp_model.UNKNOWN and has_incumbent
    ):
        return ROW_EQUALITY if status == cp_model.OPTIMAL else ROW_BOUND
    if status == cp_model.UNKNOWN:
        return ROW_STOP_NO_SOLUTION if stage == 1 else ROW_STOP_PUBLISH
    if status == cp_model.INFEASIBLE:
        return ROW_STOP_PLAN_INFEASIBLE if stage == 1 else ROW_STOP_INVALID
    # MODEL_INVALID and anything a future OR-Tools adds. Not a matrix row: the
    # matrix's four statuses are the whole vocabulary it was written against, so
    # a fifth is this package disagreeing with its solver and is never a
    # schedule.
    return ROW_STOP_INVALID


class SolveFailed(Exception):
    """The run cannot produce a response the wire can carry.

    Raised only where the matrix's disposition is `invalid-output`: a later-stage
    INFEASIBLE, or a model CP-SAT refuses outright. `cli.main` exits non-zero
    with the message on stderr and nothing on stdout.
    """


@dataclass(frozen=True)
class SolverConfig:
    """Per-process solver settings, which are deliberately not on the wire.

    `solver-wire.v1.json` is closed (`additionalProperties: false`) and carries
    no search-worker, seed or determinism field, and its own `$comment` records
    the precedent: the lifecycle wrapper's `childDeadlineAt` and `attemptToken`
    are *process* arguments rather than message fields. These are the same kind
    of thing — how this process searches, not what it is asked to solve — so
    they stay a constructor argument here.

    `num_search_workers` defaults to **2**, which is design.md's
    `solverSearchWorkers` default and the value the fleet worst case
    (16 × 2 = 32 CP-SAT search workers) is stated against. **Reading it from
    configuration at the process boundary is 5.4b's**, along with the memory
    ceiling that clause owns; this default is what a production solve gets until
    that lands, so the fleet arithmetic already holds.

    `deterministic_time_per_stage` selects 5.5's pinned configuration: CP-SAT's
    *deterministic* time limit instead of the wall clock. Production is
    multi-worker wall-clock and is explicitly not required to be reproducible.
    """

    num_search_workers: int = 2
    random_seed: int = 0
    deterministic_time_per_stage: float | None = None
    child_deadline_epoch_ms: int | None = None


def evaluate_terms(
    request: Mapping[str, Any], offsets: Mapping[str, int]
) -> dict[str, int]:
    """The three terms recomputed from a placement, outside CP-SAT.

    The same arithmetic as `recomputeObjectives` in
    `revalidate-solver-result.ts`, and the same reason it exists there: `value`
    is defined as the term on the *published* offsets, which is not the stage
    incumbent — a later stage minimising `T₂` under `T₁ ≤ v₁` may legitimately
    return a schedule whose `T₁` is strictly better than `v₁`. Bun recomputes all
    three and refuses the response on a one-unit disagreement, so this runs on
    Python's unbounded integers and never on a CP-SAT variable value.
    """
    baseline = request["baselineOffsets"]
    makespan = 0
    priority = 0
    movement = 0
    for entry in request["slices"]:
        key = str(entry["key"])
        start = int(offsets[key])
        finish = start + int(entry["durationUnits"])
        if finish > makespan:
            makespan = finish
        priority += int(entry["priorityWeight"]) * finish
        movement += abs(start - int(baseline[key]))
    return {MAKESPAN: makespan, PRIORITY: priority, MOVEMENT: movement}


def stage_budgets_ms(total_ms: int, split: Sequence[float]) -> list[float]:
    """Each stage's share of the budget, before any donation.

    Donation cannot be computed here: it depends on what the earlier stages
    actually spent. This is the worst-case share, and `solve_request` adds the
    carry.
    """
    return [total_ms * float(share) for share in split]


def donated_budget_ms(share_ms: float, spent_ms: float) -> float:
    """What a stage hands to the next one: its share, less what it spent.

    Pure and exported for the same reason `stage_disposition` is. The only way
    to observe donation through a solve is to assert on elapsed wall clock,
    which is a measurement rather than a proof and is the flake 5.6 is written
    to avoid — so the arithmetic is asserted as arguments instead.

    Clamped at zero because a stage can overrun its share: `max_time_in_seconds`
    bounds the search, not the presolve and the model build around it, and a
    negative carry would silently take budget away from a later stage that never
    had it.
    """
    return max(0.0, share_ms - spent_ms)


# 5.9's feasibility probe limit, in CP-SAT deterministic units. The probe solves
# a model with every start fixed, so presolve decides it and there is nothing to
# search: measured at 1.1–1.6 ms wall on the eleven-slice instance
# `test_bound.py` uses. The limit is a fail-safe against a pathological instance,
# not a budget, and exhausting it means "not proved feasible", which costs the
# bound and never an answer.
BASELINE_PROBE_UNITS = 1.0


def baseline_is_feasible(request: Mapping[str, Any]) -> bool:
    """Is `baselineOffsets` a solution of exactly the model this run solves?

    5.9's bound `T₁ ≤ baselineT₁` is sound **only** if the baseline placement is
    itself admitted by the model: bounding a term by the cost of something the
    constraints exclude can cut off every real solution, and stage 1 reports that
    as `INFEASIBLE, k = 1` — design.md's "a property of the user's plan". A wrong
    answer, not a degraded one.

    design.md says the baseline is feasible "by construction" because it is
    Fast's own placement re-run through `schedule()` over the same rounded
    durations. That is a **builder** invariant, and the wire does not carry it:
    the request `$comment`'s eight cross-field invariants cover the two offset
    maps' equality, their key sets, their horizon bound, pools, edges, the split,
    duplicate members and the overflow worst cases — and say nothing about
    whether the baseline can actually be placed. So this side checks rather than
    assumes, and the check is not hypothetical: an all-zero baseline over slices
    sharing a capacity-2 pool is a request the schema, the cross-field checks and
    `validate_request` all accept, and it is infeasible.

    The probe is `build_model` with every start pinned, deliberately rather than
    a second implementation of the six clauses. A hand-written predicate would be
    a copy of `model.py` free to drift from it, and the two disagreeing is the
    exact failure mode — a bound installed against a model that does not admit
    the baseline after all.
    """
    probe = build_model(request)
    baseline = request["baselineOffsets"]
    for key, var in probe.starts.items():
        probe.model.add(var == int(baseline[key]))
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.max_deterministic_time = BASELINE_PROBE_UNITS
    return solver.solve(probe.model) in (cp_model.OPTIMAL, cp_model.FEASIBLE)


def baseline_bound(request: Mapping[str, Any]) -> tuple[str, int] | None:
    """Stage 1's term and the baseline's value for it, or `None` when unbounded.

    Exported and separate from `solve_request` for the same reason
    `stage_disposition` and `donated_budget_ms` are: what the bound *is* can then
    be asserted as a value, and the property that matters — no placement worse
    than the baseline is a solution — can be asserted against the number this
    function actually returns rather than against a copy of the arithmetic.

    That seam is load-bearing here, because the bound is **invisible in
    `solve_request`'s answer on this solver**. Measured on the eleven-slice
    instance at every deterministic limit from 0.001 to 0.5: stage 1's incumbent
    is the baseline's own value whether the bound is installed or not, because
    5.9's *other* half — the solution hint — already delivers the baseline as the
    first incumbent. So the bound is not what makes the common case good; it is
    what makes the guarantee hold in the case CP-SAT does not promise to avoid.
    `model.py`'s hint case says it in as many words: a hint is advice.
    """
    primary = stage_order(str(request["objective"]))[0]
    if not baseline_is_feasible(request):
        return None
    return primary, evaluate_terms(request, request["baselineOffsets"])[primary]


def _configure(config: SolverConfig, budget_ms: float) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = config.num_search_workers
    solver.parameters.random_seed = config.random_seed
    if config.deterministic_time_per_stage is not None:
        # 5.5. A deterministic limit is a count of the solver's own work units,
        # so the same model under the same seed explores the same tree whatever
        # the host is doing. A wall-clock assertion would be a measurement.
        solver.parameters.max_deterministic_time = config.deterministic_time_per_stage
    else:
        # A stage is never given a non-positive budget: the schema's
        # `exclusiveMinimum: 0` on every share and `minimum: 1` on `budgetMs`
        # make the product positive, and a zero would read as "no limit" to
        # CP-SAT, which is the opposite of what an exhausted budget means.
        wall_budget_ms = budget_ms
        if config.child_deadline_epoch_ms is not None:
            remaining_ms = config.child_deadline_epoch_ms - time.time_ns() / 1_000_000
            wall_budget_ms = min(wall_budget_ms, remaining_ms)
        solver.parameters.max_time_in_seconds = max(wall_budget_ms, 1.0) / 1000.0
    return solver


def _dual_bound(solver: cp_model.CpSolver) -> int:
    """The stage's best dual bound as a non-negative integer.

    Minimisation, so the bound is a lower bound and `ceil` is the integral
    tightening rather than a rounding choice. Clamped at zero because every term
    is non-negative by construction and the wire's `safeInteger` starts there;
    an unproved model can report a bound below the term's own floor.
    """
    bound = solver.best_objective_bound
    if not math.isfinite(bound):
        return 0
    return max(0, math.ceil(bound))


def _term_row(
    value: int, stage_value: int | None, bound: int | None, status: str
) -> dict[str, Any]:
    return {
        "value": value,
        "stageValue": stage_value,
        "bound": bound,
        "status": status,
    }


def solve_request(
    request: Mapping[str, Any], config: SolverConfig | None = None
) -> dict[str, Any]:
    """Solve one validated request and return one wire response.

    The request is assumed already through `validate_request`. Returns the
    response as a dict; raises `SolveFailed` for the outcomes the wire cannot
    carry.
    """
    config = config or SolverConfig()
    built = build_model(request)
    order = stage_order(str(request["objective"]))
    shares = stage_budgets_ms(int(request["budgetMs"]), request["stageBudgetSplit"])

    # What each stage recorded, keyed by term. A term missing from this map is a
    # stage that never ran, which is the `k > 1` UNKNOWN-without-incumbent row's
    # "`Tₖ` and every later term".
    recorded: dict[str, tuple[int, int, str]] = {}
    incumbent: dict[str, int] | None = None
    carry_ms = 0.0

    # 5.9's second half. The hint is in `build_model`; this is the bound, and it
    # is here because it constrains stage 1's *term*, which does not exist until
    # `build_model` has returned.
    #
    # WHAT IT GUARANTEES, EXACTLY: no placement worse than the quantised baseline
    # on stage 1's term is a solution of this model. That is a statement about
    # the **quantised** model alone (design.md, Sol r10 Critical 3) — rounding
    # `days / width` up can cost more than the search wins, so the real-domain
    # no-worse-than-Fast guarantee is 4.11b's publication guard and is not made
    # here.
    #
    # It is never `MOVEMENT ≤ 0`: `STAGE_ORDER` puts MOVEMENT last under both
    # objectives, so `order[0]` is PRIORITY or MAKESPAN. If that ever changes,
    # the bound would pin MOVEMENT to zero — the baseline is its own reference —
    # and freeze every start at the baseline, which is why the pairing is stated
    # rather than left to be noticed.
    bound = baseline_bound(request)
    if bound is not None:
        bounded_term, bound_value = bound
        built.model.add(built.terms[bounded_term] <= bound_value)

    for index, term_name in enumerate(order):
        stage = index + 1
        budget_ms = shares[index] + carry_ms
        solver = _configure(config, budget_ms)
        # One objective per stage. The model is cumulative — every constraint an
        # earlier stage added is still installed — so the objective is the only
        # thing that changes between solves.
        built.model.minimize(built.terms[term_name])
        status = solver.solve(built.model)
        carry_ms = donated_budget_ms(budget_ms, solver.wall_time * 1000.0)
        found = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
        row = stage_disposition(status, stage, found)

        if row in (ROW_EQUALITY, ROW_BOUND):
            stage_value = int(solver.value(built.terms[term_name]))
            recorded[term_name] = (
                stage_value,
                _dual_bound(solver),
                TERM_OPTIMAL if row == ROW_EQUALITY else TERM_FEASIBLE,
            )
            incumbent = {
                key: int(solver.value(var)) for key, var in built.starts.items()
            }
            # The whole reason the first two rows differ: an equality is sound
            # only where the value is proved. Fixing an unproven incumbent is not
            # lexicographic minimisation over the feasible set, while `<= v`
            # excludes no solution at least as good.
            if row == ROW_EQUALITY:
                built.model.add(built.terms[term_name] == stage_value)
            else:
                built.model.add(built.terms[term_name] <= stage_value)
            continue

        if row == ROW_STOP_PLAN_INFEASIBLE:
            # Nothing publishable, and a typed state rather than a failure.
            # Deadlines are in the model before any objective term, so this is a
            # property of the plan.
            return {"wireVersion": WIRE_VERSION, "status": STATUS_INFEASIBLE}

        if row == ROW_STOP_NO_SOLUTION:
            # The budget ran out with nothing found and nothing proved. Fast
            # stays visible.
            return {"wireVersion": WIRE_VERSION, "status": STATUS_UNKNOWN}

        if row == ROW_STOP_PUBLISH:
            # Publish stage k−1's incumbent, which is feasible for the original
            # constraints and already satisfies every bound added so far. `Tₖ`
            # and every later term stay out of `recorded`.
            break

        raise SolveFailed(
            f"stage {stage} ({term_name}) returned {solver.status_name(status)} "
            "under constraints the previous stage's incumbent already satisfies"
        )

    if incumbent is None:  # pragma: no cover - both paths above already returned
        raise SolveFailed("no stage produced an incumbent and none reported why")

    values = evaluate_terms(request, incumbent)
    objective_values: dict[str, Any] = {}
    for term_name in TERMS:
        if term_name in recorded:
            stage_value, bound, term_status = recorded[term_name]
            objective_values[term_name] = _term_row(
                values[term_name], stage_value, bound, term_status
            )
        else:
            # The `k > 1` UNKNOWN-without-incumbent shape, spelled by the matrix
            # itself: a recomputed `value` beside a null stage and a null bound.
            # "Describes the stage" is never a requirement that they be
            # populated — no stage produced them.
            objective_values[term_name] = _term_row(
                values[term_name], None, None, TERM_UNKNOWN
            )

    return {
        "wireVersion": WIRE_VERSION,
        "status": STATUS_FEASIBLE,
        "offsets": {key: incumbent[key] for key in built.keys},
        "objectiveValues": objective_values,
    }
