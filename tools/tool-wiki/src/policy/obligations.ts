import { Buffer } from 'node:buffer';

import { parseOrThrow, type } from '@wbs/validation';

import { OpaqueId } from '../contracts/records';
import {
  classifyCurrency,
  type ContentChange,
  type CurrencyReport,
  type CurrencySnapshot,
  decodeCurrencySnapshot,
  decodeReviewJudgments,
  type ReviewJudgment,
} from '../evidence/currency';

export interface BehaviorRule {
  contentInputId: string;
  consumerChecks: string[];
  conformanceChecks: string[];
  expandedReviewJudgments: string[];
}

export interface ObligationPolicy {
  policyId: string;
  behaviorRules: BehaviorRule[];
}

interface ImpactClassificationBase {
  classificationId: string;
  contentInputId: string;
  reviewedSourceBase: string;
  currentSourceBase: string;
  reviewedCandidateIdentity: string;
  currentCandidateIdentity: string;
  classification: 'behavior-changing' | 'behavior-preserving' | 'unknown';
  authority:
    | { kind: 'reviewed'; reviewIdentity: string }
    | { kind: 'declared'; declarationIdentity: string };
}

export type ImpactClassification = ImpactClassificationBase &
  (
    | { change: 'added'; currentIdentity: string }
    | { change: 'changed'; reviewedIdentity: string; currentIdentity: string }
    | { change: 'removed'; reviewedIdentity: string }
  );

export interface WriterImpactLabel {
  labelId: string;
  contentInputId: string;
  label: 'implementation-only';
}

export interface CheckEvidence {
  observationId: string;
  checkId: string;
  candidateIdentity: string;
  status: 'failed' | 'passed' | 'skipped';
}

export interface ReviewEvidence {
  observationId: string;
  judgmentId: string;
  candidateIdentity: string;
  status: 'current' | 'failed';
}

export interface ObligationRequest {
  reviewed: CurrencySnapshot;
  current: CurrencySnapshot;
  judgments: ReviewJudgment[];
  policy: ObligationPolicy;
  impactClassifications: ImpactClassification[];
  writerLabels: WriterImpactLabel[];
  checks: CheckEvidence[];
  reviews: ReviewEvidence[];
}

export type ObligationKind =
  'behavior-policy' | 'check' | 'expanded-review' | 'impact-classification' | 'review';

export interface Refusal {
  obligationId: string;
  kind: ObligationKind;
  subjectId: string;
  reason: string;
}

export interface ObligationReport {
  policyId: string;
  candidateIdentity: string;
  currency: CurrencyReport;
  writerLabels: WriterImpactLabel[];
  requiredChecks: string[];
  requiredReviews: string[];
  refusals: Refusal[];
  accepted: boolean;
}

const GitIdentity = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const Sha256 = type(/^[0-9a-f]{64}$/);
const AuthorityRecord = type({ kind: "'reviewed'", reviewIdentity: Sha256 })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'declared'", declarationIdentity: Sha256 }).onUndeclaredKey('reject'));
const ImpactClassificationBaseShape = {
  classificationId: OpaqueId,
  contentInputId: OpaqueId,
  reviewedSourceBase: GitIdentity,
  currentSourceBase: GitIdentity,
  reviewedCandidateIdentity: Sha256,
  currentCandidateIdentity: Sha256,
  // Proof: widening this to an opaque string made
  // `rejects an unrecognized impact classification at the public boundary` accept
  // `implementation-only` as known with no refusals; making it optional let an absent
  // classification through with the same accepted report instead of throwing.
  classification: "'behavior-changing'|'behavior-preserving'|'unknown'",
  authority: AuthorityRecord,
} as const;
const ImpactClassificationRecord = type({
  ...ImpactClassificationBaseShape,
  change: "'added'",
  currentIdentity: GitIdentity,
})
  .onUndeclaredKey('reject')
  .or(
    type({
      ...ImpactClassificationBaseShape,
      change: "'changed'",
      reviewedIdentity: GitIdentity,
      currentIdentity: GitIdentity,
    }).onUndeclaredKey('reject'),
  )
  .or(
    type({
      ...ImpactClassificationBaseShape,
      change: "'removed'",
      reviewedIdentity: GitIdentity,
    }).onUndeclaredKey('reject'),
  );
