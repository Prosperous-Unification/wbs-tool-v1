"""The entrypoint's two contracts: what it does before it reads, and what it
refuses.

Split deliberately into in-process tests and subprocess tests. The in-process
ones can watch call order, which is the whole subject of `PDEATHSIG`; the
subprocess ones are the only ones that prove the real `sys.stdin.buffer` path
and that a refusal leaves stdout empty, which no monkeypatched stream can show.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SRC = PACKAGE_ROOT / "src"
FIXTURES = PACKAGE_ROOT.parents[1] / "libs" / "contracts" / "solver" / "fixtures" / "request"
sys.path.insert(0, str(SRC))

from wbs_solver import __version__, cli  # noqa: E402
from wbs_solver.solve import SolveFailed  # noqa: E402


def run_cli(stdin: bytes, args: list[str] | None = None) -> subprocess.CompletedProcess[bytes]:
    """The real console script path, as a child process.

    `-m wbs_solver` rather than the installed `wbs-solver` script on purpose:
    the suite runs in CI from a checkout, and `__main__.py` calls the same
    `main`. The installed script is proved from the built image by 5.11's
    smoke test, which is a different claim and belongs there.
    """
    env = dict(os.environ, PYTHONPATH=str(SRC))
    return subprocess.run(
        [sys.executable, "-m", "wbs_solver", *(args or [])],
        input=stdin,
        capture_output=True,
        env=env,
        timeout=30,
        check=False,
    )


class ParentDeathSignalOrdering(unittest.TestCase):
    """`prctl(PR_SET_PDEATHSIG, SIGKILL)` is installed before stdin is read.

    Watched red: move `set_parent_death_signal()` in `cli.main` to after the
    `read_request` call and this fails on the recorded order, naming both
    calls. Delete it entirely and `installs_it_at_all` fails too.
    """

    def _record(self) -> list[str]:
        return []

    def test_pdeathsig_is_installed_before_the_first_read(self) -> None:
        calls = self._record()
        with (
            mock.patch.object(cli, "set_parent_death_signal", lambda: calls.append("pdeathsig") or True),
            mock.patch.object(cli, "read_request", lambda stream: calls.append("read") or b""),
        ):
            code = cli.main([])
        self.assertEqual(calls, ["pdeathsig", "read"])
        # The empty read is a refusal, which is the next test's subject; it is
        # asserted here only so a silently-changed exit code cannot make the
        # order above vacuous.
        self.assertEqual(code, cli.EXIT_BAD_REQUEST)

    def test_pdeathsig_is_installed_before_version_is_printed(self) -> None:
        calls = self._record()
        with (
            mock.patch.object(cli, "set_parent_death_signal", lambda: calls.append("pdeathsig") or True),
            mock.patch("sys.stdout", io.StringIO()),
        ):
            code = cli.main(["--version"])
        self.assertEqual(calls, ["pdeathsig"])
        self.assertEqual(code, cli.EXIT_OK)

    @unittest.skipUnless(sys.platform == "linux", "PR_SET_PDEATHSIG is Linux-only")
    def test_installs_it_at_all(self) -> None:
        """The real call, against the real libc. Returns True or raises.

        This is the non-vacuous half: the ordering tests above would pass with
        a `set_parent_death_signal` that did nothing.
        """
        self.assertTrue(cli.set_parent_death_signal())


class VersionFlag(unittest.TestCase):
    def test_prints_the_bare_version_and_nothing_else(self) -> None:
        done = run_cli(b"", ["--version"])
        self.assertEqual(done.returncode, cli.EXIT_OK)
        self.assertEqual(done.stdout.decode(), f"{__version__}\n")

    def test_does_not_read_stdin(self) -> None:
        """A coordinator probing the version writes nothing and closes nothing.

        With stdin held open and empty, a `--version` that read it would block
        until the timeout rather than answering. `input=b""` closes stdin, so
        the blocking case is built explicitly with a pipe nobody writes to.
        """
        env = dict(os.environ, PYTHONPATH=str(SRC))
        with subprocess.Popen(
            [sys.executable, "-m", "wbs_solver", "--version"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        ) as proc:
            out, _ = proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, cli.EXIT_OK)
        self.assertEqual(out.decode(), f"{__version__}\n")


class RefusedRequests(unittest.TestCase):
    """Every refusal exits 64 and writes nothing at all to stdout.

    The stdout assertion is the one that matters. The response schema has no
    status for "refused", so a solver that emitted a partial message here would
    be handing the coordinator something it cannot tell from a solved answer.
    """

    def assert_refused(self, stdin: bytes, because: str) -> None:
        done = run_cli(stdin)
        self.assertEqual(done.returncode, cli.EXIT_BAD_REQUEST, done.stderr)
        self.assertEqual(done.stdout, b"")
        self.assertIn(because, done.stderr.decode())

    def test_empty_stdin(self) -> None:
        self.assert_refused(b"", "empty request")

    def test_whitespace_only(self) -> None:
        self.assert_refused(b"  \n\t ", "empty request")

    def test_not_json(self) -> None:
        self.assert_refused(b"{not json", "not valid JSON")

    def test_not_utf8(self) -> None:
        self.assert_refused(b'{"wireVersion": "\xff\xfe"}', "not valid UTF-8")

    def test_json_array(self) -> None:
        self.assert_refused(b"[1, 2]", "must be a JSON object")

    def test_json_scalar(self) -> None:
        self.assert_refused(b"7", "must be a JSON object")

    def test_unexpected_argument(self) -> None:
        done = run_cli(b"", ["--daemon"])
        self.assertEqual(done.returncode, cli.EXIT_BAD_REQUEST)
        self.assertEqual(done.stdout, b"")
        self.assertIn("unexpected arguments", done.stderr.decode())


class AnsweredRequests(unittest.TestCase):
    """The whole path, through a real process: stdin to a parsed response.

    Both inputs are real corpus fixtures rather than hand-built stubs — they
    have to clear the schema and every cross-field check to reach the solver at
    all, so these cases double as the proof that a valid request gets through
    the front door.

    Before 5.2 this class asserted that the same fixture exited 70 with nothing
    on stdout, because `solve_request` raised. The rule it was protecting has
    not changed and has simply moved down to `UnencodableOutcomes` below, which
    is where it now has a subject.
    """

    def test_a_solvable_request_is_answered_on_stdout_and_exits_zero(self) -> None:
        done = run_cli((FIXTURES / "valid-quantised-baseline.json").read_bytes())
        self.assertEqual(done.returncode, cli.EXIT_OK, done.stderr)
        response = json.loads(done.stdout)
        self.assertEqual(response["status"], "feasible")
        self.assertEqual(sorted(response["offsets"].values()), [0, 10, 20])
        self.assertEqual(response["wireVersion"], 1)

    def test_search_workers_are_process_metadata_and_reach_the_solver_config(self) -> None:
        request = (FIXTURES / "valid-quantised-baseline.json").read_bytes()
        out, err = io.StringIO(), io.StringIO()
        seen: list[int] = []

        def answer(parsed: object, config: object) -> dict[str, object]:
            seen.append(config.num_search_workers)
            return {"wireVersion": 1, "status": "infeasible"}

        with (
            mock.patch.object(cli, "read_request", return_value=request),
            mock.patch.object(cli, "solve_request", side_effect=answer),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            code = cli.main(["--search-workers", "3"])
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(seen, [3])

    def test_non_positive_search_worker_count_is_refused_before_reading(self) -> None:
        with mock.patch.object(cli, "read_request") as read:
            self.assertEqual(cli.main(["--search-workers", "0"]), cli.EXIT_BAD_REQUEST)
        read.assert_not_called()

    def test_an_infeasible_plan_is_a_response_and_not_a_failure(self) -> None:
        """`valid-two-slices.json` is schema-valid with a width-5 slice on a
        capacity-2 pool. Stage 1 INFEASIBLE is a typed outcome the wire carries,
        so it exits 0 with a response — not 70 with silence."""
        done = run_cli((FIXTURES / "valid-two-slices.json").read_bytes())
        self.assertEqual(done.returncode, cli.EXIT_OK, done.stderr)
        response = json.loads(done.stdout)
        self.assertEqual(response["status"], "infeasible")
        self.assertNotIn("offsets", response)


class UnencodableOutcomes(unittest.TestCase):
    """An outcome the response schema cannot encode exits non-zero **without**
    emitting a response.

    The unencodable outcome is a later-stage INFEASIBLE: every constraint a
    later stage adds is already satisfied by the previous incumbent, so reaching
    it means the solver holds a counterexample to its own answer, and
    `solver-wire.v1.json`'s response `$comment` requires it to exit non-zero
    silently rather than emit a proof it can itself refute.

    It cannot be produced by any request — that is the whole argument for the
    row — so the failure is injected at the seam `cli.main` actually catches.
    Driving `main` in-process is the point: the rule under test is that stdout
    stays empty on that path, and a subprocess could only prove it for an
    outcome no input can reach.
    """

    def test_a_solve_failure_exits_70_with_nothing_on_stdout(self) -> None:
        request = (FIXTURES / "valid-quantised-baseline.json").read_bytes()
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(cli, "read_request", return_value=request),
            mock.patch.object(
                cli, "solve_request", side_effect=SolveFailed("stage 2 is infeasible")
            ),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            code = cli.main([])
        self.assertEqual(code, cli.EXIT_INTERNAL)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("stage 2 is infeasible", err.getvalue())

    def test_the_same_seam_answers_normally_when_the_solve_succeeds(self) -> None:
        """The slack half: the patched harness is not what empties stdout."""
        request = (FIXTURES / "valid-quantised-baseline.json").read_bytes()
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(cli, "read_request", return_value=request),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            code = cli.main([])
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(json.loads(out.getvalue())["status"], "feasible")


if __name__ == "__main__":
    unittest.main()
