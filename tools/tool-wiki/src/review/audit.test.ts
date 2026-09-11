import { describe, expect, test } from 'bun:test';

import { hashBytes, hashCanonical } from '../evidence/content-manifest';
import { type AuditObligation, evaluateAudit, selectAudit } from './audit';
import type { ReviewEvidence } from './protocol';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const REVISION_A = '1'.repeat(40);

function obligations(): AuditObligation[] {
  return [
    {
      obligationId: 'review.file.alpha',
      riskStratum: 'risk.high',
      subject: {
        subjectId: 'subject.file.alpha',
        kind: 'file' as const,
        path: 'src/alpha.ts',
        contentIdentity: SHA_A,
      },
    },
    {
      obligationId: 'review.directory.src',
      riskStratum: 'risk.high',
      subject: {
        subjectId: 'subject.directory.src',
        kind: 'directory' as const,
        path: 'src',
        contentIdentity: SHA_A,
      },
    },
    {
      obligationId: 'review.project.tool-wiki',
      riskStratum: 'risk.standard',
      subject: {
        subjectId: 'subject.project.tool-wiki',
        kind: 'project' as const,
        path: 'tools/tool-wiki',
        contentIdentity: SHA_A,
      },
    },
    {
      obligationId: 'review.documentation.guide',
      riskStratum: 'risk.standard',
      subject: {
        subjectId: 'subject.documentation.guide',
        kind: 'documentation' as const,
        path: 'docs/guide.md',
        contentIdentity: SHA_A,
      },
    },
  ];
}

function selectionRequest() {
  return {
    schemaVersion: 1 as const,
    auditId: 'audit.repeatable',
    sourceBase: REVISION_A,
    candidateIdentity: SHA_A,
    generation: 3,
    seed: 'seed.repeatable',
    coverage: 'sampled' as const,
    strata: [
      { stratumId: 'risk.high', sampleRateBps: 500, disagreementTriggerBps: 1000 },
      { stratumId: 'risk.standard', sampleRateBps: 500, disagreementTriggerBps: 1000 },
    ],
    obligations: obligations(),
  };
}

type Obligation = AuditObligation;

function reviewEvidence(
  obligation: Obligation,
  reviewId: string,
  options: {
    impact?: 'yes' | 'partial' | 'no';
    contextIds?: string[];
    model?: string;
  } = {},
): ReviewEvidence {
  const invocationId = `invocation.${reviewId}`;
  const coldResponse = `cold ${reviewId}\n`;
  const informedResponse = `informed ${reviewId}\n`;
  const startedAt = '2026-09-11T07:00:00.000Z';
  const endedAt = '2026-09-11T07:00:01.000Z';
  const executor = {
    provider: 'openai',
    model: options.model ?? 'gpt-5',
    version: '2026-09-10',
    effort: 'high',
    toolchain: 'codex',
  };
  const priceIdentity = {
    priceId: 'price.review.v1',
    provider: 'openai',
    model: options.model ?? 'gpt-5',
    currency: 'USD',
    source: 'provider-receipt',
  };
  const phase = (name: 'cold' | 'informed', response: string, charge: number) => ({
    status: 'verified' as const,
    receipt: {
      schemaVersion: 1 as const,
      receiptKind: 'invocation' as const,
      receiptId: `receipt.${reviewId}.${name}`,
      invocationId,
      startedAt,
      endedAt,
      status: 'completed' as const,
      executor,
      rawUsage: [{ category: `${name}_tokens`, quantity: charge, unit: 'tokens' }],
      priceIdentity,
      chargedAmountMicros: charge,
      inputArtifact: SHA_A,
      outputArtifact: hashBytes(response),
    },
    elapsedReceipts: [
      {
        schemaVersion: 1 as const,
        receiptKind: 'elapsed' as const,
        receiptId: `elapsed.${reviewId}.${name}`,
        trialId: 'trial.audit',
        outcomeId: 'outcome.audit',
        attemptId: `attempt.${reviewId}.${name}`,
        phase: 'review' as const,
        startedAt,
        endedAt,
        elapsedMs: 1000,
        status: 'completed' as const,
      },
    ],
  });
  const cold = {
    sequence: 1 as const,
    judgments: {
      purpose: 'yes' as const,
      relationships: 'yes' as const,
      impact: 'partial' as const,
    },
    observedReadIds: [obligation.subject.contentIdentity],
  };
  const coldReceipt = phase('cold', coldResponse, 11);
  const informedReceipt = phase('informed', informedResponse, 14);
  const informedContextIds = options.contextIds ?? [];
  const rawUsage = [...coldReceipt.receipt.rawUsage, ...informedReceipt.receipt.rawUsage];
  return {
    schemaVersion: 1,
    receipt: {
      schemaVersion: 1,
      receiptKind: 'review',
      receiptId: `review-receipt.${reviewId}`,
      invocationId,
      executor,
      suppliedContextIds: [SHA_B, obligation.subject.contentIdentity, ...informedContextIds],
      observedReadIds: [
        ...cold.observedReadIds,
        obligation.subject.contentIdentity,
        ...informedContextIds,
      ],
      rawResponseArtifact: hashBytes(informedResponse),
      rawUsage,
      priceIdentity,
      trust: { scope: 'local-cooperative', journalId: 'journal.audit' },
    },
    protocolEvidence: {
      schemaVersion: 1,
      protocol: { protocolId: 'review.cold-informed.v1', protocolBlob: SHA_B },
      subject: obligation.subject,
      cold,
      expansion: {
        sequence: 2,
        coldJudgmentArtifact: hashCanonical(cold),
        suppliedContextIds: informedContextIds,
      },
      informed: {
        sequence: 3,
        judgments: {
          purpose: 'yes',
          relationships: 'yes',
          impact: options.impact ?? 'yes',
        },
        observedReadIds: [obligation.subject.contentIdentity, ...informedContextIds],
      },
    },
    phaseReceipts: { cold: coldReceipt, informed: informedReceipt },
    phaseTools: {
      cold: [{ toolId: 'read-file', version: '1' }],
      informed: [{ toolId: 'run-check', version: '1' }],
    },
    actualTools: [
      { toolId: 'read-file', version: '1' },
      { toolId: 'run-check', version: '1' },
    ],
    rawResponse: {
      artifact: hashBytes(informedResponse),
      retention: { kind: 'journal-inline' },
    },
  };
}

