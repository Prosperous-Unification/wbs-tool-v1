import { parseOrThrow, type } from '@shared/validation';

import {
  ElapsedReceipt,
  ExperimentManifest,
  InvocationReceipt,
  IsoInstant,
  OpaqueId,
  PriceIdentity,
  SchemaVersion,
} from '../contracts/records';
import {
  compareCanonicalText,
  hashCanonical,
  serializeCanonical,
} from '../evidence/content-manifest';

const Sha256 = type(/^[0-9a-f]{64}$/);
const GitObject = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const NonNegativeSafeInteger = type('number.integer>=0').narrow((value, context) =>
  Number.isSafeInteger(value) && !Object.is(value, -0)
    ? true
    : context.mustBe('a nonnegative safe integer'),
);
const PositiveSafeInteger = type('number.integer>=1').narrow((value, context) =>
  Number.isSafeInteger(value) ? true : context.mustBe('a positive safe integer'),
);

export const TrialSession = type({
  // Proof: deleting process.alpha from the production journal fixture made accounting.test.ts
  // refuse the session before runner evidence could lose its launched-process linkage.
  processId: OpaqueId,
  sessionId: OpaqueId,
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  status: "'completed'|'failed'|'censored'",
  attemptIds: OpaqueId.array(),
}).onUndeclaredKey('reject');
export type TrialSession = typeof TrialSession.infer;

export const TrialAttempt = type({
  attemptId: OpaqueId,
  outcomeId: OpaqueId,
  sessionId: OpaqueId,
  status: "'completed'|'failed'|'censored'",
  commitIds: GitObject.array(),
  invocationReceiptIds: OpaqueId.array(),
  elapsedReceiptIds: OpaqueId.array(),
}).onUndeclaredKey('reject');
export type TrialAttempt = typeof TrialAttempt.infer;

const AcceptedOutcome = type({
  outcomeId: OpaqueId,
  status: "'accepted'",
  attemptIds: OpaqueId.array(),
  // Proof: deleting this field from an accepted fixture made accounting.test.ts refuse at the
  // production decoder with `acceptanceArtifact must be a string`.
  acceptanceArtifact: Sha256,
  integrationIdentity: Sha256,
  defectCount: NonNegativeSafeInteger,
}).onUndeclaredKey('reject');

const UnacceptedOutcome = type({
  outcomeId: OpaqueId,
  status: "'failed'|'censored'",
  attemptIds: OpaqueId.array(),
  defectCount: NonNegativeSafeInteger,
}).onUndeclaredKey('reject');

export const TrialOutcome = AcceptedOutcome.or(UnacceptedOutcome);
export type TrialOutcome = typeof TrialOutcome.infer;

export const AllocationReceipt = type({
  schemaVersion: SchemaVersion,
  receiptKind: "'allocation'",
  receiptId: OpaqueId,
  trialId: OpaqueId,
  resourceId: OpaqueId,
  allocationMode: "'fixed-total'|'fixed-per-session'",
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  elapsedMs: NonNegativeSafeInteger,
  quantity: 'number>0',
  unit: 'string>=1',
  // Proof: deleting this field made accounting.test.ts refuse the production journal boundary
  // with `priceIdentity must be an object` instead of pricing infrastructure as zero.
  priceIdentity: PriceIdentity,
  chargedAmountMicros: NonNegativeSafeInteger,
}).onUndeclaredKey('reject');
export type AllocationReceipt = typeof AllocationReceipt.infer;

export const TrialJournal = type({
  schemaVersion: SchemaVersion,
  trialId: OpaqueId,
  manifest: ExperimentManifest,
  manifestIdentity: Sha256,
  repeat: PositiveSafeInteger,
  seed: NonNegativeSafeInteger,
  concurrency: PositiveSafeInteger,
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  status: "'completed'|'failed'|'censored'",
  sessions: TrialSession.array(),
  attempts: TrialAttempt.array(),
  outcomes: TrialOutcome.array(),
  invocationReceipts: InvocationReceipt.array(),
  elapsedReceipts: ElapsedReceipt.array(),
  allocationReceipts: AllocationReceipt.array(),
  // Proof: adding `unexpected: true` made accounting.test.ts refuse with
  // `unexpected must be removed` before any totals were produced.
}).onUndeclaredKey('reject');
export type TrialJournal = typeof TrialJournal.infer;

