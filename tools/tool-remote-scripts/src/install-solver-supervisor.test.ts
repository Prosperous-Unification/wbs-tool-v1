import { describe, expect, it } from 'bun:test';

import {
  buildSolverSupervisorInstallPlan,
  installSolverSupervisor,
  parseSolverSupervisorInstallArgs,
  type SolverSupervisorInstallerDependencies,
} from './install-solver-supervisor';
import {
  SOLVER_SUPERVISOR_BUN,
  SOLVER_SUPERVISOR_BUN_SOURCE,
  SOLVER_SUPERVISOR_BUN_VERSIONS,
  SOLVER_SUPERVISOR_BUNDLE,
  SOLVER_SUPERVISOR_CONFIG,
  SOLVER_SUPERVISOR_UNIT,
} from './lib/solver-supervisor-install-contract';

const IMAGE = `registry.example/wbs-be@sha256:${'a'.repeat(64)}`;
const SOCKET = '/run/user/1000/wbs-solver/supervisor.sock';
const MEASURED_BUN_VERSIONS = ['1.4.2'] as const;
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
    expect(plan[0]?.argv).toEqual([SOLVER_SUPERVISOR_BUN_SOURCE, '--version']);
    expect(plan.filter((step) => step.argv[0] === 'scp').map((step) => step.argv[2])).toEqual([
      `h2puni:${SOLVER_SUPERVISOR_BUN}.tmp`,
      `h2puni:${SOLVER_SUPERVISOR_BUNDLE.remote}.tmp`,
      `h2puni:${SOLVER_SUPERVISOR_CONFIG}.tmp`,
      `h2puni:${SOLVER_SUPERVISOR_UNIT}.tmp`,
    ]);
    expect(plan.findIndex((step) => step.description.includes('atomically publish'))).toBeLessThan(
      plan.findIndex((step) => step.description.includes('reload the user service manager')),
    );
    const publish = plan.find((step) => step.description.includes('atomically publish'));
    const bunMove = `mv ${SOLVER_SUPERVISOR_BUN}.tmp ${SOLVER_SUPERVISOR_BUN}`;
    const unitMove = `mv ${SOLVER_SUPERVISOR_UNIT}.tmp ${SOLVER_SUPERVISOR_UNIT}`;
    expect(publish?.argv.at(-1)).toContain(bunMove);
    expect(publish?.argv.at(-1)?.indexOf(bunMove)).toBeLessThan(
      publish?.argv.at(-1)?.indexOf(unitMove) ?? -1,
    );
    expect(plan.at(-1)?.argv.join(' ')).toContain(`test -S ${SOCKET}`);
  });
});

function dependencies(
  config: string,
  seen: string[],
  bunVersion = '1.4.2\n',
  stagedBunVersion = bunVersion,
): SolverSupervisorInstallerDependencies {
  return {
    read: () => Promise.resolve(new TextEncoder().encode(config)),
    exists: () => Promise.resolve(true),
    command: (argv) => {
      const command = argv.join(' ');
      seen.push(command);
      const stdout =
        command === `ssh h2puni ${SOLVER_SUPERVISOR_BUN}.tmp --version`
          ? stagedBunVersion
          : bunVersion;
      return Promise.resolve({ code: 0, stdout, stderr: '' });
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
    expect(error.message).toContain(`requires ${SOLVER_SUPERVISOR_BUN_SOURCE} at 1.4.2`);
    expect(seen).toEqual([`${SOLVER_SUPERVISOR_BUN_SOURCE} --version`]);
  });

  it('rejects Bun 1.2.20, whose shipped listener exposes no accepted socket fd', async () => {
    const seen: string[] = [];
    const error = await rejectionOf(
      installSolverSupervisor(
        { host: 'h2puni', execute: true, config: '/work/config.json' },
        dependencies(CONFIG, seen, '1.2.20\n'),
      ),
    );
    expect(error.message).toContain('got 1.2.20');
    expect(seen).toEqual([`${SOLVER_SUPERVISOR_BUN_SOURCE} --version`]);
  });

  it('rejects a staged runtime changed after preflight before publication', async () => {
    const seen: string[] = [];
    const error = await rejectionOf(
      installSolverSupervisor(
        { host: 'h2puni', execute: true, config: '/work/config.json' },
        dependencies(CONFIG, seen, '1.4.2\n', '1.2.20\n'),
      ),
    );
    expect(error.message).toContain('got 1.2.20');
    expect(seen).toContain(`ssh h2puni ${SOLVER_SUPERVISOR_BUN}.tmp --version`);
    expect(seen.some((entry) => entry.includes(`mv ${SOLVER_SUPERVISOR_BUN}.tmp`))).toBe(false);
    expect(seen.some((entry) => entry.includes('systemctl'))).toBe(false);
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
      expect(seen[0]).toBe(`${SOLVER_SUPERVISOR_BUN_SOURCE} --version`);
      expect(seen.some((entry) => entry.includes('install -d'))).toBe(true);
      expect(seen).toContain(
        `scp ${SOLVER_SUPERVISOR_BUN_SOURCE} h2puni:${SOLVER_SUPERVISOR_BUN}.tmp`,
      );
      expect(seen).toContain(`ssh h2puni ${SOLVER_SUPERVISOR_BUN}.tmp --version`);
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
    expect(seen[verify]).toContain(SOLVER_SUPERVISOR_BUN);
    expect(seen.at(-1)).toContain(`test -S ${SOCKET}`);
  });
});
