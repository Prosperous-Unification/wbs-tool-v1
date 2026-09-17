import { parseOrThrow } from '@shared/validation';
import { describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { trialJournal } from './accounting.test';
import {
  assertComparableTrials,
  assignTrialOutcomes,
  type ExecutionAdapter,
  type ExecutionPacket,
  ExecutionSessionEvidence,
  runTrial,
  type TrialCheckpoint,
} from './runner';

const SECOND = 1_000;
const discardCheckpoints = {
  save(checkpoint: TrialCheckpoint) {
    structuredClone(checkpoint);
  },
};

async function rejectionFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw new Error(`expected Error rejection, received ${String(cause)}`, { cause });
  }
  throw new Error('expected promise to reject');
}

function evidenceFor(
  packet: ExecutionPacket,
  model = packet.manifest.execution.model,
): ExecutionSessionEvidence {
  const source = trialJournal();
  const offset = packet.assignmentOrdinal * SECOND;
  const startedAt = new Date(Date.parse(source.startedAt) + offset).toISOString();
  const endedAt = new Date(Date.parse(source.endedAt) - offset).toISOString();
  const outcomeIds = new Set(packet.outcomes.map(({ outcomeId }) => outcomeId));
  const attempts = source.attempts
    .filter(({ outcomeId }) => outcomeIds.has(outcomeId))
    .map((attempt) => ({ ...attempt, sessionId: `session.${String(packet.assignmentOrdinal)}` }));
  const attemptIds = new Set(attempts.map(({ attemptId }) => attemptId));
  return parseOrThrow(ExecutionSessionEvidence, {
    schemaVersion: 1,
    packetIdentity: hashCanonical(packet),
    processId: `process.${String(packet.assignmentOrdinal)}`,
    cacheCondition: packet.cacheCondition,
    session: {
      processId: `process.${String(packet.assignmentOrdinal)}`,
      sessionId: `session.${String(packet.assignmentOrdinal)}`,
      startedAt,
      endedAt,
      status: attempts.some(({ status }) => status === 'censored') ? 'censored' : 'completed',
      attemptIds: attempts.map(({ attemptId }) => attemptId),
    },
    attempts,
    outcomes: source.outcomes.filter(({ outcomeId }) => outcomeIds.has(outcomeId)),
    invocationReceipts: source.invocationReceipts
      .filter(({ receiptId }) =>
        attempts.some(({ invocationReceiptIds }) => invocationReceiptIds.includes(receiptId)),
      )
      .map((receipt) => ({
        ...receipt,
        startedAt,
        endedAt,
        executor: { ...receipt.executor, model },
      })),
    elapsedReceipts: source.elapsedReceipts
      .filter(({ attemptId }) => attemptIds.has(attemptId))
      .map((receipt) => ({
        ...receipt,
        trialId: packet.trialId,
        startedAt,
        endedAt: new Date(Date.parse(startedAt) + receipt.elapsedMs).toISOString(),
      })),
  });
}

function adapterFor(
  evidence: (packet: ExecutionPacket) => ExecutionSessionEvidence = (packet) => evidenceFor(packet),
): { adapter: ExecutionAdapter; packets: ExecutionPacket[]; canceled: string[] } {
  const packets: ExecutionPacket[] = [];
  const canceled: string[] = [];
  return {
    packets,
    canceled,
    adapter: {
      start(packet) {
        packets.push(structuredClone(packet));
        return {
          processId: `process.${String(packet.assignmentOrdinal)}`,
          sessionId: `session.${String(packet.assignmentOrdinal)}`,
          completion: Promise.resolve(evidence(packet)),
          cancel(reason) {
            canceled.push(reason);
          },
        };
      },
    },
  };
}

function request(concurrency = 2) {
  const source = trialJournal();
  source.manifest.resources.maxConcurrentSessions = Math.max(8, concurrency);
  source.manifestIdentity = hashCanonical(source.manifest);
  return {
    schemaVersion: 1,
    trialId: `trial.runner.${String(concurrency)}`,
    manifest: source.manifest,
    manifestIdentity: source.manifestIdentity,
    repeat: 1,
    seed: 11,
    concurrency,
    startedAt: source.startedAt,
    endedAt: source.endedAt,
    timeoutMs: 100,
    allocationReceipts: source.allocationReceipts.map((receipt) => ({
      ...receipt,
      trialId: `trial.runner.${String(concurrency)}`,
      resourceId: source.manifest.resources.resourceId,
    })),
  };
}