const PhaseElapsed = type({
  phase:
    "'discovery'|'review'|'upkeep'|'waiting'|'execution'|'integration'|'gate'|'human'|'infrastructure'",
  elapsedMs: NonNegativeSafeInteger,
}).onUndeclaredKey('reject');

const CurrencyCharge = type({
  currency: /^[A-Z]{3}$/,
  chargedAmountMicros: NonNegativeSafeInteger,
}).onUndeclaredKey('reject');

const AcceptedReportOutcome = type({
  outcomeId: OpaqueId,
  title: 'string>=1',
  stratum: "'independent-module'|'shared-contract'",
  heldOut: 'boolean',
  acceptanceCriteria: 'string[]',
  status: "'accepted'",
  attemptIds: OpaqueId.array(),
  defectCount: NonNegativeSafeInteger,
  // Proof: deleting this from a verified report made export.test.ts refuse at the production
  // export decoder instead of emitting an unproven accepted outcome.
  acceptanceArtifact: Sha256,
  integrationIdentity: Sha256,
}).onUndeclaredKey('reject');

const UnacceptedReportOutcome = type({
  outcomeId: OpaqueId,
  title: 'string>=1',
  stratum: "'independent-module'|'shared-contract'",
  heldOut: 'boolean',
  acceptanceCriteria: 'string[]',
  status: "'failed'|'censored'",
  attemptIds: OpaqueId.array(),
  defectCount: NonNegativeSafeInteger,
}).onUndeclaredKey('reject');

const ReportOutcome = AcceptedReportOutcome.or(UnacceptedReportOutcome);

export const TrialReport = type({
  schemaVersion: SchemaVersion,
  reportKind: "'trial-accounting'",
  trialId: OpaqueId,
  manifestId: OpaqueId,
  manifestIdentity: Sha256,
  manifest: ExperimentManifest,
  corpusId: OpaqueId,
  acceptanceId: OpaqueId,
  repeat: PositiveSafeInteger,
  seed: NonNegativeSafeInteger,
  concurrency: PositiveSafeInteger,
  allocationMode: "'fixed-total'|'fixed-per-session'",
  cacheCondition: "'cold'|'warm'|'mixed'",
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  status: "'completed'|'failed'|'censored'",
  verification: "'verified'",
  totalElapsedMs: NonNegativeSafeInteger,
  aggregateSessionElapsedMs: NonNegativeSafeInteger,
  acceptedOutcomeCount: NonNegativeSafeInteger,
  acceptedOutcomeIds: OpaqueId.array(),
  phaseElapsedMs: PhaseElapsed.array(),
  currencyCharges: CurrencyCharge.array(),
  sessions: TrialSession.array(),
  attempts: TrialAttempt.array(),
  outcomes: ReportOutcome.array(),
  invocationReceipts: InvocationReceipt.array(),
  elapsedReceipts: ElapsedReceipt.array(),
  allocationReceipts: AllocationReceipt.array(),
}).onUndeclaredKey('reject');
export type TrialReport = typeof TrialReport.infer;

function addSafe(total: number, increment: number, label: string): number {
  const sum = total + increment;
  // Proof: charging Number.MAX_SAFE_INTEGER plus another receipt made accounting.test.ts throw
  // `currency charge total exceeds the safe integer range` instead of rounding the total.
  if (!Number.isSafeInteger(sum)) throw new Error(`${label} exceeds the safe integer range`);
  return sum;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareCanonicalText);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function assertSameSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (serializeCanonical(sorted(actual)) !== serializeCanonical(sorted(expected))) {
    throw new Error(`${label} differ`);
  }
}

function elapsedMs(startedAt: string, endedAt: string, label: string): number {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  if (duration < 0 || !Number.isSafeInteger(duration)) {
    throw new Error(`${label} has an invalid interval`);
  }
  return duration;
}

