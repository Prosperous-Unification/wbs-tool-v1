import { describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { accountTrial, validateTrialReport } from './accounting';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const GIT_A = '1'.repeat(40);
const GIT_B = '2'.repeat(40);
const START = '2026-09-13T08:00:00.000Z';
const END = '2026-09-13T08:10:00.000Z';

const priceIdentity = {
  priceId: 'price.fixture.v1',
  provider: 'openai',
  model: 'gpt-5',
  currency: 'USD',
  source: 'fixture-price-list',
};

const manifest = {
  schemaVersion: 1,
  manifestId: 'experiment.fixture.v1',
  repository: { revision: GIT_A, tree: GIT_B, inventoryId: 'inventory.fixture.v1' },
  corpus: {
    corpusId: 'corpus.fixture.v1',
    acceptanceId: 'acceptance.fixture.v1',
    outcomes: [
      {
        outcomeId: 'outcome.alpha',
        title: 'Alpha, accepted once',
        stratum: 'independent-module',
        heldOut: false,
        acceptanceCriteria: ['alpha gate passes'],
      },
      {
        outcomeId: 'outcome.beta',
        title: 'Beta remains censored',
        stratum: 'shared-contract',
        heldOut: true,
        acceptanceCriteria: ['beta gate passes'],
      },
    ],
  },
  granularity: {
    policyId: 'granularity.fixture.v1',
    mappingVersion: 'mapping.fixture.v1',
    mappingBlob: SHA_A,
  },
  reviewProtocol: { protocolId: 'review.fixture.v1', protocolBlob: SHA_B },
  execution: {
    provider: 'openai',
    model: 'gpt-5',
    version: '2026-09-13',
    effort: 'high',
    promptHash: SHA_A,
    toolHash: SHA_B,
  },
  resources: {
    resourceId: 'resource.fixture.v1',
    allocationMode: 'fixed-total',
    maxConcurrentSessions: 2,
    cacheCondition: 'cold',
  },
  seeds: [11, 22, 33],
  retryPolicy: { maxAttemptsPerOutcome: 3, timeBudgetMs: 3_600_000 },
  integrationPolicy: { maxSubmissions: 4, maxWaitMs: 300_000 },
  priceIdentity,
  receiptJournal: { journalId: 'journal.fixture.v1', schemaVersion: 1 },
  observation: { postAcceptanceDefectWindowHours: 24 },
  hypotheses: {
    q2OverQ1Minimum: 1.6,
    q4OverQ1Minimum: 3.2,
    q8OverQ1Minimum: 6.4,
    conflictRateMaximum: 0.05,
    integrationReworkRateMaximum: 0.1,
    medianDiscoveryMsMaximum: 300_000,
    reviewAmplificationMaximum: 3,
    leaseWaitFractionMaximum: 0.1,
  },
};

function invocation(
  receiptId: string,
  invocationId: string,
  status: 'completed' | 'failed' | 'censored',
  charge: number,
) {
  return {
    schemaVersion: 1,
    receiptKind: 'invocation',
    receiptId,
    invocationId,
    startedAt: START,
    endedAt: END,
    status,
    executor: {
      provider: 'openai',
      model: 'gpt-5',
      version: '2026-09-13',
      effort: 'high',
      toolchain: 'codex.fixture.v1',
    },
    rawUsage: [{ category: 'input_tokens', quantity: charge, unit: 'tokens' }],
    priceIdentity,
    chargedAmountMicros: charge,
    inputArtifact: SHA_A,
    outputArtifact: SHA_B,
  };
}

function elapsed(
  receiptId: string,
  outcomeId: string,
  attemptId: string,
  phase: 'discovery' | 'waiting' | 'execution' | 'gate' | 'human',
  elapsedMs: number,
) {
  return {
    schemaVersion: 1,
    receiptKind: 'elapsed',
    receiptId,
    trialId: 'trial.fixture.1',
    outcomeId,
    attemptId,
    phase,
    startedAt: START,
    endedAt: new Date(Date.parse(START) + elapsedMs).toISOString(),
    elapsedMs,
    status: phase === 'execution' && attemptId === 'attempt.beta.1' ? 'censored' : 'completed',
  };
}

export function trialJournal() {
  const journal = {
    schemaVersion: 1,
    trialId: 'trial.fixture.1',
    manifest,
    manifestIdentity: hashCanonical(manifest),
    repeat: 1,
    seed: 11,
    concurrency: 2,
    startedAt: START,
    endedAt: END,
    status: 'censored',
    sessions: [
      {
        processId: 'process.alpha',
        sessionId: 'session.alpha',
        startedAt: START,
        endedAt: END,
        status: 'completed',
        attemptIds: ['attempt.alpha.1', 'attempt.alpha.2'],
      },
      {
        processId: 'process.beta',
        sessionId: 'session.beta',
        startedAt: START,
        endedAt: END,
        status: 'censored',
        attemptIds: ['attempt.beta.1'],
      },
    ],
    attempts: [
      {
        attemptId: 'attempt.alpha.1',
        outcomeId: 'outcome.alpha',
        sessionId: 'session.alpha',
        status: 'completed',
        commitIds: [GIT_A, GIT_B],
        invocationReceiptIds: ['receipt.invocation.alpha.1'],
        elapsedReceiptIds: ['receipt.discovery.alpha', 'receipt.waiting.alpha'],
      },
      {
        attemptId: 'attempt.alpha.2',
        outcomeId: 'outcome.alpha',
        sessionId: 'session.alpha',
        status: 'failed',
        commitIds: [],
        invocationReceiptIds: ['receipt.invocation.alpha.2'],
        elapsedReceiptIds: ['receipt.gate.alpha'],
      },
      {
        attemptId: 'attempt.beta.1',
        outcomeId: 'outcome.beta',
        sessionId: 'session.beta',
        status: 'censored',
        commitIds: [],
        invocationReceiptIds: ['receipt.invocation.beta.1'],
        elapsedReceiptIds: ['receipt.execution.beta', 'receipt.human.beta'],
      },
    ],
    outcomes: [
      {
        outcomeId: 'outcome.alpha',
        status: 'accepted',
        attemptIds: ['attempt.alpha.1', 'attempt.alpha.2'],
        acceptanceArtifact: SHA_C,
        integrationIdentity: SHA_A,
        defectCount: 0,
      },
      {
        outcomeId: 'outcome.beta',
        status: 'censored',
        attemptIds: ['attempt.beta.1'],
        defectCount: 0,
      },
    ],
    invocationReceipts: [
      invocation('receipt.invocation.alpha.1', 'invocation.alpha.1', 'completed', 100),
      invocation('receipt.invocation.alpha.2', 'invocation.alpha.2', 'failed', 50),
      invocation('receipt.invocation.beta.1', 'invocation.beta.1', 'censored', 25),
    ],
    elapsedReceipts: [
      elapsed('receipt.discovery.alpha', 'outcome.alpha', 'attempt.alpha.1', 'discovery', 10_000),
      elapsed('receipt.waiting.alpha', 'outcome.alpha', 'attempt.alpha.1', 'waiting', 20_000),
      elapsed('receipt.gate.alpha', 'outcome.alpha', 'attempt.alpha.2', 'gate', 30_000),
      elapsed('receipt.execution.beta', 'outcome.beta', 'attempt.beta.1', 'execution', 40_000),
      elapsed('receipt.human.beta', 'outcome.beta', 'attempt.beta.1', 'human', 50_000),
    ],
    allocationReceipts: [
      {
        schemaVersion: 1,
        receiptKind: 'allocation',
        receiptId: 'receipt.allocation.1',
        trialId: 'trial.fixture.1',
        resourceId: 'resource.fixture.v1',
        allocationMode: 'fixed-total',
        startedAt: START,
        endedAt: END,
        elapsedMs: 600_000,
        quantity: 1,
        unit: 'host',
        priceIdentity,
        chargedAmountMicros: 200,
      },
    ],
  };
  return structuredClone(journal);
}

describe('trial accounting', () => {
  test('counts one accepted outcome while retaining every attempt, phase, usage, and cost', () => {
    const report = accountTrial(trialJournal());

    expect(report.acceptedOutcomeIds).toEqual(['outcome.alpha']);
    expect(report.acceptedOutcomeCount).toBe(1);
    expect(report.attempts.map(({ status }) => status)).toEqual([
      'completed',
      'failed',
      'censored',
    ]);
    expect(report.phaseElapsedMs).toEqual([
      { phase: 'discovery', elapsedMs: 10_000 },
      { phase: 'execution', elapsedMs: 40_000 },
      { phase: 'gate', elapsedMs: 30_000 },
      { phase: 'human', elapsedMs: 50_000 },
      { phase: 'waiting', elapsedMs: 20_000 },
    ]);
    expect(report.totalElapsedMs).toBe(600_000);
    expect(report.aggregateSessionElapsedMs).toBe(1_200_000);
    expect(report.currencyCharges).toEqual([{ currency: 'USD', chargedAmountMicros: 375 }]);
    expect(report.invocationReceipts).toHaveLength(3);
    expect(report.elapsedReceipts).toHaveLength(5);
  });

  test('refuses incomplete or inflated reports against the complete journal', () => {
    const journal = trialJournal();
    const report = accountTrial(journal);
    const inflated = structuredClone(report);
    inflated.acceptedOutcomeCount = 2;
    const missingFailed = structuredClone(report);
    missingFailed.attempts = missingFailed.attempts.filter(
      ({ attemptId }) => attemptId !== 'attempt.alpha.2',
    );
    const missingWaiting = structuredClone(report);
    missingWaiting.elapsedReceipts = missingWaiting.elapsedReceipts.filter(
      ({ phase }) => phase !== 'waiting',
    );
    const missingPrice = structuredClone(report);
    Reflect.deleteProperty(missingPrice.invocationReceipts[0], 'priceIdentity');

    expect(() => validateTrialReport(journal, inflated)).toThrow('accepted outcome accounting');
    expect(() => validateTrialReport(journal, missingFailed)).toThrow('does not own attempt');
    expect(() => validateTrialReport(journal, missingWaiting)).toThrow(
      'mismatched elapsed receipt',
    );
    expect(() => validateTrialReport(journal, missingPrice)).toThrow('priceIdentity');
  });

  test('refuses orphan receipts and outcome sets that differ from the frozen corpus', () => {
    const orphaned = trialJournal();
    orphaned.attempts[0].invocationReceiptIds = [];
    const missingOutcome = trialJournal();
    missingOutcome.outcomes.pop();

    expect(() => accountTrial(orphaned)).toThrow('invocation receipt coverage');
    expect(() => accountTrial(missingOutcome)).toThrow('frozen corpus outcomes');
  });

  test('refuses missing usage and infrastructure price provenance instead of pricing as zero', () => {
    const missingUsage = trialJournal();
    missingUsage.invocationReceipts[1].rawUsage = [];
    const missingAllocationPrice = trialJournal();
    Reflect.deleteProperty(missingAllocationPrice.allocationReceipts[0], 'priceIdentity');

    expect(() => accountTrial(missingUsage)).toThrow('raw usage telemetry');
    expect(() => accountTrial(missingAllocationPrice)).toThrow('priceIdentity');
  });

  test('refuses inconsistent pinned conditions, ownership links, and strict records', () => {
    const faults: readonly [string, (journal: ReturnType<typeof trialJournal>) => void, string][] =
      [
        ['manifest identity', (journal) => (journal.manifestIdentity = SHA_A), 'manifest identity'],
        ['seed', (journal) => (journal.seed = 44), 'seed is absent'],
        ['concurrency', (journal) => (journal.concurrency = 3), 'resource envelope'],
        [
          'session ownership',
          (journal) => (journal.sessions[0].attemptIds = ['attempt.alpha.1']),
          'session attempt coverage',
        ],
        [
          'outcome ownership',
          (journal) => (journal.outcomes[0].attemptIds = ['attempt.alpha.1']),
          'outcome attempt coverage',
        ],
        [
          'elapsed linkage',
          (journal) => (journal.elapsedReceipts[0].attemptId = 'attempt.alpha.2'),
          'mismatched elapsed receipt',
        ],
        [
          'executor identity',
          (journal) => (journal.invocationReceipts[0].executor.model = 'gpt-5-other'),
          'pinned executor',
        ],
        [
          'resource identity',
          (journal) => (journal.allocationReceipts[0].resourceId = 'resource.other.v1'),
          'pinned resource',
        ],
        [
          'strict trial record',
          (journal) => Reflect.set(journal, 'unexpected', true),
          'unexpected must be removed',
        ],
        [
          'missing launched process',
          (journal) => Reflect.deleteProperty(journal.sessions[0], 'processId'),
          'processId',
        ],
        [
          'strict accepted outcome',
          (journal) => Reflect.deleteProperty(journal.outcomes[0], 'acceptanceArtifact'),
          'acceptanceArtifact',
        ],
      ];

    for (const [name, injectFault, expected] of faults) {
      const journal = trialJournal();
      injectFault(journal);
      expect(() => accountTrial(journal), name).toThrow(expected);
    }
  });

  test('refuses aggregate cost outside the safe integer range', () => {
    const overflow = trialJournal();
    overflow.invocationReceipts[0].chargedAmountMicros = Number.MAX_SAFE_INTEGER;

    expect(() => accountTrial(overflow)).toThrow('currency charge total');
  });

  test('refuses observations outside their trial or owning session interval', () => {
    const invocationOutsideTrial = trialJournal();
    invocationOutsideTrial.invocationReceipts[0].startedAt = '2025-09-13T08:00:00.000Z';
    invocationOutsideTrial.invocationReceipts[0].endedAt = '2025-09-13T08:10:00.000Z';
    const elapsedOutsideTrial = trialJournal();
    elapsedOutsideTrial.elapsedReceipts[0].startedAt = '2025-09-13T08:00:00.000Z';
    elapsedOutsideTrial.elapsedReceipts[0].endedAt = '2025-09-13T08:00:10.000Z';
    const allocationOutsideTrial = trialJournal();
    allocationOutsideTrial.allocationReceipts[0].startedAt = '2026-09-13T07:59:59.000Z';
    allocationOutsideTrial.allocationReceipts[0].elapsedMs = 601_000;
    const waitingOutsideSession = trialJournal();
    waitingOutsideSession.sessions[0].startedAt = '2026-09-13T08:00:11.000Z';

    expect(() => accountTrial(invocationOutsideTrial)).toThrow('outside owning session interval');
    expect(() => accountTrial(elapsedOutsideTrial)).toThrow('outside owning session interval');
    expect(() => accountTrial(allocationOutsideTrial)).toThrow('outside trial interval');
    expect(() => accountTrial(waitingOutsideSession)).toThrow('outside owning session interval');
  });
});
