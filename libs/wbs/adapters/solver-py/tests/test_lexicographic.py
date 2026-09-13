"""5.10's replacement for 5.7's weighted-sum mutation.

WHY 5.7's MUTATION HAD TO BE REPLACED
--------------------------------------
5.7 asked for "the staged loop collapsed to a weighted sum" and run 18 measured
what that actually proves. On its four-slice PRI/Time-disagreement oracle,
`1000·T₁ + 100·T₂ + T₃` leaves `BothStagings` **green** — every term on that
instance is far below 100, so a dominating sum simply *is* the lexicographic
order and reorders nothing. Only the naive `T₁ + T₂ + T₃` reds. So the mutation
was green exactly where a real implementation would most plausibly go wrong, and
5.10 replaced it: "sufficiently large coefficients encode the same lexicographic
order exactly, so PRI/Time disagreement proves nothing about staged versus
weighted."

WHAT THIS FIXTURE DOES INSTEAD
-------------------------------
5.10's rule: build the instance so "the second term's swing exceeds the first
term's coefficient gap — an answer that necessarily changes". Under `pri` the
order is (PRIORITY, MAKESPAN, MOVEMENT) and the coefficients under test are
`1000 / 100 / 1`, so one unit of PRIORITY is worth ten units of MAKESPAN. The
instance therefore has to make **one** unit of PRIORITY cost **more than ten**
units of MAKESPAN.

`W` and `S` share a person, so they serialise; `S` heads a twenty-link chain, so
whatever delays `S` delays the whole tail; and `W` is fifteen units long, so
putting `W` first delays that tail by fifteen. `W` is the only weighted slice,
so PRIORITY is just `W`'s own finish:

| placement | PRIORITY | MAKESPAN | MOVEMENT vs the baseline |
|---|---|---|---|
| `W` first (`W`@0, `S`@15) | **15** | **36** | 0 |
| `S` first (`S`@0, `W`@1) | **16** | **21** | 316 |

One unit of PRIORITY buys fifteen units of MAKESPAN, and fifteen is greater than
ten. Measured on the gate host, ortools 9.15.6755, one worker, seed 0, every
solve proved OPTIMAL:

| objective minimised | answer | PRIORITY | MAKESPAN |
|---|---|---|---|
| the shipped staged loop | `W`@0 | 15 | 36 |
| `1000·T₁ + 100·T₂ + T₃` | **`S`@0** | **16** | **21** |
| `1·T₁ + 1·T₂ + 1·T₃` | `W`@0 | 15 | 36 |
| `10⁶·T₁ + 10³·T₂ + T₃` | `W`@0 | 15 | 36 |

**The last two rows are the point of 5.10 and are asserted, not decoration.**
This fixture is the exact complement of 5.7's: there the dominating sum was green
and the equal-weight sum red, here the dominating sum is red and *both* the
equal-weight and the larger sum are green. So neither "the coefficients are big"
nor "the coefficients are equal" decides whether a weighted form is faithful —
only whether the gap exceeds the swing does. A mutation whose coefficients are
not named, and whose fixture is not built against them, is a coin flip either
way.

5.9's BOUND CHOOSES THIS FILE'S BASELINE, AND THE OBVIOUS CHOICE WAS WRONG
---------------------------------------------------------------------------
`solve_request` installs 5.9's bound, `T₁ ≤ baselineT₁`. Baselined on `w_first` —
the lexicographic answer, and the obvious pick — that bound is `PRIORITY ≤ 15`
and it **excludes the S-first placement outright**. Correctly: S-first is worse
than the quantised baseline on stage 1's term, which is exactly what the bound
exists to exclude. But then the collapse cannot move `solve_request`'s answer,
and this file goes green under its own target mutation. Measured, not predicted:
run 19 chunk 3 replaced stage 1's objective with `1000·T₁ + 100·T₂ + T₃` and
watched `TheStagedLoopIsLexicographic` pass while `test_solve.BothStagings` and
`test_budget` caught it.

The baseline is therefore `s_first` (PRIORITY 16), so the bound admits both
placements and is present without being decisive. The weighted comparison itself
still runs on `build_model`: it asks which objective picks which placement, and
installing a bound on the mutant would be comparing two different models.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any, Mapping, Sequence

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from ortools.sat.python import cp_model  # noqa: E402
from test_model import a_request, a_slice, an_edge  # noqa: E402

from wbs_solver.model import MAKESPAN, MOVEMENT, PRIORITY, build_model  # noqa: E402
from wbs_solver.solve import SolverConfig, evaluate_terms, solve_request  # noqa: E402
from wbs_solver.validate import (  # noqa: E402
    MAX_SAFE_INTEGER,
    RequestRejected,
    check_cross_field,
    validate_against_schema,
)

CHAIN = 20
W_DURATION = 15

# The four measured outcomes above, as the two placements they choose between.
W_FIRST_PRIORITY = 15
W_FIRST_MAKESPAN = 36
S_FIRST_PRIORITY = 16
S_FIRST_MAKESPAN = 21

# The implementation's own dominating coefficients — 5.7's, the ones that stayed
# green there — and the two contrasts that make the swing rule visible.
DOMINATING = (1000, 100, 1)
EQUAL = (1, 1, 1)
LARGER = (10**6, 10**3, 1)

# Enough to prove this instance: every probe returned OPTIMAL well inside it.
PROOF_LIMIT = 20.0


def _slices() -> list[dict[str, Any]]:
    out = [
        a_slice("W", duration=W_DURATION, weight=1, person="p"),
        a_slice("S", duration=1, weight=0, person="p"),
    ]
    out.extend(a_slice(f"T{i}", duration=1, weight=0) for i in range(CHAIN))
    return out


def _edges() -> list[dict[str, str]]:
    out = [an_edge("S", "T0")]
    out.extend(an_edge(f"T{i}", f"T{i + 1}") for i in range(CHAIN - 1))
    return out


def w_first() -> dict[str, int]:
    """`W` at 0, the whole chain pushed behind it. The lexicographic answer."""
    offsets = {"W": 0, "S": W_DURATION}
    cursor = W_DURATION + 1
    for index in range(CHAIN):
        offsets[f"T{index}"] = cursor
        cursor += 1
    return offsets


def s_first() -> dict[str, int]:
    """`S` at 0 so the chain runs early; `W` takes the person straight after."""
    offsets = {"S": 0, "W": 1}
    for index in range(CHAIN):
        offsets[f"T{index}"] = index + 1
    return offsets


def instance(baseline: Mapping[str, int] | None = None) -> dict[str, Any]:
    """A fresh request per call, baselined on `s_first` **deliberately**.

    `w_first` is the obvious choice — it is what the shipped loop returns — and
    it is wrong here, measured rather than reasoned. With it, 5.9's bound is
    `PRIORITY ≤ 15`, which excludes the `S`-first placement (PRIORITY 16)
    outright; the collapse this file exists to catch then cannot move
    `solve_request`'s answer, and `TheStagedLoopIsLexicographic` stays green
    under its own target mutation. Run 19 chunk 3 injected that mutation and
    watched this file pass while `test_solve.BothStagings` and `test_budget`
    caught it.

    `s_first` has PRIORITY 16, so the bound is `PRIORITY ≤ 16` and admits both
    placements. It is a feasible placement, so the bound is still installed and
    this file still solves the shipped model rather than a bound-free one — the
    bound is present and simply not decisive, which is the state a mutation test
    of the staging needs.
    """
    return a_request(
        _slices(),
        edges=_edges(),
        baseline=dict(baseline if baseline is not None else s_first()),
        objective="pri",
    )


def _proved(model: cp_model.CpModel) -> tuple[int, cp_model.CpSolver]:
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.max_deterministic_time = PROOF_LIMIT
    return solver.solve(model), solver


def admits(request: Mapping[str, Any], placement: Mapping[str, int]) -> bool:
    built = build_model(request)
    for key, var in built.starts.items():
        built.model.add(var == int(placement[key]))
    status, _ = _proved(built.model)
    return status in (cp_model.OPTIMAL, cp_model.FEASIBLE)


def under_weighted_sum(
    request: Mapping[str, Any], coefficients: Sequence[int]
) -> dict[str, int]:
    """The mutation: one weighted minimise in place of the staged loop.

    Raises rather than returning a partial answer if the solve does not prove an
    optimum — a mutation compared at an unproved incumbent would be comparing
    search order, which is the flake 5.6 and 5.5 both refuse.
    """
    built = build_model(request)
    first, second, third = coefficients
    built.model.minimize(
        first * built.terms[PRIORITY]
        + second * built.terms[MAKESPAN]
        + third * built.terms[MOVEMENT]
    )
    status, solver = _proved(built.model)
    if status != cp_model.OPTIMAL:
        raise AssertionError(
            f"the weighted form did not prove an optimum at {coefficients}: "
            f"{solver.status_name(status)}"
        )
    return {key: int(solver.value(var)) for key, var in built.starts.items()}


class TheTwoPlacementsAreBothRealAndAreHandComputed(unittest.TestCase):
    """Neither row of the table is a search outcome."""

    def setUp(self) -> None:
        self.request = instance()

    def test_both_placements_are_admitted_by_the_model(self) -> None:
        # Without this the mutation case would pass on a model that refuses
        # `S`-first for some entirely different reason.
        self.assertTrue(admits(self.request, w_first()))
        self.assertTrue(admits(self.request, s_first()))

    def test_the_w_first_terms(self) -> None:
        terms = evaluate_terms(self.request, w_first())
        self.assertEqual(terms[PRIORITY], W_FIRST_PRIORITY)
        self.assertEqual(terms[MAKESPAN], W_FIRST_MAKESPAN)

    def test_the_s_first_terms(self) -> None:
        terms = evaluate_terms(self.request, s_first())
        self.assertEqual(terms[PRIORITY], S_FIRST_PRIORITY)
        self.assertEqual(terms[MAKESPAN], S_FIRST_MAKESPAN)

    def test_one_unit_of_priority_buys_more_makespan_than_the_gap(self) -> None:
        # 5.10's construction rule, checked as arithmetic rather than trusted:
        # the second term's swing must exceed the first term's coefficient gap.
        first, second, _ = DOMINATING
        priority_gap = S_FIRST_PRIORITY - W_FIRST_PRIORITY
        makespan_swing = W_FIRST_MAKESPAN - S_FIRST_MAKESPAN
        self.assertGreater(second * makespan_swing, first * priority_gap)


class TheStagedLoopIsLexicographic(unittest.TestCase):
    """The shipped answer, which is the one the mutation must move."""

    def setUp(self) -> None:
        self.response = solve_request(
            instance(),
            SolverConfig(
                num_search_workers=1,
                random_seed=0,
                deterministic_time_per_stage=PROOF_LIMIT,
            ),
        )

    def test_it_takes_the_better_priority_and_pays_the_makespan(self) -> None:
        values = self.response["objectiveValues"]
        self.assertEqual(values[PRIORITY]["value"], W_FIRST_PRIORITY)
        self.assertEqual(values[MAKESPAN]["value"], W_FIRST_MAKESPAN)

    def test_it_proves_both_terms_at_this_limit(self) -> None:
        # An unproved staged answer would make the comparison below a race
        # between two truncations rather than between two objectives.
        values = self.response["objectiveValues"]
        self.assertEqual(values[PRIORITY]["status"], "optimal")
        self.assertEqual(values[MAKESPAN]["status"], "optimal")


class TheWeightedFormAnswersDifferently(unittest.TestCase):
    """5.10's mutation, at the coefficients 5.7's version stayed green on."""

    def test_the_dominating_sum_moves_the_answer(self) -> None:
        offsets = under_weighted_sum(instance(), DOMINATING)
        self.assertEqual(offsets["S"], 0)
        self.assertEqual(offsets["W"], 1)
        terms = evaluate_terms(instance(), offsets)
        self.assertEqual(terms[PRIORITY], S_FIRST_PRIORITY)
        self.assertEqual(terms[MAKESPAN], S_FIRST_MAKESPAN)

    def test_the_equal_weight_sum_moves_it_too_but_on_movement(self) -> None:
        # Measured, and it flipped when the baseline moved from `w_first` to
        # `s_first`: MOVEMENT is the only term defined *relative to the
        # baseline*, so `1/1/1` here scores W-first at 15 + 36 + 316 and S-first
        # at 16 + 21 + 0 and picks S-first on the movement alone. Against the
        # `w_first` baseline the same coefficients picked W-first.
        #
        # That is a third way for a weighted form to be unfaithful, and the one
        # a fixture cannot design around: two of its three terms are properties
        # of the schedule and the third is a property of the *question*. The
        # staged loop is immune — MOVEMENT is last under both objectives, so it
        # only ever breaks ties the first two terms left open.
        offsets = under_weighted_sum(instance(), EQUAL)
        self.assertEqual(offsets["W"], 1)

    def test_a_larger_dominating_sum_does_not_either(self) -> None:
        # And this is why "use big coefficients" is not the rule: 10⁶/10³ is a
        # thousand times 1000/100 and recovers the lexicographic answer exactly,
        # because now the gap does exceed the swing.
        offsets = under_weighted_sum(instance(), LARGER)
        self.assertEqual(offsets["W"], 0)



# ---------------------------------------------------------------------------
# 5.10's second half: the integer-overflow guard on the weighted form's bound.
# ---------------------------------------------------------------------------
#
# The cases above compare *answers* on a small fixture. These compare *bounds*
# at the wire's own ceilings, and they are a different argument: the fixture
# says a weighted form can be unfaithful, this says a weighted form can be
# unrepresentable — on a request the builder is obliged to accept.
#
# `solver-wire.v1.json` caps `horizonUnits` at 2³¹ − 1 and cross-field invariant
# 8 caps the two objective worst cases, `Σ w(s) × (horizonUnits + durationUnits(s))`
# for PRIORITY and `Σ |offset − baseline|` for MOVEMENT, at
# `Number.MAX_SAFE_INTEGER`. Those are
# per-term bounds. A weighted objective multiplies each term by a coefficient
# and adds them, so invariant 8 says nothing at all about the sum — which is the
# quantity CP-SAT has to represent.
#
# TOOLING NOTE, and it cost run 19 a probe: read a term's upper bound with
# `list(var.proto.domain)[-1]` or `var.domain.max()`, never
# `var.proto.domain[-1]`. `.proto.domain` is a protobuf repeated-scalar *view*,
# and a negative index into it returns **0** rather than the last element — on
# ortools 9.15.6755 `v.proto.domain[-1]` read 0 for a variable whose domain is
# `[0, 140]`. Both accessors used below agree, and one case asserts they do, so
# a future reader who reaches for `[-1]` gets a red rather than a zero.

# CP-SAT's own signed 64-bit ceiling, next to the wire's exactness bound
# imported above. The first is what the solver can hold; the second is what
# survives the round trip to the consumer that asked.
INT64_MAX = 2**63 - 1

# The schema's own maximum for `horizonUnits` — "Bounded by 2^31 − 1 here
# because the builder fails with horizon-overflow above it before spawning".
HORIZON_CEILING = 2**31 - 1

# The largest weight that keeps invariant 8's PRIORITY worst case under the bound
# on a single-slice request at that horizon. The worst case is over FINISHES, so
# on a slice one unit long it is w × ((2³¹ − 1) + 1) = w × 2³¹: at 2²² − 1 that
# is 9007197107257344 and inside the bound, and one more unit of weight is
# exactly 2⁵³, which is what the case below measures.
CEILING_WEIGHT = 2**22 - 1

# Enough for these instances: each is one slice and every solve below proved
# OPTIMAL well inside it.
CEILING_LIMIT = 30.0


def at_the_ceiling(weight: int = CEILING_WEIGHT, *, baseline_at_horizon: bool = False):
    """One slice, the schema's maximum horizon, and a weight at invariant 8's edge.

    Deliberately one slice: the overflow is a property of the coefficients
    against the wire's per-term ceilings, and adding slices would only make the
    same point with numbers nobody can check by hand.
    """
    offsets = {"a": HORIZON_CEILING} if baseline_at_horizon else None
    return a_request(
        [a_slice("a", duration=1, weight=weight)],
        horizon=HORIZON_CEILING,
        baseline=offsets,
    )


def term_upper_bounds(request: Mapping[str, Any]) -> dict[str, int]:
    """The three terms' domain ceilings, read the way the note above requires."""
    built = build_model(request)
    return {
        name: list(built.terms[name].proto.domain)[-1]
        for name in (MAKESPAN, PRIORITY, MOVEMENT)
    }


