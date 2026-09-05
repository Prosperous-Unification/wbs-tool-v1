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
The coordinator distinguishes zero from non-zero and nothing finer: every
non-zero exit is `internal-error` to it. The distinct values below exist for
whoever is reading a log.

  0   a response was written to stdout
  64  the request was refused before solving (framing, encoding, shape)
  70  the solve could not answer

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
from .solve import SolveFailed, solve_request
from .validate import RequestRejected, validate_request

EXIT_OK = 0
EXIT_BAD_REQUEST = 64
EXIT_INTERNAL = 70

def read_request(stream: BinaryIO) -> bytes:
    """Read the whole request. Named so the ordering test can watch it."""
    return stream.read()


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
    if argv:
        print(f"wbs-solver: unexpected arguments {argv!r}; usage: wbs-solver [--version]", file=stderr)
        return EXIT_BAD_REQUEST

    try:
        request = validate_request(read_request(sys.stdin.buffer))
    except RequestRejected as exc:
        print(f"wbs-solver: {exc}", file=stderr)
        return EXIT_BAD_REQUEST

    try:
        response = solve_request(request)
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
