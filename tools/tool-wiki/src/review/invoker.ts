import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { parseOrThrow, type } from '@wbs/validation';

import { IsoInstant, OpaqueId, SchemaVersion } from '../contracts/records';
import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import type { HarnessOutput } from './protocol';
import {
  decodeHarnessOutput,
  decodeReviewEvidence,
  RetainedRawResponse,
  ReviewEvidence,
  type ReviewEvidence as ReviewEvidenceRecord,
  ReviewInvocationRequest,
  type ReviewInvocationRequest as ReviewInvocationRequestRecord,
  ReviewProtocolEvidence,
  ReviewTelemetry,
  ToolIdentity,
} from './protocol';

const Sha256 = type(/^[0-9a-f]{64}$/);
const TrustScope = type("'local-cooperative'|'trusted-harness'|'external-verifier'");
export type TrustScope = typeof TrustScope.infer;

export const InvocationRegistration = type({
  invocationId: OpaqueId,
  receiptId: OpaqueId,
  registeredAt: IsoInstant,
  harnessArgv: 'string[]',
  stdinArtifact: Sha256,
  stdinBytes: 'string',
})
  .onUndeclaredKey('reject')
  // Proof: replacing this comparison with true made "exact stdin or stdout byte identities" fail: "Received function did not throw".
  .narrow((registration, context) =>
    registration.stdinArtifact === hashBytes(registration.stdinBytes)
      ? true
      : context.mustBe('a stdinArtifact identifying the exact canonical stdin bytes'),
  );
export type InvocationRegistration = typeof InvocationRegistration.infer;

export const InvocationCompletion = type({
  completedAt: IsoInstant,
  stdoutArtifact: Sha256,
  stdoutBytes: 'string',
  actualTools: ToolIdentity.array(),
  rawResponse: RetainedRawResponse,
  protocolEvidence: ReviewProtocolEvidence,
  telemetry: ReviewTelemetry,
  evidence: ReviewEvidence.or('null'),
})
  .onUndeclaredKey('reject')
  .narrow((completion, context) => {
    // Proof: bypassing this comparison made "exact stdin or stdout byte identities" fail: "Received function did not throw".
    if (completion.stdoutArtifact !== hashBytes(completion.stdoutBytes)) {
      return context.mustBe('a stdoutArtifact identifying the exact raw stdout bytes');
    }
    const hasEvidence = completion.evidence !== null;
    const completedWithTelemetry =
      completion.telemetry.status === 'verified' &&
      completion.telemetry.receipt.status === 'completed';
    // Proof: replacing this equivalence with true made "makes completion idempotent" reach "different terminal completion" instead of rejecting missing evidence.
    return completedWithTelemetry === hasEvidence
      ? true
      : context.mustBe('evidence exactly when completed telemetry is verified');
  });
export type InvocationCompletion = typeof InvocationCompletion.infer;

const RegisteredInvocation = type({
  state: "'registered'",
  registration: InvocationRegistration,
}).onUndeclaredKey('reject');

const CompletedInvocation = type({
  state: "'completed'",
  registration: InvocationRegistration,
  completion: InvocationCompletion,
}).onUndeclaredKey('reject');

export const InvocationJournalRecord = type({
  schemaVersion: SchemaVersion,
  journalId: OpaqueId,
  trustScope: TrustScope,
  entries: RegisteredInvocation.or(CompletedInvocation).array(),
})
  .onUndeclaredKey('reject')
  // Proof: replacing this uniqueness comparison with true made "exact stdin or stdout byte identities" accept a duplicated entry and fail "Received function did not throw".
  .narrow((journal, context) =>
    new Set(journal.entries.map(({ registration }) => registration.invocationId)).size ===
    journal.entries.length
      ? true
      : context.mustBe('entries with unique invocationId'),
  );
export type InvocationJournalRecord = typeof InvocationJournalRecord.infer;

export interface DurableRegistration {
  status: 'durable';
  journalId: string;
  invocationId: string;
  registrationArtifact: string;
}

/**
 * Persists the lifecycle of a harness invocation outside writer-supplied evidence.
 * `register` returns only after the exact registration is durably readable.
 */
export interface InvocationJournal {
  readonly journalId: string;
  readonly trustScope: TrustScope;
  register(registration: InvocationRegistration): DurableRegistration;
  complete(invocationId: string, completion: InvocationCompletion): void;
  read(): InvocationJournalRecord;
}

export interface ReviewInvoker {
  invoke(request: ReviewInvocationRequestRecord): ReviewInvocationResult;
}

