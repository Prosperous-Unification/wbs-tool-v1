import { describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { decodeHarnessOutput, type ReviewProtocolEvidence } from './protocol';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function protocolEvidence(): ReviewProtocolEvidence {
  const cold = {
    sequence: 1 as const,
    judgments: {
      purpose: 'yes' as const,
      relationships: 'partial' as const,
      impact: 'no' as const,
    },
    observedReadIds: [SHA_A],
  };
  return {
    schemaVersion: 1,
    protocol: { protocolId: 'review.cold-informed.v1', protocolBlob: SHA_B },
    subject: {
      subjectId: 'subject.protocol-test',
      kind: 'file',
      path: 'src/example.ts',
      contentIdentity: SHA_A,
    },
    cold,
    expansion: {
      sequence: 2,
      coldJudgmentArtifact: hashCanonical(cold),
      suppliedContextIds: [SHA_B],
    },
    informed: {
      sequence: 3,
      judgments: { purpose: 'yes', relationships: 'yes', impact: 'yes' },
      observedReadIds: [SHA_A, SHA_B],
    },
  };
}

function verifiedOutput() {
  const evidence = protocolEvidence();
  const rawResponse = 'cold: relationships partial, impact no\ninformed: all yes\n';
  return {
    schemaVersion: 1,
    messageKind: 'review-completion',
    invocationId: 'invocation.protocol-test',
    protocolEvidence: evidence,
    actualTools: [
      { toolId: 'read-file', version: '1' },
      { toolId: 'read-file', version: '1' },
      { toolId: 'run-check', version: '2' },
    ],
    rawResponse: {
      mediaType: 'text/plain',
      payload: rawResponse,
      retention: { kind: 'journal-inline' },
    },
    telemetry: {
      status: 'verified',
      receipt: {
        schemaVersion: 1,
        receiptKind: 'invocation',
        receiptId: 'receipt.invocation.protocol-test',
        invocationId: 'invocation.protocol-test',
        startedAt: '2026-09-11T07:00:00.000Z',
        endedAt: '2026-09-11T07:01:00.000Z',
        status: 'completed',
        executor: {
          provider: 'openai',
          model: 'gpt-5',
          version: '2026-09-10',
          effort: 'high',
          toolchain: 'codex',
        },
        rawUsage: [
          { category: 'input_tokens', quantity: 1200, unit: 'tokens' },
          { category: 'output_tokens', quantity: 300, unit: 'tokens' },
        ],
        priceIdentity: {
          priceId: 'openai.gpt-5.2026-09-10',
          provider: 'openai',
          model: 'gpt-5',
          currency: 'USD',
          source: 'provider-receipt',
        },
        chargedAmountMicros: 25000,
        inputArtifact: SHA_C,
        outputArtifact: new Bun.CryptoHasher('sha256').update(rawResponse).digest('hex'),
      },
      elapsedReceipts: [
        {
          schemaVersion: 1,
          receiptKind: 'elapsed',
          receiptId: 'receipt.elapsed.protocol-test',
          trialId: 'trial.protocol-test',
          outcomeId: 'outcome.protocol-test',
          attemptId: 'attempt.protocol-test',
          phase: 'review',
          startedAt: '2026-09-11T07:00:00.000Z',
          endedAt: '2026-09-11T07:01:00.000Z',
          elapsedMs: 60000,
          status: 'completed',
        },
      ],
    },
  };
}

describe('cold/informed review protocol', () => {
  test('retains cold uncertainty separately when informed expansion reaches yes', () => {
    const decoded = decodeHarnessOutput(verifiedOutput());

    expect(decoded.protocolEvidence.cold.judgments).toEqual({
      purpose: 'yes',
      relationships: 'partial',
      impact: 'no',
    });
    expect(decoded.protocolEvidence.informed.judgments).toEqual({
      purpose: 'yes',
      relationships: 'yes',
      impact: 'yes',
    });
    expect(decoded.actualTools).toEqual(verifiedOutput().actualTools);
    expect(decoded.telemetry.status).toBe('verified');
    if (decoded.telemetry.status !== 'verified') throw new Error('expected verified telemetry');
    expect(decoded.telemetry.elapsedReceipts).toHaveLength(1);
    expect(decoded.telemetry.elapsedReceipts[0]).toMatchObject({
      receiptKind: 'elapsed',
      phase: 'review',
      elapsedMs: 60000,
    });
  });

  test('refuses an expansion that does not bind the exact frozen cold judgment', () => {
    const output = verifiedOutput();
    output.protocolEvidence.expansion.coldJudgmentArtifact = SHA_C;

    expect(() => decodeHarnessOutput(output)).toThrow('coldJudgmentArtifact');
  });

  test('refuses verified telemetry that does not identify its exact response or elapsed time', () => {
    const wrongResponse = verifiedOutput();
    wrongResponse.telemetry.receipt.outputArtifact = SHA_A;
    const missingElapsed = verifiedOutput();
    missingElapsed.telemetry.elapsedReceipts = [];

    expect(() => decodeHarnessOutput(wrongResponse)).toThrow('outputArtifact');
    expect(() => decodeHarnessOutput(missingElapsed)).toThrow('elapsed receipt');
  });

  test('models absent required telemetry without fabricated usage, prices or charges', () => {
    const output = verifiedOutput();
    const unverified = {
      ...output,
      telemetry: {
        status: 'unverified' as const,
        reason: 'provider omitted price identity',
      },
    };

    const decoded = decodeHarnessOutput(unverified);

    expect(decoded.telemetry).toEqual({
      status: 'unverified',
      reason: 'provider omitted price identity',
    });
    expect(decoded.telemetry).not.toHaveProperty('receipt');

    expect(() =>
      decodeHarnessOutput({
        ...unverified,
        telemetry: { ...unverified.telemetry, chargedAmountMicros: 0 },
      }),
    ).toThrow('chargedAmountMicros must be removed');
  });

  test('requires a real retention horizon for externally retained raw responses', () => {
    const output = verifiedOutput();
    Reflect.set(output.rawResponse, 'retention', {
      kind: 'external',
      artifactUri: 's3://review-evidence/raw-response.txt',
      retainedUntil: '2026-02-30T00:00:00.000Z',
    });

    expect(() => decodeHarnessOutput(output)).toThrow('retainedUntil');
  });
});
