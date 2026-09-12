import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { parseOrThrow, type } from '@wbs/validation';

import { IsoInstant, OpaqueId, SchemaVersion } from '../contracts/records';
import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import {
  ColdHarnessOutput,
  ColdHarnessRequest,
  decodeColdHarnessOutput,
  decodeInformedHarnessOutput,
  decodeReviewEvidence,
  InformedHarnessOutput,
  InformedHarnessRequest,
  ReviewEvidence,
  type ReviewEvidence as ReviewEvidenceRecord,
  ReviewInvocationRequest,
  type ReviewInvocationRequest as ReviewInvocationRequestRecord,
  type VerifiedTelemetry,
} from './protocol';

const Sha256 = type(/^[0-9a-f]{64}$/);
// Proof: widening this boundary to accept `trusted-harness` let a relabeled local journal pass
// the provenance CLI; the test observed `Expected: 1, Received: 0`.
const LocalTrustScope = type("'local-cooperative'");

export const InvocationRegistration = type({
  invocationId: OpaqueId,
  receiptId: OpaqueId,
  registeredAt: IsoInstant,
  harnessArgv: 'string[]',
  stdinArtifact: Sha256,
  stdinBytes: 'string',
})
  .onUndeclaredKey('reject')
  .narrow((registration, context) =>
    // Proof: accepting every identity let a forged registration stdinArtifact pass journal
    // reading; the exact-bytes test reported "function did not throw".
    registration.stdinArtifact === hashBytes(registration.stdinBytes)
      ? true
      : context.mustBe('a stdinArtifact identifying the exact canonical stdin bytes'),
  );
export type InvocationRegistration = typeof InvocationRegistration.infer;

const ExitedProcess = type({
  kind: "'exited'",
  exitCode: 'number.integer',
}).onUndeclaredKey('reject');
const SignaledProcess = type({
  kind: "'signaled'",
  signalCode: 'string>=1',
}).onUndeclaredKey('reject');
const UnresolvedProcessExit = type({
  kind: "'unresolved'",
  exitCode: 'null',
  signalCode: 'string|null',
}).onUndeclaredKey('reject');
const LaunchFailedProcess = type({
  kind: "'launch-failed'",
  message: 'string>=1',
}).onUndeclaredKey('reject');

export const ProcessObservation = type({
  phase: "'cold'|'informed'",
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  stdinArtifact: Sha256,
  stdinBytes: 'string',
  stdoutArtifact: Sha256,
  stdoutBase64: 'string',
  stderrArtifact: Sha256,
  stderrBase64: 'string',
  exit: ExitedProcess.or(SignaledProcess).or(UnresolvedProcessExit).or(LaunchFailedProcess),
})
  .onUndeclaredKey('reject')
  .narrow((observation, context) => {
    // Proof: bypassing this comparison changed a forged stdinArtifact rejection to the downstream
    // telemetry mismatch; the exact-bytes test expected the stdinArtifact boundary itself.
    if (observation.stdinArtifact !== hashBytes(observation.stdinBytes)) {
      return context.mustBe('a stdinArtifact identifying the exact phase stdin bytes');
    }
    const stdout = decodeBase64(observation.stdoutBase64, 'stdoutBase64');
    // Proof: bypassing this comparison let a forged stdoutArtifact pass journal reading; the
    // exact-bytes test reported "function did not throw" at the stdoutArtifact assertion.
    if (observation.stdoutArtifact !== hashBytes(stdout)) {
      return context.mustBe('a stdoutArtifact identifying the exact raw stdout bytes');
    }
    const stderr = decodeBase64(observation.stderrBase64, 'stderrBase64');
    // Proof: bypassing this comparison let rewritten retained stderr pass journal reading; the
    // exact-bytes test reported "function did not throw" at the stderrArtifact assertion.
    if (observation.stderrArtifact !== hashBytes(stderr)) {
      return context.mustBe('a stderrArtifact identifying the exact raw stderr bytes');
    }
    return Date.parse(observation.endedAt) >= Date.parse(observation.startedAt)
      ? true
      : context.mustBe('a process observation whose end is not before its start');
  });
export type ProcessObservation = typeof ProcessObservation.infer;

export const ColdAttempt = type({
  observation: ProcessObservation,
  output: ColdHarnessOutput.or('null'),
  decodeFailure: 'string|null',
}).onUndeclaredKey('reject');
export type ColdAttempt = typeof ColdAttempt.infer;

export const InformedAttempt = type({
  observation: ProcessObservation,
  output: InformedHarnessOutput.or('null'),
  decodeFailure: 'string|null',
}).onUndeclaredKey('reject');
export type InformedAttempt = typeof InformedAttempt.infer;

export const ColdAcknowledgement = type({
  acknowledgedAt: IsoInstant,
  attempt: ColdAttempt,
}).onUndeclaredKey('reject');
export type ColdAcknowledgement = typeof ColdAcknowledgement.infer;

const ReviewedTerminal = type({
  status: "'reviewed'",
  completedAt: IsoInstant,
  informed: InformedAttempt,
  evidence: ReviewEvidence,
}).onUndeclaredKey('reject');