const BehaviorRuleRecord = type({
  contentInputId: OpaqueId,
  consumerChecks: OpaqueId.array(),
  conformanceChecks: OpaqueId.array(),
  expandedReviewJudgments: OpaqueId.array(),
}).onUndeclaredKey('reject');
const ObligationRequestRecord = type({
  reviewed: 'unknown',
  current: 'unknown',
  judgments: 'unknown',
  policy: type({ policyId: OpaqueId, behaviorRules: BehaviorRuleRecord.array() }).onUndeclaredKey(
    'reject',
  ),
  impactClassifications: ImpactClassificationRecord.array(),
  writerLabels: type({
    labelId: OpaqueId,
    contentInputId: OpaqueId,
    label: "'implementation-only'",
  })
    .onUndeclaredKey('reject')
    .array(),
  checks: type({
    observationId: OpaqueId,
    checkId: OpaqueId,
    candidateIdentity: Sha256,
    status: "'failed'|'passed'|'skipped'",
  })
    .onUndeclaredKey('reject')
    .array(),
  reviews: type({
    observationId: OpaqueId,
    judgmentId: OpaqueId,
    candidateIdentity: Sha256,
    status: "'current'|'failed'",
  })
    .onUndeclaredKey('reject')
    .array(),
}).onUndeclaredKey('reject');

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function assertUniqueEvidenceIds(request: ObligationRequest): void {
  for (const [kind, ids] of [
    // Proof: omitting this family made `refuses duplicate impact-classification identities`
    // return an accepted report instead of throwing for `classification.child`.
    ['impact classification', request.impactClassifications.map((entry) => entry.classificationId)],
    // Proof: omitting this family made `refuses duplicate writer-label identities` return an
    // accepted report containing both duplicate labels instead of throwing for `writer-label.child`.
    ['writer label', request.writerLabels.map((entry) => entry.labelId)],
    // Proof: omitting this family made `refuses duplicate check-observation identities` return
    // accepted instead of throwing for `check-observation.consumer`.
    ['check observation', request.checks.map((entry) => entry.observationId)],
    // Proof: omitting this family made `refuses duplicate review-observation identities` return
    // accepted instead of throwing for `review-observation.child`.
    ['review observation', request.reviews.map((entry) => entry.observationId)],
  ] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`duplicate ${kind}: ${id}`);
      seen.add(id);
    }
  }
}

/** Decodes and semantically validates one obligation request at its public boundary. */
export function decodeObligationRequest(input: unknown): ObligationRequest {
  const envelope = parseOrThrow(ObligationRequestRecord, input);
  const request: ObligationRequest = {
    reviewed: decodeCurrencySnapshot(envelope.reviewed),
    current: decodeCurrencySnapshot(envelope.current),
    judgments: decodeReviewJudgments(envelope.judgments),
    policy: envelope.policy,
    impactClassifications: envelope.impactClassifications,
    writerLabels: envelope.writerLabels,
    checks: envelope.checks,
    reviews: envelope.reviews,
  };
  // Proof: skipping semantic duplicate validation made
  // `refuses duplicate impact-classification identities` accept two `classification.child`
  // observations instead of throwing the named duplicate error.
  assertUniqueEvidenceIds(request);
  return request;
}

function indexBehaviorRules(rules: readonly BehaviorRule[]): Map<string, BehaviorRule> {
  const byContentInput = new Map<string, BehaviorRule>();
  for (const rule of rules) {
    // Proof: deleting this refusal made
    // `refuses duplicate behavior rules instead of selecting by array order` return accepted
    // with only `check.consumer` selected instead of throwing the named duplicate error.
    if (byContentInput.has(rule.contentInputId)) {
      throw new Error(`duplicate behavior rule content input: ${rule.contentInputId}`);
    }
    byContentInput.set(rule.contentInputId, rule);
  }
  return byContentInput;
}

