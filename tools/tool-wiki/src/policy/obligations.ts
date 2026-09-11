import { Buffer } from 'node:buffer';

import {
  classifyCurrency,
  type CurrencyReport,
  type CurrencySnapshot,
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

export interface ImpactClassification {
  contentInputId: string;
  reviewedIdentity: string;
  currentIdentity: string | null;
  reviewedSourceBase: string;
  currentSourceBase: string;
  reviewedCandidateIdentity: string;
  currentCandidateIdentity: string;
  classification: 'behavior-changing' | 'behavior-preserving' | 'unknown';
  authority:
    | { kind: 'reviewed'; reviewIdentity: string }
    | { kind: 'declared'; declarationIdentity: string };
}

export interface WriterImpactLabel {
  contentInputId: string;
  label: 'implementation-only';
}

export interface CheckEvidence {
  checkId: string;
  candidateIdentity: string;
  status: 'failed' | 'passed' | 'skipped';
}

export interface ReviewEvidence {
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

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function currentCheck(
  evidence: readonly CheckEvidence[],
  checkId: string,
  candidateIdentity: string,
): CheckEvidence | undefined {
  const matching = evidence.filter(
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

/** Evaluates the finite review and behavior obligations selected for one exact candidate. */
export function evaluateObligations(request: ObligationRequest): ObligationReport {
  const currency = classifyCurrency(request.reviewed, request.current, request.judgments);
  const requiredChecks = new Set<string>();
  const reviewKinds = new Map<string, Set<'expanded-review' | 'review'>>();
  const refusals: Refusal[] = [];

  for (const judgment of currency.judgments) {
    if (judgment.status !== 'stale') continue;
    reviewKinds.set(judgment.judgmentId, new Set(['review']));
  }

  for (const contentChange of currency.contentChanges) {
    const rule = request.policy.behaviorRules.find(
      (candidate) => candidate.contentInputId === contentChange.inputId,
    );
    if (rule === undefined) {
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
    const currentIdentity = contentChange.current?.blob ?? null;
    const classifications = request.impactClassifications.filter(
      (candidate) => candidate.contentInputId === contentChange.inputId,
    );
    // Proof: omitting current-candidate bindings here and in `bindsChange` made
    // `missing impact classification expands review and refuses instead of defaulting`
    // receive no refusals for a foreign candidate instead of `does not bind`.
    const exactClassifications = classifications.filter(
      (candidate) =>
        candidate.reviewedIdentity === contentChange.reviewed.blob &&
        candidate.currentIdentity === currentIdentity &&
        candidate.reviewedSourceBase === request.reviewed.sourceBase &&
        candidate.currentSourceBase === request.current.sourceBase &&
        candidate.reviewedCandidateIdentity === request.reviewed.candidateIdentity &&
        candidate.currentCandidateIdentity === request.current.candidateIdentity,
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
      classification?.reviewedIdentity === contentChange.reviewed.blob &&
      classification.currentIdentity === currentIdentity &&
      classification.reviewedSourceBase === request.reviewed.sourceBase &&
      classification.currentSourceBase === request.current.sourceBase &&
      classification.reviewedCandidateIdentity === request.reviewed.candidateIdentity &&
      classification.currentCandidateIdentity === request.current.candidateIdentity;
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
