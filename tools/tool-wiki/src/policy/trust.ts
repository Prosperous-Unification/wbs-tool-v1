import { Buffer } from 'node:buffer';
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { parseOrThrow, type } from '@wbs/validation';

import {
  CheckReceipt,
  type CheckReceipt as CheckReceiptValue,
  ClassificationPolicy,
  OpaqueId,
  RelationshipRequest,
  type RelationshipRequest as RelationshipRequestValue,
  RelativePath,
  SchemaVersion,
} from '../contracts/records';
import { hashBytes, hashCanonical } from '../evidence/content-manifest';
import { checkIndexes } from '../indexes/check-indexes';
import { readIndexes } from '../indexes/read-indexes';
import { classifyEntries } from '../inventory/classify-entries';
import {
  type CandidateEntry,
  type CandidateRequest,
  type CandidateSnapshot,
  readCandidate,
} from '../inventory/read-candidate';
import { extractRelationships } from '../relationships';
import { AuditEvaluation, type AuditReport, evaluateAudit } from '../review/audit';
import {
  decodeObligationRequest,
  evaluateObligations,
  type ObligationReport,
  type ObligationRequest,
} from './obligations';

const Sha256 = type(/^[0-9a-f]{64}$/);
const GitIdentity = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const Mode = type("'observe'|'ratchet'|'enforce'");
export type LintMode = typeof Mode.infer;

const ExactTuple = type({
  path: RelativePath,
  mode: "'100644'|'100755'|'120000'|'160000'",
  blob: GitIdentity,
}).onUndeclaredKey('reject');
const BoundarySelector = type({ kind: "'path'", value: RelativePath })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'prefix'", value: RelativePath }).onUndeclaredKey('reject'));
const TrustedBoundary = type({
  boundaryId: OpaqueId,
  selector: BoundarySelector,
  baselineEntries: ExactTuple.array(),
  obligationIds: OpaqueId.array(),
}).onUndeclaredKey('reject');
const TrustedObligation = type({
  obligationId: OpaqueId,
  boundaryId: OpaqueId,
  checkIds: OpaqueId.array(),
  reviewIds: OpaqueId.array(),
}).onUndeclaredKey('reject');
const TrustedExemption = type({
  exemptionId: OpaqueId,
  obligationId: OpaqueId,
  reason: 'string>=1',
  reviewIdentity: Sha256,
}).onUndeclaredKey('reject');
const TrustedPolicyRecord = type({
  schemaVersion: SchemaVersion,
  policyId: OpaqueId,
  minimumMode: Mode,
  classificationPolicy: ClassificationPolicy,
  adoptedBoundaryIds: OpaqueId.array(),
  activationBoundaryIds: OpaqueId.array(),
  boundaries: TrustedBoundary.array(),
  obligations: TrustedObligation.array(),
  exemptions: TrustedExemption.array(),
  'relationshipRequest?': 'unknown',
}).onUndeclaredKey('reject');
export type TrustedPolicy = typeof TrustedPolicyRecord.infer;

const ArtifactReference = type({ path: 'string>=1', sha256: Sha256 }).onUndeclaredKey('reject');
const Predecessor = type({
  bindingId: OpaqueId,
  bindingIdentity: Sha256,
  policyId: OpaqueId,
  policyIdentity: Sha256,
  authorityId: OpaqueId,
  authorityIdentity: Sha256,
  authorityJournalId: OpaqueId,
  authorityTrustScope: "'trusted-harness'|'external-verifier'",
  validatorId: OpaqueId,
  validatorIdentity: Sha256,
}).onUndeclaredKey('reject');
const ActivationDeclaration = type({
  addedBoundaryIds: OpaqueId.array(),
  changedBoundaryIds: OpaqueId.array(),
  addedObligationIds: OpaqueId.array(),
  removedExemptionIds: OpaqueId.array(),
  authorityChanged: 'boolean',
  validatorChanged: 'boolean',
}).onUndeclaredKey('reject');
const TrustedBindingRecord = type({
  schemaVersion: SchemaVersion,
  bindingId: OpaqueId,
  trustScope: "'local-operator'|'ci'",
  policy: ArtifactReference,
  authority: type({
    authorityId: OpaqueId,
    journalId: OpaqueId,
    trustScope: "'trusted-harness'|'external-verifier'",
    artifact: ArtifactReference,
  }).onUndeclaredKey('reject'),
  validator: type({ validatorId: OpaqueId, artifacts: ArtifactReference.array() }).onUndeclaredKey(
    'reject',
  ),
  'predecessor?': Predecessor,
  'activation?': ActivationDeclaration,
}).onUndeclaredKey('reject');
export type TrustedBinding = typeof TrustedBindingRecord.infer;

const ObligationEvidence = type({
  obligationId: OpaqueId,
  checkIds: OpaqueId.array(),
  reviewIds: OpaqueId.array(),
}).onUndeclaredKey('reject');
const LintEvidenceRecord = type({
  schemaVersion: SchemaVersion,
  reportMode: Mode,
  obligations: ObligationEvidence.array(),
  // Proof: changing this boundary to ignore undeclared keys made trustedBindingPath in
  // candidate evidence exit 0 with accepted and certified both true on the CI route.
}).onUndeclaredKey('reject');
interface LintEvidence {
  schemaVersion: 1;
  reportMode: LintMode;
  obligations: (typeof ObligationEvidence.infer)[];
}

const TrustedAuthorityRecord = type({
  schemaVersion: SchemaVersion,
  authorityId: OpaqueId,
  obligationRequest: 'unknown',
  checkReceipts: type({ observationId: OpaqueId, receipt: 'unknown' })
    .onUndeclaredKey('reject')
    .array(),
  audit: AuditEvaluation,
}).onUndeclaredKey('reject');

interface TrustedAuthority {
  authorityId: string;
  obligationRequest: ObligationRequest;
  checkReceipts: { observationId: string; receipt: CheckReceiptValue }[];
  audit: typeof AuditEvaluation.infer;
}

interface StableArtifact {
  path: string;
  bytes: Uint8Array;
}

export interface LoadedTrust {
  binding: TrustedBinding;
  policy: TrustedPolicy;
  bindingPath: string;
  policyPath: string;
  authorityPath: string;
  bindingIdentity: string;
  policyIdentity: string;
  authorityIdentity: string;
  validatorIdentity: string;
  authority: TrustedAuthority;
  authorityObligations: ObligationReport;
  authorityAudit: AuditReport;
  relationshipRequest?: RelationshipRequestValue;
}

export interface TrustRefusal {
  kind: 'activation' | 'mode' | 'obligation' | 'ratchet' | 'selection';
  obligationId?: string;
  boundaryId?: string;
  reason: string;
}

