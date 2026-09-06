import { supervisorImagePolicy } from './solver-supervisor-image-map';
import type { SolverSupervisorRuntimeOptions } from './solver-supervisor-runtime';

const CONFIG_KEYS = [
  'socketPath',
  'maxSearchWorkers',
  'maxMemoryLimitMb',
  'pidsLimit',
  'maxManagedContainers',
  'devSourceSha',
  'images',
] as const;
const SOCKET_PATH = /^\/run\/user\/[1-9][0-9]*\/wbs-solver\/supervisor\.sock$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function defect(message: string): Error {
  return new Error(`solver supervisor config: ${message}`);
}

function configRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw defect('root is not an object');
  }
  const config = value as Record<string, unknown>;
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.includes(key as never));
  if (unknown.length > 0) throw defect(`unknown key ${unknown.sort()[0]}`);
  const missing = CONFIG_KEYS.filter((key) => !Object.hasOwn(config, key));
  if (missing.length > 0) throw defect(`missing key ${missing[0]}`);
  return config;
}

function boundedInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw defect(`${name} must be an integer from 1 through ${String(maximum)}`);
  }
  return value as number;
}

/** Turns the complete host file into runtime options without accepting authority knobs. */
export function decodeSolverSupervisorConfig(
  value: unknown,
  now: () => number = Date.now,
): SolverSupervisorRuntimeOptions {
  const config = configRecord(value);
  const socketPath = config['socketPath'];
  if (typeof socketPath !== 'string' || !SOCKET_PATH.test(socketPath)) {
    throw defect('socketPath must be the systemd runtime-directory supervisor socket');
  }
  const maxSearchWorkers = boundedInteger(config['maxSearchWorkers'], 'maxSearchWorkers', 2);
  const maxMemoryLimitMb = boundedInteger(config['maxMemoryLimitMb'], 'maxMemoryLimitMb', 512);
  const pidsLimit = boundedInteger(config['pidsLimit'], 'pidsLimit', 128);
  const maxManagedContainers = boundedInteger(
    config['maxManagedContainers'],
    'maxManagedContainers',
    16,
  );
  if (typeof config['devSourceSha'] !== 'string' || !COMMIT_SHA.test(config['devSourceSha'])) {
    throw defect('devSourceSha must be a full lowercase commit SHA');
  }
  const images = supervisorImagePolicy(config['images']);

  return {
    connection: {
      unix: socketPath,
      allowedNamePatterns: images.allowedNamePatterns,
      maxInputBytes: 2 * 1024 * 1024,
      bindTimeoutMs: 5_000,
      maxSearchWorkers,
      maxMemoryLimitMb,
      now,
    },
    lifecycle: {
      pidsLimit,
      maxManagedContainers,
      outputLimits: {
        maxPayloadBytes: 64 * 1024,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      },
    },
    imageFor: (identity) => images.imageFor(identity),
  };
}
