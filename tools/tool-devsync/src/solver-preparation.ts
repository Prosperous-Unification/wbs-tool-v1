import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const SOLVER_COMPATIBILITY_PATHS = ['libs/solver-py', 'apps/be-01/Dockerfile'] as const;

const LIVE_SOURCE_ROOT = '/home/puni1/wbs-dev/src';
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const COMPATIBILITY_IDENTITY = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const STATE_MAX_BYTES = 64 * 1024;
const STATE_KEYS = [
  'schemaVersion',
  'compatibilityIdentity',
  'sourceSha',
  'image',
  'phase',
] as const;

export interface SolverCompatibilityReader {
  objectIdAt(sourceSha: string, path: string): Promise<string>;
}

/** Identifies only the target tree entries that require a new solver image. */
export async function solverCompatibilityIdentityAt(
  sourceSha: string,
  reader: SolverCompatibilityReader,
): Promise<string> {
  if (!COMMIT_SHA.test(sourceSha)) throw new Error(`invalid target source SHA ${sourceSha}`);
  const digest = createHash('sha256');
  for (const path of SOLVER_COMPATIBILITY_PATHS) {
    const objectId = (await reader.objectIdAt(sourceSha, path)).trim();
    if (!GIT_OBJECT_ID.test(objectId)) {
      throw new Error(`invalid git object id for ${sourceSha}:${path}`);
    }
    digest.update(path);
    digest.update('\0');
    digest.update(objectId);
    digest.update('\n');
  }
  return digest.digest('hex');
}

export interface SolverPreparationState {
  schemaVersion: 1;
  compatibilityIdentity: string;
  sourceSha: string;
  image: string;
  phase: 'published' | 'complete';
}

function stateDefect(message: string): Error {
  return new Error(`solver preparation state ${message}`);
}

