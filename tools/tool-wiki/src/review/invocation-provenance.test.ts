import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import {
  FileInvocationJournal,
  type InvocationJournal,
  ProcessReviewInvoker,
  readInvocationJournal,
  type ReviewInvocationResult,
} from './invoker';
import type { ReviewEvidence, ReviewInvocationRequest } from './protocol';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { force: true, recursive: true });
});

function createScratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tool-wiki-review-'));
  scratch.push(path);
  return path;
}

function request(): ReviewInvocationRequest {
  return {
    schemaVersion: 1,
    invocationId: 'invocation.integration-test',
    receiptId: 'receipt.review.integration-test',
    protocol: { protocolId: 'review.cold-informed.v1', protocolBlob: SHA_B },
    subject: {
      subjectId: 'subject.integration-test',
      kind: 'file',
      path: 'src/example.ts',
      contentIdentity: SHA_A,
    },
  };
}

type HarnessMode =
  | 'verified'
  | 'unverified'
  | 'wrong-input'
  | 'wrong-output-invocation'
  | 'wrong-invocation'
  | 'wrong-protocol'
  | 'early-start'
  | 'failed';

function writeHarness(directory: string, mode: HarnessMode = 'verified'): string {
  const path = join(directory, `harness-${mode}.ts`);
  writeFileSync(
    path,
    `import { readFileSync } from 'node:fs';
import { hashCanonical } from '${join(import.meta.dir, '..', 'evidence', 'content-manifest.ts')}';

const journal = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (journal.entries.length !== 1 || journal.entries[0].state !== 'registered') {
  process.stderr.write('invocation was not durably registered before launch\\n');
  process.exit(19);
}
const stdin = await Bun.stdin.text();
const request = JSON.parse(stdin);
const hash = (text) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const rawResponse = 'cold: impact partial\\ninformed: impact yes\\n';
const endedAt = new Date().toISOString();
const cold = {
  sequence: 1,
  judgments: { purpose: 'yes', relationships: 'yes', impact: 'partial' },
  observedReadIds: [request.subject.contentIdentity],
};
const protocolEvidence = {
  schemaVersion: 1,
  protocol: ${mode === 'wrong-protocol' ? `{ ...request.protocol, protocolBlob: '${SHA_A}' }` : 'request.protocol'},
  subject: request.subject,
  cold,
  expansion: {
    sequence: 2,
    coldJudgmentArtifact: hashCanonical(cold),
    suppliedContextIds: ['${SHA_B}'],
  },
  informed: {
    sequence: 3,
    judgments: { purpose: 'yes', relationships: 'yes', impact: 'yes' },
    observedReadIds: [request.subject.contentIdentity, '${SHA_B}'],
  },
};
const telemetry = ${
      mode !== 'unverified'
        ? `{
  status: 'verified',
  receipt: {
    schemaVersion: 1,
    receiptKind: 'invocation',
    receiptId: 'receipt.invocation.integration-test',
    invocationId: ${mode === 'wrong-invocation' ? "'invocation.wrong'" : 'request.invocationId'},
    startedAt: ${mode === 'early-start' ? "'2020-01-01T00:00:00.000Z'" : 'journal.entries[0].registration.registeredAt'},
    endedAt,
    status: '${mode === 'failed' ? 'failed' : 'completed'}',
    executor: { provider: 'openai', model: 'gpt-5', version: '2026-09-10', effort: 'high', toolchain: 'codex' },
    rawUsage: [
      { category: 'input_tokens', quantity: 1200, unit: 'tokens' },
      { category: 'output_tokens', quantity: 300, unit: 'tokens' },
    ],
    priceIdentity: { priceId: 'openai.gpt-5.2026-09-10', provider: 'openai', model: 'gpt-5', currency: 'USD', source: 'provider-receipt' },
    chargedAmountMicros: 25000,
    inputArtifact: ${mode === 'wrong-input' ? `'${SHA_A}'` : 'hash(stdin)'},
    outputArtifact: hash(rawResponse),
  },
  elapsedReceipts: [{
    schemaVersion: 1,
    receiptKind: 'elapsed',
    receiptId: 'receipt.elapsed.integration-test',
    trialId: 'trial.integration-test',
    outcomeId: 'outcome.integration-test',
    attemptId: 'attempt.integration-test',
    phase: 'review',
    startedAt: journal.entries[0].registration.registeredAt,
    endedAt,
    elapsedMs: Date.parse(endedAt) - Date.parse(journal.entries[0].registration.registeredAt),
    status: '${mode === 'failed' ? 'failed' : 'completed'}',
  }],
}`
        : `{ status: 'unverified', reason: 'provider omitted price identity' }`
    };
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  messageKind: 'review-completion',
  invocationId: ${mode === 'wrong-output-invocation' ? "'invocation.wrong-output'" : 'request.invocationId'},
  protocolEvidence,
  actualTools: [
    { toolId: 'read-file', version: '1' },
    { toolId: 'read-file', version: '1' },
    { toolId: 'run-check', version: '2' },
  ],
  rawResponse: { mediaType: 'text/plain', payload: rawResponse, retention: { kind: 'journal-inline' } },
  telemetry,
}) + '\\n');
`,
    'utf8',
  );
  chmodSync(path, 0o755);
  return path;
}

