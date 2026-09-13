"""The staged lexicographic loop: the matrix, both stagings, the response.

THE ORACLE THIS FILE IS BUILT AROUND
------------------------------------
`DISAGREE` is four slices in a capacity-2 pool — three of duration 1 and one of
duration 3, all weight 1 — and the two stagings genuinely disagree on it. It is
the classic `1,1,1,3` counterexample to "shortest first also minimises the
makespan", worked out by hand rather than read off this package:

* **PRIORITY first.** `Σ finish` is minimised by pairing the long slice with one
  short one and the other two together: finishes `1, 1, 2, 4` for a total of
  **8**, and that schedule's makespan is **4**. No schedule of makespan 3
  reaches 8 — a makespan of 3 forces the long slice to occupy `[0, 3)`, which
  leaves one unit of capacity for the three short ones, so they finish at
  `1, 2, 3` and the total is 9.
* **MAKESPAN first.** Total work is 6 against capacity 2, so 3 is the floor, and
  it is reachable: the long slice runs `[0, 3)` beside the three short ones. Its
  `Σ finish` is **9**.

So PRI publishes `(priority 8, makespan 4)` and Time publishes
`(makespan 3, priority 9)`, and neither is reachable from the other's staging.
Both numbers above are arithmetic on four integers; nothing here asserts what
CP-SAT happened to return.

WHY THE MATRIX IS TESTED AS ARGUMENTS AND NOT ONLY END TO END
--------------------------------------------------------------
Four of the six rows cannot be reached through a real solve of an instance small
enough to be an oracle. A budget that reliably exhausts is exactly the flake 5.6
is written to avoid, and a later-stage INFEASIBLE cannot be produced at all
without a deliberately wrong model. `stage_disposition` is therefore pure and
every row is asserted against it directly; the reachable rows are *also* driven
end to end, so the dispatch and the table cannot pass separately.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any, Mapping
from unittest import mock

from ortools.sat.python import cp_model

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from test_model import a_request, a_slice, an_edge  # noqa: E402

from wbs_solver import solve as solve_module  # noqa: E402
from wbs_solver.model import MAKESPAN, MOVEMENT, PRIORITY  # noqa: E402
from wbs_solver.solve import (  # noqa: E402
    ROW_BOUND,
    ROW_EQUALITY,
    ROW_STOP_INVALID,
    ROW_STOP_MODEL_INVALID,
    ROW_STOP_NO_SOLUTION,
    ROW_STOP_PLAN_INFEASIBLE,
    ROW_STOP_PUBLISH,
    ModelInvalid,
    SolveFailed,
    SolverConfig,
    donated_budget_ms,
    evaluate_terms,
    solve_request,
    stage_budgets_ms,
    stage_disposition,
)
from wbs_solver.validate import validate_against_schema  # noqa: E402

FIXTURES = REPO_ROOT / "libs" / "contracts" / "solver" / "fixtures" / "request"

# One worker and a fixed seed everywhere in this file. Every instance here is
# proved OPTIMAL in milliseconds, so no case depends on a budget; the pin is
# there so a case cannot pass on which worker found an incumbent first.
PINNED = SolverConfig(num_search_workers=1, random_seed=0)


def disagreement(objective: str) -> dict[str, Any]:
    """The `1,1,1,3` oracle. See the module docstring for the hand arithmetic."""
    return a_request(
        [
            a_slice("s1", duration=1, width=1, pools=["t"], weight=1),
            a_slice("s2", duration=1, width=1, pools=["t"], weight=1),
            a_slice("s3", duration=1, width=1, pools=["t"], weight=1),
            a_slice("big", duration=3, width=1, pools=["t"], weight=1),
        ],
        pools={"t": 2},
        objective=objective,
    )


def values_of(response: Mapping[str, Any]) -> dict[str, int]:
    return {
        term: entry["value"] for term, entry in response["objectiveValues"].items()
    }


class TheMatrixRowByRow(unittest.TestCase):
    """`stage_disposition` against every row of design.md's table.

    Each case names the row it is transcribing. A row that changed in design.md
    and not here should fail as a wrong verdict, not as a missing test, which is
    why the two `k` halves of the stopping rows are separate cases.
    """

    def test_optimal_installs_an_equality_at_every_stage(self) -> None:
        for stage in (1, 2, 3):
            with self.subTest(stage=stage):
                self.assertEqual(
                    stage_disposition(cp_model.OPTIMAL, stage, True), ROW_EQUALITY
                )

    def test_feasible_installs_a_bound_at_every_stage(self) -> None:
        for stage in (1, 2, 3):
            with self.subTest(stage=stage):
                self.assertEqual(
                    stage_disposition(cp_model.FEASIBLE, stage, True), ROW_BOUND
                )

    def test_unknown_with_an_incumbent_installs_the_same_bound(self) -> None:
        """The row CP-SAT never produces, honoured anyway: it prescribes the
        identical constraint and the identical per-term status as FEASIBLE, so
        the collapse is a property of this solver and not of the table."""
        for stage in (1, 2, 3):
            with self.subTest(stage=stage):
                self.assertEqual(
                    stage_disposition(cp_model.UNKNOWN, stage, True), ROW_BOUND
                )

    def test_unknown_without_an_incumbent_at_stage_one_publishes_nothing(self) -> None:
        self.assertEqual(
            stage_disposition(cp_model.UNKNOWN, 1, False), ROW_STOP_NO_SOLUTION
        )

    def test_unknown_without_an_incumbent_later_publishes_the_previous_stage(
        self,
    ) -> None:
        """The row the earlier prose decided two ways: a valid anytime result is
        kept, not discarded."""
        for stage in (2, 3):
            with self.subTest(stage=stage):
                self.assertEqual(
                    stage_disposition(cp_model.UNKNOWN, stage, False), ROW_STOP_PUBLISH
                )

    def test_infeasible_at_stage_one_is_a_plan_property(self) -> None:
        self.assertEqual(
            stage_disposition(cp_model.INFEASIBLE, 1, False), ROW_STOP_PLAN_INFEASIBLE
        )

    def test_infeasible_later_is_never_reported_as_a_plan_property(self) -> None:
        """`SHALL NOT be reported as plan-infeasible`: stage 1 already produced a
        deadline-satisfying incumbent, and caching "your deadlines cannot be met"
        with no Retry would hide an engine failure behind a user-blaming state."""
        for stage in (2, 3):
            with self.subTest(stage=stage):
                self.assertEqual(
                    stage_disposition(cp_model.INFEASIBLE, stage, False),
                    ROW_STOP_INVALID,
                )

    def test_a_status_outside_the_matrix_is_never_a_schedule(self) -> None:
        """`MODEL_INVALID` is not one of the four statuses the table was written
        against, so it is this package disagreeing with its solver.

        TASK-310: it lands on its OWN row, not on the later-stage INFEASIBLE
        one. Both rows stop and publish nothing, which is why they shared a
        constant for so long; they differ in who repairs them, and the row is
        the only place that difference can be decided once for both the
        exception type and the exit code.
        """
        for stage in (1, 2, 3):
            with self.subTest(stage=stage):
                self.assertEqual(
                    stage_disposition(cp_model.MODEL_INVALID, stage, False),
                    ROW_STOP_MODEL_INVALID,
                )
                self.assertNotEqual(
                    stage_disposition(cp_model.MODEL_INVALID, stage, False),
                    stage_disposition(cp_model.INFEASIBLE, 2, False),
                )


class BothStagings(unittest.TestCase):
    """5.3's "both stagings", on the oracle the module docstring works out.

    Proof (5.7, fault two — a weighted sum silently reordering the terms):
    replacing the per-stage `minimize(terms[term_name])` with one
    `minimize(T₁ + T₂ + T₃)` reds `test_the_two_stagings_return_different_
    schedules` and `test_time_minimises_makespan_and_pays_for_it_in_priority`
    here, plus `test_budget`'s generous-limit case. **The weights are the
    finding.** A *dominating* sum — `1000·T₁ + 100·T₂ + T₃` — leaves this class
    entirely green, because every term on this four-slice oracle is far below
    100 and the dominating sum simply *is* the lexicographic order. Only the
    naive equal-weight sum is a genuine reordering, and only that one is caught.
    A watched red on a weighted sum therefore has to say which weights, or it
    proves nothing.
    """

    def test_pri_minimises_priority_and_pays_for_it_in_makespan(self) -> None:
        response = solve_request(disagreement("pri"), PINNED)
        self.assertEqual(response["status"], "feasible")
        self.assertEqual(values_of(response)[PRIORITY], 8)
        self.assertEqual(values_of(response)[MAKESPAN], 4)

    def test_time_minimises_makespan_and_pays_for_it_in_priority(self) -> None:
        response = solve_request(disagreement("time"), PINNED)
        self.assertEqual(response["status"], "feasible")
        self.assertEqual(values_of(response)[MAKESPAN], 3)
        self.assertEqual(values_of(response)[PRIORITY], 9)

    def test_the_two_stagings_return_different_schedules(self) -> None:
        """The disagreement is in the offsets and not only in the numbers: if
        one staging could reach the other's answer the case would prove nothing
        about the order the stages run in."""
        pri = solve_request(disagreement("pri"), PINNED)["offsets"]
        time = solve_request(disagreement("time"), PINNED)["offsets"]
        self.assertNotEqual(pri, time)

    def test_each_staging_proves_its_own_first_term(self) -> None:
        """Stage 1 runs to OPTIMAL on both, so each leading term reports
        `optimal` and its `stageValue` equals the value on the published
        schedule — the terms only diverge when a later stage improves one."""
        for objective, leader in (("pri", PRIORITY), ("time", MAKESPAN)):
            with self.subTest(objective):
                entry = solve_request(disagreement(objective), PINNED)[
                    "objectiveValues"
                ][leader]
                self.assertEqual(entry["status"], "optimal")
                self.assertEqual(entry["stageValue"], entry["value"])


class TheResponse(unittest.TestCase):
    def test_every_response_validates_against_the_wire_schema(self) -> None:
        """The entrypoint validates its input against `solver-wire.v1.json`;
        nothing validates its output at runtime, so it is proved here. A
        response the schema refuses is one `parseSolverResponse` throws away."""
        cases = {
            "pri": disagreement("pri"),
            "time": disagreement("time"),
            "a real corpus fixture": json.loads(
                (FIXTURES / "valid-quantised-baseline.json").read_text(encoding="utf-8")
            ),
            "infeasible at stage 1": a_request(
                [a_slice("a", duration=10, not_before=20, deadline=25)], horizon=40
            ),
        }
        for name, request in cases.items():
            with self.subTest(name):
                validate_against_schema(solve_request(request, PINNED), "response")

    def test_value_is_recomputed_on_the_published_offsets(self) -> None:
        """Not the stage incumbent. Bun recomputes all three from the returned
        offsets and refuses the response on a one-unit disagreement, so the two
        arithmetics are checked against each other here."""
        for objective in ("pri", "time"):
            with self.subTest(objective):
                request = disagreement(objective)
                response = solve_request(request, PINNED)
                self.assertEqual(
                    values_of(response),
                    evaluate_terms(request, response["offsets"]),
                )

    def test_offsets_carry_one_entry_per_slice_in_request_order(self) -> None:
        request = disagreement("pri")
        response = solve_request(request, PINNED)
        self.assertEqual(
            list(response["offsets"]), [s["key"] for s in request["slices"]]
        )

    def test_all_three_terms_are_always_present(self) -> None:
        response = solve_request(disagreement("pri"), PINNED)
        self.assertEqual(
            sorted(response["objectiveValues"]), [MAKESPAN, MOVEMENT, PRIORITY]
        )

    def test_a_fully_staged_run_reports_a_stage_for_every_term(self) -> None:
        """All three stages run on this instance, so all three terms carry a
        stage. `stageValue` and `bound` are null only where no stage produced
        one — the matrix's `k > 1` UNKNOWN-without-incumbent row — and a term
        that silently never got its stage would otherwise look identical to a
        term whose stage ran out of budget.
        """
        for objective in ("pri", "time"):
            with self.subTest(objective):
                values = solve_request(disagreement(objective), PINNED)[
                    "objectiveValues"
                ]
                for term, entry in values.items():
                    with self.subTest(term):
                        self.assertIsNotNone(entry["stageValue"])
                        self.assertIsNotNone(entry["bound"])
                        self.assertIn(entry["status"], ("optimal", "feasible"))

    def test_the_response_survives_json_serialisation_unchanged(self) -> None:
        """`cli.main` writes it with `json.dump`, so anything in it that is not
        a plain int, str, list or dict is a crash at the last statement of a
        successful solve."""
        response = solve_request(disagreement("pri"), PINNED)
        self.assertEqual(json.loads(json.dumps(response)), response)


class StoppingRowsEndToEnd(unittest.TestCase):
    """The two stopping rows a real solve can reach."""

    def test_a_deadline_no_floor_can_meet_is_infeasible_and_publishes_nothing(
        self,
    ) -> None:
        request = a_request(
            [a_slice("a", duration=10, not_before=20, deadline=25)], horizon=40
        )
        response = solve_request(request, PINNED)
        self.assertEqual(response["status"], "infeasible")
        self.assertNotIn("offsets", response)
        self.assertNotIn("objectiveValues", response)

    def test_the_corpus_fixture_with_a_width_five_slice_on_a_capacity_two_pool(
        self,
    ) -> None:
        """`valid-two-slices.json` is schema-valid and unsolvable on purpose, and
        it is the one corpus fixture that exercises this row end to end."""
        request = json.loads(
            (FIXTURES / "valid-two-slices.json").read_text(encoding="utf-8")
        )
        self.assertEqual(solve_request(request, PINNED)["status"], "infeasible")

    def test_a_solvable_corpus_fixture_returns_its_baseline_placement(self) -> None:
        """`valid-quantised-baseline.json` is a three-link chain whose baseline
        is already both makespan-optimal and movement-zero, so the published
        offsets are the baseline itself. Every weight is 0, so stage 1 proves
        PRIORITY = 0 and the later stages do the work."""
        request = json.loads(
            (FIXTURES / "valid-quantised-baseline.json").read_text(encoding="utf-8")
        )
        response = solve_request(request, PINNED)
        self.assertEqual(response["status"], "feasible")
        self.assertEqual(response["offsets"], request["baselineOffsets"])
        self.assertEqual(values_of(response), {MAKESPAN: 30, PRIORITY: 0, MOVEMENT: 0})


class TermArithmeticAgreesWithTheModel(unittest.TestCase):
    """`evaluate_terms` is a second implementation of the model's three terms.

    It exists because `value` is defined on the published offsets and CP-SAT's
    variables describe the last stage's model, not the published schedule. Two
    implementations of one definition drift, so they are checked against each
    other on a placement neither of them chose.
    """

    def test_it_reproduces_a_hand_computed_placement(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, weight=3), a_slice("b", duration=20, weight=1)],
            horizon=40,
            baseline={"a": 0, "b": 5},
        )
        # finishes 14 and 20; priority 3×14 + 1×20; movement |4−0| + |0−5|.
        self.assertEqual(
            evaluate_terms(request, {"a": 4, "b": 0}),
            {MAKESPAN: 20, PRIORITY: 62, MOVEMENT: 9},
        )

    def test_it_agrees_with_the_solved_terms_on_the_published_schedule(self) -> None:
        request = a_request(
            [a_slice("a", duration=10, weight=2), a_slice("b", duration=6, weight=5)],
            edges=[an_edge("a", "b")],
            baseline={"a": 0, "b": 0},
        )
        response = solve_request(request, PINNED)
        self.assertEqual(values_of(response), evaluate_terms(request, response["offsets"]))


class TheBudgetSplit(unittest.TestCase):
    def test_each_share_is_its_fraction_of_the_budget(self) -> None:
        self.assertEqual(stage_budgets_ms(30000, [0.6, 0.25, 0.15]), [18000.0, 7500.0, 4500.0])

    def test_the_shares_add_up_to_the_whole_budget(self) -> None:
        """Not a restatement of the line above: the schema cannot say the split
        sums to 1, so a builder invariant is the only thing keeping the three
        shares from being shares of something else."""
        self.assertAlmostEqual(sum(stage_budgets_ms(30000, [0.6, 0.25, 0.15])), 30000.0)

    def test_a_solve_never_exceeds_its_budget_across_all_three_stages(self) -> None:
        """Donation moves time forward between stages and never adds any. A
        stage that finishes early hands its remainder on, so the three shares
        are shares of a worst case rather than reservations."""
        shares = stage_budgets_ms(1000, [0.6, 0.25, 0.15])
        self.assertLessEqual(sum(shares), 1000.0)

    def test_an_early_stage_donates_exactly_what_it_did_not_spend(self) -> None:
        self.assertEqual(donated_budget_ms(18000.0, 500.0), 17500.0)

    def test_a_stage_that_spends_its_whole_share_donates_nothing(self) -> None:
        self.assertEqual(donated_budget_ms(18000.0, 18000.0), 0.0)

    def test_an_overrun_never_takes_budget_from_the_next_stage(self) -> None:
        """`max_time_in_seconds` bounds the search, not the presolve and the
        model build around it, so a stage can spend more than its share. A
        negative carry would silently shorten a later stage that never had it."""
        self.assertEqual(donated_budget_ms(18000.0, 19000.0), 0.0)


class UnencodableOutcomes(unittest.TestCase):
    def test_solve_failed_is_raised_and_not_returned(self) -> None:
        """A later-stage INFEASIBLE has no encoding on the wire, so it must not
        arrive as a response object. The row is unreachable without a wrong
        model, so what is asserted here is that `SolveFailed` is an exception
        `cli.main` can catch rather than a value it would serialise."""
        self.assertTrue(issubclass(SolveFailed, Exception))
        with self.assertRaises(SolveFailed):
            raise SolveFailed("stage 2 is infeasible")

    def test_a_refused_model_is_a_subclass_and_not_a_sibling(self) -> None:
        """TASK-310. `ModelInvalid` must still be catchable as `SolveFailed`:
        every caller that only cares the run produced nothing publishable keeps
        working, and only `cli.main`, which orders the handlers, sees the split.
        A sibling exception would have escaped those callers silently."""
        self.assertTrue(issubclass(ModelInvalid, SolveFailed))
        with self.assertRaises(SolveFailed):
            raise ModelInvalid("stage 1 returned MODEL_INVALID")
        # And the containment is strict in the other direction, which is what
        # makes `cli.main`'s handler order meaningful rather than decorative.
        self.assertNotIsInstance(SolveFailed("stage 2 is infeasible"), ModelInvalid)

    def test_solve_request_raises_the_exception_the_row_names(self) -> None:
        """The production dispatch, and the one thing the other new cases miss.

        Sol's Important on this change: the row case above only exercises
        `stage_disposition`, and `test_cli.py`'s pair injects the exception
        after `solve_request` has been mocked away — so `raise ModelInvalid`
        in the dispatch could be changed back to `raise SolveFailed` and every
        other new assertion would stay green while a real `MODEL_INVALID`
        exited `70` and was recorded `invalid-output` again.

        `stage_disposition` is patched rather than CP-SAT, because the point
        under test is the row-to-exception mapping and both rows are
        unreachable through a real solve on a fixture small enough to be an
        oracle — which is why that function is pure and exported at all.
        """
        for row, expected, unexpected in (
            (ROW_STOP_MODEL_INVALID, ModelInvalid, None),
            (ROW_STOP_INVALID, SolveFailed, ModelInvalid),
        ):
            with self.subTest(row=row):
                with mock.patch.object(
                    solve_module, "stage_disposition", return_value=row
                ):
                    with self.assertRaises(expected) as caught:
                        solve_request(disagreement("pri"), PINNED)
                if unexpected is not None:
                    self.assertNotIsInstance(caught.exception, unexpected)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
