"""The copy of `solver-wire.v1.json` inside the package is the original.

Two files with the same name in one repository are a drift bug waiting to be
written, so the drift is a test rather than a convention. It compares **bytes**,
not parsed JSON: a re-serialised copy that happens to parse equal is still a
second author of the normative document, and the next edit to it would be
invisible here.

Why a copy exists at all: the wheel deployed into the be-01 image carries no
`libs/contracts/` tree, and design.md requires the entrypoint to validate
"against the copy installed beside it". The package data glob in
pyproject.toml is what puts it in the wheel.

Watched red: edit one byte of either file (a space inside a `$comment`) and this
fails naming the offset.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from wbs_solver.validate import SCHEMA_FILENAME, SCHEMA_PATH  # noqa: E402

ORIGINAL = REPO_ROOT / "libs" / "contracts" / "solver" / SCHEMA_FILENAME


class SchemaCopy(unittest.TestCase):
    def test_the_installed_copy_is_byte_identical_to_the_original(self) -> None:
        self.assertTrue(ORIGINAL.exists(), f"the normative schema is missing at {ORIGINAL}")
        self.assertTrue(SCHEMA_PATH.exists(), f"the package copy is missing at {SCHEMA_PATH}")
        original = ORIGINAL.read_bytes()
        copy = SCHEMA_PATH.read_bytes()
        if original == copy:
            return
        offset = next(
            (i for i, (a, b) in enumerate(zip(original, copy)) if a != b),
            min(len(original), len(copy)),
        )
        self.fail(
            f"{SCHEMA_PATH} differs from {ORIGINAL} at byte {offset} "
            f"(lengths {len(original)} and {len(copy)}); "
            f"re-copy it rather than editing the copy"
        )

    def test_the_copy_travels_in_the_wheel(self) -> None:
        """Package data, not a happy accident of the source layout.

        Without the glob the file sits beside the module in a checkout and is
        absent from every installed copy — which is a green suite and a
        production entrypoint that cannot validate anything.
        """
        import tomllib

        pyproject = tomllib.loads((PACKAGE_ROOT / "pyproject.toml").read_text())
        globs = pyproject["tool"]["setuptools"]["package-data"]["wbs_solver"]
        self.assertTrue(
            any(g == SCHEMA_FILENAME or g.endswith(".json") for g in globs),
            f"package-data {globs!r} does not carry {SCHEMA_FILENAME}",
        )

    def test_the_root_rejects_everything_so_a_forgotten_ref_is_loud(self) -> None:
        """The `not: {}` at the root is load-bearing and easy to delete.

        A consumer that validates against the document instead of a branch would
        otherwise accept anything at all. This asserts the property the schema's
        own `$comment` claims, from the side that depends on it.
        """
        from jsonschema import Draft202012Validator

        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        root = Draft202012Validator(schema)
        for message in ({}, {"wireVersion": 1}, {"anything": "at all"}):
            with self.subTest(message=message):
                self.assertFalse(root.is_valid(message))


if __name__ == "__main__":
    unittest.main()
