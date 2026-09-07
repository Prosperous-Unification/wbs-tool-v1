import { describe, expect, it } from 'bun:test';

import {
  buildSolverSupervisorInstallPlan,
  installSolverSupervisor,
  parseSolverSupervisorInstallArgs,
  type SolverSupervisorInstallerDependencies,
} from './install-solver-supervisor';
import {
  SOLVER_SUPERVISOR_BUN,
  SOLVER_SUPERVISOR_BUN_VERSIONS,
  SOLVER_SUPERVISOR_BUNDLE,
  SOLVER_SUPERVISOR_CONFIG,
  SOLVER_SUPERVISOR_UNIT,
} from './lib/solver-supervisor-install-contract';

const IMAGE = `registry.example/wbs-be@sha256:${'a'.repeat(64)}`;
const SOCKET = '/run/user/1000/wbs-solver/supervisor.sock';
const MEASURED_BUN_VERSIONS = ['1.2.20', '1.4.2'] as const;
const CONFIG = JSON.stringify({
  socketPath: SOCKET,
  maxSearchWorkers: 2,
  maxMemoryLimitMb: 512,
  pidsLimit: 128,
  maxManagedContainers: 16,
  devSourceSha: 'd'.repeat(40),
  images: [{ callerName: 'be-01-blue', callerImage: IMAGE, solverImage: IMAGE }],
});

describe('parseSolverSupervisorInstallArgs', () => {
  it('is dry-run by default and requires an explicit local config', () => {
    expect(parseSolverSupervisorInstallArgs(['--config=/work/config.json'])).toEqual({
      host: 'h2puni',
      execute: false,
      config: '/work/config.json',
    });
    expect(() => parseSolverSupervisorInstallArgs([])).toThrow('--config=');
    expect(() =>
      parseSolverSupervisorInstallArgs(['--config=/work/config.json', '--host=host;reboot']),
    ).toThrow('invalid SSH host');
  });
});

describe('buildSolverSupervisorInstallPlan', () => {
  it('preflights before staging and reloads only after atomic publication', () => {
    const plan = buildSolverSupervisorInstallPlan('h2puni', '/work/config.json', SOCKET);
    expect(plan[0]?.argv).toEqual(['ssh', 'h2puni', `${SOLVER_SUPERVISOR_BUN} --version`]);
    expect(plan.filter((step) => step.argv[0] === 'scp').map((step) => step.argv[2])).toEqual([
      `h2puni:${SOLVER_SUPERVISOR_BUNDLE.remote}.tmp`,
      `h2puni:${SOLVER_SUPERVISOR_CONFIG}.tmp`,
      `h2puni:${SOLVER_SUPERVISOR_UNIT}.tmp`,
    ]);
    expect(plan.findIndex((step) => step.description.includes('atomically publish'))).toBeLessThan(
      plan.findIndex((step) => step.description.includes('reload the user service manager')),
    );
    expect(plan.at(-1)?.argv.join(' ')).toContain(`test -S ${SOCKET}`);
  });
});

function dependencies(
  config: string,
  seen: string[],
  bunVersion = '1.2.20\n',
): SolverSupervisorInstallerDependencies {
  return {
    read: () => Promise.resolve(new TextEncoder().encode(config)),
    exists: () => Promise.resolve(true),
    command: (argv) => {
      seen.push(argv.join(' '));
      return Promise.resolve({ code: 0, stdout: bunVersion, stderr: '' });
    },
    verify: (_host, files) => {
      seen.push(`verify ${files.map((file) => file.remote).join(' ')}`);
      return Promise.resolve();
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw new Error(`expected Error rejection, got ${String(error)}`, { cause: error });
  }
  throw new Error('expected rejection');
}

describe('installSolverSupervisor', () => {
  it('keeps every host version with recorded compatibility evidence', () => {
    expect(SOLVER_SUPERVISOR_BUN_VERSIONS).toEqual(MEASURED_BUN_VERSIONS);
  });

  it('rejects an invalid config before any remote command', async () => {
    const seen: string[] = [];
    const error = await rejectionOf(
      installSolverSupervisor(
        { host: 'h2puni', execute: true, config: '/work/config.json' },
        dependencies('{}', seen),
      ),
    );
    expect(error.message).toContain('missing key socketPath');
    expect(seen).toEqual([]);
  });

  it('rejects a different user runtime socket before any remote command', async () => {
    const seen: string[] = [];
    const config = JSON.stringify({
      ...JSON.parse(CONFIG),
      socketPath: '/run/user/1001/wbs-solver/supervisor.sock',
    });
    const error = await rejectionOf(
      installSolverSupervisor(
        { host: 'h2puni', execute: true, config: '/work/config.json' },
        dependencies(config, seen),
      ),
    );
    expect(error.message).toContain('/run/user/1000/wbs-solver/supervisor.sock');
    expect(seen).toEqual([]);
  });

  it('rejects the wrong Bun before any remote mutation', async () => {
    const seen: string[] = [];
    const error = await rejectionOf(
      installSolverSupervisor(
        { host: 'h2puni', execute: true, config: '/work/config.json' },
        dependencies(CONFIG, seen, '1.3.13\n'),
      ),
    );
    expect(error.message).toContain('requires /usr/local/bin/bun at 1.2.20, 1.4.2');
    expect(seen).toEqual([`ssh h2puni ${SOLVER_SUPERVISOR_BUN} --version`]);
  });

  // Membership alone is vacuous: without this, either entry could be dropped or
  // mistyped and no test would go red. Each listed version must reach the files
  // phase, which is the first step that touches the host.
  it.each([...MEASURED_BUN_VERSIONS])(
    'installs under measured-compatible Bun %s',
    async (version) => {
      const seen: string[] = [];
      await installSolverSupervisor(
        { host: 'h2puni', execute: true, config: '/work/config.json' },
        dependencies(CONFIG, seen, `${version}\n`),
      );
      expect(seen[0]).toBe(`ssh h2puni ${SOLVER_SUPERVISOR_BUN} --version`);
      expect(seen.some((entry) => entry.includes('install -d'))).toBe(true);
    },
  );

  it('verifies all published bytes before reloading or restarting systemd', async () => {
    const seen: string[] = [];
    await installSolverSupervisor(
      { host: 'h2puni', execute: true, config: '/work/config.json' },
      dependencies(CONFIG, seen),
    );
    const verify = seen.findIndex((entry) => entry.startsWith('verify '));
    const reload = seen.findIndex((entry) => entry.includes('daemon-reload'));
    expect(verify).toBeGreaterThan(seen.findIndex((entry) => entry.includes('chmod 0755')));
    expect(verify).toBeLessThan(reload);
    expect(seen.at(-1)).toContain(`test -S ${SOCKET}`);
  });
});
