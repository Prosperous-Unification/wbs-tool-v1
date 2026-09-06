import { decodeSolverSupervisorConfig } from './lib/solver-supervisor-config';
import {
  type SolverSupervisorRuntimeOptions,
  startSolverSupervisor,
} from './lib/solver-supervisor-runtime';

export const SUPERVISOR_CONFIG_MAX_BYTES = 256 * 1024;

export interface SolverSupervisorEntrypointDependencies {
  read(path: string): Promise<Uint8Array>;
  start(options: SolverSupervisorRuntimeOptions): Promise<unknown>;
  connectionError(error: Error): void;
}

function defect(message: string): Error {
  return new Error(`solver supervisor: ${message}`);
}

export function parseSolverSupervisorArgs(argv: readonly string[]): string {
  if (argv.length !== 1 || !argv[0]?.startsWith('--config=')) {
    throw defect('expected exactly --config=/absolute/path');
  }
  const path = argv[0].slice('--config='.length);
  if (!path.startsWith('/') || path.length > 4096 || path.includes('\0')) {
    throw defect('config path must be a bounded absolute path');
  }
  return path;
}

export function decodeSolverSupervisorConfigBytes(
  bytes: Uint8Array,
  now?: () => number,
): SolverSupervisorRuntimeOptions {
  if (bytes.byteLength === 0 || bytes.byteLength > SUPERVISOR_CONFIG_MAX_BYTES) {
    throw defect(`config must contain 1 through ${String(SUPERVISOR_CONFIG_MAX_BYTES)} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw defect('config is not valid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw defect('config is not valid JSON');
  }
  return decodeSolverSupervisorConfig(value, now);
}

async function readConfig(path: string): Promise<Uint8Array> {
  const bytes = await Bun.file(path)
    .slice(0, SUPERVISOR_CONFIG_MAX_BYTES + 1)
    .arrayBuffer();
  return new Uint8Array(bytes);
}

const DEFAULT_DEPENDENCIES: SolverSupervisorEntrypointDependencies = {
  read: readConfig,
  start: (options) => startSolverSupervisor(options),
  connectionError: (error) => {
    console.error(`[wbs-solver-supervisor] connection refused: ${error.message}`);
  },
};

/** Reads one bounded host-owned document, validates it completely, then listens. */
export async function runSolverSupervisor(
  argv: readonly string[],
  dependencies: SolverSupervisorEntrypointDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const path = parseSolverSupervisorArgs(argv);
  const options = decodeSolverSupervisorConfigBytes(await dependencies.read(path));
  await dependencies.start({
    ...options,
    connection: {
      ...options.connection,
      onConnectionError: (error) => {
        dependencies.connectionError(error);
      },
    },
  });
}

if (import.meta.main) {
  runSolverSupervisor(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.error(`[wbs-solver-supervisor] startup failed: ${message}`);
    process.exit(1);
  });
}
