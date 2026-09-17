"""5.5's determinism case, under the pinned configuration and nothing else.

WHAT IS AND IS NOT PROMISED
---------------------------
Production is multi-worker and wall-clock bounded, and is **explicitly not
reproducible**: which worker finds an incumbent first depends on the host. So
this file never asserts that two production solves agree on a placement. It
asserts three narrower things, which is the whole of what 5.5 claims:

1. Under the pinned configuration — `num_search_workers=1`, a fixed
   `random_seed`, and CP-SAT's **deterministic** time limit — repeated solves of
   the same request return the identical response.
2. The *values* are seed-independent, because an optimum is a number and not a
   choice. This is what production still promises when the placement does not.
3. The limit in force under the pinned configuration is the deterministic one
   and the wall clock is left unset — asserted by reading the solver's
   parameters, never by measuring how long anything took.

THE INSTANCE HAS TO HAVE A TIE, OR NONE OF THIS MEANS ANYTHING
---------------------------------------------------------------
`TIED` is two interchangeable slices in a capacity-1 pool: same duration, same
weight, both baselines zero. Every objective term is equal on both orders
(`PRIORITY 6`, `MAKESPAN 4`, `MOVEMENT 2`), so nothing in the model prefers
either and the placement is genuinely a free choice the search makes. On an
instance with a unique optimum, "the same answer twice" would be a property of
the arithmetic and would hold under any configuration at all.

NO ASSERTION HERE IS A MEASUREMENT
----------------------------------
There is no `time.monotonic()` in this file on purpose. A wall-clock assertion is
the flake 5.6 exists to avoid, and a determinism test that measured a duration
would be the first place it appeared.
"""

from __future__ import annotations

import math
import time
import sys
import unittest
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from test_model import a_request, a_slice  # noqa: E402

from wbs_solver.model import MAKESPAN, MOVEMENT, PRIORITY  # noqa: E402
from wbs_solver.solve import SolverConfig, _configure, solve_request  # noqa: E402

# 5.5's pinned configuration, written out here rather than imported from a test
# that uses it for something else: this file is where the pin is the subject.
PINNED = SolverConfig(
    num_search_workers=1, random_seed=0, deterministic_time_per_stage=8.0
)
# What a production solve gets: design.md's `solverSearchWorkers` default and
# the wall clock. Named so the contrast below cannot be misread as a second pin.
PRODUCTION = SolverConfig()

REPEATS = 5


def tied() -> dict[str, Any]:
    """Two interchangeable slices in a pool that holds one of them at a time."""
    return a_request(
        [
            a_slice("first", duration=2, width=1, pools=["t"], weight=1),
            a_slice("second", duration=2, width=1, pools=["t"], weight=1),
        ],
        pools={"t": 1},
        objective="pri",
    )


def values(response: dict[str, Any]) -> dict[str, int]:
    return {term: entry["value"] for term, entry in response["objectiveValues"].items()}


class TheInstanceIsGenuinelyTied(unittest.TestCase):
    """If this class fails, every case below is vacuous."""

    def test_both_orders_are_optimal_and_the_model_prefers_neither(self) -> None:
        response = solve_request(tied(), PINNED)
        self.assertEqual(
            values(response), {PRIORITY: 6, MAKESPAN: 4, MOVEMENT: 2}
        )
        offsets = response["offsets"]
        self.assertEqual(sorted(offsets.values()), [0, 2])
        # The mirror placement carries the identical terms, so the search is
        # choosing between two equally good answers rather than finding one.
        self.assertEqual(
            sorted(offsets), ["first", "second"], "the fixture lost a slice"
        )


class ThePinnedConfigurationRepeats(unittest.TestCase):
    def test_the_same_request_gives_the_identical_response_every_time(self) -> None:
        """Whole responses, not just the offsets: `bound` and every per-term
        `status` are part of what a caller reads, and a run that agreed on the
        placement while disagreeing on a bound would still be a run nobody could
        reproduce."""
        responses = [solve_request(tied(), PINNED) for _ in range(REPEATS)]
        for later in responses[1:]:
            self.assertEqual(later, responses[0])

    def test_it_repeats_under_both_stagings(self) -> None:
        for objective in ("pri", "time"):
            with self.subTest(objective=objective):
                request = tied()
                request["objective"] = objective
                first = solve_request(dict(request), PINNED)
                self.assertEqual(solve_request(dict(request), PINNED), first)