const ColdUnverifiedTerminal = type({
  status: "'unverified'",
  completedAt: IsoInstant,
  phase: "'cold'",
  reason: 'string>=1',
  attempt: ColdAttempt,
  evidence: 'null',
}).onUndeclaredKey('reject');

const InformedUnverifiedTerminal = type({
  status: "'unverified'",
  completedAt: IsoInstant,
  phase: "'informed'",
  reason: 'string>=1',
  attempt: InformedAttempt,
  evidence: 'null',
}).onUndeclaredKey('reject');

export const InvocationTerminal = ReviewedTerminal.or(ColdUnverifiedTerminal).or(
  InformedUnverifiedTerminal,
);
export type InvocationTerminal = typeof InvocationTerminal.infer;

const RegisteredInvocation = type({
  state: "'registered'",
  registration: InvocationRegistration,
}).onUndeclaredKey('reject');

const ColdAcknowledgedInvocation = type({
  state: "'cold-acknowledged'",
  registration: InvocationRegistration,
  cold: ColdAcknowledgement,
}).onUndeclaredKey('reject');

const TerminalInvocation = type({
  state: "'terminal'",
  registration: InvocationRegistration,
  'cold?': ColdAcknowledgement,
  terminal: InvocationTerminal,
}).onUndeclaredKey('reject');

export const InvocationJournalRecord = type({
  schemaVersion: SchemaVersion,
  journalId: OpaqueId,
  trustScope: LocalTrustScope,
  entries: RegisteredInvocation.or(ColdAcknowledgedInvocation).or(TerminalInvocation).array(),
})
  .onUndeclaredKey('reject')
  .narrow((journal, context) =>
    new Set(journal.entries.map(({ registration }) => registration.invocationId)).size ===
    journal.entries.length
      ? true
      : context.mustBe('entries with unique invocationId'),
  );
export type InvocationJournalRecord = typeof InvocationJournalRecord.infer;

export interface DurableAcceptance {
  status: 'durable';
  journalId: string;
  invocationId: string;
  artifact: string;
}

export interface InvocationJournal {
  readonly journalId: string;
  readonly trustScope: 'local-cooperative';
  register(registration: InvocationRegistration): DurableAcceptance;
  acknowledgeCold(invocationId: string, cold: ColdAcknowledgement): DurableAcceptance;
  complete(invocationId: string, terminal: InvocationTerminal): DurableAcceptance;
  read(): InvocationJournalRecord;
}

export interface ReviewInvoker {
  invoke(request: ReviewInvocationRequestRecord): ReviewInvocationResult;
}

export type ReviewInvocationResult =
  | { status: 'verified'; evidence: ReviewEvidenceRecord }
  | { status: 'unverified'; invocationId: string; reason: string };

function decodeBase64(source: string, subject: string): Uint8Array {
  const bytes = Buffer.from(source, 'base64');
  if (bytes.toString('base64') !== source) throw new Error(`${subject} is not canonical base64`);
  return bytes;
}

function decodeUtf8(bytes: Uint8Array, subject: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${subject} is not UTF-8: ${detail}`, { cause });
  }
}

function decodeJson(source: string, subject: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${subject} is malformed JSON: ${detail}`, { cause });
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function decodeRegistration(registration: InvocationRegistration): ReviewInvocationRequestRecord {
  const request = parseOrThrow(
    ReviewInvocationRequest,
    decodeJson(registration.stdinBytes, 'registered review request'),
  );
  if (serializeCanonical(request) !== registration.stdinBytes) {
    throw new Error(`registered review request is not exact canonical stdin`);
  }
  if (
    request.invocationId !== registration.invocationId ||
    request.receiptId !== registration.receiptId
  ) {
    throw new Error(`registered review request identity differs from journal registration`);
  }
  return request;
}

/**
 * Builds the cold stdin without informed context identities or payloads.
 *
 * Proof: adding `informedContextIds` here and to the cold schema made the production harness exit
 * 31 (`review harness exited 31`) in the durable-boundary test.
 */
function coldRequest(request: ReviewInvocationRequestRecord): typeof ColdHarnessRequest.infer {
  return parseOrThrow(ColdHarnessRequest, {
    schemaVersion: 1,
    messageKind: 'cold-request',
    invocationId: request.invocationId,
    receiptId: request.receiptId,
    protocol: request.protocol,
    subject: request.subject,
  });
}

function informedRequest(
  request: ReviewInvocationRequestRecord,
  cold: ColdAcknowledgement,
): typeof InformedHarnessRequest.infer {
  if (cold.attempt.output === null) throw new Error(`cold acknowledgement has no decoded output`);
  return parseOrThrow(InformedHarnessRequest, {
    schemaVersion: 1,
    messageKind: 'informed-request',
    invocationId: request.invocationId,
    receiptId: request.receiptId,
    protocol: request.protocol,
    subject: request.subject,
    cold: cold.attempt.output.cold,
    coldArtifact: hashCanonical(cold.attempt.output.cold),
    informedContextIds: request.informedContextIds,
  });
}

