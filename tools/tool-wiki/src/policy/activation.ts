import {
  chmodSync,
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
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseOrThrow, type } from '@wbs/validation';

import { compareCanonicalText, hashBytes, serializeCanonical } from '../evidence/content-manifest';

const Sha256 = /^[0-9a-f]{64}$/;
const GitObject = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const roles = [
  'authority',
  'ciBinding',
  'evidence',
  'launcher',
  'localBinding',
  'mapping',
  'policy',
  'reviewReceipt',
  'snapshotter',
  'validator',
] as const;
type ActivationRole = (typeof roles)[number];
const rolePaths: Record<ActivationRole, string> = {
  authority: 'artifacts/authority.json',
  ciBinding: 'artifacts/ci-binding.json',
  evidence: 'artifacts/evidence.json',
  launcher: 'artifacts/launcher.sh',
  localBinding: 'artifacts/local-binding.json',
  mapping: 'artifacts/mapping.json',
  policy: 'artifacts/policy.json',
  reviewReceipt: 'artifacts/review-receipt.json',
  snapshotter: 'artifacts/snapshotter.ts',
  validator: 'artifacts/validator.mjs',
};
const descriptors: Partial<Record<ActivationRole, string>> = {
  ciBinding: 'ci-binding-path',
  evidence: 'evidence-path',
  launcher: 'launcher-path',
  localBinding: 'local-binding-path',
  snapshotter: 'snapshotter-path',
  validator: 'validator-path',
};

const Sha256Identity = type(Sha256);
const ArtifactRecord = type({
  identity: Sha256Identity,
  path: 'string>=1',
  role: "'authority'|'ciBinding'|'evidence'|'launcher'|'localBinding'|'mapping'|'policy'|'reviewReceipt'|'snapshotter'|'validator'",
}).onUndeclaredKey('reject');
const RolesRecord = type({
  authority: 'string>=1',
  ciBinding: 'string>=1',
  evidence: 'string>=1',
  launcher: 'string>=1',
  localBinding: 'string>=1',
  mapping: 'string>=1',
  policy: 'string>=1',
  reviewReceipt: 'string>=1',
  snapshotter: 'string>=1',
  validator: 'string>=1',
}).onUndeclaredKey('reject');
const ManifestRecord = type({
  schemaVersion: '3',
  sourceRevision: /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/,
  policyIdentity: Sha256Identity,
  mappingIdentity: Sha256Identity,
  validatorIdentity: Sha256Identity,
  reviewReceiptIdentity: Sha256Identity,
  roles: RolesRecord,
  artifacts: ArtifactRecord.array(),
}).onUndeclaredKey('reject');
const BindingArtifactReference = type({ path: 'string>=1', sha256: Sha256Identity });
const BindingClosureRecord = type({
  policy: BindingArtifactReference,
  authority: type({ artifact: BindingArtifactReference }),
  validator: type({ artifacts: BindingArtifactReference.array() }),
  'pilotModuleMapping?': type({ artifact: BindingArtifactReference }),
});

export type ActivationManifest = typeof ManifestRecord.infer;

export interface PrepareActivationRequest {
  readonly candidateRepository: string;
  readonly destination: string;
  readonly roleSources: Readonly<Record<ActivationRole, string>>;
  readonly sourceRevision: string;
  readonly policyIdentity: string;
  readonly mappingIdentity: string;
  readonly validatorIdentity: string;
  readonly reviewReceiptIdentity: string;
}

export interface VerifiedActivation {
  readonly directory: string;
  readonly identity: string;
  readonly manifest: ActivationManifest;
}

export interface PreparedActivation extends VerifiedActivation {
  readonly request: PrepareActivationRequest;
}

function existingRealPath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error(`activation destination has no existing ancestor: ${path}`);
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}

function assertExternalDestination(request: PrepareActivationRequest): string {
  const candidate = realpathSync(request.candidateRepository);
  const destination = existingRealPath(request.destination);
  const fromCandidate = relative(candidate, destination);
  const isParent = fromCandidate === '..' || fromCandidate.startsWith(`..${sep}`);
  // Proof: preparing at candidate/..inside returned a complete candidate-owned package until the
  // containment check distinguished the `..` parent segment from an ordinary child prefix.
  if (fromCandidate === '' || (!isParent && !isAbsolute(fromCandidate))) {
    throw new Error('activation package destination must be outside the candidate repository');
  }
  return destination;
}

