/**
 * `nx run wbs-solver-py:setup-macos` — build and prove the local solver environment.
 *
 * Separate from `dev:setup`, which seeds `.env` files and must keep working on a
 * machine that will never run a solver. This one is opt-in for the local
 * solver profile and refuses rather than degrades: an environment that
 * cannot be verified is not a usable optimizer, and reporting one would put the
 * plan read back where the stale-seat bug left it — being told work is
 * happening when none is.
 */
import {
  provisionSolverEnvironment,
  solveGoldenRequest,
  verifySolverEnvironment,
} from './solver-environment';

const repoRoot = process.cwd();
const environment = provisionSolverEnvironment(repoRoot);
const report = verifySolverEnvironment(environment);
const solved = solveGoldenRequest(repoRoot, environment);
const status = JSON.parse(solved) as { status?: string };
if (status.status !== 'feasible') {
  throw new Error(`golden request did not solve feasibly: ${solved.slice(0, 200)}`);
}

process.stdout.write(
  [
    `solver environment ready at ${environment.root}`,
    `  python           ${report.pythonVersion} (${report.platform})`,
    `  wbs-solver       ${report.installedVersion}`,
    `  golden request   ${status.status}`,
    '',
    '  This profile has NO memory enforcement and NO parent-death signal:',
    '  both are Linux mechanisms the supervised path owns. A solve here is',
    '  unbounded in memory, and a be-01 crash can leave the child running',
    '  until its own deadline alarm fires.',
    '',
  ].join('\n'),
);