function review(
  obligation: Obligation,
  reviewId: string,
  options: Parameters<typeof reviewEvidence>[2] = {},
) {
  return {
    reviewId,
    obligationId: obligation.obligationId,
    sourceBase: REVISION_A,
    candidateIdentity: SHA_A,
    generation: 3,
    reviewRound: 1,
    recordedAt: '2026-09-11T07:01:00.000Z',
    evidence: reviewEvidence(obligation, reviewId, options),
    findings: [],
  };
}

function requireReview<Review extends { reviewId: string }>(
  reviews: Review[],
  reviewId: string,
): Review {
  const found = reviews.find((candidate) => candidate.reviewId === reviewId);
  if (found === undefined) throw new Error(`missing fixture review ${reviewId}`);
  return found;
}

describe('review audit selection', () => {
  test('the same seed selects the exact same risk-stratified sample independent of input order', () => {
    const request = selectionRequest();
    const first = selectAudit(request);
    const repeated = selectAudit({
      ...request,
      strata: [...request.strata].reverse(),
      obligations: [...request.obligations].reverse(),
    });

    expect(repeated).toEqual(first);
    expect(first.strata).toEqual([
      {
        stratumId: 'risk.high',
        populationSize: 2,
        sampleSize: 1,
        obligationIds: ['review.directory.src'],
      },
      {
        stratumId: 'risk.standard',
        populationSize: 2,
        sampleSize: 1,
        obligationIds: ['review.project.tool-wiki'],
      },
    ]);
    expect(first.obligationIds).toEqual(['review.directory.src', 'review.project.tool-wiki']);
    expect(
      first.obligationIds.map(
        (obligationId) =>
          request.obligations.find((obligation) => obligation.obligationId === obligationId)
            ?.subject.kind,
      ),
    ).toEqual(['directory', 'project']);
  });

  test('the selection boundary rejects duplicate identities, unknown strata, and noncanonical input', () => {
    const request = selectionRequest();
    expect(() =>
      selectAudit({
        ...request,
        obligations: [
          ...request.obligations,
          {
            ...request.obligations[0],
            subject: {
              ...request.obligations[0].subject,
              subjectId: 'subject.duplicate-obligation',
            },
          },
        ],
      }),
    ).toThrow('duplicate audit obligation');
    expect(() =>
      selectAudit({
        ...request,
        obligations: [
          ...request.obligations,
          { ...request.obligations[0], obligationId: 'review.file.duplicate-subject' },
        ],
      }),
    ).toThrow('duplicate audit obligation subject');
    expect(() =>
      selectAudit({ ...request, strata: [...request.strata, request.strata[0]] }),
    ).toThrow('duplicate audit stratum');
    expect(() =>
      selectAudit({
        ...request,
        strata: [
          ...request.strata,
          { stratumId: 'risk.empty', sampleRateBps: 500, disagreementTriggerBps: 1000 },
        ],
      }),
    ).toThrow('audit stratum has no population');
    expect(() =>
      selectAudit({
        ...request,
        obligations: [
          { ...request.obligations[0], riskStratum: 'risk.unknown' },
          ...request.obligations.slice(1),
        ],
      }),
    ).toThrow('unknown risk stratum');
    expect(() => selectAudit({ ...request, unexpected: true })).toThrow();
    expect(() =>
      selectAudit({
        ...request,
        strata: [{ ...request.strata[0], sampleRateBps: -0 }, request.strata[1]],
      }),
    ).toThrow('negative zero');
    const nonPlainRequest = { ...request };
    Object.setPrototypeOf(nonPlainRequest, { inherited: true });
    expect(() => selectAudit(nonPlainRequest)).toThrow(
      'canonical JSON requires a plain JSON object',
    );
  });
});