function decodeAttemptOutput<T>(
  observation: ProcessObservation,
  retained: T | null,
  decode: (input: unknown) => T,
): T | null {
  if (retained === null) return null;
  const bytes = decodeBase64(observation.stdoutBase64, 'stdoutBase64');
  let decoded: T;
  try {
    decoded = decode(
      decodeJson(decodeUtf8(bytes, 'retained phase stdout'), 'retained phase stdout'),
    );
  } catch (cause) {
    throw new Error(`retained output is not decodable from exact stdout: ${errorMessage(cause)}`, {
      cause,
    });
  }
  // Proof: removing the retained-vs-decoded comparison let a rewritten payload and telemetry
  // charge pass readInvocationJournal; the exact-stdout test reported "function did not throw".
  if (hashCanonical(decoded) !== hashCanonical(retained)) {
    throw new Error(`retained output differs from exact stdout`);
  }
  return decoded;
}

function reconcileTelemetry(
  telemetry: VerifiedTelemetry,
  observation: ProcessObservation,
  registeredAt: string,
  invocationId: string,
): void {
  // Proof: bypassing this comparison made a cold receipt for `invocation.forged` verify; the
  // telemetry-invalid test received `verified` instead of `unverified`.
  if (telemetry.receipt.invocationId !== invocationId) {
    throw new Error(`telemetry invocationId differs from registered invocation`);
  }
  if (telemetry.receipt.inputArtifact !== observation.stdinArtifact) {
    throw new Error(`telemetry inputArtifact differs from exact phase stdin`);
  }
  if (Date.parse(telemetry.receipt.startedAt) < Date.parse(registeredAt)) {
    throw new Error(`telemetry starts before durable invocation registration`);
  }
}

/**
 * Reconciles retained bytes without treating an invalid protocol claim as invalid journal data.
 *
 * Proof: moving the protocol comparison into this byte reconciliation made terminal persistence
 * throw `cold output protocol, subject or invocation differs from registered request`.
 */
function reconcileColdAttempt(
  registration: InvocationRegistration,
  attempt: ColdAttempt,
): ColdHarnessOutput | null {
  const request = decodeRegistration(registration);
  if (attempt.observation.phase !== 'cold') throw new Error(`cold attempt has informed phase`);
  const expectedInput = serializeCanonical(coldRequest(request));
  if (attempt.observation.stdinBytes !== expectedInput) {
    throw new Error(`cold attempt stdin differs from cold-only request`);
  }
  const output = decodeAttemptOutput(attempt.observation, attempt.output, decodeColdHarnessOutput);
  if (output === null) return null;
  return output;
}

function reconcileInformedAttempt(
  registration: InvocationRegistration,
  cold: ColdAcknowledgement,
  attempt: InformedAttempt,
): InformedHarnessOutput | null {
  const request = decodeRegistration(registration);
  if (attempt.observation.phase !== 'informed') throw new Error(`informed attempt has cold phase`);
  const expected = informedRequest(request, cold);
  if (attempt.observation.stdinBytes !== serializeCanonical(expected)) {
    throw new Error(`informed attempt stdin differs from acknowledged cold boundary`);
  }
  const output = decodeAttemptOutput(
    attempt.observation,
    attempt.output,
    decodeInformedHarnessOutput,
  );
  if (output === null) return null;
  return output;
}

function assertSuccessfulAttempt<T extends ColdHarnessOutput | InformedHarnessOutput>(
  attempt: ColdAttempt | InformedAttempt,
  output: T | null,
): asserts output is T & { telemetry: VerifiedTelemetry } {
  if (attempt.observation.exit.kind === 'launch-failed') {
    throw new Error(`launch failed: ${attempt.observation.exit.message}`);
  }
  // Proof: returning here let a signal attempt reach null telemetry; both production harness
  // tests received `null is not an object (evaluating 'output.telemetry')` instead of SIGTERM.
  if (attempt.observation.exit.kind === 'signaled') {
    throw new Error(`review harness terminated by ${attempt.observation.exit.signalCode}`);
  }
  if (attempt.observation.exit.kind === 'unresolved') {
    throw new Error(
      attempt.observation.exit.signalCode === ''
        ? `review harness returned no exit code and an empty signal code`
        : `review harness returned neither an exit code nor a signal code`,
    );
  }
  if (attempt.observation.exit.exitCode !== 0) {
    throw new Error(`review harness exited ${String(attempt.observation.exit.exitCode)}`);
  }
  if (attempt.decodeFailure !== null) throw new Error(attempt.decodeFailure);
  if (output === null) throw new Error(`review harness produced no decodable output`);
  // Proof: accepting unverified telemetry here launched informed; the partial-telemetry test
  // received informed `verified` telemetry instead of retained cold `unverified` telemetry.
  if (output.telemetry.status === 'unverified') throw new Error(output.telemetry.reason);
  if (output.telemetry.receipt.status !== 'completed') {
    throw new Error(`invocation status ${output.telemetry.receipt.status}`);
  }
}

