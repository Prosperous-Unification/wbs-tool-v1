"""Lifecycle gate between a counted SQLite reservation and ``wbs-solver``.

The launcher imports no CP-SAT code.  It installs the parent-death guard,
waits at most five seconds for the coordinator's bind verdict, and execs the
solve entrypoint only after ``bound`` while the absolute child deadline still
has time left.  Reading the verdict one byte at a time is intentional: a
buffered read could consume part of the JSON request and lose it at exec.
"""

from __future__ import annotations

import os
import select
import signal
import sys
import time
from collections.abc import Sequence

from . import __version__
from .lifecycle import set_parent_death_signal

BIND_TIMEOUT_MS = 5_000
EXIT_BAD_PROTOCOL = 64
EXIT_ABORTED = 75
MAX_VERDICT_BYTES = 16


def _arguments(argv: Sequence[str]) -> tuple[str, int] | None:
    if len(argv) != 4:
        return None
    values: dict[str, str] = {}
    for index in range(0, len(argv), 2):
        flag, value = argv[index], argv[index + 1]
        if flag not in {"--attempt-token", "--child-deadline-epoch-ms"} or flag in values:
            return None
        values[flag] = value
    token = values.get("--attempt-token", "")
    try:
        deadline = int(values.get("--child-deadline-epoch-ms", ""))
    except ValueError:
        return None
    if token == "" or deadline < 0:
        return None
    return token, deadline


def _install_parent_guard() -> None:
    parent = os.getppid()
    set_parent_death_signal()
    if os.getppid() != parent:
        # The parent died in the prctl race.  SIGKILL is deliberate: this is
        # the same terminal state the kernel would have delivered afterwards.
        os.kill(os.getpid(), signal.SIGKILL)
        raise RuntimeError("parent changed while installing PR_SET_PDEATHSIG")


def _read_verdict(fd: int, timeout_ms: int) -> bytes | None:
    until = time.monotonic_ns() + timeout_ms * 1_000_000
    verdict = bytearray()
    while len(verdict) <= MAX_VERDICT_BYTES:
        remaining = (until - time.monotonic_ns()) / 1_000_000_000
        if remaining <= 0:
            return None
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            return None
        part = os.read(fd, 1)
        if part == b"":
            return None
        if part == b"\n":
            return bytes(verdict)
        verdict.extend(part)
    return b"invalid"


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ["--version"]:
        print(__version__)
        return 0
    parsed = _arguments(args)
    if parsed is None:
        print(
            "wbs-solver-launcher: usage: wbs-solver-launcher "
            "--attempt-token TOKEN --child-deadline-epoch-ms EPOCH_MS",
            file=sys.stderr,
        )
        return EXIT_BAD_PROTOCOL
    _, child_deadline_at = parsed

    _install_parent_guard()
    remaining = child_deadline_at - time.time_ns() // 1_000_000
    if remaining <= 0:
        return EXIT_ABORTED
    verdict = _read_verdict(sys.stdin.fileno(), min(BIND_TIMEOUT_MS, remaining))
    if verdict == b"abort" or verdict is None:
        return EXIT_ABORTED
    if verdict != b"bound":
        return EXIT_BAD_PROTOCOL
    remaining = child_deadline_at - time.time_ns() // 1_000_000
    if remaining <= 0:
        return EXIT_ABORTED

    # This timer survives exec and is the in-process half of the absolute
    # deadline. Production also puts the same instant on the external scope;
    # SIGALRM alone cannot bound a native CP-SAT call that holds the GIL.
    signal.setitimer(signal.ITIMER_REAL, remaining / 1_000)
    os.execvp("wbs-solver", ["wbs-solver"])
    raise AssertionError("os.execvp returned")


if __name__ == "__main__":  # pragma: no cover - exercised as a real process
    raise SystemExit(main())
