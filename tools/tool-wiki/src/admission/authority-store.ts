import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

import {
  assertAuthorityClaimPath,
  assertAuthorityConflictGroup,
  assertAuthorityPathAccess,
  assertAuthoritySessionId,
  assertAuthorityWorktreePath,
} from './authority-identities';
import { decodeAdmissionPacketBody } from './packet-codec';

export {
  assertAuthorityClaimPath,
  assertAuthorityConflictGroup,
  assertAuthorityPathAccess,
  assertAuthoritySessionId,
  assertAuthorityWorktreePath,
} from './authority-identities';

/**
 * v4 adds durable integration/recovery history. Existing v3 files are intentionally refused:
 * inventing an empty queue could erase an in-flight publication fact. This authority remains
 * unactivated until the separately reviewed production bootstrap in slice 5.3.
 */
export const AUTHORITY_SCHEMA_VERSION = 'wbs-wiki-authority.v4' as const;

export type PathAccess = 'read' | 'write';

export interface PathClaim {
  readonly kind: 'path';
  readonly identity: string;
  readonly access: PathAccess;
}

export interface GroupClaim {
  readonly kind: 'group';
  readonly identity: string;
}

export type AuthorityClaim = PathClaim | GroupClaim;

export type GenerationStatus =
  'working' | 'investigating' | 'submitted' | 'integrated' | 'rejected' | 'abandoned' | 'released';

export interface SubmissionIdentity {
  readonly patchIdentity: string;
  readonly candidateDiffIdentity: string;
  readonly contentIdentity: string;
}

export interface AuthorityPacketBinding {
  readonly packetIdentity: string;
  readonly packetBytes: string;
}

export interface AuthorityGeneration {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly generation: number;
  readonly claims: readonly AuthorityClaim[];
  readonly status: GenerationStatus;
  readonly heartbeatAt: number;
  readonly statusAt: number;
  readonly packet?: AuthorityPacketBinding;
  readonly submission?: SubmissionIdentity;
}

export type IntegrationQueueStatus =
  'queued' | 'checking' | 'rework' | 'publishing' | 'published' | 'terminal';

export interface IntegrationQueueSubmission {
  readonly sessionId: string;
  readonly generation: number;
  readonly packetIdentity: string;
  readonly patchIdentity: string;
}

export interface IntegrationResourceRequirement {
  readonly kind: 'lane' | 'port';
  readonly identity: string;
}

export interface IntegrationQueueRecord {
  readonly integrationId: string;
  readonly targetRef: string;
  readonly status: IntegrationQueueStatus;
  readonly queuedAt: number;
  readonly statusAt: number;
  readonly attemptCount: number;
  readonly attemptIdentity?: string;
  readonly submissions: readonly IntegrationQueueSubmission[];
  readonly resources: readonly IntegrationResourceRequirement[];
  readonly baseCommit?: string;
  readonly compositionIdentity?: string;
  readonly candidateTree?: string;
  readonly candidateCommit?: string;
  readonly markerRef?: string;
  readonly terminalReason?: string;
}

export interface AuthorityState {
  readonly nextGeneration: number;
  readonly generations: readonly AuthorityGeneration[];
  readonly integrations: readonly IntegrationQueueRecord[];
}

/**
 * Trusted epoch-millisecond source configured with the adapter, never supplied by a claimant.
 *
 * Wall clocks are not claimed monotonic across processes; persisted regressions are refused.
 */
export interface AuthorityClock {
  read(): number;
}

function assertAuthorityClock(clock: unknown): asserts clock is AuthorityClock {
  // Proof: before this boundary, `{clock:{}}` constructed live memory and SQLite stores; their
  // malformed-clock adapter tests observed that neither constructor threw.
  if (
    typeof clock !== 'object' ||
    clock === null ||
    !('read' in clock) ||
    typeof clock.read !== 'function'
  ) {
    throw new Error('invalid authority clock adapter');
  }
}

/**
 * The synchronous mutation surface held inside one authority transaction.
 *
 * The callback shape makes the conflict read, generation allocation, owner insert and claim
 * inserts one indivisible operation. A caller cannot retain this view after the callback returns.
 * See {@link ../../../docs/adr/0021-shared-git-admission-authority.md Shared Git admission authority}.
 */
export interface AuthorityTransaction {
  readState(): AuthorityState;
  writeState(state: AuthorityState): void;
}

/**
 * One common-Git authority store; adapters must commit the callback or leave no mutation.
 *
 * An adapter may invoke `operation` again after rolling back retryable contention, including
 * contention raised by the body or commit. Callbacks must therefore be synchronous,
 * deterministic and free of effects outside the supplied transaction. A callback value is
 * returned only after its transaction commits.
 */
export interface AuthorityStore {
  transact<T>(operation: (transaction: AuthorityTransaction) => T): T;
  readClock(): number;
}

function copyClaim(claim: AuthorityClaim): AuthorityClaim {
  return claim.kind === 'path'
    ? { access: claim.access, identity: claim.identity, kind: 'path' }
    : { identity: claim.identity, kind: 'group' };
}

function copyState(state: AuthorityState): AuthorityState {
  return {
    nextGeneration: state.nextGeneration,
    generations: state.generations.map((generation) => ({
      claims: generation.claims.map(copyClaim),
      generation: generation.generation,
      heartbeatAt: generation.heartbeatAt,
      packet: generation.packet === undefined ? undefined : { ...generation.packet },
      sessionId: generation.sessionId,
      status: generation.status,
      statusAt: generation.statusAt,
      submission: generation.submission === undefined ? undefined : { ...generation.submission },
      worktreePath: generation.worktreePath,
    })),
    integrations: state.integrations.map((integration) => ({
      ...integration,
      resources: integration.resources.map((resource) => ({ ...resource })),
      submissions: integration.submissions.map((submission) => ({ ...submission })),
    })),
  };
}

