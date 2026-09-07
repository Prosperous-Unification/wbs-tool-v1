"""The four checks the schema cannot make, each against a request the schema
accepts.

That framing is the point of every case here. A test that feeds
`check_cross_field` something the schema would already have rejected proves
nothing about the check — the schema was going to catch it either way. So each
case starts from a valid corpus fixture, breaks exactly one invariant, asserts
the schema still says yes, and only then asserts the cross-field check says no.
"""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from wbs_solver.validate import (  # noqa: E402
    MAX_SAFE_INTEGER,
    RequestRejected,
    check_cross_field,
    parse_request,
    validate_against_schema,
    validate_request,
)

CORPUS = REPO_ROOT / "libs" / "contracts" / "solver" / "fixtures"
FIXTURES = CORPUS / "request"
KEY_A = "wi-1\x00step-a"
KEY_B = "wi-2\x00"


def valid_request() -> dict:
    return json.loads((FIXTURES / "valid-two-slices.json").read_text(encoding="utf-8"))


def schema_legal_request_fixtures() -> list[str]:
    """The corpus's own list, not a second one written here.

    A fixture added to the manifest is picked up by the round-trip cases below
    without anyone remembering to add it twice.
    """
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))
    return [
        entry["file"].split("/", 1)[1]
        for entry in manifest["fixtures"]
        if entry["branch"] == "request" and entry["valid"]
    ]


class SchemaAcceptsTheBaseline(unittest.TestCase):
    def test_the_fixture_this_module_mutates_is_valid_end_to_end(self) -> None:
        """If this ever fails, every other case in this file is vacuous."""
        request = validate_request((FIXTURES / "valid-two-slices.json").read_bytes())
        self.assertEqual([s["key"] for s in request["slices"]], [KEY_A, KEY_B])


def leaf_types(value, path: str = "<root>") -> dict[str, str]:
    """Every scalar leaf's Python type, keyed by path. Order-insensitive."""
    if isinstance(value, dict):
        out: dict[str, str] = {}
        for key, item in value.items():
            out.update(leaf_types(item, f"{path}/{key}"))
        return out
    if isinstance(value, list):
        out = {}
        for index, item in enumerate(value):
            out.update(leaf_types(item, f"{path}/{index}"))
        return out
    return {path: type(value).__name__}


class TheParseIsLossless(unittest.TestCase):
    """5.3's request parse round-trip: what the solver reads is what was sent.

    The three checks above this line are about *refusing* bad requests. This one
    is about not quietly altering a good one — a different failure, and the more
    dangerous of the two, because it has no symptom at the wire and surfaces
    much later as a wrong plan or a `TypeError` inside CP-SAT.

    The oracle is deliberately plain `json.loads`, without
    `parse_request`'s `object_pairs_hook`. Comparing the hook's output against
    itself would prove nothing; comparing it against the stdlib's own reading of
    the same bytes is what makes a sanitising hook visible.
    """

    def test_every_schema_legal_corpus_request_round_trips_unchanged(self) -> None:
        """Re-serialising the parse and reading it back gives the same document.

        Watched red: make `_no_duplicate_members` sanitise its keys the way a
        printable slice key looks (`key.replace("\\x00", "::")`) and all three
        fixtures go red here, while `negative-printable-key.json` also stops
        being refused by `KeySetEquality` above — one mutation, four failures,
        which is the shape of a defect that would otherwise be silent.
        """
        names = schema_legal_request_fixtures()
        self.assertGreaterEqual(len(names), 3, "the corpus lost its valid requests")
        for name in names:
            with self.subTest(fixture=name):
                raw = (FIXTURES / name).read_bytes()
                parsed = parse_request(raw)
                self.assertEqual(json.loads(json.dumps(parsed)), json.loads(raw))

    def test_the_number_kinds_survive(self) -> None:
        """An integer stays `int` and a fraction stays `float`.

        This is not pedantry about types. The model builds `IntVar` domains from
        `durationUnits` and friends, so a `durationUnits` that arrived as `10.0`
        is a failure hundreds of lines away from the line that caused it. The
        opposite direction matters just as much: `stageBudgetSplit` is fractions
        of a budget, and truncating those to `int` is a stage with no time.

        Watched red: `parse_int=float` in `parse_request` — the whole document
        goes float and every integer path here reports it.
        """
        raw = (FIXTURES / "valid-two-slices.json").read_bytes()
        self.assertEqual(leaf_types(parse_request(raw)), leaf_types(json.loads(raw)))

        parsed = parse_request(raw)
        self.assertIsInstance(parsed["slices"][0]["durationUnits"], int)
        self.assertNotIsInstance(parsed["slices"][0]["durationUnits"], bool)
        self.assertTrue(all(isinstance(share, float) for share in parsed["stageBudgetSplit"]))

    def test_a_null_member_is_preserved_rather_than_dropped(self) -> None:
        """`deadlineUnits: null` is "no deadline", not "field omitted".

        The schema `required`s both, so a parse that dropped its `None` values
        would turn a legal request into a schema-invalid one — and it would do it
        only to the requests that exercise the optional fields.

        Watched red: return `{k: v for k, v in pairs if v is not None}` from the
        hook; this case fails on the missing key, and the fixed-point case below
        fails on the schema.
        """
        parsed = parse_request((FIXTURES / "valid-two-slices.json").read_bytes())
        self.assertIn("deadlineUnits", parsed["slices"][0])
        self.assertIsNone(parsed["slices"][0]["deadlineUnits"])
        self.assertIsNone(parsed["slices"][0]["personId"])

    def test_the_front_door_is_a_fixed_point(self) -> None:
        """Serialising a validated request produces a request that validates.

        Equality alone would be satisfied by a parse that returned some faithful
        object the wire could not carry. This says the round trip lands back on
        the wire: through the schema and the cross-field checks, not just through
        `==`.
        """
        for name in ("valid-two-slices.json", "valid-quantised-baseline.json"):
            with self.subTest(fixture=name):
                once = validate_request((FIXTURES / name).read_bytes())
                twice = validate_request(json.dumps(once).encode("utf-8"))
                self.assertEqual(twice, once)
                self.assertEqual([s["key"] for s in twice["slices"]], list(twice["fastHint"]))