export interface DeterministicCheck {
  kind: 'inventory' | 'classification' | 'schema' | 'metadata-links' | 'selector-input-coverage';
  identity: string;
}

export interface TrustedLintReport {
  schemaVersion: 1;
  mode: LintMode;
  trustProvenance: 'local-operator' | 'ci-preselected';
  bindingId: string;
  bindingIdentity: string;
  policyId: string;
  policyIdentity: string;
  authorityId: string;
  authorityIdentity: string;
  authorityJournalId: string;
  validatorId: string;
  validatorIdentity: string;
  candidateIdentity: string;
  candidateSelection: CandidateSnapshot['selection'];
  untrackedPaths: string[];
  deterministicChecks: DeterministicCheck[];
  changedBoundaryIds: string[];
  debtObligationIds: string[];
  unmetObligationIds: string[];
  refusals: TrustRefusal[];
  certified: boolean;
  accepted: boolean;
}

export interface ActivationIdentity {
  bindingId: string;
  bindingIdentity: string;
  policyId: string;
  policyIdentity: string;
  authorityId: string;
  authorityIdentity: string;
  authorityJournalId: string;
  authorityTrustScope: 'trusted-harness' | 'external-verifier';
  validatorId: string;
  validatorIdentity: string;
}

export interface CompatibleActivationReport {
  schemaVersion: 1;
  compatible: true;
  previous: ActivationIdentity;
  next: ActivationIdentity;
  addedBoundaryIds: string[];
  changedBoundaryIds: string[];
  addedObligationIds: string[];
  removedExemptionIds: string[];
  reselectedCheckIds: string[];
  reselectedReviewIds: string[];
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function readStableArtifact(path: string, subject: string): StableArtifact {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`cannot open ${subject} ${path}: ${detail}`, { cause });
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const canonicalPath = realpathSync(`/proc/self/fd/${String(descriptor)}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`${subject} changed while it was being read: ${canonicalPath}`);
    }
    return { path: canonicalPath, bytes };
  } finally {
    closeSync(descriptor);
  }
}

function isInside(root: string, path: string): boolean {
  const offset = relative(root, path);
  // Proof: treating every `..` prefix as traversal made production CI certify a binding at
  // candidate/..trust/binding.json; the containment test expected exit 1 and received 0.
  const escapes = offset === '..' || offset.startsWith(`..${sep}`);
  return offset === '' || (!escapes && !isAbsolute(offset));
}

function assertExternal(candidateRoot: string, artifact: StableArtifact, subject: string): void {
  // Proof: removing this boundary made a trusted-binding symlink into the candidate exit 0
  // with accepted and certified both true on the production CI route.
  if (isInside(candidateRoot, artifact.path)) {
    throw new Error(`${subject} resolves inside selected candidate: ${artifact.path}`);
  }
}

function parseJson(bytes: Uint8Array, subject: string): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${subject} is not UTF-8: ${detail}`, { cause });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`malformed ${subject}: ${detail}`, { cause });
  }
}

