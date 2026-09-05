"""The lifecycle launcher never creates a solver before a valid bind."""

from __future__ import annotations

import os
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
        self.assertEqual(done.stdout, b"0.1.0\n")

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
            mock.patch.object(launcher, "set_parent_death_signal"),
            mock.patch.object(launcher.os, "getpid", return_value=200),
            mock.patch.object(launcher.os, "kill") as kill,
        ):
            with self.assertRaisesRegex(RuntimeError, "parent changed"):
                launcher._install_parent_guard()
        kill.assert_called_once_with(200, launcher.signal.SIGKILL)

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
