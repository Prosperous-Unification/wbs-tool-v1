import { decodeSolverSupervisorConfig } from './lib/solver-supervisor-config';
import { SOLVER_SUPERVISOR_SOCKET } from './lib/solver-supervisor-install-contract';

const OPTION = /^--([^=]+)(?:=(.*))?$/;

export interface SolverSupervisorConfigArgs {
  blueImage: string;
  greenImage: string;
  devSolverImage: string;
  devSourceSha: string;
  output: string;
  replace: boolean;
}

export interface SolverSupervisorConfigDependencies {
  exists(path: string): Promise<boolean>;
  write(path: string, contents: string): Promise<void>;
}

const DEFAULT_DEPENDENCIES: SolverSupervisorConfigDependencies = {
  exists: (path) => Bun.file(path).exists(),
  write: async (path, contents) => {
    await Bun.write(path, contents);
  },
};

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value === '') throw new Error(`--${name}= is required`);
  return value;
}

/** Parses only explicit image identities; ambient release state is never guessed. */
export function parseSolverSupervisorConfigArgs(
  argv: readonly string[],
): SolverSupervisorConfigArgs {
  const options = new Map<string, string>();
  let replace = false;
  for (const raw of argv) {
    const match = OPTION.exec(raw);
    if (match === null) throw new Error(`unexpected argument ${raw}`);
    const name = match[1];
    const value = (match[2] as string | undefined) ?? '';
    if (name === 'replace' && value === '') {
      if (replace) throw new Error('duplicate --replace');
      replace = true;
      continue;
    }
    if (
      !['blue-image', 'green-image', 'dev-solver-image', 'dev-source-sha', 'output'].includes(name)
    ) {
      throw new Error(`unexpected argument ${raw}`);
    }
    if (options.has(name)) throw new Error(`duplicate --${name}`);
    options.set(name, value);
  }
  const output = required(options, 'output');
  if (output.length > 4096 || output.includes('\0')) {
    throw new Error('--output= must be a bounded local path');
  }
  return {
    blueImage: required(options, 'blue-image'),
    greenImage: required(options, 'green-image'),
    devSolverImage: required(options, 'dev-solver-image'),
    devSourceSha: required(options, 'dev-source-sha'),
    output,
    replace,
  };
}

/** Renders the complete host authority document and re-decodes it before use. */
export function renderSolverSupervisorConfig(
  images: Pick<
    SolverSupervisorConfigArgs,
    'blueImage' | 'greenImage' | 'devSolverImage' | 'devSourceSha'
  >,
): string {
  const config = {
    socketPath: SOLVER_SUPERVISOR_SOCKET,
    maxSearchWorkers: 2,
    maxMemoryLimitMb: 512,
    pidsLimit: 128,
    maxManagedContainers: 16,
    devSourceSha: images.devSourceSha,
    images: [
      {
        callerName: 'be-01-blue',
        callerImage: images.blueImage,
        solverImage: images.blueImage,
      },
      {
        callerName: 'be-01-green',
        callerImage: images.greenImage,
        solverImage: images.greenImage,
      },
      {
        callerName: 'wbs-dev-src',
        callerImage: null,
        solverImage: images.devSolverImage,
      },
    ],
  };
  // Proof: materialize-solver-supervisor-config.test.ts supplies a tag-only
  // dev image and observes refusal before any output is written.
  decodeSolverSupervisorConfig(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Writes one validated local input for the dry-run-default host installer. */
export async function materializeSolverSupervisorConfig(
  args: SolverSupervisorConfigArgs,
  dependencies: SolverSupervisorConfigDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const contents = renderSolverSupervisorConfig(args);
  if (!args.replace && (await dependencies.exists(args.output))) {
    throw new Error(`${args.output} already exists; pass --replace to overwrite it`);
  }
  await dependencies.write(args.output, contents);
  return contents;
}

async function main(): Promise<void> {
  const args = parseSolverSupervisorConfigArgs(process.argv.slice(2));
  await materializeSolverSupervisorConfig(args);
  console.log(`[tool-remote-scripts] wrote validated solver supervisor config to ${args.output}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      '[tool-remote-scripts] solver supervisor config failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
