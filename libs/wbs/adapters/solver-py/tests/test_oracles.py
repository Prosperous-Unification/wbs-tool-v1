"""5.4's oracle cases: hand-verified instances the solver must reproduce exactly.

WHAT MAKES A CASE AN ORACLE HERE
--------------------------------
Every number in this file is arithmetic on the instance, worked out in the
docstring above the case before the solver was ever run on it. Nothing asserts
what CP-SAT happened to return. That is the whole value: a test written from the
solver's output proves the solver is deterministic, not that it is right.

Each instance is small enough that the optimum is **unique**, so the offsets can
be asserted whole rather than by their objective values. Where that took a
weight to arrange, the docstring says so and shows the runner-up placement it
excludes.

WHY EACH CASE ALSO CARRIES ITS OWN CONTRAST
-------------------------------------------
5.4 names one constraint per case, and an instance that satisfies a constraint
by accident proves nothing about it. So each case is solved twice: once as
built, and once with exactly the named constraint relaxed — the second pool
membership dropped, the edge removed, `notBeforeUnits` returned to 0. The
relaxed instance has a *different* hand-computed optimum, asserted too. A model
that ignored the constraint would return the relaxed answer for both.

THE DISAGREEMENT CASE IS NOT HERE
---------------------------------
5.4's "one where PRI and Time disagree" is the `1,1,1,3` counterexample, and it
already lives in `test_solve.py` where the staging loop it exists to separate is
tested. Copying it here would be two tests of one instance. The three cases in
this file are the other three 5.4 names, and each is solved under *both*
objectives: they agree, and that agreement is itself the claim — these
instances are pinned by a constraint, not by the order the stages run in.
"""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from typing import Any, Mapping

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from test_model import a_request, a_slice, an_edge  # noqa: E402

from wbs_solver.model import MAKESPAN, MOVEMENT, PRIORITY  # noqa: E402
from wbs_solver.solve import SolverConfig, solve_request  # noqa: E402

# Same pin as `test_solve.py`, for the same reason: every instance below is
# proved OPTIMAL in milliseconds, so nothing here depends on a budget, and the
# pin stops a case passing on which worker found an incumbent first.
PINNED = SolverConfig(num_search_workers=1, random_seed=0)


def solved(request: Mapping[str, Any]) -> tuple[dict[str, int], dict[str, int]]:
    """`(offsets, term values)` for one request. Every case reads both."""
    response = solve_request(dict(request), PINNED)
    assert response["status"] == "feasible", response["status"]
    return response["offsets"], {
        term: entry["value"] for term, entry in response["objectiveValues"].items()
    }


class OracleCase(unittest.TestCase):
    """Assert one instance's whole optimum under both objectives."""

    def assert_optimum(
        self,
        build,
        *,
        offsets: Mapping[str, int],
        priority: int,
        makespan: int,
        movement: int,
    ) -> None:
        for objective in ("pri", "time"):
            with self.subTest(objective=objective):
                got_offsets, got_values = solved(build(objective))
                self.assertEqual(got_offsets, dict(offsets))
                self.assertEqual(got_values[PRIORITY], priority)
                self.assertEqual(got_values[MAKESPAN], makespan)
                self.assertEqual(got_values[MOVEMENT], movement)