function invoke(
  mode: HarnessMode = 'verified',
  trustScope: 'local-cooperative' | 'trusted-harness' = 'local-cooperative',
) {
  const directory = createScratch();
  const journalPath = join(directory, 'journal.json');
  const journal = FileInvocationJournal.create(journalPath, 'journal.integration-test', trustScope);
  const harnessPath = writeHarness(directory, mode);
  const invoker = new ProcessReviewInvoker(journal, [
    process.execPath,
    'run',
    harnessPath,
    journalPath,
  ]);
  return { directory, journalPath, journal, invocation: invoker.invoke(request()) };
}

function requireVerified(invocation: ReviewInvocationResult): ReviewEvidence {
  if (invocation.status !== 'verified') throw new Error(invocation.reason);
  return invocation.evidence;
}

function runValidation(
  directory: string,
  journalPath: string,
  evidence: ReviewEvidence,
  requirement: 'allow-local' | 'require-external' = 'allow-local',
) {
  const evidencePath = join(directory, `evidence-${crypto.randomUUID()}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      join(import.meta.dir, '..', 'cli.ts'),
      'validate-review-provenance',
      journalPath,
      evidencePath,
      requirement,
    ],
    { cwd: join(import.meta.dir, '..', '..'), stderr: 'pipe', stdout: 'pipe' },
  );
}

function readPipe(bytes: Uint8Array | undefined, name: string): string {
  if (bytes === undefined) throw new Error(`${name} was not piped`);
  return new TextDecoder().decode(bytes);
}

function output(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${readPipe(invocation.stdout, 'stdout')}${readPipe(invocation.stderr, 'stderr')}`;
}

describe('review invocation provenance', () => {
  test('durably registers before launch and retains exact actual receipts and response bytes', () => {
    const { journalPath, invocation } = invoke();
    const evidence = requireVerified(invocation);
    const journal = readInvocationJournal(journalPath);
    const entry = journal.entries[0];

    expect(invocation.status).toBe('verified');
    expect(entry.state).toBe('completed');
    if (entry.state !== 'completed') throw new Error('expected completed invocation');
    expect(entry.registration.stdinArtifact).toBe(
      new Bun.CryptoHasher('sha256').update(entry.registration.stdinBytes).digest('hex'),
    );
    expect(entry.registration.stdinBytes).toBe(
      `{"invocationId":"invocation.integration-test","protocol":{"protocolBlob":"${SHA_B}","protocolId":"review.cold-informed.v1"},"receiptId":"receipt.review.integration-test","schemaVersion":1,"subject":{"contentIdentity":"${SHA_A}","kind":"file","path":"src/example.ts","subjectId":"subject.integration-test"}}\n`,
    );
    expect(entry.completion.stdoutArtifact).toBe(
      new Bun.CryptoHasher('sha256').update(entry.completion.stdoutBytes).digest('hex'),
    );
    expect(entry.completion.actualTools).toEqual([
      { toolId: 'read-file', version: '1' },
      { toolId: 'read-file', version: '1' },
      { toolId: 'run-check', version: '2' },
    ]);
    expect(evidence.receipt.rawUsage).toEqual([
      { category: 'input_tokens', quantity: 1200, unit: 'tokens' },
      { category: 'output_tokens', quantity: 300, unit: 'tokens' },
    ]);
    expect(evidence.receipt.priceIdentity).toEqual({
      priceId: 'openai.gpt-5.2026-09-10',
      provider: 'openai',
      model: 'gpt-5',
      currency: 'USD',
      source: 'provider-receipt',
    });
    expect(evidence.receipt.executor).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      version: '2026-09-10',
      effort: 'high',
      toolchain: 'codex',
    });
    expect(entry.completion.telemetry.status).toBe('verified');
    if (entry.completion.telemetry.status !== 'verified') {
      throw new Error('expected verified telemetry');
    }
    expect(entry.completion.telemetry.receipt.chargedAmountMicros).toBe(25000);
    expect(entry.completion.telemetry.elapsedReceipts).toHaveLength(1);
    expect(entry.completion.telemetry.elapsedReceipts[0]).toMatchObject({
      phase: 'review',
      status: 'completed',
    });
    expect(entry.completion.telemetry.elapsedReceipts[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(entry.completion.rawResponse.payload).toContain('impact partial');
  });

  test('rejects forged provenance and preserves cold uncertainty through the production CLI', () => {
    const { directory, journalPath, invocation } = invoke();
    const evidence = requireVerified(invocation);
    const cases: { name: string; mutate: (copy: ReviewEvidence) => void; expected: string }[] = [
      {
        name: 'forged-invocation',
        mutate: (copy) => {
          copy.receipt.invocationId = 'invocation.forged';
        },
        expected: 'unknown invocation',
      },
      {
        name: 'altered-response',
        mutate: (copy) => {
          copy.receipt.rawResponseArtifact = 'f'.repeat(64);
          copy.rawResponse.artifact = 'f'.repeat(64);
        },
        expected: 'raw response reference differs',
      },
      {
        name: 'erased-reads',
        mutate: (copy) => {
          copy.receipt.observedReadIds = [];
          copy.protocolEvidence.cold.observedReadIds = [];
          copy.protocolEvidence.informed.observedReadIds = [];
          copy.protocolEvidence.expansion.coldJudgmentArtifact = hashCanonical(
            copy.protocolEvidence.cold,
          );
        },
        expected: 'observed reads differ',
      },
      {
        name: 'rewritten-cold',
        mutate: (copy) => {
          copy.protocolEvidence.cold.judgments.impact = 'yes';
          copy.protocolEvidence.expansion.coldJudgmentArtifact = hashCanonical(
            copy.protocolEvidence.cold,
          );
        },
        expected: 'cold judgment differs',
      },
      {
        name: 'forged-tools',
        mutate: (copy) => {
          copy.actualTools = [{ toolId: 'invented-tool', version: '9' }];
        },
        expected: 'review evidence differs',
      },
    ];

    for (const validationCase of cases) {
      const forged = structuredClone(evidence);
      validationCase.mutate(forged);
      const invocation = runValidation(directory, journalPath, forged);
      expect(invocation.exitCode, `${validationCase.name}: ${output(invocation)}`).toBe(1);
      expect(output(invocation)).toContain(validationCase.expected);
    }

    const localOnly = runValidation(directory, journalPath, evidence, 'require-external');
    expect(localOnly.exitCode, output(localOnly)).toBe(1);
    expect(output(localOnly)).toContain('local-cooperative cannot satisfy external provenance');
  });

  test('makes completion idempotent only for the same terminal observation', () => {
    const { journal, journalPath } = invoke();
    const completed = readInvocationJournal(journalPath).entries[0];
    if (completed.state !== 'completed') throw new Error('expected completed invocation');

    expect(() => journal.register(completed.registration)).toThrow('already registered');
    expect(() => {
      journal.complete('invocation.forged', completed.completion);
    }).toThrow('unknown invocation');
    expect(() => {
      journal.complete(completed.registration.invocationId, completed.completion);
    }).not.toThrow();
    const missingEvidence = structuredClone(completed.completion);
    missingEvidence.evidence = null;
    expect(() => {
      journal.complete(completed.registration.invocationId, missingEvidence);
    }).toThrow('evidence exactly when completed telemetry is verified');
    const changed = structuredClone(completed.completion);
    changed.actualTools.push({ toolId: 'another-tool', version: '1' });
    expect(() => {
      journal.complete(completed.registration.invocationId, changed);
    }).toThrow('different terminal completion');
  });

  test('does not launch after a journal accepts a different invocation identity', () => {
    const rejectingJournal: InvocationJournal = {
      journalId: 'journal.wrong-acceptance',
      trustScope: 'local-cooperative',
      register: (registration) => ({
        status: 'durable',
        journalId: 'journal.wrong-acceptance',
        invocationId: 'invocation.wrong-acceptance',
        registrationArtifact: hashCanonical(registration),
      }),
      complete: () => {
        throw new Error('completion must not be reached');
      },
      read: () => {
        throw new Error('read must not be reached');
      },
    };
    const invoker = new ProcessReviewInvoker(rejectingJournal, ['not-a-real-harness']);

    expect(() => invoker.invoke(request())).toThrow('did not durably accept');
  });

  test('refuses harness identity, request and time claims at their registered boundaries', () => {
    const cases: { mode: HarnessMode; expected: string }[] = [
      { mode: 'wrong-input', expected: 'inputArtifact differs' },
      { mode: 'wrong-output-invocation', expected: 'differs from registered' },
      { mode: 'wrong-invocation', expected: 'telemetry invocation differs' },
      { mode: 'wrong-protocol', expected: 'protocol or subject differs' },
      { mode: 'early-start', expected: 'starts before durable' },
    ];

    for (const validationCase of cases) {
      expect(() => invoke(validationCase.mode)).toThrow(validationCase.expected);
    }
  });

  test('distinguishes missing, unreadable and malformed invocation journals', () => {
    const directory = createScratch();
    const absent = join(directory, 'absent.json');
    const malformed = join(directory, 'malformed.json');
    const unreadable = join(directory, 'unreadable.json');
    writeFileSync(malformed, '{', 'utf8');
    writeFileSync(unreadable, '{}\n', { encoding: 'utf8', mode: 0o000 });

    expect(() => readInvocationJournal(absent)).toThrow('cannot read invocation journal');
    expect(() => readInvocationJournal(unreadable)).toThrow('cannot read invocation journal');
    expect(() => readInvocationJournal(malformed)).toThrow('malformed JSON');
  });

  test('refuses journal records whose exact stdin or stdout byte identities were rewritten', () => {
    const first = invoke();
    const changedInput = structuredClone(readInvocationJournal(first.journalPath));
    changedInput.entries[0].registration.stdinArtifact = 'f'.repeat(64);
    writeFileSync(first.journalPath, `${JSON.stringify(changedInput)}\n`, 'utf8');

    expect(() => readInvocationJournal(first.journalPath)).toThrow('stdinArtifact');

    const second = invoke();
    const changedOutput = structuredClone(readInvocationJournal(second.journalPath));
    const completed = changedOutput.entries[0];
    if (completed.state !== 'completed') throw new Error('expected completed invocation');
    completed.completion.stdoutArtifact = 'f'.repeat(64);
    writeFileSync(second.journalPath, `${JSON.stringify(changedOutput)}\n`, 'utf8');

    expect(() => readInvocationJournal(second.journalPath)).toThrow('stdoutArtifact');

    const third = invoke();
    const duplicate = structuredClone(readInvocationJournal(third.journalPath));
    duplicate.entries.push(duplicate.entries[0]);
    writeFileSync(third.journalPath, `${JSON.stringify(duplicate)}\n`, 'utf8');

    expect(() => readInvocationJournal(third.journalPath)).toThrow('unique invocationId');

    const fourth = invoke();
    const changedJournal = structuredClone(readInvocationJournal(fourth.journalPath));
    changedJournal.journalId = 'journal.replaced';
    writeFileSync(fourth.journalPath, `${JSON.stringify(changedJournal)}\n`, 'utf8');

    expect(() => fourth.journal.read()).toThrow('journal identity changed');
  });

  test('classifies configured external provenance without selecting a trust policy', () => {
    const { directory, journalPath, invocation } = invoke('verified', 'trusted-harness');
    const validation = runValidation(
      directory,
      journalPath,
      requireVerified(invocation),
      'require-external',
    );

    expect(validation.exitCode, output(validation)).toBe(0);
    expect(JSON.parse(readPipe(validation.stdout, 'stdout')) as unknown).toEqual({
      status: 'verified',
      scope: 'trusted-harness',
      satisfiesExternal: true,
    });
  });

  test('refuses incomplete and unverified journal observations through the production CLI', () => {
    const verified = invoke();
    const evidence = requireVerified(verified.invocation);
    const completed = readInvocationJournal(verified.journalPath).entries[0];
    const directory = createScratch();
    const registeredPath = join(directory, 'registered.json');
    const registered = FileInvocationJournal.create(
      registeredPath,
      'journal.registered-only',
      'local-cooperative',
    );
    registered.register(completed.registration);

    const incomplete = runValidation(directory, registeredPath, evidence);
    expect(incomplete.exitCode, output(incomplete)).toBe(1);
    expect(output(incomplete)).toContain('invocation is not complete');

    const unverified = invoke('unverified');
    const unverifiable = runValidation(directory, unverified.journalPath, evidence);
    expect(unverifiable.exitCode, output(unverifiable)).toBe(1);
    expect(output(unverifiable)).toContain('invocation telemetry is unverified');
  });

  test('returns explicit unverified telemetry without manufacturing a review receipt', () => {
    const { invocation, journalPath } = invoke('unverified');

    expect(invocation).toEqual({
      status: 'unverified',
      invocationId: 'invocation.integration-test',
      reason: 'provider omitted price identity',
    });
    const completed = readInvocationJournal(journalPath).entries[0];
    if (completed.state !== 'completed') throw new Error('expected completed invocation');
    expect(completed.completion.telemetry).toEqual({
      status: 'unverified',
      reason: 'provider omitted price identity',
    });
    expect(JSON.stringify(completed)).not.toContain('chargedAmountMicros":0');
  });

  test('retains failed invocation telemetry without turning it into review evidence', () => {
    const { invocation, journalPath } = invoke('failed');

    expect(invocation).toEqual({
      status: 'unverified',
      invocationId: 'invocation.integration-test',
      reason: 'invocation status failed',
    });
    const completed = readInvocationJournal(journalPath).entries[0];
    if (completed.state !== 'completed') throw new Error('expected completed invocation');
    expect(completed.completion.telemetry.status).toBe('verified');
    if (completed.completion.telemetry.status !== 'verified') {
      throw new Error('expected retained verified telemetry');
    }
    expect(completed.completion.telemetry.receipt.status).toBe('failed');
    expect(completed.completion.evidence).toBeNull();
  });
});
