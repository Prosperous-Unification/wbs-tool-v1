"""The CP-SAT model: its six constraint clauses and its three cost terms.

HOW THESE CASES ARE BUILT, AND WHY IT MATTERS
----------------------------------------------
Every instance here is a **real request**: `test_every_hand_built_instance_is_a
_valid_request` runs each one through the schema and the four cross-field
checks, so a case cannot quietly drift into a private dialect that the
entrypoint would refuse. That guard is the reason the rest of the file can build
requests from a terse helper instead of a fixture.

Two shapes of case, and they prove different things:

* **Term arithmetic** pins every start, then reads the three term variables. A
  model with fixed starts has exactly one placement, so the expected values are
  hand-computed from `revalidate-solver-result.ts`'s own definitions rather than
  from anything this package computed.
* **Constraint clauses** leave the starts free, minimise one term, and assert
  what the solver was *forced* to do. Each pairs a binding case with a slack
  case: the pool with capacity 1 serialises and the same pool with capacity 2
  does not. Without the slack half a case proves only that the model is
  over-constrained somewhere, not that this clause is what constrained it.

No case asserts a wall-clock duration, and every solve runs single-worker with a
fixed seed: these are exact statements about small models, not measurements.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from ortools.sat.python import cp_model

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from wbs_solver.model import (  # noqa: E402
    MAKESPAN,
    MOVEMENT,
    PRIORITY,
    build_model,
    stage_order,
)
from wbs_solver.validate import (  # noqa: E402
    check_cross_field,
    validate_against_schema,
)


def a_slice(
    key: str,
    *,
    duration: int = 10,
    width: int = 1,
    person: str | None = None,
    pools: Sequence[str] = (),
    weight: int = 0,
    not_before: int = 0,
    deadline: int | None = None,
) -> dict[str, Any]:
    return {
        "key": key,
        "durationUnits": duration,
        "width": width,
        "personId": person,
        "poolIds": list(pools),
        "priorityWeight": weight,
        "notBeforeUnits": not_before,
        "deadlineUnits": deadline,
    }


def a_request(
    slices: Sequence[Mapping[str, Any]],
    *,
    edges: Iterable[Mapping[str, str]] = (),
    pools: Mapping[str, int] | None = None,
    horizon: int | None = None,
    baseline: Mapping[str, int] | None = None,
    objective: str = "pri",
) -> dict[str, Any]:
    """A schema-valid request around a hand-built slice set.

    `horizonUnits` defaults to the serial bound the builder computes,
    `max(0, ...notBefore) + Σ duration`, so the default instance can always
    serialise everything and no case is accidentally horizon-bound.
    `baselineOffsets` defaults to all-zero, which makes MOVEMENT equal to Σ start
    and keeps the movement cases readable.
    """
    keys = [str(s["key"]) for s in slices]
    if horizon is None:
        horizon = max([0, *(int(s["notBeforeUnits"]) for s in slices)]) + sum(
            int(s["durationUnits"]) for s in slices
        )
    offsets = dict(baseline) if baseline is not None else {key: 0 for key in keys}
    return {
        "wireVersion": 1,
        "contractVersion": "7+0.1.0",
        "solverVersion": "0.1.0",
        "objective": objective,
        "budgetMs": 30000,
        "stageBudgetSplit": [0.6, 0.25, 0.15],
        "quantum": 48,
        "horizonUnits": horizon,
        "slices": [dict(s) for s in slices],
        "edges": [dict(e) for e in edges],
        "pools": dict(pools or {}),
        "baselineOffsets": dict(offsets),
        # The wire carries two copies of one value; the builder invariant is
        # that they are equal, so a test that made them differ would be testing
        # a request no builder can emit.
        "fastHint": dict(offsets),
    }


def an_edge(predecessor: str, successor: str) -> dict[str, str]:
    return {"predecessorKey": predecessor, "successorKey": successor}


def _solver() -> cp_model.CpSolver:
    """The pinned configuration: one worker, fixed seed, no time limit.

    Every model in this file is a handful of variables and is proved OPTIMAL in
    milliseconds, so there is no budget to exhaust. The pin is here so a case can
    never pass or fail on which worker happened to find an incumbent first.
    """
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    return solver


def terms_at(request: Mapping[str, Any], starts: Mapping[str, int]) -> dict[str, int]:
    """Fix every start, solve, and read the three terms off that one placement."""
    built = build_model(request)
    for key, value in starts.items():
        built.model.add(built.starts[key] == value)
    solver = _solver()
    status = solver.solve(built.model)
    assert status in (cp_model.OPTIMAL, cp_model.FEASIBLE), solver.status_name(status)
    return {name: solver.value(var) for name, var in built.terms.items()}


def minimise(request: Mapping[str, Any], term: str) -> tuple[int, dict[str, int]]:
    """Minimise one term and return its value with the starts that achieved it."""
    built = build_model(request)
    built.model.minimize(built.terms[term])
    solver = _solver()
    status = solver.solve(built.model)
    assert status == cp_model.OPTIMAL, solver.status_name(status)
    return solver.value(built.terms[term]), {
        key: solver.value(var) for key, var in built.starts.items()
    }


def status_of(request: Mapping[str, Any]) -> int:
    built = build_model(request)
    return _solver().solve(built.model)


# Instances shared by more than one case, named so a failure says which.
TWO_FREE = a_request(
    [a_slice("a", duration=10, weight=3), a_slice("b", duration=20, weight=1)]
)


class HandBuiltInstancesAreRealRequests(unittest.TestCase):
    """If this fails, every other case is arithmetic about an unsendable request."""

    def test_every_hand_built_instance_is_a_valid_request(self) -> None:
        instances = {
            "two free slices": TWO_FREE,
            "an edge": a_request(
                [a_slice("a"), a_slice("b")], edges=[an_edge("a", "b")]
            ),
            "a pool": a_request(
                [a_slice("a", pools=["t"]), a_slice("b", pools=["t"])], pools={"t": 1}
            ),
            "a person": a_request(
                [a_slice("a", person="p"), a_slice("b", person="p")]
            ),
            "a deadline and a floor": a_request(
                [a_slice("a", not_before=5, deadline=40)]
            ),
            "a zero duration": a_request([a_slice("a", duration=0, pools=["t"])], pools={"t": 1}),
            "a fenced zero duration": a_request(
                [a_slice("a", duration=0, person="p", not_before=5, deadline=6),
                 a_slice("b", duration=10, person="p", deadline=10)],
                horizon=20,
            ),
            "a non-zero baseline": a_request(
                [a_slice("a", duration=10)], horizon=30, baseline={"a": 20}
            ),
        }
        for name, request in instances.items():
            with self.subTest(name):
                validate_against_schema(request, "request")
                check_cross_field(request)


class CostTerms(unittest.TestCase):
    """5.3's first clause: each of the three terms on a hand-built instance.

    Watched red: change `add_max_equality` to a chain of `>=` and the makespan
    cases still pass while `MakespanIsTheMaximumNotTheSum` below fails, which is
    why that case exists as well as these.

    Proof (5.7, fault one — the solver reading something the request hash does
    not cover): `build_model`'s `baseline` taken from `time.time()` instead of
    `request["baselineOffsets"]` reds exactly three cases, all of them here —
    `a_slice_placed_on_its_baseline_moves_nothing`,
    `movement_counts_a_start_before_the_baseline_the_same_as_after`, and
    `a_zero_weight_slice_contributes_nothing_to_priority`. **5.7 predicted 5.4's
    oracle cases would fail and they do not**: `MOVEMENT` is the last
    tie-breaker under both stagings and every oracle instance in
    `test_oracles.py` has a unique optimum on an earlier term, so a corrupted
    baseline never reaches their placements. This class is the whole of the
    suite's defence against that fault, which is why it is named here.
    """

    def test_makespan_is_the_largest_finish(self) -> None:
        # finishes are 4 + 10 = 14 and 0 + 20 = 20.
        self.assertEqual(terms_at(TWO_FREE, {"a": 4, "b": 0})[MAKESPAN], 20)

    def test_priority_is_the_weighted_sum_of_finishes(self) -> None:
        # 3 × (4 + 10) + 1 × (0 + 20) = 42 + 20 = 62.
        self.assertEqual(terms_at(TWO_FREE, {"a": 4, "b": 0})[PRIORITY], 62)

    def test_movement_is_the_summed_absolute_deviation(self) -> None:
        # Baselines are 0 and 0, so movement is 4 + 0.
        self.assertEqual(terms_at(TWO_FREE, {"a": 4, "b": 0})[MOVEMENT], 4)

    def test_movement_counts_a_start_before_the_baseline_the_same_as_after(self) -> None:
        """The absolute value, not a signed lateness. Both directions cost."""
        request = a_request(
            [a_slice("a", duration=4), a_slice("b", duration=4)],
            horizon=40,
            baseline={"a": 10, "b": 10},
        )
        self.assertEqual(terms_at(request, {"a": 4, "b": 16})[MOVEMENT], 12)

    def test_a_slice_placed_on_its_baseline_moves_nothing(self) -> None:
        request = a_request([a_slice("a", duration=4)], horizon=40, baseline={"a": 10})
        self.assertEqual(terms_at(request, {"a": 10})[MOVEMENT], 0)

    def test_a_zero_weight_slice_contributes_nothing_to_priority(self) -> None:
        """`priorityWeight` is 0 when no priority reaches the leaf, and 0 is not
        a missing value: the slice still exists, still occupies, and still counts
        in MAKESPAN and MOVEMENT."""
        request = a_request([a_slice("a", duration=10, weight=0)])
        terms = terms_at(request, {"a": 3})
        self.assertEqual(terms[PRIORITY], 0)
        self.assertEqual(terms[MAKESPAN], 13)
        self.assertEqual(terms[MOVEMENT], 3)

    def test_priority_uses_the_finish_and_not_the_start(self) -> None:
        """Two slices of equal weight and unequal duration, placed together.

        If PRIORITY were Σ w · start, both placements below would score the same.
        """
        request = a_request(
            [a_slice("a", duration=10, weight=1), a_slice("b", duration=30, weight=1)]
        )
        self.assertEqual(terms_at(request, {"a": 0, "b": 0})[PRIORITY], 40)


class MakespanIsTheMaximumNotTheSum(unittest.TestCase):
    def test_a_later_slice_does_not_raise_the_makespan_of_an_earlier_one(self) -> None:
        request = a_request(
            [a_slice("a", duration=10), a_slice("b", duration=10), a_slice("c", duration=10)]
        )
        self.assertEqual(terms_at(request, {"a": 0, "b": 0, "c": 0})[MAKESPAN], 10)

    def test_minimising_makespan_over_free_slices_parallelises_them(self) -> None:
        """Nothing serialises three unconstrained slices, so the makespan is the
        longest of them and not their sum."""
        request = a_request(
            [a_slice("a", duration=10), a_slice("b", duration=20), a_slice("c", duration=5)]
        )
        value, _ = minimise(request, MAKESPAN)
        self.assertEqual(value, 20)

    def test_the_term_cannot_be_held_above_the_largest_reachable_finish(self) -> None:
        """The case that separates an equality from a lower-bound chain.

        Every other makespan case here minimises the term, and under
        minimisation `makespan >= end(s)` for each `s` behaves exactly like
        `makespan = max end(s)` — the objective drives it down to the maximum
        either way. The matrix does not only minimise: after an OPTIMAL stage it
        installs `Tₖ = v`, and an equality against a term defined only by lower
        bounds is satisfiable by a schedule whose real maximum is *smaller* than
        `v`, which is a later stage optimising under a bound it is not actually
        holding.

        One slice of duration 10 with the horizon at 5: the start is in `[0, 5]`
        so the only reachable finishes are `10..15`, and no placement has a
        maximum of 20. Under `AddMaxEquality` that is infeasible. Under the
        chain, `20 >= 15` and it is not.
        """
        request = a_request([a_slice("a", duration=10)], horizon=5)
        built = build_model(request)
        built.model.add(built.terms[MAKESPAN] == 20)
        self.assertEqual(_solver().solve(built.model), cp_model.INFEASIBLE)

    def test_a_reachable_equality_is_still_satisfiable(self) -> None:
        """The slack half: 14 is a real maximum on that same instance, so the
        case above is proving the bound and not just that equalities refuse."""
        request = a_request([a_slice("a", duration=10)], horizon=5)
        built = build_model(request)
        built.model.add(built.terms[MAKESPAN] == 14)
        solver = _solver()
        self.assertEqual(solver.solve(built.model), cp_model.OPTIMAL)
        self.assertEqual(solver.value(built.starts["a"]), 4)


class EdgeClause(unittest.TestCase):
    """Clause 3: `finish(pred) <= start(succ)`, closed-then-open."""

    def test_a_chain_serialises(self) -> None:
        request = a_request(
            [a_slice("a", duration=10), a_slice("b", duration=20)],
            edges=[an_edge("a", "b")],
        )
        value, starts = minimise(request, MAKESPAN)
        self.assertEqual(value, 30)
        self.assertEqual(starts, {"a": 0, "b": 10})

    def test_without_the_edge_the_same_pair_is_concurrent(self) -> None:
        request = a_request([a_slice("a", duration=10), a_slice("b", duration=20)])
        value, _ = minimise(request, MAKESPAN)
        self.assertEqual(value, 20)

    def test_a_hand_off_at_the_exact_instant_is_legal(self) -> None:
        """The successor may start at the unit the predecessor finishes. A
        strict `<` would push every chain one unit further out per link."""
        request = a_request(
            [a_slice("a", duration=10), a_slice("b", duration=10)],
            edges=[an_edge("a", "b")],
        )
        self.assertEqual(terms_at(request, {"a": 0, "b": 10})[MAKESPAN], 20)


class FloorAndHorizonClauses(unittest.TestCase):
    """Clauses 1 and 2, both folded into the start variable's own domain."""

    def test_a_floor_pushes_the_start_out(self) -> None:
        request = a_request([a_slice("a", duration=10, not_before=7)])
        _, starts = minimise(request, MAKESPAN)
        self.assertEqual(starts["a"], 7)

    def test_the_horizon_bounds_the_start_and_not_the_finish(self) -> None:
        """A finish past the horizon is legal — the re-validator bounds the
        offset, and says a finish past the horizon is the makespan's business."""
        request = a_request([a_slice("a", duration=10)], horizon=5)
        terms = terms_at(request, {"a": 5})
        self.assertEqual(terms[MAKESPAN], 15)

    def test_a_start_past_the_horizon_is_refused(self) -> None:
        request = a_request([a_slice("a", duration=10)], horizon=5)
        built = build_model(request)
        built.model.add(built.starts["a"] == 6)
        self.assertEqual(_solver().solve(built.model), cp_model.INFEASIBLE)


