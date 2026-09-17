/**
 * Provision and verify the local development solver environment.
 *
 * **Why this exists.** Each solver lock is single-platform by construction:
 * `libs/wbs/adapters/solver-py/requirements.lock` is the Linux x86_64 runtime
 * lock h2puni and CI install, and
 * `libs/wbs/adapters/solver-py/requirements.macos-arm64.lock` pins the same
 * versions to macOS arm64 wheels. `wbs-solver-py:test` on a developer machine
 * resolves bare `python3` to whatever is first on PATH — on one Mac an Anaconda
 * 3.13 with no OR-Tools, so the target failed before a single assertion. This
 * builds the one interpreter-and-wheels environment that both the suite and the
 * local solver use, hash-verified from the lock for the host it runs on.
 *
 * **One environment object, both uses.** {@link solverEnvironment} returns the
 * absolute paths, and every consumer takes them from here rather than
 * re-deriving a `python3`. A probe that reads a version from one interpreter
 * while a spawn runs another is the shape that lets an old install keep
 * reporting the current version — see {@link verifySolverEnvironment}, which
 * checks the two against each other rather than trusting either alone.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Where the provisioned interpreter and console scripts live. */
export interface SolverEnvironment {
  /** The venv root, deliberately inside the repo and gitignored. */
  readonly root: string;
  /** Absolute interpreter. Never bare `python3`. */
  readonly python: string;
  /** Absolute `bin`, which the launcher's own `execvp("wbs-solver")` needs on PATH. */
  readonly bin: string;
  /** The hash-verified lock this environment is built from. */
  readonly lock: string;
}

/** The host a lock must match; `process.platform` and `process.arch` in production. */
export interface SolverHost {
  readonly platform: string;
  readonly arch: string;
}

const LINUX_LOCK = 'libs/wbs/adapters/solver-py/requirements.lock';
const MACOS_LOCK = 'libs/wbs/adapters/solver-py/requirements.macos-arm64.lock';

function lockFor(host: SolverHost): string {
  if (host.platform === 'linux' && host.arch === 'x64') return LINUX_LOCK;
  if (host.platform === 'darwin' && host.arch === 'arm64') return MACOS_LOCK;
  throw new Error(
    `no solver lock for ${host.platform}/${host.arch}; locks exist for linux/x64 and darwin/arm64`,
  );
}

/**
 * The repo-relative layout, resolved against a caller-supplied root for tests.
 *
 * @throws When no lock was generated for `host`; every lock is single-platform,
 * so any other choice fails later as a wheel hash mismatch instead.
 */
export function solverEnvironment(repoRoot: string, host: SolverHost): SolverEnvironment {
  const root = resolve(repoRoot, '.venv-solver');
  return {
    root,
    python: join(root, 'bin', 'python'),
    bin: join(root, 'bin'),
    lock: resolve(repoRoot, lockFor(host)),
  };
}

/**
 * The interpreter the venv is built from.
 *
 * A single minor version because `pyproject.toml` pins `>=3.14,<3.15` and says
 * that range is deliberate. The patch level is deliberately NOT pinned to the
 * image's 3.14.4: the wheels in the lock are `cp314`, which is an ABI tag
 * shared across the whole 3.14 series, so demanding an exact patch would send a
 * developer building CPython to gain nothing the ABI does not already give.
 */
