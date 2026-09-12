import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

import { parseOrThrow } from '@wbs/validation';

import {
  CheckReceipt,
  type CheckReceipt as CheckReceiptValue,
  ReviewReceipt,
  type ReviewReceipt as ReviewReceiptValue,
} from '../contracts/records';
import { compareCanonicalText, hashBytes, hashCanonical } from '../evidence/content-manifest';
import type { CandidateEntry } from '../inventory/read-candidate';
import type { AuthorityGeneration, AuthorityStore } from './authority-store';
import { assertAdmissionPacket } from './packet';
import { type AdmissionPacket, decodeAdmissionPacketBody } from './packet-codec';
import type { AdmissionSubmissionReport } from './submit';

const Sha256 = /^[0-9a-f]{64}$/;
const Term = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface IntegrationContractRule {
  readonly contractId: string;
  readonly requiredConsumerInterfaceIds: readonly string[];
}

export type IntegrationSelectorRule =
  | {
      readonly kind: 'path';
      readonly path: string;
      readonly checks: readonly string[];
      readonly reviews: readonly string[];
    }
  | {
      readonly kind: 'prefix';
      readonly path: string;
      readonly checks: readonly string[];
      readonly reviews: readonly string[];
    };

export interface IntegrationPolicy {
  readonly schemaVersion: 1;
  readonly policyIdentity: string;
  readonly mappingIdentity: string;
  readonly contractRules: readonly IntegrationContractRule[];
  readonly selectorRules: readonly IntegrationSelectorRule[];
}

export interface SubmittedCandidate {
  readonly packet: AdmissionPacket;
  readonly patch: Uint8Array;
  readonly report: AdmissionSubmissionReport;
}

export interface IntegrationRequest {
  readonly policy: IntegrationPolicy;
  readonly submissions: readonly SubmittedCandidate[];
}

export interface IntegrationGenerationSnapshot {
  readonly sessionId: string;
  readonly generation: number;
  readonly status: 'submitted';
  readonly packetIdentity: string;
  readonly patchIdentity: string;
}

interface IntegrationCandidateBody {
  readonly schemaVersion: 1;
  readonly status: 'unchecked';
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly candidateTree: string;
  readonly contentManifestIdentity: string;
  readonly candidateDiffIdentity: string;
  readonly declarationIdentity: string;
  readonly policyIdentity: string;
  readonly mappingIdentity: string;
  readonly changedPaths: readonly string[];
  readonly selectedChecks: readonly string[];
  readonly selectedReviews: readonly string[];
  readonly submissions: readonly IntegrationGenerationSnapshot[];
  readonly publicationBoundary: '5.2 must atomically recheck authority and target ref before publication';
}

export interface UncheckedIntegrationCandidate extends IntegrationCandidateBody {
  readonly compositionIdentity: string;
}

export interface IntegrationEvidence {
  readonly candidateTree: string;
  readonly contentManifestIdentity: string;
  readonly candidateDiffIdentity: string;
  readonly declarationIdentity: string;
  readonly policyIdentity: string;
  readonly mappingIdentity: string;
  readonly selectedChecks: readonly string[];
  readonly selectedReviews: readonly string[];
  readonly checks: readonly { readonly checkId: string; readonly receipt: unknown }[];
  readonly reviews: readonly { readonly reviewId: string; readonly receipt: unknown }[];
}

export interface CheckedIntegrationCandidate extends Omit<IntegrationCandidateBody, 'status'> {
  readonly status: 'checked';
  readonly compositionIdentity: string;
  readonly evidenceIdentity: string;
  readonly checkReceipts: readonly CheckReceiptValue[];
  readonly reviewReceipts: readonly ReviewReceiptValue[];
}

function policyBody(policy: IntegrationPolicy): Omit<IntegrationPolicy, 'policyIdentity'> {
  const { policyIdentity: _identity, ...body } = policy;
  return body;
}

function runtimeField(input: object, field: string): unknown {
  return Reflect.get(input, field);
}

function assertFields(input: object, expected: readonly string[], subject: string): void {
  const actual = Object.keys(input).sort(compareCanonicalText);
  const canonical = [...expected].sort(compareCanonicalText);
  if (
    actual.length !== canonical.length ||
    actual.some((field, index) => field !== canonical[index])
  ) {
    throw new Error(`${subject} has undeclared or missing fields`);
  }
}