function assertUnique(ids: readonly string[], subject: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate ${subject}: ${id}`);
    seen.add(id);
  }
}

function orderedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareText);
}

function assertExactIds(
  actual: readonly string[],
  expected: readonly string[],
  subject: string,
): void {
  const orderedActual = orderedIds(actual);
  const orderedExpected = orderedIds(expected);
  if (hashCanonical(orderedActual) !== hashCanonical(orderedExpected)) {
    throw new Error(
      `${subject} declaration mismatch: expected ${orderedExpected.join(',') || '(none)'}, received ${orderedActual.join(',') || '(none)'}`,
    );
  }
}

function validatePolicy(policy: TrustedPolicy): void {
  assertUnique(policy.adoptedBoundaryIds, 'adopted boundary');
  assertUnique(policy.activationBoundaryIds, 'activation boundary');
  assertUnique(
    policy.boundaries.map(({ boundaryId }) => boundaryId),
    'trusted boundary',
  );
  assertUnique(
    policy.obligations.map(({ obligationId }) => obligationId),
    'trusted obligation',
  );
  assertUnique(
    policy.exemptions.map(({ exemptionId }) => exemptionId),
    'trusted exemption',
  );
  const boundaries = new Set(policy.boundaries.map(({ boundaryId }) => boundaryId));
  const obligations = new Set(policy.obligations.map(({ obligationId }) => obligationId));
  for (const boundaryId of policy.adoptedBoundaryIds) {
    if (!boundaries.has(boundaryId)) throw new Error(`unknown adopted boundary: ${boundaryId}`);
  }
  for (const boundaryId of policy.activationBoundaryIds) {
    if (!boundaries.has(boundaryId)) throw new Error(`unknown activation boundary: ${boundaryId}`);
  }
  for (const boundary of policy.boundaries) {
    assertUnique(boundary.obligationIds, `obligation in boundary ${boundary.boundaryId}`);
    for (const obligationId of boundary.obligationIds) {
      if (!obligations.has(obligationId)) {
        throw new Error(`boundary ${boundary.boundaryId} has unknown obligation: ${obligationId}`);
      }
    }
  }
  for (const obligation of policy.obligations) {
    if (!boundaries.has(obligation.boundaryId)) {
      throw new Error(
        `obligation ${obligation.obligationId} has unknown boundary: ${obligation.boundaryId}`,
      );
    }
    const assignedBoundaryIds = policy.boundaries
      .filter(({ obligationIds }) => obligationIds.includes(obligation.obligationId))
      .map(({ boundaryId }) => boundaryId);
    // Proof: removing this exact assignment check made production CI certify a policy where
    // obligation.application named boundary.policy while boundary.application still claimed it.
    if (assignedBoundaryIds.length !== 1 || assignedBoundaryIds[0] !== obligation.boundaryId) {
      throw new Error(
        `trusted obligation boundary assignment mismatch: ${obligation.obligationId}`,
      );
    }
    assertUnique(obligation.checkIds, `check in obligation ${obligation.obligationId}`);
    assertUnique(obligation.reviewIds, `review in obligation ${obligation.obligationId}`);
  }
  for (const exemption of policy.exemptions) {
    if (!obligations.has(exemption.obligationId)) {
      throw new Error(`exemption ${exemption.exemptionId} has unknown obligation`);
    }
  }
}

function resolveReference(bindingPath: string, path: string): string {
  return isAbsolute(path) ? path : resolve(dirname(bindingPath), path);
}

function validatorIdentity(artifacts: readonly StableArtifact[]): string {
  return hashCanonical(
    artifacts
      .map((artifact) => ({ path: artifact.path, sha256: hashBytes(artifact.bytes) }))
      .sort((left, right) => compareText(left.path, right.path)),
  );
}

function importedSpecifiers(path: string, source: string): string[] {
  const loader = path.endsWith('.ts') ? 'ts' : 'js';
  return new Bun.Transpiler({ loader }).scanImports(source).map(({ path: specifier }) => specifier);
}

/** Resolves the exact transitive source closure executed by trust-capable CLI routes. */
export function resolveValidatorArtifactPaths(entryPaths: readonly string[]): string[] {
  const pending = [...entryPaths.map((path) => realpathSync(path))];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    for (const specifier of importedSpecifiers(path, source)) {
      if (specifier.startsWith('node:') || specifier.startsWith('bun:')) continue;
      let dependency: string;
      try {
        const resolvedDependency = Bun.resolveSync(specifier, dirname(path));
        if (resolvedDependency.startsWith('node:') || resolvedDependency.startsWith('bun:')) {
          continue;
        }
        dependency = realpathSync(resolvedDependency);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `cannot resolve validator dependency ${specifier} from ${path}: ${detail}`,
          {
            cause,
          },
        );
      }
      pending.push(dependency);
    }
  }
  // Proof: removing transitive discovery made the production CI route certify a binding that
  // omitted indexes/check-indexes.ts (expected executable-implementation refusal).
  return [...visited].sort(compareText);
}

/** Loads exact policy and executable identities through an external, stable trust binding. */
export function loadTrustedPolicy(
  bindingInputPath: string,
  candidateRepository: string,
  runtimeEntryPaths?: readonly string[],
  requiredScope?: TrustedBinding['trustScope'],
): LoadedTrust {
  const candidateRoot = realpathSync(candidateRepository);
  const bindingArtifact = readStableArtifact(bindingInputPath, 'trusted binding');
  assertExternal(candidateRoot, bindingArtifact, 'trusted binding');
  const binding = parseOrThrow(
    TrustedBindingRecord,
    parseJson(bindingArtifact.bytes, 'trusted binding JSON'),
  );
  if (requiredScope !== undefined && binding.trustScope !== requiredScope) {
    throw new Error(`trusted binding scope must be ${requiredScope}`);
  }
  assertUnique(
    binding.validator.artifacts.map(({ path }) => path),
    'validator artifact path',
  );
  const policyArtifact = readStableArtifact(
    resolveReference(bindingArtifact.path, binding.policy.path),
    'trusted policy',
  );
  assertExternal(candidateRoot, policyArtifact, 'trusted policy');
  if (hashBytes(policyArtifact.bytes) !== binding.policy.sha256) {
    throw new Error('trusted policy digest does not match binding');
  }
  const runtimeArtifacts =
    runtimeEntryPaths === undefined
      ? undefined
      : resolveValidatorArtifactPaths(runtimeEntryPaths).map((path) =>
          readStableArtifact(path, 'validator runtime artifact'),
        );
  for (const artifact of runtimeArtifacts ?? [])
    assertExternal(candidateRoot, artifact, 'validator');
  const boundArtifacts = binding.validator.artifacts.map((reference) => {
    const artifact = readStableArtifact(
      resolveReference(bindingArtifact.path, reference.path),
      'bound validator artifact',
    );
    assertExternal(candidateRoot, artifact, 'bound validator');
    if (hashBytes(artifact.bytes) !== reference.sha256) {
      throw new Error(`validator artifact digest does not match binding: ${artifact.path}`);
    }
    return artifact;
  });
  const boundIdentity = validatorIdentity(boundArtifacts);
  const runtimeIdentity =
    runtimeArtifacts === undefined ? undefined : validatorIdentity(runtimeArtifacts);
  // Proof: removing this identity comparison let a binding that omitted trust.ts reach the
  // policy engine; the production report then refused only obligation.application instead.
  if (runtimeIdentity !== undefined && runtimeIdentity !== boundIdentity) {
    throw new Error('trusted validator artifacts do not match the executable implementation');
  }
  const policy = parseOrThrow(
    TrustedPolicyRecord,
    parseJson(policyArtifact.bytes, 'trusted policy JSON'),
  );
  validatePolicy(policy);
  // Proof: skipping authority loading let authority.does-not-exist.json activate as compatible
  // with empty reselection; the production activation test failed on `Expected: 1, Received: 0`.
  const authorityArtifact = readStableArtifact(
    resolveReference(bindingArtifact.path, binding.authority.artifact.path),
    'trusted authority',
  );
  assertExternal(candidateRoot, authorityArtifact, 'trusted authority');
  // Proof: omitting the digest let changed authority bytes delete check.failed and certify;
  // the production CI test failed on `Expected: 1, Received: 0`.
  if (hashBytes(authorityArtifact.bytes) !== binding.authority.artifact.sha256) {
    throw new Error('trusted authority digest does not match binding');
  }
  const authority = decodeTrustedAuthority(authorityArtifact.bytes);
  if (authority.authorityId !== binding.authority.authorityId) {
    throw new Error('trusted authority identity does not match binding');
  }
  if (authority.obligationRequest.policy.policyId !== policy.policyId) {
    throw new Error('trusted authority obligation policy does not match trusted policy');
  }
  const authorityObligations = evaluateObligations(authority.obligationRequest);
  const authorityAudit = evaluateAudit(authority.audit);
  const relationshipRequest =
    policy.relationshipRequest === undefined
      ? undefined
      : parseOrThrow(RelationshipRequest, policy.relationshipRequest);
  return {
    binding,
    policy,
    bindingPath: bindingArtifact.path,
    policyPath: policyArtifact.path,
    authorityPath: authorityArtifact.path,
    bindingIdentity: hashBytes(bindingArtifact.bytes),
    policyIdentity: hashBytes(policyArtifact.bytes),
    authorityIdentity: hashBytes(authorityArtifact.bytes),
    validatorIdentity: boundIdentity,
    authority,
    authorityObligations,
    authorityAudit,
    relationshipRequest,
  };
}

function activationIdentity(trust: LoadedTrust): ActivationIdentity {
  return {
    bindingId: trust.binding.bindingId,
    bindingIdentity: trust.bindingIdentity,
    policyId: trust.policy.policyId,
    policyIdentity: trust.policyIdentity,
    authorityId: trust.binding.authority.authorityId,
    authorityIdentity: trust.authorityIdentity,
    authorityJournalId: trust.binding.authority.journalId,
    authorityTrustScope: trust.binding.authority.trustScope,
    validatorId: trust.binding.validator.validatorId,
    validatorIdentity: trust.validatorIdentity,
  };
}

function activationBoundaryShape(
  policy: TrustedPolicy,
  boundary: TrustedPolicy['boundaries'][number],
): object {
  return {
    boundary,
    isAdopted: policy.adoptedBoundaryIds.includes(boundary.boundaryId),
    requiresActivation: policy.activationBoundaryIds.includes(boundary.boundaryId),
    obligations: policy.obligations
      .filter(({ boundaryId }) => boundaryId === boundary.boundaryId)
      .sort((left, right) => compareText(left.obligationId, right.obligationId)),
  };
}

function assertRetainsAuthorityIds(
  previousIds: readonly string[],
  nextIds: readonly string[],
  kind: string,
  subjectId: string,
): void {
  for (const id of previousIds) {
    if (!nextIds.includes(id)) {
      throw new Error(
        `compatible activation cannot remove authority ${kind} requirement from ${subjectId}: ${id}`,
      );
    }
  }
}

function validateCompatibleAuthority(previous: LoadedTrust, next: LoadedTrust): void {
  const previousRules = new Map(
    previous.authority.obligationRequest.policy.behaviorRules.map((rule) => [
      rule.contentInputId,
      rule,
    ]),
  );
  const nextRules = new Map(
    next.authority.obligationRequest.policy.behaviorRules.map((rule) => [
      rule.contentInputId,
      rule,
    ]),
  );
  for (const [contentInputId, previousRule] of previousRules) {
    const nextRule = nextRules.get(contentInputId);
    if (nextRule === undefined) {
      throw new Error(
        `compatible activation cannot remove authority behavior rule: ${contentInputId}`,
      );
    }
    assertRetainsAuthorityIds(
      [...previousRule.consumerChecks, ...previousRule.conformanceChecks],
      [...nextRule.consumerChecks, ...nextRule.conformanceChecks],
      'check',
      contentInputId,
    );
    assertRetainsAuthorityIds(
      previousRule.expandedReviewJudgments,
      nextRule.expandedReviewJudgments,
      'review',
      contentInputId,
    );
  }
  const nextJudgments = new Map(
    next.authority.obligationRequest.judgments.map((judgment) => [judgment.judgmentId, judgment]),
  );
  for (const judgment of previous.authority.obligationRequest.judgments) {
    const retained = nextJudgments.get(judgment.judgmentId);
    if (retained === undefined || hashCanonical(retained) !== hashCanonical(judgment)) {
      throw new Error(
        `compatible activation cannot remove or weaken authority judgment: ${judgment.judgmentId}`,
      );
    }
  }
  assertRetainsAuthorityIds(
    previous.authorityObligations.requiredChecks,
    next.authorityObligations.requiredChecks,
    'check',
    'selected-obligations',
  );
  assertRetainsAuthorityIds(
    previous.authorityObligations.requiredReviews,
    next.authorityObligations.requiredReviews,
    'review',
    'selected-obligations',
  );
  assertRetainsAuthorityIds(
    previous.authorityAudit.requiredObligationIds,
    next.authorityAudit.requiredObligationIds,
    'review',
    'audit',
  );
  const nextAuditObligations = new Map(
    next.authority.audit.obligations.map((obligation) => [obligation.obligationId, obligation]),
  );
  // Proof: removing this exact-record comparison let review.application narrow from project/src
  // to file/src/app.ts and return compatible true; the same next binding exited 0 with accepted
  // and certified true on production lint-ci (`Expected: 1, Received: 0`).
  for (const obligation of previous.authority.audit.obligations) {
    const retained = nextAuditObligations.get(obligation.obligationId);
    if (retained === undefined || hashCanonical(retained) !== hashCanonical(obligation)) {
      throw new Error(
        `compatible activation cannot change authority audit obligation: ${obligation.obligationId}`,
      );
    }
  }
}

function authorityCheckIds(trust: LoadedTrust): string[] {
  return orderedIds(
    trust.authority.obligationRequest.policy.behaviorRules.flatMap((rule) => [
      ...rule.consumerChecks,
      ...rule.conformanceChecks,
    ]),
  );
}

function authorityReviewIds(trust: LoadedTrust): string[] {
  return orderedIds([
    ...trust.authority.obligationRequest.judgments.map(({ judgmentId }) => judgmentId),
    ...trust.authority.obligationRequest.policy.behaviorRules.flatMap(
      ({ expandedReviewJudgments }) => expandedReviewJudgments,
    ),
    ...trust.authorityAudit.requiredObligationIds,
  ]);
}

/** Validates a monotonic, explicitly described transition between two reviewed bindings. */
export function validateCompatibleActivation(
  previous: LoadedTrust,
  next: LoadedTrust,
): CompatibleActivationReport {
  const predecessor = next.binding.predecessor;
  const declaration = next.binding.activation;
  if (predecessor === undefined || declaration === undefined) {
    throw new Error(
      'compatible activation requires predecessor identities and an explicit change declaration',
    );
  }
  const previousIdentity = activationIdentity(previous);
  // Proof: removing this comparison made an all-zero predecessor binding identity exit 0
  // with compatible true and the actual previous identity substituted into the report.
  if (hashCanonical(predecessor) !== hashCanonical(previousIdentity)) {
    throw new Error('activation predecessor does not match the previous trusted binding');
  }
  // Proof: skipping authority monotonicity changed the production refusal from the removed
  // check.application requirement to only `authority change declaration does not match`.
  validateCompatibleAuthority(previous, next);
  // Proof: without this compatibility guard an enforce-to-observe activation exited 0 with
  // compatible true and merely reselected the four existing checks and reviews.
  if (modeRank(next.policy.minimumMode) < modeRank(previous.policy.minimumMode)) {
    throw new Error('compatible activation cannot weaken minimum mode');
  }
  for (const [subject, ids] of [
    ['activation added boundary', declaration.addedBoundaryIds],
    ['activation changed boundary', declaration.changedBoundaryIds],
    ['activation added obligation', declaration.addedObligationIds],
    ['activation removed exemption', declaration.removedExemptionIds],
  ] as const) {
    assertUnique(ids, subject);
  }
  const previousBoundaries = new Map(
    previous.policy.boundaries.map((boundary) => [boundary.boundaryId, boundary]),
  );
  const nextBoundaries = new Map(
    next.policy.boundaries.map((boundary) => [boundary.boundaryId, boundary]),
  );
  // Proof: removing this compatibility guard let a deleted boundary pass through to the
  // later obligation check, which reported only `cannot remove obligation` and lost the
  // boundary-coverage refusal on the production activation route.
  for (const boundaryId of previousBoundaries.keys()) {
    if (!nextBoundaries.has(boundaryId)) {
      throw new Error(`compatible activation cannot remove boundary: ${boundaryId}`);
    }
  }
  for (const [boundaryId, previousBoundary] of previousBoundaries) {
    const nextBoundary = nextBoundaries.get(boundaryId);
    if (nextBoundary === undefined) continue;
    const previousSelector = previousBoundary.selector;
    const nextSelector = nextBoundary.selector;
    const selectorRetained =
      nextSelector.kind === 'prefix' &&
      (previousSelector.value === nextSelector.value ||
        previousSelector.value.startsWith(`${nextSelector.value}/`));
    // Proof: removing this monotonic selector comparison made prefix src narrow to path
    // src/app.ts and exit 0 with compatible true on the production activation route.
    if (!selectorRetained && hashCanonical(previousSelector) !== hashCanonical(nextSelector)) {
      throw new Error(`compatible activation cannot narrow selector coverage: ${boundaryId}`);
    }
  }
  const addedBoundaryIds = orderedIds(
    [...nextBoundaries.keys()].filter((boundaryId) => !previousBoundaries.has(boundaryId)),
  );
  const changedBoundaryIds = orderedIds(
    [...previousBoundaries.keys()].filter((boundaryId) => {
      const previousBoundary = previousBoundaries.get(boundaryId);
      const nextBoundary = nextBoundaries.get(boundaryId);
      return (
        previousBoundary !== undefined &&
        nextBoundary !== undefined &&
        hashCanonical(activationBoundaryShape(previous.policy, previousBoundary)) !==
          hashCanonical(activationBoundaryShape(next.policy, nextBoundary))
      );
    }),
  );
  // Proof: removing this declaration check made an undeclared boundary.docs addition exit 0
  // with compatible true while the report itself named boundary.docs in addedBoundaryIds.
  assertExactIds(declaration.addedBoundaryIds, addedBoundaryIds, 'added boundary');
  // Proof: comparing only boundary records made an undeclared check.application.new coverage
  // change exit 0 with compatible true while it appeared in reselectedCheckIds.
  assertExactIds(declaration.changedBoundaryIds, changedBoundaryIds, 'changed boundary');
  const previousObligations = new Map(
    previous.policy.obligations.map((obligation) => [obligation.obligationId, obligation]),
  );
  const nextObligations = new Map(
    next.policy.obligations.map((obligation) => [obligation.obligationId, obligation]),
  );
  for (const obligationId of previousObligations.keys()) {
    if (!nextObligations.has(obligationId)) {
      throw new Error(`compatible activation cannot remove obligation: ${obligationId}`);
    }
  }
  for (const [obligationId, previousObligation] of previousObligations) {
    const nextObligation = nextObligations.get(obligationId);
    if (nextObligation === undefined) continue;
    // Proof: removing this guard made obligation.application move to boundary.policy and exit 0
    // with compatible true after both changed boundaries were explicitly declared.
    if (nextObligation.boundaryId !== previousObligation.boundaryId) {
      throw new Error(
        `compatible activation cannot move obligation ${obligationId} from ${previousObligation.boundaryId}`,
      );
    }
    for (const [kind, previousIds, nextIds] of [
      ['check', previousObligation.checkIds, nextObligation.checkIds],
      ['review', previousObligation.reviewIds, nextObligation.reviewIds],
    ] as const) {
      // Proof: removing this monotonic requirement comparison made the production activation
      // route delete each of check.application and review.application and exit 0 compatible.
      for (const id of previousIds) {
        if (!nextIds.includes(id)) {
          throw new Error(
            `compatible activation cannot remove ${kind} requirement from ${obligationId}: ${id}`,
          );
        }
      }
    }
  }
  const addedObligationIds = orderedIds(
    [...nextObligations.keys()].filter((obligationId) => !previousObligations.has(obligationId)),
  );
  assertExactIds(declaration.addedObligationIds, addedObligationIds, 'added obligation');
  for (const boundaryId of previous.policy.adoptedBoundaryIds) {
    if (!next.policy.adoptedBoundaryIds.includes(boundaryId)) {
      throw new Error(`compatible activation cannot shrink adopted coverage: ${boundaryId}`);
    }
  }
  for (const boundaryId of previous.policy.activationBoundaryIds) {
    if (!next.policy.activationBoundaryIds.includes(boundaryId)) {
      throw new Error(`compatible activation cannot shrink activation coverage: ${boundaryId}`);
    }
  }
  const previousExemptions = new Map(
    previous.policy.exemptions.map((exemption) => [exemption.exemptionId, exemption]),
  );
  const nextExemptions = new Map(
    next.policy.exemptions.map((exemption) => [exemption.exemptionId, exemption]),
  );
  // Proof: removing this comparison made a newly introduced exemption exit 0 with a
  // compatible true activation report and no removed exemptions on the production route.
  for (const [exemptionId, exemption] of nextExemptions) {
    const before = previousExemptions.get(exemptionId);
    if (before === undefined || hashCanonical(before) !== hashCanonical(exemption)) {
      throw new Error(`compatible activation cannot add or weaken exemption: ${exemptionId}`);
    }
  }
  const removedExemptionIds = orderedIds(
    [...previousExemptions.keys()].filter((exemptionId) => !nextExemptions.has(exemptionId)),
  );
  assertExactIds(declaration.removedExemptionIds, removedExemptionIds, 'removed exemption');
  const validatorChanged = previous.validatorIdentity !== next.validatorIdentity;
  if (declaration.validatorChanged !== validatorChanged) {
    throw new Error('validator change declaration does not match executable identities');
  }
  const authorityChanged =
    previous.authorityIdentity !== next.authorityIdentity ||
    previous.binding.authority.authorityId !== next.binding.authority.authorityId ||
    previous.binding.authority.journalId !== next.binding.authority.journalId ||
    previous.binding.authority.trustScope !== next.binding.authority.trustScope;
  if (declaration.authorityChanged !== authorityChanged) {
    throw new Error('authority change declaration does not match trusted authority identities');
  }
  const policyChanged = previous.policyIdentity !== next.policyIdentity;
  const trustRequirementsChanged = policyChanged || validatorChanged || authorityChanged;
  const affectedObligations = trustRequirementsChanged
    ? [...next.policy.obligations]
    : next.policy.obligations.filter(
        ({ boundaryId, obligationId }) =>
          changedBoundaryIds.includes(boundaryId) || addedObligationIds.includes(obligationId),
      );
  return {
    schemaVersion: 1,
    compatible: true,
    previous: previousIdentity,
    next: activationIdentity(next),
    addedBoundaryIds,
    changedBoundaryIds,
    addedObligationIds,
    removedExemptionIds,
    reselectedCheckIds: orderedIds([
      ...affectedObligations.flatMap(({ checkIds }) => checkIds),
      // Proof: omitting authority checks left check.authority.new out of the production
      // activation report; the test's exact array comparison failed at that missing ID.
      // Gating them on authorityChanged alone also omitted check.authority.extra from both
      // policy-only and validator-only reports; each exact comparison showed the missing ID.
      ...(trustRequirementsChanged ? authorityCheckIds(next) : []),
    ]),
    reselectedReviewIds: orderedIds([
      ...affectedObligations.flatMap(({ reviewIds }) => reviewIds),
      // Proof: omitting authority reviews left review.authority.new out of the production
      // activation report; the test's exact array comparison failed at that missing ID.
      // Gating them on authorityChanged alone also omitted review.authority.extra from both
      // policy-only and validator-only reports; each exact comparison showed the missing ID.
      ...(trustRequirementsChanged ? authorityReviewIds(next) : []),
    ]),
  };
}

function readSelectedBlob(repository: string, blob: string, path: string): Uint8Array {
  const invocation = Bun.spawnSync(['git', '-C', repository, 'cat-file', 'blob', blob], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    throw new Error(
      `cannot read selected blob ${blob} for ${path}: ${invocation.stderr.toString('utf8').trim()}`,
    );
  }
  return invocation.stdout;
}

function sameTuple(left: CandidateEntry, right: typeof ExactTuple.infer): boolean {
  return left.path === right.path && left.mode === right.mode && left.blob === right.blob;
}

function selectedMembers(
  candidate: CandidateSnapshot,
  selector: typeof BoundarySelector.infer,
): CandidateEntry[] {
  return candidate.entries.filter(({ path }) =>
    selector.kind === 'path'
      ? path === selector.value
      : path === selector.value || path.startsWith(`${selector.value}/`),
  );
}

function changedBoundaries(candidate: CandidateSnapshot, policy: TrustedPolicy): string[] {
  return policy.boundaries
    .filter((boundary) => {
      const selected = selectedMembers(candidate, boundary.selector);
      return (
        selected.length !== boundary.baselineEntries.length ||
        selected.some(
          (entry) => !boundary.baselineEntries.some((baseline) => sameTuple(entry, baseline)),
        )
      );
    })
    .map(({ boundaryId }) => boundaryId)
    .sort(compareText);
}

function validateSelectedInputs(
  repository: string,
  candidate: CandidateSnapshot,
  trust: LoadedTrust,
): string {
  const policy = trust.policy;
  for (const boundary of policy.boundaries) {
    // Proof: replacing this validation with the selector digest made a nonexistent selector
    // certify on production CI after its trusted policy digest was correctly updated.
    if (selectedMembers(candidate, boundary.selector).length === 0) {
      throw new Error(
        `trusted boundary selector selects no candidate input: ${boundary.boundaryId}`,
      );
    }
  }
  const selectors = readIndexes(repository, candidate).indexes.flatMap(({ indexPath, metadata }) =>
    metadata.relationshipSelectors.map((selectorId) => ({ indexPath, selectorId })),
  );
  if (selectors.length === 0) return hashCanonical([]);
  if (trust.relationshipRequest === undefined) {
    throw new Error('trusted policy has no relationship request for declared selectors');
  }
  const relationships = extractRelationships(repository, candidate, trust.relationshipRequest);
  const available = new Set(
    relationships.manifestInputs.relationshipInputs.map(({ inputId }) => inputId),
  );
  for (const { indexPath, selectorId } of selectors) {
    // Proof: omitting production relationship extraction/resolution made README metadata with
    // selector.does-not-exist certify; the production CI test failed on `Expected: 1,
    // Received: 0`.
    if (!available.has(selectorId)) {
      throw new Error(`unknown relationship selector in ${indexPath}: ${selectorId}`);
    }
  }
  return hashCanonical(relationships.manifestInputs);
}

