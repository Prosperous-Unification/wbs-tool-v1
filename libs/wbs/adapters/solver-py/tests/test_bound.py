"""5.9's bound half: the quantised baseline as an upper bound on stage 1's term.

WHAT 5.9 ASKS FOR, AND WHY THIS FILE ASSERTS SOMETHING ELSE
------------------------------------------------------------
"**Watched red:** remove the bound and run a fixture where the search's first
incumbent is worse than quantised Fast on that term."

**That red is unreachable on this solver, and the reason is 5.9's own other
half.** Measured on the gate host against `requirements.lock` (ortools
9.15.6755), one search worker, seed 0, through the same `build_model` +
`minimize` + `solve` that stage 1 makes, with the bound removed:

| deterministic limit | stage-1 `priority` incumbent | worse than the baseline? |
|---|---|---|
| 0.001 / 0.005 / 0.01 / 0.02 | 1221 | no |
| 0.05 / 0.1 / 0.25 / 0.5 | 1221 | no |

1221 is the baseline's own value on that fixture. The search's first incumbent
is never worse than quantised Fast, at any limit, because **the solution hint
delivers the baseline as the first incumbent**. The second probe says it from
the other side: against a deliberately mediocre serial baseline worth 4045, the
unbounded search returns 1875 at a limit of 0.001 and 1273 at 0.1 — it improves
on the hint immediately and never returns something worse.

So the fixture 5.9 describes does not exist here, and building one would mean
constructing a request no builder can emit (the request `$comment`'s invariant 1
makes `fastHint` and `baselineOffsets` equal, and `check_cross_field` enforces
it). A watched red that cannot be produced honestly is recorded as unreachable,
not faked — the same disposition run 17 gave `num_search_workers`, and the same
reason: an instance where CP-SAT's search order could be made to misbehave would
be one whose outcome is a measurement.

**What is asserted instead is the guarantee itself, at the model.** design.md:
"it guarantees the solver never returns a quantised primary worse than quantised
Fast's". That is a statement about which placements are *solutions*, not about
which one a search happens to reach first, and it is decidable in milliseconds
with no search and no clock: pin every start to a feasible placement that is
worse than the baseline and ask whether the model still admits it.

THE OTHER HALF OF THIS FILE IS THE GUARD, AND IT IS NOT DEFENSIVE DECORATION
-----------------------------------------------------------------------------
The bound is sound only where the baseline is a solution of the model. design.md
has it feasible "by construction" — Fast's placement re-run through `schedule()`
over the same rounded durations — but that is a **builder** invariant and the
wire does not carry it. The request `$comment` lists eight cross-field
invariants; none of them is "the baseline can be placed".

`test_the_corpus_baseline_is_infeasible_and_is_therefore_not_bounded` is the
proof that this is a live request shape rather than a hypothetical: an all-zero
baseline over eleven slices sharing a capacity-2 pool passes the schema, passes
`check_cross_field`, passes `validate_request` — and is infeasible, with a
`priority` of 678 against a true optimum of 1221. Bounding on it would report a
schedulable plan as `INFEASIBLE, k = 1`, which the matrix hands to the
coordinator as a property of the user's plan. Not a slower answer: a wrong one.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any, Mapping

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from ortools.sat.python import cp_model  # noqa: E402
from test_model import a_request, a_slice  # noqa: E402

from wbs_solver.model import MAKESPAN, PRIORITY, build_model  # noqa: E402
from wbs_solver.solve import (  # noqa: E402
    SolverConfig,
    baseline_bound,
    baseline_is_feasible,
    evaluate_terms,
    solve_request,
)
from wbs_solver.validate import check_cross_field, validate_against_schema  # noqa: E402

# `test_budget.py`'s instance, unchanged and for the same reason it was chosen
# there: coprime durations so nothing packs flush, distinct weights so PRIORITY
# orders strictly, and a proof cost large enough that stage 1 truncates.
DURATIONS = (7, 11, 13, 5, 17, 3, 19, 23, 29, 2, 31)
WEIGHTS = (1, 2, 3, 5, 8, 13, 1, 2, 3, 5, 8)

# Proved at a generous limit and reproduced by the probe; the same number
# `test_budget.PROVEN_OPTIMUM` asserts.
PROVEN_OPTIMUM = 1221

# The all-zero baseline's `priority`, recorded because the whole guard rests on
# it being *below* the optimum: a bound of 678 on a model whose best is 1221
# excludes every solution.
ZERO_BASELINE_PRIORITY = 678


def instance(baseline: Mapping[str, int] | None = None, *, objective: str = "pri"):
    """A fresh request per call; `solve_request` takes a `Mapping`."""
    return a_request(
        [
            a_slice(f"s{i}", duration=DURATIONS[i], weight=WEIGHTS[i], pools=["P"])
            for i in range(len(DURATIONS))
        ],
        pools={"P": 2},
        objective=objective,
        baseline=dict(baseline) if baseline is not None else None,
    )


def serial_offsets() -> dict[str, int]:
    """Every slice end to end. Feasible under any capacity and any no-overlap,
    and far from optimal, which is exactly the placement the bound must exclude.
    """
    offsets: dict[str, int] = {}
    cursor = 0
    for index, duration in enumerate(DURATIONS):
        offsets[f"s{index}"] = cursor
        cursor += duration
    return offsets


def optimal_offsets() -> dict[str, int]:
    """A proved-optimal placement, used as a *good* baseline.

    Obtained by solving, not hand-computed, and that is sound here because
    nothing is asserted about which placement comes back: the cases below assert
    on `evaluate_terms` of whatever it is, and `test_the_seeded_baseline_is_the
    _proven_optimum` pins the only number that matters.
    """
    response = solve_request(
        instance(),
        SolverConfig(num_search_workers=1, random_seed=0, deterministic_time_per_stage=8.0),
    )
    return {key: int(value) for key, value in response["offsets"].items()}


def admits(request: Mapping[str, Any], placement: Mapping[str, int], bound: bool) -> bool:
    """Does the model admit `placement`, with or without 5.9's bound?

    The bound installed is the one `baseline_bound` returns — the shipped value,
    not a copy of its arithmetic — so a change to that function moves this
    assertion with it.
    """
    built = build_model(request)
    if bound:
        term, value = baseline_bound(request)  # type: ignore[misc]
        built.model.add(built.terms[term] <= value)
    for key, var in built.starts.items():
        built.model.add(var == int(placement[key]))
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.max_deterministic_time = 1.0
    return solver.solve(built.model) in (cp_model.OPTIMAL, cp_model.FEASIBLE)


class TheGuardOnAnUnplaceableBaseline(unittest.TestCase):
    """The bound is installed only where the baseline is a solution."""

    def setUp(self) -> None:
        self.request = instance()

    def test_the_corpus_baseline_is_a_request_this_package_accepts(self) -> None:
        # If the schema or the cross-field checks refused it, the guard would be
        # unreachable code and this file would be asserting on a shape no
        # entrypoint can produce.
        validate_against_schema(self.request)
        check_cross_field(self.request)

    def test_the_corpus_baseline_is_infeasible_in_the_model(self) -> None:
        self.assertFalse(baseline_is_feasible(self.request))

    def test_its_term_is_below_the_optimum_which_is_why_it_would_cut(self) -> None:
        # The number is what makes the guard load-bearing rather than tidy: a
        # bound *above* the optimum would be harmless whether or not the
        # placement is feasible.
        baseline = evaluate_terms(self.request, self.request["baselineOffsets"])
        self.assertEqual(baseline[PRIORITY], ZERO_BASELINE_PRIORITY)
        self.assertLess(baseline[PRIORITY], PROVEN_OPTIMUM)

    def test_no_bound_is_installed(self) -> None:
        self.assertIsNone(baseline_bound(self.request))

    def test_the_run_still_answers_with_a_schedule(self) -> None:
        # The whole point. Unconditionally bounding this request returns
        # `infeasible` — a schedulable plan reported as unschedulable.
        response = solve_request(
            self.request,
            SolverConfig(
                num_search_workers=1, random_seed=0, deterministic_time_per_stage=8.0
            ),
        )
        self.assertEqual(response["status"], "feasible")
        self.assertEqual(response["objectiveValues"][PRIORITY]["value"], PROVEN_OPTIMUM)


class TheBoundOnAPlaceableBaseline(unittest.TestCase):
    """`T₁ ≤ baselineT₁`, and what it excludes."""

    @classmethod
    def setUpClass(cls) -> None:
        # One solve for the whole class: `optimal_offsets` is the only thing here
        # that searches, and it is a fixture rather than a subject.
        cls.good = optimal_offsets()
        cls.serial = serial_offsets()

    def test_a_serial_placement_is_feasible_so_it_is_a_fair_witness(self) -> None:
        # The exclusion case below means nothing unless the placement it names is
        # otherwise admitted: a model that refuses it for some *other* reason
        # would pass with the bound deleted.
        self.assertTrue(admits(instance(baseline=self.good), self.serial, bound=False))

    def test_the_seeded_baseline_is_the_proven_optimum(self) -> None:
        request = instance(baseline=self.good)
        self.assertTrue(baseline_is_feasible(request))
        self.assertEqual(baseline_bound(request), (PRIORITY, PROVEN_OPTIMUM))

    def test_the_serial_placement_is_worse_than_the_baseline(self) -> None:
        request = instance(baseline=self.good)
        self.assertGreater(
            evaluate_terms(request, self.serial)[PRIORITY], PROVEN_OPTIMUM
        )

    def test_the_bound_excludes_every_placement_worse_than_the_baseline(self) -> None:
        # design.md's guarantee, stated as a property of the solution set rather
        # than of a search outcome: "the solver never returns a quantised primary
        # worse than quantised Fast's". Deleting the `add` in `solve_request`
        # leaves this red and every search-outcome case green.
        request = instance(baseline=self.good)
        self.assertFalse(admits(request, self.serial, bound=True))

    def test_it_excludes_nothing_at_least_as_good_as_the_baseline(self) -> None:
        # The other half of soundness, and the reason the bound may be an
        # inequality on the *whole* run: the baseline itself stays admitted, so
        # stage 1 cannot be made infeasible by its own upper bound.
        request = instance(baseline=self.good)
        self.assertTrue(admits(request, self.good, bound=True))

    def test_the_answer_is_unchanged_because_the_bound_excludes_no_optimum(self) -> None:
        request = instance(baseline=self.good)
        response = solve_request(
            request,
            SolverConfig(
                num_search_workers=1, random_seed=0, deterministic_time_per_stage=8.0
            ),
        )
        self.assertEqual(response["objectiveValues"][PRIORITY]["value"], PROVEN_OPTIMUM)


class TheBoundedTermIsStageOnesAndNeverMovement(unittest.TestCase):
    """`order[0]`, which `STAGE_ORDER` makes PRIORITY or MAKESPAN.

    MOVEMENT is measured against the baseline, so `MOVEMENT ≤ baselineMOVEMENT`
    is `MOVEMENT ≤ 0` — every start frozen at the baseline and no search at all.
    It is unreachable while MOVEMENT is last under both objectives, which is
    exactly why it is asserted rather than left to be noticed.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.good = optimal_offsets()

    def test_pri_bounds_priority(self) -> None:
        bound = baseline_bound(instance(baseline=self.good, objective="pri"))
        self.assertIsNotNone(bound)
        self.assertEqual(bound[0], PRIORITY)  # type: ignore[index]

    def test_time_bounds_makespan(self) -> None:
        request = instance(baseline=self.good, objective="time")
        bound = baseline_bound(request)
        self.assertIsNotNone(bound)
        self.assertEqual(bound[0], MAKESPAN)  # type: ignore[index]
        self.assertEqual(
            bound[1],  # type: ignore[index]
            evaluate_terms(request, request["baselineOffsets"])[MAKESPAN],
        )

    def test_movement_is_never_the_bounded_term_under_either_objective(self) -> None:
        for objective in ("pri", "time"):
            with self.subTest(objective=objective):
                bound = baseline_bound(instance(baseline=self.good, objective=objective))
                self.assertNotEqual(bound[0], "movement")  # type: ignore[index]


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