class DeadlineClause(unittest.TestCase):
    """Clause 6. Bun carries the same clause on the materialised schedule in
    the real fractional domain, through the `isOnTime` predicate the two sides
    now share; this is the integer-unit half of it.

    It is what makes design.md's `INFEASIBLE, k = 1` row mean "the user's
    deadlines cannot be met" rather than "the engine is broken": deadlines are in
    the model before any objective term, so a stage-1 infeasibility is a property
    of the plan.
    """

    def test_a_deadline_bounds_the_finish(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, not_before=0, deadline=12)],
            horizon=40,
        )
        built = build_model(request)
        built.model.add(built.starts["a"] == 3)
        self.assertEqual(_solver().solve(built.model), cp_model.INFEASIBLE)

    def test_the_same_start_one_unit_earlier_meets_it(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, not_before=0, deadline=12)],
            horizon=40,
        )
        built = build_model(request)
        built.model.add(built.starts["a"] == 2)
        self.assertEqual(_solver().solve(built.model), cp_model.OPTIMAL)

    def test_a_deadline_a_floor_cannot_meet_is_infeasible(self) -> None:
        """Stage 1 INFEASIBLE, and the whole reason that row is
        `plan-infeasible` rather than `invalid-output`."""
        request = a_request(
            [a_slice("a", duration=10, not_before=20, deadline=25)], horizon=40
        )
        self.assertEqual(status_of(request), cp_model.INFEASIBLE)

    def test_a_null_deadline_constrains_nothing(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, not_before=20, deadline=None)], horizon=40
        )
        self.assertEqual(status_of(request), cp_model.OPTIMAL)

    def test_a_zero_duration_milestone_one_day_late_is_infeasible(self) -> None:
        """**WATCHED RED W2** (tasks.md 8.4). Substitute `end <= deadlineUnits`
        for `start + max(duration, 1) <= deadlineUnits` and this goes OPTIMAL.

        The milestone is the only input the two forms disagree on. `end == start`
        at duration zero, so the substituted form admits a start of exactly `48`
        — `(D + 1) x quantum` for a day-0 deadline, which is the first instant of
        day 1 and a day late. `lastWorkdayOf` in `libs/domain/src/on-time.ts`
        reads that placement as day 1 and calls it late, so under the
        substitution the solver publishes a schedule Bun then refuses as
        `deadline-violated`: a plan-infeasible verdict arriving as an engine
        failure, which is exactly what TASK-241's AC #2 forbids.

        Every non-zero-duration fixture stays green under the substitution,
        which is why the case has to be the milestone and not a shorter task.
        """
        request = a_request(
            [a_slice("a", duration=0, not_before=0, deadline=48)], horizon=96
        )
        built = build_model(request)
        built.model.add(built.starts["a"] == 48)
        self.assertEqual(_solver().solve(built.model), cp_model.INFEASIBLE)

    def test_the_same_milestone_inside_its_due_day_is_feasible(self) -> None:
        """The slack half of W2: the clause fences the milestone, it does not
        forbid it. Unit 47 is still inside day 0 — `lastWorkdayOf(47/48, 47/48)`
        is 0 — and `47 + max(0, 1) <= 48` admits it."""
        request = a_request(
            [a_slice("a", duration=0, not_before=0, deadline=48)], horizon=96
        )
        built = build_model(request)
        built.model.add(built.starts["a"] == 47)
        self.assertEqual(_solver().solve(built.model), cp_model.OPTIMAL)


