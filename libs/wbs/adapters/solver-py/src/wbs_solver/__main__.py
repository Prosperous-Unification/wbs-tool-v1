"""`python -m wbs_solver` is the same entrypoint as the `wbs-solver` console
script, so the suite can exercise the real CLI without installing the
distribution first.
"""

from .cli import main

raise SystemExit(main())