function assertWithinInterval(
  startedAt: string,
  endedAt: string,
  boundaryStartedAt: string,
  boundaryEndedAt: string,
  boundaryLabel: 'trial' | 'owning session',
  label: string,
): void {
  if (
    Date.parse(startedAt) < Date.parse(boundaryStartedAt) ||
    Date.parse(endedAt) > Date.parse(boundaryEndedAt)
  ) {
    throw new Error(`${label} lies outside ${boundaryLabel} interval`);
  }
}

function validateJournal(journal: TrialJournal): void {
  // Proof: replacing the fixture's canonical identity with a different SHA-256 made
  // accounting.test.ts throw `trial manifest identity differs from its canonical bytes`.
  if (journal.manifestIdentity !== hashCanonical(journal.manifest)) {
    throw new Error('trial manifest identity differs from its canonical bytes');
  }
  // Proof: selecting seed 44 outside the three pinned seeds made accounting.test.ts refuse it.
  if (!journal.manifest.seeds.includes(journal.seed)) {
    throw new Error('trial seed is absent from the pinned manifest');
  }
  // Proof: requesting three sessions from a two-session envelope made accounting.test.ts refuse.
  if (journal.concurrency > journal.manifest.resources.maxConcurrentSessions) {
    throw new Error('trial concurrency exceeds the pinned resource envelope');
  }
  elapsedMs(journal.startedAt, journal.endedAt, 'trial');

  const manifestOutcomeIds = journal.manifest.corpus.outcomes.map(({ outcomeId }) => outcomeId);
  const outcomeIds = journal.outcomes.map(({ outcomeId }) => outcomeId);
  assertUnique(outcomeIds, 'trial outcome identities');
  // Proof: removing outcome.beta at equal schema validity made accounting.test.ts throw
  // `trial outcomes and frozen corpus outcomes differ`.
  assertSameSet(outcomeIds, manifestOutcomeIds, 'trial outcomes and frozen corpus outcomes');

  const attemptIds = journal.attempts.map(({ attemptId }) => attemptId);
  const sessionIds = journal.sessions.map(({ sessionId }) => sessionId);
  const invocationReceiptIds = journal.invocationReceipts.map(({ receiptId }) => receiptId);
  const elapsedReceiptIds = journal.elapsedReceipts.map(({ receiptId }) => receiptId);
  const allocationReceiptIds = journal.allocationReceipts.map(({ receiptId }) => receiptId);
  assertUnique(attemptIds, 'trial attempt identities');
  assertUnique(sessionIds, 'trial session identities');
  assertUnique(invocationReceiptIds, 'invocation receipt identities');
  assertUnique(elapsedReceiptIds, 'elapsed receipt identities');
  assertUnique(allocationReceiptIds, 'allocation receipt identities');

  const attemptById = new Map(journal.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const invocationById = new Map(
    journal.invocationReceipts.map((receipt) => [receipt.receiptId, receipt]),
  );
  const elapsedById = new Map(
    journal.elapsedReceipts.map((receipt) => [receipt.receiptId, receipt]),
  );
  const sessionById = new Map(journal.sessions.map((session) => [session.sessionId, session]));

  const sessionAttemptIds = journal.sessions.flatMap((session) => {
    elapsedMs(session.startedAt, session.endedAt, `session ${session.sessionId}`);
    if (
      Date.parse(session.startedAt) < Date.parse(journal.startedAt) ||
      Date.parse(session.endedAt) > Date.parse(journal.endedAt)
    ) {
      throw new Error(`session ${session.sessionId} lies outside the trial interval`);
    }
    assertUnique(session.attemptIds, `session ${session.sessionId} attempt identities`);
    for (const attemptId of session.attemptIds) {
      const attempt = attemptById.get(attemptId);
      if (attempt?.sessionId !== session.sessionId) {
        throw new Error(`session ${session.sessionId} does not own attempt ${attemptId}`);
      }
    }
    return session.attemptIds;
  });
  // Proof: dropping attempt.alpha.2 from its session made accounting.test.ts name the incomplete
  // session attempt coverage; the analogous outcome fault named outcome attempt coverage.
  assertSameSet(sessionAttemptIds, attemptIds, 'session attempt coverage and trial attempts');
  if (sessionAttemptIds.length !== attemptIds.length) {
    throw new Error('session attempt coverage assigns an attempt more than once');
  }

  const outcomeAttemptIds = journal.outcomes.flatMap((outcome) => {
    assertUnique(outcome.attemptIds, `outcome ${outcome.outcomeId} attempt identities`);
    if (outcome.attemptIds.length > journal.manifest.retryPolicy.maxAttemptsPerOutcome) {
      throw new Error(`outcome ${outcome.outcomeId} exceeds the pinned attempt limit`);
    }
    for (const attemptId of outcome.attemptIds) {
      const attempt = attemptById.get(attemptId);
      if (attempt?.outcomeId !== outcome.outcomeId) {
        throw new Error(`outcome ${outcome.outcomeId} does not own attempt ${attemptId}`);
      }
    }
    if (
      outcome.status === 'accepted' &&
      !outcome.attemptIds.some((attemptId) => attemptById.get(attemptId)?.status === 'completed')
    ) {
      throw new Error(`accepted outcome ${outcome.outcomeId} has no completed attempt`);
    }
    return outcome.attemptIds;
  });
  assertSameSet(outcomeAttemptIds, attemptIds, 'outcome attempt coverage and trial attempts');
  if (outcomeAttemptIds.length !== attemptIds.length) {
    throw new Error('outcome attempt coverage assigns an attempt more than once');
  }

  const referencedInvocations: string[] = [];
  const referencedElapsed: string[] = [];
  for (const attempt of journal.attempts) {
    const session = sessionById.get(attempt.sessionId);
    if (session === undefined) {
      throw new Error(`attempt ${attempt.attemptId} names unknown session ${attempt.sessionId}`);
    }
    assertUnique(
      attempt.invocationReceiptIds,
      `attempt ${attempt.attemptId} invocation receipt identities`,
    );
    assertUnique(
      attempt.elapsedReceiptIds,
      `attempt ${attempt.attemptId} elapsed receipt identities`,
    );
    if (attempt.invocationReceiptIds.length === 0) {
      // Proof: clearing attempt.alpha.1's receipt ids made accounting.test.ts name missing
      // invocation receipt coverage instead of omitting the attempt's usage and charge.
      throw new Error(`attempt ${attempt.attemptId} has no invocation receipt coverage`);
    }
    if (attempt.elapsedReceiptIds.length === 0) {
      throw new Error(`attempt ${attempt.attemptId} has no elapsed receipt coverage`);
    }
    for (const receiptId of attempt.invocationReceiptIds) {
      const receipt = invocationById.get(receiptId);
      if (receipt === undefined) {
        throw new Error(
          `attempt ${attempt.attemptId} names unknown invocation receipt ${receiptId}`,
        );
      }
      // Proof: moving a valid invocation one year before its owning session made
      // accounting.test.ts refuse it at this production join.
      assertWithinInterval(
        receipt.startedAt,
        receipt.endedAt,
        session.startedAt,
        session.endedAt,
        'owning session',
        `invocation receipt ${receiptId}`,
      );
      referencedInvocations.push(receiptId);
    }
    for (const receiptId of attempt.elapsedReceiptIds) {
      const receipt = elapsedById.get(receiptId);
      if (
        receipt?.trialId !== journal.trialId ||
        receipt.attemptId !== attempt.attemptId ||
        receipt.outcomeId !== attempt.outcomeId
      ) {
        // Proof: rebinding receipt.discovery.alpha to attempt.alpha.2 made accounting.test.ts
        // throw `mismatched elapsed receipt` before elapsed aggregation.
        throw new Error(`attempt ${attempt.attemptId} has mismatched elapsed receipt ${receiptId}`);
      }
      // Proof: moving discovery before its session, or shortening the session past waiting,
      // made accounting.test.ts refuse the elapsed receipt rather than shrink the denominator.
      assertWithinInterval(
        receipt.startedAt,
        receipt.endedAt,
        session.startedAt,
        session.endedAt,
        'owning session',
        `elapsed receipt ${receiptId}`,
      );
      referencedElapsed.push(receiptId);
    }
  }
  assertSameSet(
    referencedInvocations,
    invocationReceiptIds,
    'attempt invocation receipt coverage and journal receipts',
  );
  if (referencedInvocations.length !== invocationReceiptIds.length) {
    throw new Error('attempt invocation receipt coverage reuses a receipt');
  }
  assertSameSet(
    referencedElapsed,
    elapsedReceiptIds,
    'attempt elapsed receipt coverage and journal receipts',
  );
  if (referencedElapsed.length !== elapsedReceiptIds.length) {
    throw new Error('attempt elapsed receipt coverage reuses a receipt');
  }

  const expectedExecutor = journal.manifest.execution;
  for (const receipt of journal.invocationReceipts) {
    if (
      receipt.executor.provider !== expectedExecutor.provider ||
      receipt.executor.model !== expectedExecutor.model ||
      receipt.executor.version !== expectedExecutor.version ||
      receipt.executor.effort !== expectedExecutor.effort
    ) {
      // Proof: changing one actual model to gpt-5-other made accounting.test.ts refuse the
      // invocation as different from the pinned executor.
      throw new Error(`invocation receipt ${receipt.receiptId} differs from the pinned executor`);
    }
    if (hashCanonical(receipt.priceIdentity) !== hashCanonical(journal.manifest.priceIdentity)) {
      throw new Error(
        `invocation receipt ${receipt.receiptId} differs from the pinned price identity`,
      );
    }
    if (receipt.rawUsage.length === 0) {
      // Proof: emptying the failed attempt's usage made accounting.test.ts refuse raw usage
      // telemetry rather than retaining a zero-cost failed attempt.
      throw new Error(`invocation receipt ${receipt.receiptId} has no raw usage telemetry`);
    }
  }

  if (journal.allocationReceipts.length === 0) {
    throw new Error('trial has no infrastructure allocation receipt');
  }
  for (const receipt of journal.allocationReceipts) {
    if (
      receipt.trialId !== journal.trialId ||
      receipt.resourceId !== journal.manifest.resources.resourceId ||
      receipt.allocationMode !== journal.manifest.resources.allocationMode
    ) {
      // Proof: changing the allocation resource id made accounting.test.ts refuse it as different
      // from the pinned resource before infrastructure cost aggregation.
      throw new Error(`allocation receipt ${receipt.receiptId} differs from the pinned resource`);
    }
    if (receipt.elapsedMs !== elapsedMs(receipt.startedAt, receipt.endedAt, 'allocation receipt')) {
      throw new Error(`allocation receipt ${receipt.receiptId} has inconsistent elapsedMs`);
    }
    // Proof: starting allocation before the trial made accounting.test.ts refuse it even when
    // its own elapsed duration remained internally consistent.
    assertWithinInterval(
      receipt.startedAt,
      receipt.endedAt,
      journal.startedAt,
      journal.endedAt,
      'trial',
      `allocation receipt ${receipt.receiptId}`,
    );
    if (hashCanonical(receipt.priceIdentity) !== hashCanonical(journal.manifest.priceIdentity)) {
      throw new Error(
        `allocation receipt ${receipt.receiptId} differs from the pinned price identity`,
      );
    }
  }
}

/**
 * Accounts one complete trusted trial journal without treating missing telemetry as zero.
 * Accepted throughput is derived from the frozen outcome set, independently of its attempts.
 */
export function accountTrial(input: unknown): TrialReport {
  const journal = parseOrThrow(TrialJournal, input);
  validateJournal(journal);

  const outcomes = journal.outcomes
    .map((outcome) => {
      const definition = journal.manifest.corpus.outcomes.find(
        ({ outcomeId }) => outcomeId === outcome.outcomeId,
      );
      if (definition === undefined) throw new Error(`unknown outcome ${outcome.outcomeId}`);
      return { ...definition, ...outcome, attemptIds: sorted(outcome.attemptIds) };
    })
    .sort((left, right) => compareCanonicalText(left.outcomeId, right.outcomeId));
  const acceptedOutcomeIds = outcomes
    .filter(({ status }) => status === 'accepted')
    .map(({ outcomeId }) => outcomeId);

  const phaseTotals = new Map<string, number>();
  for (const receipt of journal.elapsedReceipts) {
    phaseTotals.set(
      receipt.phase,
      addSafe(phaseTotals.get(receipt.phase) ?? 0, receipt.elapsedMs, 'phase elapsed total'),
    );
  }
  const phaseElapsedMs = [...phaseTotals]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([phase, duration]) => ({ phase, elapsedMs: duration }));

  const charges = new Map<string, number>();
  for (const receipt of [...journal.invocationReceipts, ...journal.allocationReceipts]) {
    const currency = receipt.priceIdentity.currency;
    charges.set(
      currency,
      addSafe(charges.get(currency) ?? 0, receipt.chargedAmountMicros, 'currency charge total'),
    );
  }
  const currencyCharges = [...charges]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([currency, chargedAmountMicros]) => ({ currency, chargedAmountMicros }));

  let aggregateSessionElapsedMs = 0;
  for (const session of journal.sessions) {
    aggregateSessionElapsedMs = addSafe(
      aggregateSessionElapsedMs,
      elapsedMs(session.startedAt, session.endedAt, `session ${session.sessionId}`),
      'aggregate session elapsed total',
    );
  }

  return parseOrThrow(TrialReport, {
    schemaVersion: 1,
    reportKind: 'trial-accounting',
    trialId: journal.trialId,
    manifestId: journal.manifest.manifestId,
    manifestIdentity: journal.manifestIdentity,
    manifest: journal.manifest,
    corpusId: journal.manifest.corpus.corpusId,
    acceptanceId: journal.manifest.corpus.acceptanceId,
    repeat: journal.repeat,
    seed: journal.seed,
    concurrency: journal.concurrency,
    allocationMode: journal.manifest.resources.allocationMode,
    cacheCondition: journal.manifest.resources.cacheCondition,
    startedAt: journal.startedAt,
    endedAt: journal.endedAt,
    status: journal.status,
    verification: 'verified',
    totalElapsedMs: elapsedMs(journal.startedAt, journal.endedAt, 'trial'),
    aggregateSessionElapsedMs,
    acceptedOutcomeCount: acceptedOutcomeIds.length,
    acceptedOutcomeIds,
    phaseElapsedMs,
    currencyCharges,
    sessions: journal.sessions
      .map((session) => ({ ...session, attemptIds: sorted(session.attemptIds) }))
      .sort((left, right) => compareCanonicalText(left.sessionId, right.sessionId)),
    attempts: journal.attempts
      .map((attempt) => ({
        ...attempt,
        invocationReceiptIds: sorted(attempt.invocationReceiptIds),
        elapsedReceiptIds: sorted(attempt.elapsedReceiptIds),
      }))
      .sort((left, right) => compareCanonicalText(left.attemptId, right.attemptId)),
    outcomes,
    invocationReceipts: [...journal.invocationReceipts].sort((left, right) =>
      compareCanonicalText(left.receiptId, right.receiptId),
    ),
    elapsedReceipts: [...journal.elapsedReceipts].sort((left, right) =>
      compareCanonicalText(left.receiptId, right.receiptId),
    ),
    allocationReceipts: [...journal.allocationReceipts].sort((left, right) =>
      compareCanonicalText(left.receiptId, right.receiptId),
    ),
  });
}