class PoolClause(unittest.TestCase):
    """Clause 4: one cumulative per pool, demand `width`, capacity `pools[id]`."""

    def test_a_capacity_of_one_serialises_two_width_one_slices(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, width=1, pools=["t"]),
             a_slice("b", duration=10, width=1, pools=["t"])],
            pools={"t": 1},
        )
        value, _ = minimise(request, MAKESPAN)
        self.assertEqual(value, 20)

    def test_a_capacity_of_two_lets_the_same_pair_run_together(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, width=1, pools=["t"]),
             a_slice("b", duration=10, width=1, pools=["t"])],
            pools={"t": 2},
        )
        value, _ = minimise(request, MAKESPAN)
        self.assertEqual(value, 10)

    def test_width_is_the_demand_and_not_the_slice_count(self) -> None:
        """Two width-2 slices need four slots to run together; a capacity of 3
        serialises them even though the pool could hold three *slices*."""
        request = a_request(
            [a_slice("a", duration=10, width=2, pools=["t"]),
             a_slice("b", duration=10, width=2, pools=["t"])],
            pools={"t": 3},
        )
        self.assertEqual(minimise(request, MAKESPAN)[0], 20)
        wider = a_request(
            [a_slice("a", duration=10, width=2, pools=["t"]),
             a_slice("b", duration=10, width=2, pools=["t"])],
            pools={"t": 4},
        )
        self.assertEqual(minimise(wider, MAKESPAN)[0], 10)

    def test_the_whole_width_is_spent_in_every_named_pool(self) -> None:
        """A two-pool slice is counted at full width in both, so the *tighter*
        pool binds. Counting only the first membership would let this pair run
        concurrently."""
        request = a_request(
            [a_slice("a", duration=10, width=1, pools=["roomy", "tight"]),
             a_slice("b", duration=10, width=1, pools=["tight"])],
            pools={"roomy": 9, "tight": 1},
        )
        self.assertEqual(minimise(request, MAKESPAN)[0], 20)

    def test_a_pool_nobody_names_constrains_nothing(self) -> None:
        request = a_request(
            [a_slice("a", duration=10), a_slice("b", duration=10)],
            pools={"unreferenced": 1},
        )
        self.assertEqual(minimise(request, MAKESPAN)[0], 10)

    def test_a_width_larger_than_its_pool_is_infeasible(self) -> None:
        """`valid-two-slices.json` is exactly this shape — schema-valid and
        unsolvable — which is why no case in this file solves that fixture."""
        request = a_request(
            [a_slice("a", duration=10, width=5, pools=["t"])], pools={"t": 2}
        )
        self.assertEqual(status_of(request), cp_model.INFEASIBLE)


