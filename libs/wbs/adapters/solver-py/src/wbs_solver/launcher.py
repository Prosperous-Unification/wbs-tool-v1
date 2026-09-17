"""Lifecycle gate between a counted SQLite reservation and ``wbs-solver``.

The launcher imports no CP-SAT code.  It installs the parent-death guard,
waits at most five seconds for the coordinator's bind verdict, and execs the
solve entrypoint only after ``bound`` while the absolute child deadline still
has time left.  Reading the verdict one byte at a time is intentional: a
buffered read could consume part of the JSON request and lose it at exec.
"""

from __future__ import annotations

import os
import resource
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


def _arguments(argv: Sequence[str]) -> tuple[str, int, int, int] | None:
    if len(argv) != 8:
        return None
    values: dict[str, str] = {}
    for index in range(0, len(argv), 2):
        flag, value = argv[index], argv[index + 1]
        if flag not in {
            "--attempt-token",
            "--child-deadline-epoch-ms",
            "--search-workers",
            "--memory-limit-mb",
        } or flag in values:
            return None
        values[flag] = value
    token = values.get("--attempt-token", "")
    try:
        deadline = int(values.get("--child-deadline-epoch-ms", ""))
        search_workers = int(values.get("--search-workers", ""))
        memory_limit_mb = int(values.get("--memory-limit-mb", ""))
    except ValueError:
        return None
    if token == "" or deadline < 0 or search_workers <= 0 or memory_limit_mb <= 0:
        return None
    return token, deadline, search_workers, memory_limit_mb


def _apply_address_space_limit(memory_limit_mb: int) -> None:
    """Loose address-space backstop; cgroup MemoryMax owns the RSS ceiling.

    Native OR-Tools maps substantially more virtual address space than resident
    memory. Equating RLIMIT_AS to the RSS limit made a valid 512 MB solve fail
    while creating its worker pool, so this deliberately leaves 4x headroom.

    **Linux only, and the branch is not a portability nicety.** The backstop is
    the inner half of a pair whose outer half is the cgroup ceiling, and a
    platform with no cgroup has no pair to complete. macOS reports RLIMIT_AS as
    unlimited and then refuses to set it -- ``getrlimit`` returns
    ``(9223372036854775807, 9223372036854775807)`` and ``setrlimit`` raises
    ``ValueError: current limit exceeds maximum limit`` -- so on Darwin this
    call cannot narrow anything and can only abort a solve that would have
    succeeded. The development profile that runs here therefore has NO memory
    enforcement at all, which is a fact its capability status must carry rather
    than a fact this function may quietly imply it handled.

    Raising on an unsupported platform was the alternative and is wrong: the
    caller has no ceiling to fall back to, so refusing to launch would trade a
    working unbounded solve for no solve, without adding a bound either way.

    Proof, Linux arm: returning before the call on every platform failed
    `test_the_limit_is_really_applied_by_the_kernel` on a real Linux kernel with
    `AssertionError: -1 != 2147483648`, `-1` being RLIM_INFINITY.

    Proof, Darwin arm: deleting the platform branch failed three cases on darwin/arm64 --
    `test_no_address_space_limit_is_attempted_off_linux` on "Expected 'setrlimit'
    to not have been called. Called 1 times.", and both real-process cases,
    `test_bound_execs_the_solver_without_consuming_its_request` and
    `test_bound_passes_the_absolute_deadline_to_the_solver`, on `1 != 0` carrying
    this machine's `ValueError: current limit exceeds maximum limit`. Replacing the
    branch with `try: ... except ValueError: return` instead -- which passes on this
    machine and would silently drop the backstop on Linux -- failed
    `test_a_linux_setrlimit_failure_is_not_swallowed` on `ValueError not raised`.
    """
    if sys.platform != "linux":
        return
    limit = memory_limit_mb * 4 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def _install_parent_guard() -> None:
    """Arm the parent-death guard, and check the race it opens -- on Linux.

    ``set_parent_death_signal`` already answers for the platform: it returns
    ``False`` on non-Linux having installed nothing. The race check below is
    about the window *between* reading ``getppid`` and the kernel accepting
    ``prctl``, so where no ``prctl`` happened there is no window, and running
    the check anyway would let an ordinary re-parenting on Darwin SIGKILL a
    launcher that was never guarded in the first place.

    The return value is now read rather than discarded, so this function's
    branch is decided by what the helper actually did instead of by a second,
    independent reading of ``sys.platform``.

    Proof: restoring the discarded call (`set_parent_death_signal()` with no branch)
    failed `test_no_parent_race_check_where_no_guard_was_installed` with
    `RuntimeError: parent changed while installing PR_SET_PDEATHSIG` -- the launcher
    self-terminating over a window that never opened.
    """
    parent = os.getppid()
    if not set_parent_death_signal():
        return
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
            "--attempt-token TOKEN --child-deadline-epoch-ms EPOCH_MS "
            "--search-workers COUNT --memory-limit-mb MB",
            file=sys.stderr,
        )
        return EXIT_BAD_PROTOCOL
    _, child_deadline_at, search_workers, memory_limit_mb = parsed

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
    _apply_address_space_limit(memory_limit_mb)
    os.execvp(
        "wbs-solver",
        [
            "wbs-solver",
            "--search-workers",
            str(search_workers),
            "--child-deadline-epoch-ms",
            str(child_deadline_at),
        ],
    )
    raise AssertionError("os.execvp returned")


if __name__ == "__main__":  # pragma: no cover - exercised as a real process
    raise SystemExit(main())