function assertSynchronous(value: unknown): void {
  // Proof: without this boundary an async callback returned a resolved Promise and committed its
  // pending state; the callback-contract test observed that `transact` did not throw.
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value
  ) {
    throw new Error('authority transaction callback must be synchronous');
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const INTEGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HOLDING_STATUSES: ReadonlySet<GenerationStatus> = new Set([
  'working',
  'investigating',
  'submitted',
]);

/** Refuses a persisted or requested submission identity outside the exact SHA-256 contract. */
export function assertSubmissionIdentity(submission: SubmissionIdentity): void {
  // Proof: weakening the SHA-256 matcher to accept every string let `not-sha256` publish; the
  // malformed-submission production test observed that `submitGeneration` did not throw for each
  // of patch, candidate-diff and content identity.
  if (!SHA256.test(submission.patchIdentity)) throw new Error('invalid patch identity');
  if (!SHA256.test(submission.candidateDiffIdentity)) {
    throw new Error('invalid candidate diff identity');
  }
  if (!SHA256.test(submission.contentIdentity)) throw new Error('invalid content identity');
}

/** Refuses a time value that cannot be represented identically by memory and SQLite. */
export function assertAuthorityTimestamp(timestamp: number): void {
  // Proof: bypassing this boundary made -1 reach the later regression diagnostic rather than the
  // canonical timestamp boundary; the production heartbeat test lost its exact refusal.
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`invalid authority clock timestamp: ${String(timestamp)}`);
  }
}