class AssigneeClause(unittest.TestCase):
    """Clause 5: a person is not a quantity."""

    def test_one_person_on_two_slices_serialises_them(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, person="p"), a_slice("b", duration=20, person="p")]
        )
        self.assertEqual(minimise(request, MAKESPAN)[0], 30)

    def test_two_different_people_do_not_serialise(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, person="p"), a_slice("b", duration=20, person="q")]
        )
        self.assertEqual(minimise(request, MAKESPAN)[0], 20)

    def test_an_unassigned_slice_serialises_with_nothing(self) -> None:
        """`personId: null` is a real and common state, not a person named
        null: two unassigned slices are not the same assignee."""
        request = a_request(
            [a_slice("a", duration=10), a_slice("b", duration=20)]
        )
        self.assertEqual(minimise(request, MAKESPAN)[0], 20)

    def test_width_does_not_soften_a_double_booking(self) -> None:
        """Two width-5 slices on one person still serialise: the clause counts
        slices at one each against a capacity of one, whatever their widths."""
        request = a_request(
            [a_slice("a", duration=10, width=5, person="p"),
             a_slice("b", duration=10, width=5, person="p")]
        )
        self.assertEqual(minimise(request, MAKESPAN)[0], 20)


class ZeroDurationSlices(unittest.TestCase):
    """A zero `durationUnits` is legal and occupies nothing.

    The re-validator's sweep drops zero-length placements before counting, so a
    zero-duration slice can never oversubscribe a pool or double-book a person
    there. If it could here, the solver would report a plan infeasible that Bun
    would have accepted.
    """

    def test_a_zero_duration_slice_does_not_double_book_a_person(self) -> None:
        """Pinned *inside* an occupied span, which is the only placement that
        can tell the two readings apart.

        A zero-duration slice free to move is not a proof: CP-SAT's own
        `NoOverlap` is satisfied by putting it at the exact instant its
        neighbour starts, so a case that merely minimises the makespan passes
        whether or not the filter exists. Here `a` is fenced to unit 5 by its
        floor and its deadline, and `b` is fenced to `[0, 10)` by the same pair,
        so the zero-length point sits strictly inside `b`'s span with nowhere to
        escape to.

        Watched red: drop the `duration > 0` filter and this is INFEASIBLE — a
        plan reported unschedulable that the re-validator's sweep, which drops
        zero-length placements before counting, would have accepted.

        `a`'s deadline is 6 and not 5. Clause 6 became
        `start + max(duration, 1) <= deadlineUnits` (tasks.md 8.3), so the
        exclusive bound that pins a zero-duration slice to unit 5 is 6; under the
        old `end <= deadlineUnits` it was 5. The fence is the same fence and the
        assertion below is unchanged — only the number that expresses "no later
        than unit 5" moved, because the clause it is written against changed.
        """
        request = a_request(
            [a_slice("a", duration=0, person="p", not_before=5, deadline=6),
             a_slice("b", duration=10, person="p", deadline=10)],
            horizon=20,
        )
        built = build_model(request)
        solver = _solver()
        self.assertEqual(solver.solve(built.model), cp_model.OPTIMAL)
        self.assertEqual(solver.value(built.starts["a"]), 5)
        self.assertEqual(solver.value(built.starts["b"]), 0)

    def test_the_same_pair_with_a_real_duration_is_infeasible(self) -> None:
        """The slack half. Give `a` one unit of duration and the identical
        fencing, and the double-booking is real: the case above passes because
        `a` occupies nothing, not because the fencing was loose."""
        request = a_request(
            [a_slice("a", duration=1, person="p", not_before=5, deadline=6),
             a_slice("b", duration=10, person="p", deadline=10)],
            horizon=20,
        )
        self.assertEqual(status_of(request), cp_model.INFEASIBLE)

    def test_a_zero_duration_slice_does_not_consume_pool_capacity(self) -> None:
        """The same fencing against a pool, and the same watched red.

        The pool half is weaker than the assignee half and is recorded as such:
        CP-SAT's `AddCumulative` integrates demand over time, so a zero-length
        interval contributes nothing to it whether or not this model filters it
        out, and the mutation above leaves this case green on its own. It is
        kept because the filter is one decision covering both clauses, and a
        case that documents the pool reading is worth more than a case that
        only re-proves the one CP-SAT already gives.

        `a`'s deadline is 6 for the same reason as the assignee case above: the
        exclusive bound that pins a zero-duration slice to unit 5 is 6 under
        clause 6's `start + max(duration, 1) <= deadlineUnits`.
        """
        request = a_request(
            [a_slice("a", duration=0, width=9, pools=["t"], not_before=5, deadline=6),
             a_slice("b", duration=10, width=1, pools=["t"], deadline=10)],
            pools={"t": 1},
            horizon=20,
        )
        built = build_model(request)
        solver = _solver()
        self.assertEqual(solver.solve(built.model), cp_model.OPTIMAL)
        self.assertEqual(solver.value(built.starts["a"]), 5)

    def test_it_still_carries_its_edges_and_its_weight(self) -> None:
        """Occupying nothing is not the same as being absent: the edge still
        orders it and the terms still count it."""
        request = a_request(
            [a_slice("a", duration=10), a_slice("b", duration=0, weight=2)],
            edges=[an_edge("a", "b")],
        )
        terms = terms_at(request, {"a": 0, "b": 10})
        self.assertEqual(terms[MAKESPAN], 10)
        self.assertEqual(terms[PRIORITY], 20)
        self.assertEqual(terms[MOVEMENT], 10)
        built = build_model(request)
        built.model.add(built.starts["b"] == 9)
        self.assertEqual(_solver().solve(built.model), cp_model.INFEASIBLE)