function modeRank(mode: LintMode): number {
  return mode === 'observe' ? 0 : mode === 'ratchet' ? 1 : 2;
}

function decodeLintEvidence(bytes: Uint8Array): LintEvidence {
  const envelope = parseOrThrow(LintEvidenceRecord, parseJson(bytes, 'lint evidence JSON'));
  return {
    schemaVersion: envelope.schemaVersion,
    reportMode: envelope.reportMode,
    obligations: envelope.obligations,
  };
}

function decodeTrustedAuthority(bytes: Uint8Array): TrustedAuthority {
  const envelope = parseOrThrow(TrustedAuthorityRecord, parseJson(bytes, 'trusted authority JSON'));
  const checkReceipts = envelope.checkReceipts.map(({ observationId, receipt }) => ({
    observationId,
    receipt: parseOrThrow(CheckReceipt, receipt),
  }));
  assertUnique(
    checkReceipts.map(({ observationId }) => observationId),
    'check receipt observation',
  );
  assertUnique(
    checkReceipts.map(({ receipt }) => receipt.receiptId),
    'check receipt',
  );
  return {
    authorityId: envelope.authorityId,
    obligationRequest: decodeObligationRequest(envelope.obligationRequest),
    checkReceipts,
    audit: envelope.audit,
  };
}

