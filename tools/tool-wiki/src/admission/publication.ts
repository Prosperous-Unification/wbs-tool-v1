import { realpathSync } from 'node:fs';

import { compareCanonicalText, hashBytes, hashCanonical } from '../evidence/content-manifest';
import type {
  AuthorityGeneration,
  AuthorityState,
  AuthorityStore,
  IntegrationQueueRecord,
  IntegrationQueueSubmission,
  IntegrationResourceRequirement,
} from './authority-store';
import { assertAuthorityTimestamp } from './authority-store';
import {
  assertCheckedIntegrationCandidate,
  type CheckedIntegrationCandidate,
  composeIntegrationCandidate,
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
  readonly queueTimeMs: number;
  readonly unavailableResources: readonly IntegrationResourceRequirement[];
  readonly fileClaimGenerations: readonly IntegrationQueueSubmission[];
}

export interface IntegrationTerminalReport {
  readonly status: 'terminal';
  readonly integrationId: string;
  readonly reason: 'starvation' | 'attempts-exhausted' | 'candidate-refused';
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

export interface ReservedIntegrationPublication {
  readonly integrationId: string;
  readonly targetRef: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly compositionIdentity: string;
  readonly markerRef: string;
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
  const invocation = Bun.spawnSync(['git', '-C', repository, 'rev-parse', '--verify', reference], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode === 1 || invocation.exitCode === 128) return undefined;
  if (invocation.exitCode !== 0) {
    throw new Error(
      `integration refused: cannot read ${reference}: ${invocation.stderr.toString('utf8').trim()}`,
    );
  }
  const identity = invocation.stdout.toString('utf8').trimEnd();
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

function terminal(
  store: AuthorityStore,
  integrationId: string,
  reason: IntegrationTerminalReport['reason'],
): IntegrationTerminalReport {
  const record = transition(store, integrationId, (current, timestamp) => ({
    ...current,
    baseCommit: undefined,
    candidateCommit: undefined,
    candidateTree: undefined,
    compositionIdentity: undefined,
    markerRef: undefined,
    status: 'terminal',
    statusAt: timestamp,
    terminalReason: reason,
  }));
  return {
    attempts: record.attemptCount,
    integrationId,
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
): IntegrationQueueRecord {
  return transition(store, integrationId, (current, timestamp) => {
    if (current.status !== 'queued' && current.status !== 'rework') {
      throw new Error(`integration cannot start checks from ${current.status}: ${integrationId}`);
    }
    if (current.attemptCount >= MAX_INTEGRATION_ATTEMPTS) {
      throw new Error(`integration attempt budget exhausted: ${integrationId}`);
    }
    return {
      ...current,
      attemptCount: current.attemptCount + 1,
      baseCommit: candidate.baseCommit,
      candidateTree: candidate.candidateTree,
      compositionIdentity: candidate.compositionIdentity,
      status: 'checking',
      statusAt: timestamp,
    };
  });
}

/** Reserves one checked candidate after the final authority and target-base recheck. */
export function reserveIntegrationPublication(
  store: AuthorityStore,
  coordinatorRepository: string,
  checked: CheckedIntegrationCandidate,
  candidateCommit: string,
  integrationId: string,
): ReservedIntegrationPublication {
  assertCheckedIntegrationCandidate(checked);
  const repository = realpathSync(coordinatorRepository);
  return store.transact((transaction) => {
    const state = transaction.readState();
    const record = state.integrations.find((entry) => entry.integrationId === integrationId);
    if (
      record?.status !== 'checking' ||
      record.baseCommit !== checked.baseCommit ||
      record.candidateTree !== checked.candidateTree ||
      record.compositionIdentity !== checked.compositionIdentity
    ) {
      throw new Error(`integration is not checking this candidate: ${integrationId}`);
    }
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
      baseCommit: checked.baseCommit,
      candidateCommit,
      candidateTree: checked.candidateTree,
      compositionIdentity: checked.compositionIdentity,
      integrationId,
      markerRef: publicationMarker,
      targetRef: record.targetRef,
    };
  });
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
  return false;
}

function assertPublishedCommit(repository: string, reserved: ReservedIntegrationPublication): void {
  const marker = readRef(repository, reserved.markerRef);
  const tree = readRef(repository, `${reserved.candidateCommit}^{tree}`);
  const parent = readRef(repository, `${reserved.candidateCommit}^`);
  // Proof: omitting the tree comparison made `immutable marker proves publication across a
  // crash` accept a forged base-tree reservation (`Received function did not throw`).
  if (
    marker !== reserved.candidateCommit ||
    tree !== reserved.candidateTree ||
    parent !== reserved.baseCommit
  ) {
    throw new Error('published integration commit differs from the checked candidate');
  }
}

/** Finalizes a marker-proven publication, even when the target subsequently advanced. */
export function finalizeIntegrationPublication(
  store: AuthorityStore,
  coordinatorRepository: string,
  reserved: ReservedIntegrationPublication,
): IntegrationPublishedReport {
  const repository = realpathSync(coordinatorRepository);
  assertPublishedCommit(repository, reserved);
  const record = store.transact((transaction) => {
    const state = transaction.readState();
    const integration = state.integrations.find(
      (entry) => entry.integrationId === reserved.integrationId,
    );
    if (
      integration?.status !== 'publishing' ||
      integration.candidateCommit !== reserved.candidateCommit ||
      integration.markerRef !== reserved.markerRef ||
      integration.baseCommit !== reserved.baseCommit ||
      integration.compositionIdentity !== reserved.compositionIdentity
    ) {
      throw new Error(`integration publication reservation changed: ${reserved.integrationId}`);
    }
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
    return published;
  });
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

/** Atomically publishes the target and durable marker refs, then finalizes authority lifecycle. */
export function publishReservedIntegration(
  store: AuthorityStore,
  coordinatorRepository: string,
  reserved: ReservedIntegrationPublication,
): IntegrationPublishedReport | undefined {
  const repository = realpathSync(coordinatorRepository);
  if (!publishIntegrationRefs(repository, reserved)) return undefined;
  return finalizeIntegrationPublication(store, repository, reserved);
}

/** Atomically CAS-updates the target and creates the immutable publication marker. */
export function publishIntegrationRefs(
  coordinatorRepository: string,
  reserved: ReservedIntegrationPublication,
): boolean {
  return updateRefs(realpathSync(coordinatorRepository), reserved);
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

function markRework(store: AuthorityStore, integrationId: string): IntegrationQueueRecord {
  return transition(store, integrationId, (record, timestamp) => ({
    ...record,
    baseCommit: undefined,
    candidateCommit: undefined,
    candidateTree: undefined,
    compositionIdentity: undefined,
    markerRef: undefined,
    status: 'rework',
    statusAt: timestamp,
  }));
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
      record.candidateCommit === undefined ||
      record.candidateTree === undefined ||
      record.markerRef === undefined ||
      record.baseCommit === undefined ||
      record.compositionIdentity === undefined
    ) {
      throw new Error('published integration record is incomplete');
    }
    assertPublishedCommit(repository, {
      baseCommit: record.baseCommit,
      candidateCommit: record.candidateCommit,
      candidateTree: record.candidateTree,
      compositionIdentity: record.compositionIdentity,
      integrationId: record.integrationId,
      markerRef: record.markerRef,
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
      reason !== 'candidate-refused'
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
      record.baseCommit === undefined ||
      record.candidateCommit === undefined ||
      record.candidateTree === undefined ||
      record.compositionIdentity === undefined ||
      record.markerRef === undefined
    ) {
      throw new Error('publishing integration record is incomplete');
    }
    const recovered = publishReservedIntegration(store, repository, {
      baseCommit: record.baseCommit,
      candidateCommit: record.candidateCommit,
      candidateTree: record.candidateTree,
      compositionIdentity: record.compositionIdentity,
      integrationId: record.integrationId,
      markerRef: record.markerRef,
      targetRef: record.targetRef,
    });
    if (recovered !== undefined) return recovered;
    record = markRework(store, record.integrationId);
  }

  const currentState = store.transact((transaction) => transaction.readState());
  const currentTime = readTrustedTime(store, currentState);
  // Proof: removing this deadline made `queue caps batches, separates resource prerequisites,
  // and reports starvation` receive `status: waiting` at exactly 300000 ms instead of terminal.
  if (currentTime - record.queuedAt >= MAX_INTEGRATION_QUEUE_WAIT_MS) {
    return terminal(store, record.integrationId, 'starvation');
  }
  while (record.attemptCount < MAX_INTEGRATION_ATTEMPTS) {
    const targetBase = requireTargetRef(repository, record.targetRef);
    const candidate =
      record.attemptCount === 0 && targetBase === request.submissions[0]?.packet.base.commit
        ? composeIntegrationCandidate(store, repository, request)
        : recomposeIntegrationCandidate(store, repository, request, targetBase);
    const unavailable = await unavailableResources(
      options.resourceProbe,
      record.integrationId,
      record.resources,
      candidate.compositionIdentity,
    );
    if (unavailable.length !== 0) {
      return {
        fileClaimGenerations: record.submissions,
        integrationId: record.integrationId,
        queueTimeMs: currentTime - record.queuedAt,
        status: 'waiting',
        unavailableResources: unavailable,
      };
    }
    record = recordIntegrationCheck(store, record.integrationId, candidate);
    const certification = await options.certifier.certify(candidate);
    if (certification.status === 'failed') {
      if (certification.reason.length === 0) {
        throw new Error('integration certifier returned an empty failure reason');
      }
      record = markRework(store, record.integrationId);
      if (record.attemptCount >= MAX_INTEGRATION_ATTEMPTS) {
        return terminal(store, record.integrationId, 'attempts-exhausted');
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
      );
    } catch (cause) {
      if (cause instanceof IntegrationTargetMovedError) {
        record = markRework(store, record.integrationId);
        if (record.attemptCount >= MAX_INTEGRATION_ATTEMPTS) {
          return terminal(store, record.integrationId, 'attempts-exhausted');
        }
        continue;
      }
      if (cause instanceof IntegrationGenerationChangedError) {
        return terminal(store, record.integrationId, 'candidate-refused');
      }
      throw cause;
    }
    const published = publishReservedIntegration(store, repository, reserved);
    if (published !== undefined) return published;
    record = markRework(store, record.integrationId);
    if (record.attemptCount >= MAX_INTEGRATION_ATTEMPTS) {
      return terminal(store, record.integrationId, 'attempts-exhausted');
    }
  }
  return terminal(store, record.integrationId, 'attempts-exhausted');
}