function deriveReviewEvidence(
  request: ReviewInvocationRequestRecord,
  cold: ColdHarnessOutput,
  informed: InformedHarnessOutput,
  journalId: string,
): ReviewEvidenceRecord {
  if (cold.telemetry.status !== 'verified' || informed.telemetry.status !== 'verified') {
    throw new Error(`review evidence requires verified phase telemetry`);
  }
  if (
    hashCanonical(cold.telemetry.receipt.executor) !==
      hashCanonical(informed.telemetry.receipt.executor) ||
    hashCanonical(cold.telemetry.receipt.priceIdentity) !==
      hashCanonical(informed.telemetry.receipt.priceIdentity)
  ) {
    throw new Error(`review phases require one compatible executor and price identity`);
  }
  const coldArtifact = hashCanonical(cold.cold);
  return parseOrThrow(ReviewEvidence, {
    schemaVersion: 1,
    receipt: {
      schemaVersion: 1,
      receiptKind: 'review',
      receiptId: request.receiptId,
      invocationId: request.invocationId,
      executor: informed.telemetry.receipt.executor,
      suppliedContextIds: [
        request.protocol.protocolBlob,
        request.subject.contentIdentity,
        ...request.informedContextIds,
      ],
      observedReadIds: [...cold.cold.observedReadIds, ...informed.informed.observedReadIds],
      rawResponseArtifact: hashBytes(informed.rawResponse.payload),
      rawUsage: [...cold.telemetry.receipt.rawUsage, ...informed.telemetry.receipt.rawUsage],
      priceIdentity: informed.telemetry.receipt.priceIdentity,
      trust: { scope: 'local-cooperative', journalId },
    },
    protocolEvidence: {
      schemaVersion: 1,
      protocol: request.protocol,
      subject: request.subject,
      cold: cold.cold,
      expansion: {
        sequence: 2,
        coldJudgmentArtifact: coldArtifact,
        suppliedContextIds: request.informedContextIds,
      },
      informed: informed.informed,
    },
    // Proof: swapping these receipts made the cold cost assertion receive 14000 µUSD instead of
    // 11000 µUSD, so phase costs cannot collapse into an aggregate.
    phaseReceipts: { cold: cold.telemetry, informed: informed.telemetry },
    phaseTools: { cold: cold.actualTools, informed: informed.actualTools },
    // Proof: filtering out the repeated cold tool made the phase-order test receive two tool
    // observations instead of the exact three-entry sequence (including its duplicate).
    actualTools: [...cold.actualTools, ...informed.actualTools],
    rawResponse: {
      artifact: hashBytes(informed.rawResponse.payload),
      retention: informed.rawResponse.retention,
    },
  });
}

function reconcileColdAcknowledgement(
  registration: InvocationRegistration,
  cold: ColdAcknowledgement,
): ColdHarnessOutput {
  const request = decodeRegistration(registration);
  const output = reconcileColdAttempt(registration, cold.attempt);
  assertSuccessfulAttempt(cold.attempt, output);
  reconcileTelemetry(
    output.telemetry,
    cold.attempt.observation,
    registration.registeredAt,
    registration.invocationId,
  );
  if (
    output.invocationId !== request.invocationId ||
    hashCanonical(output.protocol) !== hashCanonical(request.protocol) ||
    hashCanonical(output.subject) !== hashCanonical(request.subject)
  ) {
    throw new Error(`cold output protocol, subject or invocation differs from registered request`);
  }
  return output;
}

function reconcileReviewedInformed(
  registration: InvocationRegistration,
  cold: ColdAcknowledgement,
  attempt: InformedAttempt,
): InformedHarnessOutput {
  const request = decodeRegistration(registration);
  const expected = informedRequest(request, cold);
  const output = reconcileInformedAttempt(registration, cold, attempt);
  assertSuccessfulAttempt(attempt, output);
  reconcileTelemetry(
    output.telemetry,
    attempt.observation,
    registration.registeredAt,
    registration.invocationId,
  );
  if (
    output.invocationId !== request.invocationId ||
    hashCanonical(output.protocol) !== hashCanonical(request.protocol) ||
    hashCanonical(output.subject) !== hashCanonical(request.subject) ||
    output.coldArtifact !== expected.coldArtifact
  ) {
    throw new Error(`informed output differs from acknowledged cold boundary or request`);
  }
  return output;
}

function reconcileEntry(
  entry: InvocationJournalRecord['entries'][number],
  journalId: string,
): void {
  const request = decodeRegistration(entry.registration);
  if (entry.state === 'registered') return;
  if (entry.state === 'cold-acknowledged') {
    reconcileColdAcknowledgement(entry.registration, entry.cold);
    return;
  }
  if (entry.terminal.status === 'unverified') {
    if (entry.terminal.phase === 'cold') {
      reconcileColdAttempt(entry.registration, entry.terminal.attempt);
    } else {
      if (entry.cold === undefined)
        throw new Error(`informed terminal has no cold acknowledgement`);
      reconcileColdAcknowledgement(entry.registration, entry.cold);
      reconcileInformedAttempt(entry.registration, entry.cold, entry.terminal.attempt);
    }
    return;
  }
  if (entry.cold === undefined) throw new Error(`reviewed terminal has no cold acknowledgement`);
  const cold = reconcileColdAcknowledgement(entry.registration, entry.cold);
  const informed = reconcileReviewedInformed(
    entry.registration,
    entry.cold,
    entry.terminal.informed,
  );
  const derived = deriveReviewEvidence(request, cold, informed, journalId);
  if (hashCanonical(derived) !== hashCanonical(entry.terminal.evidence)) {
    throw new Error(`retained review evidence differs from exact phase outputs and request`);
  }
}

