import { describe, expect, test } from 'bun:test';

import { evaluateObligations, type ObligationRequest } from '../policy/obligations';
import { classifyCurrency, type CurrencySnapshot, type ReviewJudgment } from './currency';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const REVISION_A = '1'.repeat(40);
const REVISION_B = '2'.repeat(40);

function extracted(at: 'candidate' | 'historical' = 'candidate') {
  return {
    kind: 'extracted' as const,
    extractor: {
      extractorId: 'index.reader',
      version: 'v1',
      blob: SHA_C,
    },
    source:
      at === 'candidate'
        ? ({ kind: 'candidate' } as const)
        : ({ kind: 'historical', revision: REVISION_A } as const),
  };
}

function snapshot(contentIdentity: string): CurrencySnapshot {
  return {
    sourceBase: REVISION_B,
    candidateIdentity: SHA_C,
    inputs: {
      content: [
        {
          kind: 'content',
          inputId: 'content.child',
          path: 'src/child.ts',
          mode: '100644',
          blob: contentIdentity,
        },
      ],
      structural: [],
      semantic: [],
      topology: [
        {
          kind: 'topology',
          inputId: 'index.root.members',
          topologyKind: 'index-membership',
          subjectId: 'module.root',
          identity: SHA_A,
          provenance: extracted(),
        },
      ],
    },
  };
}

function selectorSnapshot(
  identities: {
    publicDeclaration: string;
    semanticContract: string;
    reverseEdges: string;
    indexMembership: string;
  },
  sourceBase = REVISION_A,
): CurrencySnapshot {
  return {
    sourceBase,
    candidateIdentity: SHA_C,
    inputs: {
      content: [],
      structural: [
        {
          kind: 'structural',
          inputId: 'typescript.public.provider',
          subjectId: 'provider',
          identity: identities.publicDeclaration,
          provenance: {
            kind: 'extracted',
            extractor: {
              extractorId: 'typescript.compiler',
              version: 'v6.0.3',
              blob: SHA_C,
            },
            source: { kind: 'candidate' },
          },
        },
      ],
      semantic: [
        {
          kind: 'semantic',
          inputId: 'contract.provider.behavior',
          subjectId: 'provider',
          identity: identities.semanticContract,
          provenance: {
            kind: 'declared',
            declarationId: 'declaration.provider',
            declarationPath: 'docs/contracts/provider.json',
            selectorVersion: 'v1',
            source: { kind: 'candidate' },
          },
        },
      ],
      topology: [
        {
          kind: 'topology',
          inputId: 'typescript.reverse.provider',
          topologyKind: 'reverse-edges',
          subjectId: 'provider',
          identity: identities.reverseEdges,
          provenance: {
            kind: 'extracted',
            extractor: {
              extractorId: 'typescript.compiler',
              version: 'v6.0.3',
              blob: SHA_C,
            },
            source: { kind: 'candidate' },
          },
        },
        {
          kind: 'topology',
          inputId: 'index.root.members',
          topologyKind: 'index-membership',
          subjectId: 'module.root',
          identity: identities.indexMembership,
          provenance: extracted(),
        },
      ],
    },
  };
}