def weighted_bound(ub: Mapping[str, int], coefficients: Sequence[int]) -> int:
    """The largest value `c₁·T₁ + c₂·T₂ + c₃·T₃` can take on this model."""
    first, second, third = coefficients
    return first * ub[PRIORITY] + second * ub[MAKESPAN] + third * ub[MOVEMENT]


def objective_error(request: Mapping[str, Any], coefficients: Sequence[int] | None) -> str:
    """CP-SAT's own verdict on a model carrying this objective.

    `CpModel.validate()` returns the empty string for a model it will solve and
    a diagnostic for one it refuses. Asking it is the point: the arithmetic
    below is ours, and the answer that matters is the solver's.
    """
    built = build_model(request)
    if coefficients is None:
        built.model.minimize(built.terms[PRIORITY])
    else:
        first, second, third = coefficients
        built.model.minimize(
            first * built.terms[PRIORITY]
            + second * built.terms[MAKESPAN]
            + third * built.terms[MOVEMENT]
        )
    return built.model.validate()


class TheCeilingRequestIsWireLegal(unittest.TestCase):
    """Everything below rests on this instance being one the builder must send."""

    def test_it_passes_the_schema_and_the_cross_field_checks(self) -> None:
        request = at_the_ceiling()
        validate_against_schema(request, "request")
        check_cross_field(request)  # raises RequestRejected on any failure

    def test_it_satisfies_invariant_8(self) -> None:
        request = at_the_ceiling()
        priority_worst_case = sum(
            int(entry["priorityWeight"]) * (request["horizonUnits"] + int(entry["durationUnits"]))
            for entry in request["slices"]
        )
        movement_worst_case = sum(
            abs(int(request["fastHint"][key]) - int(request["baselineOffsets"][key]))
            for key in request["baselineOffsets"]
        )
        self.assertLessEqual(priority_worst_case, MAX_SAFE_INTEGER)
        self.assertLessEqual(movement_worst_case, MAX_SAFE_INTEGER)

    def test_every_term_on_its_own_is_within_the_wires_exactness_bound(self) -> None:
        for name, bound in term_upper_bounds(at_the_ceiling()).items():
            with self.subTest(term=name):
                self.assertLessEqual(bound, MAX_SAFE_INTEGER)

    def test_the_two_upper_bound_accessors_agree(self) -> None:
        """The guard on the tooling note: `[-1]` on the raw view is not one of them."""
        built = build_model(at_the_ceiling())
        for name in (MAKESPAN, PRIORITY, MOVEMENT):
            with self.subTest(term=name):
                var = built.terms[name]
                self.assertEqual(list(var.proto.domain)[-1], var.domain.max())


