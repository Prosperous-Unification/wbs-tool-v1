import { Buffer } from 'node:buffer';

import { parseOrThrow, type } from '@wbs/validation';

import { IsoInstant, OpaqueId, SchemaVersion } from '../contracts/records';
import { assertCanonicalJsonValue, hashBytes, hashCanonical } from '../evidence/content-manifest';
import { ReviewEvidence, ReviewSubject } from './protocol';

const GitIdentity = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const Sha256 = type(/^[0-9a-f]{64}$/);
const SafePositiveInteger = type('number.integer>=1').narrow((value, context) =>
  Number.isSafeInteger(value) && !Object.is(value, -0)
    ? true
    : context.mustBe('a positive safe integer'),
);
const BasisPoints = type('number.integer>=1')
  .and(type('number<=10000'))
  .narrow((value, context) =>
    Number.isSafeInteger(value) && !Object.is(value, -0)
      ? true
      : context.mustBe('safe integer basis points'),
  );

export const AuditStratum = type({
  stratumId: OpaqueId,
  sampleRateBps: BasisPoints,
  disagreementTriggerBps: BasisPoints,
}).onUndeclaredKey('reject');
export type AuditStratum = typeof AuditStratum.infer;

export const AuditObligation = type({
  obligationId: OpaqueId,
  riskStratum: OpaqueId,
  subject: ReviewSubject,
}).onUndeclaredKey('reject');
export type AuditObligation = typeof AuditObligation.infer;

export const AuditSelectionRequest = type({
  schemaVersion: SchemaVersion,
  auditId: OpaqueId,
  sourceBase: GitIdentity,
  candidateIdentity: Sha256,
  generation: SafePositiveInteger,
  seed: OpaqueId,
  coverage: "'sampled'|'exhaustive'",
  strata: AuditStratum.array(),
  obligations: AuditObligation.array(),
}).onUndeclaredKey('reject');
export type AuditSelectionRequest = typeof AuditSelectionRequest.infer;

export interface AuditSelectionStratum {
  stratumId: string;
  populationSize: number;
  sampleSize: number;
  obligationIds: string[];
}

export interface AuditSelection {
  schemaVersion: 1;
  auditId: string;
  sourceBase: string;
  candidateIdentity: string;
  generation: number;
  seed: string;
  coverage: 'sampled' | 'exhaustive';
  selectionId: string;
  strata: AuditSelectionStratum[];
  obligationIds: string[];
}

export const AuditFinding = type({
  findingId: OpaqueId,
  severity: "'critical'|'important'|'minor'",
  summary: 'string>=1',
}).onUndeclaredKey('reject');
export type AuditFinding = typeof AuditFinding.infer;

export const AuditReview = type({
  reviewId: OpaqueId,
  obligationId: OpaqueId,
  sourceBase: GitIdentity,
  candidateIdentity: Sha256,
  generation: SafePositiveInteger,
  reviewRound: SafePositiveInteger,
  recordedAt: IsoInstant,
  evidence: ReviewEvidence,
  findings: AuditFinding.array(),
}).onUndeclaredKey('reject');
export type AuditReview = typeof AuditReview.infer;

export const AuditSourceEvidence = type({
  evidenceId: OpaqueId,
  subjectId: OpaqueId,
  contentIdentity: Sha256,
  candidateIdentity: Sha256,
  generation: SafePositiveInteger,
}).onUndeclaredKey('reject');

export const AuditCheckEvidence = type({
  evidenceId: OpaqueId,
  checkId: OpaqueId,
  candidateIdentity: Sha256,
  generation: SafePositiveInteger,
  status: "'passed'|'failed'|'skipped'",
}).onUndeclaredKey('reject');

export const AuditCorrection = type({
  correctionId: OpaqueId,
  findingId: OpaqueId,
  ownerId: OpaqueId,
  obligationId: OpaqueId,
  fromReviewId: OpaqueId,
  fromCandidateIdentity: Sha256,
  fromGeneration: SafePositiveInteger,
  candidateIdentity: Sha256,
  generation: SafePositiveInteger,
  sourceEvidence: AuditSourceEvidence.array(),
  checkEvidence: AuditCheckEvidence.array(),
}).onUndeclaredKey('reject');
export type AuditCorrection = typeof AuditCorrection.infer;

export const AuditClosure = type({
  closureId: OpaqueId,
  findingId: OpaqueId,
  correctionId: OpaqueId,
  postCorrectionReviewId: OpaqueId,
}).onUndeclaredKey('reject');
export type AuditClosure = typeof AuditClosure.infer;

export const AuditAdjudication = type({
  adjudicationId: OpaqueId,
  obligationId: OpaqueId,
  candidateIdentity: Sha256,
  generation: SafePositiveInteger,
  // Proof: making reviewRound optional let a roundless adjudication reach an ordinary refused
  // report; the production boundary test reported "function did not throw".
  reviewRound: SafePositiveInteger,
  reviewIds: OpaqueId.array(),
  freshReviewIds: OpaqueId.array(),
  sourceEvidence: AuditSourceEvidence.array(),
  checkEvidence: AuditCheckEvidence.array(),
}).onUndeclaredKey('reject');
export type AuditAdjudication = typeof AuditAdjudication.infer;

