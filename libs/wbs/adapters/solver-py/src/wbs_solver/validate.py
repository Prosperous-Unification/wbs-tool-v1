"""Request validation: the schema, then the six things this receiver says itself.

THE SCHEMA IS NOT A COPY OF THE RULES, IT IS THE RULES
------------------------------------------------------
`solver-wire.v1.json` is the single normative definition of both messages
(design.md "Solver wire contract — one versioned schema, four consumers"). This
module is the third of that file's four consumers. It validates against the copy
installed **beside** the package, because a wheel deployed into the be-01 image
carries no `libs/contracts/` tree — and `tests/test_schema_copy.py` asserts that
copy is byte-identical to the checked-in original, so the two cannot drift
without a red test.

WHAT THE SCHEMA CANNOT ENFORCE
------------------------------
Its own `$comment` on `offsetMap` names three, and assigns them to "both
consumers" rather than to the schema. This is the Python half:

1. **Duplicate JSON member names.** `json.loads` and `JSON.parse` both silently
   keep the last one, so *no* schema anywhere can reject a duplicate — by the
   time a validator sees the document, the duplicate is gone. Caught here at
   parse time with an `object_pairs_hook`, over the whole document rather than
   only the offset maps: a duplicated `horizonUnits` is the same class of defect
   and costs nothing extra to catch.
2. **Key-set equality** between `slices[].key`, `baselineOffsets` and
   `fastHint`. `negative-printable-key.json` exists precisely to prove this is
   not the schema's job: a sanitised `wi-1::step-a` is a well-formed string, so
   the schema accepts it and only this check sees that the offset maps still key
   on the real U+0000.
3. **Every offset within the horizon.** `safeInteger` bounds each value by
   `Number.MAX_SAFE_INTEGER`, which is not the same as bounding it by this
   request's own `horizonUnits`.

And a fourth, of the same class and not in that list: **every edge endpoint is a
slice key.** An edge naming a slice that was never sent is not solvable, and the
schema has no way to say so — `sliceKey` is "a non-empty string" by
construction, so a typo'd endpoint is schema-legal. No corpus fixture covers it
yet; `tests/test_validate.py` builds one by mutating a valid request, and a
fixture belongs in the shared corpus when 2.1's cross-suite contract test is
extended.

And a fifth, the schema's own invariant 8: **the objective worst cases
`Σ w(s) × (horizonUnits + durationUnits(s))` and `Σ max(b, horizonUnits − b)`
are both at most `Number.MAX_SAFE_INTEGER`.** The schema calls each field a
`safeInteger` one at a time and can say nothing about a product or a sum of
them. The Bun request builder refuses these before it spawns anything, so no
request it sends reaches this check — which is the argument for having it
rather than against: a request arriving by any other route would otherwise be
solved, and the OPTIMAL response would carry an `objectiveValues[*].value` that
the *response* branch of this same schema refuses. An exit 64 naming the
request beats a well-formed answer nobody can accept.

And a sixth, TASK-329, which is the one the schema CAN say and this module says
anyway: **`deadlineUnits` is a multiple of the request's own `quantum`.** The
list above is titled by what the schema cannot express, and this entry does not
belong to it — since TASK-329 pinned `quantum` to `const: 48` and gave
`deadlineUnits` a literal `multipleOf: 48`, the schema refuses a non-multiple
one call before `check_cross_field` ever sees it. It is here because a receiver
that knows an invariant only through the sender's schema is not an independent
guard, and the review that filed TASK-329 asked for the independent one by name.
`check_cross_field` divides by the request's own `quantum` field rather than by
the literal, so the check and the model's arithmetic are the same statement, and
they stay the same statement under a wire version that stops pinning the value.
What that means for the reader is written where the check is, including the fact
that it cannot fire through `validate_request` today.

Every failure raises `RequestRejected`, which `cli.main` turns into exit 64 with
the message on stderr and nothing on stdout.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

SCHEMA_FILENAME = "solver-wire.v1.json"
SCHEMA_PATH = Path(__file__).resolve().parent / SCHEMA_FILENAME


MAX_SAFE_INTEGER = 9007199254740991
"""`Number.MAX_SAFE_INTEGER`, written out because Python has no such ceiling.

