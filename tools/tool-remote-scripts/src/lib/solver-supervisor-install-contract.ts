import type { BundleFile } from './deploy-contract';

/** One host-wide artifact: it is deliberately outside every prod/dev root. */
export const SOLVER_SUPERVISOR_BUNDLE: BundleFile = {
  local: 'dist/tool-remote-scripts/solver-supervisor.js',
  remote: '/home/puni1/.local/lib/wbs-solver/solver-supervisor.js',
};

export const SOLVER_SUPERVISOR_CONFIG = '/home/puni1/.config/wbs-solver/solver-supervisor.json';
export const SOLVER_SUPERVISOR_UNIT =
  '/home/puni1/.config/systemd/user/wbs-solver-supervisor.service';
export const SOLVER_SUPERVISOR_UNIT_SOURCE =
  'deploy/solver-supervisor/wbs-solver-supervisor.service';
export const SOLVER_SUPERVISOR_SERVICE = 'wbs-solver-supervisor.service';
export const SOLVER_SUPERVISOR_BUN = '/usr/local/bin/bun';
/**
 * Host Bun versions the supervisor bundle has been measured against on h2puni.
 *
 * It is a set and not a pin because 1.3.14 has never existed at
 * /usr/local/bin/bun on that host: it carries a 1.2.20 binary from
 * 2025-08-10, and the only 1.3.14-named install was replaced with 1.4.2 on
 * 2026-09-05, so the equality check refused every real host and the rollout
 * could not be installed at all (TASK-321, TASK-325).
 *
 * Evidence for both entries, 2026-09-07: the bundle built from that day's main
 * answered `--preflight=dev` with `dev mapping preflight ok` rc=0 under each.
 * That exercises module load and config decode, NOT the running supervisor —
 * so an entry here means measured, never assumed, and an unlisted version is
 * refused precisely because nobody has run it.
 */
export const SOLVER_SUPERVISOR_BUN_VERSIONS = ['1.2.20', '1.4.2'] as const;
export const SOLVER_SUPERVISOR_RUNTIME_DIRECTORY = 'wbs-solver';
export const SOLVER_SUPERVISOR_SOCKET = '/run/user/1000/wbs-solver/supervisor.sock';

/** Refuses an unmeasured host Bun before an installer mutates the service. */
export function assertSolverSupervisorBunVersion(stdout: string): void {
  const actual = stdout.trim();
  if (!SOLVER_SUPERVISOR_BUN_VERSIONS.some((version) => version === actual)) {
    throw new Error(
      `solver supervisor requires ${SOLVER_SUPERVISOR_BUN} at ${SOLVER_SUPERVISOR_BUN_VERSIONS.join(', ')}; got ${actual || '(missing)'}`,
    );
  }
}