function currentCheck(
  evidence: readonly CheckEvidence[],
  checkId: string,
  candidateIdentity: string,
): CheckEvidence | undefined {
  const matching = evidence.filter(
    // Proof: dropping candidate identity from this match made
    // `foreign candidate observations cannot discharge current checks or reviews` accept the
    // foreign passed check and receive no refusals instead of its missing-current-check refusal.
    (observation) =>
      observation.checkId === checkId && observation.candidateIdentity === candidateIdentity,
  );
  // Proof: selecting the first current observation made
  // `later current evidence discharges a named check obligation monotonically` receive
  // `accepted: false` with `required check failed` instead of an accepted empty refusal set.
  return (
    matching.find((observation) => observation.status === 'passed') ??
    matching.find((observation) => observation.status === 'failed') ??
    matching.find((observation) => observation.status === 'skipped')
  );
}

function currentReview(
  evidence: readonly ReviewEvidence[],
  judgmentId: string,
  candidateIdentity: string,
): ReviewEvidence | undefined {
  const matching = evidence.filter(
    // Proof: dropping candidate identity from this match made
    // `foreign candidate observations cannot discharge current checks or reviews` lose its
    // missing expanded-review refusal because a foreign current review discharged it.
    (observation) =>
      observation.judgmentId === judgmentId && observation.candidateIdentity === candidateIdentity,
  );
  // Proof: selecting the first current review observation made
  // `missing impact classification expands review and refuses instead of defaulting` retain
  // `expanded review failed` after later current evidence instead of only its impact refusal.
  return (
    matching.find((observation) => observation.status === 'current') ??
    matching.find((observation) => observation.status === 'failed')
  );
}

function classificationBinds(
  classification: ImpactClassification,
  contentChange: ContentChange,
  reviewed: CurrencySnapshot,
  current: CurrencySnapshot,
): boolean {
  if (
    classification.reviewedSourceBase !== reviewed.sourceBase ||
    classification.currentSourceBase !== current.sourceBase ||
    classification.reviewedCandidateIdentity !== reviewed.candidateIdentity ||
    classification.currentCandidateIdentity !== current.candidateIdentity
  ) {
    return false;
  }
  switch (contentChange.change) {
    case 'added':
      // Proof: refusing all added bindings made
      // `requires behavior checks and exact impact classification for added content` gain an
      // impact refusal and missing expanded review beside its expected failed consumer check.
      return (
        classification.change === 'added' &&
        classification.currentIdentity === contentChange.current.blob
      );
    case 'changed':
      return (
        classification.change === 'changed' &&
        classification.reviewedIdentity === contentChange.reviewed.blob &&
        classification.currentIdentity === contentChange.current.blob
      );
    case 'removed':
      // Proof: refusing all removed bindings made
      // `requires behavior checks and exact impact classification for removed content` gain an
      // impact refusal and missing expanded review beside its expected failed consumer check.
      return (
        classification.change === 'removed' &&
        classification.reviewedIdentity === contentChange.reviewed.blob
      );
  }
}