/** Reads and reconciles every retained field against canonical request and process bytes. */
export function readInvocationJournal(path: string): InvocationJournalRecord {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw new Error(`cannot read invocation journal ${path}: ${errorMessage(cause)}`, { cause });
  }
  const journal = parseOrThrow(
    InvocationJournalRecord,
    decodeJson(decodeUtf8(bytes, `invocation journal ${path}`), `invocation journal ${path}`),
  );
  for (const entry of journal.entries) reconcileEntry(entry, journal.journalId);
  return journal;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function createDurably(path: string, journal: InvocationJournalRecord): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, serializeCanonical(journal), 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(dirname(path));
}

function replaceDurably(path: string, journal: InvocationJournalRecord): void {
  const replacement = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${crypto.randomUUID()}.new`,
  );
  const descriptor = openSync(replacement, 'wx', 0o600);
  try {
    writeFileSync(descriptor, serializeCanonical(journal), 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(replacement, path);
  syncDirectory(dirname(path));
}

function isExistingLock(cause: unknown): boolean {
  return cause instanceof Error && Reflect.get(cause, 'code') === 'EEXIST';
}

function createLockDirectory(path: string, waitMs: number): void {
  const deadline = Date.now() + waitMs;
  let lastConflict: unknown;
  do {
    try {
      mkdirSync(path, { mode: 0o700 });
      return;
    } catch (cause) {
      if (!isExistingLock(cause)) throw cause;
      // Proof: deleting an existing lock here let one completion worker finish and another fail
      // while the owner still held it; the overlap test observed `[1, 0]`, not `[null, null]`.
      lastConflict = cause;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for invocation journal lock: ${path}`, {
    cause: lastConflict,
  });
}

/** An owned cross-process lock; stale locks are never stolen. */
export class FileJournalLock {
  private isReleased = false;

  private constructor(
    readonly path: string,
    private readonly owner: string,
  ) {}

  static acquire(journalPath: string, waitMs = 5000): FileJournalLock {
    const path = `${journalPath}.lock`;
    createLockDirectory(path, waitMs);
    const owner = `${String(process.pid)}.${crypto.randomUUID()}\n`;
    try {
      writeFileSync(join(path, 'owner'), owner, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      syncDirectory(path);
    } catch (cause) {
      rmSync(join(path, 'owner'), { force: true });
      rmdirSync(path);
      throw cause;
    }
    return new FileJournalLock(path, owner);
  }

  release(): void {
    if (this.isReleased) throw new Error(`invocation journal lock already released: ${this.path}`);
    const observed = readFileSync(join(this.path, 'owner'), 'utf8');
    // Proof: bypassing this comparison let a contender delete another owner's lock; the overlap
    // test reported "function did not throw" at the ownership assertion.
    if (observed !== this.owner) {
      throw new Error(`invocation journal lock ownership changed: ${this.path}`);
    }
    unlinkSync(join(this.path, 'owner'));
    rmdirSync(this.path);
    syncDirectory(dirname(this.path));
    this.isReleased = true;
  }
}

function withJournalLock<T>(path: string, waitMs: number, action: () => T): T {
  // Proof: bypassing this lock let both held-lock registration workers finish early; the overlap
  // test observed `[0, 0]` instead of `[null, null]` before the owner released the lock.
  const lock = FileJournalLock.acquire(path, waitMs);
  try {
    return action();
  } finally {
    lock.release();
  }
}

/** A canonical invocation journal with serialized, fsynced, read-back transitions. */
export class FileInvocationJournal implements InvocationJournal {
  readonly trustScope = 'local-cooperative' as const;

  private constructor(
    private readonly path: string,
    readonly journalId: string,
    private readonly lockWaitMs: number,
  ) {}

  static create(path: string, journalId: string, lockWaitMs = 5000): FileInvocationJournal {
    return withJournalLock(path, lockWaitMs, () => {
      const journal = parseOrThrow(InvocationJournalRecord, {
        schemaVersion: 1,
        journalId,
        trustScope: 'local-cooperative',
        entries: [],
      });
      createDurably(path, journal);
      const stored = readInvocationJournal(path);
      if (hashCanonical(stored) !== hashCanonical(journal)) {
        throw new Error(`durable invocation journal creation differs after read-back: ${path}`);
      }
      return new FileInvocationJournal(path, journalId, lockWaitMs);
    });
  }

  static open(path: string, lockWaitMs = 5000): FileInvocationJournal {
    const journal = readInvocationJournal(path);
    return new FileInvocationJournal(path, journal.journalId, lockWaitMs);
  }

  read(): InvocationJournalRecord {
    const journal = readInvocationJournal(this.path);
    if (journal.journalId !== this.journalId) {
      throw new Error(`invocation journal identity changed at ${this.path}`);
    }
    return journal;
  }

