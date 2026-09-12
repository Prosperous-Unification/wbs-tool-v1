import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { parseOrThrow, type } from '@wbs/validation';

import { OpaqueId } from '../contracts/records';
import {
  compareCanonicalText,
  hashBytes,
  hashCanonical,
  serializeCanonical,
} from '../evidence/content-manifest';
import {
  assertCheckedIntegrationCandidate,
  certifyIntegrationCandidate,
  type CheckedIntegrationCandidate,
  type IntegrationEvidence,
  type IntegrationEvidenceVerifier,
  type UncheckedIntegrationCandidate,
} from './integrate';

const Sha256 = /^[0-9a-f]{64}$/;
const GitObject = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const Term = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const Sha256Identity = type(Sha256);
const GitObjectIdentity = type(GitObject);
const IntegrationBindingActivationRecord = type({
  activationIdentity: Sha256Identity,
  policyIdentity: Sha256Identity,
  mappingIdentity: Sha256Identity,
  validatorIdentity: Sha256Identity,
  reviewReceiptIdentity: Sha256Identity,
}).onUndeclaredKey('reject');
export type IntegrationBindingActivation = typeof IntegrationBindingActivationRecord.infer;

const AdmissionProvenanceRecord = type({
  kind: "'not-applicable'",
  reason: "'pre-authority bootstrap commit'",
})
  .onUndeclaredKey('reject')
  .or(
    type({
      kind: "'integrated'",
      integrationId: OpaqueId,
      attemptIdentity: Sha256Identity,
    }).onUndeclaredKey('reject'),
  );
export type AdmissionProvenance = typeof AdmissionProvenanceRecord.infer;

const VerifiedReceiptRecord = type({
  obligationId: OpaqueId,
  receiptIdentity: Sha256Identity,
  compositionIdentity: Sha256Identity,
  journalId: OpaqueId,
  invocationId: OpaqueId,
}).onUndeclaredKey('reject');
const BoundReceiptRecord = type({
  obligationId: OpaqueId,
  receipt: 'unknown',
  verification: VerifiedReceiptRecord,
}).onUndeclaredKey('reject');
type BoundReceipt = typeof BoundReceiptRecord.infer;
const GenerationRecord = type({
  sessionId: OpaqueId,
  generation: 'number.integer>=1',
  status: "'submitted'",
  packetIdentity: Sha256Identity,
  patchIdentity: Sha256Identity,
}).onUndeclaredKey('reject');
const EvidenceValidationRecord = type({
  validationId: OpaqueId,
  validationIdentity: Sha256Identity,
}).onUndeclaredKey('reject');
const FinalIntegrationBindingRecord = type({
  schemaVersion: '1',
  bindingKind: "'bootstrap'|'integrated'",
  commit: GitObjectIdentity,
  tree: GitObjectIdentity,
  parent: GitObjectIdentity,
  markerRef: 'string>=1',
  compositionIdentity: Sha256Identity,
  candidateCompositionManifestIdentity: Sha256Identity,
  contentManifestIdentity: Sha256Identity,
  evidenceIdentity: Sha256Identity,
  evidenceValidation: EvidenceValidationRecord,
  activation: IntegrationBindingActivationRecord,
  admissionProvenance: AdmissionProvenanceRecord,
  generations: GenerationRecord.array(),
  checks: BoundReceiptRecord.array(),
  reviews: BoundReceiptRecord.array(),
}).onUndeclaredKey('reject');

export type FinalIntegrationBinding = typeof FinalIntegrationBindingRecord.infer;

export interface EmitIntegrationBindingRequest {
  readonly repository: string;
  readonly destination: string;
  readonly publication: {
    readonly commit: string;
    readonly tree: string;
    readonly markerRef: string;
  };
  readonly candidate: CheckedIntegrationCandidate;
  readonly contentManifestIdentity: string;
  readonly evidenceValidation: FinalIntegrationBinding['evidenceValidation'];
  readonly activation: IntegrationBindingActivation;
  readonly admissionProvenance: AdmissionProvenance;
}

