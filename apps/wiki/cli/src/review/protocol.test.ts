import { describe, expect, test } from 'bun:test';

import { hashBytes, hashCanonical } from '../evidence/content-manifest';
import {
  type ColdHarnessOutput,
  decodeColdHarnessOutput,
  decodeInformedHarnessOutput,
  type InformedHarnessOutput,
} from './protocol';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function verifiedTelemetry(rawResponse: string, receiptId: string) {
  return {
    status: 'verified' as const,
    receipt: {
      schemaVersion: 1 as const,
      receiptKind: 'invocation' as const,
      receiptId,
      invocationId: 'invocation.protocol-test',
      startedAt: '2026-09-11T07:00:00.000Z',
      endedAt: '2026-09-11T07:01:00.000Z',
      status: 'completed' as const,
      executor: {
        provider: 'openai',
        model: 'gpt-5',
        version: '2026-09-10',
        effort: 'high',
        toolchain: 'codex',
      },
      rawUsage: [{ category: 'input_tokens', quantity: 1200, unit: 'tokens' }],
      priceIdentity: {
        priceId: 'openai.gpt-5.2026-09-10',
        provider: 'openai',
        model: 'gpt-5',
        currency: 'USD',
        source: 'provider-receipt',
      },
      chargedAmountMicros: 12500,
      inputArtifact: SHA_C,
      outputArtifact: hashBytes(rawResponse),
    },
    elapsedReceipts: [
      {
        schemaVersion: 1 as const,
        receiptKind: 'elapsed' as const,
        receiptId: `receipt.elapsed.${receiptId}`,
        trialId: 'trial.protocol-test',
        outcomeId: 'outcome.protocol-test',
        attemptId: `attempt.${receiptId}`,
        phase: 'review' as const,
        startedAt: '2026-09-11T07:00:00.000Z',
        endedAt: '2026-09-11T07:01:00.000Z',
        elapsedMs: 60000,
        status: 'completed' as const,
      },
    ],
  };
}

function coldOutput(): ColdHarnessOutput {
  const rawResponse = 'cold: relationships partial, impact no\n';
  return {
    schemaVersion: 1,
    messageKind: 'cold-completion',
    invocationId: 'invocation.protocol-test',
    protocol: { protocolId: 'review.cold-informed.v1', protocolBlob: SHA_B },
    subject: {
      subjectId: 'subject.protocol-test',
      kind: 'file',
      locator: { kind: 'path', path: 'src/example.ts' },
      contentIdentity: SHA_A,
    },
    cold: {
      sequence: 1,
      judgments: { purpose: 'yes', relationships: 'partial', impact: 'no' },
      observedReadIds: [SHA_A],
    },
    actualTools: [
      { toolId: 'read-file', version: '1' },
      { toolId: 'read-file', version: '1' },
    ],
    rawResponse: {
      mediaType: 'text/plain',
      payload: rawResponse,
      retention: { kind: 'journal-inline' },
    },
    telemetry: verifiedTelemetry(rawResponse, 'receipt.invocation.cold'),
  };
}

function informedOutput(coldArtifact = hashCanonical(coldOutput().cold)): InformedHarnessOutput {
  const rawResponse = 'informed: all yes\n';
  return {
    schemaVersion: 1,
    messageKind: 'informed-completion',
    invocationId: 'invocation.protocol-test',
    protocol: coldOutput().protocol,
    subject: coldOutput().subject,
    coldArtifact,
    informed: {
      sequence: 3,
      judgments: { purpose: 'yes', relationships: 'yes', impact: 'yes' },
      observedReadIds: [SHA_A, SHA_B],
    },
    actualTools: [{ toolId: 'run-check', version: '2' }],
    rawResponse: {
      mediaType: 'text/plain',
      payload: rawResponse,
      retention: { kind: 'journal-inline' },
    },
    telemetry: verifiedTelemetry(rawResponse, 'receipt.invocation.informed'),
  };
}

describe('cold/informed review protocol', () => {
  test('repository root is explicit and limited to directory and project subjects', () => {
    const rootDirectory = structuredClone(coldOutput()) as unknown as {
      subject: Record<string, unknown>;
    };
    Reflect.deleteProperty(rootDirectory.subject, 'path');
    rootDirectory.subject['kind'] = 'directory';
    rootDirectory.subject['locator'] = { kind: 'repository-root' };

    expect(decodeColdHarnessOutput(rootDirectory).subject).toMatchObject({
      kind: 'directory',
      locator: { kind: 'repository-root' },
    });

    rootDirectory.subject['kind'] = 'file';
    expect(() => decodeColdHarnessOutput(rootDirectory)).toThrow(
      'repository root is meaningful only for directory and project subjects',
    );
  });

  test('decodes cold and informed phases as separate receipts and tool sequences', () => {
    const cold = decodeColdHarnessOutput(coldOutput());
    const informed = decodeInformedHarnessOutput(informedOutput(hashCanonical(cold.cold)));

    expect(cold.cold.judgments.impact).toBe('no');
    expect(informed.informed.judgments.impact).toBe('yes');
    expect(cold.actualTools).toHaveLength(2);
    expect(informed.actualTools).toEqual([{ toolId: 'run-check', version: '2' }]);
    expect(cold.telemetry.status).toBe('verified');
    expect(informed.telemetry.status).toBe('verified');
  });

  test('retains known partial telemetry while naming missing requirements', () => {
    const output = coldOutput();
    output.telemetry = {
      status: 'unverified',
      reason: 'provider omitted price identity',
      missingRequirements: ['priceIdentity'],
      observed: {
        provider: 'openai',
        model: 'gpt-5',
        rawUsage: [{ category: 'input_tokens', quantity: 1200, unit: 'tokens' }],
        chargedAmountMicros: 12500,
        startedAt: '2026-09-11T07:00:00.000Z',
        endedAt: '2026-09-11T07:01:00.000Z',
      },
    };

    expect(decodeColdHarnessOutput(output).telemetry).toEqual(output.telemetry);
  });

  test('keeps the informed cold identity explicit for durable-boundary reconciliation', () => {
    expect(() => decodeInformedHarnessOutput(informedOutput(SHA_C))).not.toThrow();
    expect(informedOutput(SHA_C).coldArtifact).not.toBe(hashCanonical(coldOutput().cold));
  });

  test('refuses verified phase telemetry that does not identify its exact raw response', () => {
    const output = coldOutput();
    if (output.telemetry.status !== 'verified') throw new Error('expected verified telemetry');
    output.telemetry.receipt.outputArtifact = SHA_A;

    expect(() => decodeColdHarnessOutput(output)).toThrow('outputArtifact');
  });

  test('requires a real retention horizon for externally retained raw responses', () => {
    const output = coldOutput();
    Reflect.set(output.rawResponse, 'retention', {
      kind: 'external',
      artifactUri: 's3://review-evidence/cold.txt',
      retainedUntil: '2026-02-30T00:00:00.000Z',
    });

    expect(() => decodeColdHarnessOutput(output)).toThrow('retainedUntil');
  });
});
