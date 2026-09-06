"""The `wbs-solver` package: CP-SAT placement behind one stdin/stdout solve.

`__version__` is the single source of this distribution's version. setuptools
reads it from here (pyproject.toml `[tool.setuptools.dynamic]`), so the running
interpreter and the installed metadata cannot drift apart, and the coordinator
reads the installed metadata as the `solverVersion` half of `contractVersion`.

It is `0.1.0` because the golden request corpus already spends that string.
See pyproject.toml's header for the full argument; `tests/test_version.py`
asserts the pin against the corpus rather than restating it.

Nothing else is exported. The package has no application import surface on
purpose: solving enters through `wbs-solver` (or `python -m wbs_solver`), while
production first enters through the lightweight `wbs-solver-launcher` bind
gate from the same version-locked distribution.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