export interface EmittedIntegrationBinding {
  readonly binding: FinalIntegrationBinding;
  readonly bytes: string;
  readonly identity: string;
  readonly request: EmitIntegrationBindingRequest;
}

function git(repository: string, argv: readonly string[], context: string): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.toString('utf8').trim();
    throw new Error(`${context}: ${detail || `git exited ${String(invocation.exitCode)}`}`);
  }
  return invocation.stdout.toString('utf8').trimEnd();
}

function assertCommit(
  repository: string,
  commit: string,
  tree: string,
  parent: string,
  markerRef: string,
): void {
  if (!GitObject.test(commit) || !GitObject.test(tree) || !GitObject.test(parent)) {
    throw new Error('integration binding contains a malformed Git identity');
  }
  const marker = git(
    repository,
    ['show-ref', '--verify', '--hash', markerRef],
    'cannot read publication marker',
  );
  // Proof: replacing the binding commit with its valid parent made
  // `trusted verification refuses forged candidate or policy identity and an omitted required check`
  // fail on `Expected function to throw`; the marker comparison now refuses it here.
  if (marker !== commit)
    throw new Error('integration binding commit differs from publication marker');
  const actualTree = git(
    repository,
    ['show', '-s', '--format=%T', commit],
    'cannot read integration commit tree',
  );
  const parents = git(
    repository,
    ['show', '-s', '--format=%P', commit],
    'cannot read integration commit parents',
  )
    .split(' ')
    .filter((identity) => identity.length > 0);
  if (actualTree !== tree || parents.length !== 1 || parents[0] !== parent) {
    throw new Error('integration binding commit differs from checked tree or sole parent');
  }
}

function assertSha256(identity: string, label: string): void {
  if (!Sha256.test(identity)) throw new Error(`${label} is not a SHA-256 identity`);
}

function assertActivation(activation: IntegrationBindingActivation): void {
  const fields = Object.keys(activation).sort(compareCanonicalText);
  const expected = [
    'activationIdentity',
    'mappingIdentity',
    'policyIdentity',
    'reviewReceiptIdentity',
    'validatorIdentity',
  ].sort(compareCanonicalText);
  if (hashCanonical(fields) !== hashCanonical(expected)) {
    throw new Error('integration binding activation has undeclared or missing fields');
  }
  for (const [label, identity] of [
    ['activation identity', activation.activationIdentity],
    ['mapping identity', activation.mappingIdentity],
    ['policy identity', activation.policyIdentity],
    ['review receipt identity', activation.reviewReceiptIdentity],
    ['validator identity', activation.validatorIdentity],
  ] as const) {
    assertSha256(identity, label);
  }
}

function existingRealPath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error(`integration binding destination has no existing ancestor: ${path}`);
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}

function assertExternalDestination(repository: string, destination: string): string {
  if (!isAbsolute(destination)) throw new Error('integration binding destination must be absolute');
  const candidate = realpathSync(repository);
  const resolved = existingRealPath(destination);
  const fromCandidate = relative(candidate, resolved);
  // Proof: resolving only the lexical destination let `external emission refuses candidate-local
  // destinations and symlink escapes` write through an external symlink into the candidate.
  if (fromCandidate === '' || (!fromCandidate.startsWith('..') && !isAbsolute(fromCandidate))) {
    throw new Error('integration binding destination must be outside the candidate repository');
  }
  return resolved;
}

function writeImmutable(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o444 });
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !('code' in cause) ||
      Reflect.get(cause, 'code') !== 'EEXIST'
    ) {
      throw cause;
    }
    const existing = readFileSync(path, 'utf8');
    if (existing !== bytes) {
      throw new Error(`integration binding conflicts with immutable artifact: ${path}`, { cause });
    }
  }
}