class DuplicateMembers(unittest.TestCase):
    """No schema can catch these: the duplicate is gone before validation runs.

    Watched red: drop the `object_pairs_hook` from `parse_request` and both
    cases pass silently with the last value winning.
    """

    def test_a_duplicated_offset_key_is_refused(self) -> None:
        raw = (
            '{"baselineOffsets": {"wi-1\\u0000step-a": 0, "wi-1\\u0000step-a": 99}}'
        ).encode()
        # The proof that the schema is not what catches it: json.loads keeps
        # the last value and hands the validator a document with one key.
        self.assertEqual(json.loads(raw)["baselineOffsets"], {KEY_A: 99})
        with self.assertRaises(RequestRejected) as caught:
            parse_request(raw)
        self.assertIn("duplicate JSON member", str(caught.exception))

    def test_a_duplicated_top_level_field_is_refused(self) -> None:
        with self.assertRaises(RequestRejected) as caught:
            parse_request(b'{"horizonUnits": 30, "horizonUnits": 1}')
        self.assertIn("horizonUnits", str(caught.exception))


class KeySetEquality(unittest.TestCase):
    def test_the_printable_key_fixture_is_schema_legal_and_refused_here(self) -> None:
        """`negative-printable-key.json` exists for exactly this split.

        The manifest marks it `valid: true` — schema-legal on purpose — because
        a sanitised `wi-1::step-a` is a well-formed string and no schema can
        tell it from a real `sliceKey()` result. This is the check that can.
        """
        raw = (FIXTURES / "negative-printable-key.json").read_bytes()
        request = parse_request(raw)
        validate_against_schema(request, "request")  # the schema says yes
        with self.assertRaises(RequestRejected) as caught:
            check_cross_field(request)
        self.assertIn("does not key on slices[].key", str(caught.exception))

    def test_an_offset_map_missing_a_slice_is_refused(self) -> None:
        request = valid_request()
        del request["fastHint"][KEY_B]
        validate_against_schema(request, "request")
        with self.assertRaises(RequestRejected) as caught:
            check_cross_field(request)
        self.assertIn("fastHint", str(caught.exception))

    def test_a_repeated_slice_key_is_refused(self) -> None:
        request = valid_request()
        request["slices"][1] = copy.deepcopy(request["slices"][0])
        validate_against_schema(request, "request")
        with self.assertRaises(RequestRejected) as caught:
            check_cross_field(request)
        self.assertIn("repeats", str(caught.exception))


class HorizonBound(unittest.TestCase):
    def test_an_offset_past_the_horizon_is_refused(self) -> None:
        """`safeInteger` bounds the value by MAX_SAFE_INTEGER, not by this
        request's own horizon, so the schema accepts it."""
        request = valid_request()
        request["baselineOffsets"][KEY_B] = request["horizonUnits"] + 1
        validate_against_schema(request, "request")
        with self.assertRaises(RequestRejected) as caught:
            check_cross_field(request)
        self.assertIn("past horizonUnits", str(caught.exception))

    def test_an_offset_exactly_at_the_horizon_is_accepted(self) -> None:
        """The boundary, in the other direction, so the check is not off by one."""
        request = valid_request()
        request["baselineOffsets"][KEY_B] = request["horizonUnits"]
        request["fastHint"][KEY_B] = request["horizonUnits"]
        validate_against_schema(request, "request")
        check_cross_field(request)