/** Strict input retained by trusted policy activation for review-obligation identity checks. */
export const AuditEvaluation = type({
  schemaVersion: SchemaVersion,
  auditId: OpaqueId,
  sourceBase: GitIdentity,
  candidateIdentity: Sha256,
  generation: SafePositiveInteger,
  seed: OpaqueId,
  coverage: "'sampled'|'exhaustive'",
  strata: AuditStratum.array(),
  obligations: AuditObligation.array(),
  mode: "'observe'|'enforce'",
  claimedCoverage: "'sampled'|'exhaustive'",
  reviews: AuditReview.array(),
  corrections: AuditCorrection.array(),
  closures: AuditClosure.array(),
  adjudications: AuditAdjudication.array(),
}).onUndeclaredKey('reject');
export type AuditEvaluation = typeof AuditEvaluation.infer;

export interface AuditRefusal {
  obligationId: string;
  kind: 'coverage' | 'review' | 'finding' | 'adjudication' | 'fresh-review';
  reason: string;
}

export interface AuditOverlap {
  leftReviewId: string;
  rightReviewId: string;
  sameModel: boolean;
  sameExecutor: boolean;
  sharedContextIds: string[];
  sharedReadIds: string[];
}

export interface AuditReviewCost {
  reviewId: string;
  invocationId: string;
  trustScope: 'local-cooperative' | 'trusted-harness' | 'external-verifier';
  reviewReceipt: AuditReview['evidence']['receipt'];
  phaseReceipts: AuditReview['evidence']['phaseReceipts'];
}

export interface AuditUsageObservation {
  reviewId: string;
  phase: 'cold' | 'informed';
  category: string;
  quantity: number;
  unit: string;
}

export interface AuditReadObservation {
  reviewId: string;
  phase: 'cold' | 'informed';
  observedReadIds: string[];
}

/** A checked aggregate of native charges for one exact receipt currency. */
export interface AuditCurrencyCharge {
  currency: string;
  chargedAmountMicros: number;
}

export interface AuditCosts {
  currencyCharges: AuditCurrencyCharge[];
  totalElapsedMs: number;
  reviews: AuditReviewCost[];
  rawUsage: AuditUsageObservation[];
  readObservations: AuditReadObservation[];
}

export interface AuditReport {
  auditId: string;
  mode: 'observe' | 'enforce';
  candidateIdentity: string;
  generation: number;
  claimedCoverage: 'sampled' | 'exhaustive';
  selection: AuditSelection;
  requiredObligationIds: string[];
  unreviewedObligationIds: string[];
  adjudicationObligationIds: string[];
  freshReviewObligationIds: string[];
  overlaps: AuditOverlap[];
  costs: AuditCosts;
  unresolvedFindingIds: string[];
  unmetObligationIds: string[];
  refusals: AuditRefusal[];
  accepted: boolean;
}

interface AuditDisagreement {
  obligationId: string;
  reviewRound: number;
  reviews: AuditReview[];
}

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function assertUnique<Input>(
  inputs: readonly Input[],
  identity: (input: Input) => string,
  subject: string,
): void {
  const seen = new Set<string>();
  for (const input of inputs) {
    const id = identity(input);
    if (seen.has(id)) throw new Error(`duplicate ${subject}: ${id}`);
    seen.add(id);
  }
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightIds = new Set(right);
  return [...new Set(left)].filter((id) => rightIds.has(id)).sort(compareText);
}

function hasExactIds(actual: readonly string[], expected: readonly string[]): boolean {
  const orderedActual = [...actual].sort(compareText);
  const orderedExpected = [...expected].sort(compareText);
  return (
    orderedActual.length === orderedExpected.length &&
    orderedActual.every((id, index) => id === orderedExpected[index])
  );
}

function addAuditCost(total: number, amount: number): number {
  const next = total + amount;
  // Proof: removing this guard let the production cost report emit the unsafe integer
  // 9007199254741004; the boundary test reported "function did not throw".
  if (
    !Number.isSafeInteger(amount) ||
    Object.is(amount, -0) ||
    !Number.isSafeInteger(next) ||
    Object.is(next, -0)
  ) {
    throw new Error('audit cost total is not a safe integer');
  }
  return next;
}

function reviewCanDischarge(review: AuditReview): boolean {
  // Proof: checking only cold let censored informed work discharge review.project.tool-wiki;
  // checking only informed let failed cold work discharge review.directory.src.
  return (['cold', 'informed'] as const).every(
    (phase) => review.evidence.phaseReceipts[phase].receipt.status === 'completed',
  );
}

function suppliedContextIds(review: AuditReview): string[] {
  return [
    review.evidence.protocolEvidence.protocol.protocolBlob,
    review.evidence.protocolEvidence.subject.contentIdentity,
    ...review.evidence.protocolEvidence.expansion.suppliedContextIds,
  ];
}

function observedReadIds(review: AuditReview): string[] {
  return [
    ...review.evidence.protocolEvidence.cold.observedReadIds,
    ...review.evidence.protocolEvidence.informed.observedReadIds,
  ];
}