  register(registration: InvocationRegistration): DurableAcceptance {
    const checked = parseOrThrow(InvocationRegistration, registration);
    // Proof: bypassing this preflight durably appended `invocation.malformed-json`; the unchanged-
    // byte assertion reported `Expected - 0 / Received + 306` before any duplicate could apply.
    decodeRegistration(checked);
    return withJournalLock(this.path, this.lockWaitMs, () => {
      const journal = this.read();
      if (
        journal.entries.some((entry) => entry.registration.invocationId === checked.invocationId)
      ) {
        throw new Error(`invocation already registered: ${checked.invocationId}`);
      }
      return this.persist(
        checked.invocationId,
        parseOrThrow(InvocationJournalRecord, {
          ...journal,
          entries: [...journal.entries, { state: 'registered', registration: checked }],
        }),
        { state: 'registered', registration: checked },
      );
    });
  }

  acknowledgeCold(invocationId: string, cold: ColdAcknowledgement): DurableAcceptance {
    const checked = parseOrThrow(ColdAcknowledgement, cold);
    return withJournalLock(this.path, this.lockWaitMs, () => {
      const journal = this.read();
      const index = journal.entries.findIndex(
        (entry) => entry.registration.invocationId === invocationId,
      );
      if (index < 0)
        throw new Error(`cannot acknowledge cold for unknown invocation: ${invocationId}`);
      const current = journal.entries[index];
      if (current.state === 'terminal') {
        // Proof: returning the terminal acceptance here made acknowledgeCold succeed after
        // completion; the terminal-safety test reported "function did not throw".
        throw new Error(`cannot acknowledge cold after terminal invocation: ${invocationId}`);
      }
      if (current.state === 'cold-acknowledged') {
        if (hashCanonical(current.cold) === hashCanonical(checked)) {
          return this.acceptance(invocationId, current);
        }
        throw new Error(`invocation already has a different cold acknowledgement: ${invocationId}`);
      }
      reconcileColdAcknowledgement(current.registration, checked);
      const next = {
        state: 'cold-acknowledged' as const,
        registration: current.registration,
        cold: checked,
      };
      const entries = [...journal.entries];
      entries[index] = next;
      return this.persist(
        invocationId,
        parseOrThrow(InvocationJournalRecord, { ...journal, entries }),
        next,
      );
    });
  }

  complete(invocationId: string, terminal: InvocationTerminal): DurableAcceptance {
    const checked = parseOrThrow(InvocationTerminal, terminal);
    return withJournalLock(this.path, this.lockWaitMs, () => {
      const journal = this.read();
      const index = journal.entries.findIndex(
        (entry) => entry.registration.invocationId === invocationId,
      );
      if (index < 0) throw new Error(`cannot complete unknown invocation: ${invocationId}`);
      const current = journal.entries[index];
      if (current.state === 'terminal') {
        // Proof: accepting every repeated completion made a changed completedAt return durable;
        // the terminal-safety test reported "function did not throw".
        if (hashCanonical(current.terminal) === hashCanonical(checked)) {
          return this.acceptance(invocationId, current);
        }
        throw new Error(`invocation already has a different terminal completion: ${invocationId}`);
      }
      const next = {
        state: 'terminal' as const,
        registration: current.registration,
        ...(current.state === 'cold-acknowledged' ? { cold: current.cold } : {}),
        terminal: checked,
      };
      reconcileEntry(next, journal.journalId);
      const entries = [...journal.entries];
      entries[index] = next;
      return this.persist(
        invocationId,
        parseOrThrow(InvocationJournalRecord, { ...journal, entries }),
        next,
      );
    });
  }

  private acceptance(invocationId: string, observation: unknown): DurableAcceptance {
    return {
      status: 'durable',
      journalId: this.journalId,
      invocationId,
      artifact: hashCanonical(observation),
    };
  }