function assertTerms(values: readonly string[], subject: string): void {
  const sorted = [...values].sort(compareCanonicalText);
  for (let index = 0; index < sorted.length; index += 1) {
    const value = sorted[index];
    if (!Term.test(value)) throw new Error(`invalid integration ${subject}: ${value}`);
    if (index > 0 && sorted[index - 1] === value) {
      throw new Error(`duplicate integration ${subject}: ${value}`);
    }
  }
}

function assertUnique(values: readonly string[], subject: string): void {
  const sorted = [...values].sort(compareCanonicalText);
  if (sorted.some((value, index) => index > 0 && sorted[index - 1] === value)) {
    throw new Error(`duplicate integration ${subject}`);
  }
}

function assertRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    normalize(path) !== path ||
    path === '..' ||
    path.startsWith('../')
  ) {
    throw new Error(`invalid integration selector path: ${path}`);
  }
}

/** Strictly validates the externally selected policy and its self-authenticating bytes. */
export function assertIntegrationPolicy(policy: IntegrationPolicy): void {
  assertFields(
    policy,
    ['contractRules', 'mappingIdentity', 'policyIdentity', 'schemaVersion', 'selectorRules'],
    'integration policy',
  );
  if (runtimeField(policy, 'schemaVersion') !== 1) {
    throw new Error('invalid integration policy schema version');
  }
  if (!Sha256.test(policy.mappingIdentity)) throw new Error('invalid integration mapping identity');
  // Proof: accepting a caller label here let a candidate substitute a policy carrying no gate
  // selectors; `refuses caller-labelled weakened policy bytes before composition` failed with
  // `Received function did not throw` and showed only `check.gate` selected.
  if (
    !Sha256.test(policy.policyIdentity) ||
    hashCanonical(policyBody(policy)) !== policy.policyIdentity
  ) {
    throw new Error('integration policy identity mismatch');
  }
  const contracts = policy.contractRules.map(({ contractId }) => contractId);
  assertTerms(contracts, 'contract rule');
  for (const rule of policy.contractRules) {
    assertFields(rule, ['contractId', 'requiredConsumerInterfaceIds'], 'integration contract rule');
    assertTerms(rule.requiredConsumerInterfaceIds, 'required consumer interface');
  }
  const selectors = policy.selectorRules.map((rule) => `${rule.kind}:${rule.path}`);
  assertUnique(selectors, 'selector rule');
  for (const rule of policy.selectorRules) {
    assertFields(rule, ['checks', 'kind', 'path', 'reviews'], 'integration selector rule');
    assertRelativePath(rule.path);
    assertTerms(rule.checks, 'selected check');
    assertTerms(rule.reviews, 'selected review');
  }
}

interface GitOutput {
  readonly stdout: Uint8Array;
}

function git(
  repository: string,
  argv: readonly string[],
  context: string,
  options: { readonly index?: string; readonly stdin?: Uint8Array } = {},
): GitOutput {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    env:
      options.index === undefined
        ? undefined
        : { ...process.env, GIT_INDEX_FILE: options.index, GIT_OPTIONAL_LOCKS: '0' },
    stdin: options.stdin,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.toString('utf8').trim();
    throw new Error(
      `integration refused: ${context}: ${detail || `git exited ${String(invocation.exitCode)}`}`,
    );
  }
  return { stdout: invocation.stdout };
}

function gitIdentity(
  repository: string,
  argv: readonly string[],
  context: string,
  index?: string,
): string {
  const identity = new TextDecoder('utf-8', { fatal: true })
    .decode(git(repository, argv, context, { index }).stdout)
    .replace(/\n$/, '');
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(identity)) {
    throw new Error(`integration refused: ${context}: malformed object identity`);
  }
  return identity;
}

