"""The solve entrypoint: read one request from stdin, write one response to
stdout, exit.

ORDER MATTERS, AND IT IS THE FIRST THING THIS MODULE DOES
---------------------------------------------------------
`prctl(PR_SET_PDEATHSIG, SIGKILL)` is installed **before** stdin is read
(tasks.md 5.1). A solver child that is reparented while it is blocked on a
read would otherwise sit in the process table until someone went looking for
it, and the whole concurrency ceiling in design.md rests on the OS count of
live `wbs-solver` processes not exceeding the count of `running` slot rows.
Blocking on stdin is exactly where a child waits longest, so the window that
matters is the one between spawn and the first read.

In production this is a **re-assertion**: 6.2b's launcher sets the same flag
before the bind and it survives the `exec` onto this pid. It is kept here for
the direct-spawn smoke test, where no launcher ran, and because a defence that
only exists one layer up is a defence that disappears the first time someone
spawns the solve entrypoint directly.

EXIT CODES
----------
The coordinator reads these values and dispositions them apart
(`dispositionOfExitCode` in `libs/contracts/solver/src/
solver-failure-disposition.ts`), so they are a contract rather than a log
convenience.

  0   a response was written to stdout
  64  the request was refused before solving (framing, encoding, shape)
      → `internal-error`: every request is built by `buildSolverRequest`, so a
      request this entrypoint cannot read is a fault on the caller's side
  70  the solve could not answer
      → `invalid-output`: the solver ran and returned nothing usable. This is
      the only way a **later-stage** `INFEASIBLE` can leave the process — it
      has no encoding on the wire, and spec.md's staged-lexicographic
      requirement says the entrypoint "SHALL exit non-zero without emitting a
      response, and the coordinator SHALL record that run as `invalid-output`"

An earlier revision of this block said the coordinator "distinguishes zero from
non-zero and nothing finer: every non-zero exit is `internal-error` to it". It
was written before the response schema reserved `infeasible` for a stage-1
proof, and it contradicted both the `SolveFailed` handler below and the three
artifacts that name a disposition for the `INFEASIBLE, k > 1` row.

**A non-zero exit writes nothing to stdout.** That is not tidiness: the
response schema admits no "I failed" status, so a partial or invented message
would be a lie the coordinator cannot detect (solver-wire.v1.json, the
response `$comment`). Diagnostics go to stderr.
"""

from __future__ import annotations

import json
import sys
from typing import BinaryIO, Sequence, TextIO

from . import __version__
from .lifecycle import set_parent_death_signal
from .solve import SolveFailed, SolverConfig, solve_request
from .validate import RequestRejected, validate_request

EXIT_OK = 0
EXIT_BAD_REQUEST = 64
EXIT_INTERNAL = 70

def read_request(stream: BinaryIO) -> bytes:
    """Read the whole request. Named so the ordering test can watch it."""
    return stream.read()


def _solver_config(argv: Sequence[str]) -> SolverConfig | None:
    if not argv:
        return SolverConfig()
    if len(argv) not in (2, 4):
        return None
    values: dict[str, str] = {}
    for index in range(0, len(argv), 2):
        flag, value = argv[index], argv[index + 1]
        if flag not in {"--search-workers", "--child-deadline-epoch-ms"} or flag in values:
            return None
        values[flag] = value
    if "--search-workers" not in values:
        return None
    try:
        workers = int(values["--search-workers"])
        deadline = (
            int(values["--child-deadline-epoch-ms"])
            if "--child-deadline-epoch-ms" in values
            else None
        )
    except ValueError:
        return None
    if workers <= 0 or (deadline is not None and deadline <= 0):
        return None
    return SolverConfig(
        num_search_workers=workers,
        child_deadline_epoch_ms=deadline,
    )


def main(argv: Sequence[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    stdout: TextIO = sys.stdout
    stderr: TextIO = sys.stderr

    # Before stdin. See the module docstring: this is the whole point of the
    # ordering, and `--version` gets it too because a coordinator probing the
    # version has the same reason to want the child gone with it.
    set_parent_death_signal()

    if argv == ["--version"]:
        # Bare, newline-terminated, nothing else on stdout. The coordinator
        # reads this to build `contractVersion`; anything decorative here is a
        # parser somewhere else.
        print(__version__, file=stdout)
        return EXIT_OK
    config = _solver_config(argv)
    if config is None:
        print(
            "wbs-solver: unexpected arguments "
            f"{argv!r}; usage: wbs-solver [--version | --search-workers COUNT "
            "[--child-deadline-epoch-ms EPOCH_MS]]",
            file=stderr,
        )
        return EXIT_BAD_REQUEST

    try:
        request = validate_request(read_request(sys.stdin.buffer))
    except RequestRejected as exc:
        print(f"wbs-solver: {exc}", file=stderr)
        return EXIT_BAD_REQUEST

    try:
        response = solve_request(request, config)
    except SolveFailed as exc:
        # The two outcomes the wire cannot carry: a later-stage INFEASIBLE,
        # which is the solver holding a counterexample to its own answer, and a
        # model CP-SAT refuses. Both are `invalid-output` to the coordinator,
        # and both leave stdout empty — see this module's exit-code note.
        print(f"wbs-solver: {exc}", file=stderr)
        return EXIT_INTERNAL

    json.dump(response, stdout, separators=(",", ":"), sort_keys=True)
    stdout.write("\n")
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover - exercised via __main__.py
    raise SystemExit(main())
