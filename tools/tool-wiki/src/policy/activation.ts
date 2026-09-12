import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { compareCanonicalText, hashBytes, serializeCanonical } from '../evidence/content-manifest';

const Sha256 = /^[0-9a-f]{64}$/;
const GitObject = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

interface ActivationArtifact {
  readonly name: string;
  readonly identity: string;
}

interface ActivationManifest {
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly policyIdentity: string;
  readonly mappingIdentity: string;
  readonly validatorIdentity: string;
  readonly reviewReceiptIdentity: string;
  readonly artifacts: readonly ActivationArtifact[];
}

export interface PrepareActivationRequest {
  readonly candidateRepository: string;
  readonly destination: string;
  readonly artifacts: readonly string[];
  readonly sourceRevision: string;
  readonly policyIdentity: string;
  readonly mappingIdentity: string;
  readonly validatorIdentity: string;
  readonly reviewReceiptIdentity: string;
}

function existingRealPath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error(`activation destination has no existing ancestor: ${path}`);
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}

function assertExternalDestination(request: PrepareActivationRequest): string {
  const candidate = realpathSync(request.candidateRepository);
  const destination = existingRealPath(request.destination);
  const fromCandidate = relative(candidate, destination);
  // Proof: allowing this boundary made `activation preparation refuses a candidate-local package
  // destination` return a package rooted inside the candidate instead of throwing.
  if (fromCandidate === '' || (!fromCandidate.startsWith('..') && !isAbsolute(fromCandidate))) {
    throw new Error('activation package destination must be outside the candidate repository');
  }
  return destination;
}

export interface VerifiedActivation {
  readonly directory: string;
  readonly identity: string;
  readonly manifest: ActivationManifest;
}

export interface PreparedActivation extends VerifiedActivation {
  readonly request: PrepareActivationRequest;
}

function assertIdentity(identity: string, label: string): void {
  if (!Sha256.test(identity)) throw new Error(`activation ${label} is not a SHA-256 identity`);
}

function artifactSource(path: string): { name: string; path: string; identity: string } {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (cause) {
    throw new Error(`cannot read activation source artifact: ${path}`, { cause });
  }
  if (!statSync(canonical).isFile())
    throw new Error(`activation source artifact is not a file: ${path}`);
  return {
    identity: hashBytes(readFileSync(canonical)),
    name: basename(canonical),
    path: canonical,
  };
}

function activationManifest(request: PrepareActivationRequest) {
  if (!GitObject.test(request.sourceRevision))
    throw new Error('activation source revision is invalid');
  assertIdentity(request.policyIdentity, 'policy identity');
  assertIdentity(request.mappingIdentity, 'mapping identity');
  assertIdentity(request.validatorIdentity, 'validator identity');
  assertIdentity(request.reviewReceiptIdentity, 'review receipt identity');
  const sources = request.artifacts
    .map(artifactSource)
    .sort((left, right) => compareCanonicalText(left.name, right.name));
  if (sources.length === 0) throw new Error('activation package has no artifacts');
  if (new Set(sources.map(({ name }) => name)).size !== sources.length) {
    throw new Error('activation artifact names must be unique');
  }
  const manifest: ActivationManifest = {
    artifacts: sources.map(({ identity, name }) => ({ identity, name })),
    mappingIdentity: request.mappingIdentity,
    policyIdentity: request.policyIdentity,
    reviewReceiptIdentity: request.reviewReceiptIdentity,
    schemaVersion: 1,
    sourceRevision: request.sourceRevision,
    validatorIdentity: request.validatorIdentity,
  };
  return { bytes: serializeCanonical(manifest), manifest, sources };
}