function source(
  role: ActivationRole,
  path: string,
): { identity: string; path: string; role: ActivationRole } {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (cause) {
    throw new Error(`cannot read activation ${role} artifact: ${path}`, { cause });
  }
  if (!statSync(canonical).isFile())
    throw new Error(`activation ${role} artifact is not a file: ${path}`);
  return { identity: hashBytes(readFileSync(canonical)), path: canonical, role };
}

function assertStandaloneValidator(path: string): void {
  const imports = new Bun.Transpiler({ loader: path.endsWith('.ts') ? 'ts' : 'js' }).scanImports(
    readFileSync(path, 'utf8'),
  );
  const dependency = imports.find(
    ({ path: specifier }) =>
      !specifier.startsWith('node:') &&
      !specifier.startsWith('bun:') &&
      !builtinModules.includes(specifier),
  );
  // Proof: a lone validator source with an undeclared relative dependency was accepted as a
  // complete activation until the package required a standalone reviewed validator bundle.
  if (dependency !== undefined)
    throw new Error(`activation validator is not standalone: ${dependency.path}`);
}

function packageReference(from: ActivationRole, to: ActivationRole): string {
  return relative(dirname(rolePaths[from]), rolePaths[to]).split(sep).join('/');
}

function assertBindingClosure(
  role: 'ciBinding' | 'localBinding',
  bytes: Uint8Array,
  identities: ReadonlyMap<ActivationRole, string>,
): void {
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error(`activation ${role} is malformed JSON`, { cause });
  }
  const binding = parseOrThrow(BindingClosureRecord, input);
  const expected = (target: ActivationRole) => {
    const identity = identities.get(target);
    if (identity === undefined) throw new Error(`activation ${target} role is omitted`);
    return { path: packageReference(role, target), sha256: identity };
  };
  for (const [target, reference] of [
    ['policy', binding.policy],
    ['authority', binding.authority.artifact],
  ] as const) {
    if (serializeCanonical(reference) !== serializeCanonical(expected(target))) {
      // Proof: removing each tuple let its `unlisted-policy.json` or `unlisted-authority.json`
      // preparation return a complete package (`Received function did not throw`).
      throw new Error(
        `activation ${role} ${target} reference differs from authenticated ${target} role`,
      );
    }
  }
  const validator = expected('validator');
  // Proof: removing this comparison let `unlisted-validator.mjs` preparation return a complete
  // package (`Received function did not throw`).
  if (
    binding.validator.artifacts.length !== 1 ||
    serializeCanonical(binding.validator.artifacts[0]) !== serializeCanonical(validator)
  )
    throw new Error(
      `activation ${role} validator references differ from authenticated validator role`,
    );
  // Proof: removing this comparison let `unlisted-mapping.json` preparation return a complete
  // package (`Received function did not throw`).
  if (
    binding.pilotModuleMapping !== undefined &&
    serializeCanonical(binding.pilotModuleMapping.artifact) !==
      serializeCanonical(expected('mapping'))
  )
    throw new Error(`activation ${role} mapping reference differs from authenticated mapping role`);
}

function preparedManifest(request: PrepareActivationRequest) {
  if (!GitObject.test(request.sourceRevision))
    throw new Error('activation source revision is invalid');
  const sources = roles.map((role) => source(role, request.roleSources[role]));
  const candidate = realpathSync(request.candidateRepository);
  for (const artifact of sources) {
    const offset = relative(candidate, artifact.path);
    const isParent = offset === '..' || offset.startsWith(`..${sep}`);
    // Proof: selecting a candidate-owned validator source returned a complete activation package
    // until every role source was checked at the same external-trust boundary as its destination.
    if (offset === '' || (!isParent && !isAbsolute(offset)))
      throw new Error(
        `activation ${artifact.role} source must be outside the candidate repository`,
      );
  }
  assertStandaloneValidator(request.roleSources.validator);
  const byRole = new Map(sources.map((artifact) => [artifact.role, artifact]));
  for (const [role, expected] of [
    ['policy', request.policyIdentity],
    ['mapping', request.mappingIdentity],
    ['validator', request.validatorIdentity],
    ['reviewReceipt', request.reviewReceiptIdentity],
  ] as const) {
    if (!Sha256.test(expected) || byRole.get(role)?.identity !== expected)
      throw new Error(`activation ${role} identity differs from its artifact`);
  }
  const identities = new Map(sources.map((artifact) => [artifact.role, artifact.identity]));
  for (const role of ['ciBinding', 'localBinding'] as const)
    assertBindingClosure(role, readFileSync(request.roleSources[role]), identities);
  const artifacts = sources
    .map(({ identity, role }) => ({ identity, path: rolePaths[role], role }))
    .sort((left, right) => compareCanonicalText(left.role, right.role));
  const manifest: ActivationManifest = {
    artifacts,
    mappingIdentity: request.mappingIdentity,
    policyIdentity: request.policyIdentity,
    reviewReceiptIdentity: request.reviewReceiptIdentity,
    roles: { ...rolePaths },
    schemaVersion: 3,
    sourceRevision: request.sourceRevision,
    validatorIdentity: request.validatorIdentity,
  };
  return { bytes: serializeCanonical(manifest), manifest, sources };
}