Python integers are arbitrary precision, so none of the sums below can overflow
here — which is exactly why the bound has to be a literal rather than something
derived from the language. It belongs to the *other* consumers: `#/$defs/
safeInteger` in the schema, `BigInt(Number.MAX_SAFE_INTEGER)` in the Bun
preflight, and the response's own `objectiveValues[*].value`. A request whose
worst case is above it is one whose answer Bun could not accept, and computing
it exactly here is the only way to say so before the solve rather than after.
"""


class RequestRejected(ValueError):
    """The request will not be solved, and the reason is in the message."""


def _no_duplicate_members(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    seen: set[str] = set()
    for key, _ in pairs:
        if key in seen:
            raise RequestRejected(
                f"duplicate JSON member {key!r}: json.loads would keep only the last, "
                "so the request does not mean what it looks like"
            )
        seen.add(key)
    return dict(pairs)


def parse_request(raw: bytes) -> dict[str, Any]:
    """Bytes to object, refusing anything that is not one JSON object.

    Duplicate member names are refused here rather than downstream, because
    this is the last point at which they still exist.
    """
    if not raw.strip():
        raise RequestRejected("empty request: expected one JSON object on stdin")
    try:
        parsed = json.loads(raw, object_pairs_hook=_no_duplicate_members)
    except UnicodeDecodeError as exc:
        raise RequestRejected(f"request is not valid UTF-8: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise RequestRejected(f"request is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RequestRejected(f"request must be a JSON object, got {type(parsed).__name__}")
    return parsed


@lru_cache(maxsize=1)
def _validator(branch: str) -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    # The root asserts `not: {}` on purpose, so a consumer that forgets to
    # $ref a branch fails loudly. Reach the branch through a $ref document
    # rather than by lifting the subschema out, so every internal $ref in it
    # still resolves against the whole file.
    return Draft202012Validator(
        {"$schema": schema["$schema"], "$ref": f"#/$defs/{branch}", "$defs": schema["$defs"]}
    )


def validate_against_schema(message: dict[str, Any], branch: str = "request") -> None:
    """Raise `RequestRejected` naming every schema error, not just the first.

    All of them, sorted, because a request with three faults reported one at a
    time is three round trips through a deploy.
    """
    errors = sorted(_validator(branch).iter_errors(message), key=lambda e: list(e.absolute_path))
    if errors:
        detail = "; ".join(
            f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}" for e in errors
        )
        raise RequestRejected(f"request does not satisfy #/$defs/{branch}: {detail}")


def check_cross_field(request: dict[str, Any]) -> None:
    """The six invariants this receiver states for itself. See the module docstring."""
    slice_keys = [s["key"] for s in request["slices"]]
    key_set = set(slice_keys)
    if len(key_set) != len(slice_keys):
        raise RequestRejected("slices[].key repeats: a slice key identifies one slice")

    for field in ("baselineOffsets", "fastHint"):
        offsets = request[field]
        if set(offsets) != key_set:
            missing = sorted(key_set - set(offsets))
            extra = sorted(set(offsets) - key_set)
            raise RequestRejected(
                f"{field} does not key on slices[].key "
                f"(missing {missing!r}, unexpected {extra!r})"
            )

    horizon = request["horizonUnits"]
    for field in ("baselineOffsets", "fastHint"):
        for key, value in request[field].items():
            if value > horizon:
                raise RequestRejected(
                    f"{field}[{key!r}] is {value}, past horizonUnits {horizon}"
                )

    for index, edge in enumerate(request["edges"]):
        for endpoint in ("predecessorKey", "successorKey"):
            if edge[endpoint] not in key_set:
                raise RequestRejected(
                    f"edges[{index}].{endpoint} {edge[endpoint]!r} is not a slice key"
                )

    # TASK-329 AC #1. `deadlineUnits` is `(D + 1) x quantum`, so a value that is
    # not a multiple names no day at all — the due day `deadlineUnits / quantum
    # - 1` is a fraction, and the model's `end + int(workItemIsMilestone) <=
    # deadlineUnits` would then admit a placement Bun's `isOnTime` refuses.
    # Stated against THIS REQUEST'S OWN `quantum`, not against a literal, which
    # is what makes it a cross-field check and what makes it survive a wire
    # version that stops pinning the quantum.
    #
    # Reachability, stated exactly rather than flatteringly: as of TASK-329
    # AC #2 the schema pins `quantum` to 48 and gives `deadlineUnits` a literal
    # `multipleOf: 48`, so nothing arriving through `validate_request` can reach
    # this line — `validate_against_schema` two calls up refuses it first. That
    # is a weaker kind of unreachable than invariant 8's, which is unreachable
    # because a REMOTE sender declines to emit it. What this check buys is that
    # the receiver states the invariant it actually depends on, in its own
    # terms, instead of inheriting it from the schema the sender chose; AC #1
    # asks for exactly that independence, and the guard is the thing that
    # remains true if the schema's literal and the model's arithmetic ever
    # part company.
    #
    # `0` stays legal: it is the unmeetable-deadline sentinel, and zero is a
    # multiple of every quantum, so no exemption is written here.
    quantum = request["quantum"]
    work_items: dict[str, list[dict[str, Any]]] = {}
    for index, slice_ in enumerate(request["slices"]):
        work_items.setdefault(slice_["workItemKey"], []).append(slice_)
        deadline_units = slice_.get("deadlineUnits")
        if deadline_units is None:
            continue
        if deadline_units % quantum != 0:
            raise RequestRejected(
                f"slices[{index}].deadlineUnits {deadline_units} is not a multiple of "
                f"quantum {quantum}"
            )

    for work_item_key, slices in work_items.items():
        # Proof: deleting this group comparison admits an all-zero work item
        # whose flag is false; `test_an_all_zero_work_item_cannot_deny...`
        # observed that acceptance on h2puni 2026-09-09.
        is_milestone = all(slice_["durationUnits"] == 0 for slice_ in slices)
        for slice_ in slices:
            if slice_["workItemIsMilestone"] != is_milestone:
                raise RequestRejected(
                    f"slice {slice_['key']!r} has workItemIsMilestone "
                    f"{slice_['workItemIsMilestone']!r}, but work item "
                    f"{work_item_key!r} milestone fact is {is_milestone!r}"
                )

    # Invariant 8, last because everything above is about ONE STATED FIELD —
    # its shape, or the number it names — and this one is about a product
    # computed across all of them. A plan with a missing offset key should hear
    # about the missing key, not about a sum derived from it, and the same is
    # true of a deadline that names no day.
    #
    # PRIORITY'S WORST CASE IS OVER FINISHES, NOT OVER THE HORIZON.
    # `horizonUnits` bounds a slice's start; PRIORITY is `Σ w(s) · finish(s)`
    # and a finish past the horizon is legal, so the true ceiling exceeds
    # `Σ w(s) × horizonUnits` by exactly `Σ w(s) × durationUnits(s)`. Measured
    # on the solver in TASK-219 run 20: at horizon 2³¹ − 1 and weight 2²² the
    # horizon-only bound is 9007199250546688 and accepts, while CP-SAT proves
    # OPTIMAL a placement publishing 9007199254740992 — one unit past the
    # `safeInteger` the response branch of this same schema demands.
    priority_worst_case = sum(
        slice_["priorityWeight"] * (horizon + slice_["durationUnits"])
        for slice_ in request["slices"]
    )
    if priority_worst_case > MAX_SAFE_INTEGER:
        raise RequestRejected(
            f"objective-overflow: priority worst case {priority_worst_case} exceeds "
            f"Number.MAX_SAFE_INTEGER {MAX_SAFE_INTEGER}"
        )

    # MOVEMENT is `Σ |offset − baseline|`, maximised term by term: an offset
    # lives in [0, horizonUnits], so the furthest a slice can be dragged from
    # baseline `b` is `max(b, horizonUnits − b)` — one end of the axis or the
    # other, never both, which is why this is a max and not a sum of the two.
    # Summing over `baselineOffsets` rather than over `slices` is safe only
    # because key-set equality was checked above.
    #
    # It cannot fire at today's ceiling: every term is <= horizonUnits by the
    # check above, and the schema caps that at 2³¹ − 1, so the sum needs over
    # four million slices to reach MAX_SAFE_INTEGER. It is here so the two
    # arms of invariant 8 stay the same shape — if that ceiling is ever
    # raised, neither arm silently lags the other.
    movement_worst_case = sum(
        max(offset, horizon - offset) for offset in request["baselineOffsets"].values()
    )
    if movement_worst_case > MAX_SAFE_INTEGER:
        raise RequestRejected(
            f"objective-overflow: movement worst case {movement_worst_case} exceeds "
            f"Number.MAX_SAFE_INTEGER {MAX_SAFE_INTEGER}"
        )


def validate_request(raw: bytes) -> dict[str, Any]:
    """Parse, validate, cross-check. The entrypoint's whole front door."""
    request = parse_request(raw)
    validate_against_schema(request, "request")
    check_cross_field(request)
    return request