export const SOLVER_PYTHON = 'python3.14';

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly path?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.path === undefined ? process.env : { ...process.env, PATH: options.path },
  });
  if (result.error !== undefined) {
    throw new Error(`${command} could not be run: ${result.error.message}`);
  }
  return {
    status: result.status ?? -1,
    // `encoding: 'utf8'` makes both of these strings; a `?? ''` here would be a
    // default for a state spawnSync cannot produce, which is the shape R5 bans.
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Every `name==version` pin in a lock file, for the drift comparison. */
export function lockPins(lockText: string): ReadonlyMap<string, string> {
  const pins = new Map<string, string>();
  for (const line of lockText.split('\n')) {
    const match = /^([A-Za-z0-9._-]+)==([^\s\\]+)/.exec(line);
    if (match === null) continue;
    const name = match[1].toLowerCase().replaceAll('_', '-');
    if (pins.has(name)) throw new Error(`lock names ${name} twice`);
    pins.set(name, match[2]);
  }
  if (pins.size === 0) throw new Error('lock contains no pins');
  return pins;
}

/**
 * The two locks must agree on every version, differing only in artifacts.
 *
 * **This is the check the macOS lock exists to make possible.** Resolving free
 * on this platform picked numpy 2.5.3 where Linux pins 2.5.2, which would put
 * the two platforms on different code while both files looked maintained. The
 * macOS lock is generated under the Linux pins as constraints, so the version
 * map is identical by construction — and this re-reads it, because
 * "by construction" stops being true the moment somebody regenerates one file
 * and not the other.
 *
 * Proof: deleting the version comparison left the numpy 2.5.2/2.5.3 case in
 * `solver-environment.test.ts` passing — `Expected substring: "numpy: linux
 * 2.5.2, macos 2.5.3" / Received function did not throw`.
 */
export function assertLocksAgree(linuxLockText: string, macLockText: string): void {
  const linux = lockPins(linuxLockText);
  const mac = lockPins(macLockText);
  const drift: string[] = [];
  for (const [name, version] of linux) {
    const macVersion = mac.get(name);
    if (macVersion === undefined) drift.push(`${name}: missing from the macOS lock`);
    else if (macVersion !== version) drift.push(`${name}: linux ${version}, macos ${macVersion}`);
  }
  for (const name of mac.keys()) {
    if (!linux.has(name)) drift.push(`${name}: only in the macOS lock`);
  }
  if (drift.length > 0) {
    throw new Error(
      `solver locks disagree; regenerate the macOS lock under the Linux pins:\n  ${drift.join('\n  ')}`,
    );
  }
}

/**
 * Build the venv from the lock, then install the distribution itself.
 *
 * `--require-hashes` covers the dependencies; the distribution is installed
 * `--no-deps` afterwards so the lock stays the only resolver authority and the
 * install cannot quietly pull an unpinned transitive of its own.
 */
export function provisionSolverEnvironment(repoRoot: string, host: SolverHost): SolverEnvironment {
  const environment = solverEnvironment(repoRoot, host);
  // Checked on every host, not only macOS: a Linux developer who regenerates
  // the runtime lock is the one who leaves the macOS lock behind.
  assertLocksAgree(
    readFileSync(resolve(repoRoot, LINUX_LOCK), 'utf8'),
    readFileSync(resolve(repoRoot, MACOS_LOCK), 'utf8'),
  );

  const created = run(SOLVER_PYTHON, ['-m', 'venv', environment.root]);
  if (created.status !== 0) {
    throw new Error(`${SOLVER_PYTHON} -m venv failed: ${created.stderr.trim()}`);
  }

  const deps = run(environment.python, [
    '-m',
    'pip',
    'install',
    '--quiet',
    '--require-hashes',
    '--only-binary=:all:',
    '-r',
    environment.lock,
  ]);
  if (deps.status !== 0) throw new Error(`locked install failed: ${deps.stderr.trim()}`);

  const distribution = run(environment.python, [
    '-m',
    'pip',
    'install',
    '--quiet',
    '--no-deps',
    resolve(repoRoot, 'libs/wbs/adapters/solver-py'),
  ]);
  if (distribution.status !== 0) {
    throw new Error(`wbs-solver install failed: ${distribution.stderr.trim()}`);
  }
  return environment;
}

/** What a verified environment reports about itself. */
export interface SolverEnvironmentReport {
  readonly pythonVersion: string;
  readonly platform: string;
  /** From `importlib.metadata` — the installed distribution, not the source tree. */
  readonly installedVersion: string;
  /** From the imported package — the code that will actually run. */
  readonly importedVersion: string;
}

/**
 * Prove the environment is the one we think it is, through its own interpreter.
 *
 * The two version readings are taken from different authorities on purpose:
 * `importlib.metadata` describes what pip recorded, `wbs_solver.__version__`
 * describes the module that will execute. A stale editable install can leave
 * those disagreeing while either one alone still reads `0.1.1`.
 *
 * Proof: deleting the two-authority comparison left a fake interpreter
 * reporting `installedVersion 0.1.1` beside `importedVersion 0.0.9` accepted —
 * `Received function did not throw`.
 */
export function verifySolverEnvironment(environment: SolverEnvironment): SolverEnvironmentReport {
  if (!existsSync(environment.python)) {
    throw new Error(`solver environment is not provisioned: no ${environment.python}`);
  }
  const probe = run(environment.python, [
    '-c',
    [
      'import json,sys,platform',
      'from importlib.metadata import version',
      'import wbs_solver',
      'print(json.dumps({',
      ' "pythonVersion": platform.python_version(),',
      ' "platform": sys.platform,',
      ' "installedVersion": version("wbs-solver"),',
      ' "importedVersion": wbs_solver.__version__}))',
    ].join('\n'),
  ]);
  if (probe.status !== 0) {
    throw new Error(`solver environment probe failed: ${probe.stderr.trim()}`);
  }
  const report = JSON.parse(probe.stdout) as SolverEnvironmentReport;
  if (report.installedVersion !== report.importedVersion) {
    throw new Error(
      `solver environment is stale: pip recorded ${report.installedVersion} but the importable package is ${report.importedVersion}`,
    );
  }
  return report;
}

/**
 * The `PATH` a solver child must run under.
 *
 * **Not cosmetic.** `launcher.py` finishes with `os.execvp("wbs-solver", ...)`,
 * a second lookup that an absolute path to the *launcher* does not constrain.
 * Without this the launcher binds, arms its deadline, and then execs whichever
 * `wbs-solver` the ambient shell happens to offer — or none, which is
 * `FileNotFoundError: [Errno 2]` after a successful bind, observed on this
 * machine before the environment's `bin` was put in front.
 *
 * An absent `PATH` throws rather than defaulting to the venv alone: a process
 * with no `PATH` is a machine in a state this cannot reason about, and R5 says
 * unknown is not OK.
 */
export function solverChildPath(environment: SolverEnvironment): string {
  const inherited = process.env['PATH'];
  if (inherited === undefined || inherited.length === 0) {
    throw new Error('PATH is unset; refusing to guess a solver child environment');
  }
  return `${environment.bin}:${inherited}`;
}

/** Run one golden request through the real console script, as the final readiness proof. */
export function solveGoldenRequest(repoRoot: string, environment: SolverEnvironment): string {
  const request = readFileSync(
    resolve(
      repoRoot,
      'libs/wbs/domain/contracts/solver/fixtures/request/valid-quantised-baseline.json',
    ),
    'utf8',
  );
  const solved = spawnSync(join(environment.bin, 'wbs-solver'), [], {
    input: request,
    encoding: 'utf8',
    env: { ...process.env, PATH: solverChildPath(environment) },
  });
  if (solved.status !== 0) {
    throw new Error(`golden solve exited ${String(solved.status)}: ${solved.stderr}`);
  }
  return solved.stdout.trim();
}