/** Decodes the complete durable publish/install checkpoint before any host mutation. */
export function decodeSolverPreparationState(
  bytes: Uint8Array | undefined,
): SolverPreparationState {
  if (bytes === undefined) throw stateDefect('is missing');
  if (bytes.byteLength === 0 || bytes.byteLength > STATE_MAX_BYTES) {
    throw stateDefect(`must contain 1 through ${String(STATE_MAX_BYTES)} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw stateDefect(`is not valid UTF-8 JSON: ${String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw stateDefect('root is not an object');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => !STATE_KEYS.includes(key as (typeof STATE_KEYS)[number]),
  );
  if (unknown.length > 0) throw stateDefect(`has unknown fields: ${unknown.join(', ')}`);
  if (record['schemaVersion'] !== 1) throw stateDefect('schemaVersion must be 1');
  const compatibilityIdentity = record['compatibilityIdentity'];
  if (
    typeof compatibilityIdentity !== 'string' ||
    !COMPATIBILITY_IDENTITY.test(compatibilityIdentity)
  ) {
    throw stateDefect('compatibilityIdentity must be 64 lowercase hex characters');
  }
  const sourceSha = record['sourceSha'];
  if (typeof sourceSha !== 'string' || !COMMIT_SHA.test(sourceSha)) {
    throw stateDefect('sourceSha must be a full lowercase commit SHA');
  }
  const image = record['image'];
  if (typeof image !== 'string' || !DIGEST_PINNED_IMAGE.test(image)) {
    throw stateDefect('image must be a digest-pinned registry reference');
  }
  const phase = record['phase'];
  if (phase !== 'published' && phase !== 'complete') {
    throw stateDefect('phase must be published or complete');
  }
  return { schemaVersion: 1, compatibilityIdentity, sourceSha, image, phase };
}

export interface SolverPreparationTarget {
  root: string;
  modulePath: string;
  sourceSha: string;
  compatibilityIdentity: string;
  statePath: string;
}

export interface SolverPreparationInvocation {
  cwd: string;
  argv: readonly string[];
}

export interface SolverPreparationRunnerDependencies {
  bunPath: string;
  command(invocation: SolverPreparationInvocation): Promise<{ exitCode: number; stderr: string }>;
}

export interface SolverBindingTarget {
  sourceSha: string;
  compatibilityIdentity: string;
}

export interface SolverBinding extends SolverBindingTarget {
  image: string;
}

export interface SolverBindingPipelineDependencies {
  publish(target: SolverBindingTarget): Promise<string>;
  materialize(binding: SolverBinding): Promise<void>;
  install(binding: SolverBinding): Promise<void>;
  preflight(binding: SolverBinding): Promise<void>;
  reset(sourceSha: string): Promise<void>;
}

export interface SolverBindingResumeDependencies extends SolverBindingPipelineDependencies {
  checkpoint(state: SolverPreparationState): Promise<void>;
  withHostMutationLock(action: () => Promise<void>): Promise<void>;
}

export interface SolverBindingExclusionLease {
  release(): Promise<void>;
}

export interface SolverBindingExclusion {
  tryAcquire(): Promise<SolverBindingExclusionLease | undefined>;
}

/** Completes every host-owned binding phase before the live checkout can move. */
export async function prepareSolverBindingBeforeReset(
  target: SolverBindingTarget,
  dependencies: SolverBindingPipelineDependencies,
): Promise<void> {
  if (!COMMIT_SHA.test(target.sourceSha)) throw new Error('solver binding target SHA is invalid');
  if (!COMPATIBILITY_IDENTITY.test(target.compatibilityIdentity)) {
    throw new Error('solver binding target compatibility identity is invalid');
  }
  const image = await dependencies.publish(target);
  if (!DIGEST_PINNED_IMAGE.test(image)) {
    throw new Error('solver binding publish result must be digest-pinned');
  }
  const binding: SolverBinding = { ...target, image };
  await dependencies.materialize(binding);
  await dependencies.install(binding);
  await dependencies.preflight(binding);
  // Proof: solver-preparation.test.ts makes each preceding phase throw and
  // observes that the injected reset ledger remains empty in every case.
  await dependencies.reset(target.sourceSha);
}

async function installSolverBinding(
  binding: SolverBinding,
  dependencies: SolverBindingResumeDependencies,
): Promise<void> {
  await dependencies.withHostMutationLock(async () => {
    await dependencies.materialize(binding);
    await dependencies.install(binding);
    await dependencies.preflight(binding);
  });
}

/** Resumes one compatibility identity's immutable image and checkpoints host activation last. */
export async function resumeSolverBindingBeforeReset(
  target: SolverBindingTarget,
  stateBytes: Uint8Array | undefined,
  dependencies: SolverBindingResumeDependencies,
): Promise<void> {
  if (!COMMIT_SHA.test(target.sourceSha)) throw new Error('solver binding target SHA is invalid');
  if (!COMPATIBILITY_IDENTITY.test(target.compatibilityIdentity)) {
    throw new Error('solver binding target compatibility identity is invalid');
  }

  let state: SolverPreparationState;
  if (stateBytes === undefined) {
    const image = await dependencies.publish(target);
    if (!DIGEST_PINNED_IMAGE.test(image)) {
      throw new Error('solver binding publish result must be digest-pinned');
    }
    state = { schemaVersion: 1, ...target, image, phase: 'published' };
    await dependencies.checkpoint(state);
  } else {
    state = decodeSolverPreparationState(stateBytes);
    if (state.compatibilityIdentity !== target.compatibilityIdentity) {
      throw new Error('solver preparation state compatibility identity does not match target');
    }
  }

  const binding: SolverBinding = { ...target, image: state.image };
  const successorCommit = state.sourceSha !== target.sourceSha;
  if (state.phase === 'published' || successorCommit) {
    if (successorCommit) {
      // The image belongs to the compatibility tree, not to an unrelated
      // successor commit. Rebind before host mutation so interruption resumes.
      await dependencies.checkpoint({ schemaVersion: 1, ...binding, phase: 'published' });
    }
    await installSolverBinding(binding, dependencies);
    // Proof: solver-preparation.test.ts interrupts install, observes only the
    // published checkpoint, then retries without another publish.
    await dependencies.checkpoint({ schemaVersion: 1, ...binding, phase: 'complete' });
  } else {
    try {
      // A prior transition does not prove current shared config or readiness.
      await dependencies.preflight(binding);
    } catch {
      await installSolverBinding(binding, dependencies);
    }
  }
  await dependencies.reset(target.sourceSha);
}

/** Rejects contention before target-specific work and holds one lease through reset. */
export async function prepareSolverBindingUnderExclusion(
  target: SolverBindingTarget,
  exclusion: SolverBindingExclusion,
  dependencies: SolverBindingPipelineDependencies,
): Promise<void> {
  const lease = await exclusion.tryAcquire();
  if (lease === undefined) {
    throw new Error('solver binding exclusion is already held');
  }
  try {
    // Proof: solver-preparation.test.ts overlaps two different targets while
    // the first publish is blocked; the second target reaches no phase, and
    // the first holds the same lease through its reset.
    await prepareSolverBindingBeforeReset(target, dependencies);
  } finally {
    await lease.release();
  }
}

function assertTargetPath(target: SolverPreparationTarget): void {
  if (!isAbsolute(target.root) || resolve(target.root) !== target.root) {
    throw new Error('solver preparation target root must be an absolute normalized path');
  }
  if (target.root === LIVE_SOURCE_ROOT) {
    throw new Error('solver preparation refuses code from the old live checkout');
  }
  if (!isAbsolute(target.modulePath)) {
    throw new Error('solver preparation target module must be an absolute path');
  }
  const moduleWithinRoot = relative(target.root, target.modulePath);
  if (
    moduleWithinRoot === '' ||
    moduleWithinRoot === '..' ||
    moduleWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(moduleWithinRoot)
  ) {
    throw new Error('solver preparation target module must live inside the target checkout');
  }
  if (!isAbsolute(target.statePath)) {
    throw new Error('solver preparation state path must be absolute');
  }
}

/** Runs only target-owned code after the durable digest/source pair is validated. */
export async function runTargetPinnedSolverPreparation(
  target: SolverPreparationTarget,
  stateBytes: Uint8Array | undefined,
  dependencies: SolverPreparationRunnerDependencies,
): Promise<void> {
  assertTargetPath(target);
  if (!COMMIT_SHA.test(target.sourceSha))
    throw new Error('solver preparation target SHA is invalid');
  if (!COMPATIBILITY_IDENTITY.test(target.compatibilityIdentity)) {
    throw new Error('solver preparation target compatibility identity is invalid');
  }
  const state = decodeSolverPreparationState(stateBytes);
  if (state.sourceSha !== target.sourceSha) {
    throw new Error('solver preparation state source SHA does not match target');
  }
  if (state.compatibilityIdentity !== target.compatibilityIdentity) {
    throw new Error('solver preparation state compatibility identity does not match target');
  }
  if (!isAbsolute(dependencies.bunPath)) {
    throw new Error('solver preparation Bun path must be absolute');
  }
  // Proof: solver-preparation.test.ts points this at the live checkout and
  // supplies missing, partial, and mismatched state; command remains untouched.
  const invocation: SolverPreparationInvocation = {
    cwd: target.root,
    argv: [
      dependencies.bunPath,
      target.modulePath,
      `--source-sha=${target.sourceSha}`,
      `--compatibility-identity=${target.compatibilityIdentity}`,
      `--state=${target.statePath}`,
    ],
  };
  const output = await dependencies.command(invocation);
  if (output.exitCode !== 0) {
    throw new Error(
      `target solver preparation failed (exit ${String(output.exitCode)}): ${output.stderr.trim()}`,
    );
  }
}