function sameContentInputs(
  candidateEntries: readonly CandidateEntry[],
  content: ObligationRequest['current']['inputs']['content'],
): boolean {
  const candidateTuples = candidateEntries
    .map(({ path, mode, blob }) => ({ path, mode, blob }))
    .sort((left, right) => compareText(left.path, right.path));
  const evidenceTuples = content
    .map(({ path, mode, blob }) => ({ path, mode, blob }))
    .sort((left, right) => compareText(left.path, right.path));
  return hashCanonical(candidateTuples) === hashCanonical(evidenceTuples);
}

function sourceBase(candidate: CandidateSnapshot): string {
  return candidate.selection.kind === 'committed'
    ? candidate.selection.revision
    : candidate.selection.base;
}

interface ValidatedEvidence {
  bindsCandidate: boolean;
  passedCheckIds: Set<string>;
  currentReviewIds: Set<string>;
}

function validateEvidence(
  trust: LoadedTrust,
  candidate: CandidateSnapshot,
  identity: string,
): ValidatedEvidence {
  const { authority, authorityAudit: audit, authorityObligations: obligationReport } = trust;
  const { binding, policy } = trust;
  const request = authority.obligationRequest;
  const currentBinds =
    request.policy.policyId === policy.policyId &&
    request.current.candidateIdentity === identity &&
    request.current.sourceBase === sourceBase(candidate) &&
    sameContentInputs(candidate.entries, request.current.inputs.content);
  const reviewedByPath = new Map(
    request.reviewed.inputs.content.map((input) => [input.path, input]),
  );
  const reviewedBinds = policy.boundaries.every((boundary) =>
    boundary.baselineEntries.every((baseline) => {
      const reviewed = reviewedByPath.get(baseline.path);
      return reviewed !== undefined && sameTuple(reviewed, baseline);
    }),
  );
  const passedCheckIds = new Set<string>();
  for (const observation of request.checks) {
    const receipt = authority.checkReceipts.find(
      (candidateReceipt) => candidateReceipt.observationId === observation.observationId,
    )?.receipt;
    if (
      observation.candidateIdentity === request.current.candidateIdentity &&
      observation.status === 'passed' &&
      // Proof: dropping these receipt requirements made a missing check.application receipt
      // certify on production CI; the test expected exit 1 and received certified true.
      receipt?.candidateManifest === request.current.candidateIdentity &&
      receipt.status === 'passed' &&
      receipt.exitCode === 0 &&
      receipt.skips.length === 0
    ) {
      passedCheckIds.add(observation.checkId);
    }
  }
  const currentReviewIds = new Set<string>();
  const auditBinds =
    audit.accepted &&
    // Proof: accepting observe-mode debt let an audit with reviews [] certify enforced lint;
    // the production CI test failed on `Expected: 1, Received: 0`.
    audit.mode === 'enforce' &&
    audit.refusals.length === 0 &&
    audit.unmetObligationIds.length === 0 &&
    audit.claimedCoverage === 'exhaustive' &&
    audit.candidateIdentity === identity &&
    // Proof: dropping source-base reconciliation let an all-zero audit source certify the real
    // committed candidate; the production CI test failed on `Expected: 1, Received: 0`.
    audit.selection.sourceBase === sourceBase(candidate) &&
    // Proof: omitting the externally selected journal/scope match let receipts relabeled with
    // invocation.never-executed and journal.does-not-exist certify; the production CI test
    // failed on `Expected: 1, Received: 0`.
    audit.costs.reviews.every(
      ({ trustScope, reviewReceipt }) =>
        trustScope === binding.authority.trustScope &&
        reviewReceipt.trust.journalId === binding.authority.journalId,
    );
  if (auditBinds) {
    for (const reviewId of audit.requiredObligationIds) currentReviewIds.add(reviewId);
  }
  return {
    bindsCandidate:
      authority.authorityId === binding.authority.authorityId &&
      currentBinds &&
      reviewedBinds &&
      obligationReport.accepted &&
      auditBinds,
    passedCheckIds,
    currentReviewIds,
  };
}

