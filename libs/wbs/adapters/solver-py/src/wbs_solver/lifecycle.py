"""Small Linux process-lifecycle primitives shared by both entrypoints.

This module deliberately imports no solver code.  The lifecycle launcher must
be able to arm its parent-death guard before CP-SAT exists in the process.
"""

from __future__ import annotations

import ctypes
import os
import signal
import sys

PR_SET_PDEATHSIG = 1


def set_parent_death_signal() -> bool:
    """Ask the kernel to SIGKILL this process when its parent dies."""
    if sys.platform != "linux":
        print(
            f"wbs-solver: PR_SET_PDEATHSIG unavailable on {sys.platform}; "
            "this process will not die with its parent",
            file=sys.stderr,
        )
        return False

    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.restype = ctypes.c_int
    prctl.argtypes = [
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    ctypes.set_errno(0)
    if prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        err = ctypes.get_errno()
        raise OSError(err, f"prctl(PR_SET_PDEATHSIG, SIGKILL) failed: {os.strerror(err)}")
    return True