/** Evaluates the finite review and behavior obligations selected for one exact candidate. */
export function evaluateObligations(input: unknown): ObligationReport {
  const request = decodeObligationRequest(input);
  const currency = classifyCurrency(request.reviewed, request.current, request.judgments);
  const behaviorRules = indexBehaviorRules(request.policy.behaviorRules);
  const requiredChecks = new Set<string>();
  const reviewKinds = new Map<string, Set<'expanded-review' | 'review'>>();
  const refusals: Refusal[] = [];

  for (const judgment of currency.judgments) {
    if (judgment.status !== 'stale') continue;
    reviewKinds.set(judgment.judgmentId, new Set(['review']));
  }

  for (const contentChange of currency.contentChanges) {
    const rule = behaviorRules.get(contentChange.inputId);
    if (rule === undefined) {
      // Proof: replacing this refusal with `continue` made the added, changed and removed
      // `content without a behavior rule` cases each receive `refusals: []` instead of their
      // exact `behavior-policy:content.child` refusal.
      refusals.push({
        obligationId: `behavior-policy:${contentChange.inputId}`,
        kind: 'behavior-policy',
        subjectId: contentChange.inputId,
        reason: 'changed implementation has no behavior obligation policy',
      });
      continue;
    }
    // Proof: deleting this selection made
    // `a same-type implementation change still requires its consumer and conformance checks`
    // receive `accepted: true` instead of `false` before it could reach its check assertions.
    // Proof: skipping it for a writer `implementation-only` label made
    // `a writer implementation-only label cannot waive behavior checks` receive no required
    // checks instead of `check.consumer`.
    for (const checkId of [...rule.consumerChecks, ...rule.conformanceChecks]) {
      requiredChecks.add(checkId);
    }
    const classifications = request.impactClassifications.filter(
      (candidate) => candidate.contentInputId === contentChange.inputId,
    );
    // Proof: omitting the current-candidate binding in `classificationBinds` made
    // `missing impact classification expands review and refuses instead of defaulting`
    // receive no refusals for a foreign candidate instead of its `does not bind` refusal.
    const exactClassifications = classifications.filter((candidate) =>
      classificationBinds(candidate, contentChange, request.reviewed, request.current),
    );
    // Proof: selecting the first classification made
    // `a same-type implementation change still requires its consumer and conformance checks`
    // retain `impact classification is unknown` and a missing expanded review after a later
    // exact known classification, instead of retaining only the failed consumer check.
    const classification =
      exactClassifications.find((candidate) => candidate.classification !== 'unknown') ??
      exactClassifications.at(0) ??
      classifications.at(0);
    const bindsChange =
      classification !== undefined &&
      classificationBinds(classification, contentChange, request.reviewed, request.current);
    // Proof: treating an absent classification as success made
    // `missing impact classification expands review and refuses instead of defaulting`
    // receive `accepted: true` instead of `false` at its first assertion.
    // Proof: treating a bound `unknown` classification as success made
    // `unknown impact remains a named refusal even when its expanded review is present`
    // receive `accepted: true` instead of `false` at its first assertion.
    if (!bindsChange || classification.classification === 'unknown') {
      refusals.push({
        obligationId: `impact-classification:${contentChange.inputId}`,
        kind: 'impact-classification',
        subjectId: contentChange.inputId,
        reason:
          classification === undefined
            ? 'impact classification is missing for the exact content change'
            : !bindsChange
              ? 'impact classification does not bind the exact content change'
              : 'impact classification is unknown for the exact content change',
      });
      for (const judgmentId of rule.expandedReviewJudgments) {
        const kinds = reviewKinds.get(judgmentId) ?? new Set<'expanded-review' | 'review'>();
        kinds.add('expanded-review');
        reviewKinds.set(judgmentId, kinds);
      }
    }
  }

  for (const checkId of requiredChecks) {
    const evidence = currentCheck(request.checks, checkId, request.current.candidateIdentity);
    // Proof: treating `skipped` as accepted made `refuses a skipped required check` receive
    // `refusals: []` instead of its exact `check:check.consumer` skipped-check refusal.
    if (evidence?.status !== 'passed') {
      refusals.push({
        obligationId: `check:${checkId}`,
        kind: 'check',
        subjectId: checkId,
        reason:
          evidence?.status === 'failed'
            ? 'required check failed for the current candidate'
            : evidence?.status === 'skipped'
              ? 'required check was skipped for the current candidate'
              : 'required check evidence is missing for the current candidate',
      });
    }
  }

  for (const [judgmentId, kinds] of reviewKinds) {
    const evidence = currentReview(request.reviews, judgmentId, request.current.candidateIdentity);
    // Proof: treating a failed review as acceptable made `refuses a failed stale review` receive
    // `refusals: []` and removed the exact expanded-review refusal from
    // `refuses a failed expanded review`, leaving only its independent impact refusal.
    if (evidence?.status !== 'current') {
      for (const kind of kinds) {
        refusals.push({
          obligationId: `${kind}:${judgmentId}`,
          kind,
          subjectId: judgmentId,
          reason:
            evidence?.status === 'failed'
              ? `${kind === 'review' ? 'stale' : 'expanded'} review failed for the current candidate`
              : `${kind === 'review' ? 'stale' : 'expanded'} review is missing for the current candidate`,
        });
      }
    }
  }

  return {
    policyId: request.policy.policyId,
    candidateIdentity: request.current.candidateIdentity,
    currency,
    writerLabels: [...request.writerLabels],
    requiredChecks: [...requiredChecks].sort(compareText),
    requiredReviews: [...reviewKinds.keys()].sort(compareText),
    refusals,
    accepted: refusals.length === 0,
  };
}