describe('review audit obligations', () => {
  test('enforcement names every missing sampled review without failing unsampled obligations', () => {
    const selection = selectionRequest();
    const report = evaluateAudit({
      ...selection,
      mode: 'enforce',
      claimedCoverage: 'sampled',
      reviews: [],
      corrections: [],
      closures: [],
      adjudications: [],
    });

    expect(report.accepted).toBe(false);
    expect(report.requiredObligationIds).toEqual([
      'review.directory.src',
      'review.project.tool-wiki',
    ]);
    expect(report.unmetObligationIds).toEqual(['review.directory.src', 'review.project.tool-wiki']);
    expect(report.refusals).toEqual([
      {
        obligationId: 'review.directory.src',
        kind: 'review',
        reason: 'required review is missing for the exact candidate and generation',
      },
      {
        obligationId: 'review.project.tool-wiki',
        kind: 'review',
        reason: 'required review is missing for the exact candidate and generation',
      },
    ]);
    expect(report.unreviewedObligationIds).toEqual([
      'review.directory.src',
      'review.documentation.guide',
      'review.file.alpha',
      'review.project.tool-wiki',
    ]);
  });

  test('current reviews discharge only the selected sample and leave the rest explicitly unreviewed', () => {
    const selection = selectionRequest();
    const selected = selectAudit(selection).obligationIds.map((obligationId, index) => {
      const obligation = selection.obligations.find(
        (candidate) => candidate.obligationId === obligationId,
      );
      if (obligation === undefined) throw new Error(`missing fixture obligation ${obligationId}`);
      return review(obligation, `review.selected.${String(index)}`);
    });
    const report = evaluateAudit({
      ...selection,
      mode: 'enforce',
      claimedCoverage: 'sampled',
      reviews: selected,
      corrections: [],
      closures: [],
      adjudications: [],
    });

    expect(report).toMatchObject({ accepted: true, refusals: [], unmetObligationIds: [] });
    expect(report.unreviewedObligationIds).toEqual([
      'review.documentation.guide',
      'review.file.alpha',
    ]);
  });

  test('failed, censored, or unverified phase evidence cannot discharge review coverage', () => {
    const selection = selectionRequest();
    const directory = selection.obligations[1];
    const project = selection.obligations[2];
    const failedCold = review(directory, 'review.incomplete.failed-cold');
    failedCold.evidence.phaseReceipts.cold.receipt.status = 'failed';
    const censoredInformed = review(project, 'review.incomplete.censored-informed');
    censoredInformed.evidence.phaseReceipts.informed.receipt.status = 'censored';
    const envelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [failedCold, censoredInformed],
      corrections: [],
      closures: [],
      adjudications: [],
    };
    const report = evaluateAudit(envelope);

    expect(report.unmetObligationIds).toEqual(['review.directory.src', 'review.project.tool-wiki']);
    expect(report.unreviewedObligationIds).toContain('review.directory.src');
    expect(report.unreviewedObligationIds).toContain('review.project.tool-wiki');
    expect(report.costs.currencyCharges).toEqual([{ currency: 'USD', chargedAmountMicros: 50 }]);
    expect(report.costs.reviews).toHaveLength(2);

    const verified = review(directory, 'review.incomplete.unverified');
    const unverified = {
      ...verified,
      evidence: {
        ...verified.evidence,
        phaseReceipts: {
          ...verified.evidence.phaseReceipts,
          cold: {
            status: 'unverified' as const,
            reason: 'provider usage unavailable',
            missingRequirements: ['usage'],
            observed: {},
          },
        },
      },
    };
    expect(() => evaluateAudit({ ...envelope, reviews: [unverified] })).toThrow();

    const completed = review(directory, 'review.incomplete.completed', { impact: 'yes' });
    const failedConflict = review(directory, 'review.incomplete.failed-conflict', {
      impact: 'no',
    });
    failedConflict.evidence.phaseReceipts.cold.receipt.status = 'failed';
    const mixedReport = evaluateAudit({
      ...envelope,
      reviews: [completed, failedConflict, review(project, 'review.incomplete.project')],
    });
    expect(mixedReport).toMatchObject({
      accepted: true,
      adjudicationObligationIds: [],
      unmetObligationIds: [],
    });
    expect(mixedReport.costs.reviews).toHaveLength(3);
  });

  test('sampled evidence is rejected explicitly when it claims exhaustive coverage', () => {
    const selection = selectionRequest();
    const selected = selectAudit(selection).obligationIds.map((obligationId, index) => {
      const obligation = selection.obligations.find(
        (candidate) => candidate.obligationId === obligationId,
      );
      if (obligation === undefined) throw new Error(`missing fixture obligation ${obligationId}`);
      return review(obligation, `review.exhaustive.${String(index)}`);
    });
    const report = evaluateAudit({
      ...selection,
      mode: 'enforce',
      claimedCoverage: 'exhaustive',
      reviews: selected,
      corrections: [],
      closures: [],
      adjudications: [],
    });

    expect(report.accepted).toBe(false);
    expect(report.requiredObligationIds).toEqual([
      'review.directory.src',
      'review.documentation.guide',
      'review.file.alpha',
      'review.project.tool-wiki',
    ]);
    expect(report.refusals).toContainEqual({
      obligationId: 'coverage.exhaustive',
      kind: 'coverage',
      reason: 'sampled selection cannot establish exhaustive coverage',
    });
    expect(report.unmetObligationIds).toEqual([
      'coverage.exhaustive',
      'review.documentation.guide',
      'review.file.alpha',
    ]);
  });

  test('disagreement requires named adjudication and a fresh review of the whole risk shard', () => {
    const selection = selectionRequest();
    const disputed = selection.obligations[1];
    const standard = selection.obligations[2];
    const report = evaluateAudit({
      ...selection,
      mode: 'enforce',
      claimedCoverage: 'sampled',
      reviews: [
        review(disputed, 'review.dispute.yes', { impact: 'yes', contextIds: [SHA_B] }),
        review(disputed, 'review.dispute.no', { impact: 'no', contextIds: [SHA_B] }),
        review(standard, 'review.standard'),
      ],
      corrections: [],
      closures: [],
      adjudications: [],
    });

    expect(report.adjudicationObligationIds).toEqual(['review.directory.src']);
    expect(report.freshReviewObligationIds).toEqual(['review.directory.src', 'review.file.alpha']);
    expect(report.unmetObligationIds).toEqual([
      'adjudicate:review.directory.src',
      'fresh-review:review.directory.src',
      'fresh-review:review.file.alpha',
    ]);
    expect(report.overlaps).toContainEqual({
      leftReviewId: 'review.dispute.no',
      rightReviewId: 'review.dispute.yes',
      sameModel: true,
      sameExecutor: true,
      sharedContextIds: [SHA_A, SHA_B],
      sharedReadIds: [SHA_A, SHA_B],
    });
    expect(report.accepted).toBe(false);
  });

  test('a threshold can limit shard breadth but cannot suppress disputed-obligation duties', () => {
    const selection = selectionRequest();
    selection.strata[0].sampleRateBps = 10000;
    selection.strata[0].disagreementTriggerBps = 10000;
    const report = evaluateAudit({
      ...selection,
      mode: 'enforce',
      claimedCoverage: 'sampled',
      reviews: [
        review(selection.obligations[0], 'review.threshold.file'),
        review(selection.obligations[1], 'review.threshold.yes', { impact: 'yes' }),
        review(selection.obligations[1], 'review.threshold.no', { impact: 'no' }),
        review(selection.obligations[2], 'review.threshold.project'),
      ],
      corrections: [],
      closures: [],
      adjudications: [],
    });

    expect(report.adjudicationObligationIds).toEqual(['review.directory.src']);
    expect(report.freshReviewObligationIds).toEqual(['review.directory.src']);
    expect(report.unmetObligationIds).toEqual([
      'adjudicate:review.directory.src',
      'fresh-review:review.directory.src',
    ]);
  });

  test('a later-round disagreement cannot hide behind an agreeing first round', () => {
    const selection = selectionRequest();
    selection.strata[0].sampleRateBps = 10000;
    selection.strata[0].disagreementTriggerBps = 10000;
    const directory = selection.obligations[1];
    const roundOne = review(directory, 'review.later.round-one', { impact: 'yes' });
    const roundTwoYes = {
      ...review(directory, 'review.later.round-two-yes', { impact: 'yes' }),
      reviewRound: 2,
    };
    const roundTwoNo = {
      ...review(directory, 'review.later.round-two-no', { impact: 'no' }),
      reviewRound: 2,
    };
    const report = evaluateAudit({
      ...selection,
      mode: 'enforce',
      claimedCoverage: 'sampled',
      reviews: [
        review(selection.obligations[0], 'review.later.file'),
        roundOne,
        roundTwoYes,
        roundTwoNo,
        review(selection.obligations[2], 'review.later.project'),
      ],
      corrections: [],
      closures: [],
      adjudications: [],
    });

    expect(report.adjudicationObligationIds).toEqual(['review.directory.src']);
    expect(report.unmetObligationIds).toEqual([
      'adjudicate:review.directory.src',
      'fresh-review:review.directory.src',
    ]);
    expect(report.accepted).toBe(false);

    const fresh = {
      ...review(directory, 'review.later.fresh', { impact: 'yes' }),
      reviewRound: 3,
    };
    const adjudication = {
      adjudicationId: 'adjudication.later',
      obligationId: directory.obligationId,
      candidateIdentity: SHA_A,
      generation: 3,
      reviewRound: 2,
      reviewIds: [roundTwoYes.reviewId, roundTwoNo.reviewId],
      freshReviewIds: [fresh.reviewId],
      sourceEvidence: [
        {
          evidenceId: 'adjudication-source.later',
          subjectId: directory.subject.subjectId,
          contentIdentity: SHA_A,
          candidateIdentity: SHA_A,
          generation: 3,
        },
      ],
      checkEvidence: [
        {
          evidenceId: 'adjudication-check.later',
          checkId: 'check.adjudication.later',
          candidateIdentity: SHA_A,
          generation: 3,
          status: 'passed' as const,
        },
      ],
    };
    const resolvedEnvelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [
        review(selection.obligations[0], 'review.later.resolved-file'),
        roundOne,
        roundTwoYes,
        roundTwoNo,
        fresh,
        review(selection.obligations[2], 'review.later.resolved-project'),
      ],
      corrections: [],
      closures: [],
      adjudications: [adjudication],
    };

    expect(evaluateAudit(resolvedEnvelope)).toMatchObject({ accepted: true, refusals: [] });
    const wrongRound = structuredClone(resolvedEnvelope);
    wrongRound.adjudications[0].reviewRound = 1;
    expect(evaluateAudit(wrongRound).unmetObligationIds).toEqual([
      'adjudicate:review.directory.src',
      'fresh-review:review.directory.src',
    ]);
    const wrongReviews = structuredClone(resolvedEnvelope);
    wrongReviews.adjudications[0].reviewIds = [roundOne.reviewId];
    expect(evaluateAudit(wrongReviews).unmetObligationIds).toEqual([
      'adjudicate:review.directory.src',
      'fresh-review:review.directory.src',
    ]);

    const repeatedDisagreement = structuredClone(resolvedEnvelope);
    repeatedDisagreement.reviews.push(
      {
        ...review(directory, 'review.later.round-four-yes', { impact: 'yes' }),
        reviewRound: 4,
      },
      {
        ...review(directory, 'review.later.round-four-no', { impact: 'no' }),
        reviewRound: 4,
      },
    );
    expect(evaluateAudit(repeatedDisagreement).unmetObligationIds).toEqual([
      'adjudicate:review.directory.src',
      'fresh-review:review.directory.src',
    ]);
  });

  test('source-based adjudication and distinct later reviews discharge disagreement duties', () => {
    const selection = selectionRequest();
    const directory = selection.obligations[1];
    const file = selection.obligations[0];
    const project = selection.obligations[2];
    const yes = review(directory, 'review.adjudication.yes', { impact: 'yes' });
    const no = review(directory, 'review.adjudication.no', { impact: 'no' });
    const freshDirectory = {
      ...review(directory, 'review.adjudication.fresh-directory'),
      reviewRound: 2,
    };
    const freshFile = { ...review(file, 'review.adjudication.fresh-file'), reviewRound: 2 };
    const adjudicationEnvelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [yes, no, freshDirectory, freshFile, review(project, 'review.adjudication.project')],
      corrections: [],
      closures: [],
      adjudications: [
        {
          adjudicationId: 'adjudication.directory',
          obligationId: directory.obligationId,
          candidateIdentity: SHA_A,
          generation: 3,
          reviewRound: 1,
          reviewIds: [yes.reviewId, no.reviewId],
          freshReviewIds: [freshDirectory.reviewId, freshFile.reviewId],
          sourceEvidence: [
            {
              evidenceId: 'adjudication-source.directory',
              subjectId: directory.subject.subjectId,
              contentIdentity: SHA_A,
              candidateIdentity: SHA_A,
              generation: 3,
            },
          ],
          checkEvidence: [
            {
              evidenceId: 'adjudication-check.directory',
              checkId: 'check.adjudication.directory',
              candidateIdentity: SHA_A,
              generation: 3,
              status: 'passed',
            },
          ],
        },
      ],
    };
    const report = evaluateAudit(adjudicationEnvelope);

    expect(report.adjudicationObligationIds).toEqual(['review.directory.src']);
    expect(report.freshReviewObligationIds).toEqual(['review.directory.src', 'review.file.alpha']);
    expect(report.unmetObligationIds).toEqual([]);
    expect(report.accepted).toBe(true);
    const withoutSource = structuredClone(adjudicationEnvelope);
    withoutSource.adjudications[0].sourceEvidence = [];
    expect(evaluateAudit(withoutSource).unmetObligationIds).toContain(
      'adjudicate:review.directory.src',
    );
    const withoutCheck = structuredClone(adjudicationEnvelope);
    withoutCheck.adjudications[0].checkEvidence = [];
    expect(evaluateAudit(withoutCheck).unmetObligationIds).toContain(
      'adjudicate:review.directory.src',
    );
    const reusedInitial = structuredClone(adjudicationEnvelope);
    reusedInitial.adjudications[0].freshReviewIds = [yes.reviewId];
    expect(evaluateAudit(reusedInitial).unmetObligationIds).toContain(
      'fresh-review:review.directory.src',
    );
    const failedFreshDirectory = structuredClone(adjudicationEnvelope);
    requireReview(
      failedFreshDirectory.reviews,
      freshDirectory.reviewId,
    ).evidence.phaseReceipts.cold.receipt.status = 'failed';
    expect(evaluateAudit(failedFreshDirectory).unmetObligationIds).toContain(
      'fresh-review:review.directory.src',
    );
    const censoredFreshFile = structuredClone(adjudicationEnvelope);
    requireReview(
      censoredFreshFile.reviews,
      freshFile.reviewId,
    ).evidence.phaseReceipts.informed.receipt.status = 'censored';
    expect(evaluateAudit(censoredFreshFile).unmetObligationIds).toContain(
      'fresh-review:review.file.alpha',
    );
    const duplicateAdjudication = structuredClone(adjudicationEnvelope);
    duplicateAdjudication.adjudications.push(duplicateAdjudication.adjudications[0]);
    expect(() => evaluateAudit(duplicateAdjudication)).toThrow('duplicate audit adjudication');
    const duplicateAdjudicationRound = structuredClone(adjudicationEnvelope);
    duplicateAdjudicationRound.adjudications.push({
      ...duplicateAdjudicationRound.adjudications[0],
      adjudicationId: 'adjudication.directory.duplicate-round',
    });
    expect(() => evaluateAudit(duplicateAdjudicationRound)).toThrow(
      'duplicate audit adjudication round',
    );
    const duplicateAdjudicationReview = structuredClone(adjudicationEnvelope);
    duplicateAdjudicationReview.adjudications[0].reviewIds.push(yes.reviewId);
    expect(() => evaluateAudit(duplicateAdjudicationReview)).toThrow(
      'duplicate adjudication review',
    );
    const duplicateFreshReview = structuredClone(adjudicationEnvelope);
    duplicateFreshReview.adjudications[0].freshReviewIds.push(freshDirectory.reviewId);
    expect(() => evaluateAudit(duplicateFreshReview)).toThrow(
      'duplicate adjudication fresh review',
    );
    const duplicateAdjudicationSource = structuredClone(adjudicationEnvelope);
    duplicateAdjudicationSource.adjudications[0].sourceEvidence.push(
      duplicateAdjudicationSource.adjudications[0].sourceEvidence[0],
    );
    expect(() => evaluateAudit(duplicateAdjudicationSource)).toThrow(
      'duplicate adjudication source evidence',
    );
    const duplicateAdjudicationCheck = structuredClone(adjudicationEnvelope);
    duplicateAdjudicationCheck.adjudications[0].checkEvidence.push(
      duplicateAdjudicationCheck.adjudications[0].checkEvidence[0],
    );
    expect(() => evaluateAudit(duplicateAdjudicationCheck)).toThrow(
      'duplicate adjudication check evidence',
    );
    const missingRound = structuredClone(adjudicationEnvelope);
    delete (missingRound.adjudications[0] as { reviewRound?: number }).reviewRound;
    expect(() => evaluateAudit(missingRound)).toThrow('reviewRound');
  });

  test('cost accounting preserves both phase receipts, raw usage, reads, and local trust', () => {
    const selection = selectionRequest();
    const reviews = selectAudit(selection).obligationIds.map((obligationId, index) => {
      const obligation = selection.obligations.find(
        (candidate) => candidate.obligationId === obligationId,
      );
      if (obligation === undefined) throw new Error(`missing fixture obligation ${obligationId}`);
      return review(obligation, `review.cost.${String(index)}`);
    });
    const report = evaluateAudit({
      ...selection,
      mode: 'enforce',
      claimedCoverage: 'sampled',
      reviews,
      corrections: [],
      closures: [],
      adjudications: [],
    });

    expect(report.costs.currencyCharges).toEqual([{ currency: 'USD', chargedAmountMicros: 50 }]);
    expect(report.costs.totalElapsedMs).toBe(4000);
    expect(report.costs.reviews).toHaveLength(2);
    expect(report.costs.reviews.every((cost) => cost.trustScope === 'local-cooperative')).toBe(
      true,
    );
    expect(report.costs.rawUsage).toHaveLength(4);
    expect(report.costs.readObservations).toHaveLength(4);
    expect(report.costs.reviews[0]?.phaseReceipts).toEqual(reviews[0]?.evidence.phaseReceipts);
  });

  test('cost accounting keeps native currencies and canonicalizes currency totals', () => {
    const selection = selectionRequest();
    const directoryReview = review(selection.obligations[1], 'review.cost.a-usd');
    const projectReview = review(selection.obligations[2], 'review.cost.z-eur');
    const euroPrice = {
      ...projectReview.evidence.receipt.priceIdentity,
      priceId: 'price.review.eur.v1',
      currency: 'EUR',
    };
    projectReview.evidence.receipt.priceIdentity = euroPrice;
    projectReview.evidence.phaseReceipts.cold.receipt.priceIdentity = euroPrice;
    projectReview.evidence.phaseReceipts.informed.receipt.priceIdentity = euroPrice;
    const envelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [directoryReview, projectReview],
      corrections: [],
      closures: [],
      adjudications: [],
    };

    const report = evaluateAudit(envelope);
    expect(report.costs.currencyCharges).toEqual([
      { currency: 'EUR', chargedAmountMicros: 25 },
      { currency: 'USD', chargedAmountMicros: 25 },
    ]);
    expect(evaluateAudit({ ...envelope, reviews: [...envelope.reviews].reverse() })).toEqual(
      report,
    );
    const euroCost = report.costs.reviews.find(({ reviewId }) => reviewId === 'review.cost.z-eur');
    expect(euroCost?.reviewReceipt.priceIdentity).toEqual(euroPrice);
    expect(euroCost?.phaseReceipts.cold.receipt.priceIdentity).toEqual(euroPrice);
    expect(euroCost?.phaseReceipts.informed.receipt.priceIdentity).toEqual(euroPrice);
  });

  test('price, usage, charge, and elapsed receipt identities cannot be reused', () => {
    const selection = selectionRequest();
    const directoryReview = review(selection.obligations[1], 'review.receipt.directory');
    const projectReview = review(selection.obligations[2], 'review.receipt.project');
    const envelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [directoryReview, projectReview],
      corrections: [],
      closures: [],
      adjudications: [],
    };

    const reusedPhase = structuredClone(envelope);
    reusedPhase.reviews[0].evidence.phaseReceipts.cold.receipt.chargedAmountMicros = 0;
    reusedPhase.reviews[0].evidence.phaseReceipts.informed.receipt.chargedAmountMicros = 0;
    reusedPhase.reviews[0].evidence.phaseReceipts.informed.receipt.receiptId =
      reusedPhase.reviews[0].evidence.phaseReceipts.cold.receipt.receiptId;
    expect(() => evaluateAudit(reusedPhase)).toThrow('duplicate audit receipt');

    const reusedPhaseAcrossReviews = structuredClone(envelope);
    reusedPhaseAcrossReviews.reviews[1].evidence.phaseReceipts.cold.receipt.receiptId =
      reusedPhaseAcrossReviews.reviews[0].evidence.phaseReceipts.informed.receipt.receiptId;
    expect(() => evaluateAudit(reusedPhaseAcrossReviews)).toThrow('duplicate audit receipt');

    const reusedReviewReceipt = structuredClone(envelope);
    reusedReviewReceipt.reviews[1].evidence.receipt.receiptId =
      reusedReviewReceipt.reviews[0].evidence.receipt.receiptId;
    expect(() => evaluateAudit(reusedReviewReceipt)).toThrow('duplicate audit receipt');

    const reusedElapsed = structuredClone(envelope);
    reusedElapsed.reviews[1].evidence.phaseReceipts.informed.elapsedReceipts[0].receiptId =
      reusedElapsed.reviews[0].evidence.phaseReceipts.cold.elapsedReceipts[0].receiptId;
    expect(() => evaluateAudit(reusedElapsed)).toThrow('duplicate audit receipt');

    const reusedAcrossKinds = structuredClone(envelope);
    reusedAcrossKinds.reviews[1].evidence.phaseReceipts.informed.elapsedReceipts[0].receiptId =
      reusedAcrossKinds.reviews[0].evidence.receipt.receiptId;
    expect(() => evaluateAudit(reusedAcrossKinds)).toThrow('duplicate audit receipt');
  });

  test('receipt summaries cannot hide authoritative protocol context and reads', () => {
    const selection = selectionRequest();
    const directory = selection.obligations[1];
    const project = selection.obligations[2];
    const directoryReview = review(directory, 'review.summary.directory', {
      contextIds: [SHA_B],
    });
    const projectReview = review(project, 'review.summary.project', { contextIds: [SHA_B] });
    const envelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [directoryReview, projectReview],
      corrections: [],
      closures: [],
      adjudications: [],
    };
    expect(evaluateAudit(envelope).overlaps).toContainEqual({
      leftReviewId: 'review.summary.directory',
      rightReviewId: 'review.summary.project',
      sameModel: true,
      sameExecutor: true,
      sharedContextIds: [SHA_A, SHA_B],
      sharedReadIds: [SHA_A, SHA_B],
    });

    const hiddenContext = structuredClone(envelope);
    hiddenContext.reviews[0].evidence.receipt.suppliedContextIds = [];
    expect(() => evaluateAudit(hiddenContext)).toThrow('does not summarize supplied context');
    const hiddenReads = structuredClone(envelope);
    hiddenReads.reviews[0].evidence.receipt.observedReadIds = [];
    expect(() => evaluateAudit(hiddenReads)).toThrow('does not summarize observed reads');
  });

  test('duplicated receipt summaries cannot inflate authoritative overlap', () => {
    const selection = selectionRequest();
    const directoryReview = review(selection.obligations[1], 'review.summary.duplicate-directory');
    const projectReview = review(selection.obligations[2], 'review.summary.duplicate-project');
    const envelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [directoryReview, projectReview],
      corrections: [],
      closures: [],
      adjudications: [],
    };

    const duplicatedContext = structuredClone(envelope);
    duplicatedContext.reviews[0].evidence.receipt.suppliedContextIds.push(SHA_A);
    expect(() => evaluateAudit(duplicatedContext)).toThrow('does not summarize supplied context');
    const duplicatedReads = structuredClone(envelope);
    duplicatedReads.reviews[0].evidence.receipt.observedReadIds.push(SHA_A);
    expect(() => evaluateAudit(duplicatedReads)).toThrow('does not summarize observed reads');
  });

  test('cost aggregation rejects arithmetic beyond the safe integer boundary', () => {
    const selection = selectionRequest();
    const obligation = selection.obligations[1];
    const costly = review(obligation, 'review.cost.overflow');
    costly.evidence.phaseReceipts.cold.receipt.chargedAmountMicros = Number.MAX_SAFE_INTEGER;

    expect(() =>
      evaluateAudit({
        ...selection,
        mode: 'observe',
        claimedCoverage: 'sampled',
        reviews: [costly],
        corrections: [],
        closures: [],
        adjudications: [],
      }),
    ).toThrow('audit cost total is not a safe integer');
  });

  test('a finding closes only with owned current evidence and a fresh post-correction review', () => {
    const selection = selectionRequest();
    const directory = selection.obligations[1];
    const project = selection.obligations[2];
    const priorSubject = {
      ...directory,
      subject: { ...directory.subject, contentIdentity: SHA_B },
    };
    const opening = {
      ...review(priorSubject, 'review.opening'),
      candidateIdentity: SHA_B,
      generation: 2,
      findings: [
        { findingId: 'finding.alpha', severity: 'important' as const, summary: 'fix alpha' },
      ],
    };
    const corrected = { ...review(directory, 'review.corrected'), reviewRound: 2 };
    const correction = {
      correctionId: 'correction.alpha',
      findingId: 'finding.alpha',
      ownerId: 'owner.alpha',
      obligationId: directory.obligationId,
      fromReviewId: opening.reviewId,
      fromCandidateIdentity: SHA_B,
      fromGeneration: 2,
      candidateIdentity: SHA_A,
      generation: 3,
      sourceEvidence: [
        {
          evidenceId: 'source.alpha',
          subjectId: directory.subject.subjectId,
          contentIdentity: SHA_A,
          candidateIdentity: SHA_A,
          generation: 3,
        },
      ],
      checkEvidence: [
        {
          evidenceId: 'check-evidence.alpha',
          checkId: 'check.alpha',
          candidateIdentity: SHA_A,
          generation: 3,
          status: 'passed' as const,
        },
      ],
    };
    const closure = {
      closureId: 'closure.alpha',
      findingId: 'finding.alpha',
      correctionId: correction.correctionId,
      postCorrectionReviewId: corrected.reviewId,
    };
    const closureEnvelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [opening, corrected, review(project, 'review.closure.project')],
      corrections: [correction],
      closures: [closure],
      adjudications: [],
    };
    const report = evaluateAudit(closureEnvelope);

    expect(report.unresolvedFindingIds).toEqual([]);
    expect(report.accepted).toBe(true);
    const withoutSource = structuredClone(closureEnvelope);
    withoutSource.corrections[0].sourceEvidence = [];
    expect(evaluateAudit(withoutSource).unresolvedFindingIds).toEqual(['finding.alpha']);
    const withoutCheck = structuredClone(closureEnvelope);
    withoutCheck.corrections[0].checkEvidence = [];
    expect(evaluateAudit(withoutCheck).unresolvedFindingIds).toEqual(['finding.alpha']);
    const foreignSource = structuredClone(closureEnvelope);
    foreignSource.corrections[0].sourceEvidence[0].contentIdentity = SHA_B;
    expect(evaluateAudit(foreignSource).unresolvedFindingIds).toEqual(['finding.alpha']);
    const foreignOpening = structuredClone(closureEnvelope);
    foreignOpening.corrections[0].fromReviewId = corrected.reviewId;
    expect(evaluateAudit(foreignOpening).unresolvedFindingIds).toEqual(['finding.alpha']);
    const reusedOpening = structuredClone(closureEnvelope);
    reusedOpening.closures[0].postCorrectionReviewId = opening.reviewId;
    expect(evaluateAudit(reusedOpening).unresolvedFindingIds).toEqual(['finding.alpha']);
    const failedPostCorrection = structuredClone(closureEnvelope);
    requireReview(
      failedPostCorrection.reviews,
      corrected.reviewId,
    ).evidence.phaseReceipts.cold.receipt.status = 'failed';
    expect(evaluateAudit(failedPostCorrection).unresolvedFindingIds).toEqual(['finding.alpha']);
    const censoredPostCorrection = structuredClone(closureEnvelope);
    requireReview(
      censoredPostCorrection.reviews,
      corrected.reviewId,
    ).evidence.phaseReceipts.informed.receipt.status = 'censored';
    expect(evaluateAudit(censoredPostCorrection).unresolvedFindingIds).toEqual(['finding.alpha']);
    const duplicateCorrection = structuredClone(closureEnvelope);
    duplicateCorrection.corrections.push(duplicateCorrection.corrections[0]);
    expect(() => evaluateAudit(duplicateCorrection)).toThrow('duplicate audit correction');
    const duplicateCorrectionSource = structuredClone(closureEnvelope);
    duplicateCorrectionSource.corrections[0].sourceEvidence.push(
      duplicateCorrectionSource.corrections[0].sourceEvidence[0],
    );
    expect(() => evaluateAudit(duplicateCorrectionSource)).toThrow(
      'duplicate correction source evidence',
    );
    const duplicateCorrectionCheck = structuredClone(closureEnvelope);
    duplicateCorrectionCheck.corrections[0].checkEvidence.push(
      duplicateCorrectionCheck.corrections[0].checkEvidence[0],
    );
    expect(() => evaluateAudit(duplicateCorrectionCheck)).toThrow(
      'duplicate correction check evidence',
    );
    const duplicateClosure = structuredClone(closureEnvelope);
    duplicateClosure.closures.push({
      ...duplicateClosure.closures[0],
      findingId: 'finding.other',
    });
    expect(() => evaluateAudit(duplicateClosure)).toThrow('duplicate audit closure');
    const duplicateFindingClosure = structuredClone(closureEnvelope);
    duplicateFindingClosure.closures.push({
      ...duplicateFindingClosure.closures[0],
      closureId: 'closure.alpha.duplicate',
    });
    expect(() => evaluateAudit(duplicateFindingClosure)).toThrow('duplicate audit closure finding');
    const duplicateFinding = structuredClone(closureEnvelope);
    duplicateFinding.reviews[1].findings.push(duplicateFinding.reviews[0].findings[0]);
    expect(() => evaluateAudit(duplicateFinding)).toThrow('duplicate audit finding');
  });

  test('missing correction evidence and a reused pre-correction review stay named as unmet', () => {
    const selection = selectionRequest();
    const directory = selection.obligations[1];
    const priorSubject = {
      ...directory,
      subject: { ...directory.subject, contentIdentity: SHA_B },
    };
    const opening = {
      ...review(priorSubject, 'review.opening.refused'),
      candidateIdentity: SHA_B,
      generation: 2,
      findings: [
        { findingId: 'finding.refused', severity: 'critical' as const, summary: 'still open' },
      ],
    };
    const correction = {
      correctionId: 'correction.refused',
      findingId: 'finding.refused',
      ownerId: 'owner.refused',
      obligationId: directory.obligationId,
      fromReviewId: opening.reviewId,
      fromCandidateIdentity: SHA_B,
      fromGeneration: 2,
      candidateIdentity: SHA_A,
      generation: 3,
      sourceEvidence: [],
      checkEvidence: [],
    };
    const report = evaluateAudit({
      ...selection,
      mode: 'enforce',
      claimedCoverage: 'sampled',
      reviews: [opening],
      corrections: [correction],
      closures: [
        {
          closureId: 'closure.refused',
          findingId: 'finding.refused',
          correctionId: correction.correctionId,
          postCorrectionReviewId: opening.reviewId,
        },
      ],
      adjudications: [],
    });

    expect(report.unresolvedFindingIds).toEqual(['finding.refused']);
    expect(report.unmetObligationIds).toContain('finding:finding.refused');
    expect(report.refusals).toContainEqual({
      obligationId: 'finding:finding.refused',
      kind: 'finding',
      reason:
        'finding closure requires authoritative current source/check evidence and a fresh post-correction review',
    });
    expect(report.accepted).toBe(false);
  });

  test('the boundary rejects identity reuse and wrong current subjects while reports ignore input order', () => {
    const selection = selectionRequest();
    const directory = selection.obligations[1];
    const project = selection.obligations[2];
    const directoryReview = review(directory, 'review.binding.directory');
    const projectReview = review(project, 'review.binding.project');
    const envelope = {
      ...selection,
      mode: 'enforce' as const,
      claimedCoverage: 'sampled' as const,
      reviews: [directoryReview, projectReview],
      corrections: [],
      closures: [],
      adjudications: [],
    };

    expect(evaluateAudit({ ...envelope, reviews: [...envelope.reviews].reverse() })).toEqual(
      evaluateAudit(envelope),
    );

    const reusedInvocation = structuredClone(projectReview);
    reusedInvocation.reviewId = 'review.binding.reused';
    reusedInvocation.evidence.receipt.invocationId = directoryReview.evidence.receipt.invocationId;
    reusedInvocation.evidence.phaseReceipts.cold.receipt.invocationId =
      directoryReview.evidence.receipt.invocationId;
    reusedInvocation.evidence.phaseReceipts.informed.receipt.invocationId =
      directoryReview.evidence.receipt.invocationId;
    expect(() =>
      evaluateAudit({ ...envelope, reviews: [directoryReview, reusedInvocation] }),
    ).toThrow('duplicate audit review invocation');

    const duplicateReview = structuredClone(projectReview);
    duplicateReview.reviewId = directoryReview.reviewId;
    expect(() =>
      evaluateAudit({ ...envelope, reviews: [directoryReview, duplicateReview] }),
    ).toThrow('duplicate audit review');

    const wrongSubject = structuredClone(directoryReview);
    wrongSubject.evidence.protocolEvidence.subject.contentIdentity = SHA_B;
    expect(() => evaluateAudit({ ...envelope, reviews: [wrongSubject, projectReview] })).toThrow(
      'does not bind current subject content',
    );
    const wrongSubjectId = structuredClone(directoryReview);
    wrongSubjectId.evidence.protocolEvidence.subject.subjectId = 'subject.foreign';
    expect(() => evaluateAudit({ ...envelope, reviews: [wrongSubjectId, projectReview] })).toThrow(
      'does not bind the obligation subject',
    );
    const wrongBase = structuredClone(directoryReview);
    wrongBase.sourceBase = '2'.repeat(40);
    expect(() => evaluateAudit({ ...envelope, reviews: [wrongBase, projectReview] })).toThrow(
      'does not bind the audit source base',
    );
    const mixedInvocation = structuredClone(directoryReview);
    mixedInvocation.evidence.phaseReceipts.cold.receipt.invocationId = 'invocation.foreign';
    expect(() => evaluateAudit({ ...envelope, reviews: [mixedInvocation, projectReview] })).toThrow(
      'mixes invocation identities',
    );
    const mixedExecutor = structuredClone(directoryReview);
    mixedExecutor.evidence.phaseReceipts.cold.receipt.executor = {
      ...mixedExecutor.evidence.phaseReceipts.cold.receipt.executor,
      model: 'other-model',
    };
    expect(() => evaluateAudit({ ...envelope, reviews: [mixedExecutor, projectReview] })).toThrow(
      'mixes executor or price identities',
    );
    const missingUsage = structuredClone(directoryReview);
    missingUsage.evidence.receipt.rawUsage = missingUsage.evidence.receipt.rawUsage.slice(1);
    expect(() => evaluateAudit({ ...envelope, reviews: [missingUsage, projectReview] })).toThrow(
      'omits phase usage from its review receipt',
    );
    const wrongResponse = structuredClone(directoryReview);
    wrongResponse.evidence.rawResponse.artifact = SHA_B;
    expect(() => evaluateAudit({ ...envelope, reviews: [wrongResponse, projectReview] })).toThrow(
      'does not bind its informed response',
    );
    const negativeZeroUsage = structuredClone(directoryReview);
    negativeZeroUsage.evidence.phaseReceipts.cold.receipt.rawUsage[0].quantity = -0;
    negativeZeroUsage.evidence.receipt.rawUsage[0].quantity = -0;
    expect(() =>
      evaluateAudit({ ...envelope, reviews: [negativeZeroUsage, projectReview] }),
    ).toThrow('negative zero');
    expect(() => evaluateAudit({ ...envelope, unexpected: true })).toThrow();

    const priorGeneration = { ...directoryReview, generation: 2 };
    const staleReport = evaluateAudit({
      ...envelope,
      reviews: [priorGeneration, projectReview],
    });
    expect(staleReport.unmetObligationIds).toContain('review.directory.src');
    const futureGeneration = { ...directoryReview, generation: 4 };
    expect(() =>
      evaluateAudit({ ...envelope, reviews: [futureGeneration, projectReview] }),
    ).toThrow('is from a future generation');
    const nonPlainEnvelope = { ...envelope };
    Object.setPrototypeOf(nonPlainEnvelope, { inherited: true });
    expect(() => evaluateAudit(nonPlainEnvelope)).toThrow(
      'canonical JSON requires a plain JSON object',
    );
  });
});