class NotBeforeUnits(OracleCase):
    """Two slices in a capacity-1 pool, one of them released late.

    `early` is duration 2, `late` is duration 3 with `notBeforeUnits = 5`. Both
    weigh 1 and the pool holds 1, so they cannot overlap.

    **By hand.** `late` cannot start before 5, so it occupies `[5, 8)` and
    finishes at **8**; starting it any later only costs. `early` is then free to
    take `[0, 2)`, which does not overlap, and finishes at **2**; any other
    placement raises its finish. So the optimum is unique:
    offsets `{early: 0, late: 5}`, `PRIORITY = 2 + 8 = 10`, `MAKESPAN = 8`, and
    `MOVEMENT = 0 + 5 = 5` against the all-zero baseline.

    **The point of the case.** The makespan floor here is *not* total work,
    which is 5. It is `notBeforeUnits + duration` of the late slice. A model that
    dropped the release time would pack both into `[0, 5)` and answer 5 — which
    is the relaxed optimum asserted below.
    """

    def build(self, objective: str, *, not_before: int = 5) -> dict[str, Any]:
        return a_request(
            [
                a_slice("early", duration=2, width=1, pools=["t"], weight=1),
                a_slice("late", duration=3, width=1, pools=["t"], weight=1, not_before=not_before),
                # The default horizon is computed from `notBeforeUnits`, so the
                # relaxed instance must not be allowed a smaller one — an
                # instance that differed in two ways would prove neither.
            ],
            pools={"t": 1},
            horizon=10,
            objective=objective,
        )

    def test_the_late_slice_waits_and_the_early_one_does_not(self) -> None:
        self.assert_optimum(
            self.build, offsets={"early": 0, "late": 5}, priority=10, makespan=8, movement=5
        )

    def test_relaxing_the_release_time_changes_the_answer(self) -> None:
        """`notBeforeUnits = 0` and nothing else. Now the pair is serial only by
        capacity: the shorter first, finishes 2 and 5, `PRIORITY = 7`,
        `MAKESPAN = 5` — the total work, which is what the constraint was
        holding the answer away from."""
        self.assert_optimum(
            lambda objective: self.build(objective, not_before=0),
            offsets={"early": 0, "late": 2},
            priority=7,
            makespan=5,
            movement=2,
        )


class TwoPoolSlice(OracleCase):
    """One slice drawing on two pools of different capacity.

    `both` names `t1` (capacity 2) and `t2` (capacity 1); `only1` names `t1`,
    `only2` names `t2`. Every slice is width 1, duration 2. One cumulative is
    posted per pool over the members that name it, so `both` spends its width in
    **each** — and is therefore bound by the tighter of the two.

    **By hand.** In `t1` (capacity 2) `both` and `only1` may run together. In
    `t2` (capacity 1) `both` and `only2` may not. So one of that pair finishes at
    4 and `only1` is free at `[0, 2)`. `both` weighs 2 and the others 1, which
    picks between the two symmetric orders:

    * `both` at 0 — `PRIORITY = 2·2 + 1·2 + 1·4 = 10`
    * `both` at 2 — `PRIORITY = 2·4 + 1·2 + 1·2 = 12`

    So the optimum is unique: offsets `{both: 0, only1: 0, only2: 2}`,
    `PRIORITY = 10`, `MAKESPAN = 4`, `MOVEMENT = 0 + 0 + 2 = 2`.

    **The point of the case.** The second membership is doing all the work. Drop
    `t2` from `both` and nothing serialises anything: all three run at `[0, 2)`
    for `PRIORITY = 8` and `MAKESPAN = 2`, asserted below.
    """

    def build(self, objective: str, *, both_pools=("t1", "t2")) -> dict[str, Any]:
        return a_request(
            [
                a_slice("both", duration=2, width=1, pools=list(both_pools), weight=2),
                a_slice("only1", duration=2, width=1, pools=["t1"], weight=1),
                a_slice("only2", duration=2, width=1, pools=["t2"], weight=1),
            ],
            pools={"t1": 2, "t2": 1},
            objective=objective,
        )

    def test_the_slice_is_bound_by_the_tighter_of_its_two_pools(self) -> None:
        self.assert_optimum(
            self.build,
            offsets={"both": 0, "only1": 0, "only2": 2},
            priority=10,
            makespan=4,
            movement=2,
        )

    def test_dropping_the_second_membership_frees_the_instance(self) -> None:
        self.assert_optimum(
            lambda objective: self.build(objective, both_pools=("t1",)),
            offsets={"both": 0, "only1": 0, "only2": 0},
            priority=8,
            makespan=2,
            movement=0,
        )