/** Decodes and reconciles a pinned audit population before selection. */
export function decodeAuditSelectionRequest(input: unknown): AuditSelectionRequest {
  // Proof: removing this assertion changed the -0 boundary failure from "negative zero" to
  // ArkType's ordinary "at least 1 (was 0)", losing the noncanonical-value diagnosis.
  assertCanonicalJsonValue(input);
  const request = parseOrThrow(AuditSelectionRequest, input);
  // Proof: removing this check duplicated risk.high, review.directory.src and its sample row;
  // the selection-boundary test reported "function did not throw".
  assertUnique(request.strata, ({ stratumId }) => stratumId, 'audit stratum');
  // Proof: removing this check admitted two review.file.alpha records with different subjects;
  // the boundary test reported "function did not throw" and changed risk.high population to 3.
  assertUnique(request.obligations, ({ obligationId }) => obligationId, 'audit obligation');
  // Proof: removing this check admitted one subject under two obligation IDs; the boundary test
  // reported "function did not throw" and changed risk.high population to 3.
  assertUnique(request.obligations, ({ subject }) => subject.subjectId, 'audit obligation subject');
  const strata = new Set(request.strata.map(({ stratumId }) => stratumId));
  for (const obligation of request.obligations) {
    // Proof: forcing this condition false silently dropped risk.unknown; the boundary test
    // reported "function did not throw" and risk.high population shrank to 1.
    if (!strata.has(obligation.riskStratum)) {
      throw new Error(
        `audit obligation ${obligation.obligationId} has unknown risk stratum: ${obligation.riskStratum}`,
      );
    }
  }
  for (const stratum of request.strata) {
    // Proof: forcing this condition false emitted risk.empty with population 0 but sampleSize 1;
    // the boundary test reported "function did not throw".
    if (!request.obligations.some(({ riskStratum }) => riskStratum === stratum.stratumId)) {
      throw new Error(`audit stratum has no population: ${stratum.stratumId}`);
    }
  }
  return request;
}

function auditScore(request: AuditSelectionRequest, obligation: AuditObligation): string {
  return hashBytes(
    [
      request.candidateIdentity,
      // Proof: omitting the seed selected review.documentation.guide instead of
      // review.project.tool-wiki in the exact repeatable-sample production test.
      request.seed,
      obligation.riskStratum,
      obligation.obligationId,
      obligation.subject.subjectId,
    ].join('\0'),
  );
}

/** Selects an exact reproducible sample from each risk stratum of a pinned population. */
export function selectAudit(input: unknown): AuditSelection {
  const request = decodeAuditSelectionRequest(input);
  const strata = [...request.strata]
    .sort((left, right) => compareText(left.stratumId, right.stratumId))
    .map((stratum): AuditSelectionStratum => {
      const population = request.obligations
        .filter(({ riskStratum }) => riskStratum === stratum.stratumId)
        .sort((left, right) => {
          const scoreOrder = compareText(auditScore(request, left), auditScore(request, right));
          return scoreOrder === 0 ? compareText(left.obligationId, right.obligationId) : scoreOrder;
        });
      const sampleSize =
        request.coverage === 'exhaustive'
          ? population.length
          : Math.max(1, Math.ceil((population.length * stratum.sampleRateBps) / 10000));
      return {
        stratumId: stratum.stratumId,
        populationSize: population.length,
        sampleSize,
        obligationIds: population
          .slice(0, sampleSize)
          .map(({ obligationId }) => obligationId)
          .sort(compareText),
      };
    });
  const selected = {
    schemaVersion: 1 as const,
    auditId: request.auditId,
    sourceBase: request.sourceBase,
    candidateIdentity: request.candidateIdentity,
    generation: request.generation,
    seed: request.seed,
    coverage: request.coverage,
    strata,
    obligationIds: strata.flatMap(({ obligationIds }) => obligationIds),
  };
  return { ...selected, selectionId: hashCanonical(selected) };
}

