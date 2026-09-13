/**
 * A {@link ReservedSpawner} that runs the solver as a local child process.
 *
 * **Development only, and never a fallback.** This is selected by starting a
 * different entrypoint ({@link file://./be-01.ts}); a supervisor that cannot be
 * reached stays a supervisor failure and never causes Python to be spawned
 * here. The wrong pairing is unspellable rather than merely untested: there is
 * no mode flag to set incorrectly, and `main.ts` cannot reach this module's
 * factory at all.
 *
 * **What it does NOT provide**, all three being Linux mechanisms the supervised
 * path owns and this one has no substitute for:
 *
 * - no cgroup memory ceiling, so a solve here is unbounded in memory;
 * - no `PR_SET_PDEATHSIG`, so a be-01 that dies leaves the child running until
 *   its own `SIGALRM` deadline fires — and a stopped child outlives even that;
 * - no `systemd-run` timer, so the deadline has no durable external owner.
 *
 * Those absences are reported by {@link LOCAL_SOLVER_CAPABILITIES} and printed
 * at startup rather than described only here. A profile that quietly implied
 * production's guarantees would be the same class of untruth as the stale seat
 * that reported `retrying` with nothing running.
 */
import type {
  ReservedSolverChild,
  ReservedSpawner,
  ReservedSpawnRequest,
} from '../service/optimization-coordinator';
import { spawnSolverLauncher } from '../service/solver-launcher-process';

/** What this profile actually guarantees, in the shape a caller can print. */
export interface LocalSolverCapabilities {
  readonly kind: 'local-solver';
  readonly parentDeath: 'no-immediate-termination';
  readonly memoryEnforcement: 'none';
  readonly oomEvidence: 'unavailable';
  readonly deadline: 'child-alarm-only';
}

/**
 * The literal capability record.
 *
 * Written as one frozen constant rather than assembled per call so that a
 * caller cannot report a capability the spawner does not have; the startup
 * banner and any future status endpoint read this same object.
 */
export const LOCAL_SOLVER_CAPABILITIES: LocalSolverCapabilities = Object.freeze({
  kind: 'local-solver',
  parentDeath: 'no-immediate-termination',
  memoryEnforcement: 'none',
  oomEvidence: 'unavailable',
  deadline: 'child-alarm-only',
});

export interface LocalSolverOptions {
  /** Absolute `bin` of the provisioned environment; `solver-py:setup-macos` makes it. */
  readonly binDirectory: string;
  /** CP-SAT search workers, matching the supervised path's configuration knob. */
  readonly searchWorkers: number;
  /**
   * Passed through to the launcher because its argument parser requires it.
   *
   * It buys nothing on this platform: `_apply_address_space_limit` is Linux-only
   * by construction, so this number is carried and discarded. It is NOT renamed
   * or defaulted away, because the launcher's protocol is production's and this
   * profile does not get to edit it.
   */
  readonly memoryLimitMb: number;
}

/**
 * The child environment a solver launcher must run under.
 *
 * **`launcher.py` finishes with `os.execvp("wbs-solver", ...)`** — a second
 * lookup that an absolute path to the launcher does not constrain. Without the
 * provisioned `bin` in front, the launcher binds, arms its deadline, and then
 * execs whichever `wbs-solver` the ambient shell offers, or none: observed on
 * this machine as `FileNotFoundError: [Errno 2] No such file or directory`
 * raised from `os.execvp` *after* a successful bind, which reads downstream as
 * an ordinary non-zero exit rather than as a misconfigured environment.
 *
 * `PYTHONPATH` and `PYTHONHOME` are dropped rather than forwarded: an inherited
 * import path can put a different `wbs_solver` in front of the provisioned one,
 * which is the same stale-install fault `verifySolverEnvironment` refuses, only
 * arriving at spawn time where nothing checks versions.
 *
 * Proof: appending the provisioned `bin` rather than prepending it failed
 * `local-solver-spawner.test.ts`'s `puts the provisioned bin ahead of
 * everything inherited` on `Received: "/usr/bin:/bin:/repo/.venv-solver/bin"`;
 * forwarding `PYTHONPATH` failed `drops inherited Python import overrides` on
 * `Received: "/somewhere/else"`.
 */
export function createSolverChildEnvironment(
  binDirectory: string,
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  const path = inherited['PATH'];
  if (path === undefined || path.length === 0) {
    throw new Error('PATH is unset; refusing to guess a solver child environment');
  }
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (key === 'PYTHONPATH' || key === 'PYTHONHOME' || key === 'PATH') continue;
    child[key] = value;
  }
  child['PATH'] = `${binDirectory}:${path}`;
  return child;
}

/**
 * Build the spawner.
 *
 * The bind transport is production's {@link spawnSolverLauncher} rather than a
 * copy: reading the verdict one byte at a time so no request byte is consumed
 * before `exec` is a lifecycle invariant, and a second implementation of it is
 * a second place for an apparently harmless buffered read to break solving.
 */
export function createLocalSolverSpawner(options: LocalSolverOptions): ReservedSpawner {
  return (request: ReservedSpawnRequest): Promise<ReservedSolverChild> => {
    const environment = createSolverChildEnvironment(options.binDirectory, process.env);
    const child = spawnSolverLauncher(
      {
        attemptToken: request.admission.attemptToken,
        childDeadlineAt: request.admission.childDeadlineAt,
        searchWorkers: options.searchWorkers,
        memoryLimitMb: options.memoryLimitMb,
        request: { ...request.request },
      },
      (spawnOptions) =>
        Bun.spawn({
          cmd: [...spawnOptions.cmd],
          stdin: spawnOptions.stdin,
          stdout: spawnOptions.stdout,
          stderr: spawnOptions.stderr,
          env: environment,
        }),
    );
    return Promise.resolve({
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      verdict: child.verdict,
      kill: child.kill,
      // `terminal` is deliberately absent. The coordinator's documented
      // fallback classifies a raw exit code, which is exactly what this profile
      // can honestly supply: with no cgroup there is no OOM evidence to report,
      // and inventing a `terminal` claiming `oomKilled: false` would assert a
      // fact nothing here observed.
    });
  };
}
