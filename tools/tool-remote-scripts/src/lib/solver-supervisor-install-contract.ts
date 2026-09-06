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
export const SOLVER_SUPERVISOR_BUN_VERSION = '1.3.14';
export const SOLVER_SUPERVISOR_RUNTIME_DIRECTORY = 'wbs-solver';
export const SOLVER_SUPERVISOR_SOCKET = '/run/user/1000/wbs-solver/supervisor.sock';

/** Refuses an ambient or stale host Bun before an installer mutates the service. */
export function assertSolverSupervisorBunVersion(stdout: string): void {
  const actual = stdout.trim();
  if (actual !== SOLVER_SUPERVISOR_BUN_VERSION) {
    throw new Error(
      `solver supervisor requires ${SOLVER_SUPERVISOR_BUN} ${SOLVER_SUPERVISOR_BUN_VERSION}; got ${actual || '(missing)'}`,
    );
  }
}