class DeadlineIsAWholeDay(unittest.TestCase):
    """TASK-329 AC #1: the receiver states the deadline invariant for itself.

    Unlike every other case in this file, this one does NOT call
    `validate_against_schema` before `check_cross_field` — because since
    TASK-329 AC #2 the schema pins `quantum` to 48 and gives `deadlineUnits`
    `multipleOf: 48`, so the schema refuses a non-multiple and the cross-field
    check could never be reached through `validate_request`. Both halves are
    asserted below and each is a different statement: the schema really does
    refuse it, AND the receiver refuses it on its own terms, dividing by the
    request's own `quantum` rather than by a literal. The second is what
    survives a wire version that stops pinning the value, and it is the
    independence AC #1 asks for — a receiver that knows an invariant only
    through the sender's schema is not an independent guard.
    """

    def test_the_schema_refuses_it_first(self) -> None:
        """Stated so the reachability claim in `validate.py` stays measured."""
        request = valid_request()
        request["slices"][0]["deadlineUnits"] = 1
        with self.assertRaises(RequestRejected) as caught:
            validate_against_schema(request, "request")
        self.assertIn("deadlineUnits", str(caught.exception))

    def test_a_deadline_that_is_not_a_whole_day_is_refused_here_too(self) -> None:
        """The reviewer's own input: due at unit 1, which is day 1/48 - 1."""
        request = valid_request()
        request["slices"][0]["deadlineUnits"] = 1
        with self.assertRaises(RequestRejected) as caught:
            check_cross_field(request)
        self.assertIn("not a multiple of", str(caught.exception))

    def test_it_divides_by_the_request_quantum_and_not_by_a_literal(self) -> None:
        """The whole reason this is a CROSS-FIELD check.

        24 is not a multiple of 48 and is a multiple of 24, so a check written
        against the constant would refuse this and a check written against the
        request would accept it. The schema refuses the request outright, which
        is why `check_cross_field` is called directly here.
        """
        request = valid_request()
        request["quantum"] = 24
        request["slices"][0]["deadlineUnits"] = 24
        check_cross_field(request)

    def test_the_multiples_beside_it_are_accepted(self) -> None:
        """`0` is TASK-267's unmeetable sentinel and is a multiple; `None` is no
        deadline at all. A check that refuses these has not been aimed."""
        for deadline_units in (None, 0, 48, 96):
            with self.subTest(deadlineUnits=deadline_units):
                request = valid_request()
                request["slices"][0]["deadlineUnits"] = deadline_units
                validate_against_schema(request, "request")
                check_cross_field(request)