function writePackage(destination: string, prepared: ReturnType<typeof preparedManifest>): void {
  mkdirSync(join(destination, 'artifacts'), { recursive: false, mode: 0o755 });
  for (const artifact of prepared.sources) {
    const target = join(destination, rolePaths[artifact.role]);
    copyFileSync(artifact.path, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o444);
  }
  writeFileSync(join(destination, 'manifest.json'), prepared.bytes, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o444,
  });
  writeFileSync(join(destination, 'active-v1'), 'tool-wiki-active-v1\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o444,
  });
  for (const role of roles) {
    const descriptor = descriptors[role];
    if (descriptor !== undefined)
      writeFileSync(join(destination, descriptor), `${rolePaths[role]}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o444,
      });
  }
  writeFileSync(join(destination, 'checksums.sha256'), checksumBytes(prepared.manifest), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o444,
  });
}

function checksumBytes(manifest: ActivationManifest): string {
  const entries = manifest.artifacts.map(({ identity, path }) => ({ identity, path }));
  entries.push({ identity: hashBytes('tool-wiki-active-v1\n'), path: 'active-v1' });
  for (const role of roles) {
    const descriptor = descriptors[role];
    if (descriptor !== undefined)
      entries.push({ identity: hashBytes(`${rolePaths[role]}\n`), path: descriptor });
  }
  return `${entries
    .sort((left, right) => compareCanonicalText(left.path, right.path))
    .map(({ identity, path }) => `${identity}  ${path}`)
    .join('\n')}\n`;
}

/** Copies a reviewed, role-complete standalone activation into an immutable version directory. */
export function prepareActivation(request: PrepareActivationRequest): PreparedActivation {
  const destination = assertExternalDestination(request);
  const prepared = preparedManifest(request);
  try {
    mkdirSync(destination, { recursive: false, mode: 0o755 });
  } catch (cause) {
    if (!(cause instanceof Error) || !('code' in cause) || Reflect.get(cause, 'code') !== 'EEXIST')
      throw cause;
    const existing = verifyActivation(destination);
    if (readFileSync(join(destination, 'manifest.json'), 'utf8') !== prepared.bytes)
      throw new Error('activation package already exists with different bytes', { cause });
    return { ...existing, request };
  }
  try {
    writePackage(destination, prepared);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch (cause) {
    throw new Error('activation manifest is malformed JSON', { cause });
  }
  if (serializeCanonical(parsed) !== bytes) throw new Error('activation manifest is not canonical');
  return parseOrThrow(ManifestRecord, parsed);
}

/** Strictly decodes roles and recomputes every artifact and joined identity. */
export function verifyActivation(directory: string): VerifiedActivation {
  const canonical = realpathSync(directory);
  let bytes: string;
  try {
    bytes = readFileSync(join(canonical, 'manifest.json'), 'utf8');
  } catch (cause) {
    throw new Error('cannot read activation manifest', { cause });
  }
  const manifest = decodeManifest(bytes);
  // Proof: the canonical empty manifest with an unknown trusted field was selected successfully
  // before strict decoding and the complete role boundary replaced the unchecked cast.
  if (manifest.artifacts.length !== roles.length)
    throw new Error('activation artifact set is incomplete');
  const seenRoles = new Set<string>();
  const seenPaths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (seenRoles.has(artifact.role) || seenPaths.has(artifact.path))
      throw new Error('activation artifacts contain a duplicate role or path');
    seenRoles.add(artifact.role);
    seenPaths.add(artifact.path);
    if (
      manifest.roles[artifact.role] !== artifact.path ||
      artifact.path !== rolePaths[artifact.role]
    )
      throw new Error(`activation role path is invalid: ${artifact.role}`);
    let actual: string;
    try {
      // Proof: the real relocated-package test removed authenticated `authority.json` and added
      // the same bytes under an unlisted name; verification failed here with `cannot read
      // activation artifact: artifacts/authority.json`, and required launch refused the digest.
      const path = realpathSync(join(canonical, artifact.path));
      const offset = relative(canonical, path);
      if (
        offset === '..' ||
        offset.startsWith(`..${sep}`) ||
        isAbsolute(offset) ||
        !statSync(path).isFile()
      )
        throw new Error('artifact escapes activation directory');
      actual = hashBytes(readFileSync(path));
    } catch (cause) {
      throw new Error(`cannot read activation artifact: ${artifact.path}`, { cause });
    }
    if (actual !== artifact.identity)
      throw new Error(`activation artifact digest mismatch: ${artifact.path}`);
  }
  if (roles.some((role) => !seenRoles.has(role)))
    throw new Error('activation artifact role is omitted');
  const identities = new Map(
    manifest.artifacts.map((artifact) => [artifact.role, artifact.identity]),
  );
  if (
    identities.get('policy') !== manifest.policyIdentity ||
    identities.get('mapping') !== manifest.mappingIdentity ||
    identities.get('validator') !== manifest.validatorIdentity ||
    identities.get('reviewReceipt') !== manifest.reviewReceiptIdentity
  )
    throw new Error('activation manifest identity differs from its role artifact');
  for (const role of ['ciBinding', 'localBinding'] as const)
    assertBindingClosure(role, readFileSync(join(canonical, manifest.roles[role])), identities);
  assertStandaloneValidator(join(canonical, manifest.roles.validator));
  if (readFileSync(join(canonical, 'checksums.sha256'), 'utf8') !== checksumBytes(manifest))
    throw new Error('activation checksum manifest differs from roles');
  if (readFileSync(join(canonical, 'active-v1'), 'utf8') !== 'tool-wiki-active-v1\n')
    throw new Error('activation marker differs from its package contract');
  for (const role of roles) {
    const descriptor = descriptors[role];
    if (
      descriptor !== undefined &&
      readFileSync(join(canonical, descriptor), 'utf8') !== `${rolePaths[role]}\n`
    )
      throw new Error(`activation ${role} descriptor differs from its package contract`);
  }
  return { directory: canonical, identity: hashBytes(bytes), manifest };
}