export type ReviewInvocationResult =
  | { status: 'verified'; evidence: ReviewEvidenceRecord }
  | { status: 'unverified'; invocationId: string; reason: string };

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
    // Proof: bypassing this contextual rethrow made "distinguishes missing, unreadable and malformed" receive "JSON Parse error" instead of "malformed JSON".
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${subject} is malformed JSON: ${detail}`, { cause });
  }
}

/** Reads and strictly validates a persisted invocation journal. */
export function readInvocationJournal(path: string): InvocationJournalRecord {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    // Proof: bypassing this contextual rethrow made "distinguishes missing, unreadable and malformed" receive ENOENT instead of "cannot read invocation journal".
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`cannot read invocation journal ${path}: ${detail}`, { cause });
  }
  return parseOrThrow(
    InvocationJournalRecord,
    decodeJson(decodeUtf8(bytes, `invocation journal ${path}`), `invocation journal ${path}`),
  );
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

/** A canonical JSON invocation journal whose writes are fsynced and read back before acceptance. */
export class FileInvocationJournal implements InvocationJournal {
  private constructor(
    private readonly path: string,
    readonly journalId: string,
    readonly trustScope: TrustScope,
  ) {}

  static create(path: string, journalId: string, trustScope: TrustScope): FileInvocationJournal {
    const journal = parseOrThrow(InvocationJournalRecord, {
      schemaVersion: 1,
      journalId,
      trustScope,
      entries: [],
    });
    createDurably(path, journal);
    const stored = readInvocationJournal(path);
    if (hashCanonical(stored) !== hashCanonical(journal)) {
      throw new Error(`durable invocation journal creation differs after read-back: ${path}`);
    }
    return new FileInvocationJournal(path, stored.journalId, stored.trustScope);
  }

  static open(path: string): FileInvocationJournal {
    const journal = readInvocationJournal(path);
    return new FileInvocationJournal(path, journal.journalId, journal.trustScope);
  }

  read(): InvocationJournalRecord {
    const journal = readInvocationJournal(this.path);
    // Proof: bypassing this comparison made "exact stdin or stdout byte identities" accept journalId "journal.replaced" and fail "Received function did not throw".
    if (journal.journalId !== this.journalId || journal.trustScope !== this.trustScope) {
      throw new Error(`invocation journal identity changed at ${this.path}`);
    }
    return journal;
  }

  register(registration: InvocationRegistration): DurableRegistration {
    const checked = parseOrThrow(InvocationRegistration, registration);
    const journal = this.read();
    // Proof: bypassing this guard made "makes completion idempotent" receive the later unique-invocation schema failure instead of "already registered".
    if (journal.entries.some((entry) => entry.registration.invocationId === checked.invocationId)) {
      throw new Error(`invocation already registered: ${checked.invocationId}`);
    }
    const updated = parseOrThrow(InvocationJournalRecord, {
      ...journal,
      entries: [...journal.entries, { state: 'registered', registration: checked }],
    });
    replaceDurably(this.path, updated);
    const stored = this.read().entries.find(
      (entry) => entry.registration.invocationId === checked.invocationId,
    );
    if (
      stored?.state !== 'registered' ||
      hashCanonical(stored.registration) !== hashCanonical(checked)
    ) {
      throw new Error(
        `durable invocation registration differs after read-back: ${checked.invocationId}`,
      );
    }
    return {
      status: 'durable',
      journalId: this.journalId,
      invocationId: checked.invocationId,
      registrationArtifact: hashCanonical(checked),
    };
  }

  complete(invocationId: string, completion: InvocationCompletion): void {
    const checked = parseOrThrow(InvocationCompletion, completion);
    const journal = this.read();
    const index = journal.entries.findIndex(
      (entry) => entry.registration.invocationId === invocationId,
    );
    // Proof: bypassing this guard made "makes completion idempotent" receive "undefined is not an object" instead of "unknown invocation".
    if (index < 0) throw new Error(`cannot complete unknown invocation: ${invocationId}`);
    const current = journal.entries[index];
    if (current.state === 'completed') {
      if (hashCanonical(current.completion) === hashCanonical(checked)) return;
      // Proof: replacing this throw with return made "makes completion idempotent" fail: "Received function did not throw".
      throw new Error(`invocation already has a different terminal completion: ${invocationId}`);
    }
    const entries = [...journal.entries];
    entries[index] = {
      state: 'completed',
      registration: current.registration,
      completion: checked,
    };
    const updated = parseOrThrow(InvocationJournalRecord, { ...journal, entries });
    replaceDurably(this.path, updated);
    const stored = this.read().entries[index];
    if (
      stored.state !== 'completed' ||
      hashCanonical(stored.completion) !== hashCanonical(checked)
    ) {
      throw new Error(`durable invocation completion differs after read-back: ${invocationId}`);
    }
  }
}

function buildEvidence(
  request: ReviewInvocationRequestRecord,
  output: typeof HarnessOutput.infer,
  journal: InvocationJournal,
): ReviewEvidenceRecord | null {
  // Proof: omitting the failed-status branch made "retains failed invocation telemetry" fail the completion evidence invariant.
  if (output.telemetry.status === 'unverified' || output.telemetry.receipt.status !== 'completed') {
    return null;
  }
  const rawResponseArtifact = hashBytes(output.rawResponse.payload);
  return parseOrThrow(ReviewEvidence, {
    schemaVersion: 1,
    receipt: {
      schemaVersion: 1,
      receiptKind: 'review',
      receiptId: request.receiptId,
      invocationId: request.invocationId,
      executor: output.telemetry.receipt.executor,
      suppliedContextIds: [
        request.protocol.protocolBlob,
        request.subject.contentIdentity,
        ...output.protocolEvidence.expansion.suppliedContextIds,
      ],
      observedReadIds: [
        ...output.protocolEvidence.cold.observedReadIds,
        ...output.protocolEvidence.informed.observedReadIds,
      ],
      rawResponseArtifact,
      rawUsage: output.telemetry.receipt.rawUsage,
      priceIdentity: output.telemetry.receipt.priceIdentity,
      trust: { scope: journal.trustScope, journalId: journal.journalId },
    },
    protocolEvidence: output.protocolEvidence,
    actualTools: output.actualTools,
    rawResponse: { artifact: rawResponseArtifact, retention: output.rawResponse.retention },
  });
}

/** Invokes one operator-provisioned JSON process after its exact request is durably registered. */
export class ProcessReviewInvoker implements ReviewInvoker {
  constructor(
    private readonly journal: InvocationJournal,
    private readonly harnessArgv: readonly string[],
  ) {
    if (harnessArgv.length === 0) throw new Error('review harness argv must not be empty');
  }

  invoke(request: ReviewInvocationRequestRecord): ReviewInvocationResult {
    const checked = parseOrThrow(ReviewInvocationRequest, request);
    const stdinBytes = serializeCanonical(checked);
    const registration = parseOrThrow(InvocationRegistration, {
      invocationId: checked.invocationId,
      receiptId: checked.receiptId,
      registeredAt: new Date().toISOString(),
      harnessArgv: [...this.harnessArgv],
      stdinArtifact: hashBytes(stdinBytes),
      stdinBytes,
    });
    // Proof: moving registration after spawn made "durably registers before launch" fail: "review harness exited 19: invocation was not durably registered before launch".
    const acceptance = this.journal.register(registration);
    // Proof: bypassing this identity guard made "does not launch after a journal accepts a different invocation identity" reach "Executable not found".
    if (acceptance.invocationId !== checked.invocationId) {
      throw new Error(`invocation journal did not durably accept ${checked.invocationId}`);
    }

    const processResult = Bun.spawnSync([...this.harnessArgv], {
      stdin: Buffer.from(stdinBytes, 'utf8'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (processResult.exitCode !== 0) {
      const detail = decodeUtf8(processResult.stderr, 'review harness stderr').trim();
      throw new Error(
        `review harness exited ${String(processResult.exitCode)}${detail.length === 0 ? '' : `: ${detail}`}`,
      );
    }
    const stdoutBytes = decodeUtf8(processResult.stdout, 'review harness stdout');
    const output = decodeHarnessOutput(decodeJson(stdoutBytes, 'review harness stdout'));
    // Proof: bypassing this guard made the wrong-output case in "refuses harness identity" fail: "Received function did not throw".
    if (output.invocationId !== checked.invocationId) {
      throw new Error(
        `review harness invocation ${output.invocationId} differs from registered ${checked.invocationId}`,
      );
    }
    // Proof: bypassing this comparison made the wrong-protocol case in "refuses harness identity" fail: "Received function did not throw".
    if (
      hashCanonical(output.protocolEvidence.protocol) !== hashCanonical(checked.protocol) ||
      hashCanonical(output.protocolEvidence.subject) !== hashCanonical(checked.subject)
    ) {
      throw new Error(
        `review harness protocol or subject differs from request ${checked.invocationId}`,
      );
    }
    if (output.telemetry.status === 'verified') {
      // Proof: bypassing this guard made the wrong-invocation case in "refuses harness identity" fail: "Received function did not throw".
      if (output.telemetry.receipt.invocationId !== checked.invocationId) {
        throw new Error(`telemetry invocation differs from registered ${checked.invocationId}`);
      }
      // Proof: bypassing this guard made the wrong-input case in "refuses harness identity" fail: "Received function did not throw".
      if (output.telemetry.receipt.inputArtifact !== registration.stdinArtifact) {
        throw new Error(`telemetry inputArtifact differs from exact harness stdin`);
      }
      // Proof: bypassing this guard made the early-start case in "refuses harness identity" fail: "Received function did not throw".
      if (Date.parse(output.telemetry.receipt.startedAt) < Date.parse(registration.registeredAt)) {
        throw new Error(`telemetry starts before durable invocation registration`);
      }
    }
    const evidence = buildEvidence(checked, output, this.journal);
    const completion = parseOrThrow(InvocationCompletion, {
      completedAt: new Date().toISOString(),
      stdoutArtifact: hashBytes(processResult.stdout),
      stdoutBytes,
      actualTools: output.actualTools,
      rawResponse: output.rawResponse,
      protocolEvidence: output.protocolEvidence,
      telemetry: output.telemetry,
      evidence,
    });
    this.journal.complete(checked.invocationId, completion);
    return evidence === null
      ? {
          status: 'unverified',
          invocationId: checked.invocationId,
          reason:
            output.telemetry.status === 'unverified'
              ? output.telemetry.reason
              : `invocation status ${output.telemetry.receipt.status}`,
        }
      : { status: 'verified', evidence };
  }
}

export type ProvenanceRequirement = 'allow-local' | 'require-external';

export interface ProvenanceValidation {
  status: 'verified';
  scope: TrustScope;
  satisfiesExternal: boolean;
}

/**
 * Compares writer-supplied review evidence with the exact terminal journal observation.
 * Trust-policy selection remains outside this comparison; callers may require external provenance.
 */
export function validateReviewProvenance(
  journal: InvocationJournalRecord,
  submitted: unknown,
  requirement: ProvenanceRequirement,
): ProvenanceValidation {
  const evidence = decodeReviewEvidence(submitted);
  const entry = journal.entries.find(
    ({ registration }) => registration.invocationId === evidence.receipt.invocationId,
  );
  // Proof: falling back to the first entry made the forged-invocation CLI case receive "review evidence differs" instead of "unknown invocation".
  if (entry === undefined) throw new Error(`unknown invocation: ${evidence.receipt.invocationId}`);
  // Proof: bypassing this guard made the incomplete CLI case receive "undefined is not an object" instead of "invocation is not complete".
  if (entry.state !== 'completed') {
    throw new Error(`invocation is not complete: ${evidence.receipt.invocationId}`);
  }
  // Proof: bypassing this guard made the unverified CLI case receive "null is not an object" instead of "invocation telemetry is unverified".
  if (entry.completion.telemetry.status === 'unverified' || entry.completion.evidence === null) {
    throw new Error(
      `invocation telemetry is unverified: ${entry.completion.telemetry.status === 'unverified' ? entry.completion.telemetry.reason : 'missing evidence'}`,
    );
  }
  const recorded = entry.completion.evidence;
  // Proof: bypassing this comparison made the altered-response CLI case receive "review evidence differs" instead of "raw response reference differs".
  if (
    evidence.receipt.rawResponseArtifact !== recorded.receipt.rawResponseArtifact ||
    hashCanonical(evidence.rawResponse) !== hashCanonical(recorded.rawResponse)
  ) {
    throw new Error(`raw response reference differs from invocation journal`);
  }
  // Proof: bypassing this comparison made the erased-reads CLI case receive "cold judgment differs" instead of "observed reads differ".
  if (
    hashCanonical(evidence.receipt.observedReadIds) !==
      hashCanonical(recorded.receipt.observedReadIds) ||
    hashCanonical(evidence.protocolEvidence.cold.observedReadIds) !==
      hashCanonical(recorded.protocolEvidence.cold.observedReadIds) ||
    hashCanonical(evidence.protocolEvidence.informed.observedReadIds) !==
      hashCanonical(recorded.protocolEvidence.informed.observedReadIds)
  ) {
    throw new Error(`observed reads differ from invocation journal`);
  }
  // Proof: bypassing this comparison made the rewritten-cold CLI case receive "review evidence differs" instead of "cold judgment differs".
  if (
    hashCanonical(evidence.protocolEvidence.cold) !== hashCanonical(recorded.protocolEvidence.cold)
  ) {
    throw new Error(`cold judgment differs from frozen invocation journal`);
  }
  // Proof: bypassing this comparison made the forged-tools CLI case exit 0 with status "verified".
  if (hashCanonical(evidence) !== hashCanonical(recorded)) {
    throw new Error(`review evidence differs from invocation journal`);
  }
  const satisfiesExternal = journal.trustScope !== 'local-cooperative';
  // Proof: bypassing this guard made require-external exit 0 with local-cooperative scope.
  if (requirement === 'require-external' && !satisfiesExternal) {
    throw new Error(`local-cooperative cannot satisfy external provenance`);
  }
  return { status: 'verified', scope: journal.trustScope, satisfiesExternal };
}