  private persist(
    invocationId: string,
    journal: InvocationJournalRecord,
    observation: unknown,
  ): DurableAcceptance {
    replaceDurably(this.path, journal);
    const stored = this.read().entries.find(
      (entry) => entry.registration.invocationId === invocationId,
    );
    if (stored === undefined || hashCanonical(stored) !== hashCanonical(observation)) {
      throw new Error(`durable invocation transition differs after read-back: ${invocationId}`);
    }
    return this.acceptance(invocationId, observation);
  }
}

function phaseObservation(
  phase: 'cold' | 'informed',
  stdinBytes: string,
  harnessArgv: readonly string[],
): { observation: ProcessObservation; stdout: Uint8Array } {
  const startedAt = new Date().toISOString();
  let processResult: Bun.SyncSubprocess<'pipe', 'pipe'>;
  // Only a throw from Bun.spawnSync is a launch failure. Proof: routing a returned SIGTERM through
  // this recovery erased both streams; the cold negative observed exact stdout base64 versus `""`,
  // and the informed negative observed the same loss for its phase.
  try {
    processResult = Bun.spawnSync([...harnessArgv], {
      stdin: Buffer.from(stdinBytes, 'utf8'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (cause) {
    const endedAt = new Date().toISOString();
    const empty = new Uint8Array();
    return {
      observation: parseOrThrow(ProcessObservation, {
        phase,
        startedAt,
        endedAt,
        stdinArtifact: hashBytes(stdinBytes),
        stdinBytes,
        stdoutArtifact: hashBytes(empty),
        stdoutBase64: '',
        stderrArtifact: hashBytes(empty),
        stderrBase64: '',
        exit: { kind: 'launch-failed', message: errorMessage(cause) },
      }),
      stdout: empty,
    };
  }
  const endedAt = new Date().toISOString();
  const signalCode = processResult.signalCode;
  const exit =
    // Proof: classifying returned SIGTERM as unresolved made both production harness negatives
    // receive `{ kind: "unresolved", exitCode: null }` instead of the signaled observation.
    typeof signalCode === 'string' && signalCode.length > 0
      ? { kind: 'signaled' as const, signalCode }
      : typeof processResult.exitCode === 'number'
        ? { kind: 'exited' as const, exitCode: processResult.exitCode }
        : {
            // Proof: treating null/no-signal as exited made the production path throw
            // `exit.exitCode must be a number (was null)` instead of persisting its streams.
            kind: 'unresolved' as const,
            exitCode: null,
            signalCode: signalCode ?? null,
          };
  return {
    observation: parseOrThrow(ProcessObservation, {
      phase,
      startedAt,
      endedAt,
      stdinArtifact: hashBytes(stdinBytes),
      stdinBytes,
      stdoutArtifact: hashBytes(processResult.stdout),
      stdoutBase64: Buffer.from(processResult.stdout).toString('base64'),
      stderrArtifact: hashBytes(processResult.stderr),
      stderrBase64: Buffer.from(processResult.stderr).toString('base64'),
      exit,
    }),
    stdout: processResult.stdout,
  };
}

function coldAttempt(stdinBytes: string, harnessArgv: readonly string[]): ColdAttempt {
  const captured = phaseObservation('cold', stdinBytes, harnessArgv);
  if (captured.observation.exit.kind === 'launch-failed') {
    return parseOrThrow(ColdAttempt, {
      observation: captured.observation,
      output: null,
      decodeFailure: `launch failed: ${captured.observation.exit.message}`,
    });
  }
  try {
    return parseOrThrow(ColdAttempt, {
      observation: captured.observation,
      output: decodeColdHarnessOutput(
        decodeJson(decodeUtf8(captured.stdout, 'cold stdout'), 'cold stdout'),
      ),
      decodeFailure: null,
    });
  } catch (cause) {
    return parseOrThrow(ColdAttempt, {
      observation: captured.observation,
      output: null,
      decodeFailure: errorMessage(cause),
    });
  }
}

function informedAttempt(stdinBytes: string, harnessArgv: readonly string[]): InformedAttempt {
  const captured = phaseObservation('informed', stdinBytes, harnessArgv);
  if (captured.observation.exit.kind === 'launch-failed') {
    return parseOrThrow(InformedAttempt, {
      observation: captured.observation,
      output: null,
      decodeFailure: `launch failed: ${captured.observation.exit.message}`,
    });
  }
  try {
    return parseOrThrow(InformedAttempt, {
      observation: captured.observation,
      output: decodeInformedHarnessOutput(
        decodeJson(decodeUtf8(captured.stdout, 'informed stdout'), 'informed stdout'),
      ),
      decodeFailure: null,
    });
  } catch (cause) {
    return parseOrThrow(InformedAttempt, {
      observation: captured.observation,
      output: null,
      decodeFailure: errorMessage(cause),
    });
  }
}

/** Invokes cold and informed phases with a durable acknowledgement between their launches. */
export class ProcessReviewInvoker implements ReviewInvoker {
  constructor(
    private readonly journal: InvocationJournal,
    private readonly harnessArgv: readonly string[],
  ) {
    if (harnessArgv.length === 0) throw new Error('review harness argv must not be empty');
  }

  invoke(request: ReviewInvocationRequestRecord): ReviewInvocationResult {
    const checked = parseOrThrow(ReviewInvocationRequest, request);
    const registrationBytes = serializeCanonical(checked);
    const registration = parseOrThrow(InvocationRegistration, {
      invocationId: checked.invocationId,
      receiptId: checked.receiptId,
      registeredAt: new Date().toISOString(),
      harnessArgv: [...this.harnessArgv],
      stdinArtifact: hashBytes(registrationBytes),
      stdinBytes: registrationBytes,
    });
    // Proof: bypassing registration let the cold harness run first and the production path failed
    // on `cannot complete unknown invocation: invocation.integration-test`.
    const registered = this.journal.register(registration);
    if (registered.invocationId !== checked.invocationId) {
      throw new Error(`invocation journal did not durably accept ${checked.invocationId}`);
    }

    const coldInput = serializeCanonical(coldRequest(checked));
    const cold = coldAttempt(coldInput, this.harnessArgv);
    const coldAcknowledgement = parseOrThrow(ColdAcknowledgement, {
      acknowledgedAt: new Date().toISOString(),
      attempt: cold,
    });
    let coldOutput: ColdHarnessOutput | null = null;
    let coldSemanticFailure: string | null = null;
    try {
      coldOutput = reconcileColdAcknowledgement(registration, coldAcknowledgement);
    } catch (cause) {
      coldSemanticFailure = errorMessage(cause);
    }
    const coldFailure = coldSemanticFailure;
    if (coldFailure !== null || coldOutput === null) {
      const terminal = parseOrThrow(InvocationTerminal, {
        status: 'unverified',
        completedAt: new Date().toISOString(),
        phase: 'cold',
        reason: coldFailure ?? 'cold output unavailable',
        attempt: cold,
        evidence: null,
      });
      // Proof: bypassing this completion left a nonzero process merely `registered`; the failure
      // persistence test threw `expected unverified terminal`.
      this.journal.complete(checked.invocationId, terminal);
      return {
        status: 'unverified',
        invocationId: checked.invocationId,
        reason: coldFailure ?? 'cold output unavailable',
      };
    }

    // Proof: bypassing this transition let the informed harness see only `registered`; the
    // production path failed on `informed terminal has no cold acknowledgement`.
    const acknowledged = this.journal.acknowledgeCold(checked.invocationId, coldAcknowledgement);
    if (acknowledged.invocationId !== checked.invocationId) {
      throw new Error(
        `invocation journal did not durably acknowledge cold ${checked.invocationId}`,
      );
    }

    const informedInput = serializeCanonical(informedRequest(checked, coldAcknowledgement));
    const informed = informedAttempt(informedInput, this.harnessArgv);
    let informedOutput: InformedHarnessOutput | null = null;
    let informedSemanticFailure: string | null = null;
    try {
      informedOutput = reconcileReviewedInformed(registration, coldAcknowledgement, informed);
    } catch (cause) {
      informedSemanticFailure = errorMessage(cause);
    }
    let informedFailure = informedSemanticFailure;
    let evidence: ReviewEvidenceRecord | null = null;
    if (informedFailure === null && informedOutput !== null) {
      try {
        evidence = deriveReviewEvidence(
          checked,
          coldOutput,
          informedOutput,
          this.journal.journalId,
        );
      } catch (cause) {
        informedFailure = errorMessage(cause);
      }
    }
    if (informedFailure !== null || informedOutput === null || evidence === null) {
      const terminal = parseOrThrow(InvocationTerminal, {
        status: 'unverified',
        completedAt: new Date().toISOString(),
        phase: 'informed',
        reason: informedFailure ?? 'informed output unavailable',
        attempt: informed,
        evidence: null,
      });
      // Proof: bypassing this completion left a nonzero informed process at `cold-acknowledged`;
      // the informed-failure test threw `expected unverified terminal`.
      this.journal.complete(checked.invocationId, terminal);
      return {
        status: 'unverified',
        invocationId: checked.invocationId,
        reason: informedFailure ?? 'informed output unavailable',
      };
    }
    const terminal = parseOrThrow(InvocationTerminal, {
      status: 'reviewed',
      completedAt: new Date().toISOString(),
      informed,
      evidence,
    });
    this.journal.complete(checked.invocationId, terminal);
    return { status: 'verified', evidence };
  }
}

export type ProvenanceRequirement = 'allow-local' | 'require-external';

export interface ProvenanceValidation {
  status: 'verified';
  scope: 'local-cooperative';
  satisfiesExternal: false;
}

/** Re-derives writer evidence from exact retained phase bytes before comparison. */
export function validateReviewProvenance(
  journal: InvocationJournalRecord,
  submitted: unknown,
  requirement: ProvenanceRequirement,
): ProvenanceValidation {
  const evidence = decodeReviewEvidence(submitted);
  const entry = journal.entries.find(
    ({ registration }) => registration.invocationId === evidence.receipt.invocationId,
  );
  // Proof: falling back to the first entry changed a forged-id CLI rejection from
  // `unknown invocation: invocation.forged` to a generic evidence mismatch.
  if (entry === undefined) throw new Error(`unknown invocation: ${evidence.receipt.invocationId}`);
  if (
    entry.state !== 'terminal' ||
    entry.terminal.status !== 'reviewed' ||
    entry.cold === undefined
  ) {
    throw new Error(
      `invocation is not a verified reviewed terminal: ${evidence.receipt.invocationId}`,
    );
  }
  const request = decodeRegistration(entry.registration);
  const cold = reconcileColdAcknowledgement(entry.registration, entry.cold);
  const informed = reconcileReviewedInformed(
    entry.registration,
    entry.cold,
    entry.terminal.informed,
  );
  const recorded = deriveReviewEvidence(request, cold, informed, journal.journalId);
  // Proof: removing this durable-cold comparison changed the production negative to the generic
  // `review evidence differs from exact journal observations`, missing the cold-boundary failure.
  if (
    hashCanonical(evidence.protocolEvidence.cold) !== hashCanonical(cold.cold) ||
    evidence.protocolEvidence.expansion.coldJudgmentArtifact !== hashCanonical(cold.cold)
  ) {
    throw new Error(`submitted cold judgment differs from durable cold acknowledgement`);
  }
  // Proof: bypassing this canonical comparison made the altered raw-response CLI exit 0; the
  // provenance negative observed `Expected: 1, Received: 0`.
  if (hashCanonical(evidence) !== hashCanonical(recorded)) {
    throw new Error(`review evidence differs from exact journal observations`);
  }
  // Proof: bypassing this refusal made the require-external CLI return 0; the provenance test
  // observed `Expected: 1, Received: 0`.
  if (requirement === 'require-external') {
    throw new Error(`review has no independently authenticated external provenance binding`);
  }
  return { status: 'verified', scope: 'local-cooperative', satisfiesExternal: false };
}