function evidenceMeets(
  evidence: LintEvidence,
  validated: ValidatedEvidence,
  obligation: TrustedPolicy['obligations'][number],
): boolean {
  const matching = evidence.obligations.filter(
    ({ obligationId }) => obligationId === obligation.obligationId,
  );
  if (matching.length !== 1) return false;
  const observation = matching[0];
  return (
    // Proof: removing this candidate-bound evidence gate made unchanged evidence certify a later
    // src/app.ts blob; production CI expected exit 1 and received certified true.
    validated.bindsCandidate &&
    hashCanonical([...observation.checkIds].sort(compareText)) ===
      hashCanonical([...obligation.checkIds].sort(compareText)) &&
    hashCanonical([...observation.reviewIds].sort(compareText)) ===
      hashCanonical([...obligation.reviewIds].sort(compareText)) &&
    obligation.checkIds.every((checkId) => validated.passedCheckIds.has(checkId)) &&
    obligation.reviewIds.every((reviewId) => validated.currentReviewIds.has(reviewId))
  );
}

function candidateIdentity(candidate: CandidateSnapshot): string {
  return hashCanonical({
    selection: candidate.selection,
    entries: candidate.entries,
    untracked: candidate.untracked,
  });
}

export interface TrustedLintRequest {
  repository: string;
  candidate: CandidateRequest;
  mode?: LintMode;
  bindingPath: string;
  evidencePath: string;
  runtimeEntryPaths: readonly string[];
  trustProvenance: TrustedLintReport['trustProvenance'];
  requiredScope?: TrustedBinding['trustScope'];
}

