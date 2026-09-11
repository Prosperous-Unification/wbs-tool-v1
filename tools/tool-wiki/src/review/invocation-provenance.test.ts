import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import {
  type ColdAcknowledgement,
  FileInvocationJournal,
  FileJournalLock,
  type InvocationRegistration,
  type InvocationTerminal,
  ProcessReviewInvoker,
  readInvocationJournal,
  type ReviewInvocationResult,
} from './invoker';
import type { ReviewEvidence, ReviewInvocationRequest } from './protocol';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { force: true, recursive: true });
});

function createScratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tool-wiki-review-'));
  scratch.push(path);
  return path;
}

function request(invocationId = 'invocation.integration-test'): ReviewInvocationRequest {
  return {
    schemaVersion: 1,
    invocationId,
    receiptId: `receipt.review.${invocationId}`,
    protocol: { protocolId: 'review.cold-informed.v1', protocolBlob: SHA_B },
    subject: {
      subjectId: 'subject.integration-test',
      kind: 'file',
      path: 'src/example.ts',
      contentIdentity: SHA_A,
    },
    informedContextIds: [SHA_C],
  };
}

type HarnessMode =
  | 'verified'
  | 'cold-unverified'
  | 'cold-nonzero'
  | 'cold-signaled'
  | 'cold-malformed'
  | 'cold-wrong-protocol'
  | 'cold-wrong-telemetry-invocation'
  | 'informed-nonzero'
  | 'informed-signaled'
  | 'informed-malformed';

function writeHarness(directory: string, mode: HarnessMode = 'verified'): string {
  const path = join(directory, `harness-${mode}.ts`);
  const tracePath = join(directory, 'trace.txt');
  writeFileSync(
    path,
    `import { appendFileSync, readFileSync } from 'node:fs';
const journal = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const stdin = await Bun.stdin.text();
const request = JSON.parse(stdin);
const phase = request.messageKind === 'cold-request' ? 'cold' : 'informed';
appendFileSync('${tracePath}', phase + '\\n');
if (phase === 'cold') {
  if (journal.entries.length !== 1 || journal.entries[0].state !== 'registered') {
    process.stderr.write('cold was not registered before launch\\n');
    process.exit(19);
  }
  if ('informedContextIds' in request || stdin.includes('${SHA_C}')) {
    process.stderr.write('cold received informed context\\n');
    process.exit(31);
  }
} else if (journal.entries[0].state !== 'cold-acknowledged') {
  process.stderr.write('informed launched before cold acknowledgement\\n');
  process.exit(29);
}
const hash = (bytes) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const startedAt = new Date().toISOString();
const endedAt = startedAt;
const rawResponse = phase === 'cold' ? 'cold: impact partial\\n' : 'informed: impact yes\\n';
const telemetry = ${
      mode === 'cold-unverified'
        ? `phase === 'cold' ? {
  status: 'unverified',
  reason: 'provider omitted price identity',
  missingRequirements: ['priceIdentity'],
  observed: {
    provider: 'openai', model: 'gpt-5', rawUsage: [{ category: 'input_tokens', quantity: 700, unit: 'tokens' }],
    chargedAmountMicros: 11000, startedAt, endedAt,
  },
} :`
        : ''
    } {
  status: 'verified',
  receipt: {
    schemaVersion: 1, receiptKind: 'invocation',
    receiptId: 'receipt.invocation.' + phase,
    invocationId: '${mode}' === 'cold-wrong-telemetry-invocation' && phase === 'cold' ? 'invocation.forged' : request.invocationId,
    startedAt, endedAt, status: 'completed',
    executor: { provider: 'openai', model: 'gpt-5', version: '2026-09-10', effort: 'high', toolchain: 'codex' },
    rawUsage: [{ category: phase + '_input_tokens', quantity: phase === 'cold' ? 700 : 500, unit: 'tokens' }],
    priceIdentity: { priceId: 'openai.gpt-5.2026-09-10', provider: 'openai', model: 'gpt-5', currency: 'USD', source: 'provider-receipt' },
    chargedAmountMicros: phase === 'cold' ? 11000 : 14000,
    inputArtifact: hash(stdin), outputArtifact: hash(rawResponse),
  },
  elapsedReceipts: [{
    schemaVersion: 1, receiptKind: 'elapsed', receiptId: 'receipt.elapsed.' + phase,
    trialId: 'trial.integration-test', outcomeId: 'outcome.integration-test', attemptId: 'attempt.' + phase,
    phase: 'review', startedAt, endedAt, elapsedMs: 0, status: 'completed',
  }],
};
if (('${mode}' === 'cold-malformed' && phase === 'cold') || ('${mode}' === 'informed-malformed' && phase === 'informed')) {
  process.stderr.write('malformed cold json\\n');
  process.stdout.write('{');
} else if (('${mode}' === 'cold-signaled' && phase === 'cold') || ('${mode}' === 'informed-signaled' && phase === 'informed')) {
  process.stdout.write(phase + ' stdout before SIGTERM\\n');
  process.stderr.write(phase + ' stderr before SIGTERM\\n');
  process.kill(process.pid, 'SIGTERM');
} else {
  const output = phase === 'cold' ? {
    schemaVersion: 1, messageKind: 'cold-completion', invocationId: request.invocationId,
    protocol: request.protocol, subject: request.subject,
    cold: { sequence: 1, judgments: { purpose: 'yes', relationships: 'yes', impact: 'partial' }, observedReadIds: [request.subject.contentIdentity] },
    actualTools: [{ toolId: 'read-file', version: '1' }, { toolId: 'read-file', version: '1' }],
    rawResponse: { mediaType: 'text/plain', payload: rawResponse, retention: { kind: 'journal-inline' } }, telemetry,
  } : {
    schemaVersion: 1, messageKind: 'informed-completion', invocationId: request.invocationId,
    protocol: request.protocol, subject: request.subject, coldArtifact: request.coldArtifact,
    informed: { sequence: 3, judgments: { purpose: 'yes', relationships: 'yes', impact: 'yes' }, observedReadIds: [request.subject.contentIdentity, ...request.informedContextIds] },
    actualTools: [{ toolId: 'run-check', version: '2' }],
    rawResponse: { mediaType: 'text/plain', payload: rawResponse, retention: { kind: 'journal-inline' } }, telemetry,
  };
  if ('${mode}' === 'cold-wrong-protocol' && phase === 'cold') {
    output.protocol.protocolId = 'review.another-protocol.v1';
  }
  process.stdout.write(JSON.stringify(output) + '\\n');
}
if (('${mode}' === 'cold-nonzero' && phase === 'cold') || ('${mode}' === 'informed-nonzero' && phase === 'informed')) {
  process.stderr.write(phase + ' provider failed\\n');
  process.exit(23);
}
`,
    'utf8',
  );
  chmodSync(path, 0o755);
  return path;
}

