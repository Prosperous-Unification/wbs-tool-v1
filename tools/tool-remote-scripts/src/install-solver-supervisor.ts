import { verifyInstalled } from './install';
import type { BundleFile } from './lib/deploy-contract';
import {
  assertSolverSupervisorBunVersion,
  SOLVER_SUPERVISOR_BUN,
  SOLVER_SUPERVISOR_BUNDLE,
  SOLVER_SUPERVISOR_CONFIG,
  SOLVER_SUPERVISOR_SERVICE,
  SOLVER_SUPERVISOR_SOCKET,
  SOLVER_SUPERVISOR_UNIT,
  SOLVER_SUPERVISOR_UNIT_SOURCE,
} from './lib/solver-supervisor-install-contract';
import {
  decodeSolverSupervisorConfigBytes,
  SUPERVISOR_CONFIG_MAX_BYTES,
} from './solver-supervisor';

const HOST = /^[a-zA-Z0-9._-]+$/;

export interface SolverSupervisorInstallArgs {
  host: string;
  execute: boolean;
  config: string;
}

export interface SolverSupervisorInstallStep {
  phase: 'preflight' | 'files' | 'service';
  description: string;
  argv: string[];
}

interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SolverSupervisorInstallerDependencies {
  read(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  command(argv: readonly string[]): Promise<CommandOutput>;
  verify(host: string, files: readonly BundleFile[]): Promise<void>;
}

export function parseSolverSupervisorInstallArgs(
  argv: readonly string[],
): SolverSupervisorInstallArgs {
  let host = 'h2puni';
  let execute = false;
  let config = '';

  for (const raw of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (match === null) throw new Error(`unexpected argument ${raw}`);
    const key = match[1];
    const value = (match[2] as string | undefined) ?? '';
    if (key === 'host') host = value;
    else if (key === 'execute' && value === '') execute = true;
    else if (key === 'dry-run' && value === '') execute = false;
    else if (key === 'config' && value !== '') config = value;
    else throw new Error(`unexpected argument ${raw}`);
  }

  if (!HOST.test(host)) throw new Error(`invalid SSH host ${host || '(missing)'}`);
  if (config === '') throw new Error('--config=<local validated supervisor config> is required');
  return { host, execute, config };
}

export function solverSupervisorInstallFiles(config: string): readonly BundleFile[] {
  return [
    SOLVER_SUPERVISOR_BUNDLE,
    { local: config, remote: SOLVER_SUPERVISOR_CONFIG },
    { local: SOLVER_SUPERVISOR_UNIT_SOURCE, remote: SOLVER_SUPERVISOR_UNIT },
  ];
}

export function buildSolverSupervisorInstallPlan(
  host: string,
  config: string,
  socketPath: string,
): readonly SolverSupervisorInstallStep[] {
  const files = solverSupervisorInstallFiles(config);
  const temp = files.map((file) => ({ ...file, remote: `${file.remote}.tmp` }));
  const moves = files.map((file, index) => `mv ${temp[index]?.remote} ${file.remote}`).join(' && ');
  const readiness =
    `set -eu; systemctl --user is-active --quiet ${SOLVER_SUPERVISOR_SERVICE}; ` +
    'solver_probe=0; ' +
    `until test -S ${socketPath}; do ` +
    'solver_probe=$((solver_probe + 1)); ' +
    'if test "$solver_probe" -ge 40; then echo "solver supervisor socket did not become ready" >&2; exit 1; fi; ' +
    'sleep 0.25; done';

  return [
    {
      phase: 'preflight',
      description: `require ${host}:${SOLVER_SUPERVISOR_BUN} at a measured-compatible version`,
      argv: ['ssh', host, `${SOLVER_SUPERVISOR_BUN} --version`],
    },
    {
      phase: 'files',
      description: 'create the host-wide supervisor directories',
      argv: [
        'ssh',
        host,
        'install -d -m 0755 /home/puni1/.local/lib/wbs-solver /home/puni1/.config/systemd/user && install -d -m 0700 /home/puni1/.config/wbs-solver',
      ],
    },
    ...temp.map((file, index) => ({
      phase: 'files' as const,
      description: `stage ${files[index]?.local} at ${file.remote}`,
      argv: ['scp', file.local, `${host}:${file.remote}`],
    })),
    {
      phase: 'files',
      description: 'atomically publish the supervisor bundle, config, and unit',
      argv: [
        'ssh',
        host,
        `chmod 0755 ${temp[0]?.remote} && chmod 0600 ${temp[1]?.remote} && chmod 0644 ${temp[2]?.remote} && ${moves}`,
      ],
    },
    {
      phase: 'service',
      description: 'reload the user service manager',
      argv: ['ssh', host, 'systemctl --user daemon-reload'],
    },
    {
      phase: 'service',
      description: `enable ${SOLVER_SUPERVISOR_SERVICE}`,
      argv: ['ssh', host, `systemctl --user enable ${SOLVER_SUPERVISOR_SERVICE}`],
    },
    {
      phase: 'service',
      description: `restart ${SOLVER_SUPERVISOR_SERVICE}`,
      argv: ['ssh', host, `systemctl --user restart ${SOLVER_SUPERVISOR_SERVICE}`],
    },
    {
      phase: 'service',
      description: `require active service and socket ${socketPath}`,
      argv: ['ssh', host, readiness],
    },
  ];
}

async function command(argv: readonly string[]): Promise<CommandOutput> {
  const child = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

const DEFAULT_DEPENDENCIES: SolverSupervisorInstallerDependencies = {
  read: async (path) =>
    new Uint8Array(
      await Bun.file(path)
        .slice(0, SUPERVISOR_CONFIG_MAX_BYTES + 1)
        .arrayBuffer(),
    ),
  exists: (path) => Bun.file(path).exists(),
  command,
  verify: verifyInstalled,
};

async function requireCommand(
  step: SolverSupervisorInstallStep,
  dependencies: SolverSupervisorInstallerDependencies,
): Promise<CommandOutput> {
  const output = await dependencies.command(step.argv);
  if (output.code !== 0) {
    throw new Error(
      `${step.description} failed (exit ${String(output.code)}): ${output.stderr.trim()}`,
    );
  }
  return output;
}

/**
 * Validates every local input and the remote runtime before the first remote mutation.
 *
 * Proof: install-solver-supervisor.test.ts supplies an incomplete config and
 * requires the command ledger to remain empty.
 */
export async function installSolverSupervisor(
  args: SolverSupervisorInstallArgs,
  dependencies: SolverSupervisorInstallerDependencies = DEFAULT_DEPENDENCIES,
): Promise<readonly SolverSupervisorInstallStep[]> {
  const bytes = await dependencies.read(args.config);
  const options = decodeSolverSupervisorConfigBytes(bytes);
  if (options.connection.unix !== SOLVER_SUPERVISOR_SOCKET) {
    throw new Error(`solver supervisor config socket must be ${SOLVER_SUPERVISOR_SOCKET}`);
  }
  const files = solverSupervisorInstallFiles(args.config);
  for (const file of files) {
    if (!(await dependencies.exists(file.local))) {
      throw new Error(`${file.local} not found — build or create it before installing`);
    }
  }

  const plan = buildSolverSupervisorInstallPlan(args.host, args.config, options.connection.unix);
  if (!args.execute) return plan;

  const preflight = plan.find((step) => step.phase === 'preflight');
  if (preflight === undefined) throw new Error('solver supervisor install has no Bun preflight');
  // Proof: install-solver-supervisor.test.ts returns 1.3.13 and observes that
  // the preflight is the only command reached.
  assertSolverSupervisorBunVersion((await requireCommand(preflight, dependencies)).stdout);

  for (const step of plan.filter((candidate) => candidate.phase === 'files')) {
    await requireCommand(step, dependencies);
  }
  // Proof: install-solver-supervisor.test.ts requires this marker to precede
  // daemon-reload, so mismatched bytes cannot be activated.
  await dependencies.verify(args.host, files);
  for (const step of plan.filter((candidate) => candidate.phase === 'service')) {
    await requireCommand(step, dependencies);
  }
  return plan;
}

async function main(): Promise<void> {
  const args = parseSolverSupervisorInstallArgs(process.argv.slice(2));
  const plan = await installSolverSupervisor(args);
  console.log(
    `[tool-remote-scripts] solver supervisor host=${args.host} execute=${String(args.execute)}`,
  );
  for (const step of plan) console.log(`  ${step.description}`);
  if (!args.execute) {
    console.log('[tool-remote-scripts] dry-run only. re-run with --execute to install for real.');
  } else {
    console.log('[tool-remote-scripts] solver supervisor installed, verified, and ready.');
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      '[tool-remote-scripts] solver supervisor install failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