function bindReceipts(candidate: CheckedIntegrationCandidate): {
  checks: BoundReceipt[];
  reviews: BoundReceipt[];
} {
  const verifications = new Map(
    candidate.receiptVerifications.map((verification) => [verification.obligationId, verification]),
  );
  const bind = (obligationIds: readonly string[], receipts: readonly unknown[]): BoundReceipt[] =>
    obligationIds.map((obligationId, index) => {
      const receipt = receipts[index];
      const verification = verifications.get(obligationId);
      if (receipt === undefined || verification === undefined) {
        throw new Error(`integration binding receipt evidence is incomplete: ${obligationId}`);
      }
      return { obligationId, receipt, verification };
    });
  return {
    checks: bind(candidate.selectedChecks, candidate.checkReceipts),
    reviews: bind(candidate.selectedReviews, candidate.reviewReceipts),
  };
}

function uncheckedCandidate(candidate: CheckedIntegrationCandidate): UncheckedIntegrationCandidate {
  const {
    checkReceipts: _checks,
    evidenceIdentity: _evidence,
    receiptVerifications: _verifications,
    reviewReceipts: _reviews,
    status: _status,
    ...body
  } = candidate;
  return { ...body, status: 'unchecked' };
}

/** Emits immutable canonical binding bytes outside the candidate after exact publication checks. */
export function emitIntegrationBinding(
  request: EmitIntegrationBindingRequest,
): EmittedIntegrationBinding {
  assertCheckedIntegrationCandidate(request.candidate);
  assertActivation(request.activation);
  assertSha256(request.contentManifestIdentity, 'content manifest identity');
  assertSha256(request.evidenceValidation.validationIdentity, 'evidence validation identity');
  if (!Term.test(request.evidenceValidation.validationId))
    throw new Error('invalid evidence validation id');
  if (
    request.activation.policyIdentity !== request.candidate.policyIdentity ||
    request.activation.mappingIdentity !== request.candidate.mappingIdentity
  ) {
    throw new Error('integration candidate differs from external activation');
  }
  const repository = realpathSync(request.repository);
  assertCommit(
    repository,
    request.publication.commit,
    request.publication.tree,
    request.candidate.baseCommit,
    request.publication.markerRef,
  );
  if (request.publication.tree !== request.candidate.candidateTree) {
    throw new Error('integration publication tree differs from checked candidate');
  }
  const destination = assertExternalDestination(repository, request.destination);
  const receipts = bindReceipts(request.candidate);
  const binding: FinalIntegrationBinding = {
    activation: request.activation,
    admissionProvenance: request.admissionProvenance,
    bindingKind: request.admissionProvenance.kind === 'not-applicable' ? 'bootstrap' : 'integrated',
    candidateCompositionManifestIdentity: request.candidate.contentManifestIdentity,
    checks: receipts.checks,
    commit: request.publication.commit,
    compositionIdentity: request.candidate.compositionIdentity,
    contentManifestIdentity: request.contentManifestIdentity,
    evidenceIdentity: request.candidate.evidenceIdentity,
    evidenceValidation: request.evidenceValidation,
    generations: [...request.candidate.submissions],
    markerRef: request.publication.markerRef,
    parent: request.candidate.baseCommit,
    reviews: receipts.reviews,
    schemaVersion: 1,
    tree: request.publication.tree,
  };
  const bytes = serializeCanonical(binding);
  writeImmutable(destination, bytes);
  return { binding, bytes, identity: hashBytes(bytes), request };
}

export interface VerifyIntegrationBindingRequest {
  readonly repository: string;
  readonly bindingBytes: string;
  readonly candidate: CheckedIntegrationCandidate;
  readonly activation: IntegrationBindingActivation;
  readonly contentManifestIdentity: string;
  readonly evidenceValidation: FinalIntegrationBinding['evidenceValidation'];
  readonly verifier: IntegrationEvidenceVerifier;
}