function assertMemoryState(state: AuthorityState): void {
  if (!Number.isSafeInteger(state.nextGeneration) || state.nextGeneration < 1) {
    throw new Error('invalid memory authority next generation');
  }
  const activeSessions = new Set<string>();
  const generations = new Set<number>();
  let highestGeneration = 0;
  for (const record of state.generations) {
    assertAuthoritySessionId(record.sessionId);
    assertAuthorityWorktreePath(record.worktreePath);
    if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
      throw new Error(`invalid authority generation for session ${record.sessionId}`);
    }
    if (generations.has(record.generation)) {
      throw new Error(`duplicate authority generation: ${String(record.generation)}`);
    }
    generations.add(record.generation);
    highestGeneration = Math.max(highestGeneration, record.generation);
    assertGenerationStatus(record.status);
    assertAuthorityTimestamp(record.heartbeatAt);
    assertAuthorityTimestamp(record.statusAt);
    // Proof: removing this ordering check let status time 999 follow heartbeat 1000; the malformed-
    // lifecycle test observed that `MemoryAuthorityStore` constructed successfully.
    if (record.statusAt < record.heartbeatAt) {
      throw new Error(`authority generation status predates heartbeat: ${record.sessionId}`);
    }
    if (HOLDING_STATUSES.has(record.status)) {
      // Proof: removing this check let two live generations for session-a construct; the malformed-
      // lifecycle test observed that `MemoryAuthorityStore` did not throw.
      if (activeSessions.has(record.sessionId)) {
        throw new Error(`duplicate active authority session: ${record.sessionId}`);
      }
      activeSessions.add(record.sessionId);
      // Proof: removing this terminal-state check let an integrated generation retain its write
      // claim; the malformed-lifecycle test observed that the memory authority did not throw.
    } else if (record.claims.length !== 0) {
      throw new Error(`terminal authority generation retains claims: ${record.sessionId}`);
    }
    if (record.submission !== undefined) assertSubmissionIdentity(record.submission);
    if (record.packet !== undefined) {
      // Proof: omitting strict packet recovery let a persisted, independently rehashed
      // `extraWrites` field open as trusted authority; the production open test received a store.
      const packet = decodeAdmissionPacketBody(
        record.packet.packetIdentity,
        record.packet.packetBytes,
      );
      // Proof: omitting this owner comparison let persisted packet bytes name `session-other`;
      // the production open test received a store instead of the mismatched-owner refusal.
      if (
        packet.sessionId !== record.sessionId ||
        packet.generation !== record.generation ||
        packet.worktreePath !== record.worktreePath
      ) {
        throw new Error(`authority packet binding has a different owner: ${record.sessionId}`);
      }
    }
    const requiresSubmission = record.status === 'submitted' || record.status === 'integrated';
    const forbidsSubmission =
      record.status === 'working' ||
      record.status === 'investigating' ||
      record.status === 'released';
    // Proof: bypassing each half separately let either a `submitted` record omit identities or a
    // `released` record retain them; the malformed-lifecycle test observed successful construction.
    if (
      (requiresSubmission && record.submission === undefined) ||
      (forbidsSubmission && record.submission !== undefined)
    ) {
      throw new Error(`authority generation submission does not match status: ${record.sessionId}`);
    }
    for (const claim of record.claims) {
      if (claim.kind === 'path') {
        assertAuthorityClaimPath(claim.identity);
        assertAuthorityPathAccess(claim.access);
      } else {
        assertAuthorityConflictGroup(claim.identity);
      }
    }
  }
  // Proof: removing this ordering check let a state whose next generation was already owned
  // construct successfully; the memory-state test observed no throw.
  if (state.nextGeneration <= highestGeneration) {
    throw new Error('authority next generation does not follow existing generations');
  }
  const integrationIds = new Set<string>();
  const activeSubmissionOwners = new Map<string, string>();
  for (const integration of state.integrations) {
    if (!INTEGRATION_ID.test(integration.integrationId)) {
      throw new Error(`invalid authority integration id: ${integration.integrationId}`);
    }
    if (integrationIds.has(integration.integrationId)) {
      throw new Error(`duplicate authority integration id: ${integration.integrationId}`);
    }
    integrationIds.add(integration.integrationId);
    if (!integration.targetRef.startsWith('refs/heads/')) {
      throw new Error(`invalid authority integration target ref: ${integration.targetRef}`);
    }
    assertAuthorityTimestamp(integration.queuedAt);
    assertAuthorityTimestamp(integration.statusAt);
    if (integration.statusAt < integration.queuedAt) {
      throw new Error(`authority integration status predates queue: ${integration.integrationId}`);
    }
    if (
      !Number.isSafeInteger(integration.attemptCount) ||
      integration.attemptCount < 0 ||
      integration.attemptCount > 3
    ) {
      throw new Error(`invalid authority integration attempt count: ${integration.integrationId}`);
    }
    // Proof: removing the persisted upper bound made `queue caps batches` construct a memory
    // authority record holding five exact submissions (`Received function did not throw`).
    if (integration.submissions.length < 1 || integration.submissions.length > 4) {
      throw new Error(`invalid authority integration batch size: ${integration.integrationId}`);
    }
    const owners = new Set<string>();
    for (const submission of integration.submissions) {
      assertAuthoritySessionId(submission.sessionId);
      if (!Number.isSafeInteger(submission.generation) || submission.generation < 1) {
        throw new Error(`invalid authority integration generation: ${integration.integrationId}`);
      }
      const owner = `${submission.sessionId}/${String(submission.generation)}`;
      if (owners.has(owner)) {
        throw new Error(`duplicate authority integration submission: ${integration.integrationId}`);
      }
      owners.add(owner);
      if (!SHA256.test(submission.packetIdentity) || !SHA256.test(submission.patchIdentity)) {
        throw new Error(
          `invalid authority integration submission identity: ${integration.integrationId}`,
        );
      }
    }
    const resources = new Set<string>();
    for (const resource of integration.resources) {
      if (!RESOURCE_ID.test(resource.identity)) {
        throw new Error(`invalid authority integration resource: ${integration.integrationId}`);
      }
      const identity = `${resource.kind}:${resource.identity}`;
      // Proof: removing this check made `memory authority refuses partial or mismatched durable
      // integration records` construct a store with the same `lane:heavy` prerequisite twice.
      if (resources.has(identity)) {
        throw new Error(`duplicate authority integration resource: ${integration.integrationId}`);
      }
      resources.add(identity);
    }
    const hasChecked =
      integration.attemptIdentity !== undefined &&
      integration.baseCommit !== undefined &&
      integration.candidateTree !== undefined &&
      integration.compositionIdentity !== undefined;
    const hasPublication =
      integration.candidateCommit !== undefined && integration.markerRef !== undefined;
    const checkedFieldCount = [
      integration.attemptIdentity,
      integration.baseCommit,
      integration.candidateTree,
      integration.compositionIdentity,
    ].filter((field) => field !== undefined).length;
    const publicationFieldCount = [integration.candidateCommit, integration.markerRef].filter(
      (field) => field !== undefined,
    ).length;
    if (
      (integration.attemptIdentity !== undefined && !SHA256.test(integration.attemptIdentity)) ||
      (integration.baseCommit !== undefined && !GIT_OBJECT.test(integration.baseCommit)) ||
      (integration.compositionIdentity !== undefined &&
        !SHA256.test(integration.compositionIdentity)) ||
      (integration.candidateTree !== undefined && !GIT_OBJECT.test(integration.candidateTree)) ||
      (integration.candidateCommit !== undefined &&
        !GIT_OBJECT.test(integration.candidateCommit)) ||
      (integration.markerRef !== undefined &&
        !integration.markerRef.startsWith('refs/wbs-wiki/publications/'))
    ) {
      throw new Error(
        `invalid authority integration publication identity: ${integration.integrationId}`,
      );
    }
    // Proof: removing this all-or-none check made `memory authority refuses partial or mismatched
    // durable integration records` receive the later `fields do not match status` diagnostic
    // instead of the partial-publication refusal.
    if (
      (checkedFieldCount !== 0 && checkedFieldCount !== 4) ||
      (publicationFieldCount !== 0 && publicationFieldCount !== 2)
    ) {
      throw new Error(
        `authority integration has partial publication fields: ${integration.integrationId}`,
      );
    }
    if (
      ((integration.status === 'checking' ||
        integration.status === 'publishing' ||
        integration.status === 'published') &&
        !hasChecked) ||
      ((integration.status === 'publishing' || integration.status === 'published') &&
        !hasPublication) ||
      ((integration.status === 'queued' || integration.status === 'rework') &&
        (hasChecked || hasPublication)) ||
      (integration.status === 'checking' && hasPublication)
    ) {
      throw new Error(
        `authority integration fields do not match status: ${integration.integrationId}`,
      );
    }
    if (
      (integration.status === 'terminal') !== (integration.terminalReason !== undefined) ||
      integration.terminalReason?.length === 0
    ) {
      throw new Error(
        `authority integration terminal reason does not match status: ${integration.integrationId}`,
      );
    }
    for (const submission of integration.submissions) {
      const generation = state.generations.find(
        (record) =>
          record.sessionId === submission.sessionId && record.generation === submission.generation,
      );
      // Proof: omitting these packet/patch comparisons made `memory authority refuses partial or
      // mismatched durable integration records` construct a queue pointing at a forged packet.
      if (
        generation?.packet?.packetIdentity !== submission.packetIdentity ||
        generation.submission?.patchIdentity !== submission.patchIdentity ||
        // Proof: bypassing this persisted-state invariant with publication's final generation
        // recheck made `terminal generation transition while checks are held` update the ref and
        // fail later on `integration generation changed before publication: one/1`.
        (integration.status === 'publishing' && generation.status !== 'submitted') ||
        (integration.status === 'published' && generation.status !== 'integrated')
      ) {
        throw new Error(
          `authority integration submission is not retained: ${integration.integrationId}`,
        );
      }
      if (integration.status === 'checking' || integration.status === 'publishing') {
        const owner = `${submission.sessionId}/${String(submission.generation)}`;
        const activeOwner = activeSubmissionOwners.get(owner);
        // Proof: removing this persisted fence made `one checking integration fences an
        // overlapping integration` construct two active owners for the same submitted generation.
        if (activeOwner !== undefined && activeOwner !== integration.integrationId) {
          throw new Error(`authority generation has competing integrations: ${owner}`);
        }
        activeSubmissionOwners.set(owner, integration.integrationId);
      }
    }
  }
}

/** In-memory adapter with the same commit-or-rollback callback semantics as SQLite. */
export class MemoryAuthorityStore implements AuthorityStore {
  #state: AuthorityState;
  readonly #clock: AuthorityClock;