function parseTree(bytes: Uint8Array): CandidateEntry[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const records = text.split('\0');
  if (records.pop() !== '')
    throw new Error('integration refused: tree inventory is not NUL terminated');
  return records.map((record) => {
    const tab = record.indexOf('\t');
    const header = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (tab < 0 || header.length !== 3)
      throw new Error('integration refused: malformed tree tuple');
    const [mode, type, blob] = header;
    if (
      (mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') ||
      (type !== 'blob' && type !== 'commit') ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(blob)
    ) {
      throw new Error('integration refused: malformed tree tuple');
    }
    return { blob, mode, path };
  });
}

function readTree(repository: string, tree: string): CandidateEntry[] {
  return parseTree(
    git(repository, ['ls-tree', '-r', '-z', '--full-tree', tree], 'cannot inventory candidate tree')
      .stdout,
  );
}

function entryMap(entries: readonly CandidateEntry[]): Map<string, CandidateEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function entriesEqual(
  left: CandidateEntry | undefined,
  right: CandidateEntry | undefined,
): boolean {
  return left?.path === right?.path && left?.mode === right?.mode && left?.blob === right?.blob;
}

function differences(base: readonly CandidateEntry[], candidate: readonly CandidateEntry[]) {
  const before = entryMap(base);
  const after = entryMap(candidate);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareCanonicalText);
  const changedPaths: string[] = [];
  const tuples: unknown[] = [];
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (entriesEqual(oldEntry, newEntry)) continue;
    changedPaths.push(path);
    tuples.push({ after: newEntry ?? null, before: oldEntry ?? null, path });
  }
  return { changedPaths, identity: hashCanonical(tuples) };
}