class TheStagedLoopIsRepresentableHere(unittest.TestCase):
    """The control. Whatever the weighted forms do, the shipped one solves."""

    def test_cp_sat_accepts_a_single_term_objective(self) -> None:
        self.assertEqual(objective_error(at_the_ceiling(), None), "")

    def test_and_proves_an_optimum(self) -> None:
        built = build_model(at_the_ceiling())
        built.model.minimize(built.terms[PRIORITY])
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = 0
        solver.parameters.max_deterministic_time = CEILING_LIMIT
        self.assertEqual(solver.solve(built.model), cp_model.OPTIMAL)


class TheWeightedFormsOverflowHere(unittest.TestCase):
    """Both coefficient sets this file already uses are refused at the ceilings.

    The staged loop minimises one term at a time, so its objective is a single
    variable and its bound is that variable's own — which invariant 8 already
    holds under `Number.MAX_SAFE_INTEGER`. That is the whole structural reason
    the shipped loop cannot overflow and a weighted collapse can.
    """

    def test_the_larger_sums_bound_exceeds_int64_outright(self) -> None:
        ub = term_upper_bounds(at_the_ceiling())
        self.assertGreater(weighted_bound(ub, LARGER), INT64_MAX)

    def test_the_dominating_sums_bound_does_not(self) -> None:
        """Measured, and it is why the next case is not a restatement of this one."""
        ub = term_upper_bounds(at_the_ceiling())
        self.assertLess(weighted_bound(ub, DOMINATING), INT64_MAX)

    def test_cp_sat_refuses_both_of_them_anyway(self) -> None:
        """The finding: fitting in int64 is not the same as being solvable.

        `DOMINATING`'s exact worst case is 9007197324153192447, comfortably
        inside int64 — and CP-SAT still answers "Possible integer overflow in
        objective", because its own check is over the model's declared domains
        and is deliberately more conservative than the exact arithmetic. Run 20
        predicted this case would be green for `DOMINATING` and measured it red;
        the prediction is recorded here rather than quietly dropped, because the
        arithmetic bound above is the thing a reader would otherwise trust.
        """
        for name, coefficients in (("DOMINATING", DOMINATING), ("LARGER", LARGER)):
            with self.subTest(coefficients=name):
                error = objective_error(at_the_ceiling(), coefficients)
                self.assertIn("overflow", error)

    def test_no_faithful_coefficient_set_is_representable_at_these_ceilings(self) -> None:
        """The general statement, not a property of the two sets above.

        A weighted form reproduces the lexicographic order only while one unit
        of the first term outweighs the entire range of the rest, so the
        smallest faithful `c₁` under `c₂ = c₃ = 1` is `ub(MAKESPAN) +
        ub(MOVEMENT) + 1`. At the wire's ceilings that is 4294967296, and
        multiplying it by PRIORITY's own ceiling lands four orders of magnitude
        past int64. Faithfulness and representability are not both available.
        """
        ub = term_upper_bounds(at_the_ceiling())
        smallest_faithful = ub[MAKESPAN] + ub[MOVEMENT] + 1
        self.assertGreater(
            weighted_bound(ub, (smallest_faithful, 1, 1)),
            INT64_MAX,
        )


