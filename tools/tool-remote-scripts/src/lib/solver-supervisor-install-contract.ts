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
/** Stable host-wide runtime published atomically with the supervisor service. */
export const SOLVER_SUPERVISOR_BUN = '/home/puni1/.local/lib/wbs-solver/bun';
/** Exact local Bun executing the installer and copied into the host-wide location. */
export const SOLVER_SUPERVISOR_BUN_SOURCE = process.execPath;
/**
 * Host Bun versions from {@link SOLVER_SUPERVISOR_BUN_SOURCE} whose accepted Unix sockets expose the fd required for
 * Linux SO_PEERCRED authentication.
 *
 * TASK-488 proved on h2puni that Bun 1.2.20 returns `undefined` for `socket.fd`
 * through the shipped cross-process listener shape while 1.4.2 returns a valid
 * descriptor. Module/config preflight alone is insufficient: 1.2.20 passed it
 * but made the running supervisor reject every peer.
 */
export const SOLVER_SUPERVISOR_BUN_VERSIONS = ['1.4.2'] as const;
export const SOLVER_SUPERVISOR_RUNTIME_DIRECTORY = 'wbs-solver';
export const SOLVER_SUPERVISOR_SOCKET = '/run/user/1000/wbs-solver/supervisor.sock';

/** Refuses a runtime without measured accepted-socket fd support before mutation. */
export function assertSolverSupervisorBunVersion(stdout: string): void {
  const actual = stdout.trim();
  if (!SOLVER_SUPERVISOR_BUN_VERSIONS.some((version) => version === actual)) {
    throw new Error(
      `solver supervisor requires ${SOLVER_SUPERVISOR_BUN_SOURCE} at ${SOLVER_SUPERVISOR_BUN_VERSIONS.join(', ')}; got ${actual || '(missing)'}`,
    );
  }
}