/** Validates a standalone accounted report before it crosses the portable export boundary. */
export function decodeTrialReport(input: unknown): TrialReport {
  const decoded = parseOrThrow(TrialReport, input);
  // Proof: duplicating an accepted outcome made export.test.ts reach only a derived count
  // mismatch; this identity check now refuses the contradictory observation set directly.
  assertUnique(
    decoded.outcomes.map(({ outcomeId }) => outcomeId),
    'trial report outcome identities',
  );
  const report = parseOrThrow(TrialReport, {
    ...decoded,
    acceptedOutcomeIds: sorted(decoded.acceptedOutcomeIds),
    phaseElapsedMs: [...decoded.phaseElapsedMs].sort((left, right) =>
      compareCanonicalText(left.phase, right.phase),
    ),
    currencyCharges: [...decoded.currencyCharges].sort((left, right) =>
      compareCanonicalText(left.currency, right.currency),
    ),
    sessions: decoded.sessions
      .map((session) => ({ ...session, attemptIds: sorted(session.attemptIds) }))
      .sort((left, right) => compareCanonicalText(left.sessionId, right.sessionId)),
    attempts: decoded.attempts
      .map((attempt) => ({
        ...attempt,
        invocationReceiptIds: sorted(attempt.invocationReceiptIds),
        elapsedReceiptIds: sorted(attempt.elapsedReceiptIds),
      }))
      .sort((left, right) => compareCanonicalText(left.attemptId, right.attemptId)),
    outcomes: decoded.outcomes
      .map((outcome) => ({ ...outcome, attemptIds: sorted(outcome.attemptIds) }))
      .sort((left, right) => compareCanonicalText(left.outcomeId, right.outcomeId)),
    invocationReceipts: [...decoded.invocationReceipts].sort((left, right) =>
      compareCanonicalText(left.receiptId, right.receiptId),
    ),
    elapsedReceipts: [...decoded.elapsedReceipts].sort((left, right) =>
      compareCanonicalText(left.receiptId, right.receiptId),
    ),
    allocationReceipts: [...decoded.allocationReceipts].sort((left, right) =>
      compareCanonicalText(left.receiptId, right.receiptId),
    ),
  });
  const acceptedOutcomeIds = report.outcomes
    .filter(({ status }) => status === 'accepted')
    .map(({ outcomeId }) => outcomeId)
    .sort(compareCanonicalText);
  // Proof: setting acceptedOutcomeCount to 2 while the JSONL carried one accepted outcome made
  // export.test.ts report "function did not throw" and emit a contradictory trial CSV row.
  if (
    report.acceptedOutcomeCount !== acceptedOutcomeIds.length ||
    serializeCanonical(report.acceptedOutcomeIds) !== serializeCanonical(acceptedOutcomeIds)
  ) {
    throw new Error('trial report has inconsistent accepted outcome accounting');
  }
  const journal = {
    schemaVersion: report.schemaVersion,
    trialId: report.trialId,
    manifest: report.manifest,
    manifestIdentity: report.manifestIdentity,
    repeat: report.repeat,
    seed: report.seed,
    concurrency: report.concurrency,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    status: report.status,
    sessions: report.sessions,
    attempts: report.attempts,
    outcomes: report.outcomes.map((outcome) =>
      outcome.status === 'accepted'
        ? {
            outcomeId: outcome.outcomeId,
            status: outcome.status,
            attemptIds: outcome.attemptIds,
            acceptanceArtifact: outcome.acceptanceArtifact,
            integrationIdentity: outcome.integrationIdentity,
            defectCount: outcome.defectCount,
          }
        : {
            outcomeId: outcome.outcomeId,
            status: outcome.status,
            attemptIds: outcome.attemptIds,
            defectCount: outcome.defectCount,
          },
    ),
    invocationReceipts: report.invocationReceipts,
    elapsedReceipts: report.elapsedReceipts,
    allocationReceipts: report.allocationReceipts,
  };
  const recomputed = accountTrial(journal);
  // Proof: altering elapsed or currency headlines while retaining the raw observations made
  // export.test.ts reach export before this comparison and emit contradictory CSV totals.
  if (serializeCanonical(report) !== serializeCanonical(recomputed)) {
    throw new Error(
      'trial report has inconsistent trial elapsed, charge, or observation accounting',
    );
  }
  return recomputed;
}

/** Recomputes a submitted report from its complete journal and refuses any omitted observation. */
export function validateTrialReport(journalInput: unknown, reportInput: unknown): TrialReport {
  const report = decodeTrialReport(reportInput);
  const expected = accountTrial(journalInput);
  // Proof: deleting the failed attempt or waiting receipt from the submitted report made
  // accounting.test.ts throw this mismatch against the unchanged complete journal.
  if (serializeCanonical(report) !== serializeCanonical(expected)) {
    throw new Error('trial report differs from complete journal accounting');
  }
  return report;
}