function decodeBinding(bytes: string): FinalIntegrationBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch (cause) {
    throw new Error('integration binding is malformed JSON', { cause });
  }
  if (serializeCanonical(parsed) !== bytes) throw new Error('integration binding is not canonical');
  return parseOrThrow(FinalIntegrationBindingRecord, parsed);
}

/** Recomputes the Git, activation, candidate and authenticated receipt joins of external bytes. */
export function verifyIntegrationBinding(request: VerifyIntegrationBindingRequest): {
  readonly binding: FinalIntegrationBinding;
  readonly identity: string;
} {
  const binding = decodeBinding(request.bindingBytes);
  assertActivation(binding.activation);
  assertActivation(request.activation);
  // Proof: changing only the binding's policy identity made `trusted verification refuses forged
  // candidate or policy identity and an omitted required check` reach receipt verification until
  // this external-selection comparison was added.
  if (hashCanonical(binding.activation) !== hashCanonical(request.activation)) {
    throw new Error('integration binding activation differs from external selection');
  }
  assertCheckedIntegrationCandidate(request.candidate);
  if (
    request.activation.policyIdentity !== request.candidate.policyIdentity ||
    request.activation.mappingIdentity !== request.candidate.mappingIdentity
  ) {
    throw new Error('external activation differs from independently selected candidate');
  }
  // Proof: forging only the normative content identity made `trusted verification refuses forged
  // candidate or policy identity and an omitted required check` return a verified binding until
  // this independently supplied content/evidence comparison was added.
  if (
    binding.contentManifestIdentity !== request.contentManifestIdentity ||
    hashCanonical(binding.evidenceValidation) !== hashCanonical(request.evidenceValidation)
  ) {
    throw new Error(
      'integration binding content or evidence validation differs from trusted inputs',
    );
  }
  assertCommit(request.repository, binding.commit, binding.tree, binding.parent, binding.markerRef);
  if (
    binding.tree !== request.candidate.candidateTree ||
    binding.parent !== request.candidate.baseCommit ||
    binding.compositionIdentity !== request.candidate.compositionIdentity ||
    binding.candidateCompositionManifestIdentity !== request.candidate.contentManifestIdentity ||
    hashCanonical(binding.generations) !== hashCanonical(request.candidate.submissions)
  ) {
    throw new Error('integration binding differs from independently selected candidate');
  }
  const evidence: IntegrationEvidence = {
    candidateDiffIdentity: request.candidate.candidateDiffIdentity,
    candidateTree: request.candidate.candidateTree,
    checks: binding.checks.map(({ obligationId, receipt }) => ({ checkId: obligationId, receipt })),
    compositionIdentity: request.candidate.compositionIdentity,
    contentManifestIdentity: request.candidate.contentManifestIdentity,
    declarationIdentity: request.candidate.declarationIdentity,
    mappingIdentity: request.candidate.mappingIdentity,
    policyIdentity: request.candidate.policyIdentity,
    reviews: binding.reviews.map(({ obligationId, receipt }) => ({
      reviewId: obligationId,
      receipt,
    })),
    selectedChecks: request.candidate.selectedChecks,
    selectedReviews: request.candidate.selectedReviews,
  };
  // Proof: deleting the sole check from binding bytes made `trusted verification refuses forged
  // candidate or policy identity and an omitted required check` fail on `Expected function to
  // throw`; re-certification now reports `integration check receipt set is incomplete`.
  const recertified = certifyIntegrationCandidate(
    uncheckedCandidate(request.candidate),
    evidence,
    request.verifier,
  );
  if (
    recertified.evidenceIdentity !== binding.evidenceIdentity ||
    recertified.evidenceIdentity !== request.candidate.evidenceIdentity ||
    hashCanonical(recertified.receiptVerifications) !==
      hashCanonical(request.candidate.receiptVerifications)
  ) {
    throw new Error('integration binding evidence differs from trusted verification');
  }
  return { binding, identity: hashBytes(request.bindingBytes) };
}