/** Runs one shared whole-tree engine; the mode controls only obligation disposition. */
export function lintTrustedCandidate(request: TrustedLintRequest): TrustedLintReport {
  const repository = realpathSync(request.repository);
  const trust = loadTrustedPolicy(
    request.bindingPath,
    repository,
    request.runtimeEntryPaths,
    request.requiredScope,
  );
  const evidenceArtifact = readStableArtifact(request.evidencePath, 'lint evidence');
  const evidence = decodeLintEvidence(evidenceArtifact.bytes);
  const mode = request.mode ?? trust.policy.minimumMode;
  assertUnique(
    evidence.obligations.map(({ obligationId }) => obligationId),
    'lint evidence obligation',
  );
  const candidate = readCandidate(repository, request.candidate);
  const classified = classifyEntries(
    candidate.entries,
    trust.policy.classificationPolicy,
    (blob, path) => readSelectedBlob(repository, blob, path),
  );
  // Proof: replacing this production whole-tree index check with an empty report made an
  // unindexed src/unindexed.ts candidate exit 0 with accepted true.
  // Working selection intentionally keeps untracked paths outside its frozen tuple set. CI
  // checks every tracked tuple, reports that separate set, and refuses certification below.
  const indexCandidate =
    request.trustProvenance === 'ci-preselected' && candidate.selection.kind === 'working'
      ? { ...candidate, untracked: [] }
      : candidate;
  const indexes = checkIndexes(repository, indexCandidate);
  const relationshipIdentity = validateSelectedInputs(repository, indexCandidate, trust);
  const identity = candidateIdentity(candidate);
  const validatedEvidence = validateEvidence(trust, candidate, identity);
  const changedBoundaryIds = changedBoundaries(candidate, trust.policy);
  const met = new Set(
    trust.policy.obligations
      .filter((obligation) => evidenceMeets(evidence, validatedEvidence, obligation))
      .map(({ obligationId }) => obligationId),
  );
  const exempt = new Set(trust.policy.exemptions.map(({ obligationId }) => obligationId));
  const debtObligationIds = trust.policy.obligations
    .map(({ obligationId }) => obligationId)
    .filter((obligationId) => !met.has(obligationId) && !exempt.has(obligationId))
    .sort(compareText);
  const adopted = new Set(trust.policy.adoptedBoundaryIds);
  const changedAdopted = new Set(
    changedBoundaryIds.filter((boundaryId) => adopted.has(boundaryId)),
  );
  const ratchetDebt = trust.policy.obligations
    .filter(({ boundaryId }) => changedAdopted.has(boundaryId))
    .map(({ obligationId }) => obligationId)
    .filter((obligationId) => !met.has(obligationId) && !exempt.has(obligationId))
    .sort(compareText);
  const refusals: TrustRefusal[] = [];
  const activationBoundaries = new Set(trust.policy.activationBoundaryIds);
  // Proof: removing this guard made the production CLI accept candidate edits to policy,
  // validator and exemption authority with changedBoundaryIds naming each one but exit 0,
  // accepted true and an empty refusal set.
  for (const boundaryId of changedBoundaryIds.filter((id) => activationBoundaries.has(id))) {
    refusals.push({
      kind: 'activation',
      boundaryId,
      reason: 'trusted authority boundary changed without a separate activation',
    });
  }
  if (modeRank(mode) < modeRank(trust.policy.minimumMode)) {
    refusals.push({
      kind: 'mode',
      reason: `${mode} cannot lower ${trust.policy.minimumMode} policy`,
    });
  }
  // Proof: removing this check left only obligation.application in the production report;
  // the required `observe evidence cannot satisfy enforce work` refusal disappeared.
  if (modeRank(evidence.reportMode) < modeRank(mode)) {
    refusals.push({
      kind: 'mode',
      reason:
        mode === 'enforce' && evidence.reportMode === 'observe'
          ? 'observe evidence cannot satisfy enforce work'
          : `${evidence.reportMode} evidence cannot satisfy ${mode} work`,
    });
  }
  if (request.trustProvenance === 'ci-preselected' && candidate.selection.kind === 'working') {
    // Proof: removing this refusal made production lint-ci certify a working selection while
    // its report exposed untracked.ts outside the immutable candidate tuple set.
    refusals.push({
      kind: 'selection',
      reason: 'mutable working selection cannot receive CI certification',
    });
  }
  // Proof: removing this disposition made an exact blob-tuple change under
  // boundary.application exit 0 with accepted true even while the report named
  // obligation.application in both debtObligationIds and unmetObligationIds.
  if (mode === 'ratchet') {
    for (const obligationId of ratchetDebt) {
      const obligation = trust.policy.obligations.find(
        (candidateObligation) => candidateObligation.obligationId === obligationId,
      );
      if (obligation === undefined)
        throw new Error(`trusted obligation disappeared: ${obligationId}`);
      refusals.push({
        kind: 'ratchet',
        boundaryId: obligation.boundaryId,
        obligationId,
        reason: 'changed adopted boundary has an unmet obligation',
      });
    }
  }
  // Proof: removing this disposition made omitted obligation.application evidence exit 0
  // with accepted true even while both debtObligationIds and unmetObligationIds named it.
  if (mode === 'enforce') {
    for (const obligationId of debtObligationIds) {
      refusals.push({
        kind: 'obligation',
        obligationId,
        reason: 'selected policy obligation is unmet',
      });
    }
  }
  const deterministicChecks: DeterministicCheck[] = [
    { kind: 'inventory', identity },
    { kind: 'classification', identity: hashCanonical(classified) },
    {
      kind: 'schema',
      identity: hashCanonical({
        policy: trust.policyIdentity,
        evidence: hashBytes(evidenceArtifact.bytes),
        authority: trust.authorityIdentity,
      }),
    },
    { kind: 'metadata-links', identity: hashCanonical(indexes) },
    {
      kind: 'selector-input-coverage',
      identity: hashCanonical({
        boundaries: trust.policy.boundaries.map(({ boundaryId, selector }) => ({
          boundaryId,
          selector,
        })),
        entries: candidate.entries.map(({ path, mode, blob }) => ({ path, mode, blob })),
        relationships: relationshipIdentity,
      }),
    },
  ];
  const accepted = refusals.length === 0;
  return {
    schemaVersion: 1,
    mode,
    trustProvenance: request.trustProvenance,
    bindingId: trust.binding.bindingId,
    bindingIdentity: trust.bindingIdentity,
    policyId: trust.policy.policyId,
    policyIdentity: trust.policyIdentity,
    authorityId: trust.binding.authority.authorityId,
    authorityIdentity: trust.authorityIdentity,
    authorityJournalId: trust.binding.authority.journalId,
    validatorId: trust.binding.validator.validatorId,
    validatorIdentity: trust.validatorIdentity,
    candidateIdentity: identity,
    candidateSelection: candidate.selection,
    untrackedPaths: [...candidate.untracked],
    deterministicChecks,
    changedBoundaryIds,
    debtObligationIds,
    unmetObligationIds:
      mode === 'enforce' ? debtObligationIds : mode === 'ratchet' ? ratchetDebt : [],
    refusals,
    certified: mode === 'enforce' && request.trustProvenance === 'ci-preselected' && accepted,
    accepted,
  };
}