  constructor(
    initial: AuthorityState = { generations: [], integrations: [], nextGeneration: 1 },
    clock: AuthorityClock = { read: () => Date.now() },
  ) {
    assertMemoryState(initial);
    assertAuthorityClock(clock);
    this.#state = copyState(initial);
    this.#clock = clock;
  }

  transact<T>(operation: (transaction: AuthorityTransaction) => T): T {
    let pending = copyState(this.#state);
    const value = operation({
      readState: () => copyState(pending),
      writeState: (state) => {
        assertMemoryState(state);
        pending = copyState(state);
      },
    });
    assertSynchronous(value);
    this.#state = pending;
    return value;
  }

  /** A detached snapshot for assertions and diagnostics. */
  inspect(): AuthorityState {
    return copyState(this.#state);
  }

  readClock(): number {
    return this.#clock.read();
  }
}

const SCHEMA = [
  `CREATE TABLE authority_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version TEXT NOT NULL,
    next_generation INTEGER NOT NULL CHECK (next_generation >= 1)
  ) STRICT`,
  `CREATE TABLE authority_generation (
    session_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    generation INTEGER NOT NULL UNIQUE CHECK (generation >= 1),
    status TEXT NOT NULL CHECK (status IN ('working', 'investigating', 'submitted', 'integrated', 'rejected', 'abandoned', 'released')),
    heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= 0),
    status_at INTEGER NOT NULL CHECK (status_at >= heartbeat_at),
    patch_identity TEXT,
    candidate_diff_identity TEXT,
    content_identity TEXT,
    packet_identity TEXT,
    packet_bytes TEXT,
    PRIMARY KEY (session_id, generation),
    CHECK ((patch_identity IS NULL AND candidate_diff_identity IS NULL AND content_identity IS NULL) OR (patch_identity IS NOT NULL AND candidate_diff_identity IS NOT NULL AND content_identity IS NOT NULL)),
    CHECK ((packet_identity IS NULL AND packet_bytes IS NULL) OR (packet_identity IS NOT NULL AND packet_bytes IS NOT NULL)),
    CHECK ((status IN ('submitted', 'integrated') AND patch_identity IS NOT NULL) OR (status IN ('working', 'investigating', 'released') AND patch_identity IS NULL) OR (status IN ('rejected', 'abandoned')))
  ) STRICT`,
  `CREATE TABLE authority_claim (
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('path', 'group')),
    access TEXT CHECK (access IN ('read', 'write')),
    identity TEXT NOT NULL,
    PRIMARY KEY (session_id, kind, identity),
    FOREIGN KEY (session_id, generation) REFERENCES authority_generation(session_id, generation) ON DELETE CASCADE,
    CHECK ((kind = 'path' AND access IS NOT NULL) OR (kind = 'group' AND access IS NULL))
  ) STRICT`,
  `CREATE TABLE authority_integration (
    integration_id TEXT PRIMARY KEY,
    target_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'checking', 'rework', 'publishing', 'published', 'terminal')),
    queued_at INTEGER NOT NULL CHECK (queued_at >= 0),
    status_at INTEGER NOT NULL CHECK (status_at >= queued_at),
    attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 3),
    attempt_identity TEXT,
    base_commit TEXT,
    candidate_tree TEXT,
    composition_identity TEXT,
    candidate_commit TEXT,
    marker_ref TEXT,
    terminal_reason TEXT
  ) STRICT`,
  `CREATE TABLE authority_integration_submission (
    integration_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    packet_identity TEXT NOT NULL,
    patch_identity TEXT NOT NULL,
    PRIMARY KEY (integration_id, session_id, generation),
    FOREIGN KEY (integration_id) REFERENCES authority_integration(integration_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, generation) REFERENCES authority_generation(session_id, generation)
  ) STRICT`,
  `CREATE TABLE authority_integration_resource (
    integration_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('lane', 'port')),
    identity TEXT NOT NULL,
    PRIMARY KEY (integration_id, kind, identity),
    FOREIGN KEY (integration_id) REFERENCES authority_integration(integration_id) ON DELETE CASCADE
  ) STRICT`,
] as const;

const DEFAULT_BUSY_ATTEMPTS = 50;
const DEFAULT_BUSY_DELAY_MS = 5;
const MAX_BUSY_ATTEMPTS = 100;
const MAX_BUSY_DELAY_MS = 50;

export interface AuthorityStoreOptions {
  readonly maxBusyAttempts?: number;
  readonly busyDelayMilliseconds?: number;
  readonly clock?: unknown;
}

interface RequiredAuthorityStoreOptions {
  readonly maxBusyAttempts: number;
  readonly busyDelayMilliseconds: number;
  readonly clock: AuthorityClock;
}

interface SchemaRow {
  readonly name: string;
  readonly sql: string;
  readonly type: string;
}

interface MetaRow {
  readonly schemaVersion: string;
  readonly nextGeneration: number;
}

interface GenerationRow {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly generation: number;
  readonly status: string;
  readonly heartbeatAt: number;
  readonly statusAt: number;
  readonly patchIdentity: string | null;
  readonly candidateDiffIdentity: string | null;
  readonly contentIdentity: string | null;
  readonly packetIdentity: string | null;
  readonly packetBytes: string | null;
}

interface ClaimRow {
  readonly sessionId: string;
  readonly generation: number;
  readonly kind: string;
  readonly access: string | null;
  readonly identity: string;
}

interface IntegrationRow {
  readonly integrationId: string;
  readonly targetRef: string;
  readonly status: string;
  readonly queuedAt: number;
  readonly statusAt: number;
  readonly attemptCount: number;
  readonly attemptIdentity: string | null;
  readonly baseCommit: string | null;
  readonly candidateTree: string | null;
  readonly compositionIdentity: string | null;
  readonly candidateCommit: string | null;
  readonly markerRef: string | null;
  readonly terminalReason: string | null;
}

interface IntegrationSubmissionRow {
  readonly integrationId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly packetIdentity: string;
  readonly patchIdentity: string;
}

interface IntegrationResourceRow {
  readonly integrationId: string;
  readonly kind: string;
  readonly identity: string;
}

function assertGenerationStatus(status: string): asserts status is GenerationStatus {
  if (
    status === 'working' ||
    status === 'investigating' ||
    status === 'submitted' ||
    status === 'integrated' ||
    status === 'rejected' ||
    status === 'abandoned' ||
    status === 'released'
  ) {
    return;
  }
  // Proof: before this runtime boundary, a memory record with status `unknown` constructed
  // successfully; the malformed-lifecycle test observed that the constructor did not throw.
  throw new Error(`invalid authority generation status: ${status}`);
}

function decodeGenerationStatus(status: string): GenerationStatus {
  try {
    assertGenerationStatus(status);
  } catch (cause) {
    throw new Error(`authority database generation status is invalid: ${status}`, { cause });
  }
  return status;
}

function decodeIntegrationStatus(status: string): IntegrationQueueStatus {
  if (
    status === 'queued' ||
    status === 'checking' ||
    status === 'rework' ||
    status === 'publishing' ||
    status === 'published' ||
    status === 'terminal'
  ) {
    return status;
  }
  throw new Error(`authority database integration status is invalid: ${status}`);
}

/** The authority exhausted its configured attempts to take SQLite's write lock. */
export class AuthorityContentionError extends Error {
  constructor(attempts: number, cause?: unknown) {
    super(
      `authority database remained busy after ${String(attempts)} attempts`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'AuthorityContentionError';
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function isBusy(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) return false;
    // Proof: refusing to classify the SQLite code leaked raw `database is locked`; the bounded
    // contention test expected `AuthorityContentionError` from the production acquire path.
    if ('code' in current && (current.code === 'SQLITE_BUSY' || current.code === 'SQLITE_LOCKED')) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function requiredOptions(options: AuthorityStoreOptions): RequiredAuthorityStoreOptions {
  const maxBusyAttempts = options.maxBusyAttempts ?? DEFAULT_BUSY_ATTEMPTS;
  const busyDelayMilliseconds = options.busyDelayMilliseconds ?? DEFAULT_BUSY_DELAY_MS;
  let clock = options.clock;
  if (clock === undefined) clock = { read: () => Date.now() };
  assertAuthorityClock(clock);
  // Proof: before these ceilings, attempts 1001 constructed a live store; the finite-budget test
  // observed that the constructor did not throw.
  if (
    !Number.isSafeInteger(maxBusyAttempts) ||
    maxBusyAttempts < 1 ||
    maxBusyAttempts > MAX_BUSY_ATTEMPTS
  ) {
    throw new Error(`invalid authority busy attempt bound: ${String(maxBusyAttempts)}`);
  }
  if (
    !Number.isSafeInteger(busyDelayMilliseconds) ||
    busyDelayMilliseconds < 0 ||
    // Proof: without the delay ceiling, 1001 ms constructed a live store; the finite-budget
    // test observed that the constructor did not throw.
    busyDelayMilliseconds > MAX_BUSY_DELAY_MS
  ) {
    throw new Error(`invalid authority busy delay: ${String(busyDelayMilliseconds)}`);
  }
  return {
    busyDelayMilliseconds,
    clock,
    maxBusyAttempts,
  };
}

function runGitCommonDirectory(worktreePath: string): string {
  const invocation = Bun.spawnSync(['git', '-C', worktreePath, 'rev-parse', '--git-common-dir'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = new TextDecoder().decode(invocation.stderr).trim();
  if (invocation.exitCode !== 0) {
    throw new Error(
      `cannot resolve common Git directory for ${worktreePath}: ${stderr || `exit ${String(invocation.exitCode)}`}`,
    );
  }
  const stdout = new TextDecoder().decode(invocation.stdout);
  if (stdout.includes('\u0000')) throw new Error('common Git directory output contains NUL');
  const lines = stdout.trimEnd().split('\n');
  if (lines.length !== 1 || lines[0]?.length === 0) {
    throw new Error(`git returned malformed common directory for ${worktreePath}`);
  }
  const common = lines[0];
  return realpathSync(isAbsolute(common) ? common : resolve(worktreePath, common));
}

/** Resolves the one authority file shared by every linked or symlinked worktree. */
export function resolveAuthorityDatabasePath(worktreePath: string): string {
  const commonDirectory = runGitCommonDirectory(worktreePath);
  const authorityDirectory = join(commonDirectory, 'wbs-wiki');
  mkdirSync(authorityDirectory, { recursive: true });
  // Proof: omitting this comparison let `.git/wbs-wiki` redirect the authority outside the
  // common Git directory; the symlink test observed that resolution did not throw.
  if (realpathSync(authorityDirectory) !== authorityDirectory) {
    throw new Error(`authority directory is not canonical: ${authorityDirectory}`);
  }
  return join(authorityDirectory, 'authority.sqlite');
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function assertSchema(database: Database): void {
  const quick = database.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
  // Proof: persisted unknown status, regressed status time and integrated-without-submission faults
  // each made the SQLite lifecycle test observe this production open refuse as corrupt.
  if (quick?.quick_check !== 'ok') {
    throw new Error(`authority database corrupt: quick_check=${quick?.quick_check ?? 'missing'}`);
  }
  const foreignKeyFaults = database
    .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
    .all();
  // Proof: omitting this check let an orphan `libs/contracts` claim open as healthy; the
  // relational-corruption test observed that `openAuthorityStore` did not throw.
  if (foreignKeyFaults.length !== 0) {
    throw new Error('authority database corrupt: foreign-key check failed');
  }
  // Proof: SQL LIKE treated `_` as a wildcard and hid `sqliteXerase`; the production schema
  // test observed that its trigger erased every claim instead of being refused.
  const rows = database
    .query<SchemaRow, []>(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE substr(name, 1, 7) <> 'sqlite_'
       ORDER BY type, name`,
    )
    .all();
  const expected = SCHEMA.map((sql) => ({
    name: /^CREATE TABLE ([a-z_]+)/.exec(sql)?.[1] ?? '',
    sql: normalizedSql(sql),
    type: 'table',
  })).sort((left, right) => left.name.localeCompare(right.name));
  const actual = rows.map((row) => ({
    name: row.name,
    sql: normalizedSql(row.sql),
    type: row.type,
  }));
  // Proof: bypassing this comparison let an existing database with `foreign_state` open;
  // the strict-schema test observed that `openAuthorityStore` did not throw.
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('authority database schema is incompatible');
  }
  const meta = database
    .query<MetaRow, []>(
      `SELECT schema_version AS schemaVersion, next_generation AS nextGeneration
       FROM authority_meta WHERE singleton = 1`,
    )
    .get();
  // Proof: accepting any stored version let `unknown.v99` open; the version test observed that
  // `openAuthorityStore` did not throw. Treating v3 as an empty v4 queue made `existing v3
  // authority state is refused` fail on `Received function did not throw`.
  if (meta?.schemaVersion !== AUTHORITY_SCHEMA_VERSION) {
    throw new Error('authority database version is incompatible');
  }
  if (!Number.isSafeInteger(meta.nextGeneration) || meta.nextGeneration < 1) {
    throw new Error('authority database next generation is invalid');
  }
  // Proof: without decoding persisted identities here, `bad/session`, a relative worktree,
  // `libs/./contracts` and `bad/group` each opened as trusted state; the persisted-identity test
  // observed that `openAuthorityStore` did not throw.
  readSqliteState(database);
}

function assertSchemaWithRetry(database: Database, options: RequiredAuthorityStoreOptions): void {
  for (let attempt = 1; attempt <= options.maxBusyAttempts; attempt += 1) {
    try {
      // Proof: without this snapshot, a valid commit between the meta and owner reads produced
      // `authority next generation does not follow existing generations`; the two-store snapshot
      // test observed false corruption while both the preceding and following states were valid.
      database.run('BEGIN');
      assertSchema(database);
      database.run('COMMIT');
      return;
    } catch (cause) {
      rollbackTransaction(database, cause);
      if (!isBusy(cause)) throw cause;
      if (attempt === options.maxBusyAttempts) {
        throw new AuthorityContentionError(options.maxBusyAttempts, cause);
      }
      Bun.sleepSync(options.busyDelayMilliseconds);
    }
  }
}

function initializeDatabase(database: Database): void {
  database.run('BEGIN IMMEDIATE');
  try {
    for (const sql of SCHEMA) database.run(sql);
    database
      .query<never, [number, string, number]>(
        'INSERT INTO authority_meta(singleton, schema_version, next_generation) VALUES (?, ?, ?)',
      )
      .run(1, AUTHORITY_SCHEMA_VERSION, 1);
    database.run('COMMIT');
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }
}

function openDatabase(
  databasePath: string,
  initialize: boolean,
  options: RequiredAuthorityStoreOptions,
): Database {
  let database: Database;
  try {
    database = new Database(databasePath, { create: initialize, strict: true });
  } catch (error) {
    throw new Error(
      `authority database unreadable: ${databasePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    database.run('PRAGMA foreign_keys = ON');
    database.run('PRAGMA busy_timeout = 0');
    const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
    const busy = database.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
    if (foreignKeys?.foreign_keys !== 1 || busy?.timeout !== 0) {
      throw new Error('authority database connection pragmas were not adopted');
    }
    if (initialize) initializeDatabase(database);
    assertSchemaWithRetry(database, options);
    return database;
  } catch (error) {
    database.close();
    if (error instanceof Error && error.message.startsWith('authority database')) throw error;
    throw new Error(
      `authority database corrupt or incompatible: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function waitForInitializer(initializerPath: string, options: RequiredAuthorityStoreOptions): void {
  for (let attempt = 1; attempt <= options.maxBusyAttempts; attempt += 1) {
    if (!existsSync(initializerPath)) return;
    if (attempt < options.maxBusyAttempts) Bun.sleepSync(options.busyDelayMilliseconds);
  }
  throw new AuthorityContentionError(options.maxBusyAttempts);
}

function connectAuthority(databasePath: string, options: RequiredAuthorityStoreOptions): Database {
  try {
    // Proof: omitting this check followed `authority.sqlite` to an external empty database; the
    // database-symlink test received a schema error instead of the canonical-location refusal.
    if (lstatSync(databasePath).isSymbolicLink()) {
      throw new Error(`authority database is not canonical: ${databasePath}`);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const initializerPath = `${databasePath}.initializing`;
  if (existsSync(databasePath)) {
    waitForInitializer(initializerPath, options);
    return openDatabase(databasePath, false, options);
  }
  try {
    mkdirSync(initializerPath);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    waitForInitializer(initializerPath, options);
    if (!existsSync(databasePath)) {
      throw new Error('authority initialization ended without a database', { cause: error });
    }
    return openDatabase(databasePath, false, options);
  }
  try {
    if (existsSync(databasePath)) return openDatabase(databasePath, false, options);
    return openDatabase(databasePath, true, options);
  } finally {
    rmdirSync(initializerPath);
  }
}

function readSqliteState(database: Database): AuthorityState {
  const meta = database
    .query<MetaRow, []>(
      'SELECT schema_version AS schemaVersion, next_generation AS nextGeneration FROM authority_meta WHERE singleton = 1',
    )
    .get();
  if (meta?.schemaVersion !== AUTHORITY_SCHEMA_VERSION) {
    throw new Error('authority database version is incompatible');
  }
  const generations = database
    .query<GenerationRow, []>(
      `SELECT session_id AS sessionId, worktree_path AS worktreePath, generation, status,
              heartbeat_at AS heartbeatAt, status_at AS statusAt,
              patch_identity AS patchIdentity, candidate_diff_identity AS candidateDiffIdentity,
              content_identity AS contentIdentity, packet_identity AS packetIdentity,
              packet_bytes AS packetBytes
       FROM authority_generation ORDER BY generation`,
    )
    .all();
  const claims = database
    .query<ClaimRow, []>(
      'SELECT session_id AS sessionId, generation, kind, access, identity FROM authority_claim ORDER BY identity, kind',
    )
    .all();
  const integrations = database
    .query<IntegrationRow, []>(
      `SELECT integration_id AS integrationId, target_ref AS targetRef, status,
              queued_at AS queuedAt, status_at AS statusAt, attempt_count AS attemptCount,
              attempt_identity AS attemptIdentity,
              base_commit AS baseCommit, candidate_tree AS candidateTree,
              composition_identity AS compositionIdentity,
              candidate_commit AS candidateCommit, marker_ref AS markerRef,
              terminal_reason AS terminalReason
       FROM authority_integration ORDER BY integration_id`,
    )
    .all();
  const integrationSubmissions = database
    .query<IntegrationSubmissionRow, []>(
      `SELECT integration_id AS integrationId, session_id AS sessionId, generation,
              packet_identity AS packetIdentity, patch_identity AS patchIdentity
       FROM authority_integration_submission ORDER BY integration_id, session_id, generation`,
    )
    .all();
  const integrationResources = database
    .query<IntegrationResourceRow, []>(
      `SELECT integration_id AS integrationId, kind, identity
       FROM authority_integration_resource ORDER BY integration_id, kind, identity`,
    )
    .all();
  const state: AuthorityState = {
    nextGeneration: meta.nextGeneration,
    generations: generations.map((record) => {
      try {
        assertAuthoritySessionId(record.sessionId);
      } catch (cause) {
        throw new Error(`authority database generation session is invalid: ${record.sessionId}`, {
          cause,
        });
      }
      try {
        assertAuthorityWorktreePath(record.worktreePath);
      } catch (cause) {
        throw new Error(
          `authority database generation worktree is invalid: ${record.worktreePath}`,
          {
            cause,
          },
        );
      }
      const submission =
        record.patchIdentity === null &&
        record.candidateDiffIdentity === null &&
        record.contentIdentity === null
          ? undefined
          : record.patchIdentity !== null &&
              record.candidateDiffIdentity !== null &&
              record.contentIdentity !== null
            ? {
                candidateDiffIdentity: record.candidateDiffIdentity,
                contentIdentity: record.contentIdentity,
                patchIdentity: record.patchIdentity,
              }
            : (() => {
                throw new Error(
                  `authority database generation has a partial submission: ${record.sessionId}/${String(record.generation)}`,
                );
              })();
      const packet =
        record.packetIdentity === null && record.packetBytes === null
          ? undefined
          : record.packetIdentity !== null && record.packetBytes !== null
            ? { packetBytes: record.packetBytes, packetIdentity: record.packetIdentity }
            : (() => {
                throw new Error(
                  `authority database generation has a partial packet binding: ${record.sessionId}/${String(record.generation)}`,
                );
              })();
      return {
        generation: record.generation,
        heartbeatAt: record.heartbeatAt,
        sessionId: record.sessionId,
        status: decodeGenerationStatus(record.status),
        statusAt: record.statusAt,
        packet,
        submission,
        worktreePath: record.worktreePath,
        claims: claims
          .filter(
            (claim) =>
              claim.sessionId === record.sessionId && claim.generation === record.generation,
          )
          .map((claim): AuthorityClaim => {
            if (claim.kind === 'group' && claim.access === null) {
              try {
                assertAuthorityConflictGroup(claim.identity);
              } catch (cause) {
                throw new Error(`authority database conflict group is invalid: ${claim.identity}`, {
                  cause,
                });
              }
              return { identity: claim.identity, kind: 'group' };
            }
            if (claim.kind === 'path' && (claim.access === 'read' || claim.access === 'write')) {
              try {
                assertAuthorityClaimPath(claim.identity);
                assertAuthorityPathAccess(claim.access);
              } catch (cause) {
                throw new Error(`authority database path claim is invalid: ${claim.identity}`, {
                  cause,
                });
              }
              return { access: claim.access, identity: claim.identity, kind: 'path' };
            }
            throw new Error(
              `authority database claim is invalid: ${claim.sessionId}/${claim.identity}`,
            );
          }),
      };
    }),
    integrations: integrations.map((record): IntegrationQueueRecord => ({
      attemptCount: record.attemptCount,
      attemptIdentity: record.attemptIdentity ?? undefined,
      baseCommit: record.baseCommit ?? undefined,
      candidateTree: record.candidateTree ?? undefined,
      candidateCommit: record.candidateCommit ?? undefined,
      compositionIdentity: record.compositionIdentity ?? undefined,
      integrationId: record.integrationId,
      markerRef: record.markerRef ?? undefined,
      queuedAt: record.queuedAt,
      resources: integrationResources
        .filter((resource) => resource.integrationId === record.integrationId)
        .map((resource): IntegrationResourceRequirement => {
          if (resource.kind !== 'lane' && resource.kind !== 'port') {
            throw new Error(
              `authority database integration resource kind is invalid: ${resource.kind}`,
            );
          }
          return { identity: resource.identity, kind: resource.kind };
        }),
      status: decodeIntegrationStatus(record.status),
      statusAt: record.statusAt,
      submissions: integrationSubmissions
        .filter((submission) => submission.integrationId === record.integrationId)
        .map((submission) => ({
          generation: submission.generation,
          packetIdentity: submission.packetIdentity,
          patchIdentity: submission.patchIdentity,
          sessionId: submission.sessionId,
        })),
      targetRef: record.targetRef,
      terminalReason: record.terminalReason ?? undefined,
    })),
  };
  assertMemoryState(state);
  if (
    claims.length !==
    state.generations.reduce((count, generation) => count + generation.claims.length, 0)
  ) {
    throw new Error('authority database contains a claim without its exact owner generation');
  }
  if (
    integrationSubmissions.length !==
      state.integrations.reduce(
        (count, integration) => count + integration.submissions.length,
        0,
      ) ||
    integrationResources.length !==
      state.integrations.reduce((count, integration) => count + integration.resources.length, 0)
  ) {
    throw new Error('authority database contains an orphan integration record');
  }
  return state;
}

function writeSqliteState(database: Database, state: AuthorityState): void {
  assertMemoryState(state);
  database.run('DELETE FROM authority_integration_resource');
  database.run('DELETE FROM authority_integration_submission');
  database.run('DELETE FROM authority_integration');
  database.run('DELETE FROM authority_claim');
  database.run('DELETE FROM authority_generation');
  database
    .query<never, [number]>('UPDATE authority_meta SET next_generation = ? WHERE singleton = 1')
    .run(state.nextGeneration);
  const insertGeneration = database.query<
    never,
    [
      string,
      string,
      number,
      GenerationStatus,
      number,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO authority_generation(
       session_id, worktree_path, generation, status, heartbeat_at, status_at,
       patch_identity, candidate_diff_identity, content_identity, packet_identity, packet_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertClaim = database.query<never, [string, number, string, string | null, string]>(
    'INSERT INTO authority_claim(session_id, generation, kind, access, identity) VALUES (?, ?, ?, ?, ?)',
  );
  for (const generation of state.generations) {
    insertGeneration.run(
      generation.sessionId,
      generation.worktreePath,
      generation.generation,
      generation.status,
      generation.heartbeatAt,
      generation.statusAt,
      generation.submission?.patchIdentity ?? null,
      generation.submission?.candidateDiffIdentity ?? null,
      generation.submission?.contentIdentity ?? null,
      generation.packet?.packetIdentity ?? null,
      generation.packet?.packetBytes ?? null,
    );
    for (const claim of generation.claims) {
      insertClaim.run(
        generation.sessionId,
        generation.generation,
        claim.kind,
        claim.kind === 'path' ? claim.access : null,
        claim.identity,
      );
    }
  }
  const insertIntegration = database.query<
    never,
    [
      string,
      string,
      IntegrationQueueStatus,
      number,
      number,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO authority_integration(
       integration_id, target_ref, status, queued_at, status_at, attempt_count,
       attempt_identity, base_commit, candidate_tree, composition_identity, candidate_commit,
       marker_ref, terminal_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertIntegrationSubmission = database.query<
    never,
    [string, string, number, string, string]
  >(
    `INSERT INTO authority_integration_submission(
       integration_id, session_id, generation, packet_identity, patch_identity
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertIntegrationResource = database.query<never, [string, string, string]>(
    `INSERT INTO authority_integration_resource(integration_id, kind, identity)
     VALUES (?, ?, ?)`,
  );
  for (const integration of state.integrations) {
    insertIntegration.run(
      integration.integrationId,
      integration.targetRef,
      integration.status,
      integration.queuedAt,
      integration.statusAt,
      integration.attemptCount,
      integration.attemptIdentity ?? null,
      integration.baseCommit ?? null,
      integration.candidateTree ?? null,
      integration.compositionIdentity ?? null,
      integration.candidateCommit ?? null,
      integration.markerRef ?? null,
      integration.terminalReason ?? null,
    );
    for (const submission of integration.submissions) {
      insertIntegrationSubmission.run(
        integration.integrationId,
        submission.sessionId,
        submission.generation,
        submission.packetIdentity,
        submission.patchIdentity,
      );
    }
    for (const resource of integration.resources) {
      insertIntegrationResource.run(integration.integrationId, resource.kind, resource.identity);
    }
  }
}

function isTransactionOpen(database: Database): boolean {
  return database.inTransaction;
}

function rollbackTransaction(database: Database, transactionCause: unknown): void {
  if (!isTransactionOpen(database)) return;
  try {
    database.run('ROLLBACK');
    if (isTransactionOpen(database)) {
      throw new Error('authority database remained in a transaction after rollback');
    }
  } catch (rollbackCause) {
    // Proof: ignoring an injected rollback failure retried on the still-open transaction and
    // leaked `cannot start a transaction within a transaction`; the rollback-failure test
    // expected both original failures and exactly one callback attempt.
    throw new AggregateError(
      [transactionCause, rollbackCause],
      'authority transaction and rollback both failed',
      { cause: rollbackCause },
    );
  }
}

/** SQLite adapter for the canonical common-Git admission authority. */
class SqliteAuthorityStore implements AuthorityStore {
  readonly #database: Database;
  readonly #options: RequiredAuthorityStoreOptions;

  constructor(databasePath: string, options: AuthorityStoreOptions = {}) {
    this.#options = requiredOptions(options);
    this.#database = connectAuthority(databasePath, this.#options);
  }

  transact<T>(operation: (transaction: AuthorityTransaction) => T): T {
    for (let attempt = 1; attempt <= this.#options.maxBusyAttempts; attempt += 1) {
      try {
        this.#database.run('BEGIN IMMEDIATE');
        let pending = readSqliteState(this.#database);
        const value = operation({
          readState: () => copyState(pending),
          writeState: (state) => {
            assertMemoryState(state);
            pending = copyState(state);
          },
        });
        assertSynchronous(value);
        writeSqliteState(this.#database, pending);
        this.#database.run('COMMIT');
        return value;
      } catch (cause) {
        rollbackTransaction(this.#database, cause);
        // Proof: retrying only BEGIN leaked raw SQLITE_BUSY when a rollback-journal reader
        // blocked COMMIT; the reader tests observed one callback instead of the bounded attempt
        // count, no configured delay, and no convergence after the reader released.
        if (!isBusy(cause)) throw cause;
        if (attempt === this.#options.maxBusyAttempts) {
          throw new AuthorityContentionError(this.#options.maxBusyAttempts, cause);
        }
        Bun.sleepSync(this.#options.busyDelayMilliseconds);
      }
    }
    throw new AuthorityContentionError(this.#options.maxBusyAttempts);
  }

  inspect(): AuthorityState {
    return this.transact((transaction) => transaction.readState());
  }

  close(): void {
    this.#database.close();
  }

  readClock(): number {
    return this.#options.clock.read();
  }
}

/** Opens the canonical authority selected by a repository or linked worktree. */
export function openAuthorityStore(
  worktreePath: string,
  options: AuthorityStoreOptions = {},
): SqliteAuthorityStore {
  return new SqliteAuthorityStore(resolveAuthorityDatabasePath(worktreePath), options);
}