/** Atomically selects only an independently expected verified package identity. */
export function selectActivation(
  root: string,
  directory: string,
  expectedIdentity: string,
): VerifiedActivation {
  const activation = verifyActivation(directory);
  if (activation.identity !== expectedIdentity)
    throw new Error('activation package differs from selected identity');
  const canonicalRoot = realpathSync(root);
  const selectedDirectory = relative(canonicalRoot, activation.directory);
  const isParent = selectedDirectory === '..' || selectedDirectory.startsWith(`..${sep}`);
  if (selectedDirectory === '' || isParent || isAbsolute(selectedDirectory))
    throw new Error('activation selection must name a version directory below its root');
  const descriptor = serializeCanonical({
    checksumsIdentity: hashBytes(readFileSync(join(activation.directory, 'checksums.sha256'))),
    directory: selectedDirectory,
    identity: activation.identity,
    schemaVersion: 1,
  });
  const selectedPath = join(canonicalRoot, 'selected.json');
  try {
    if (readFileSync(selectedPath, 'utf8') === descriptor) return activation;
  } catch (cause) {
    if (!(cause instanceof Error) || !('code' in cause) || Reflect.get(cause, 'code') !== 'ENOENT')
      throw cause;
  }
  const pendingPath = join(canonicalRoot, `.selected-${String(process.pid)}.pending`);
  writeFileSync(pendingPath, descriptor, { encoding: 'utf8', mode: 0o444 });
  renameSync(pendingPath, selectedPath);
  return activation;
}