function candidateRequest(kind: string, revision: string): CandidateRequest {
  if (kind !== 'committed' && kind !== 'staged' && kind !== 'working') {
    throw new Error('lint candidate kind must be committed, staged or working');
  }
  return kind === 'committed' ? { kind, revision } : { kind, base: revision };
}

function lintMode(input: string): LintMode {
  if (input !== 'observe' && input !== 'ratchet' && input !== 'enforce') {
    throw new Error('lint mode must be observe, ratchet or enforce');
  }
  return input;
}

function writeLintReport(report: TrustedLintReport): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.accepted) process.exitCode = 1;
}

/** Runs the local/operator trust adapter without elevating its provenance to CI. */
export function writeLocalLintCommand(argv: string[], runtimeEntryPaths: string[]): void {
  const [, modeInput, kind, repository, revision, bindingPath, evidencePath] = argv;
  writeLintReport(
    lintTrustedCandidate({
      repository,
      candidate: candidateRequest(kind, revision),
      mode: lintMode(modeInput),
      bindingPath,
      evidencePath,
      runtimeEntryPaths,
      trustProvenance: 'local-operator',
    }),
  );
}

/** Runs CI only with the binding its caller preselected outside candidate input. */
export function writeCiLintCommand(argv: string[], runtimeEntryPaths: string[]): void {
  const [, kind, repository, revision, evidencePath] = argv;
  const bindingPath = process.env['TOOL_WIKI_CI_TRUSTED_BINDING'];
  if (bindingPath === undefined || bindingPath.length === 0) {
    throw new Error('CI trusted binding was not preselected by the caller');
  }
  writeLintReport(
    lintTrustedCandidate({
      repository,
      candidate: candidateRequest(kind, revision),
      bindingPath,
      evidencePath,
      runtimeEntryPaths,
      trustProvenance: 'ci-preselected',
      requiredScope: 'ci',
    }),
  );
}

/** Validates a new binding against exact historical and currently executable identities. */
export function writePolicyActivationCommand(argv: string[], runtimeEntryPaths: string[]): void {
  const [, repository, previousBindingPath, nextBindingPath] = argv;
  const previous = loadTrustedPolicy(previousBindingPath, repository);
  const next = loadTrustedPolicy(nextBindingPath, repository, runtimeEntryPaths);
  process.stdout.write(`${JSON.stringify(validateCompatibleActivation(previous, next))}\n`);
}