class TheHint(unittest.TestCase):
    """5.9's hint half. A hint is advice and never an answer."""

    def test_an_unsatisfiable_hint_does_not_make_the_model_infeasible(self) -> None:
        """`fastHint` is the quantised Fast baseline and is feasible by
        construction, but nothing in this model may *depend* on that: a hint
        CP-SAT cannot use must cost search time and never correctness."""
        request = a_request(
            [a_slice("a", duration=10, not_before=5)], horizon=40, baseline={"a": 0}
        )
        value, starts = minimise(request, MAKESPAN)
        self.assertEqual(starts["a"], 5)
        self.assertEqual(value, 15)


class StageOrder(unittest.TestCase):
    """The lexicographic order each objective minimises, from the schema's enum."""

    def test_pri_leads_with_priority(self) -> None:
        self.assertEqual(stage_order("pri"), (PRIORITY, MAKESPAN, MOVEMENT))

    def test_time_leads_with_makespan(self) -> None:
        self.assertEqual(stage_order("time"), (MAKESPAN, PRIORITY, MOVEMENT))

    def test_movement_is_last_in_both(self) -> None:
        """It is the tie-breaker and never a driver, in either staging."""
        for objective in ("pri", "time"):
            with self.subTest(objective):
                self.assertEqual(stage_order(objective)[2], MOVEMENT)

    def test_an_unknown_objective_raises_rather_than_defaulting(self) -> None:
        with self.assertRaises(ValueError):
            stage_order("cheapest")


class BuiltModelShape(unittest.TestCase):
    def test_keys_follow_the_request_slice_order(self) -> None:
        """`offsets` is emitted in this order, so it is pinned rather than
        left to dict iteration order."""
        request = a_request([a_slice("z"), a_slice("a"), a_slice("m")])
        self.assertEqual(build_model(request).keys, ("z", "a", "m"))

    def test_every_slice_has_a_start_an_end_and_the_three_terms_exist(self) -> None:
        built = build_model(TWO_FREE)
        self.assertEqual(sorted(built.starts), ["a", "b"])
        self.assertEqual(sorted(built.ends), ["a", "b"])
        self.assertEqual(sorted(built.terms), [MAKESPAN, MOVEMENT, PRIORITY])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