describe('review currency', () => {
  test('a content-only child edit leaves its ancestor navigation judgment current', () => {
    const reviewed = snapshot(SHA_A);
    const current = snapshot(SHA_B);
    const judgments: ReviewJudgment[] = [
      {
        judgmentId: 'judgment.child.content',
        kind: 'content',
        subjectId: 'subject.child',
        bindings: {
          content: [{ kind: 'content', inputId: 'content.child' }],
          structural: [],
          semantic: [],
          topology: [],
        },
      },
      {
        judgmentId: 'judgment.root.navigation',
        kind: 'navigation',
        subjectId: 'subject.root',
        bindings: {
          content: [],
          structural: [],
          semantic: [],
          topology: [{ kind: 'topology', inputId: 'index.root.members' }],
        },
      },
    ];

    const report = classifyCurrency(reviewed, current, judgments);

    expect(report.judgments).toEqual([
      {
        judgmentId: 'judgment.child.content',
        kind: 'content',
        subjectId: 'subject.child',
        status: 'stale',
        changes: [{ axis: 'content', inputId: 'content.child', change: 'identity-changed' }],
      },
      {
        judgmentId: 'judgment.root.navigation',
        kind: 'navigation',
        subjectId: 'subject.root',
        status: 'current',
        changes: [],
      },
    ]);
  });

  test('public and semantic selector edits stale only their bound consumer judgments', () => {
    const reviewed = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    const current = selectorSnapshot({
      publicDeclaration: SHA_B,
      semanticContract: SHA_B,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    const judgments: ReviewJudgment[] = [
      {
        judgmentId: 'judgment.consumer.structure',
        kind: 'structural',
        subjectId: 'consumer',
        bindings: {
          content: [],
          structural: [{ kind: 'structural', inputId: 'typescript.public.provider' }],
          semantic: [],
          topology: [],
        },
      },
      {
        judgmentId: 'judgment.consumer.behavior',
        kind: 'semantic',
        subjectId: 'consumer',
        bindings: {
          content: [],
          structural: [],
          semantic: [{ kind: 'semantic', inputId: 'contract.provider.behavior' }],
          topology: [],
        },
      },
      {
        judgmentId: 'judgment.provider.relationships',
        kind: 'relationship',
        subjectId: 'provider',
        bindings: {
          content: [],
          structural: [],
          semantic: [],
          topology: [{ kind: 'topology', inputId: 'typescript.reverse.provider' }],
        },
      },
    ];

    expect(
      classifyCurrency(reviewed, current, judgments).judgments.map(
        ({ judgmentId, status, changes }) => ({ judgmentId, status, changes }),
      ),
    ).toEqual([
      {
        judgmentId: 'judgment.consumer.structure',
        status: 'stale',
        changes: [
          {
            axis: 'structural',
            inputId: 'typescript.public.provider',
            change: 'identity-changed',
          },
        ],
      },
      {
        judgmentId: 'judgment.consumer.behavior',
        status: 'stale',
        changes: [
          {
            axis: 'semantic',
            inputId: 'contract.provider.behavior',
            change: 'identity-changed',
          },
        ],
      },
      { judgmentId: 'judgment.provider.relationships', status: 'current', changes: [] },
    ]);
  });

  test('new reverse and index edges stale their matching relationship and navigation judgments', () => {
    const reviewed = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    const current = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_B,
      indexMembership: SHA_B,
    });
    const judgments: ReviewJudgment[] = [
      {
        judgmentId: 'judgment.provider.relationships',
        kind: 'relationship',
        subjectId: 'provider',
        bindings: {
          content: [],
          structural: [],
          semantic: [],
          topology: [{ kind: 'topology', inputId: 'typescript.reverse.provider' }],
        },
      },
      {
        judgmentId: 'judgment.root.navigation',
        kind: 'navigation',
        subjectId: 'module.root',
        bindings: {
          content: [],
          structural: [],
          semantic: [],
          topology: [{ kind: 'topology', inputId: 'index.root.members' }],
        },
      },
    ];

    expect(
      classifyCurrency(reviewed, current, judgments).judgments.map(
        ({ judgmentId, status, changes }) => ({ judgmentId, status, changes }),
      ),
    ).toEqual([
      {
        judgmentId: 'judgment.provider.relationships',
        status: 'stale',
        changes: [
          {
            axis: 'topology',
            inputId: 'typescript.reverse.provider',
            change: 'identity-changed',
          },
        ],
      },
      {
        judgmentId: 'judgment.root.navigation',
        status: 'stale',
        changes: [
          {
            axis: 'topology',
            inputId: 'index.root.members',
            change: 'identity-changed',
          },
        ],
      },
    ]);
  });

  test('keeps current selectors stable across candidates but pins historical selector bases', () => {
    const reviewed = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    const current = selectorSnapshot(
      {
        publicDeclaration: SHA_A,
        semanticContract: SHA_A,
        reverseEdges: SHA_A,
        indexMembership: SHA_A,
      },
      REVISION_B,
    );
    const relationship: ReviewJudgment = {
      judgmentId: 'judgment.provider.relationships',
      kind: 'relationship',
      subjectId: 'provider',
      bindings: {
        content: [],
        structural: [],
        semantic: [],
        topology: [{ kind: 'topology', inputId: 'typescript.reverse.provider' }],
      },
    };

    expect(classifyCurrency(reviewed, current, [relationship]).judgments[0]?.status).toBe(
      'current',
    );

    const reviewedHistorical = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    reviewedHistorical.inputs.topology[0].provenance = extracted('historical');
    const currentHistorical = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    currentHistorical.inputs.topology[0].provenance = {
      ...extracted('historical'),
      source: { kind: 'historical', revision: REVISION_B },
    };

    expect(
      classifyCurrency(reviewedHistorical, currentHistorical, [relationship]).judgments[0],
    ).toMatchObject({
      status: 'stale',
      changes: [
        {
          axis: 'topology',
          inputId: 'typescript.reverse.provider',
          change: 'identity-changed',
        },
      ],
    });
  });

  test('treats declared and extracted provenance as part of selector currency', () => {
    const reviewed = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    const current = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    current.inputs.structural[0].provenance = {
      kind: 'extracted',
      extractor: {
        extractorId: 'typescript.compiler',
        version: 'v6.0.4',
        blob: SHA_C,
      },
      source: { kind: 'candidate' },
    };
    current.inputs.semantic[0].provenance = {
      kind: 'declared',
      declarationId: 'declaration.provider',
      declarationPath: 'docs/contracts/provider.json',
      selectorVersion: 'v2',
      source: { kind: 'candidate' },
    };

    const report = classifyCurrency(reviewed, current, [
      {
        judgmentId: 'judgment.consumer.structure',
        kind: 'structural',
        subjectId: 'consumer',
        bindings: {
          content: [],
          structural: [{ kind: 'structural', inputId: 'typescript.public.provider' }],
          semantic: [],
          topology: [],
        },
      },
      {
        judgmentId: 'judgment.consumer.behavior',
        kind: 'semantic',
        subjectId: 'consumer',
        bindings: {
          content: [],
          structural: [],
          semantic: [{ kind: 'semantic', inputId: 'contract.provider.behavior' }],
          topology: [],
        },
      },
    ]);

    expect(report.judgments.map(({ judgmentId, status }) => ({ judgmentId, status }))).toEqual([
      { judgmentId: 'judgment.consumer.structure', status: 'stale' },
      { judgmentId: 'judgment.consumer.behavior', status: 'stale' },
    ]);
  });

  test('refuses ambiguous inputs and bindings instead of guessing their currency', () => {
    const duplicate = snapshot(SHA_A);
    duplicate.inputs.content.push({ ...duplicate.inputs.content[0] });
    expect(() => classifyCurrency(duplicate, snapshot(SHA_A), [])).toThrow(
      'duplicate content currency input: content.child',
    );

    const absentBinding: ReviewJudgment = {
      judgmentId: 'judgment.missing',
      kind: 'structural',
      subjectId: 'missing',
      bindings: {
        content: [],
        structural: [{ kind: 'structural', inputId: 'structural.missing' }],
        semantic: [],
        topology: [],
      },
    };
    expect(() => classifyCurrency(snapshot(SHA_A), snapshot(SHA_A), [absentBinding])).toThrow(
      'judgment judgment.missing binds absent reviewed structural input: structural.missing',
    );
  });
});

