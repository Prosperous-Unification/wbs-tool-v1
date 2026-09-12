import { realpathSync } from 'node:fs';

import { compareCanonicalText, hashBytes, hashCanonical } from '../evidence/content-manifest';
import type {
  AuthorityGeneration,
  AuthorityState,
  AuthorityStore,
  AuthorityTransaction,
  IntegrationQueueRecord,
  IntegrationQueueSubmission,
  IntegrationResourceRequirement,
} from './authority-store';
import { assertAuthorityTimestamp } from './authority-store';
import {
  assertCheckedIntegrationCandidate,
  type CheckedIntegrationCandidate,
  composeIntegrationCandidate,
  IntegrationPatchConflictError,
  type IntegrationRequest,
  recomposeIntegrationCandidate,
  type UncheckedIntegrationCandidate,
} from './integrate';

export const MAX_INTEGRATION_BATCH_SIZE = 4;
export const MAX_INTEGRATION_QUEUE_WAIT_MS = 5 * 60 * 1_000;
// Proof: raising this bound to four made `three failed certifications terminate` throw on a
// fourth persisted attempt instead of returning the expected `{attempts: 3, status: terminal}`.
export const MAX_INTEGRATION_ATTEMPTS = 3;

const GitObject = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const IntegrationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ResourceId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface IntegrationResourceProbeReceipt {
  readonly integrationId: string;
  readonly compositionIdentity: string;
  readonly requirementsIdentity: string;
  readonly probeIdentity: string;
  readonly unavailable: readonly IntegrationResourceRequirement[];
}

export interface IntegrationResourceProbe {
  /** Operator-provisioned probe; the coordinator validates its exact candidate/prerequisite receipt. */
  inspect(request: {
    readonly integrationId: string;
    readonly compositionIdentity: string;
    readonly requirements: readonly IntegrationResourceRequirement[];
    readonly requirementsIdentity: string;
  }): IntegrationResourceProbeReceipt | Promise<IntegrationResourceProbeReceipt>;
}

export interface IntegrationCandidateCertifier {
  certify(
    candidate: UncheckedIntegrationCandidate,
  ):
    | CheckedIntegrationCandidate
    | { readonly status: 'failed'; readonly reason: string }
    | Promise<CheckedIntegrationCandidate | { readonly status: 'failed'; readonly reason: string }>;
}

export interface IntegrationCoordinatorOptions {
  readonly integrationId: string;
  readonly targetRef: string;
  readonly resources: readonly IntegrationResourceRequirement[];
  readonly resourceProbe: IntegrationResourceProbe;
  readonly certifier: IntegrationCandidateCertifier;
  readonly commit: {
    readonly authorName: string;
    readonly authorEmail: string;
    readonly message: string;
  };
}

export interface IntegrationWaitingReport {
  readonly status: 'waiting';
  readonly integrationId: string;
  readonly reason: 'resources' | 'submission-reserved' | 'attempt-fenced' | 'publication-contended';
  readonly attempts: number;
  readonly queueTimeMs: number;
  readonly unavailableResources: readonly IntegrationResourceRequirement[];
  readonly fileClaimGenerations: readonly IntegrationQueueSubmission[];
  readonly blockingIntegrationIds: readonly string[];
}

export interface IntegrationTerminalReport {
  readonly status: 'terminal';
  readonly integrationId: string;
  readonly reason:
    'starvation' | 'attempts-exhausted' | 'candidate-refused' | 'incompatible-submission';
  readonly attempts: number;
  readonly reworkCount: number;
  readonly queueTimeMs: number;
}

export interface IntegrationPublishedReport {
  readonly status: 'integrated';
  readonly integrationId: string;
  readonly commit: string;
  readonly tree: string;
  readonly markerRef: string;
  readonly attempts: number;
  readonly reworkCount: number;
  readonly queueTimeMs: number;
}

export type IntegrationCoordinatorReport =
  IntegrationWaitingReport | IntegrationTerminalReport | IntegrationPublishedReport;

export type IntegrationCheckingRecord = IntegrationQueueRecord & {
  readonly status: 'checking';
  readonly attemptIdentity: string;
  readonly baseCommit: string;
  readonly candidateTree: string;
  readonly compositionIdentity: string;
};

export interface ReservedIntegrationPublication {
  readonly integrationId: string;
  readonly attemptIdentity: string;
  readonly targetRef: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly compositionIdentity: string;
  readonly markerRef: string;
  readonly submissions: readonly IntegrationQueueSubmission[];
}

class IntegrationGenerationChangedError extends Error {
  constructor(owner: string) {
    super(`integration generation changed before publication: ${owner}`);
    this.name = 'IntegrationGenerationChangedError';
  }
}

class IntegrationTargetMovedError extends Error {
  constructor() {
    super('integration target moved before publication');
    this.name = 'IntegrationTargetMovedError';
  }
}

class IntegrationAttemptChangedError extends Error {
  constructor(integrationId: string) {
    super(`integration attempt changed: ${integrationId}`);
    this.name = 'IntegrationAttemptChangedError';
  }
}

class IntegrationSubmissionReservedError extends Error {
  readonly blockingIntegrationIds: readonly string[];

  constructor(blockingIntegrationIds: readonly string[]) {
    super(`integration submissions are reserved by: ${blockingIntegrationIds.join(', ')}`);
    this.name = 'IntegrationSubmissionReservedError';
    this.blockingIntegrationIds = blockingIntegrationIds;
  }
}

function replaceIntegration(
  state: AuthorityState,
  replacement: IntegrationQueueRecord,
): AuthorityState {
  return {
    ...state,
    integrations: state.integrations.map((entry) =>
      entry.integrationId === replacement.integrationId ? replacement : entry,
    ),
  };
}

function latestTimestamp(state: AuthorityState): number {
  return Math.max(
    0,
    ...state.generations.flatMap((generation) => [generation.heartbeatAt, generation.statusAt]),
    ...state.integrations.flatMap((integration) => [integration.queuedAt, integration.statusAt]),
  );
}

function readTrustedTime(store: AuthorityStore, state: AuthorityState): number {
  const timestamp = store.readClock();
  assertAuthorityTimestamp(timestamp);
  if (timestamp < latestTimestamp(state)) throw new Error('authority clock regressed');
  return timestamp;
}