/** Copies a reviewed closure into a compare-and-create immutable version directory. */
export function prepareActivation(request: PrepareActivationRequest): PreparedActivation {
  const prepared = activationManifest(request);
  const destination = assertExternalDestination(request);
  try {
    mkdirSync(destination, { recursive: false, mode: 0o755 });
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !('code' in cause) ||
      Reflect.get(cause, 'code') !== 'EEXIST'
    ) {
      throw cause;
    }
    let existing: VerifiedActivation;
    try {
      existing = verifyActivation(destination);
    } catch (verificationCause) {
      throw new Error('activation package already exists but is not valid', {
        cause: verificationCause,
      });
    }
    if (readFileSync(join(destination, 'manifest.json'), 'utf8') !== prepared.bytes) {
      throw new Error('activation package already exists with different bytes', { cause });
    }
    return { ...existing, request };
  }
  try {
    for (const source of prepared.sources) {
      copyFileSync(source.path, join(destination, source.name), constants.COPYFILE_EXCL);
    }
    writeFileSync(join(destination, 'manifest.json'), prepared.bytes, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o444,
    });
  } catch (cause) {
    throw new Error(`cannot prepare immutable activation package: ${destination}`, { cause });
  }
  return {
    directory: realpathSync(destination),
    identity: hashBytes(prepared.bytes),
    manifest: prepared.manifest,
    request,
  };
}

function decodeManifest(bytes: string): ActivationManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes) as unknown;
  } catch (cause) {
    throw new Error('activation manifest is malformed JSON', { cause });
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('activation manifest must be an object');
  }
  if (serializeCanonical(manifest) !== bytes)
    throw new Error('activation manifest is not canonical');
  if (
    Reflect.get(manifest, 'schemaVersion') !== 1 ||
    !Array.isArray(Reflect.get(manifest, 'artifacts'))
  ) {
    throw new Error('unsupported activation manifest');
  }
  const record = manifest as ActivationManifest;
  if (!GitObject.test(record.sourceRevision))
    throw new Error('activation source revision is invalid');
  for (const identity of [
    record.policyIdentity,
    record.mappingIdentity,
    record.validatorIdentity,
    record.reviewReceiptIdentity,
  ])
    assertIdentity(identity, 'manifest identity');
  return record;
}

/** Recomputes every artifact digest before the activation can be selected or executed. */
export function verifyActivation(directory: string): VerifiedActivation {
  const canonical = realpathSync(directory);
  let bytes: string;
  try {
    bytes = readFileSync(join(canonical, 'manifest.json'), 'utf8');
  } catch (cause) {
    throw new Error('cannot read activation manifest', { cause });
  }
  const manifest = decodeManifest(bytes);
  for (const artifact of manifest.artifacts) {
    if (basename(artifact.name) !== artifact.name || artifact.name === 'manifest.json') {
      throw new Error(`invalid activation artifact name: ${artifact.name}`);
    }
    assertIdentity(artifact.identity, `artifact ${artifact.name}`);
    let actual: string;
    try {
      const path = realpathSync(join(canonical, artifact.name));
      if (dirname(path) !== canonical || !statSync(path).isFile()) {
        throw new Error('artifact escapes activation directory');
      }
      actual = hashBytes(readFileSync(path));
    } catch (cause) {
      throw new Error(`cannot read activation artifact: ${artifact.name}`, { cause });
    }
    // Proof: changing validator.ts after preparation made `a malformed successor cannot replace
    // the prior selected activation` fail on `Expected function to throw`; selection now stops
    // before replacing the prior descriptor.
    if (actual !== artifact.identity)
      throw new Error(`activation artifact digest mismatch: ${artifact.name}`);
  }
  return { directory: canonical, identity: hashBytes(bytes), manifest };
}

/** Atomically replaces only the small operator-controlled selection descriptor after verification. */
export function selectActivation(root: string, directory: string): VerifiedActivation {
  const activation = verifyActivation(directory);
  const canonicalRoot = realpathSync(root);
  const descriptor = serializeCanonical({
    directory: activation.directory,
    identity: activation.identity,
    schemaVersion: 1,
  });
  const selectedPath = join(canonicalRoot, 'selected.json');
  try {
    if (readFileSync(selectedPath, 'utf8') === descriptor) return activation;
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !('code' in cause) ||
      Reflect.get(cause, 'code') !== 'ENOENT'
    ) {
      throw cause;
    }
  }
  const pendingPath = join(canonicalRoot, `.selected-${String(process.pid)}.pending`);
  writeFileSync(pendingPath, descriptor, { encoding: 'utf8', mode: 0o444 });
  renameSync(pendingPath, selectedPath);
  return activation;
}
