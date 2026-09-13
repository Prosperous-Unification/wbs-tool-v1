"""5.6's budget case: a limit small enough that the proof is out of reach.

WHAT 5.6 ASKS FOR, AND WHY EACH HALF IS HERE
--------------------------------------------
"A deterministic limit small enough that the instance is provably unsolved at it
(an instance whose search tree is **measured**, not guessed) returns `feasible`,
never `optimal`, and never crashes. A wall-clock 'too small' budget is not a
guarantee and is not used."

Three words there do the work.

*Provably unsolved* is why `test_the_generous_limit_proves_the_same_instance`
exists. Without it, `status == "feasible"` at a small limit is consistent with
an instance that is simply never provable, and the case would assert nothing
about the limit at all. That test proves `PROVEN_OPTIMUM` on the same request,
so the only difference between the two outcomes is the number in
`deterministic_time_per_stage`.

*Measured* is `BUDGET`'s provenance, recorded below rather than chosen to look
small.

*Never a wall clock* is why there is no `time.monotonic()` in this file, exactly
as in `test_determinism.py`. A budget case asserting on elapsed seconds would be
the flake the clause exists to forbid.

THE MEASUREMENT
---------------
Probed on the gate host against `requirements.lock` (ortools 9.15.6755), one
search worker, seed 0, through the same `build_model` + `minimize` + `solve`
that `solve_request`'s stage 1 makes. `INSTANCE` is eleven slices of coprime
durations sharing a capacity-2 pool, so stage 1 is a weighted-completion-time
problem whose first incumbent is instant and whose proof is not:

| deterministic limit | stage-1 `priority` outcome |
|---|---|
| unbounded | `OPTIMAL` at **4.1573** deterministic units |
| 8.0 (`GENEROUS`) | `optimal`, value 1221 |
| 0.5 / 0.25 | `feasible` |
| **0.1 (`BUDGET`)** | **`feasible`**, bound 681 against incumbent 1234 |
| 0.05 / 0.02 / 0.01 / 0.005 / 0.001 | `feasible` |

`BUDGET` therefore sits inside a **measured band**: 41× below the proof, and
100× above the smallest limit probed, at which stage 1 still returns an
incumbent. That second margin is the one that matters for flakiness, because
the failure mode a too-small budget would introduce is not `optimal` — it is
`UNKNOWN` with no incumbent, which stage 1 reports as `no-solution` and which
would make this file assert on an empty response. Every limit from 0.001 to 0.5
produced a stage-1 incumbent, so the band is four orders of magnitude wide on
the side that could break.

Twelve slices at the same capacity did **not** prove within 20 deterministic
units, and run 17's earlier 10-to-20-slice candidates did not print a line in
500 wall seconds. `INSTANCE` is the size at which the proof cost is large
relative to the budget and still small enough to belong in a suite.

WHAT THE NUMBERS ARE AND ARE NOT ASSERTED ON
--------------------------------------------
`PROVEN_OPTIMUM` is asserted because an optimum is arithmetic, not a search
outcome — the same reason `test_determinism.py` asserts values while refusing to
assert placements. The budgeted incumbent is asserted only through the two
inequalities that hold for *any* correct truncated solve: it is no better than
the optimum, and the dual bound is no worse. The exact 1229/681 the probe saw
are recorded in the table above and deliberately not asserted; they are
properties of one ortools build's search order, and pinning them would turn a
dependency bump into a red that means nothing.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from test_model import a_request, a_slice  # noqa: E402

from wbs_solver.model import PRIORITY  # noqa: E402
from wbs_solver.solve import SolverConfig, solve_request  # noqa: E402
from wbs_solver.validate import validate_against_schema  # noqa: E402

# The measured band. `GENEROUS` is `test_determinism.py`'s pinned limit
# unchanged: this file needs a limit above the measured 4.1573, and inventing a
# second one would invite the two to drift apart.
BUDGET = 0.1
GENEROUS = 8.0
MEASURED_PROOF_COST = 4.1573

# The optimum of `INSTANCE`'s stage 1, proved at `GENEROUS` and reproduced twice.
PROVEN_OPTIMUM = 1221

# Coprime so no two slices pack flush and the search cannot collapse to a few
# symmetric arrangements; distinct weights so `PRIORITY` orders them strictly.
DURATIONS = (7, 11, 13, 5, 17, 3, 19, 23, 29, 2, 31)
WEIGHTS = (1, 2, 3, 5, 8, 13, 1, 2, 3, 5, 8)


def instance() -> dict[str, Any]:
    """Eleven slices contending for two units of one pool, minimising `pri`.

    A fresh dict per call: `solve_request` takes a `Mapping` and the repeat case
    must not be able to pass by sharing one object.
    """
    return a_request(
        [
            a_slice(f"s{i}", duration=DURATIONS[i], weight=WEIGHTS[i], pools=["P"])
            for i in range(len(DURATIONS))
        ],
        pools={"P": 2},
        objective="pri",
    )


def budgeted(limit: float) -> SolverConfig:
    """The pinned configuration at one deterministic limit.

    One worker and a fixed seed, so the truncation point is a property of the
    limit rather than of which worker was ahead when it fired.
    """
    return SolverConfig(
        num_search_workers=1, random_seed=0, deterministic_time_per_stage=limit
    )


class TheBudgetedSolve(unittest.TestCase):
    """5.6's clause: `feasible`, never `optimal`, never a crash."""

    def setUp(self) -> None:
        self.response = solve_request(instance(), budgeted(BUDGET))
        self.priority = self.response["objectiveValues"][PRIORITY]

    def test_the_first_stage_reports_feasible_and_not_optimal(self) -> None:
        self.assertEqual(self.priority["status"], "feasible")

    def test_no_term_claims_a_proof_at_this_limit(self) -> None:
        # The clause says "never `optimal`" of the whole run, not only of the
        # stage whose limit was measured. Later stages inherit stage 1's
        # inequality and get the same limit, so none of them can prove more.
        statuses = [
            term["status"] for term in self.response["objectiveValues"].values()
        ]
        self.assertNotIn("optimal", statuses)

    def test_the_gap_is_open_which_is_what_unproved_means(self) -> None:
        # An incumbent with a strictly weaker dual bound IS the unsolved search
        # tree, expressed in the response. Equal values would mean the limit
        # closed the proof after all and the case had stopped testing anything.
        self.assertIsNotNone(self.priority["bound"])
        self.assertIsNotNone(self.priority["stageValue"])
        self.assertLess(self.priority["bound"], self.priority["stageValue"])

    def test_the_incumbent_is_no_better_than_the_proved_optimum(self) -> None:
        # True of any correct truncated minimisation, so it survives a search
        # order change; false the moment truncation starts inventing schedules.
        self.assertGreaterEqual(self.priority["stageValue"], PROVEN_OPTIMUM)

    def test_the_dual_bound_never_exceeds_the_proved_optimum(self) -> None:
        # The other side of the same soundness check: a lower bound above the
        # optimum would have excluded the optimal schedule.
        self.assertLessEqual(self.priority["bound"], PROVEN_OPTIMUM)

    def test_a_truncated_run_still_publishes_a_complete_schedule(self) -> None:
        # "Never crashes" is not only "no exception": the response has to be one
        # the wire can carry, with a placement for every slice.
        self.assertEqual(self.response["status"], "feasible")
        self.assertEqual(
            sorted(self.response["offsets"]),
            sorted(entry["key"] for entry in instance()["slices"]),
        )
        validate_against_schema(self.response, "response")

    def test_an_unknown_term_carries_nulls_and_still_carries_a_value(self) -> None:
        # 5.8's `k > 1` UNKNOWN-without-incumbent shape, asserted where it is
        # actually produced. `test_solve.TheMatrixRowByRow` proves
        # `stage_disposition` picks `ROW_STOP_PUBLISH` for that row, and
        # `test_a_fully_staged_run_reports_a_stage_for_every_term` proves the
        # populated side, but nothing asserted the emitted
        # `{stageValue: null, bound: null, status: 'unknown'}` end to end.
        #
        # Phrased over whichever terms come out unknown rather than naming one:
        # which later stage runs out of budget first shifts with the limit, and
        # the matrix's rule does not depend on which it is. `value` is never
        # null for any term, because 2.4 recomputes it on the published offsets.
        for name, term in self.response["objectiveValues"].items():
            with self.subTest(term=name):
                self.assertIsNotNone(term["value"])
                if term["status"] == "unknown":
                    self.assertIsNone(term["stageValue"])
                    self.assertIsNone(term["bound"])

    def test_repeating_the_budgeted_solve_returns_the_identical_response(self) -> None:
        # The flake-free half. A wall-clock budget would truncate at a different
        # point on a loaded host; a deterministic one truncates after the same
        # count of the solver's own work units, so even the *unfinished* search
        # is reproducible. This is the claim `test_determinism.py` cannot make,
        # because every instance there is proved.
        self.assertEqual(solve_request(instance(), budgeted(BUDGET)), self.response)


class TheLimitIsWhatMakesTheDifference(unittest.TestCase):
    """Without this class the case above is consistent with an unprovable model."""

    def test_the_generous_limit_proves_the_same_instance(self) -> None:
        response = solve_request(instance(), budgeted(GENEROUS))
        statuses = {
            name: term["status"] for name, term in response["objectiveValues"].items()
        }
        self.assertEqual(set(statuses.values()), {"optimal"})
        self.assertEqual(response["objectiveValues"][PRIORITY]["value"], PROVEN_OPTIMUM)

    def test_the_budget_is_below_the_measured_proof_cost(self) -> None:
        # The provenance of `BUDGET`, stated as an assertion so the module
        # docstring's table cannot silently stop describing the constants. It is
        # arithmetic on recorded numbers and runs no solve.
        self.assertLess(BUDGET, MEASURED_PROOF_COST)
        self.assertGreater(GENEROUS, MEASURED_PROOF_COST)


if __name__ == "__main__":
    unittest.main()