describe('review obligations', () => {
  test('turns a stale selector-bound consumer judgment into a named review obligation', () => {
    const reviewed = selectorSnapshot({
      publicDeclaration: SHA_A,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    const current = selectorSnapshot({
      publicDeclaration: SHA_B,
      semanticContract: SHA_A,
      reverseEdges: SHA_A,
      indexMembership: SHA_A,
    });
    const judgment: ReviewJudgment = {
      judgmentId: 'judgment.consumer.structure',
      kind: 'structural',
      subjectId: 'consumer',
      bindings: {
        content: [],
        structural: [{ kind: 'structural', inputId: 'typescript.public.provider' }],
        semantic: [],
        topology: [],
      },
    };

    const report = evaluateObligations({
      reviewed,
      current,
      judgments: [judgment],
      policy: { policyId: 'policy.review.v1', behaviorRules: [] },
      impactClassifications: [],
      writerLabels: [],
      checks: [],
      reviews: [],
    });

    expect(report.requiredReviews).toEqual(['judgment.consumer.structure']);
    expect(report.refusals).toEqual([
      {
        obligationId: 'review:judgment.consumer.structure',
        kind: 'review',
        subjectId: 'judgment.consumer.structure',
        reason: 'stale review is missing for the current candidate',
      },
    ]);
  });

  test('a same-type implementation change still requires its consumer and conformance checks', () => {
    const reviewed = snapshot(SHA_A);
    reviewed.inputs.structural = [
      {
        kind: 'structural',
        inputId: 'typescript.public.child',
        subjectId: 'subject.child',
        identity: SHA_C,
        provenance: {
          kind: 'extracted',
          extractor: {
            extractorId: 'typescript.compiler',
            version: 'v6.0.3',
            blob: SHA_C,
          },
          source: { kind: 'candidate' },
        },
      },
    ];
    const current = snapshot(SHA_B);
    current.inputs.structural = reviewed.inputs.structural;
    const request: ObligationRequest = {
      reviewed,
      current,
      judgments: [],
      policy: {
        policyId: 'policy.review.v1',
        behaviorRules: [
          {
            contentInputId: 'content.child',
            consumerChecks: ['check.consumer'],
            conformanceChecks: ['check.conformance'],
            expandedReviewJudgments: ['judgment.child.impact'],
          },
        ],
      },
      impactClassifications: [
        {
          contentInputId: 'content.child',
          reviewedIdentity: SHA_A,
          currentIdentity: SHA_B,
          reviewedSourceBase: reviewed.sourceBase,
          currentSourceBase: current.sourceBase,
          reviewedCandidateIdentity: reviewed.candidateIdentity,
          currentCandidateIdentity: current.candidateIdentity,
          classification: 'unknown',
          authority: { kind: 'reviewed', reviewIdentity: SHA_A },
        },
        {
          contentInputId: 'content.child',
          reviewedIdentity: SHA_A,
          currentIdentity: SHA_B,
          reviewedSourceBase: reviewed.sourceBase,
          currentSourceBase: current.sourceBase,
          reviewedCandidateIdentity: reviewed.candidateIdentity,
          currentCandidateIdentity: current.candidateIdentity,
          classification: 'behavior-changing',
          authority: { kind: 'reviewed', reviewIdentity: SHA_C },
        },
      ],
      writerLabels: [],
      checks: [
        {
          checkId: 'check.consumer',
          candidateIdentity: current.candidateIdentity,
          status: 'failed',
        },
        {
          checkId: 'check.conformance',
          candidateIdentity: current.candidateIdentity,
          status: 'passed',
        },
      ],
      reviews: [],
    };

    const report = evaluateObligations(request);

    expect(report.accepted).toBe(false);
    expect(report.requiredChecks).toEqual(['check.conformance', 'check.consumer']);
    expect(report.refusals).toEqual([
      {
        obligationId: 'check:check.consumer',
        kind: 'check',
        subjectId: 'check.consumer',
        reason: 'required check failed for the current candidate',
      },
    ]);
    expect(report.currency.judgments).toEqual([]);
  });

  test('missing impact classification expands review and refuses instead of defaulting', () => {
    const reviewed = snapshot(SHA_A);
    const current = snapshot(SHA_B);
    const request: ObligationRequest = {
      reviewed,
      current,
      judgments: [],
      policy: {
        policyId: 'policy.review.v1',
        behaviorRules: [
          {
            contentInputId: 'content.child',
            consumerChecks: ['check.consumer'],
            conformanceChecks: [],
            expandedReviewJudgments: ['judgment.child.impact'],
          },
        ],
      },
      impactClassifications: [],
      writerLabels: [],
      checks: [
        {
          checkId: 'check.consumer',
          candidateIdentity: current.candidateIdentity,
          status: 'passed',
        },
      ],
      reviews: [],
    };

    const report = evaluateObligations(request);

    expect(report.accepted).toBe(false);
    expect(report.requiredReviews).toEqual(['judgment.child.impact']);
    expect(report.refusals).toEqual([
      {
        obligationId: 'impact-classification:content.child',
        kind: 'impact-classification',
        subjectId: 'content.child',
        reason: 'impact classification is missing for the exact content change',
      },
      {
        obligationId: 'expanded-review:judgment.child.impact',
        kind: 'expanded-review',
        subjectId: 'judgment.child.impact',
        reason: 'expanded review is missing for the current candidate',
      },
    ]);

    expect(
      evaluateObligations({
        ...request,
        reviews: [
          {
            judgmentId: 'judgment.child.impact',
            candidateIdentity: current.candidateIdentity,
            status: 'failed',
          },
          {
            judgmentId: 'judgment.child.impact',
            candidateIdentity: current.candidateIdentity,
            status: 'current',
          },
        ],
      }).refusals,
    ).toEqual([
      {
        obligationId: 'impact-classification:content.child',
        kind: 'impact-classification',
        subjectId: 'content.child',
        reason: 'impact classification is missing for the exact content change',
      },
    ]);

    expect(
      evaluateObligations({
        ...request,
        impactClassifications: [
          {
            contentInputId: 'content.child',
            reviewedIdentity: SHA_A,
            currentIdentity: SHA_B,
            reviewedSourceBase: reviewed.sourceBase,
            currentSourceBase: current.sourceBase,
            reviewedCandidateIdentity: reviewed.candidateIdentity,
            currentCandidateIdentity: SHA_A,
            classification: 'behavior-preserving',
            authority: { kind: 'reviewed', reviewIdentity: SHA_C },
          },
        ],
        reviews: [
          {
            judgmentId: 'judgment.child.impact',
            candidateIdentity: current.candidateIdentity,
            status: 'current',
          },
        ],
      }).refusals,
    ).toEqual([
      {
        obligationId: 'impact-classification:content.child',
        kind: 'impact-classification',
        subjectId: 'content.child',
        reason: 'impact classification does not bind the exact content change',
      },
    ]);
  });

  test('later current evidence discharges a named check obligation monotonically', () => {
    const reviewed = snapshot(SHA_A);
    const current = snapshot(SHA_B);
    const request: ObligationRequest = {
      reviewed,
      current,
      judgments: [],
      policy: {
        policyId: 'policy.review.v1',
        behaviorRules: [
          {
            contentInputId: 'content.child',
            consumerChecks: ['check.consumer'],
            conformanceChecks: [],
            expandedReviewJudgments: ['judgment.child.impact'],
          },
        ],
      },
      impactClassifications: [
        {
          contentInputId: 'content.child',
          reviewedIdentity: SHA_A,
          currentIdentity: SHA_B,
          reviewedSourceBase: reviewed.sourceBase,
          currentSourceBase: current.sourceBase,
          reviewedCandidateIdentity: reviewed.candidateIdentity,
          currentCandidateIdentity: current.candidateIdentity,
          classification: 'behavior-preserving',
          authority: { kind: 'reviewed', reviewIdentity: SHA_C },
        },
      ],
      writerLabels: [],
      checks: [
        {
          checkId: 'check.consumer',
          candidateIdentity: current.candidateIdentity,
          status: 'failed',
        },
        {
          checkId: 'check.consumer',
          candidateIdentity: current.candidateIdentity,
          status: 'passed',
        },
      ],
      reviews: [],
    };

    expect(evaluateObligations(request)).toMatchObject({ accepted: true, refusals: [] });
  });

  test('a writer implementation-only label cannot waive behavior checks', () => {
    const reviewed = snapshot(SHA_A);
    const current = snapshot(SHA_B);
    const report = evaluateObligations({
      reviewed,
      current,
      judgments: [],
      policy: {
        policyId: 'policy.review.v1',
        behaviorRules: [
          {
            contentInputId: 'content.child',
            consumerChecks: ['check.consumer'],
            conformanceChecks: [],
            expandedReviewJudgments: ['judgment.child.impact'],
          },
        ],
      },
      impactClassifications: [
        {
          contentInputId: 'content.child',
          reviewedIdentity: SHA_A,
          currentIdentity: SHA_B,
          reviewedSourceBase: reviewed.sourceBase,
          currentSourceBase: current.sourceBase,
          reviewedCandidateIdentity: reviewed.candidateIdentity,
          currentCandidateIdentity: current.candidateIdentity,
          classification: 'behavior-preserving',
          authority: { kind: 'declared', declarationIdentity: SHA_C },
        },
      ],
      writerLabels: [{ contentInputId: 'content.child', label: 'implementation-only' }],
      checks: [],
      reviews: [],
    });

    expect(report.writerLabels).toEqual([
      { contentInputId: 'content.child', label: 'implementation-only' },
    ]);
    expect(report.requiredChecks).toEqual(['check.consumer']);
    expect(report.refusals).toEqual([
      {
        obligationId: 'check:check.consumer',
        kind: 'check',
        subjectId: 'check.consumer',
        reason: 'required check evidence is missing for the current candidate',
      },
    ]);
  });

  test('unknown impact remains a named refusal even when its expanded review is present', () => {
    const reviewed = snapshot(SHA_A);
    const current = snapshot(SHA_B);
    const report = evaluateObligations({
      reviewed,
      current,
      judgments: [],
      policy: {
        policyId: 'policy.review.v1',
        behaviorRules: [
          {
            contentInputId: 'content.child',
            consumerChecks: [],
            conformanceChecks: [],
            expandedReviewJudgments: ['judgment.child.impact'],
          },
        ],
      },
      impactClassifications: [
        {
          contentInputId: 'content.child',
          reviewedIdentity: SHA_A,
          currentIdentity: SHA_B,
          reviewedSourceBase: reviewed.sourceBase,
          currentSourceBase: current.sourceBase,
          reviewedCandidateIdentity: reviewed.candidateIdentity,
          currentCandidateIdentity: current.candidateIdentity,
          classification: 'unknown',
          authority: { kind: 'reviewed', reviewIdentity: SHA_C },
        },
      ],
      writerLabels: [],
      checks: [],
      reviews: [
        {
          judgmentId: 'judgment.child.impact',
          candidateIdentity: current.candidateIdentity,
          status: 'current',
        },
      ],
    });

    expect(report.accepted).toBe(false);
    expect(report.requiredReviews).toEqual(['judgment.child.impact']);
    expect(report.refusals).toEqual([
      {
        obligationId: 'impact-classification:content.child',
        kind: 'impact-classification',
        subjectId: 'content.child',
        reason: 'impact classification is unknown for the exact content change',
      },
    ]);
  });
});
