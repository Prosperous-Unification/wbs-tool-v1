"""The lifecycle launcher never creates a solver before a valid bind."""

from __future__ import annotations

import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
from pathlib import Path
from unittest import mock

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SRC = PACKAGE_ROOT / "src"
sys.path.insert(0, str(SRC))

from wbs_solver import launcher  # noqa: E402


class LauncherProcess(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        executable = Path(self.folder.name) / "wbs-solver"
        executable.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            "sys.stdout.buffer.write(sys.stdin.buffer.read())\n",
            encoding="utf-8",
        )
        executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
        self.env = dict(
            os.environ,
            PYTHONPATH=str(SRC),
            PATH=f"{self.folder.name}{os.pathsep}{os.environ['PATH']}",
        )

    def replace_solver(self, body: str) -> None:
        executable = Path(self.folder.name) / "wbs-solver"
        executable.write_text(f"#!/usr/bin/env python3\n{body}", encoding="utf-8")
        executable.chmod(executable.stat().st_mode | stat.S_IXUSR)

    def tearDown(self) -> None:
        self.folder.cleanup()

    def command(self, deadline: int) -> list[str]:
        return [
            sys.executable,
            "-m",
            "wbs_solver.launcher",
            "--attempt-token",
            "0123456789abcdef0123456789abcdef",
            "--child-deadline-epoch-ms",
            str(deadline),
            "--search-workers",
            "2",
            "--memory-limit-mb",
            "512",
        ]

    def test_reports_the_lightweight_distribution_version_before_lifecycle_setup(self) -> None:
        # Production reads this before constructing the coordinator. Proof:
        # remove the dedicated version branch and the launcher rejects the
        # one-argument command as bad protocol instead of exposing metadata.
        done = subprocess.run(
            [sys.executable, "-m", "wbs_solver.launcher", "--version"],
            capture_output=True,
            env=self.env,
            timeout=2,
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        # Proof: restoring `__version__ = "0.1.0"` failed here with
        # `b'0.1.0\n' != b'0.1.1\n'`; watched 2026-09-07.
        self.assertEqual(done.stdout, b"0.1.3\n")

    def test_bound_execs_the_solver_without_consuming_its_request(self) -> None:
        request = b'{"wireVersion":1}\n'
        done = subprocess.run(
            self.command(int(time.time() * 1_000) + 30_000),
            input=b"bound\n" + request,
            capture_output=True,
            env=self.env,
            timeout=10,
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, request)

    def test_bound_passes_the_absolute_deadline_to_the_solver(self) -> None:
        deadline = int(time.time() * 1_000) + 30_000
        self.replace_solver(
            "import json, sys\n"
            "sys.stdout.write(json.dumps(sys.argv[1:]))\n"
        )
        done = subprocess.run(
            self.command(deadline),
            input=b"bound\n{}\n",
            capture_output=True,
            env=self.env,
            timeout=10,
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(
            done.stdout,
            f'["--search-workers", "2", "--child-deadline-epoch-ms", "{deadline}"]'.encode(),
        )

    def test_memory_limit_is_converted_to_a_hard_address_space_backstop(self) -> None:
        """The Linux arm, selected explicitly so this passes on any host.

        Patching `sys.platform` rather than skipping off Linux is the point: the
        backstop is production behaviour, and a test that vanishes on the
        developer's machine is a test that stops describing it there.
        """
        with (
            mock.patch.object(launcher.sys, "platform", "linux"),
            mock.patch.object(launcher.resource, "setrlimit") as setrlimit,
        ):
            launcher._apply_address_space_limit(512)
        setrlimit.assert_called_once_with(
            launcher.resource.RLIMIT_AS,
            (512 * 4 * 1024 * 1024, 512 * 4 * 1024 * 1024),
        )

    @unittest.skipUnless(sys.platform == "linux", "RLIMIT_AS is only settable on Linux")
    def test_the_limit_is_really_applied_by_the_kernel(self) -> None:
        """The real call, against the real kernel. Mirrors test_cli's prctl case.

        This is the non-vacuous half of the two mocked cases around it: both
        would pass against an `_apply_address_space_limit` that computed the
        right number and never reached the kernel with it, which is exactly what
        the Darwin branch above now does deliberately.

        In a subprocess because a limit applied to the test runner would follow
        it into every case after this one.

        Proof: observed on a real Linux kernel (python:3.14-slim under Docker,
        `Linux aarch64`) rather than on the darwin machine this was written on,
        where it skips. Making `_apply_address_space_limit` return before the
        call on every platform failed it with `AssertionError: -1 !=
        2147483648` — `-1` being RLIM_INFINITY, the limit never reaching the
        kernel. Unfaulted, the same container reported `before: (-1, -1)` and
        `after: (2147483648, 2147483648)`.
        """
        probe = (
            "import resource, sys;"
            "sys.path.insert(0, 'src');"
            "from wbs_solver import launcher;"
            "launcher._apply_address_space_limit(512);"
            "print(resource.getrlimit(resource.RLIMIT_AS)[0])"
        )
        done = subprocess.run(
            [sys.executable, "-c", probe],
            capture_output=True,
            cwd=str(pathlib.Path(__file__).resolve().parent.parent),
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(int(done.stdout.strip()), 512 * 4 * 1024 * 1024)

    def test_a_linux_setrlimit_failure_is_not_swallowed(self) -> None:
        """The platform branch must not become a general exception guard.

        Proof: rewriting the branch as `try: setrlimit(...) except ValueError: return`
        failed this case on `ValueError not raised`.
        """
        with (
            mock.patch.object(launcher.sys, "platform", "linux"),
            mock.patch.object(
                launcher.resource, "setrlimit", side_effect=ValueError("current limit")
            ),
        ):
            with self.assertRaises(ValueError):
                launcher._apply_address_space_limit(512)

    def test_no_address_space_limit_is_attempted_off_linux(self) -> None:
        """Darwin has no cgroup ceiling to complete, and refuses this call.

        Proof: deleting the branch failed this case on "Expected 'setrlimit' to not
        have been called. Called 1 times."
        """
        with (
            mock.patch.object(launcher.sys, "platform", "darwin"),
            mock.patch.object(launcher.resource, "setrlimit") as setrlimit,
        ):
            launcher._apply_address_space_limit(512)
        setrlimit.assert_not_called()

    def test_abort_never_execs_the_solver(self) -> None:
        done = subprocess.run(
            self.command(int(time.time() * 1_000) + 30_000),
            input=b"abort\nrequest that must not be read",
            capture_output=True,
            env=self.env,
            timeout=10,
            check=False,
        )
        self.assertEqual(done.returncode, launcher.EXIT_ABORTED)
        self.assertEqual(done.stdout, b"")

    def test_closed_stdin_never_execs_the_solver(self) -> None:
        done = subprocess.run(
            self.command(int(time.time() * 1_000) + 30_000),
            input=b"",
            capture_output=True,
            env=self.env,
            timeout=10,
            check=False,
        )
        self.assertEqual(done.returncode, launcher.EXIT_ABORTED)
        self.assertEqual(done.stdout, b"")

    def test_bound_after_the_absolute_deadline_never_execs(self) -> None:
        done = subprocess.run(
            self.command(int(time.time() * 1_000) - 1),
            input=b"bound\nrequest that must not be read",
            capture_output=True,
            env=self.env,
            timeout=10,
            check=False,
        )
        self.assertEqual(done.returncode, launcher.EXIT_ABORTED)
        self.assertEqual(done.stdout, b"")

    @unittest.skipUnless(sys.platform == "linux", "the production deadline is Linux-only")
    def test_bound_solver_is_killed_at_the_absolute_deadline(self) -> None:
        self.replace_solver("import time\ntime.sleep(5)\n")
        started = time.monotonic()
        done = subprocess.run(
            self.command(int(time.time() * 1_000) + 300),
            input=b"bound\n",
            capture_output=True,
            env=self.env,
            timeout=2,
            check=False,
        )
        self.assertEqual(done.returncode, -launcher.signal.SIGALRM)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_open_stdin_without_a_verdict_times_out(self) -> None:
        started = time.monotonic()
        with subprocess.Popen(
            self.command(int(time.time() * 1_000) + 30_000),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
        ) as process:
            code = process.wait(timeout=7)
        elapsed = time.monotonic() - started
        self.assertEqual(code, launcher.EXIT_ABORTED)
        self.assertGreaterEqual(elapsed, 4.5)
        self.assertLess(elapsed, 7)


class ParentGuard(unittest.TestCase):
    def test_parent_change_inside_the_prctl_window_self_terminates(self) -> None:
        with (
            mock.patch.object(launcher.os, "getppid", side_effect=[100, 101]),
            mock.patch.object(launcher, "set_parent_death_signal", return_value=True),
            mock.patch.object(launcher.os, "getpid", return_value=200),
            mock.patch.object(launcher.os, "kill") as kill,
        ):
            with self.assertRaisesRegex(RuntimeError, "parent changed"):
                launcher._install_parent_guard()
        kill.assert_called_once_with(200, launcher.signal.SIGKILL)

    def test_no_parent_race_check_where_no_guard_was_installed(self) -> None:
        """An unguarded launcher must survive an ordinary re-parenting.

        The helper returns False having installed nothing, so the window this
        check exists for never opened. Running it anyway would SIGKILL a healthy
        Darwin launcher whose parent merely changed.

        Proof: discarding the helper's return value failed this case with
        `RuntimeError: parent changed while installing PR_SET_PDEATHSIG`.
        """
        with (
            mock.patch.object(launcher.os, "getppid", side_effect=[100, 101]),
            mock.patch.object(launcher, "set_parent_death_signal", return_value=False),
            mock.patch.object(launcher.os, "kill") as kill,
        ):
            launcher._install_parent_guard()
        kill.assert_not_called()

    def test_importing_the_launcher_does_not_import_cp_sat(self) -> None:
        done = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys, wbs_solver.launcher; "
                "raise SystemExit(any(name == 'ortools' or name.startswith('ortools.') "
                "for name in sys.modules))",
            ],
            capture_output=True,
            env=dict(os.environ, PYTHONPATH=str(SRC)),
            timeout=10,
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_distribution_declares_the_version_locked_launcher_script(self) -> None:
        project = tomllib.loads((PACKAGE_ROOT / "pyproject.toml").read_text())
        self.assertEqual(
            project["project"]["scripts"],
            {
                "wbs-solver": "wbs_solver.cli:main",
                "wbs-solver-launcher": "wbs_solver.launcher:main",
            },
        )


if __name__ == "__main__":
    unittest.main()