/** Reports finite review debt without allowing sampled coverage to impersonate exhaustive work. */
export function evaluateAudit(input: unknown): AuditReport {
  // Proof: removing this assertion let a non-plain envelope with an inherited property produce
  // an accepted report; the production boundary test reported "function did not throw".
  assertCanonicalJsonValue(input);
  const envelope = parseOrThrow(AuditEvaluation, input);
  const selectionInput: AuditSelectionRequest = {
    schemaVersion: envelope.schemaVersion,
    auditId: envelope.auditId,
    sourceBase: envelope.sourceBase,
    candidateIdentity: envelope.candidateIdentity,
    generation: envelope.generation,
    seed: envelope.seed,
    coverage: envelope.coverage,
    strata: envelope.strata,
    obligations: envelope.obligations,
  };
  const selection = selectAudit(selectionInput);
  // Proof: removing this check let two records share review.binding.directory; the identity-
  // reuse production test reported "function did not throw" and duplicated its cost rows.
  assertUnique(envelope.reviews, ({ reviewId }) => reviewId, 'audit review');
  // Proof: removing this check let two review IDs share one invocation; the identity-reuse
  // production test reported "function did not throw" and an accepted audit.
  assertUnique(
    envelope.reviews,
    ({ evidence }) => evidence.receipt.invocationId,
    'audit review invocation',
  );
  const receipts = envelope.reviews.flatMap((review) => [
    review.evidence.receipt,
    review.evidence.phaseReceipts.cold.receipt,
    ...review.evidence.phaseReceipts.cold.elapsedReceipts,
    review.evidence.phaseReceipts.informed.receipt,
    ...review.evidence.phaseReceipts.informed.elapsedReceipts,
  ]);
  // Proof: removing this guard let one zero-charge receipt identify both audit phases; the public
  // receipt-identity test reported "function did not throw".
  assertUnique(receipts, ({ receiptId }) => receiptId, 'audit receipt');
  // Proof: removing this check let correction.alpha appear twice and still close its finding;
  // the correction production test reported "function did not throw".
  assertUnique(envelope.corrections, ({ correctionId }) => correctionId, 'audit correction');
  for (const correction of envelope.corrections) {
    // Proof: removing this check admitted source.alpha twice and still closed finding.alpha;
    // the correction boundary test reported "function did not throw".
    assertUnique(
      correction.sourceEvidence,
      ({ evidenceId }) => evidenceId,
      'correction source evidence',
    );
    // Proof: removing this check admitted check-evidence.alpha twice and still closed the
    // finding; the correction boundary test reported "function did not throw".
    assertUnique(
      correction.checkEvidence,
      ({ evidenceId }) => evidenceId,
      'correction check evidence',
    );
  }
  // Proof: removing this check admitted closure.alpha for two finding IDs; the correction
  // production test reported "function did not throw".
  assertUnique(envelope.closures, ({ closureId }) => closureId, 'audit closure');
  // Proof: removing this check admitted two closure IDs for finding.alpha; the correction
  // production test reported "function did not throw".
  assertUnique(envelope.closures, ({ findingId }) => findingId, 'audit closure finding');
  // Proof: removing this check admitted adjudication.directory twice and still accepted;
  // the adjudication production test reported "function did not throw".
  assertUnique(
    envelope.adjudications,
    ({ adjudicationId }) => adjudicationId,
    'audit adjudication',
  );
  // Proof: removing this guard let two adjudication IDs resolve the same obligation/round;
  // the adjudication production test reported "function did not throw".
  assertUnique(
    envelope.adjudications,
    ({ obligationId, reviewRound }) => `${obligationId}\0${String(reviewRound)}`,
    'audit adjudication round',
  );
  for (const adjudication of envelope.adjudications) {
    // Proof: removing this check admitted a repeated yes review and returned ordinary unmet
    // duties; the adjudication boundary test reported "function did not throw".
    assertUnique(adjudication.reviewIds, (reviewId) => reviewId, 'adjudication review');
    // Proof: removing this check admitted the same fresh directory review twice and still
    // accepted; the adjudication boundary test reported "function did not throw".
    assertUnique(adjudication.freshReviewIds, (reviewId) => reviewId, 'adjudication fresh review');
    // Proof: removing this check admitted adjudication-source.directory twice and still
    // accepted; the adjudication boundary test reported "function did not throw".
    assertUnique(
      adjudication.sourceEvidence,
      ({ evidenceId }) => evidenceId,
      'adjudication source evidence',
    );
    // Proof: removing this check admitted adjudication-check.directory twice and still
    // accepted; the adjudication boundary test reported "function did not throw".
    assertUnique(
      adjudication.checkEvidence,
      ({ evidenceId }) => evidenceId,
      'adjudication check evidence',
    );
  }
  // Proof: removing this check admitted finding.alpha twice and changed an otherwise closed
  // report to unresolved ["finding.alpha"]; the correction test reported "function did not throw".
  assertUnique(
    envelope.reviews.flatMap(({ findings }) => findings),
    ({ findingId }) => findingId,
    'audit finding',
  );
  const obligationById = new Map(
    envelope.obligations.map((obligation) => [obligation.obligationId, obligation]),
  );
  for (const review of envelope.reviews) {
    const obligation = obligationById.get(review.obligationId);
    if (obligation === undefined) {
      throw new Error(
        `audit review ${review.reviewId} has unknown obligation: ${review.obligationId}`,
      );
    }
    const subject = review.evidence.protocolEvidence.subject;
    // Proof: forcing this condition false let subject.foreign satisfy the directory obligation;
    // the binding production test reported "function did not throw" and accepted the audit.
    if (
      subject.subjectId !== obligation.subject.subjectId ||
      subject.kind !== obligation.subject.kind ||
      subject.path !== obligation.subject.path
    ) {
      throw new Error(`audit review ${review.reviewId} does not bind the obligation subject`);
    }
    // Proof: forcing this condition false admitted generation 4 into a generation 3 audit;
    // the binding production test reported "function did not throw".
    if (review.generation > envelope.generation) {
      throw new Error(`audit review ${review.reviewId} is from a future generation`);
    }
    // Proof: forcing this condition false let source base 222... satisfy 111...; the binding
    // production test reported "function did not throw" and accepted the audit.
    if (review.sourceBase !== envelope.sourceBase) {
      throw new Error(`audit review ${review.reviewId} does not bind the audit source base`);
    }
    // Proof: removing this exact-content guard let SHA_B satisfy the current SHA_A subject;
    // the binding production test reported "function did not throw" and accepted the audit.
    if (
      review.candidateIdentity === envelope.candidateIdentity &&
      review.generation === envelope.generation &&
      subject.contentIdentity !== obligation.subject.contentIdentity
    ) {
      throw new Error(`audit review ${review.reviewId} does not bind current subject content`);
    }
    const invocationId = review.evidence.receipt.invocationId;
    // Proof: removing this reconciliation admitted invocation.foreign in the cold phase;
    // the binding production test reported "function did not throw".
    if (
      review.evidence.phaseReceipts.cold.receipt.invocationId !== invocationId ||
      review.evidence.phaseReceipts.informed.receipt.invocationId !== invocationId
    ) {
      throw new Error(`audit review ${review.reviewId} mixes invocation identities`);
    }
    const phaseReceipts = [
      review.evidence.phaseReceipts.cold.receipt,
      review.evidence.phaseReceipts.informed.receipt,
    ];
    // Proof: forcing this condition false admitted cold model other-model beside gpt-5;
    // the binding production test reported "function did not throw".
    if (
      phaseReceipts.some(
        (receipt) =>
          hashCanonical(receipt.executor) !== hashCanonical(review.evidence.receipt.executor) ||
          hashCanonical(receipt.priceIdentity) !==
            hashCanonical(review.evidence.receipt.priceIdentity),
      )
    ) {
      throw new Error(`audit review ${review.reviewId} mixes executor or price identities`);
    }
    const phaseUsage = phaseReceipts.flatMap(({ rawUsage }) => rawUsage);
    // Proof: forcing this condition false admitted a review receipt missing its cold usage;
    // the binding production test reported "function did not throw".
    if (hashCanonical(phaseUsage) !== hashCanonical(review.evidence.receipt.rawUsage)) {
      throw new Error(`audit review ${review.reviewId} omits phase usage from its review receipt`);
    }
    // Proof: forcing this condition false admitted SHA_B beside the retained informed SHA;
    // the binding production test reported "function did not throw".
    if (
      review.evidence.receipt.rawResponseArtifact !== review.evidence.rawResponse.artifact ||
      review.evidence.phaseReceipts.informed.receipt.outputArtifact !==
        review.evidence.rawResponse.artifact
    ) {
      throw new Error(`audit review ${review.reviewId} does not bind its informed response`);
    }
    // Proof: removing this reconciliation let both an empty summary erase known context and an
    // extra SHA_A inflate it; each production test reported "function did not throw".
    if (
      hashCanonical(review.evidence.receipt.suppliedContextIds) !==
      hashCanonical(suppliedContextIds(review))
    ) {
      throw new Error(`audit review ${review.reviewId} does not summarize supplied context`);
    }
    // Proof: removing this reconciliation let both an empty summary erase known reads and an
    // extra SHA_A inflate it; each production test reported "function did not throw".
    if (
      hashCanonical(review.evidence.receipt.observedReadIds) !==
      hashCanonical(observedReadIds(review))
    ) {
      throw new Error(`audit review ${review.reviewId} does not summarize observed reads`);
    }
  }
  const requiredObligationIds = (
    envelope.claimedCoverage === 'exhaustive'
      ? envelope.obligations.map(({ obligationId }) => obligationId)
      : selection.obligationIds
  ).sort(compareText);
  const reviewedObligationIds = new Set(
    envelope.reviews
      // Proof: removing this exact candidate/generation filter let generation 2 discharge
      // review.directory.src; the binding test expected it in unmet and received [].
      .filter(
        (review) =>
          review.candidateIdentity === envelope.candidateIdentity &&
          review.generation === envelope.generation &&
          reviewCanDischarge(review),
      )
      .map(({ obligationId }) => obligationId),
  );
  const unreviewedObligationIds = envelope.obligations
    .map(({ obligationId }) => obligationId)
    .filter((obligationId) => !reviewedObligationIds.has(obligationId))
    .sort(compareText);
  const currentReviews = envelope.reviews.filter(
    (review) =>
      review.candidateIdentity === envelope.candidateIdentity &&
      review.generation === envelope.generation &&
      reviewCanDischarge(review),
  );
  const reviewsByObligation = new Map<string, AuditReview[]>();
  for (const review of currentReviews) {
    const reviews = reviewsByObligation.get(review.obligationId) ?? [];
    reviews.push(review);
    reviewsByObligation.set(review.obligationId, reviews);
  }
  const disagreementRounds: AuditDisagreement[] = [...reviewsByObligation].flatMap(
    ([obligationId, reviews]) => {
      const rounds = new Map<number, AuditReview[]>();
      for (const review of reviews) {
        const roundReviews = rounds.get(review.reviewRound) ?? [];
        roundReviews.push(review);
        rounds.set(review.reviewRound, roundReviews);
      }
      return (
        [...rounds]
          // Proof: retaining only the earliest round made the later-round production test receive
          // no adjudication obligations instead of review.directory.src.
          .filter(([, roundReviews]) => {
            const judgments = new Set(
              roundReviews.map(({ evidence }) =>
                hashCanonical(evidence.protocolEvidence.informed.judgments),
              ),
            );
            // Proof: forcing this false made the disagreement production report return [] where
            // review.directory.src was the required adjudication obligation.
            return judgments.size > 1;
          })
          .map(([reviewRound, roundReviews]) => ({
            obligationId,
            reviewRound,
            reviews: roundReviews,
          }))
      );
    },
  );
  const adjudicationObligationIds = [
    ...new Set(disagreementRounds.map(({ obligationId }) => obligationId)),
  ].sort(compareText);
  // Proof: starting this set empty let a below-threshold disagreement produce no fresh-review
  // duty; the production test expected review.directory.src and received [].
  const freshReviewIds = new Set(adjudicationObligationIds);
  const freshDisagreementsByObligation = new Map<string, AuditDisagreement[]>();
  for (const disagreement of disagreementRounds) {
    freshDisagreementsByObligation.set(disagreement.obligationId, [
      ...(freshDisagreementsByObligation.get(disagreement.obligationId) ?? []),
      disagreement,
    ]);
  }
  for (const stratum of envelope.strata) {
    const selectedInStratum = selection.obligationIds.filter(
      (obligationId) => obligationById.get(obligationId)?.riskStratum === stratum.stratumId,
    );
    const disputedInStratum = adjudicationObligationIds.filter(
      (obligationId) => obligationById.get(obligationId)?.riskStratum === stratum.stratumId,
    );
    const disagreementRoundsInStratum = disagreementRounds.filter(
      ({ obligationId }) => obligationById.get(obligationId)?.riskStratum === stratum.stratumId,
    );
    const disagreementBps = Math.floor(
      (disputedInStratum.length * 10000) / selectedInStratum.length,
    );
    if (disagreementBps >= stratum.disagreementTriggerBps) {
      for (const obligation of envelope.obligations) {
        if (obligation.riskStratum === stratum.stratumId) {
          freshReviewIds.add(obligation.obligationId);
          freshDisagreementsByObligation.set(obligation.obligationId, [
            ...(freshDisagreementsByObligation.get(obligation.obligationId) ?? []),
            ...disagreementRoundsInStratum,
          ]);
        }
      }
    }
  }
  const freshReviewObligationIds = [...freshReviewIds].sort(compareText);
  const reviewById = new Map(envelope.reviews.map((review) => [review.reviewId, review]));
  const validAdjudications = envelope.adjudications.flatMap((adjudication) => {
    const disagreement = disagreementRounds.find(
      // Proof: ignoring reviewRound let a round-1 adjudication discharge the exact round-2
      // conflict; the later-round test expected both named duties and received none.
      ({ obligationId, reviewRound }) =>
        obligationId === adjudication.obligationId && reviewRound === adjudication.reviewRound,
    );
    const obligation = obligationById.get(adjudication.obligationId);
    if (disagreement === undefined || obligation === undefined) return [];
    const isValid =
      adjudicationObligationIds.includes(adjudication.obligationId) &&
      adjudication.candidateIdentity === envelope.candidateIdentity &&
      adjudication.generation === envelope.generation &&
      // Proof: bypassing this exact-ID comparison let review.later.round-one adjudicate a
      // round-2 conflict; the later-round test expected both named duties and received none.
      hasExactIds(
        adjudication.reviewIds,
        disagreement.reviews.map(({ reviewId }) => reviewId),
      ) &&
      // Proof: replacing this source binding with true let an empty adjudication source
      // discharge its duty; the production test expected the named obligation and received [].
      adjudication.sourceEvidence.some(
        (evidence) =>
          evidence.subjectId === obligation.subject.subjectId &&
          evidence.contentIdentity === obligation.subject.contentIdentity &&
          evidence.candidateIdentity === envelope.candidateIdentity &&
          evidence.generation === envelope.generation,
      ) &&
      // Proof: replacing this check binding with true let empty check evidence discharge
      // adjudication; the production test expected the named obligation and received [].
      adjudication.checkEvidence.some(
        (evidence) =>
          evidence.status === 'passed' &&
          evidence.candidateIdentity === envelope.candidateIdentity &&
          evidence.generation === envelope.generation,
      );
    return isValid ? [{ adjudication, disagreement }] : [];
  });
  const unmetAdjudicationIds = [
    ...new Set(
      disagreementRounds
        .filter(
          (disagreement) =>
            !validAdjudications.some(
              ({ disagreement: resolved }) =>
                resolved.obligationId === disagreement.obligationId &&
                resolved.reviewRound === disagreement.reviewRound,
            ),
        )
        .map(({ obligationId }) => obligationId),
    ),
  ].sort(compareText);
  const unmetFreshReviewIds = freshReviewObligationIds.filter((obligationId) => {
    // Proof: checking only the first conflict let a resolved round 2 hide a new round-4
    // conflict; the later-round test lost fresh-review:review.directory.src.
    const disagreements = freshDisagreementsByObligation.get(obligationId) ?? [];
    return disagreements.some(
      (disagreement) =>
        !validAdjudications.some(
          ({ adjudication, disagreement: resolved }) =>
            resolved.obligationId === disagreement.obligationId &&
            resolved.reviewRound === disagreement.reviewRound &&
            adjudication.freshReviewIds.some((reviewId) => {
              const freshReview = reviewById.get(reviewId);
              return (
                freshReview?.obligationId === obligationId &&
                freshReview.candidateIdentity === envelope.candidateIdentity &&
                freshReview.generation === envelope.generation &&
                // Proof: removing completion here let a failed cold attempt discharge the
                // directory fresh-review duty; the production test expected it and received [].
                reviewCanDischarge(freshReview) &&
                // Proof: removing the round comparison reused an initial yes review; the
                // production report lost fresh-review:review.directory.src and retained only
                // the file duty.
                freshReview.reviewRound > disagreement.reviewRound
              );
            }),
        ),
    );
  });
  // Proof: retaining caller order made reversed input reverse all cost rows and the overlap
  // pair; the order-independence production test reported a 40-line structural mismatch.
  const orderedReviews = [...envelope.reviews].sort((left, right) =>
    compareText(left.reviewId, right.reviewId),
  );
  const overlaps: AuditOverlap[] = [];
  for (let leftIndex = 0; leftIndex < orderedReviews.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < orderedReviews.length; rightIndex += 1) {
      const left = orderedReviews[leftIndex];
      const right = orderedReviews[rightIndex];
      overlaps.push({
        leftReviewId: left.reviewId,
        rightReviewId: right.reviewId,
        sameModel:
          left.evidence.receipt.executor.provider === right.evidence.receipt.executor.provider &&
          left.evidence.receipt.executor.model === right.evidence.receipt.executor.model,
        sameExecutor:
          hashCanonical(left.evidence.receipt.executor) ===
          hashCanonical(right.evidence.receipt.executor),
        sharedContextIds: intersection(
          left.evidence.receipt.suppliedContextIds,
          right.evidence.receipt.suppliedContextIds,
        ),
        sharedReadIds: intersection(
          left.evidence.receipt.observedReadIds,
          right.evidence.receipt.observedReadIds,
        ),
      });
    }
  }
  const chargedAmountMicrosByCurrency = new Map<string, number>();
  let totalElapsedMs = 0;
  const costReviews: AuditReviewCost[] = [];
  const rawUsage: AuditUsageObservation[] = [];
  const readObservations: AuditReadObservation[] = [];
  for (const review of orderedReviews) {
    costReviews.push({
      reviewId: review.reviewId,
      invocationId: review.evidence.receipt.invocationId,
      trustScope: review.evidence.receipt.trust.scope,
      reviewReceipt: review.evidence.receipt,
      phaseReceipts: review.evidence.phaseReceipts,
    });
    // Proof: aggregating only informed phases made the full-cost production test receive
    // 28 charged micros instead of 50.
    for (const phase of ['cold', 'informed'] as const) {
      const phaseEvidence = review.evidence.phaseReceipts[phase];
      const currency = phaseEvidence.receipt.priceIdentity.currency;
      chargedAmountMicrosByCurrency.set(
        currency,
        addAuditCost(
          chargedAmountMicrosByCurrency.get(currency) ?? 0,
          phaseEvidence.receipt.chargedAmountMicros,
        ),
      );
      for (const elapsed of phaseEvidence.elapsedReceipts) {
        totalElapsedMs = addAuditCost(totalElapsedMs, elapsed.elapsedMs);
      }
      for (const usage of phaseEvidence.receipt.rawUsage) {
        rawUsage.push({ reviewId: review.reviewId, phase, ...usage });
      }
      readObservations.push({
        reviewId: review.reviewId,
        phase,
        observedReadIds: [...review.evidence.protocolEvidence[phase].observedReadIds].sort(
          compareText,
        ),
      });
    }
  }
  // Proof: forcing every phase into USD returned USD 50 instead of EUR 25 / USD 25; removing
  // the sort returned USD then EUR where the public production test required EUR then USD.
  const currencyCharges = [...chargedAmountMicrosByCurrency]
    .sort(([leftCurrency], [rightCurrency]) => compareText(leftCurrency, rightCurrency))
    .map(([currency, chargedAmountMicros]) => ({ currency, chargedAmountMicros }));
  const costs: AuditCosts = {
    currencyCharges,
    totalElapsedMs,
    reviews: costReviews,
    rawUsage,
    readObservations,
  };
  const correctionById = new Map(
    envelope.corrections.map((correction) => [correction.correctionId, correction]),
  );
  const closureByFinding = new Map(
    envelope.closures.map((closure) => [closure.findingId, closure]),
  );
  const unresolvedFindingIds = envelope.reviews
    .flatMap((review) => review.findings.map((finding) => ({ finding, opening: review })))
    .filter(({ finding, opening }) => {
      const closure = closureByFinding.get(finding.findingId);
      if (closure === undefined) return true;
      const correction = correctionById.get(closure.correctionId);
      const postCorrectionReview = reviewById.get(closure.postCorrectionReviewId);
      const obligation = obligationById.get(opening.obligationId);
      if (
        correction === undefined ||
        postCorrectionReview === undefined ||
        obligation === undefined ||
        closure.findingId !== finding.findingId ||
        correction.findingId !== finding.findingId ||
        correction.obligationId !== opening.obligationId ||
        correction.fromReviewId !== opening.reviewId ||
        correction.fromCandidateIdentity !== opening.candidateIdentity ||
        correction.fromGeneration !== opening.generation ||
        correction.candidateIdentity !== envelope.candidateIdentity ||
        correction.generation !== envelope.generation ||
        correction.generation <= correction.fromGeneration
      ) {
        return true;
      }
      // Proof: forcing this true closed finding.alpha with sourceEvidence []; the correction
      // production test expected ["finding.alpha"] and received [].
      const hasSourceEvidence = correction.sourceEvidence.some(
        (evidence) =>
          evidence.subjectId === obligation.subject.subjectId &&
          evidence.contentIdentity === obligation.subject.contentIdentity &&
          evidence.candidateIdentity === correction.candidateIdentity &&
          evidence.generation === correction.generation,
      );
      // Proof: forcing this true closed finding.alpha with checkEvidence []; the correction
      // production test expected ["finding.alpha"] and received [].
      const hasCheckEvidence = correction.checkEvidence.some(
        (evidence) =>
          evidence.status === 'passed' &&
          evidence.candidateIdentity === correction.candidateIdentity &&
          evidence.generation === correction.generation,
      );
      return !(
        hasSourceEvidence &&
        hasCheckEvidence &&
        postCorrectionReview.obligationId === opening.obligationId &&
        // Proof: retaining only the obligation comparison reused review.opening; the correction
        // production test expected ["finding.alpha"] and received [] for unresolved findings.
        postCorrectionReview.candidateIdentity === correction.candidateIdentity &&
        postCorrectionReview.generation === correction.generation &&
        // Proof: removing completion here let a failed cold attempt close finding.alpha;
        // the correction production test expected it unresolved and received [].
        reviewCanDischarge(postCorrectionReview) &&
        postCorrectionReview.reviewRound > opening.reviewRound
      );
    })
    .map(({ finding }) => finding.findingId)
    .sort(compareText);
  // Proof: replacing this filter with [] made the missing-sampled-review production test
  // report accepted true where false was required.
  const missingReviewIds = requiredObligationIds.filter(
    (obligationId) => !reviewedObligationIds.has(obligationId),
  );
  // Proof: forcing this predicate false removed coverage.exhaustive from the sampled-as-
  // exhaustive production report; the test received only the two missing review refusals.
  const refusesExhaustive =
    envelope.claimedCoverage === 'exhaustive' && envelope.coverage === 'sampled';
  const refusals: AuditRefusal[] = [];
  if (refusesExhaustive) {
    refusals.push({
      obligationId: 'coverage.exhaustive',
      kind: 'coverage',
      reason: 'sampled selection cannot establish exhaustive coverage',
    });
  }
  refusals.push(
    ...missingReviewIds.map((obligationId): AuditRefusal => ({
      obligationId,
      kind: 'review',
      reason: 'required review is missing for the exact candidate and generation',
    })),
  );
  refusals.push(
    ...unmetAdjudicationIds.map((obligationId): AuditRefusal => ({
      obligationId: `adjudicate:${obligationId}`,
      kind: 'adjudication',
      reason: 'disagreement requires source-based adjudication',
    })),
    ...unmetFreshReviewIds.map((obligationId): AuditRefusal => ({
      obligationId: `fresh-review:${obligationId}`,
      kind: 'fresh-review',
      reason: 'disagreement requires a fresh shard review',
    })),
    ...unresolvedFindingIds.map((findingId): AuditRefusal => ({
      obligationId: `finding:${findingId}`,
      kind: 'finding',
      reason:
        'finding closure requires authoritative current source/check evidence and a fresh post-correction review',
    })),
  );
  const unmetObligationIds = [
    ...(refusesExhaustive ? ['coverage.exhaustive'] : []),
    ...missingReviewIds,
    ...unmetAdjudicationIds.map((obligationId) => `adjudicate:${obligationId}`),
    ...unmetFreshReviewIds.map((obligationId) => `fresh-review:${obligationId}`),
    ...unresolvedFindingIds.map((findingId) => `finding:${findingId}`),
  ].sort(compareText);
  return {
    auditId: envelope.auditId,
    mode: envelope.mode,
    candidateIdentity: envelope.candidateIdentity,
    generation: envelope.generation,
    claimedCoverage: envelope.claimedCoverage,
    selection,
    requiredObligationIds,
    unreviewedObligationIds,
    adjudicationObligationIds,
    freshReviewObligationIds,
    overlaps,
    costs,
    unresolvedFindingIds,
    unmetObligationIds,
    refusals,
    accepted: envelope.mode === 'observe' || refusals.length === 0,
  };
}