function withTemporaryIndex<T>(repository: string, operation: (index: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'wiki-integration-index-'));
  try {
    return operation(join(directory, 'index'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function applyPatch(repository: string, index: string, patch: Uint8Array): void {
  git(
    repository,
    ['apply', '--cached', '--index', '--binary', '--whitespace=nowarn', '-'],
    'immutable submission patch cannot be applied',
    { index, stdin: patch },
  );
}

function verifyFrozenSubmission(
  repository: string,
  baseTree: string,
  baseEntries: readonly CandidateEntry[],
  submission: SubmittedCandidate,
): void {
  const frozen = submission.report;
  if (hashBytes(submission.patch) !== frozen.patchIdentity) {
    // Proof: omitting this exact-byte comparison let a caller replace a frozen patch with `broken`;
    // `refuses duplicate, stale, identity-mismatched and non-submitted inputs` received
    // `immutable submission patch cannot be applied`, not the required identity refusal.
    throw new Error('immutable submission patch identity mismatch');
  }
  withTemporaryIndex(repository, (index) => {
    git(repository, ['read-tree', baseTree], 'cannot initialize submission index', { index });
    applyPatch(repository, index, submission.patch);
    const tree = gitIdentity(repository, ['write-tree'], 'cannot freeze submission tree', index);
    const entries = readTree(repository, tree);
    const diff = differences(baseEntries, entries);
    const contentIdentity = hashCanonical({ entries, schemaVersion: 1, tree });
    // Proof: bypassing this tuple comparison let a report for one patch authenticate different
    // applicable bytes; `refuses authenticated patch application failure and frozen report
    // mismatch` failed with `Received function did not throw` and printed the unchecked tree.
    if (
      tree !== frozen.candidateTree ||
      diff.identity !== frozen.candidateDiffIdentity ||
      contentIdentity !== frozen.contentIdentity ||
      !sameStrings(diff.changedPaths, frozen.changedPaths)
    ) {
      throw new Error('immutable submission candidate identity mismatch');
    }
  });
}

function authorityGeneration(
  generations: readonly AuthorityGeneration[],
  packet: AdmissionPacket,
): AuthorityGeneration {
  const generation = generations.find(
    (record) => record.sessionId === packet.sessionId && record.generation === packet.generation,
  );
  if (generation === undefined) throw new Error('integration generation does not exist');
  // Proof: accepting a terminal record let rejected work enter composition; `refuses duplicate,
  // stale, identity-mismatched and non-submitted inputs` failed with `Received function did not
  // throw` and printed the rejected generation as submitted in an unchecked candidate.
  if (
    generation.status !== 'submitted' ||
    generation.submission === undefined ||
    generation.packet === undefined
  ) {
    throw new Error(`integration generation is not submitted: ${packet.sessionId}`);
  }
  const bound = decodeAdmissionPacketBody(
    generation.packet.packetIdentity,
    generation.packet.packetBytes,
  );
  assertAdmissionPacket(packet);
  // Proof: comparing only session/generation let caller-mutated packet bytes replace authority
  // bytes; `refuses a caller packet that differs from the authority-bound packet` failed with
  // `Received function did not throw` and printed the forged packet identity.
  if (bound.packetIdentity !== packet.packetIdentity)
    throw new Error('integration packet differs from authority binding');
  return generation;
}

function candidateBody(candidate: UncheckedIntegrationCandidate): IntegrationCandidateBody {
  const { compositionIdentity: _identity, ...body } = candidate;
  return body;
}

/** Composes exact submitted patches into an immutable, unchecked candidate tree. */
export function composeIntegrationCandidate(
  store: AuthorityStore,
  coordinatorRepository: string,
  request: IntegrationRequest,
): UncheckedIntegrationCandidate {
  assertIntegrationPolicy(request.policy);
  if (request.submissions.length < 1)
    throw new Error('integration requires at least one submission');
  const coordinator = realpathSync(coordinatorRepository);
  // One authority read prevents a composition from silently mixing generations observed on
  // opposite sides of a concurrent lifecycle transition. Slice 5.2 must still recheck this set.
  const authoritySnapshot = store.transact((transaction) => transaction.readState());
  const sessions = new Set<string>();
  let baseCommit: string | undefined;
  let baseTree: string | undefined;
  const snapshots: IntegrationGenerationSnapshot[] = [];
  for (const submission of request.submissions) {
    const packet = submission.packet;
    // Proof: bypassing duplicate-session refusal made `refuses duplicate, stale, identity-
    // mismatched and non-submitted inputs` receive `src/producer.ts: patch does not apply`.
    if (sessions.has(packet.sessionId))
      throw new Error(`duplicate integration session: ${packet.sessionId}`);
    sessions.add(packet.sessionId);
    // Proof: bypassing coordinator isolation made `refuses duplicate, stale, identity-mismatched
    // and non-submitted inputs` fail with `Received function did not throw` and print unchecked.
    if (packet.worktreePath === coordinator)
      throw new Error('coordinator cannot be a source writer worktree');
    // Proof: accepting a valid but differently selected policy made `refuses duplicate, stale,
    // identity-mismatched and non-submitted inputs` fail with `Received function did not throw`.
    if (packet.policyIdentity !== request.policy.policyIdentity)
      throw new Error('submission policy identity mismatch');
    // Proof: accepting a remapped packet made `refuses duplicate, stale, identity-mismatched and
    // non-submitted inputs` receive `integration packet differs from authority binding` instead.
    if (packet.mappingIdentity !== request.policy.mappingIdentity)
      throw new Error('submission mapping identity mismatch');
    if (
      baseCommit !== undefined &&
      (packet.base.commit !== baseCommit || packet.base.tree !== baseTree)
    ) {
      throw new Error('integration submissions do not share an exact base');
    }
    baseCommit = packet.base.commit;
    baseTree = packet.base.tree;
    const generation = authorityGeneration(authoritySnapshot.generations, packet);
    if (
      generation.submission?.patchIdentity !== submission.report.patchIdentity ||
      generation.submission.candidateDiffIdentity !== submission.report.candidateDiffIdentity ||
      generation.submission.contentIdentity !== submission.report.contentIdentity
    ) {
      throw new Error('integration submission differs from authority identity');
    }
    snapshots.push({
      generation: packet.generation,
      packetIdentity: packet.packetIdentity,
      patchIdentity: generation.submission.patchIdentity,
      sessionId: packet.sessionId,
      status: 'submitted',
    });
  }
  if (baseCommit === undefined || baseTree === undefined)
    throw new Error('integration base is absent');
  const resolvedTree = gitIdentity(
    coordinator,
    ['rev-parse', `${baseCommit}^{tree}`],
    'cannot resolve integration base',
  );
  if (resolvedTree !== baseTree)
    throw new Error('integration base commit differs from pinned tree');
  const baseEntries = readTree(coordinator, baseTree);
  for (const submission of request.submissions)
    verifyFrozenSubmission(coordinator, baseTree, baseEntries, submission);

  const ordered = [...request.submissions].sort((left, right) =>
    compareCanonicalText(left.packet.sessionId, right.packet.sessionId),
  );
  const candidateTree = withTemporaryIndex(coordinator, (index) => {
    git(coordinator, ['read-tree', baseTree], 'cannot initialize coordinator index', { index });
    for (const submission of ordered) applyPatch(coordinator, index, submission.patch);
    return gitIdentity(coordinator, ['write-tree'], 'cannot freeze combined candidate tree', index);
  });
  const entries = readTree(coordinator, candidateTree);
  const combinedDiff = differences(baseEntries, entries);
  const byPath = entryMap(entries);
  for (const submission of ordered) {
    for (const dependency of submission.packet.readDependencies) {
      // Proof: validating reads only against standalone submissions let another batch patch stale
      // the declared tuple; `refuses a stale read in the actual combined candidate` failed with
      // `Received function did not throw` and printed both changed paths in an unchecked tree.
      if (!entriesEqual(dependency, byPath.get(dependency.path))) {
        throw new Error(`integration read dependency changed: ${dependency.path}`);
      }
    }
  }
  const consumers = new Set(ordered.flatMap(({ packet }) => [...packet.consumedInterfaces]));
  for (const rule of request.policy.contractRules) {
    const produced = ordered.some(({ packet }) =>
      packet.producedContracts.includes(rule.contractId),
    );
    // Proof: bypassing this join admitted a contract-only producer; `requires a contract consumer
    // in the same batch` failed with `Received function did not throw` and printed its unchecked tree.
    if (
      produced &&
      rule.requiredConsumerInterfaceIds.some((consumer) => !consumers.has(consumer))
    ) {
      throw new Error(`required consumer is absent from integration batch: ${rule.contractId}`);
    }
  }
  const checks = new Set(ordered.flatMap(({ packet }) => [...packet.checks]));
  const reviews = new Set(ordered.flatMap(({ packet }) => [...packet.evidenceRequirements]));
  for (const rule of request.policy.selectorRules) {
    const affected = combinedDiff.changedPaths.some((path) =>
      rule.kind === 'path'
        ? path === rule.path
        : path === rule.path || path.startsWith(`${rule.path}/`),
    );
    // Proof: skipping matched selector rules made `reselects gate evidence and refuses standalone
    // or mismatched receipts` miss `check.trusted-gate` (`Expected - 1, Received + 0`).
    if (!affected) continue;
    for (const check of rule.checks) checks.add(check);
    for (const review of rule.reviews) reviews.add(review);
  }
  const body: IntegrationCandidateBody = {
    baseCommit,
    baseTree,
    candidateDiffIdentity: combinedDiff.identity,
    candidateTree,
    changedPaths: combinedDiff.changedPaths,
    contentManifestIdentity: hashCanonical({ entries, schemaVersion: 1, tree: candidateTree }),
    declarationIdentity: hashCanonical(
      ordered.map(({ packet }) => ({
        checks: packet.checks,
        consumedContracts: packet.consumedContracts,
        consumedInterfaces: packet.consumedInterfaces,
        evidenceRequirements: packet.evidenceRequirements,
        invariants: packet.invariants,
        producedContracts: packet.producedContracts,
        producedInterfaces: packet.producedInterfaces,
        sessionId: packet.sessionId,
      })),
    ),
    mappingIdentity: request.policy.mappingIdentity,
    policyIdentity: request.policy.policyIdentity,
    publicationBoundary: '5.2 must atomically recheck authority and target ref before publication',
    schemaVersion: 1,
    selectedChecks: [...checks].sort(compareCanonicalText),
    selectedReviews: [...reviews].sort(compareCanonicalText),
    status: 'unchecked',
    submissions: snapshots.sort((left, right) =>
      compareCanonicalText(left.sessionId, right.sessionId),
    ),
  };
  return { ...body, compositionIdentity: hashCanonical(body) };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Certifies an already-frozen candidate only with exact candidate-bound check and review receipts. */
export function certifyIntegrationCandidate(
  candidate: UncheckedIntegrationCandidate,
  evidence: IntegrationEvidence,
): CheckedIntegrationCandidate {
  // Proof: bypassing this self-authentication moved a tampered candidate to the later evidence
  // diagnostic; `certification requires the whole selected receipt set and exact review/check
  // bindings` received `evidence candidate binding mismatch`, not the candidate identity refusal.
  if (hashCanonical(candidateBody(candidate)) !== candidate.compositionIdentity) {
    throw new Error('unchecked integration candidate identity mismatch');
  }
  assertFields(
    evidence,
    [
      'candidateDiffIdentity',
      'candidateTree',
      'checks',
      'contentManifestIdentity',
      'declarationIdentity',
      'mappingIdentity',
      'policyIdentity',
      'reviews',
      'selectedChecks',
      'selectedReviews',
    ],
    'integration evidence',
  );
  const bindingMatches =
    evidence.candidateTree === candidate.candidateTree &&
    evidence.contentManifestIdentity === candidate.contentManifestIdentity &&
    evidence.candidateDiffIdentity === candidate.candidateDiffIdentity &&
    evidence.declarationIdentity === candidate.declarationIdentity &&
    evidence.policyIdentity === candidate.policyIdentity &&
    evidence.mappingIdentity === candidate.mappingIdentity &&
    sameStrings(evidence.selectedChecks, candidate.selectedChecks) &&
    sameStrings(evidence.selectedReviews, candidate.selectedReviews);
  // Proof: accepting a standalone manifest here let its successful receipts certify the combined
  // tree; `reselects gate evidence and refuses standalone or mismatched receipts` instead failed
  // later with `integration check receipt does not certify candidate: check.producer`.
  if (!bindingMatches) throw new Error('evidence candidate binding mismatch');
  const checks = new Map<string, CheckReceiptValue>();
  for (const entry of evidence.checks) {
    assertFields(entry, ['checkId', 'receipt'], 'integration check evidence');
    if (checks.has(entry.checkId))
      throw new Error(`duplicate integration check receipt: ${entry.checkId}`);
    const receipt = parseOrThrow(CheckReceipt, entry.receipt);
    // Proof: omitting candidateManifest/status checks let a standalone or skipped check satisfy
    // the final manifest; `certification requires the whole selected receipt set and exact
    // review/check bindings` failed with `Received function did not throw` and printed `skipped`.
    if (
      receipt.candidateManifest !== candidate.contentManifestIdentity ||
      receipt.status !== 'passed' ||
      receipt.exitCode !== 0 ||
      receipt.skips.length !== 0
    ) {
      throw new Error(`integration check receipt does not certify candidate: ${entry.checkId}`);
    }
    checks.set(entry.checkId, receipt);
  }
  const reviews = new Map<string, ReviewReceiptValue>();
  for (const entry of evidence.reviews) {
    assertFields(entry, ['receipt', 'reviewId'], 'integration review evidence');
    if (reviews.has(entry.reviewId))
      throw new Error(`duplicate integration review receipt: ${entry.reviewId}`);
    const receipt = parseOrThrow(ReviewReceipt, entry.receipt);
    // Proof: omitting the observed/supplied manifest binding let a review of the standalone tree
    // certify the combined tree; `certification requires the whole selected receipt set and exact
    // review/check bindings` failed with `Received function did not throw` and printed stale reads.
    if (
      !receipt.suppliedContextIds.includes(candidate.contentManifestIdentity) ||
      !receipt.observedReadIds.includes(candidate.contentManifestIdentity) ||
      receipt.trust.scope === 'local-cooperative'
    ) {
      throw new Error(`integration review receipt does not certify candidate: ${entry.reviewId}`);
    }
    reviews.set(entry.reviewId, receipt);
  }
  // Proof: bypassing completeness made `certification requires the whole selected receipt set and
  // exact review/check bindings` fail with `Received function did not throw` and print one receipt.
  if (!sameStrings([...checks.keys()].sort(compareCanonicalText), candidate.selectedChecks)) {
    throw new Error('integration check receipt set is incomplete');
  }
  // Proof: bypassing completeness made `certification requires the whole selected receipt set and
  // exact review/check bindings` fail with `Received function did not throw` and print one review.
  if (!sameStrings([...reviews.keys()].sort(compareCanonicalText), candidate.selectedReviews)) {
    throw new Error('integration review receipt set is incomplete');
  }
  const { status: _status, ...uncheckedBody } = candidateBody(candidate);
  return {
    ...uncheckedBody,
    checkReceipts: [...checks.entries()]
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([, receipt]) => receipt),
    compositionIdentity: candidate.compositionIdentity,
    evidenceIdentity: hashCanonical(evidence),
    reviewReceipts: [...reviews.entries()]
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([, receipt]) => receipt),
    status: 'checked',
  };
}