function invoke(mode: HarnessMode = 'verified', harnessArgv?: string[]) {
  const directory = createScratch();
  const journalPath = join(directory, 'journal.json');
  const journal = FileInvocationJournal.create(journalPath, 'journal.integration-test');
  const harnessPath = writeHarness(directory, mode);
  const invoker = new ProcessReviewInvoker(
    journal,
    harnessArgv ?? [process.execPath, 'run', harnessPath, journalPath],
  );
  return {
    directory,
    journalPath,
    journal,
    tracePath: join(directory, 'trace.txt'),
    invocation: invoker.invoke(request()),
  };
}

function invokeWithIncompleteRuntimeExit(signalCode: '' | undefined) {
  const returned = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `process.stdout.write('unresolved stdout\\n'); process.stderr.write('unresolved stderr\\n')`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const impossible = {
    stdout: returned.stdout,
    stderr: returned.stderr,
    exitCode: null,
    signalCode,
    success: false,
    resourceUsage: returned.resourceUsage,
    pid: returned.pid,
    exitedDueToTimeout: returned.exitedDueToTimeout,
    exitedDueToMaxBuffer: returned.exitedDueToMaxBuffer,
  };
  const spawnSync = Bun.spawnSync;
  Object.defineProperty(Bun, 'spawnSync', { value: () => impossible });
  try {
    const directory = createScratch();
    const journalPath = join(directory, 'journal.json');
    const journal = FileInvocationJournal.create(journalPath, 'journal.integration-test');
    return {
      invocation: new ProcessReviewInvoker(journal, ['not-reached']).invoke(request()),
      journalPath,
    };
  } finally {
    Object.defineProperty(Bun, 'spawnSync', { value: spawnSync });
  }
}

function requireVerified(invocation: ReviewInvocationResult): ReviewEvidence {
  if (invocation.status !== 'verified') throw new Error(invocation.reason);
  return invocation.evidence;
}

