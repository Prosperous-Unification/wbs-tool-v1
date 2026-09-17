import { describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { accountTrial } from './accounting';
import { trialJournal } from './accounting.test';
import { exportTrialEvidence } from './export';

function submission(journal = trialJournal()) {
  return { journal, report: accountTrial(journal) };
}

describe('portable experiment export', () => {
  test('supports independent recomputation from JSONL and CSV without tool-wiki code', () => {
    const exported = exportTrialEvidence([submission()]);
    const observations = exported.jsonl
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const outcomes = observations.filter(({ observationKind }) => observationKind === 'outcome');
    const elapsed = observations.filter(({ observationKind }) => observationKind === 'elapsed');
    const invocations = observations.filter(
      ({ observationKind }) => observationKind === 'invocation',
    );
    const allocations = observations.filter(
      ({ observationKind }) => observationKind === 'allocation',
    );
    const sessions = observations.filter(({ observationKind }) => observationKind === 'session');
    const acceptedCount = outcomes.filter(({ status }) => status === 'accepted').length;
    const trial = observations.find(({ observationKind }) => observationKind === 'trial');
    if (trial === undefined) throw new Error('expected one exported trial observation');
    const totalElapsedMs =
      Date.parse(String(trial['endedAt'])) - Date.parse(String(trial['startedAt']));
    const phaseElapsedMs = elapsed.reduce(
      (total, observation) => total + Number(observation['elapsedMs']),
      0,
    );
    const chargedAmountMicros = [...invocations, ...allocations].reduce(
      (total, observation) => total + Number(observation['chargedAmountMicros']),
      0,
    );
    const aggregateSessionElapsedMs = sessions.reduce(
      (total, observation) =>
        total +
        (Date.parse(String(observation['endedAt'])) - Date.parse(String(observation['startedAt']))),
      0,
    );

    expect(acceptedCount).toBe(1);
    expect(phaseElapsedMs).toBe(150_000);
    expect(chargedAmountMicros).toBe(375);
    expect(aggregateSessionElapsedMs).toBe(1_200_000);
    expect(sessions.map(({ status }) => status)).toEqual(['completed', 'censored']);
    expect(invocations.map(({ status }) => status)).toEqual(['completed', 'failed', 'censored']);
    expect(elapsed.map(({ phase }) => phase)).toEqual([
      'discovery',
      'execution',
      'gate',
      'human',
      'waiting',
    ]);
    expect(exported.outcomesCsv).toContain(
      '"trial.fixture.1","outcome.alpha","Alpha, accepted once","accepted",2,0',
    );
    expect(exported.trialsCsv).toContain(
      `"trial.fixture.1","experiment.fixture.v1","8762efd964830d2aab9f7951249aac2fad77bc4df9af2789d1f0be7965195554","corpus.fixture.v1","acceptance.fixture.v1",2,"censored",${String(acceptedCount)},${String(outcomes.length)},${String(totalElapsedMs)},${String(aggregateSessionElapsedMs)},"USD:${String(chargedAmountMicros)}"`,
    );
  });

  test('is deterministic across report input order', () => {
    const first = submission();
    const secondJournal = trialJournal();
    secondJournal.trialId = 'trial.fixture.2';
    secondJournal.repeat = 2;
    secondJournal.sessions.forEach((session) => {
      session.sessionId = `${session.sessionId}.second`;
    });
    secondJournal.attempts.forEach((attempt) => {
      attempt.sessionId = `${attempt.sessionId}.second`;
    });
    secondJournal.elapsedReceipts.forEach((receipt) => {
      receipt.trialId = secondJournal.trialId;
    });
    secondJournal.allocationReceipts.forEach((receipt) => {
      receipt.trialId = secondJournal.trialId;
    });
    const second = submission(secondJournal);

    expect(exportTrialEvidence([second, first])).toEqual(exportTrialEvidence([first, second]));
  });

  test('refuses an internally inconsistent report before export', () => {
    const inflated = submission();
    inflated.report.acceptedOutcomeCount = 2;
    const unprovenAcceptance = submission();
    Reflect.deleteProperty(unprovenAcceptance.report.outcomes[0], 'acceptanceArtifact');
    const tamperedTotals = submission();
    tamperedTotals.report.totalElapsedMs = 1;
    tamperedTotals.report.aggregateSessionElapsedMs = 2;
    tamperedTotals.report.phaseElapsedMs = [{ phase: 'waiting', elapsedMs: 3 }];
    tamperedTotals.report.currencyCharges = [{ currency: 'USD', chargedAmountMicros: 0 }];
    const duplicateOutcome = submission();
    duplicateOutcome.report.outcomes.push(structuredClone(duplicateOutcome.report.outcomes[0]));

    expect(() => exportTrialEvidence([inflated])).toThrow('accepted outcome accounting');
    expect(() => exportTrialEvidence([unprovenAcceptance])).toThrow('acceptanceArtifact');
    expect(() => exportTrialEvidence([tamperedTotals])).toThrow('inconsistent trial elapsed');
    expect(() => exportTrialEvidence([duplicateOutcome])).toThrow(
      'trial report outcome identities must be unique',
    );
  });

  test('reconciles export against the complete journal so failed work cannot be excised', () => {
    const missingFailed = submission();
    missingFailed.report.attempts = missingFailed.report.attempts.filter(
      ({ attemptId }) => attemptId !== 'attempt.alpha.2',
    );
    missingFailed.report.sessions[0].attemptIds = ['attempt.alpha.1'];
    missingFailed.report.outcomes[0].attemptIds = ['attempt.alpha.1'];
    missingFailed.report.invocationReceipts = missingFailed.report.invocationReceipts.filter(
      ({ receiptId }) => receiptId !== 'receipt.invocation.alpha.2',
    );
    missingFailed.report.elapsedReceipts = missingFailed.report.elapsedReceipts.filter(
      ({ receiptId }) => receiptId !== 'receipt.gate.alpha',
    );
    missingFailed.report.phaseElapsedMs = missingFailed.report.phaseElapsedMs.filter(
      ({ phase }) => phase !== 'gate',
    );
    missingFailed.report.currencyCharges = [{ currency: 'USD', chargedAmountMicros: 325 }];

    expect(() => exportTrialEvidence([missingFailed])).toThrow('differs from complete journal');
  });

  test('strictly rejects caller claims outside the complete journal/report submission', () => {
    const unknownClaim = submission();
    Reflect.set(unknownClaim, 'verificationOverride', true);

    expect(() => exportTrialEvidence([unknownClaim])).toThrow(
      'verificationOverride must be removed',
    );
  });

  test('retains pinned conditions and normalizes every set-like observation collection', () => {
    const firstJournal = trialJournal();
    const changedPromptJournal = trialJournal();
    changedPromptJournal.manifest.execution.promptHash = 'f'.repeat(64);
    changedPromptJournal.manifestIdentity = hashCanonical(changedPromptJournal.manifest);
    const first = submission(firstJournal);
    const permuted = structuredClone(first);
    permuted.report.sessions.reverse();
    permuted.report.sessions.forEach(({ attemptIds }) => attemptIds.reverse());
    permuted.report.outcomes.reverse();
    permuted.report.attempts.reverse();
    permuted.report.attempts.forEach((attempt) => {
      attempt.invocationReceiptIds.reverse();
      attempt.elapsedReceiptIds.reverse();
    });
    permuted.report.invocationReceipts.reverse();
    permuted.report.elapsedReceipts.reverse();
    permuted.report.allocationReceipts.reverse();
    const changedPrompt = submission(changedPromptJournal);

    expect(exportTrialEvidence([permuted])).toEqual(exportTrialEvidence([first]));
    expect(exportTrialEvidence([changedPrompt])).not.toEqual(exportTrialEvidence([first]));
    expect(exportTrialEvidence([changedPrompt]).jsonl).toContain(
      changedPromptJournal.manifestIdentity,
    );
  });
});