class IntraItemStepOrder(OracleCase):
    """Two steps of one work item, ordered by an edge and by nothing else.

    Both keys are `sliceKey()` results for the same work item — the `U+0000`
    separator with one item id on the left — because "intra-item step order" is a
    statement about keys that share that left half. The pool holds 2 and each
    slice is width 1, so capacity orders nothing: the edge is the only reason
    these two cannot run together.

    **By hand.** The edge posts `end[step-a] <= start[step-b]`. `step-a` is
    duration 2 and `step-b` is duration 3, both weight 1. `step-a` at 0 finishes
    at 2, which is the earliest `step-b` may start, so it occupies `[2, 5)` and
    finishes at **5**. Nothing improves on that: delaying `step-a` delays both.
    Unique optimum — offsets `{step-a: 0, step-b: 2}`, `PRIORITY = 2 + 5 = 7`,
    `MAKESPAN = 5`, `MOVEMENT = 0 + 2 = 2`.

    **The point of the case.** Remove the edge and the capacity-2 pool lets both
    run at `[0, 2)` and `[0, 3)`: `PRIORITY = 5`, `MAKESPAN = 3`. Asserted below,
    so the ordering cannot be coming from anywhere else in the model.
    """

    ITEM = "wi-7"
    STEP_A = f"{ITEM}\x00step-a"
    STEP_B = f"{ITEM}\x00step-b"

    def build(self, objective: str, *, ordered: bool = True) -> dict[str, Any]:
        return a_request(
            [
                a_slice(self.STEP_A, duration=2, width=1, pools=["t"], weight=1),
                a_slice(self.STEP_B, duration=3, width=1, pools=["t"], weight=1),
            ],
            edges=[an_edge(self.STEP_A, self.STEP_B)] if ordered else [],
            pools={"t": 2},
            objective=objective,
        )

    def test_the_steps_of_one_item_run_in_order(self) -> None:
        self.assert_optimum(
            self.build,
            offsets={self.STEP_A: 0, self.STEP_B: 2},
            priority=7,
            makespan=5,
            movement=2,
        )

    def test_the_keys_share_an_item_and_differ_only_after_the_separator(self) -> None:
        """Otherwise this is an ordinary edge case wearing the name of an
        intra-item one, and the distinction 5.4 draws would be untested."""
        self.assertEqual(self.STEP_A.split("\x00")[0], self.STEP_B.split("\x00")[0])
        self.assertNotEqual(self.STEP_A, self.STEP_B)
        offsets, _ = solved(self.build("pri"))
        self.assertEqual(sorted(offsets), sorted([self.STEP_A, self.STEP_B]))

    def test_removing_the_edge_lets_both_steps_start_together(self) -> None:
        self.assert_optimum(
            lambda objective: self.build(objective, ordered=False),
            offsets={self.STEP_A: 0, self.STEP_B: 0},
            priority=5,
            makespan=3,
            movement=0,
        )


class TheInstancesAreNotAccidentallyIdentical(unittest.TestCase):
    """Each case above must differ from its own relaxation in exactly one field.

    A contrast that changed two things would explain nothing, and the horizon is
    the easy one to change by accident — `a_request` derives it from
    `notBeforeUnits` when it is not given, which is why `NotBeforeUnits` pins it.
    """

    def test_only_the_named_field_differs(self) -> None:
        cases = (
            (NotBeforeUnits().build("pri"), NotBeforeUnits().build("pri", not_before=0)),
            (TwoPoolSlice().build("pri"), TwoPoolSlice().build("pri", both_pools=("t1",))),
            (
                IntraItemStepOrder().build("pri"),
                IntraItemStepOrder().build("pri", ordered=False),
            ),
        )
        expected = ({"slices"}, {"slices"}, {"edges"})
        for (built, relaxed), fields in zip(cases, expected):
            with self.subTest(fields=sorted(fields)):
                differing = {k for k in built if built[k] != relaxed[k]}
                self.assertEqual(differing, fields)

    def test_the_relaxations_do_not_mutate_the_originals(self) -> None:
        """`a_slice` copies, but a helper that stopped copying would make every
        contrast above compare an instance with itself."""
        case = TwoPoolSlice()
        first = case.build("pri")
        snapshot = copy.deepcopy(first)
        case.build("pri", both_pools=("t1",))
        self.assertEqual(first, snapshot)


if __name__ == "__main__":
    unittest.main()