function readUnverifiedTerminal(journalPath: string) {
  const entry = readInvocationJournal(journalPath).entries[0];
  if (entry.state !== 'terminal' || entry.terminal.status !== 'unverified') {
    throw new Error('expected unverified terminal');
  }
  return entry as {
    cold?: ColdAcknowledgement;
    terminal: InvocationTerminal & { status: 'unverified' };
  };
}

function readPipe(bytes: Uint8Array | undefined, name: string): string {
  if (bytes === undefined) throw new Error(`${name} was not piped`);
  return new TextDecoder().decode(bytes);
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

function commandOutput(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${readPipe(invocation.stdout, 'stdout')}${readPipe(invocation.stderr, 'stderr')}`;
}

function registerRecord(invocationId: string): InvocationRegistration {
  const invocationRequest = request(invocationId);
  const stdinBytes = serializeCanonical(invocationRequest);
  return {
    invocationId,
    receiptId: invocationRequest.receiptId,
    registeredAt: '2026-09-11T07:00:00.000Z',
    harnessArgv: ['harness'],
    stdinArtifact: hashBytes(stdinBytes),
    stdinBytes,
  };
}

function registrationForBytes(
  invocationId: string,
  receiptId: string,
  stdinBytes: string,
): InvocationRegistration {
  return {
    invocationId,
    receiptId,
    registeredAt: '2026-09-11T07:00:00.000Z',
    harnessArgv: ['harness'],
    stdinArtifact: hashBytes(stdinBytes),
    stdinBytes,
  };
}

function launchFailureTerminal(registration: InvocationRegistration): InvocationTerminal {
  const coldRequest = {
    schemaVersion: 1,
    messageKind: 'cold-request',
    invocationId: registration.invocationId,
    receiptId: registration.receiptId,
    protocol: request(registration.invocationId).protocol,
    subject: request(registration.invocationId).subject,
  };
  const stdinBytes = serializeCanonical(coldRequest);
  const empty = Buffer.alloc(0).toString('base64');
  return {
    status: 'unverified',
    completedAt: '2026-09-11T07:00:01.000Z',
    phase: 'cold',
    reason: 'launch failed: fixture',
    attempt: {
      observation: {
        phase: 'cold',
        startedAt: '2026-09-11T07:00:00.000Z',
        endedAt: '2026-09-11T07:00:01.000Z',
        stdinArtifact: hashBytes(stdinBytes),
        stdinBytes,
        stdoutArtifact: hashBytes(new Uint8Array()),
        stdoutBase64: empty,
        stderrArtifact: hashBytes(new Uint8Array()),
        stderrBase64: empty,
        exit: { kind: 'launch-failed', message: 'fixture' },
      },
      output: null,
      decodeFailure: 'launch failed: fixture',
    },
    evidence: null,
  };
}

function writeWorker(directory: string): string {
  const path = join(directory, 'journal-worker.ts');
  writeFileSync(
    path,
    `import { readFileSync, writeFileSync } from 'node:fs';
import { FileInvocationJournal } from '${join(import.meta.dir, 'invoker.ts')}';
const [journalPath, commandPath, readyPath] = process.argv.slice(2);
const command = JSON.parse(readFileSync(commandPath, 'utf8'));
const journal = FileInvocationJournal.open(journalPath, 5000);
writeFileSync(readyPath, 'ready\\n');
if (command.kind === 'register') journal.register(command.registration);
else journal.complete(command.invocationId, command.terminal);
`,
    'utf8',
  );
  return path;
}

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() > deadline) throw new Error('workers did not become ready');
    await Bun.sleep(10);
  }
}

describe('review invocation provenance', () => {
  test('durably acknowledges cold before informed launch and retains separate phase receipts', () => {
    const { invocation, journalPath, tracePath } = invoke();
    const evidence = requireVerified(invocation);
    const entry = readInvocationJournal(journalPath).entries[0];

    expect(readFileSync(tracePath, 'utf8')).toBe('cold\ninformed\n');
    expect(entry.state).toBe('terminal');
    if (entry.state !== 'terminal' || entry.cold === undefined) {
      throw new Error('expected terminal invocation with cold acknowledgement');
    }
    const coldInput = entry.cold.attempt.observation.stdinBytes;
    expect(coldInput).not.toContain('informedContextIds');
    expect(coldInput).not.toContain(SHA_C);
    expect(entry.cold.attempt.observation.stderrArtifact).toBe(hashBytes(new Uint8Array()));
    expect(entry.terminal.status).toBe('reviewed');
    expect(evidence.phaseReceipts.cold.receipt.chargedAmountMicros).toBe(11000);
    expect(evidence.phaseReceipts.informed.receipt.chargedAmountMicros).toBe(14000);
    expect(evidence.phaseTools.cold).toHaveLength(2);
    expect(evidence.phaseTools.informed).toEqual([{ toolId: 'run-check', version: '2' }]);
    expect(evidence.actualTools).toEqual([
      { toolId: 'read-file', version: '1' },
      { toolId: 'read-file', version: '1' },
      { toolId: 'run-check', version: '2' },
    ]);
  });

  test('never elevates a local journal label to external provenance', () => {
    const { directory, journalPath, invocation } = invoke();
    const evidence = requireVerified(invocation);
    const local = runValidation(directory, journalPath, evidence);
    expect(local.exitCode, commandOutput(local)).toBe(0);
    expect(JSON.parse(readPipe(local.stdout, 'stdout')) as unknown).toEqual({
      status: 'verified',
      scope: 'local-cooperative',
      satisfiesExternal: false,
    });

    const required = runValidation(directory, journalPath, evidence, 'require-external');
    expect(required.exitCode, commandOutput(required)).toBe(1);
    expect(commandOutput(required)).toContain('independently authenticated');

    const relabeled = JSON.parse(readFileSync(journalPath, 'utf8')) as { trustScope: string };
    relabeled.trustScope = 'trusted-harness';
    writeFileSync(journalPath, `${JSON.stringify(relabeled)}\n`, 'utf8');
    const forged = runValidation(directory, journalPath, evidence);
    expect(forged.exitCode, commandOutput(forged)).toBe(1);
  });

  test('rejects post-informed cold mutation even when the local hash is recomputed', () => {
    const { directory, journalPath, invocation } = invoke();
    const evidence = requireVerified(invocation);
    evidence.protocolEvidence.cold.judgments.impact = 'yes';
    evidence.protocolEvidence.expansion.coldJudgmentArtifact = hashCanonical(
      evidence.protocolEvidence.cold,
    );

    const validation = runValidation(directory, journalPath, evidence);
    expect(validation.exitCode, commandOutput(validation)).toBe(1);
    expect(commandOutput(validation)).toContain('cold acknowledgement');
  });

  test('rejects forged invocation, raw-response reference and observed-read evidence', () => {
    const { directory, journalPath, invocation } = invoke();
    const evidence = requireVerified(invocation);

    const forgedInvocation = structuredClone(evidence);
    forgedInvocation.receipt.invocationId = 'invocation.forged';
    const unknown = runValidation(directory, journalPath, forgedInvocation);
    expect(unknown.exitCode, commandOutput(unknown)).toBe(1);
    expect(commandOutput(unknown)).toContain('unknown invocation: invocation.forged');

    const changedReference = structuredClone(evidence);
    changedReference.rawResponse.artifact = SHA_C;
    const response = runValidation(directory, journalPath, changedReference);
    expect(response.exitCode, commandOutput(response)).toBe(1);

    const erasedReads = structuredClone(evidence);
    erasedReads.protocolEvidence.informed.observedReadIds = [];
    erasedReads.receipt.observedReadIds = [...erasedReads.protocolEvidence.cold.observedReadIds];
    const reads = runValidation(directory, journalPath, erasedReads);
    expect(reads.exitCode, commandOutput(reads)).toBe(1);
  });

  test('re-decodes exact stdout before trusting retained payload or telemetry fields', () => {
    const first = invoke();
    const changedPayload = structuredClone(readInvocationJournal(first.journalPath));
    const firstEntry = changedPayload.entries[0];
    if (firstEntry.state !== 'terminal' || firstEntry.terminal.status !== 'reviewed') {
      throw new Error('expected reviewed terminal');
    }
    if (firstEntry.terminal.informed.output === null) throw new Error('expected informed output');
    firstEntry.terminal.informed.output.rawResponse.payload = 'rewritten payload\n';
    if (firstEntry.terminal.informed.output.telemetry.status !== 'verified') {
      throw new Error('expected verified telemetry');
    }
    firstEntry.terminal.informed.output.telemetry.receipt.outputArtifact =
      hashBytes('rewritten payload\n');
    writeFileSync(first.journalPath, `${JSON.stringify(changedPayload)}\n`, 'utf8');
    expect(() => readInvocationJournal(first.journalPath)).toThrow('exact stdout');

    const second = invoke();
    const changedTelemetry = structuredClone(readInvocationJournal(second.journalPath));
    const secondEntry = changedTelemetry.entries[0];
    if (secondEntry.state !== 'terminal' || secondEntry.terminal.status !== 'reviewed') {
      throw new Error('expected reviewed terminal');
    }
    if (secondEntry.terminal.informed.output === null) throw new Error('expected informed output');
    const telemetry = secondEntry.terminal.informed.output.telemetry;
    if (telemetry.status !== 'verified') throw new Error('expected verified telemetry');
    telemetry.receipt.chargedAmountMicros += 1;
    writeFileSync(second.journalPath, `${JSON.stringify(changedTelemetry)}\n`, 'utf8');
    expect(() => readInvocationJournal(second.journalPath)).toThrow('exact stdout');

    const third = invoke();
    const changedStderr = structuredClone(readInvocationJournal(third.journalPath));
    const thirdEntry = changedStderr.entries[0];
    if (thirdEntry.state !== 'terminal' || thirdEntry.terminal.status !== 'reviewed') {
      throw new Error('expected reviewed terminal');
    }
    thirdEntry.terminal.informed.observation.stderrBase64 =
      Buffer.from('rewritten stderr').toString('base64');
    writeFileSync(third.journalPath, `${JSON.stringify(changedStderr)}\n`, 'utf8');
    expect(() => readInvocationJournal(third.journalPath)).toThrow('stderrArtifact');

    const fourth = invoke();
    const changedStdoutIdentity = structuredClone(readInvocationJournal(fourth.journalPath));
    const fourthEntry = changedStdoutIdentity.entries[0];
    if (fourthEntry.state !== 'terminal' || fourthEntry.terminal.status !== 'reviewed') {
      throw new Error('expected reviewed terminal');
    }
    fourthEntry.terminal.informed.observation.stdoutArtifact = SHA_C;
    writeFileSync(fourth.journalPath, `${JSON.stringify(changedStdoutIdentity)}\n`, 'utf8');
    expect(() => readInvocationJournal(fourth.journalPath)).toThrow('stdoutArtifact');

    const fifth = invoke();
    const changedStdinIdentity = structuredClone(readInvocationJournal(fifth.journalPath));
    const fifthEntry = changedStdinIdentity.entries[0];
    if (fifthEntry.state !== 'terminal' || fifthEntry.cold === undefined) {
      throw new Error('expected terminal with cold acknowledgement');
    }
    fifthEntry.cold.attempt.observation.stdinArtifact = SHA_C;
    writeFileSync(fifth.journalPath, `${JSON.stringify(changedStdinIdentity)}\n`, 'utf8');
    expect(() => readInvocationJournal(fifth.journalPath)).toThrow('stdinArtifact');

    const sixth = invoke();
    const changedRegistrationIdentity = structuredClone(readInvocationJournal(sixth.journalPath));
    changedRegistrationIdentity.entries[0].registration.stdinArtifact = SHA_C;
    writeFileSync(sixth.journalPath, `${JSON.stringify(changedRegistrationIdentity)}\n`, 'utf8');
    expect(() => readInvocationJournal(sixth.journalPath)).toThrow('stdinArtifact');
  });

  test('persists a nonzero cold process as an exact terminal attempt', () => {
    const { invocation, journalPath, tracePath } = invoke('cold-nonzero');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    expect(entry.terminal.phase).toBe('cold');
    expect(entry.terminal.attempt.observation.stderrArtifact).toBe(
      hashBytes(Buffer.from(entry.terminal.attempt.observation.stderrBase64, 'base64')),
    );
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\n');
  });

  test('persists malformed cold stdout as an exact terminal attempt', () => {
    const { invocation, journalPath, tracePath } = invoke('cold-malformed');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    expect(entry.terminal.phase).toBe('cold');
    expect(entry.terminal.attempt.output).toBeNull();
    expect(entry.terminal.attempt.observation.stdoutBase64).toBe(
      Buffer.from('{').toString('base64'),
    );
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\n');
  });

  test('persists a cold launch failure as an exact terminal attempt', () => {
    const launched = invoke('verified', ['not-a-real-review-harness']);
    expect(launched.invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(launched.journalPath);
    expect(entry.terminal.attempt.observation.exit.kind).toBe('launch-failed');
    expect(entry.terminal.attempt.observation.stdoutArtifact).toBe(hashBytes(new Uint8Array()));
    expect(entry.terminal.attempt.observation.stderrArtifact).toBe(hashBytes(new Uint8Array()));
  });

  test('persists exact cold streams and signal identity when the harness is terminated', () => {
    const { invocation, journalPath, tracePath } = invoke('cold-signaled');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    const observation = entry.terminal.attempt.observation;
    expect(entry.terminal.phase).toBe('cold');
    expect(observation.stdoutBase64).toBe(
      Buffer.from('cold stdout before SIGTERM\n').toString('base64'),
    );
    expect(observation.stdoutArtifact).toBe(hashBytes(Buffer.from('cold stdout before SIGTERM\n')));
    expect(observation.stderrBase64).toBe(
      Buffer.from('cold stderr before SIGTERM\n').toString('base64'),
    );
    expect(observation.stderrArtifact).toBe(hashBytes(Buffer.from('cold stderr before SIGTERM\n')));
    expect(observation.exit).toEqual({ kind: 'signaled', signalCode: 'SIGTERM' });
    expect(entry.terminal.reason).toContain('SIGTERM');
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\n');
  });

  test('fails closed with retained streams when Bun returns neither exit nor signal', () => {
    const { invocation, journalPath } = invokeWithIncompleteRuntimeExit(undefined);
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    const observation = entry.terminal.attempt.observation;
    expect(entry.terminal.phase).toBe('cold');
    expect(entry.terminal.reason).toContain('neither an exit code nor a signal code');
    expect(observation.exit).toEqual({ kind: 'unresolved', exitCode: null, signalCode: null });
    expect(observation.stdoutBase64).toBe(Buffer.from('unresolved stdout\n').toString('base64'));
    expect(observation.stderrBase64).toBe(Buffer.from('unresolved stderr\n').toString('base64'));
  });

  test('fails closed with retained streams when Bun returns an empty signal', () => {
    const { invocation, journalPath } = invokeWithIncompleteRuntimeExit('');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    const observation = entry.terminal.attempt.observation;
    expect(entry.terminal.phase).toBe('cold');
    expect(entry.terminal.reason).toContain('empty signal code');
    expect(observation.exit).toEqual({ kind: 'unresolved', exitCode: null, signalCode: '' });
    expect(observation.stdoutBase64).toBe(Buffer.from('unresolved stdout\n').toString('base64'));
    expect(observation.stderrBase64).toBe(Buffer.from('unresolved stderr\n').toString('base64'));
  });

  test('persists protocol-invalid cold output and refuses informed launch', () => {
    const { invocation, journalPath, tracePath } = invoke('cold-wrong-protocol');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    expect(entry.terminal.phase).toBe('cold');
    expect(entry.terminal.reason).toContain('protocol, subject or invocation');
    expect(entry.terminal.attempt.output).not.toBeNull();
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\n');
  });

  test('persists telemetry-invalid cold output and refuses informed launch', () => {
    const { invocation, journalPath, tracePath } = invoke('cold-wrong-telemetry-invocation');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    expect(entry.terminal.phase).toBe('cold');
    expect(entry.terminal.reason).toContain('telemetry invocationId');
    expect(entry.terminal.attempt.output).not.toBeNull();
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\n');
  });

  test('persists a nonzero informed process after the cold acknowledgement', () => {
    const { invocation, journalPath, tracePath } = invoke('informed-nonzero');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    expect(entry.cold).toBeDefined();
    expect(entry.terminal.phase).toBe('informed');
    expect(entry.terminal.attempt.output).not.toBeNull();
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\ninformed\n');
  });

  test('persists exact informed streams and signal identity after cold acknowledgement', () => {
    const { invocation, journalPath, tracePath } = invoke('informed-signaled');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    const observation = entry.terminal.attempt.observation;
    expect(entry.cold).toBeDefined();
    expect(entry.terminal.phase).toBe('informed');
    expect(observation.stdoutBase64).toBe(
      Buffer.from('informed stdout before SIGTERM\n').toString('base64'),
    );
    expect(observation.stdoutArtifact).toBe(
      hashBytes(Buffer.from('informed stdout before SIGTERM\n')),
    );
    expect(observation.stderrBase64).toBe(
      Buffer.from('informed stderr before SIGTERM\n').toString('base64'),
    );
    expect(observation.stderrArtifact).toBe(
      hashBytes(Buffer.from('informed stderr before SIGTERM\n')),
    );
    expect(observation.exit).toEqual({ kind: 'signaled', signalCode: 'SIGTERM' });
    expect(entry.terminal.reason).toContain('SIGTERM');
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\ninformed\n');
  });

  test('persists malformed informed stdout after the cold acknowledgement', () => {
    const { invocation, journalPath, tracePath } = invoke('informed-malformed');
    expect(invocation.status).toBe('unverified');
    const entry = readUnverifiedTerminal(journalPath);
    expect(entry.cold).toBeDefined();
    expect(entry.terminal.phase).toBe('informed');
    expect(entry.terminal.attempt.output).toBeNull();
    expect(entry.terminal.attempt.observation.stdoutBase64).toBe(
      Buffer.from('{').toString('base64'),
    );
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\ninformed\n');
  });

  test('retains known partial cold telemetry and never launches informed', () => {
    const { invocation, journalPath, tracePath } = invoke('cold-unverified');
    expect(invocation.status).toBe('unverified');
    const entry = readInvocationJournal(journalPath).entries[0];
    if (entry.state !== 'terminal' || entry.terminal.status !== 'unverified') {
      throw new Error('expected unverified terminal');
    }
    const telemetry = entry.terminal.attempt.output?.telemetry;
    expect(telemetry?.status).toBe('unverified');
    if (telemetry?.status !== 'unverified') throw new Error('expected partial telemetry');
    expect(telemetry.missingRequirements).toEqual(['priceIdentity']);
    expect(telemetry.observed).toMatchObject({
      provider: 'openai',
      model: 'gpt-5',
      rawUsage: [{ category: 'input_tokens', quantity: 700, unit: 'tokens' }],
      chargedAmountMicros: 11000,
    });
    expect(typeof telemetry.observed.endedAt).toBe('string');
    expect(readFileSync(tracePath, 'utf8')).toBe('cold\n');
  });

  test('rejects invalid embedded registration requests without changing durable state', () => {
    const directory = createScratch();
    const journalPath = join(directory, 'journal.json');
    const journal = FileInvocationJournal.create(journalPath, 'journal.registration-preflight');
    const seed = registerRecord('invocation.seed');
    journal.register(seed);
    const snapshot = readFileSync(journalPath);

    const noncanonicalRequest = request('invocation.noncanonical');
    const mismatchedInvocation = {
      ...request('invocation.identity'),
      invocationId: 'invocation.embedded',
    };
    const mismatchedReceipt = {
      ...request('invocation.receipt'),
      receiptId: 'receipt.review.different',
    };
    const invalidRegistrations: readonly {
      registration: InvocationRegistration;
      failure: string;
    }[] = [
      {
        registration: registrationForBytes(
          'invocation.malformed-json',
          'receipt.review.invocation.malformed-json',
          '{',
        ),
        failure: 'registered review request is malformed JSON',
      },
      {
        registration: registrationForBytes(
          'invocation.invalid-schema',
          'receipt.review.invocation.invalid-schema',
          '{}\n',
        ),
        failure: 'Validation failed',
      },
      {
        registration: registrationForBytes(
          noncanonicalRequest.invocationId,
          noncanonicalRequest.receiptId,
          JSON.stringify(noncanonicalRequest),
        ),
        failure: 'registered review request is not exact canonical stdin',
      },
      {
        registration: registrationForBytes(
          'invocation.identity',
          mismatchedInvocation.receiptId,
          serializeCanonical(mismatchedInvocation),
        ),
        failure: 'registered review request identity differs from journal registration',
      },
      {
        registration: registrationForBytes(
          mismatchedReceipt.invocationId,
          'receipt.review.invocation.receipt',
          serializeCanonical(mismatchedReceipt),
        ),
        failure: 'registered review request identity differs from journal registration',
      },
    ];

    for (const invalid of invalidRegistrations) {
      expect(() => journal.register(invalid.registration)).toThrow(invalid.failure);
      expect(readFileSync(journalPath)).toEqual(snapshot);
      expect(readInvocationJournal(journalPath).entries).toEqual([
        { state: 'registered', registration: seed },
      ]);
      expect(existsSync(`${journalPath}.lock`)).toBe(false);
    }

    const later = registerRecord('invocation.later');
    journal.register(later);
    expect(
      readInvocationJournal(journalPath).entries.map(
        ({ registration }) => registration.invocationId,
      ),
    ).toEqual(['invocation.seed', 'invocation.later']);
  });

  test('serializes overlapping registrations without losing either acknowledgement', async () => {
    const directory = createScratch();
    const journalPath = join(directory, 'journal.json');
    FileInvocationJournal.create(journalPath, 'journal.concurrent-register');
    const lock = FileJournalLock.acquire(journalPath, 100);
    const worker = writeWorker(directory);
    const readyPaths = [join(directory, 'ready-a'), join(directory, 'ready-b')];
    const processes = ['a', 'b'].map((suffix, index) => {
      const commandPath = join(directory, `register-${suffix}.json`);
      writeFileSync(
        commandPath,
        JSON.stringify({ kind: 'register', registration: registerRecord(`invocation.${suffix}`) }),
      );
      return Bun.spawn(
        [process.execPath, 'run', worker, journalPath, commandPath, readyPaths[index]],
        { stderr: 'pipe', stdout: 'pipe' },
      );
    });
    await waitForFiles(readyPaths);
    await Bun.sleep(50);
    expect(processes.map((process) => process.exitCode)).toEqual([null, null]);
    lock.release();
    expect(await Promise.all(processes.map((process) => process.exited))).toEqual([0, 0]);
    expect(
      readInvocationJournal(journalPath)
        .entries.map((entry) => entry.registration.invocationId)
        .sort(),
    ).toEqual(['invocation.a', 'invocation.b']);
  });

  test('makes exact completion idempotent and refuses conflicting terminal transitions', () => {
    const directory = createScratch();
    const journalPath = join(directory, 'journal.json');
    const journal = FileInvocationJournal.create(journalPath, 'journal.terminal-safety');
    const registration = registerRecord('invocation.terminal-safety');
    const terminal = launchFailureTerminal(registration);
    if (terminal.status !== 'unverified' || terminal.phase !== 'cold') {
      throw new Error('expected cold unverified fixture');
    }
    journal.register(registration);

    const first = journal.complete(registration.invocationId, terminal);
    const repeated = journal.complete(registration.invocationId, terminal);
    expect(repeated.artifact).toBe(first.artifact);

    expect(() =>
      journal.complete(registration.invocationId, {
        ...terminal,
        completedAt: '2026-09-11T07:00:02.000Z',
      }),
    ).toThrow('different terminal completion');
    expect(() =>
      journal.acknowledgeCold(registration.invocationId, {
        acknowledgedAt: '2026-09-11T07:00:02.000Z',
        attempt: terminal.attempt,
      }),
    ).toThrow('after terminal invocation');
  });

  test('serializes overlapping completions and enforces lock ownership without stealing stale locks', async () => {
    const directory = createScratch();
    const journalPath = join(directory, 'journal.json');
    const journal = FileInvocationJournal.create(journalPath, 'journal.concurrent-complete');
    const registrations = [registerRecord('invocation.a'), registerRecord('invocation.b')];
    for (const registration of registrations) journal.register(registration);
    const lock = FileJournalLock.acquire(journalPath, 100);
    const ownerPath = join(`${journalPath}.lock`, 'owner');
    const owner = readFileSync(ownerPath, 'utf8');
    writeFileSync(ownerPath, 'different-owner\n', 'utf8');
    expect(() => {
      lock.release();
    }).toThrow('ownership changed');
    expect(existsSync(`${journalPath}.lock`)).toBe(true);
    writeFileSync(ownerPath, owner, 'utf8');

    const worker = writeWorker(directory);
    const readyPaths = [join(directory, 'complete-a'), join(directory, 'complete-b')];
    const processes = registrations.map((registration, index) => {
      const commandPath = join(directory, `complete-${String(index)}.json`);
      writeFileSync(
        commandPath,
        JSON.stringify({
          kind: 'complete',
          invocationId: registration.invocationId,
          terminal: launchFailureTerminal(registration),
        }),
      );
      return Bun.spawn(
        [process.execPath, 'run', worker, journalPath, commandPath, readyPaths[index]],
        { stderr: 'pipe', stdout: 'pipe' },
      );
    });
    await waitForFiles(readyPaths);
    await Bun.sleep(50);
    expect(processes.map((process) => process.exitCode)).toEqual([null, null]);
    lock.release();
    expect(await Promise.all(processes.map((process) => process.exited))).toEqual([0, 0]);
    expect(readInvocationJournal(journalPath).entries.map((entry) => entry.state)).toEqual([
      'terminal',
      'terminal',
    ]);

    mkdirSync(`${journalPath}.lock`, { mode: 0o700 });
    writeFileSync(ownerPath, 'stale-owner\n', 'utf8');
    expect(() =>
      FileInvocationJournal.open(journalPath, 20).register(registerRecord('invocation.c')),
    ).toThrow('timed out waiting for invocation journal lock');
    expect(readFileSync(ownerPath, 'utf8')).toBe('stale-owner\n');
    rmSync(`${journalPath}.lock`, { force: true, recursive: true });
  });
});