function queueSubmissions(request: IntegrationRequest): IntegrationQueueSubmission[] {
  return request.submissions
    .map(({ packet, patch, report }) => {
      if (hashBytes(patch) !== report.patchIdentity) {
        throw new Error('immutable submission patch identity mismatch');
      }
      return {
        generation: packet.generation,
        packetIdentity: packet.packetIdentity,
        patchIdentity: report.patchIdentity,
        sessionId: packet.sessionId,
      };
    })
    .sort((left, right) => compareCanonicalText(left.sessionId, right.sessionId));
}

function normalizeResources(
  resources: readonly IntegrationResourceRequirement[],
): IntegrationResourceRequirement[] {
  const normalized = resources
    .map((resource) => {
      if (!ResourceId.test(resource.identity)) {
        throw new Error(
          `invalid integration resource prerequisite: ${resource.kind}:${resource.identity}`,
        );
      }
      return { identity: resource.identity, kind: resource.kind };
    })
    .sort((left, right) =>
      compareCanonicalText(`${left.kind}:${left.identity}`, `${right.kind}:${right.identity}`),
    );
  for (let index = 1; index < normalized.length; index += 1) {
    if (
      normalized[index - 1]?.kind === normalized[index]?.kind &&
      normalized[index - 1]?.identity === normalized[index]?.identity
    ) {
      throw new Error('duplicate integration resource prerequisite');
    }
  }
  return normalized;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

function candidateQueueSubmissions(
  candidate: UncheckedIntegrationCandidate | CheckedIntegrationCandidate,
): readonly IntegrationQueueSubmission[] {
  return candidate.submissions.map(({ generation, packetIdentity, patchIdentity, sessionId }) => ({
    generation,
    packetIdentity,
    patchIdentity,
    sessionId,
  }));
}

function assertCandidateSubmissions(
  record: IntegrationQueueRecord,
  candidate: UncheckedIntegrationCandidate | CheckedIntegrationCandidate,
): void {
  if (!sameCanonical(record.submissions, candidateQueueSubmissions(candidate))) {
    throw new Error('integration candidate submissions differ from the durable queue');
  }
}

/** Durably enqueues an exact immutable submission batch. */
export function enqueueIntegration(
  store: AuthorityStore,
  request: IntegrationRequest,
  options: Pick<IntegrationCoordinatorOptions, 'integrationId' | 'targetRef' | 'resources'>,
): IntegrationQueueRecord {
  if (!IntegrationId.test(options.integrationId)) {
    throw new Error(`invalid integration id: ${options.integrationId}`);
  }
  // Proof: removing the upper bound made `queue caps batches` fail because the oversized request
  // reached persisted-state validation (`Received: invalid authority integration batch size`).
  if (request.submissions.length < 1 || request.submissions.length > MAX_INTEGRATION_BATCH_SIZE) {
    throw new Error(`integration batch exceeds ${String(MAX_INTEGRATION_BATCH_SIZE)} submissions`);
  }
  const submissions = queueSubmissions(request);
  const resources = normalizeResources(options.resources);
  return store.transact((transaction) => {
    const state = transaction.readState();
    const existing = state.integrations.find(
      (integration) => integration.integrationId === options.integrationId,
    );
    if (existing !== undefined) {
      if (
        existing.targetRef !== options.targetRef ||
        !sameCanonical(existing.submissions, submissions) ||
        !sameCanonical(existing.resources, resources)
      ) {
        throw new Error(
          `integration id already belongs to another request: ${options.integrationId}`,
        );
      }
      return existing;
    }
    const timestamp = readTrustedTime(store, state);
    const record: IntegrationQueueRecord = {
      attemptCount: 0,
      integrationId: options.integrationId,
      queuedAt: timestamp,
      resources,
      status: 'queued',
      statusAt: timestamp,
      submissions,
      targetRef: options.targetRef,
    };
    transaction.writeState({ ...state, integrations: [...state.integrations, record] });
    return record;
  });
}

function readRef(repository: string, reference: string): string | undefined {
  const presence = Bun.spawnSync(['git', '-C', repository, 'show-ref', '--exists', reference], {
    env: { ...process.env },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (presence.exitCode === 2) return undefined;
  // Proof: treating exit 1/128 as absence made `a malformed publication marker is not mistaken
  // for absence` return publication-contended and `a publication marker read failure preserves
  // the exact publishing reservation` advance to the unrelated commit oracle.
  if (presence.exitCode !== 0) {
    const detail = presence.stderr.toString('utf8').trim();
    throw new Error(
      `integration refused: cannot determine whether ${reference} exists: ${detail || `git exited ${String(presence.exitCode)}`}`,
    );
  }
  const invocation = Bun.spawnSync(
    ['git', '-C', repository, 'show-ref', '--verify', '--hash', reference],
    { env: { ...process.env }, stderr: 'pipe', stdout: 'pipe' },
  );
  // Proof: accepting this read failure after a positive existence query made `a marker
  // disappearing after exact existence proof is a read failure` continue past the ref boundary.
  if (invocation.exitCode !== 0) {
    throw new Error(
      `integration refused: cannot read ${reference}: ${invocation.stderr.toString('utf8').trim()}`,
    );
  }
  const output = invocation.stdout.toString('utf8');
  const identity = output.endsWith('\n') ? output.slice(0, -1) : output;
  if (!GitObject.test(identity)) throw new Error(`integration ref is malformed: ${reference}`);
  return identity;
}

function requireTargetRef(repository: string, targetRef: string): string {
  if (!targetRef.startsWith('refs/heads/')) {
    throw new Error(`integration target must be a branch ref: ${targetRef}`);
  }
  const format = Bun.spawnSync(['git', '-C', repository, 'check-ref-format', targetRef], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (format.exitCode !== 0) throw new Error(`invalid integration target ref: ${targetRef}`);
  const identity = readRef(repository, targetRef);
  if (identity === undefined) throw new Error(`integration target ref is absent: ${targetRef}`);
  return identity;
}

function markerRef(integrationId: string, targetRef: string): string {
  return `refs/wbs-wiki/publications/${hashCanonical({ integrationId, targetRef })}`;
}

function assertGenerationMatches(
  generations: readonly AuthorityGeneration[],
  expected: IntegrationQueueSubmission,
): AuthorityGeneration {
  const generation = generations.find(
    (entry) => entry.sessionId === expected.sessionId && entry.generation === expected.generation,
  );
  if (
    generation?.status !== 'submitted' ||
    generation.packet?.packetIdentity !== expected.packetIdentity ||
    generation.submission?.patchIdentity !== expected.patchIdentity
  ) {
    throw new IntegrationGenerationChangedError(
      `${expected.sessionId}/${String(expected.generation)}`,
    );
  }
  return generation;
}

/** Creates the checked tree's unattached commit without touching a worktree or ref. */
export function createIntegrationCommit(
  repository: string,
  candidate: CheckedIntegrationCandidate,
  integration: IntegrationQueueRecord,
  commit: IntegrationCoordinatorOptions['commit'],
): string {
  for (const [field, value] of Object.entries(commit)) {
    if (value.length === 0 || value.includes('\0') || value.includes('\n')) {
      throw new Error(`invalid integration commit ${field}`);
    }
  }
  const epochSeconds = Math.floor(integration.queuedAt / 1_000);
  const invocation = Bun.spawnSync(
    ['git', '-C', repository, 'commit-tree', candidate.candidateTree, '-p', candidate.baseCommit],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `@${String(epochSeconds)} +0000`,
        GIT_AUTHOR_EMAIL: commit.authorEmail,
        GIT_AUTHOR_NAME: commit.authorName,
        GIT_COMMITTER_DATE: `@${String(epochSeconds)} +0000`,
        GIT_COMMITTER_EMAIL: commit.authorEmail,
        GIT_COMMITTER_NAME: commit.authorName,
      },
      stdin: new TextEncoder().encode(`${commit.message}\n`),
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  if (invocation.exitCode !== 0) {
    throw new Error(
      `integration refused: cannot create commit: ${invocation.stderr.toString('utf8').trim()}`,
    );
  }
  const identity = invocation.stdout.toString('utf8').trimEnd();
  if (!GitObject.test(identity)) throw new Error('integration commit identity is malformed');
  return identity;
}

function assertCheckedMatches(
  checked: CheckedIntegrationCandidate,
  unchecked: UncheckedIntegrationCandidate,
): void {
  assertCheckedIntegrationCandidate(checked);
  if (
    checked.compositionIdentity !== unchecked.compositionIdentity ||
    checked.candidateTree !== unchecked.candidateTree ||
    checked.baseCommit !== unchecked.baseCommit ||
    checked.contentManifestIdentity !== unchecked.contentManifestIdentity
  ) {
    throw new Error('certifier returned a different integration candidate');
  }
}

function transition(
  store: AuthorityStore,
  integrationId: string,
  update: (record: IntegrationQueueRecord, timestamp: number) => IntegrationQueueRecord,
): IntegrationQueueRecord {
  return store.transact((transaction) => {
    const state = transaction.readState();
    const record = state.integrations.find((entry) => entry.integrationId === integrationId);
    if (record === undefined)
      throw new Error(`integration queue record is absent: ${integrationId}`);
    const timestamp = readTrustedTime(store, state);
    const replacement = update(record, timestamp);
    transaction.writeState(replaceIntegration(state, replacement));
    return replacement;
  });
}

function readIntegration(store: AuthorityStore, integrationId: string): IntegrationQueueRecord {
  return store.transact((transaction) => {
    const record = transaction
      .readState()
      .integrations.find((integration) => integration.integrationId === integrationId);
    if (record === undefined)
      throw new Error(`integration queue record is absent: ${integrationId}`);
    return record;
  });
}

function terminal(
  store: AuthorityStore,
  expected: IntegrationQueueRecord,
  reason: IntegrationTerminalReport['reason'],
): IntegrationTerminalReport {
  const record = transition(store, expected.integrationId, (current, timestamp) => {
    if (
      current.status !== expected.status ||
      current.attemptCount !== expected.attemptCount ||
      current.attemptIdentity !== expected.attemptIdentity
    ) {
      throw new IntegrationAttemptChangedError(expected.integrationId);
    }
    return {
      ...current,
      attemptIdentity: undefined,
      baseCommit: undefined,
      candidateCommit: undefined,
      candidateTree: undefined,
      compositionIdentity: undefined,
      markerRef: undefined,
      status: 'terminal',
      statusAt: timestamp,
      terminalReason: reason,
    };
  });
  return {
    attempts: record.attemptCount,
    integrationId: expected.integrationId,
    queueTimeMs: record.statusAt - record.queuedAt,
    reason,
    reworkCount: Math.max(0, record.attemptCount - 1),
    status: 'terminal',
  };
}

/** Records the exact candidate whose trusted checks are about to run. */
export function recordIntegrationCheck(
  store: AuthorityStore,
  integrationId: string,
  candidate: UncheckedIntegrationCandidate,
): IntegrationCheckingRecord {
  return store.transact((transaction) => {
    const state = transaction.readState();
    const current = state.integrations.find(
      (integration) => integration.integrationId === integrationId,
    );
    if (current === undefined) {
      throw new Error(`integration queue record is absent: ${integrationId}`);
    }
    const timestamp = readTrustedTime(store, state);
    if (current.status !== 'queued' && current.status !== 'rework') {
      throw new Error(`integration cannot start checks from ${current.status}: ${integrationId}`);
    }
    // Proof: omitting this exact tuple comparison let `the complete candidate submission set must
    // match the durable queue before checks and publication` record candidate two against the
    // queue for candidate one (`Received function did not throw`).
    assertCandidateSubmissions(current, candidate);
    if (current.attemptCount >= MAX_INTEGRATION_ATTEMPTS) {
      throw new Error(`integration attempt budget exhausted: ${integrationId}`);
    }
    const submissionOwners = new Set(
      current.submissions.map(
        (submission) => `${submission.sessionId}/${String(submission.generation)}`,
      ),
    );
    const blockingIntegrationIds = state.integrations
      .filter(
        (integration) =>
          integration.integrationId !== integrationId &&
          (integration.status === 'checking' || integration.status === 'publishing') &&
          integration.submissions.some((submission) =>
            submissionOwners.has(`${submission.sessionId}/${String(submission.generation)}`),
          ),
      )
      .map(({ integrationId: blockingId }) => blockingId)
      .sort(compareCanonicalText);
    // Proof: omitting this same-transaction owner check made `one checking integration fences an
    // overlapping integration` publish the competing integration and spend its first attempt.
    if (blockingIntegrationIds.length !== 0) {
      throw new IntegrationSubmissionReservedError(blockingIntegrationIds);
    }
    const attemptCount = current.attemptCount + 1;
    // This transaction derives the identity from its serialized attempt; no coordinator supplies
    // an identity that the authority could mistake for ownership.
    const attemptIdentity = hashCanonical({
      attemptCount,
      baseCommit: candidate.baseCommit,
      candidateTree: candidate.candidateTree,
      compositionIdentity: candidate.compositionIdentity,
      integrationId,
      statusAt: timestamp,
    });
    const checking: IntegrationCheckingRecord = {
      ...current,
      attemptCount,
      attemptIdentity,
      baseCommit: candidate.baseCommit,
      candidateTree: candidate.candidateTree,
      compositionIdentity: candidate.compositionIdentity,
      status: 'checking',
      statusAt: timestamp,
    };
    transaction.writeState(replaceIntegration(state, checking));
    return checking;
  });
}

function assertIntegrationCommit(
  repository: string,
  candidateCommit: string,
  candidateTree: string,
  baseCommit: string,
): void {
  const treeInvocation = Bun.spawnSync(
    ['git', '-C', repository, 'rev-parse', '--verify', `${candidateCommit}^{tree}`],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  const treeOutput = treeInvocation.stdout.toString('utf8');
  const tree = treeOutput.endsWith('\n') ? treeOutput.slice(0, -1) : treeOutput;
  const invocation = Bun.spawnSync(
    ['git', '-C', repository, 'rev-list', '--parents', '-n', '1', candidateCommit],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  const ancestry = invocation.stdout.toString('utf8').trimEnd().split(' ');
  // Proof: removing this oracle made `a wrong-tree or extra-parent candidate commit is refused
  // before refs or lifecycle change` reserve commits with the wrong tree or a second parent.
  if (
    treeInvocation.exitCode !== 0 ||
    !GitObject.test(tree) ||
    invocation.exitCode !== 0 ||
    tree !== candidateTree ||
    ancestry.length !== 2 ||
    ancestry[0] !== candidateCommit ||
    ancestry[1] !== baseCommit
  ) {
    throw new Error('integration commit differs from the checked candidate');
  }
}

/** Reserves one checked candidate after the final authority and target-base recheck. */
export function reserveIntegrationPublication(
  store: AuthorityStore,
  coordinatorRepository: string,
  checked: CheckedIntegrationCandidate,
  candidateCommit: string,
  integrationId: string,
  attemptIdentity: string,
): ReservedIntegrationPublication {
  assertCheckedIntegrationCandidate(checked);
  const repository = realpathSync(coordinatorRepository);
  assertIntegrationCommit(repository, candidateCommit, checked.candidateTree, checked.baseCommit);
  return store.transact((transaction) => {
    const state = transaction.readState();
    const record = state.integrations.find((entry) => entry.integrationId === integrationId);
    if (
      record?.status !== 'checking' ||
      // Proof: omitting this attempt fence made `a stale attempt identity cannot reserve an equal
      // checked candidate` return a publishing reservation for attempt one over attempt two.
      record.attemptIdentity !== attemptIdentity ||
      record.baseCommit !== checked.baseCommit ||
      record.candidateTree !== checked.candidateTree ||
      record.compositionIdentity !== checked.compositionIdentity
    ) {
      throw new Error(`integration is not checking this candidate: ${integrationId}`);
    }
    // Proof: omitting this repeated binding let the complete-submission-set test reserve candidate
    // one after the durable checking queue was replaced with candidate two (`Received function did
    // not throw`), before either Git ref or the lifecycle changed.
    assertCandidateSubmissions(record, checked);
    // Proof: bypassing this final generation recheck together with the persisted publishing-state
    // invariant made `terminal generation transition while checks are held` reach finalization and
    // fail on `integration generation changed before publication: one/1` after updating the ref.
    for (const submission of record.submissions) {
      assertGenerationMatches(state.generations, submission);
    }
    const target = requireTargetRef(repository, record.targetRef);
    // Proof: bypassing this recheck together with the update-ref old-object guard made `target
    // advance while checks are held` fail on `Expected: 2, Received: 1`: the stale checked tree
    // published without a recomposition attempt.
    if (target !== checked.baseCommit) throw new IntegrationTargetMovedError();
    const publicationMarker = markerRef(integrationId, record.targetRef);
    // Proof: removing this refusal made `a preexisting private publication marker cannot
    // collide with a new reservation` return a reservation over the occupied marker.
    if (readRef(repository, publicationMarker) !== undefined) {
      throw new Error(`integration publication marker already exists: ${publicationMarker}`);
    }
    const timestamp = readTrustedTime(store, state);
    const publishing: IntegrationQueueRecord = {
      ...record,
      candidateCommit,
      markerRef: publicationMarker,
      status: 'publishing',
      statusAt: timestamp,
    };
    transaction.writeState(replaceIntegration(state, publishing));
    return {
      attemptIdentity,
      baseCommit: checked.baseCommit,
      candidateCommit,
      candidateTree: checked.candidateTree,
      compositionIdentity: checked.compositionIdentity,
      integrationId,
      markerRef: publicationMarker,
      submissions: record.submissions,
      targetRef: record.targetRef,
    };
  });
}

/** Recognizes only Git's C-locale diagnostic for a held loose-ref lock. */
function isLooseRefLockContention(detail: string): boolean {
  return /^fatal: (?:prepare: )?cannot lock ref '[^']+': Unable to create '.+\.lock': File exists\./.test(
    detail,
  );
}

function updateRefs(repository: string, reserved: ReservedIntegrationPublication): boolean {
  const commands = [
    'start',
    // Proof: removing this old object guard together with the final base recheck made `target
    // advance while checks are held` fail on `Expected: 2, Received: 1`, publishing attempt one.
    `update ${reserved.targetRef} ${reserved.candidateCommit} ${reserved.baseCommit}`,
    // Proof: omitting this command made `immutable marker proves publication across a crash`
    // fail on `published integration commit differs from the checked candidate` after the target
    // advanced, so target position alone could not prove the earlier CAS.
    `create ${reserved.markerRef} ${reserved.candidateCommit}`,
    'prepare',
    'commit',
    '',
  ].join('\n');
  const invocation = Bun.spawnSync(['git', '-C', repository, 'update-ref', '--stdin'], {
    env: { ...process.env, LC_ALL: 'C' },
    stdin: new TextEncoder().encode(commands),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode === 0) return true;
  const marker = readRef(repository, reserved.markerRef);
  if (marker === reserved.candidateCommit) return true;
  if (marker !== undefined) {
    // Proof: returning an ordinary CAS miss here made `a mismatched publication marker after
    // reservation is refused` fail on `Received function did not throw; Received value: false`.
    throw new Error(`integration publication marker mismatch: ${reserved.markerRef}`);
  }
  if (requireTargetRef(repository, reserved.targetRef) !== reserved.baseCommit) return false;
  const detail = invocation.stderr.toString('utf8').trim();
  if (isLooseRefLockContention(detail)) return false;
  // Proof: treating every failed update with an absent marker and unchanged target as contention
  // made `a rejecting Git publication hook preserves the exact reservation and throws` return
  // `publication-contended`; `Received function did not throw`.
  throw new Error(
    `integration refused: cannot atomically publish integration refs: ${detail || `git exited ${String(invocation.exitCode)}`}`,
  );
}

function assertReservationMatches(
  integration: IntegrationQueueRecord | undefined,
  reserved: ReservedIntegrationPublication,
  status: 'publishing' | 'published',
): asserts integration is IntegrationQueueRecord {
  // Proof: in `a crafted reservation cannot redirect publication or substitute its checked tree`,
  // omitting targetRef returned integrated after moving `refs/heads/other`; omitting candidateTree
  // reached the later commit diagnostic; omitting attemptIdentity returned integrated as attempt
  // 0; omitting submissions returned integrated with an empty reserved tuple.
  if (
    integration?.status !== status ||
    integration.integrationId !== reserved.integrationId ||
    integration.attemptIdentity !== reserved.attemptIdentity ||
    integration.targetRef !== reserved.targetRef ||
    integration.candidateCommit !== reserved.candidateCommit ||
    integration.markerRef !== reserved.markerRef ||
    integration.baseCommit !== reserved.baseCommit ||
    integration.candidateTree !== reserved.candidateTree ||
    integration.compositionIdentity !== reserved.compositionIdentity ||
    !sameCanonical(integration.submissions, reserved.submissions)
  ) {
    throw new Error(`integration publication reservation changed: ${reserved.integrationId}`);
  }
}

function assertPublishedCommit(repository: string, reserved: ReservedIntegrationPublication): void {
  const marker = readRef(repository, reserved.markerRef);
  assertIntegrationCommit(
    repository,
    reserved.candidateCommit,
    reserved.candidateTree,
    reserved.baseCommit,
  );
  // Proof: omitting the marker comparison made `immutable marker proves publication across a
  // crash` finalize a target-only publication after the marker was absent.
  if (marker !== reserved.candidateCommit) {
    throw new Error('published integration commit differs from the checked candidate');
  }
}

function publishedReport(
  record: IntegrationQueueRecord,
  reserved: ReservedIntegrationPublication,
): IntegrationPublishedReport {
  return {
    attempts: record.attemptCount,
    commit: reserved.candidateCommit,
    integrationId: reserved.integrationId,
    markerRef: reserved.markerRef,
    queueTimeMs: record.statusAt - record.queuedAt,
    reworkCount: Math.max(0, record.attemptCount - 1),
    status: 'integrated',
    tree: reserved.candidateTree,
  };
}

function starvationReport(record: IntegrationQueueRecord): IntegrationTerminalReport {
  return {
    attempts: record.attemptCount,
    integrationId: record.integrationId,
    queueTimeMs: record.statusAt - record.queuedAt,
    reason: 'starvation',
    reworkCount: Math.max(0, record.attemptCount - 1),
    status: 'terminal',
  };
}

function publicationWaitingReport(
  record: IntegrationQueueRecord,
  timestamp: number,
): IntegrationWaitingReport {
  return {
    attempts: record.attemptCount,
    blockingIntegrationIds: [],
    fileClaimGenerations: record.submissions,
    integrationId: record.integrationId,
    queueTimeMs: timestamp - record.queuedAt,
    reason: 'publication-contended',
    status: 'waiting',
    unavailableResources: [],
  };
}

function finalizePublication(
  store: AuthorityStore,
  transaction: AuthorityTransaction,
  state: AuthorityState,
  integration: IntegrationQueueRecord,
  reserved: ReservedIntegrationPublication,
): IntegrationPublishedReport {
  for (const submission of integration.submissions) {
    assertGenerationMatches(state.generations, submission);
  }
  const timestamp = readTrustedTime(store, state);
  const owners = new Set(
    integration.submissions.map(
      (submission) => `${submission.sessionId}/${String(submission.generation)}`,
    ),
  );
  const generations = state.generations.map((generation): AuthorityGeneration =>
    owners.has(`${generation.sessionId}/${String(generation.generation)}`)
      ? { ...generation, claims: [], status: 'integrated', statusAt: timestamp }
      : generation,
  );
  const published: IntegrationQueueRecord = {
    ...integration,
    status: 'published',
    statusAt: timestamp,
  };
  transaction.writeState({
    ...replaceIntegration(state, published),
    generations,
  });
  return publishedReport(published, reserved);
}

function starvePublication(
  transaction: AuthorityTransaction,
  state: AuthorityState,
  integration: IntegrationQueueRecord,
  timestamp: number,
): IntegrationTerminalReport {
  const starved: IntegrationQueueRecord = {
    ...clearCandidate(integration, 'terminal', timestamp),
    terminalReason: 'starvation',
  };
  transaction.writeState(replaceIntegration(state, starved));
  return starvationReport(starved);
}

/** Finalizes a marker-proven publication, even when the target subsequently advanced. */
export function finalizeIntegrationPublication(
  store: AuthorityStore,
  coordinatorRepository: string,
  reserved: ReservedIntegrationPublication,
): IntegrationPublishedReport {
  const repository = realpathSync(coordinatorRepository);
  return store.transactPublication((transaction) => {
    const state = transaction.readState();
    const integration = state.integrations.find(
      (entry) => entry.integrationId === reserved.integrationId,
    );
    assertReservationMatches(integration, reserved, 'publishing');
    assertPublishedCommit(repository, reserved);
    return finalizePublication(store, transaction, state, integration, reserved);
  });
}

/** Atomically publishes the target and durable marker refs, then finalizes authority lifecycle. */
export function publishReservedIntegration(
  store: AuthorityStore,
  coordinatorRepository: string,
  reserved: ReservedIntegrationPublication,
): IntegrationCoordinatorReport | undefined {
  const repository = realpathSync(coordinatorRepository);
  // Proof: splitting this reservation validation, Git transaction and lifecycle decision let the
  // prepared-ref race's second process clear `publishing`; the first publisher then failed on
  // `integration publication reservation changed: prepared-publication` after Git committed.
  return store.transactPublication((transaction) => {
    const state = transaction.readState();
    const integration = state.integrations.find(
      (entry) => entry.integrationId === reserved.integrationId,
    );
    if (integration?.status === 'published') {
      assertReservationMatches(integration, reserved, 'published');
      assertPublishedCommit(repository, reserved);
      return publishedReport(integration, reserved);
    }
    assertReservationMatches(integration, reserved, 'publishing');
    const existingMarker = readRef(repository, reserved.markerRef);
    if (existingMarker !== undefined && existingMarker !== reserved.candidateCommit) {
      throw new Error(`integration publication marker mismatch: ${reserved.markerRef}`);
    }
    // Proof: enforcing the deadline before this marker recovery made `publishing recovery checks
    // an immutable marker before enforcing the refreshed deadline` return terminal starvation at
    // 600000ms where it expected the marker-proven commit to be integrated.
    if (existingMarker === reserved.candidateCommit) {
      assertIntegrationCommit(
        repository,
        reserved.candidateCommit,
        reserved.candidateTree,
        reserved.baseCommit,
      );
      return finalizePublication(store, transaction, state, integration, reserved);
    }

    assertIntegrationCommit(
      repository,
      reserved.candidateCommit,
      reserved.candidateTree,
      reserved.baseCommit,
    );
    const beforeCas = readTrustedTime(store, state);
    // Proof: publishing without this marker-first deadline refresh made `publishing recovery checks
    // an immutable marker before enforcing the refreshed deadline` advance the target and return
    // integrated at 600000ms instead of terminal starvation with both refs untouched.
    if (beforeCas - integration.queuedAt >= MAX_INTEGRATION_QUEUE_WAIT_MS) {
      return starvePublication(transaction, state, integration, beforeCas);
    }
    if (updateRefs(repository, reserved)) {
      return finalizePublication(store, transaction, state, integration, reserved);
    }

    const markerAfterFailure = readRef(repository, reserved.markerRef);
    if (markerAfterFailure !== undefined) {
      if (markerAfterFailure !== reserved.candidateCommit) {
        throw new Error(`integration publication marker mismatch: ${reserved.markerRef}`);
      }
      assertIntegrationCommit(
        repository,
        reserved.candidateCommit,
        reserved.candidateTree,
        reserved.baseCommit,
      );
      return finalizePublication(store, transaction, state, integration, reserved);
    }
    const afterFailure = readTrustedTime(store, state);
    if (afterFailure - integration.queuedAt >= MAX_INTEGRATION_QUEUE_WAIT_MS) {
      return starvePublication(transaction, state, integration, afterFailure);
    }
    if (requireTargetRef(repository, reserved.targetRef) === reserved.baseCommit) {
      // Proof: clearing this exact attempt on an ordinary Git lock failure made `an eligible
      // publisher retains its exact attempt across Git ref contention` spend all three attempts
      // and terminalize instead of returning publication-contended with status publishing.
      return publicationWaitingReport(integration, afterFailure);
    }
    transaction.writeState(
      replaceIntegration(state, clearCandidate(integration, 'rework', afterFailure)),
    );
    return undefined;
  });
}

/**
 * Atomically CAS-updates refs while deliberately retaining `publishing` for crash-recovery tests.
 */
export function publishIntegrationRefs(
  store: AuthorityStore,
  coordinatorRepository: string,
  reserved: ReservedIntegrationPublication,
): boolean {
  const repository = realpathSync(coordinatorRepository);
  return store.transactPublication((transaction) => {
    const state = transaction.readState();
    const integration = state.integrations.find(
      (entry) => entry.integrationId === reserved.integrationId,
    );
    assertReservationMatches(integration, reserved, 'publishing');
    const existingMarker = readRef(repository, reserved.markerRef);
    if (existingMarker !== undefined) {
      if (existingMarker !== reserved.candidateCommit) {
        throw new Error(`integration publication marker mismatch: ${reserved.markerRef}`);
      }
      assertIntegrationCommit(
        repository,
        reserved.candidateCommit,
        reserved.candidateTree,
        reserved.baseCommit,
      );
      return true;
    }
    assertIntegrationCommit(
      repository,
      reserved.candidateCommit,
      reserved.candidateTree,
      reserved.baseCommit,
    );
    const beforeCas = readTrustedTime(store, state);
    if (beforeCas - integration.queuedAt >= MAX_INTEGRATION_QUEUE_WAIT_MS) {
      starvePublication(transaction, state, integration, beforeCas);
      return false;
    }
    return updateRefs(repository, reserved);
  });
}

async function unavailableResources(
  probe: IntegrationResourceProbe,
  integrationId: string,
  resources: readonly IntegrationResourceRequirement[],
  compositionIdentity: string,
): Promise<readonly IntegrationResourceRequirement[]> {
  const requirementsIdentity = hashCanonical(resources);
  const receipt = await probe.inspect({
    compositionIdentity,
    integrationId,
    requirements: resources,
    requirementsIdentity,
  });
  if (
    receipt.integrationId !== integrationId ||
    // Proof: omitting this comparison made `resource probe receipts must bind the exact separately
    // modeled prerequisites` resolve the forged-candidate probe instead of rejecting it.
    receipt.compositionIdentity !== compositionIdentity ||
    // Proof: omitting this identity comparison made `resource probe receipts must bind the exact
    // separately modeled prerequisites` resolve the forged-prerequisite probe successfully.
    receipt.requirementsIdentity !== requirementsIdentity ||
    !/^[0-9a-f]{64}$/.test(receipt.probeIdentity)
  ) {
    throw new Error('resource probe receipt does not bind the integration prerequisites');
  }
  const unavailable = normalizeResources(receipt.unavailable);
  if (
    unavailable.some((resource) => !resources.some((required) => sameCanonical(resource, required)))
  ) {
    throw new Error('resource probe reported an undeclared prerequisite');
  }
  return unavailable;
}

function isSameAttempt(current: IntegrationQueueRecord, expected: IntegrationQueueRecord): boolean {
  return (
    current.status === expected.status &&
    current.attemptCount === expected.attemptCount &&
    current.attemptIdentity === expected.attemptIdentity
  );
}

function clearCandidate(
  record: IntegrationQueueRecord,
  status: 'rework' | 'terminal',
  timestamp: number,
): IntegrationQueueRecord {
  return {
    ...record,
    attemptIdentity: undefined,
    baseCommit: undefined,
    candidateCommit: undefined,
    candidateTree: undefined,
    compositionIdentity: undefined,
    markerRef: undefined,
    status,
    statusAt: timestamp,
  };
}

/** Releases only the exact active attempt for bounded rework or checking-crash recovery. */
export function recordIntegrationRework(
  store: AuthorityStore,
  expected: IntegrationQueueRecord,
): IntegrationQueueRecord {
  return transition(store, expected.integrationId, (record, timestamp) => {
    // Proof: without this boundary `a publication reservation fences terminal lifecycle changes`
    // cleared a live publishing owner through the ordinary replayable transaction path (`Received
    // function did not throw`) instead of throwing `publishing rework requires serialized recovery`.
    if (record.status === 'publishing' || expected.status === 'publishing') {
      throw new Error('publishing rework requires serialized recovery');
    }
    // Proof: omitting the exact attempt comparison made `a stale attempt identity cannot reserve
    // an equal checked candidate` clear live attempt two when passed stale attempt one.
    if (!isSameAttempt(record, expected)) {
      throw new IntegrationAttemptChangedError(expected.integrationId);
    }
    return clearCandidate(record, 'rework', timestamp);
  });
}

function queueReport(
  store: AuthorityStore,
  integrationId: string,
  reason: IntegrationWaitingReport['reason'],
  blockingIntegrationIds: readonly string[],
  unavailableResources: readonly IntegrationResourceRequirement[],
): IntegrationWaitingReport {
  return store.transact((transaction) => {
    const state = transaction.readState();
    const record = state.integrations.find(
      (integration) => integration.integrationId === integrationId,
    );
    if (record === undefined)
      throw new Error(`integration queue record is absent: ${integrationId}`);
    const timestamp = readTrustedTime(store, state);
    return {
      attempts: record.attemptCount,
      blockingIntegrationIds,
      fileClaimGenerations: record.submissions,
      integrationId,
      queueTimeMs: timestamp - record.queuedAt,
      reason,
      status: 'waiting',
      unavailableResources,
    };
  });
}

function terminalIfStarved(
  store: AuthorityStore,
  expected: IntegrationQueueRecord,
): IntegrationTerminalReport | undefined {
  const record = store.transact((transaction) => {
    const state = transaction.readState();
    const current = state.integrations.find(
      (integration) => integration.integrationId === expected.integrationId,
    );
    if (current === undefined) {
      throw new Error(`integration queue record is absent: ${expected.integrationId}`);
    }
    if (!isSameAttempt(current, expected)) {
      throw new IntegrationAttemptChangedError(expected.integrationId);
    }
    const timestamp = readTrustedTime(store, state);
    if (timestamp - current.queuedAt < MAX_INTEGRATION_QUEUE_WAIT_MS) return undefined;
    // Proof: omitting this refreshed transition made `held resource and certification runtime
    // count toward the trusted queue deadline` publish after an awaited operation crossed five
    // minutes.
    const starved = {
      ...clearCandidate(current, 'terminal', timestamp),
      terminalReason: 'starvation',
    };
    transaction.writeState(replaceIntegration(state, starved));
    return starved;
  });
  if (record === undefined) return undefined;
  return {
    attempts: record.attemptCount,
    integrationId: record.integrationId,
    queueTimeMs: record.statusAt - record.queuedAt,
    reason: 'starvation',
    reworkCount: Math.max(0, record.attemptCount - 1),
    status: 'terminal',
  };
}

function blockingIntegrationIds(
  store: AuthorityStore,
  record: IntegrationQueueRecord,
): readonly string[] {
  return store.transact((transaction) => {
    const state = transaction.readState();
    const owners = new Set(
      record.submissions.map(
        (submission) => `${submission.sessionId}/${String(submission.generation)}`,
      ),
    );
    return state.integrations
      .filter(
        (integration) =>
          integration.integrationId !== record.integrationId &&
          (integration.status === 'checking' || integration.status === 'publishing') &&
          integration.submissions.some((submission) =>
            owners.has(`${submission.sessionId}/${String(submission.generation)}`),
          ),
      )
      .map(({ integrationId }) => integrationId)
      .sort(compareCanonicalText);
  });
}

function assertSubmittedGenerations(store: AuthorityStore, record: IntegrationQueueRecord): void {
  store.transact((transaction) => {
    const state = transaction.readState();
    // Proof: omitting this pre-composition generation check made `a crashed publisher fences an
    // overlapping integration until exact recovery` throw from Git apply after the owner finalized,
    // leaving the queued competitor without its modeled terminal outcome.
    for (const submission of record.submissions) {
      assertGenerationMatches(state.generations, submission);
    }
  });
}

/**
 * Integrates exact submitted bytes with a three-attempt recovery budget.
 *
 * Four submissions, five minutes and three attempts are initial policy assumptions for the
 * experiment, not claims that those limits are universally optimal.
 */
export async function integrateWithRecovery(
  store: AuthorityStore,
  coordinatorRepository: string,
  request: IntegrationRequest,
  options: IntegrationCoordinatorOptions,
): Promise<IntegrationCoordinatorReport> {
  const repository = realpathSync(coordinatorRepository);
  requireTargetRef(repository, options.targetRef);
  let record = enqueueIntegration(store, request, options);
  if (record.status === 'published') {
    if (
      record.attemptIdentity === undefined ||
      record.candidateCommit === undefined ||
      record.candidateTree === undefined ||
      record.markerRef === undefined ||
      record.baseCommit === undefined ||
      record.compositionIdentity === undefined
    ) {
      throw new Error('published integration record is incomplete');
    }
    assertPublishedCommit(repository, {
      attemptIdentity: record.attemptIdentity,
      baseCommit: record.baseCommit,
      candidateCommit: record.candidateCommit,
      candidateTree: record.candidateTree,
      compositionIdentity: record.compositionIdentity,
      integrationId: record.integrationId,
      markerRef: record.markerRef,
      submissions: record.submissions,
      targetRef: record.targetRef,
    });
    return {
      attempts: record.attemptCount,
      commit: record.candidateCommit,
      integrationId: record.integrationId,
      markerRef: record.markerRef,
      queueTimeMs: record.statusAt - record.queuedAt,
      reworkCount: Math.max(0, record.attemptCount - 1),
      status: 'integrated',
      tree: record.candidateTree,
    };
  }
  if (record.status === 'terminal') {
    const reason = record.terminalReason;
    if (
      reason !== 'starvation' &&
      reason !== 'attempts-exhausted' &&
      reason !== 'candidate-refused' &&
      reason !== 'incompatible-submission'
    ) {
      throw new Error('terminal integration reason is invalid');
    }
    return {
      attempts: record.attemptCount,
      integrationId: record.integrationId,
      queueTimeMs: record.statusAt - record.queuedAt,
      reason,
      reworkCount: Math.max(0, record.attemptCount - 1),
      status: 'terminal',
    };
  }
  if (record.status === 'publishing') {
    if (
      record.attemptIdentity === undefined ||
      record.baseCommit === undefined ||
      record.candidateCommit === undefined ||
      record.candidateTree === undefined ||
      record.compositionIdentity === undefined ||
      record.markerRef === undefined
    ) {
      throw new Error('publishing integration record is incomplete');
    }
    const recovered = publishReservedIntegration(store, repository, {
      attemptIdentity: record.attemptIdentity,
      baseCommit: record.baseCommit,
      candidateCommit: record.candidateCommit,
      candidateTree: record.candidateTree,
      compositionIdentity: record.compositionIdentity,
      integrationId: record.integrationId,
      markerRef: record.markerRef,
      submissions: record.submissions,
      targetRef: record.targetRef,
    });
    if (recovered !== undefined) return recovered;
    record = readIntegration(store, record.integrationId);
  } else if (record.status === 'checking') {
    // A durable checking record contains no external process receipt. A restarted coordinator
    // atomically fences that exact attempt before spending the next one; its stale certifier can no
    // longer reserve against an equal candidate identity.
    try {
      record = recordIntegrationRework(store, record);
    } catch (cause) {
      if (cause instanceof IntegrationAttemptChangedError) {
        return queueReport(store, record.integrationId, 'attempt-fenced', [], []);
      }
      throw cause;
    }
  }

  while (record.attemptCount < MAX_INTEGRATION_ATTEMPTS) {
    let starved: IntegrationTerminalReport | undefined;
    try {
      starved = terminalIfStarved(store, record);
    } catch (cause) {
      if (cause instanceof IntegrationAttemptChangedError) {
        return queueReport(store, record.integrationId, 'attempt-fenced', [], []);
      }
      throw cause;
    }
    if (starved !== undefined) return starved;
    const blockers = blockingIntegrationIds(store, record);
    if (blockers.length !== 0) {
      return queueReport(store, record.integrationId, 'submission-reserved', blockers, []);
    }
    try {
      assertSubmittedGenerations(store, record);
    } catch (cause) {
      if (cause instanceof IntegrationGenerationChangedError) {
        return terminal(store, record, 'candidate-refused');
      }
      throw cause;
    }
    const targetBase = requireTargetRef(repository, record.targetRef);
    let candidate: UncheckedIntegrationCandidate;
    try {
      candidate =
        record.attemptCount === 0 && targetBase === request.submissions[0]?.packet.base.commit
          ? composeIntegrationCandidate(store, repository, request)
          : recomposeIntegrationCandidate(store, repository, request, targetBase);
    } catch (cause) {
      // Proof: without this narrow production-path transition `a conflicting target advance
      // terminalizes the exact immutable submission` threw the Git apply diagnostic and retained
      // `rework` forever instead of returning incompatible-submission on repeated invocation.
      if (cause instanceof IntegrationPatchConflictError) {
        return terminal(store, record, 'incompatible-submission');
      }
      throw cause;
    }
    const unavailable = await unavailableResources(
      options.resourceProbe,
      record.integrationId,
      record.resources,
      candidate.compositionIdentity,
    );
    // Probe runtime is queue time. Refresh only after the awaited trusted port returns so a held
    // resource cannot publish with the pre-await timestamp.
    try {
      starved = terminalIfStarved(store, record);
    } catch (cause) {
      if (cause instanceof IntegrationAttemptChangedError) {
        return queueReport(store, record.integrationId, 'attempt-fenced', [], []);
      }
      throw cause;
    }
    if (starved !== undefined) return starved;
    if (unavailable.length !== 0) {
      return queueReport(store, record.integrationId, 'resources', [], unavailable);
    }
    let checking: IntegrationCheckingRecord;
    try {
      checking = recordIntegrationCheck(store, record.integrationId, candidate);
    } catch (cause) {
      if (cause instanceof IntegrationSubmissionReservedError) {
        return queueReport(
          store,
          record.integrationId,
          'submission-reserved',
          cause.blockingIntegrationIds,
          [],
        );
      }
      if (cause instanceof IntegrationAttemptChangedError) {
        return queueReport(store, record.integrationId, 'attempt-fenced', [], []);
      }
      throw cause;
    }
    record = checking;
    const certification = await options.certifier.certify(candidate);
    // Certification time is inside the initial five-minute queue budget. This refresh is before
    // every post-certification transition, including retry, terminalization and publication.
    try {
      starved = terminalIfStarved(store, checking);
    } catch (cause) {
      if (cause instanceof IntegrationAttemptChangedError) {
        return queueReport(store, record.integrationId, 'attempt-fenced', [], []);
      }
      throw cause;
    }
    if (starved !== undefined) return starved;
    if (certification.status === 'failed') {
      if (certification.reason.length === 0) {
        throw new Error('integration certifier returned an empty failure reason');
      }
      try {
        record = recordIntegrationRework(store, checking);
      } catch (cause) {
        if (cause instanceof IntegrationAttemptChangedError) {
          return queueReport(store, record.integrationId, 'attempt-fenced', [], []);
        }
        throw cause;
      }
      if (record.attemptCount >= MAX_INTEGRATION_ATTEMPTS) {
        return terminal(store, record, 'attempts-exhausted');
      }
      continue;
    }
    const checked = certification;
    assertCheckedMatches(checked, candidate);
    const candidateCommit = createIntegrationCommit(repository, checked, record, options.commit);
    let reserved: ReservedIntegrationPublication;
    try {
      reserved = reserveIntegrationPublication(
        store,
        repository,
        checked,
        candidateCommit,
        record.integrationId,
        checking.attemptIdentity,
      );
    } catch (cause) {
      if (cause instanceof IntegrationTargetMovedError) {
        record = recordIntegrationRework(store, checking);
        if (record.attemptCount >= MAX_INTEGRATION_ATTEMPTS) {
          return terminal(store, record, 'attempts-exhausted');
        }
        continue;
      }
      if (cause instanceof IntegrationGenerationChangedError) {
        return terminal(store, checking, 'candidate-refused');
      }
      if (cause instanceof IntegrationAttemptChangedError) {
        return queueReport(store, record.integrationId, 'attempt-fenced', [], []);
      }
      throw cause;
    }
    const published = publishReservedIntegration(store, repository, reserved);
    if (published !== undefined) return published;
    record = readIntegration(store, record.integrationId);
    if (record.attemptCount >= MAX_INTEGRATION_ATTEMPTS) {
      return terminal(store, record, 'attempts-exhausted');
    }
  }
  return terminal(store, record, 'attempts-exhausted');
}