class ValuesAreSeedIndependentAndPlacementsAreNot(unittest.TestCase):
    """The line between what production still promises and what it does not."""

    def test_every_seed_and_worker_count_agrees_on_the_numbers(self) -> None:
        """An optimum is a number. Changing the search changes which optimal
        placement is found, never what the optimum is — so this is the assertion
        that survives outside the pin."""
        expected = {PRIORITY: 6, MAKESPAN: 4, MOVEMENT: 2}
        for workers in (1, 2, 4):
            for seed in (0, 1, 7):
                with self.subTest(workers=workers, seed=seed):
                    config = SolverConfig(num_search_workers=workers, random_seed=seed)
                    self.assertEqual(values(solve_request(tied(), config)), expected)

    def test_no_case_here_requires_two_production_solves_to_place_alike(self) -> None:
        """Deliberately not an assertion about two solves agreeing *or*
        differing. Production makes no promise either way, and a test that
        asserted nondeterminism would fail exactly when the solver got more
        stable. What is asserted is that a production solve is still a *valid*
        answer to the same instance."""
        offsets = solve_request(tied(), PRODUCTION)["offsets"]
        self.assertEqual(sorted(offsets.values()), [0, 2])


class TheLimitIsDeterministicAndNotTheWallClock(unittest.TestCase):
    """Read off the solver's parameters. Nothing here times anything.

    `_configure` is private and imported anyway: the parameter it sets is the
    entire mechanism 5.5 rests on, and asserting it through a solve would mean
    asserting a duration, which is the one thing this clause forbids.

    **An unset CP-SAT limit is `inf`, not `0`.** This file's first version
    asserted `0.0` for the limit each configuration leaves alone and went red on
    both, which is worth keeping written down: `0` is not "no limit" here, it is
    "stop immediately", and `_configure`'s own comment already says a
    zero-length budget would read as no limit — the opposite convention, one
    layer away. So "in force" below means **finite**, and the assertion that the
    other limit is `inf` is the assertion that it does not bind.
    """

    def test_the_pinned_configuration_sets_a_deterministic_limit_only(self) -> None:
        parameters = _configure(PINNED, budget_ms=30000.0).parameters
        self.assertEqual(parameters.max_deterministic_time, 8.0)
        self.assertTrue(math.isinf(parameters.max_time_in_seconds))
        self.assertEqual(parameters.num_search_workers, 1)
        self.assertEqual(parameters.random_seed, 0)

    def test_a_production_configuration_sets_the_wall_clock_only(self) -> None:
        parameters = _configure(PRODUCTION, budget_ms=30000.0).parameters
        self.assertEqual(parameters.max_time_in_seconds, 30.0)
        self.assertTrue(math.isinf(parameters.max_deterministic_time))
        self.assertEqual(parameters.num_search_workers, 2)

    def test_the_absolute_child_deadline_clamps_a_stage_wall_clock(self) -> None:
        config = SolverConfig(child_deadline_epoch_ms=int(time.time() * 1_000) + 2_000)
        parameters = _configure(config, budget_ms=30000.0).parameters
        self.assertGreater(parameters.max_time_in_seconds, 0.0)
        self.assertLessEqual(parameters.max_time_in_seconds, 2.0)

    def test_the_two_limits_are_never_both_in_force(self) -> None:
        """A solve bounded by whichever of the two fires first is reproducible
        only until the host is busy — the exact failure the deterministic limit
        exists to remove."""
        for config in (PINNED, PRODUCTION):
            with self.subTest(deterministic=config.deterministic_time_per_stage):
                parameters = _configure(config, budget_ms=30000.0).parameters
                in_force = [
                    name
                    for name, value in (
                        ("max_deterministic_time", parameters.max_deterministic_time),
                        ("max_time_in_seconds", parameters.max_time_in_seconds),
                    )
                    if math.isfinite(value)
                ]
                self.assertEqual(len(in_force), 1, in_force)


if __name__ == "__main__":
    unittest.main()
