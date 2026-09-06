"""The two pins nobody can see from inside one file.

1. `__version__` against the golden request corpus, which spends the current
   package version. The
   TypeScript side has the mirror of this check in
   `libs/contracts/solver/src/wire-contract-version.test.ts`, which asserts the
   `contractVersion` **prefix** and deliberately leaves the suffix — this
   package's version — to whoever owns it. This is that half.

2. `requirements.lock` against `pyproject.toml`. The lock is the hash-verified
   install path and the metadata is what a reader believes; a bump applied to
   one and not the other is a deploy-time surprise, so it is a test.

Both read files outside this package, which is fine and is why the suite is
CI-only (tasks.md 5.3): it runs from a checkout, never from a wheel.
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
import unittest
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from wbs_solver import __version__  # noqa: E402

FIXTURES = REPO_ROOT / "libs" / "contracts" / "solver" / "fixtures" / "request"


class VersionPin(unittest.TestCase):
    def test_the_golden_corpus_spends_this_exact_version(self) -> None:
        fixtures = sorted(FIXTURES.glob("valid-*.json"))
        self.assertTrue(fixtures, f"no valid request fixtures under {FIXTURES}")
        for fixture in fixtures:
            with self.subTest(fixture=fixture.name):
                request = json.loads(fixture.read_text())
                self.assertEqual(request["solverVersion"], __version__)
                # The composed field, so a corpus edited on one side only is
                # caught here as well as by the TypeScript prefix test.
                self.assertTrue(
                    request["contractVersion"].endswith(f"+{__version__}"),
                    f"{fixture.name} contractVersion {request['contractVersion']!r} "
                    f"does not end with +{__version__}",
                )

    def test_setuptools_reads_the_version_from_the_package(self) -> None:
        """`version` is dynamic and sourced from `wbs_solver.__version__`.

        Watched red: hard-code a `version = "..."` in pyproject.toml and this
        fails, because the two would then be free to disagree.
        """
        pyproject = tomllib.loads((PACKAGE_ROOT / "pyproject.toml").read_text())
        self.assertEqual(pyproject["project"]["dynamic"], ["version"])
        self.assertNotIn("version", pyproject["project"])
        self.assertEqual(
            pyproject["tool"]["setuptools"]["dynamic"]["version"],
            {"attr": "wbs_solver.__version__"},
        )


class LockPin(unittest.TestCase):
    LOCK = PACKAGE_ROOT / "requirements.lock"

    def parse_lock(self) -> dict[str, str]:
        """name -> version, from the pinned requirement lines only."""
        pins: dict[str, str] = {}
        for line in self.LOCK.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("--"):
                continue
            match = re.match(r"^([A-Za-z0-9._-]+)==([^\s\\]+)", line)
            if match:
                pins[match.group(1).lower().replace("_", "-")] = match.group(2)
        return pins

    def test_every_declared_dependency_is_pinned_to_the_locked_version(self) -> None:
        pyproject = tomllib.loads((PACKAGE_ROOT / "pyproject.toml").read_text())
        declared = {}
        for requirement in pyproject["project"]["dependencies"]:
            name, _, version = requirement.partition("==")
            self.assertTrue(version, f"{requirement!r} is not pinned with ==")
            declared[name.strip().lower()] = version.strip()
        self.assertTrue(declared)

        locked = self.parse_lock()
        for name, version in declared.items():
            with self.subTest(dependency=name):
                self.assertIn(name, locked, f"{name} is declared but absent from requirements.lock")
                self.assertEqual(locked[name], version)

    def test_every_locked_line_carries_at_least_one_hash(self) -> None:
        """`--require-hashes` is only a guarantee if every line has hashes.

        pip enforces this at install time, but the install happens in CI and in
        the image build; a lock regenerated without `--hash` would be found
        there rather than here, on whichever branch happened to deploy first.
        """
        body = self.LOCK.read_text()
        self.assertIn("--require-hashes", body)
        # Continuation lines belong to the requirement above them, so unfold
        # first and then check each logical line.
        for logical in body.replace("\\\n", " ").splitlines():
            logical = logical.strip()
            if not logical or logical.startswith("#") or logical.startswith("--"):
                continue
            with self.subTest(requirement=logical.split()[0]):
                self.assertIn("--hash=sha256:", logical)


if __name__ == "__main__":
    unittest.main()