class Invariant8BoundsThePublishedPriority(unittest.TestCase):
    """The defect run 19 characterised here, now closed, and its two halves kept apart.

    The old invariant 8 bounded `Σ w(s) × horizonUnits`. The model bounds
    PRIORITY by `Σ w(s) × (horizonUnits + durationUnits)`, because
    `horizonUnits` bounds the *start* and the term is over *finishes*, so a
    request satisfying the old bound could publish a `priority.value` one unit
    past the response schema's own `safeInteger` — Bun refusing the response it
    asked for. The bound now carries the `durationUnits` term and
    `check_cross_field` re-derives it, so the request below is refused here
    rather than in the builder alone.

    **The model half is deliberately unchanged.** CP-SAT still proves that
    placement OPTIMAL at `MAX_SAFE_INTEGER + 1` when the request is fed to it
    directly, and it should: the value is inside int64 and the model is right
    about its own arithmetic. Nothing in `model.py` was widened or clamped.
    That is what makes the guard load-bearing rather than decorative — delete
    the `+ durationUnits` term from `check_cross_field` and the first case goes
    green while the second still reaches the unpublishable value.
    """

    def test_the_request_is_now_refused_before_it_can_be_solved(self) -> None:
        weight = 2**22
        request = at_the_ceiling(weight, baseline_at_horizon=True)
        validate_against_schema(request, "request")  # the schema still says yes
        self.assertLessEqual(weight * request["horizonUnits"], MAX_SAFE_INTEGER)
        with self.assertRaises(RequestRejected) as caught:
            check_cross_field(request)
        self.assertIn("objective-overflow", str(caught.exception))
        self.assertIn(str(MAX_SAFE_INTEGER + 1), str(caught.exception))

    def test_the_model_still_reaches_the_unsafe_value_if_nothing_refuses_it(self) -> None:
        """Reachable, not merely a domain ceiling: proved OPTIMAL, value read off it."""
        request = at_the_ceiling(2**22, baseline_at_horizon=True)
        built = build_model(request)
        built.model.add(built.starts["a"] == HORIZON_CEILING)
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = 0
        solver.parameters.max_deterministic_time = CEILING_LIMIT
        self.assertEqual(solver.solve(built.model), cp_model.OPTIMAL)
        self.assertEqual(int(solver.value(built.terms[PRIORITY])), MAX_SAFE_INTEGER + 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