describe('controlled experiment runner', () => {
  test('randomizes assignments deterministically and returns complete retry/cost accounting', async () => {
    const firstAdapter = adapterFor();
    const first = await runTrial(request(), firstAdapter.adapter, {
      save(checkpoint) {
        expect(checkpoint.trialId).toBe('trial.runner.2');
      },
    });
    const secondAdapter = adapterFor();
    const second = await runTrial(request(), secondAdapter.adapter, discardCheckpoints);

    if (first.status === 'pending') throw new Error(first.reason);
    if (second.status === 'pending') throw new Error(second.reason);
    expect(first.status).toBe('verified');
    expect(first.report.acceptedOutcomeCount).toBe(1);
    expect(first.report.attempts.map(({ status }) => status)).toEqual([
      'completed',
      'failed',
      'censored',
    ]);
    expect(first.report.currencyCharges).toEqual([{ currency: 'USD', chargedAmountMicros: 375 }]);
    expect(first.report.invocationReceipts.flatMap(({ rawUsage }) => rawUsage)).not.toHaveLength(0);
    expect(first.report.allocationReceipts).toHaveLength(1);
    expect(firstAdapter.packets).toEqual(secondAdapter.packets);
    expect(firstAdapter.packets.map(({ cacheCondition }) => cacheCondition)).toEqual([
      'cold',
      'cold',
    ]);
    const warmRequest = request();
    warmRequest.manifest.resources.cacheCondition = 'warm';
    warmRequest.manifestIdentity = hashCanonical(warmRequest.manifest);
    const warmAdapter = adapterFor();
    await runTrial(warmRequest, warmAdapter.adapter, discardCheckpoints);
    expect(warmAdapter.packets.map(({ cacheCondition }) => cacheCondition)).toEqual([
      'warm',
      'warm',
    ]);
    expect(first.checkpoint.state).toBe('completed');
  });

  test('pins assignment order to seed and repeat without losing the frozen outcome set', () => {
    const manifest = request().manifest;
    const first = assignTrialOutcomes(manifest, 11, 1, 2);
    const repeated = assignTrialOutcomes(manifest, 11, 1, 2);
    const nextRepeat = assignTrialOutcomes(manifest, 11, 2, 2);

    expect(first).toEqual(repeated);
    expect(first).not.toEqual(nextRepeat);
    expect(first.flat().sort()).toEqual(['outcome.alpha', 'outcome.beta']);
  });

  test('refuses two sequential groups of four presented as an eight-session trial', async () => {
    const trialRequest = request(8);
    trialRequest.manifest.corpus.outcomes = Array.from({ length: 8 }, (_, index) => ({
      ...trialRequest.manifest.corpus.outcomes[index % 2],
      outcomeId: `outcome.${String(index)}`,
    }));
    trialRequest.manifestIdentity = hashCanonical(trialRequest.manifest);
    const splitAdapter = adapterFor((packet) => {
      const sessionEvidence = evidenceFor(packet);
      sessionEvidence.outcomes = packet.outcomes.map(({ outcomeId }) => ({
        outcomeId,
        status: 'censored',
        attemptIds: [],
        defectCount: 0,
      }));
      const groupOffset = packet.assignmentOrdinal < 4 ? 0 : 300_000;
      sessionEvidence.session.startedAt = new Date(
        Date.parse(trialRequest.startedAt) + groupOffset,
      ).toISOString();
      sessionEvidence.session.endedAt = new Date(
        Date.parse(trialRequest.startedAt) + groupOffset + 60_000,
      ).toISOString();
      sessionEvidence.invocationReceipts.forEach((receipt) => {
        receipt.startedAt = sessionEvidence.session.startedAt;
        receipt.endedAt = sessionEvidence.session.endedAt;
      });
      sessionEvidence.elapsedReceipts.forEach((receipt) => {
        receipt.startedAt = sessionEvidence.session.startedAt;
        receipt.endedAt = new Date(Date.parse(receipt.startedAt) + receipt.elapsedMs).toISOString();
      });
      return sessionEvidence;
    });

    const overlapFailure = await rejectionFrom(
      runTrial(trialRequest, splitAdapter.adapter, discardCheckpoints),
    );
    expect(overlapFailure.message).toContain('8 simultaneous active sessions');
  });

  test('cancels and settles siblings before rejecting invalid session evidence', async () => {
    const checkpoints: TrialCheckpoint[] = [];
    const canceled: string[] = [];
    let completeSibling: (evidence: ExecutionSessionEvidence) => void = (_evidence) => {
      throw new Error('sibling completion was not initialized');
    };
    let siblingPacket: ExecutionPacket | undefined;
    const invalidEvidenceAdapter: ExecutionAdapter = {
      start(packet) {
        const evidence = evidenceFor(packet);
        if (packet.assignmentOrdinal === 0) {
          evidence.processId = 'process.substituted';
          evidence.session.processId = 'process.substituted';
          return {
            processId: 'process.0',
            sessionId: 'session.0',
            completion: Promise.resolve(evidence),
            cancel(reason) {
              canceled.push(reason);
            },
          };
        }
        siblingPacket = structuredClone(packet);
        return {
          processId: 'process.1',
          sessionId: 'session.1',
          completion: new Promise<ExecutionSessionEvidence>((resolve) => {
            completeSibling = resolve;
          }),
          cancel(reason) {
            canceled.push(reason);
          },
        };
      },
    };

    const evidenceFailure = await rejectionFrom(
      runTrial(request(), invalidEvidenceAdapter, {
        save(checkpoint) {
          checkpoints.push(structuredClone(checkpoint));
        },
      }),
    );
    const checkpointCountAtFailure = checkpoints.length;
    if (siblingPacket === undefined) throw new Error('sibling packet was not launched');
    completeSibling(evidenceFor(siblingPacket));
    await Promise.resolve();
    await Promise.resolve();

    expect(evidenceFailure.message).toContain('evidence differs from its launch');
    expect(checkpoints).toHaveLength(checkpointCountAtFailure);
    expect(canceled).toEqual(['canceled']);
    expect(checkpoints.at(-1)?.state).toBe('pending');
  });

  test('refuses silent model substitution and post-observation condition changes', async () => {
    const switched = adapterFor((packet) => evidenceFor(packet, 'gpt-substitute'));
    const switchFailure = await rejectionFrom(
      runTrial(request(), switched.adapter, discardCheckpoints),
    );
    expect(switchFailure.message).toContain('pinned executor');

    const baseline = await runTrial(request(), adapterFor().adapter, discardCheckpoints);
    const changedRequest = request();
    changedRequest.manifest.hypotheses.q2OverQ1Minimum = 1.1;
    changedRequest.manifestIdentity = hashCanonical(changedRequest.manifest);
    const changed = await runTrial(changedRequest, adapterFor().adapter, discardCheckpoints);
    if (baseline.status !== 'verified' || changed.status !== 'verified') return;
    expect(() => assertComparableTrials([baseline.report, changed.report])).toThrow(
      'incomparable pinned manifests',
    );

    const changedCorpusRequest = request();
    changedCorpusRequest.manifest.corpus.outcomes[0].acceptanceCriteria.push(
      'changed after observation',
    );
    changedCorpusRequest.manifestIdentity = hashCanonical(changedCorpusRequest.manifest);
    const changedCorpus = await runTrial(
      changedCorpusRequest,
      adapterFor().adapter,
      discardCheckpoints,
    );
    if (changedCorpus.status !== 'verified') throw new Error(changedCorpus.reason);
    expect(() => assertComparableTrials([baseline.report, changedCorpus.report])).toThrow(
      'incomparable pinned manifests',
    );
  });

  test('keeps unavailable capacity pending and cancels every launched session on request', async () => {
    const unavailable = await runTrial(
      request(),
      {
        start() {
          throw new Error('adapter capacity unavailable');
        },
      },
      discardCheckpoints,
    );
    expect(unavailable.status).toBe('pending');
    if (unavailable.status === 'verified') return;
    expect(unavailable.reason).toContain('capacity unavailable');
    expect(unavailable.checkpoint.sessions).toEqual([]);

    const abort = new AbortController();
    abort.abort();
    const canceledAdapter = adapterFor();
    const canceled = await runTrial(
      request(),
      canceledAdapter.adapter,
      discardCheckpoints,
      abort.signal,
    );
    expect(canceled.status).toBe('pending');
    expect(canceledAdapter.canceled).toEqual(['canceled', 'canceled']);
  });

  test('enforces the pinned bounded retry policy through complete attempt evidence', async () => {
    const boundedRequest = request();
    boundedRequest.manifest.retryPolicy.maxAttemptsPerOutcome = 1;
    boundedRequest.manifestIdentity = hashCanonical(boundedRequest.manifest);
    const retryFailure = await rejectionFrom(
      runTrial(boundedRequest, adapterFor().adapter, discardCheckpoints),
    );
    expect(retryFailure.message).toContain('exceeds the pinned attempt limit');
  });

  test('cancels timed-out sessions and durably retains partial evidence without zero accounting', async () => {
    const completed = evidenceFor;
    const checkpoints: TrialCheckpoint[] = [];
    const partialAdapter = adapterFor((packet) => completed(packet));
    partialAdapter.adapter.start = (packet) => {
      if (packet.assignmentOrdinal === 0) {
        return {
          processId: 'process.0',
          sessionId: 'session.0',
          completion: Promise.resolve(completed(packet)),
          cancel(reason) {
            partialAdapter.canceled.push(reason);
          },
        };
      }
      return {
        processId: 'process.1',
        sessionId: 'session.1',
        completion: new Promise<ExecutionSessionEvidence>(() => undefined),
        cancel(reason) {
          partialAdapter.canceled.push(reason);
        },
      };
    };
    const timedRequest = { ...request(), timeoutMs: 5 };

    const pending = await runTrial(timedRequest, partialAdapter.adapter, {
      save(checkpoint) {
        checkpoints.push(structuredClone(checkpoint));
      },
    });

    expect(pending.status).toBe('pending');
    expect(partialAdapter.canceled).toEqual(['timeout']);
    expect(checkpoints.at(-1)?.state).toBe('pending');
    expect(checkpoints.at(-1)?.sessions).toHaveLength(1);
    expect(checkpoints.at(-1)?.pendingSessionIds).toEqual(['session.1']);
  });
});