class ObjectiveOverflow(unittest.TestCase):
    """Invariant 8, whose Python arm did not exist until now.

    The Bun builder already refuses these before it spawns anything, so no
    request it sends can reach this check. That is the argument for having it,
    not against: the schema calls both fields `safeInteger` individually and
    says nothing about their product, so a request that arrives by any other
    route — a replayed corpus fixture, a second builder, someone running
    `python -m wbs_solver` by hand — would otherwise be *solved*, and the
    OPTIMAL response would carry a `priority.value` the response branch of this
    same schema refuses. An exit 64 naming the request beats a well-formed
    answer nobody can accept.
    """

    def priority_request(self, weight: int) -> dict:
        """Run 20's measured boundary, as a request the schema accepts.

        `horizonUnits` at the schema's own maximum 2**31 - 1, one slice one
        unit long carrying all the weight and the other carrying none, so the
        worst case is exactly `weight * 2**31` and the boundary sits on a
        power of two rather than near one.
        """
        request = valid_request()
        request["horizonUnits"] = 2**31 - 1
        request["slices"][0]["durationUnits"] = 1
        request["slices"][0]["priorityWeight"] = weight
        request["slices"][1]["priorityWeight"] = 0
        return request

    def test_a_priority_worst_case_past_max_safe_integer_is_refused(self) -> None:
        request = self.priority_request(2**22)
        validate_against_schema(request, "request")  # every field is a legal safeInteger
        with self.assertRaises(RequestRejected) as caught:
            check_cross_field(request)
        message = str(caught.exception)
        self.assertIn("objective-overflow", message)
        self.assertIn("9007199254740992", message)

    def test_the_horizon_only_bound_would_have_accepted_that_same_request(self) -> None:
        """Why the case above is the boundary and not just a big number.

        Arithmetic rather than a fixture, because the point is about a bound
        that is no longer in the code: PRIORITY is a sum over FINISHES, and
        `horizonUnits` bounds a START. The old horizon-only bound is under
        MAX_SAFE_INTEGER for exactly this request, so a check written that way
        passes it — and CP-SAT then proves OPTIMAL a placement publishing the
        value one unit above. Delete the `+ durationUnits` term from
        `check_cross_field` and the case above goes green while the solver
        stays wrong.
        """
        request = self.priority_request(2**22)
        horizon = request["horizonUnits"]
        horizon_only = sum(s["priorityWeight"] * horizon for s in request["slices"])
        over_finishes = sum(
            s["priorityWeight"] * (horizon + s["durationUnits"]) for s in request["slices"]
        )
        self.assertEqual(horizon_only, 9007199250546688)
        self.assertLessEqual(horizon_only, MAX_SAFE_INTEGER)
        self.assertEqual(over_finishes, MAX_SAFE_INTEGER + 1)

    def test_the_same_plan_one_unit_of_weight_lower_is_accepted(self) -> None:
        """A boundary, not a blanket refusal of large weights."""
        request = self.priority_request(2**22 - 1)
        validate_against_schema(request, "request")
        check_cross_field(request)
        self.assertEqual(
            sum(
                s["priorityWeight"] * (request["horizonUnits"] + s["durationUnits"])
                for s in request["slices"]
            ),
            9007197107257344,
        )

    def test_a_plan_with_no_weights_passes_whatever_the_horizon(self) -> None:
        """Most plans. Nobody prioritised anything and the product is zero."""
        request = self.priority_request(0)
        request["slices"][0]["durationUnits"] = request["horizonUnits"]
        validate_against_schema(request, "request")
        check_cross_field(request)

    def test_the_movement_arm_cannot_fire_below_millions_of_slices(self) -> None:
        """Stated as arithmetic because the fixture would be 4.2M slices.

        Invariant 3 has already bounded every offset by `horizonUnits` when
        this runs, so each `max(b, horizon - b)` term is at most `horizonUnits`
        and the schema caps that at 2**31 - 1. The sum therefore needs that
        many terms to reach MAX_SAFE_INTEGER. The movement arm is a guard
        against a future horizon ceiling, not against a plan anybody has, and
        the honest form of that sentence is this assertion — deleting the arm
        reddens nothing else in this file.
        """
        horizon_max = 2**31 - 1
        self.assertGreater(MAX_SAFE_INTEGER // horizon_max, 4_000_000)

    def test_the_movement_worst_case_is_one_end_of_the_axis_or_the_other(self) -> None:
        """`Σ |offset − baseline|`, maximised term by term, is a max and not a
        sum of both directions: a slice dragged to 0 is not also dragged to the
        horizon. Checked on the shipped request rather than on a rewrite of it.
        """
        request = self.priority_request(1)
        horizon = request["horizonUnits"]
        request["baselineOffsets"] = {KEY_A: 0, KEY_B: horizon}
        request["fastHint"] = dict(request["baselineOffsets"])
        validate_against_schema(request, "request")
        check_cross_field(request)
        self.assertEqual(
            sum(max(b, horizon - b) for b in request["baselineOffsets"].values()),
            2 * horizon,
        )


class EdgeEndpoints(unittest.TestCase):
    def test_an_edge_naming_an_unsent_slice_is_refused(self) -> None:
        """No corpus fixture covers this yet — see validate.py's docstring.

        Built here by mutation rather than left uncovered, because an edge
        pointing at a slice that was never sent is not solvable and the schema
        calls every non-empty string a legal slice key.
        """
        request = valid_request()
        self.assertTrue(request["edges"], "the fixture has no edges to break")
        request["edges"][0]["successorKey"] = "wi-99\x00"
        validate_against_schema(request, "request")
        with self.assertRaises(RequestRejected) as caught:
            check_cross_field(request)
        self.assertIn("is not a slice key", str(caught.exception))


class SchemaErrorsAreReportedTogether(unittest.TestCase):
    def test_every_error_is_named_not_just_the_first(self) -> None:
        request = valid_request()
        request["slices"][0]["width"] = 0
        request["slices"][1]["width"] = 2.5
        with self.assertRaises(RequestRejected) as caught:
            validate_against_schema(request, "request")
        message = str(caught.exception)
        self.assertIn("slices/0/width", message)
        self.assertIn("slices/1/width", message)


if __name__ == "__main__":
    unittest.main()
