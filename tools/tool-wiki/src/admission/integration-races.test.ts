import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';

import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import {
  MemoryAuthorityStore,
  openAuthorityStore,
  resolveAuthorityDatabasePath,
} from './authority-store';
import { acquireClaims } from './claims';
import { rejectGeneration } from './generations';
import {
  certifyIntegrationCandidate,
  composeIntegrationCandidate,
  type IntegrationEvidence,
  type IntegrationEvidenceVerifier,
  type IntegrationPolicy,
  type SubmittedCandidate,
  type UncheckedIntegrationCandidate,
} from './integrate';
import { createAdmissionPacket } from './packet';
import {
  createIntegrationCommit,
  enqueueIntegration,
  finalizeIntegrationPublication,
  integrateWithRecovery,
  type IntegrationCandidateCertifier,
  type IntegrationResourceProbe,
  publishIntegrationRefs,
  publishReservedIntegration,
  recordIntegrationCheck,
  recordIntegrationRework,
  reserveIntegrationPublication,
} from './publication';
import { submitPacket } from './submit';

const scratch: string[] = [];

afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

function git(
  repository: string,
  argv: readonly string[],
  options: { readonly env?: Record<string, string>; readonly stdin?: string } = {},
): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    env: options.env === undefined ? undefined : { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? undefined : new TextEncoder().encode(options.stdin),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) throw new Error(invocation.stderr.toString('utf8'));
  return invocation.stdout.toString('utf8').trimEnd();
}

const policyBody = {
  checkSpecs: [
    {
      checkId: 'check.integration',
      command: ['bun', 'test', 'integration'],
      cwdIdentity: 'coordinator',
      journalId: 'journal.checks',
      resourceLane: 'lane.tool-wiki',
      toolIdentity: '7'.repeat(64),
    },
  ],
  contractRules: [],
  mappingIdentity: '2'.repeat(64),
  reviewSpecs: [
    {
      executor: {
        effort: 'high',
        model: 'astra',
        provider: 'fixture',
        toolchain: 'codex',
        version: '1',
      },
      journalId: 'journal.reviews',
      reviewId: 'review.integration',
      trustScope: 'trusted-harness' as const,
    },
  ],
  schemaVersion: 1 as const,
  selectorRules: [],
};
const policy: IntegrationPolicy = {
  ...policyBody,
  policyIdentity: hashCanonical(policyBody),
};

function fixture(clock = { now: 1_000 }) {
  const repository = mkdtempSync(join(tmpdir(), 'wiki-integration-race-'));
  scratch.push(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  git(repository, ['config', 'user.name', 'Fixture']);
  mkdirSync(join(repository, 'src'));
  for (const name of ['one', 'two', 'three', 'four', 'five']) {
    writeFileSync(join(repository, 'src', `${name}.ts`), `export const ${name} = 1;\n`);
  }
  writeFileSync(join(repository, 'other.ts'), 'export const other = 1;\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '--message', 'base']);
  git(repository, ['branch', '-M', 'main']);
  const root = realpathSync(repository);
  const base = {
    commit: git(root, ['rev-parse', 'refs/heads/main']),
    tree: git(root, ['rev-parse', 'refs/heads/main^{tree}']),
  };
  const store = openAuthorityStore(root, { clock: { read: () => clock.now } });

  function submission(
    sessionId: string,
    path: string,
    source: string,
  ): SubmittedCandidate & {
    readonly token: ReturnType<typeof acquireClaims>;
    readonly worktree: string;
  } {
    const worktree = join(root, `.writer-${sessionId}`);
    git(root, ['worktree', 'add', '--quiet', '--detach', worktree, base.commit]);
    const canonical = realpathSync(worktree);
    const token = acquireClaims(store, {
      conflictGroups: [],
      owner: { sessionId, worktreePath: canonical },
      paths: [{ access: 'write', path }],
    });
    const packet = createAdmissionPacket(store, token, canonical, {
      base,
      checks: ['check.integration'],
      conflictGroups: [],
      consumedContracts: [],
      consumedInterfaces: [],
      evidenceRequirements: ['review.integration'],
      invariants: ['invariant.integration'],
      mappingIdentity: policy.mappingIdentity,
      objective: `Change ${path}`,
      outcome: `${path} changes`,
      ownedPaths: [path],
      policyIdentity: policy.policyIdentity,
      producedContracts: [],
      producedInterfaces: [],
      readPaths: [],
    });
    writeFileSync(join(canonical, path), source);
    git(canonical, ['add', path]);
    const report = submitPacket(store, packet, canonical, { base: base.commit, kind: 'staged' });
    const patch = Bun.spawnSync(
      [
        'git',
        '-C',
        canonical,
        'diff-tree',
        '--binary',
        '--full-index',
        '--no-renames',
        '--no-ext-diff',
        '--no-color',
        base.tree,
        report.candidateTree,
      ],
      { stderr: 'pipe', stdout: 'pipe' },
    ).stdout;
    return { packet, patch, report, token, worktree: canonical };
  }

  function advance(path = 'other.ts', source: string | null = 'export const other = 2;\n'): string {
    const worktree = join(
      root,
      `.advance-${String(Date.now())}-${Math.random().toString(16).slice(2)}`,
    );
    git(root, ['worktree', 'add', '--quiet', '--detach', worktree, 'refs/heads/main']);
    if (source === null) rmSync(join(worktree, path));
    else writeFileSync(join(worktree, path), source);
    git(worktree, ['add', path]);
    git(worktree, ['commit', '--quiet', '--message', 'advance']);
    const commit = git(worktree, ['rev-parse', 'HEAD']);
    const old = git(root, ['rev-parse', 'refs/heads/main']);
    git(root, ['update-ref', 'refs/heads/main', commit, old]);
    return commit;
  }

  return { advance, base, repository: root, store, submission };
}

function certify(candidate: UncheckedIntegrationCandidate) {
  const checkReceipt = {
    candidateManifest: candidate.compositionIdentity,
    command: ['bun', 'test', 'integration'],
    cwdIdentity: 'coordinator',
    elapsedMs: 1,
    endedAt: '2026-09-12T00:00:00.001Z',
    exitCode: 0,
    receiptId: 'receipt.check.integration',
    receiptKind: 'check' as const,
    resourceLane: 'lane.tool-wiki',
    schemaVersion: 1 as const,
    skips: [],
    startedAt: '2026-09-12T00:00:00.000Z',
    status: 'passed' as const,
    stderrArtifact: hashBytes(''),
    stdoutArtifact: hashBytes('ok'),
    toolIdentity: '7'.repeat(64),
  };
  const reviewReceipt = {
    executor: {
      effort: 'high',
      model: 'astra',
      provider: 'fixture',
      toolchain: 'codex',
      version: '1',
    },
    invocationId: 'invocation.review.integration',
    observedReadIds: [candidate.compositionIdentity],
    priceIdentity: {
      currency: 'USD',
      model: 'astra',
      priceId: 'fixture.price',
      provider: 'fixture',
      source: 'fixture',
    },
    rawResponseArtifact: '8'.repeat(64),
    rawUsage: [{ category: 'input', quantity: 1, unit: 'token' }],
    receiptId: 'receipt.review.integration',
    receiptKind: 'review' as const,
    schemaVersion: 1 as const,
    suppliedContextIds: [candidate.compositionIdentity],
    trust: { journalId: 'journal.reviews', scope: 'trusted-harness' as const },
  };
  const evidence: IntegrationEvidence = {
    candidateDiffIdentity: candidate.candidateDiffIdentity,
    candidateTree: candidate.candidateTree,
    checks: [{ checkId: 'check.integration', receipt: checkReceipt }],
    compositionIdentity: candidate.compositionIdentity,
    contentManifestIdentity: candidate.contentManifestIdentity,
    declarationIdentity: candidate.declarationIdentity,
    mappingIdentity: candidate.mappingIdentity,
    policyIdentity: candidate.policyIdentity,
    reviews: [{ receipt: reviewReceipt, reviewId: 'review.integration' }],
    selectedChecks: ['check.integration'],
    selectedReviews: ['review.integration'],
  };
  const entries = new Map([
    [
      hashBytes(serializeCanonical(checkReceipt)),
      {
        compositionIdentity: candidate.compositionIdentity,
        invocationId: 'invocation.check.integration',
        journalId: 'journal.checks',
        obligationId: 'check.integration',
        receiptIdentity: hashBytes(serializeCanonical(checkReceipt)),
      },
    ],
    [
      hashBytes(serializeCanonical(reviewReceipt)),
      {
        compositionIdentity: candidate.compositionIdentity,
        invocationId: reviewReceipt.invocationId,
        journalId: 'journal.reviews',
        obligationId: 'review.integration',
        receiptIdentity: hashBytes(serializeCanonical(reviewReceipt)),
      },
    ],
  ]);
  const verifier: IntegrationEvidenceVerifier = {
    verifyCheck: ({ receiptBytes }) => {
      const verification = entries.get(hashBytes(receiptBytes));
      if (verification === undefined) throw new Error('unknown check receipt');
      return verification;
    },
    verifyReview: ({ receiptBytes }) => {
      const verification = entries.get(hashBytes(receiptBytes));
      if (verification === undefined) throw new Error('unknown review receipt');
      return verification;
    },
  };
  return certifyIntegrationCandidate(candidate, evidence, verifier);
}

const resources: IntegrationResourceProbe = {
  inspect: ({ compositionIdentity, integrationId, requirementsIdentity }) => ({
    compositionIdentity,
    integrationId,
    probeIdentity: '9'.repeat(64),
    requirementsIdentity,
    unavailable: [],
  }),
};

function options(integrationId: string, certifier: IntegrationCandidateCertifier = { certify }) {
  return {
    certifier,
    commit: {
      authorEmail: 'coordinator@example.invalid',
      authorName: 'Coordinator',
      message: `Integrate ${integrationId}`,
    },
    integrationId,
    resourceProbe: resources,
    resources: [],
    targetRef: 'refs/heads/main',
  };
}

function preparePublication(subject: ReturnType<typeof fixture>, integrationId: string) {
  const submission = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [submission] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options(integrationId));
  const checking = recordIntegrationCheck(subject.store, integrationId, candidate);
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    checking,
    options(integrationId).commit,
  );
  const reserved = reserveIntegrationPublication(
    subject.store,
    subject.repository,
    checked,
    commit,
    integrationId,
    checking.attemptIdentity,
  );
  return { commit, request, reserved, submission };
}

async function captureRejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw new Error('fixture received a non-error rejection', { cause });
  }
  throw new Error('fixture promise resolved unexpectedly');
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`fixture path did not appear: ${path}`);
}

test('target advance while checks are held refuses the old candidate and recomposes exact bytes', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  let releaseChecks: (() => void) | undefined;
  let announceChecks: (() => void) | undefined;
  const checksStarted = new Promise<void>((resolve) => {
    announceChecks = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });
  let checkCount = 0;
  const integration = integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('race', {
      certify: async (candidate) => {
        checkCount += 1;
        if (checkCount === 1) {
          announceChecks?.();
          await held;
        }
        return certify(candidate);
      },
    }),
  );
  await checksStarted;
  const advanced = subject.advance();
  releaseChecks?.();
  const report = await integration;
  expect(report.status).toBe('integrated');
  if (report.status !== 'integrated') throw new Error('fixture integration did not publish');
  expect(report.attempts).toBe(2);
  expect(git(subject.repository, ['rev-parse', `${report.commit}^`])).toBe(advanced);
  expect(git(subject.repository, ['show', `${report.commit}:src/one.ts`])).toBe(
    'export const one = 2;',
  );
  expect(git(subject.repository, ['show', `${report.commit}:other.ts`])).toBe(
    'export const other = 2;',
  );
  subject.store.close();
});

test('a conflicting target advance terminalizes the exact immutable submission', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  let releaseChecks: (() => void) | undefined;
  let announceChecks: (() => void) | undefined;
  const checksStarted = new Promise<void>((resolve) => {
    announceChecks = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });
  const integration = integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('conflicting-advance', {
      certify: async (candidate) => {
        announceChecks?.();
        await held;
        return certify(candidate);
      },
    }),
  );
  await checksStarted;
  const advanced = subject.advance('src/one.ts', 'export const one = 3;\n');
  releaseChecks?.();

  const report = await integration;
  expect(report).toEqual({
    attempts: 1,
    integrationId: 'conflicting-advance',
    queueTimeMs: 0,
    reason: 'incompatible-submission',
    reworkCount: 0,
    status: 'terminal',
  });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(advanced);
  expect(git(one.worktree, ['show', ':src/one.ts'])).toBe('export const one = 2;');
  expect(subject.store.inspect().integrations[0]).toMatchObject({
    attemptCount: 1,
    status: 'terminal',
    submissions: [
      {
        generation: one.packet.generation,
        packetIdentity: one.packet.packetIdentity,
        patchIdentity: one.report.patchIdentity,
        sessionId: one.packet.sessionId,
      },
    ],
    terminalReason: 'incompatible-submission',
  });
  // Proof: without the modeled recomposition-conflict transition this production invocation
  // rejected with `immutable submission patch cannot be applied` and left status `rework`.
  expect(
    await integrateWithRecovery(
      subject.store,
      subject.repository,
      { policy, submissions: [one] },
      options('conflicting-advance', {
        certify: () => {
          throw new Error('terminal recovery reran certification');
        },
      }),
    ),
  ).toEqual(report);
  subject.store.close();
});

test('a target deletion terminalizes the exact immutable submission', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const deleted = subject.advance('src/one.ts', null);

  const report = await integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('deleted-target'),
  );
  expect(report).toEqual({
    attempts: 0,
    integrationId: 'deleted-target',
    queueTimeMs: 0,
    reason: 'incompatible-submission',
    reworkCount: 0,
    status: 'terminal',
  });
  expect(git(subject.repository, ['ls-tree', '--name-only', deleted, 'src/one.ts'])).toBe('');
  expect(git(one.worktree, ['show', ':src/one.ts'])).toBe('export const one = 2;');
  expect(subject.store.inspect().integrations[0]).toMatchObject({
    attemptCount: 0,
    status: 'terminal',
    terminalReason: 'incompatible-submission',
  });
  expect(
    await integrateWithRecovery(
      subject.store,
      subject.repository,
      { policy, submissions: [one] },
      options('deleted-target', {
        certify: () => {
          throw new Error('terminal deletion recovery reran certification');
        },
      }),
    ),
  ).toEqual(report);
  subject.store.close();
});

test('an infrastructure failure during recomposition stays recoverable and is not a conflict', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  let releaseChecks: (() => void) | undefined;
  let announceChecks: (() => void) | undefined;
  const checksStarted = new Promise<void>((resolve) => {
    announceChecks = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });
  const integration = integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('recomposition-infrastructure', {
      certify: async (candidate) => {
        announceChecks?.();
        await held;
        return certify(candidate);
      },
    }),
  );
  await checksStarted;
  const advanced = subject.advance();
  const advancedTree = git(subject.repository, ['rev-parse', `${advanced}^{tree}`]);
  const objectPath = join(
    subject.repository,
    '.git',
    'objects',
    advancedTree.slice(0, 2),
    advancedTree.slice(2),
  );
  const heldObjectPath = `${objectPath}.held`;
  if (!existsSync(objectPath)) throw new Error('advanced tree is not a loose fixture object');
  renameSync(objectPath, heldObjectPath);
  try {
    releaseChecks?.();
    const failure = await captureRejection(() => integration);
    expect(failure.message).toContain('cannot resolve current integration base');
    expect(subject.store.inspect().integrations[0]).toMatchObject({
      attemptCount: 1,
      status: 'rework',
    });
  } finally {
    renameSync(heldObjectPath, objectPath);
  }
  // Proof: broad conflict classification made this missing-tree failure terminal instead of
  // retaining exact immutable submissions in rework for a later successful invocation.
  expect(
    await integrateWithRecovery(
      subject.store,
      subject.repository,
      { policy, submissions: [one] },
      options('recomposition-infrastructure'),
    ),
  ).toMatchObject({ attempts: 2, status: 'integrated' });
  subject.store.close();
});

test('an object read failure inside descendant patch replay stays recoverable', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  let releaseChecks: (() => void) | undefined;
  let announceChecks: (() => void) | undefined;
  const checksStarted = new Promise<void>((resolve) => {
    announceChecks = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });
  const integration = integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('descendant-apply-infrastructure', {
      certify: async (candidate) => {
        announceChecks?.();
        await held;
        return certify(candidate);
      },
    }),
  );
  await checksStarted;
  subject.advance();

  const sourceBlob = git(subject.repository, ['rev-parse', `${subject.base.commit}:src/one.ts`]);
  const objectPath = join(
    subject.repository,
    '.git',
    'objects',
    sourceBlob.slice(0, 2),
    sourceBlob.slice(2),
  );
  const heldObjectPath = `${objectPath}.held`;
  if (!existsSync(objectPath)) throw new Error('source blob is not a loose fixture object');
  const realGit = Bun.which('git');
  if (realGit === null) throw new Error('git executable is absent from the test environment');
  const wrapperDirectory = mkdtempSync(join(tmpdir(), 'wiki-git-wrapper-'));
  scratch.push(wrapperDirectory);
  const invocationCountPath = join(wrapperDirectory, 'apply-count');
  const wrapper = join(wrapperDirectory, 'git');
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv[2] === 'apply') {
  const count = existsSync(${JSON.stringify(invocationCountPath)})
    ? Number(readFileSync(${JSON.stringify(invocationCountPath)}, 'utf8')) + 1
    : 1;
  writeFileSync(${JSON.stringify(invocationCountPath)}, String(count));
  if (count === 2) {
    renameSync(${JSON.stringify(objectPath)}, ${JSON.stringify(heldObjectPath)});
  }
}
const invocation = Bun.spawnSync([${JSON.stringify(realGit)}, ...argv], {
  env: process.env,
  stdin: Bun.stdin,
  stderr: 'inherit',
  stdout: 'inherit',
});
process.exit(invocation.exitCode);
`,
  );
  chmodSync(wrapper, 0o755);
  const originalPath = process.env['PATH'];
  process.env['PATH'] = `${wrapperDirectory}:${originalPath ?? ''}`;
  try {
    releaseChecks?.();
    const failure = await captureRejection(() => integration);
    expect(failure.message).toContain('immutable submission patch cannot be applied');
    expect(failure.message).toContain('error: failed to read src/one.ts');
    expect(subject.store.inspect().integrations[0]).toMatchObject({
      attemptCount: 1,
      status: 'rework',
    });
  } finally {
    process.env['PATH'] = originalPath;
    if (existsSync(heldObjectPath)) renameSync(heldObjectPath, objectPath);
  }
  expect(
    await integrateWithRecovery(
      subject.store,
      subject.repository,
      { policy, submissions: [one] },
      options('descendant-apply-infrastructure'),
    ),
  ).toMatchObject({ attempts: 2, status: 'integrated' });
  subject.store.close();
});

test('the complete candidate submission set must match the durable queue before checks and publication', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const two = subject.submission('two', 'src/two.ts', 'export const two = 2;\n');
  const requestOne = { policy, submissions: [one] };
  const requestTwo = { policy, submissions: [two] };
  const candidateOne = composeIntegrationCandidate(subject.store, subject.repository, requestOne);
  const candidateTwo = composeIntegrationCandidate(subject.store, subject.repository, requestTwo);
  enqueueIntegration(subject.store, requestOne, options('submission-binding-check'));

  expect(() =>
    recordIntegrationCheck(subject.store, 'submission-binding-check', candidateTwo),
  ).toThrow('integration candidate submissions differ from the durable queue');
  expect(
    subject.store
      .inspect()
      .integrations.find(({ integrationId }) => integrationId === 'submission-binding-check'),
  ).toMatchObject({ attemptCount: 0, status: 'queued' });

  enqueueIntegration(subject.store, requestOne, options('submission-binding-reserve'));
  const checking = recordIntegrationCheck(
    subject.store,
    'submission-binding-reserve',
    candidateOne,
  );
  const checked = certify(candidateOne);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    checking,
    options('submission-binding-reserve').commit,
  );
  subject.store.transact((transaction) => {
    const state = transaction.readState();
    transaction.writeState({
      ...state,
      integrations: state.integrations.map((integration) =>
        integration.integrationId === 'submission-binding-reserve'
          ? {
              ...integration,
              submissions: candidateTwo.submissions.map(
                ({ generation, packetIdentity, patchIdentity, sessionId }) => ({
                  generation,
                  packetIdentity,
                  patchIdentity,
                  sessionId,
                }),
              ),
            }
          : integration,
      ),
    });
  });
  expect(() =>
    reserveIntegrationPublication(
      subject.store,
      subject.repository,
      checked,
      commit,
      'submission-binding-reserve',
      checking.attemptIdentity,
    ),
  ).toThrow('integration candidate submissions differ from the durable queue');
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(
    git(subject.repository, ['for-each-ref', '--format=%(refname)', 'refs/wbs-wiki/publications']),
  ).toBe('');
  expect(
    subject.store
      .inspect()
      .integrations.find(({ integrationId }) => integrationId === 'submission-binding-reserve')
      ?.status,
  ).toBe('checking');
  subject.store.close();
});

test('terminal generation transition while checks are held is refused before publication', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  let releaseChecks: (() => void) | undefined;
  let announceChecks: (() => void) | undefined;
  const checksStarted = new Promise<void>((resolve) => {
    announceChecks = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });
  const integration = integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('generation-race', {
      certify: async (candidate) => {
        announceChecks?.();
        await held;
        return certify(candidate);
      },
    }),
  );
  await checksStarted;
  rejectGeneration(subject.store, one.token);
  releaseChecks?.();
  const report = await integration;
  expect(report).toMatchObject({ reason: 'candidate-refused', status: 'terminal' });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(git(one.worktree, ['show', ':src/one.ts'])).toBe('export const one = 2;');
  subject.store.close();
});

test('immutable marker proves publication across a crash and later target advance', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options('crash'));
  const queue = recordIntegrationCheck(subject.store, 'crash', candidate);
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    queue,
    options('crash').commit,
  );
  const reserved = reserveIntegrationPublication(
    subject.store,
    subject.repository,
    checked,
    commit,
    'crash',
    queue.attemptIdentity,
  );
  expect(publishIntegrationRefs(subject.store, subject.repository, reserved)).toBe(true);
  expect(() =>
    finalizeIntegrationPublication(subject.store, subject.repository, {
      ...reserved,
      candidateTree: subject.base.tree,
    }),
  ).toThrow('integration publication reservation changed');
  subject.advance('other.ts', 'export const other = 3;\n');
  const report = finalizeIntegrationPublication(subject.store, subject.repository, reserved);
  expect(report.commit).toBe(commit);
  expect(git(subject.repository, ['rev-parse', reserved.markerRef])).toBe(commit);
  expect(subject.store.inspect().generations[0]?.status).toBe('integrated');
  subject.store.close();
});

test('publishing recovery checks an immutable marker before enforcing the refreshed deadline', async () => {
  const expiredClock = { now: 1_000 };
  const expired = fixture(expiredClock);
  const expiredSubmission = expired.submission('expired', 'src/one.ts', 'export const one = 2;\n');
  const expiredRequest = { policy, submissions: [expiredSubmission] };
  const expiredCandidate = composeIntegrationCandidate(
    expired.store,
    expired.repository,
    expiredRequest,
  );
  enqueueIntegration(expired.store, expiredRequest, options('expired-publication'));
  const expiredChecking = recordIntegrationCheck(
    expired.store,
    'expired-publication',
    expiredCandidate,
  );
  const expiredChecked = certify(expiredCandidate);
  const expiredCommit = createIntegrationCommit(
    expired.repository,
    expiredChecked,
    expiredChecking,
    options('expired-publication').commit,
  );
  reserveIntegrationPublication(
    expired.store,
    expired.repository,
    expiredChecked,
    expiredCommit,
    'expired-publication',
    expiredChecking.attemptIdentity,
  );
  expiredClock.now = 601_000;

  expect(
    await integrateWithRecovery(
      expired.store,
      expired.repository,
      expiredRequest,
      options('expired-publication'),
    ),
  ).toMatchObject({
    attempts: 1,
    queueTimeMs: 600_000,
    reason: 'starvation',
    status: 'terminal',
  });
  expect(git(expired.repository, ['rev-parse', 'refs/heads/main'])).toBe(expired.base.commit);
  expect(
    git(expired.repository, ['for-each-ref', '--format=%(refname)', 'refs/wbs-wiki/publications']),
  ).toBe('');
  expired.store.close();

  const markedClock = { now: 1_000 };
  const marked = fixture(markedClock);
  const markedSubmission = marked.submission('marked', 'src/one.ts', 'export const one = 2;\n');
  const markedRequest = { policy, submissions: [markedSubmission] };
  const markedCandidate = composeIntegrationCandidate(
    marked.store,
    marked.repository,
    markedRequest,
  );
  enqueueIntegration(marked.store, markedRequest, options('marked-publication'));
  const markedChecking = recordIntegrationCheck(
    marked.store,
    'marked-publication',
    markedCandidate,
  );
  const markedChecked = certify(markedCandidate);
  const markedCommit = createIntegrationCommit(
    marked.repository,
    markedChecked,
    markedChecking,
    options('marked-publication').commit,
  );
  const markedReservation = reserveIntegrationPublication(
    marked.store,
    marked.repository,
    markedChecked,
    markedCommit,
    'marked-publication',
    markedChecking.attemptIdentity,
  );
  expect(publishIntegrationRefs(marked.store, marked.repository, markedReservation)).toBe(true);
  markedClock.now = 601_000;
  expect(
    await integrateWithRecovery(
      marked.store,
      marked.repository,
      markedRequest,
      options('marked-publication'),
    ),
  ).toMatchObject({ commit: markedCommit, status: 'integrated' });
  expect(marked.store.inspect().integrations[0]?.status).toBe('published');
  marked.store.close();
});

test('a publication reservation fences terminal lifecycle changes', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options('fenced'));
  const queue = recordIntegrationCheck(subject.store, 'fenced', candidate);
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    queue,
    options('fenced').commit,
  );
  reserveIntegrationPublication(
    subject.store,
    subject.repository,
    checked,
    commit,
    'fenced',
    queue.attemptIdentity,
  );
  const publishing = subject.store
    .inspect()
    .integrations.find(({ integrationId }) => integrationId === 'fenced');
  if (publishing === undefined) throw new Error('publishing fixture record is absent');
  expect(() => recordIntegrationRework(subject.store, publishing)).toThrow(
    'publishing rework requires serialized recovery',
  );
  expect(() => rejectGeneration(subject.store, one.token)).toThrow(
    'generation has a reserved publication',
  );
  expect(subject.store.inspect().generations[0]?.status).toBe('submitted');
  subject.store.close();
});

test('a mismatched publication marker after reservation is refused', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options('marker-mismatch'));
  const queue = recordIntegrationCheck(subject.store, 'marker-mismatch', candidate);
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    queue,
    options('marker-mismatch').commit,
  );
  const reserved = reserveIntegrationPublication(
    subject.store,
    subject.repository,
    checked,
    commit,
    'marker-mismatch',
    queue.attemptIdentity,
  );
  git(subject.repository, ['update-ref', reserved.markerRef, subject.base.commit]);
  expect(() => publishIntegrationRefs(subject.store, subject.repository, reserved)).toThrow(
    'integration publication marker mismatch',
  );
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  subject.store.close();
});

test('a genuinely absent publication marker permits the exact atomic publication', () => {
  const subject = fixture();
  const { commit, reserved } = preparePublication(subject, 'absent-marker');

  expect(publishReservedIntegration(subject.store, subject.repository, reserved)).toMatchObject({
    commit,
    status: 'integrated',
  });
  expect(git(subject.repository, ['rev-parse', reserved.markerRef])).toBe(commit);
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(commit);
  subject.store.close();
});

test('a malformed publication marker is not mistaken for absence', async () => {
  const subject = fixture();
  const { reserved } = preparePublication(subject, 'malformed-marker');
  const markerPath = join(subject.repository, '.git', reserved.markerRef);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, 'not-an-object\n');

  expect(() => publishReservedIntegration(subject.store, subject.repository, reserved)).toThrow(
    `integration refused: cannot determine whether ${reserved.markerRef} exists`,
  );
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(subject.store.inspect().integrations[0]).toMatchObject({
    attemptCount: 1,
    candidateCommit: reserved.candidateCommit,
    markerRef: reserved.markerRef,
    status: 'publishing',
  });
  expect(await Bun.file(markerPath).text()).toBe('not-an-object\n');
  subject.store.close();
});

test('a publication marker read failure preserves the exact publishing reservation', () => {
  const subject = fixture();
  const { reserved } = preparePublication(subject, 'marker-read-failure');
  const gitPath = join(subject.repository, '.git');
  const heldGitPath = join(subject.repository, '.git-held');
  renameSync(gitPath, heldGitPath);
  try {
    expect(() => publishReservedIntegration(subject.store, subject.repository, reserved)).toThrow(
      `integration refused: cannot determine whether ${reserved.markerRef} exists`,
    );
  } finally {
    renameSync(heldGitPath, gitPath);
  }
  // Proof: treating every Git exit 128 as an absent marker advanced to commit validation and
  // reported the wrong boundary; exact absence proof now fails at the production ref lookup.
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(subject.store.inspect().integrations[0]).toMatchObject({
    attemptCount: 1,
    candidateCommit: reserved.candidateCommit,
    markerRef: reserved.markerRef,
    status: 'publishing',
  });
  expect(git(subject.repository, ['for-each-ref', '--format=%(refname)', reserved.markerRef])).toBe(
    '',
  );
  subject.store.close();
});

test('a marker disappearing after exact existence proof is a read failure', () => {
  const subject = fixture();
  const { reserved } = preparePublication(subject, 'marker-read-race');
  git(subject.repository, ['update-ref', reserved.markerRef, reserved.candidateCommit]);
  const realGit = Bun.which('git');
  if (realGit === null) throw new Error('git executable is absent from the test environment');
  const wrapperDirectory = mkdtempSync(join(tmpdir(), 'wiki-git-wrapper-'));
  scratch.push(wrapperDirectory);
  const wrapper = join(wrapperDirectory, 'git');
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun
import { rmSync } from 'node:fs';
const argv = process.argv.slice(2);
const invocation = Bun.spawnSync([${JSON.stringify(realGit)}, ...argv], {
  stderr: 'pipe',
  stdout: 'pipe',
});
await Bun.write(Bun.stdout, invocation.stdout);
await Bun.write(Bun.stderr, invocation.stderr);
if (argv[2] === 'show-ref' && argv[3] === '--exists' && argv[4] === ${JSON.stringify(reserved.markerRef)} && invocation.exitCode === 0) {
  rmSync(${JSON.stringify(join(subject.repository, '.git', reserved.markerRef))});
}
process.exit(invocation.exitCode);
`,
  );
  chmodSync(wrapper, 0o755);
  const originalPath = process.env['PATH'];
  process.env['PATH'] = `${wrapperDirectory}:${originalPath ?? ''}`;
  try {
    expect(() => publishReservedIntegration(subject.store, subject.repository, reserved)).toThrow(
      `integration refused: cannot read ${reserved.markerRef}`,
    );
  } finally {
    process.env['PATH'] = originalPath;
  }
  // Proof: accepting a failed strict value read after the marker's existence was proven let this
  // deletion race proceed past the ref boundary instead of preserving the publishing reservation.
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(subject.store.inspect().integrations[0]).toMatchObject({
    attemptCount: 1,
    candidateCommit: reserved.candidateCommit,
    markerRef: reserved.markerRef,
    status: 'publishing',
  });
  expect(git(subject.repository, ['for-each-ref', '--format=%(refname)', reserved.markerRef])).toBe(
    '',
  );
  subject.store.close();
});

test('an eligible publisher retains its exact attempt across Git ref contention', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const targetLock = join(subject.repository, '.git', 'refs', 'heads', 'main.lock');
  writeFileSync(targetLock, 'held by fixture');

  const blocked = await integrateWithRecovery(
    subject.store,
    subject.repository,
    request,
    options('git-contention'),
  );
  expect(blocked).toMatchObject({
    attempts: 1,
    reason: 'publication-contended',
    status: 'waiting',
  });
  expect(subject.store.inspect().integrations[0]).toMatchObject({
    attemptCount: 1,
    status: 'publishing',
  });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(
    git(subject.repository, ['for-each-ref', '--format=%(refname)', 'refs/wbs-wiki/publications']),
  ).toBe('');

  rmSync(targetLock);
  expect(
    await integrateWithRecovery(
      subject.store,
      subject.repository,
      request,
      options('git-contention'),
    ),
  ).toMatchObject({ attempts: 1, status: 'integrated' });
  subject.store.close();
});

test('a rejecting Git publication hook preserves the exact reservation and throws', () => {
  const subject = fixture();
  const { reserved } = preparePublication(subject, 'publication-hook-rejection');
  const hookDirectory = join(subject.repository, '.git', 'fixture-hooks');
  const hookPath = join(hookDirectory, 'reference-transaction');
  mkdirSync(hookDirectory);
  writeFileSync(
    hookPath,
    '#!/bin/sh\nif [ "$1" = "prepared" ]; then\n  echo "fixture rejected publication" >&2\n  exit 1\nfi\n',
  );
  chmodSync(hookPath, 0o755);
  git(subject.repository, ['config', 'core.hooksPath', hookDirectory]);

  expect(() => publishReservedIntegration(subject.store, subject.repository, reserved)).toThrow(
    /integration refused: cannot atomically publish integration refs:[\s\S]*fixture rejected publication/,
  );
  expect(subject.store.inspect().integrations[0]).toMatchObject({
    attemptCount: 1,
    candidateCommit: reserved.candidateCommit,
    markerRef: reserved.markerRef,
    status: 'publishing',
  });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(git(subject.repository, ['for-each-ref', '--format=%(refname)', reserved.markerRef])).toBe(
    '',
  );
  subject.store.close();
});

test('a competing recovery cannot clear publication while Git holds prepared ref locks', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options('prepared-publication'));
  const checking = recordIntegrationCheck(subject.store, 'prepared-publication', candidate);
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    checking,
    options('prepared-publication').commit,
  );
  const reserved = reserveIntegrationPublication(
    subject.store,
    subject.repository,
    checked,
    commit,
    'prepared-publication',
    checking.attemptIdentity,
  );
  subject.store.close();

  const readyPath = join(subject.repository, '.publication-prepared');
  const releasePath = join(subject.repository, '.publication-release');
  const secondStartedPath = join(subject.repository, '.second-started');
  const secondDonePath = join(subject.repository, '.second-done');
  const hookDirectory = join(subject.repository, '.git', 'fixture-hooks');
  const hookPath = join(hookDirectory, 'reference-transaction');
  mkdirSync(hookDirectory);
  writeFileSync(
    hookPath,
    `#!/bin/sh\nif [ "$1" = "prepared" ]; then\n  : > ${JSON.stringify(
      readyPath,
    )}\n  while [ ! -e ${JSON.stringify(releasePath)} ]; do sleep 0.01; done\nfi\n`,
  );
  chmodSync(hookPath, 0o755);
  git(subject.repository, ['config', 'core.hooksPath', hookDirectory]);

  const payloadPath = join(subject.repository, '.publication-payload.json');
  writeFileSync(
    payloadPath,
    JSON.stringify({
      request: {
        policy,
        submissions: request.submissions.map(({ packet, patch, report }) => ({
          packet,
          patch: [...patch],
          report,
        })),
      },
      reserved,
    }),
  );
  const childPath = join(subject.repository, '.publication-child.ts');
  const authorityModule = join(import.meta.dir, 'authority-store.ts');
  const publicationModule = join(import.meta.dir, 'publication.ts');
  writeFileSync(
    childPath,
    `import { writeFileSync } from 'node:fs';
import { openAuthorityStore } from ${JSON.stringify(authorityModule)};
import { integrateWithRecovery, publishReservedIntegration } from ${JSON.stringify(
      publicationModule,
    )};
const [mode, repository, payloadPath, startedPath, donePath] = Bun.argv.slice(2);
if (mode === undefined || repository === undefined || payloadPath === undefined) {
  throw new Error('publication child arguments are absent');
}
const payload = JSON.parse(await Bun.file(payloadPath).text());
const store = openAuthorityStore(repository, {
  busyDelayMilliseconds: 50,
  clock: { read: () => 1_000 },
  maxBusyAttempts: 100,
});
if (startedPath !== undefined) writeFileSync(startedPath, 'started');
try {
  const report = mode === 'publish'
    ? publishReservedIntegration(store, repository, payload.reserved)
    : await integrateWithRecovery(
        store,
        repository,
        {
          ...payload.request,
          submissions: payload.request.submissions.map((submission) => ({
            ...submission,
            patch: Uint8Array.from(submission.patch),
          })),
        },
        {
          certifier: { certify: () => ({ reason: 'unexpected certification', status: 'failed' }) },
          commit: {
            authorEmail: 'coordinator@example.invalid',
            authorName: 'Coordinator',
            message: 'Integrate prepared-publication',
          },
          integrationId: 'prepared-publication',
          resourceProbe: {
            inspect: ({ compositionIdentity, integrationId, requirementsIdentity }) => ({
              compositionIdentity,
              integrationId,
              probeIdentity: '9'.repeat(64),
              requirementsIdentity,
              unavailable: [],
            }),
          },
          resources: [],
          targetRef: 'refs/heads/main',
        },
      );
  if (donePath !== undefined) writeFileSync(donePath, 'done');
  console.log(JSON.stringify(report));
} finally {
  store.close();
}
`,
  );

  const first = Bun.spawn(
    [process.execPath, childPath, 'publish', subject.repository, payloadPath],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const firstStdout = new Response(first.stdout).text();
  const firstStderr = new Response(first.stderr).text();
  await waitForPath(readyPath);
  const second = Bun.spawn(
    [
      process.execPath,
      childPath,
      'recover',
      subject.repository,
      payloadPath,
      secondStartedPath,
      secondDonePath,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  const secondStdout = new Response(second.stdout).text();
  const secondStderr = new Response(second.stderr).text();
  await waitForPath(secondStartedPath);
  await Bun.sleep(100);
  const secondWasSerialized = !existsSync(secondDonePath);
  writeFileSync(releasePath, 'release');
  const [firstExit, secondExit, firstOutput, secondOutput, firstError, secondError] =
    await Promise.all([
      first.exited,
      second.exited,
      firstStdout,
      secondStdout,
      firstStderr,
      secondStderr,
    ]);

  expect({ firstError, firstExit, secondError, secondExit }).toEqual({
    firstError: '',
    firstExit: 0,
    secondError: '',
    secondExit: 0,
  });
  expect(secondWasSerialized).toBe(true);
  expect(JSON.parse(firstOutput)).toMatchObject({ commit, status: 'integrated' });
  expect(JSON.parse(secondOutput)).toMatchObject({ commit, status: 'integrated' });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(commit);
  expect(git(subject.repository, ['rev-parse', reserved.markerRef])).toBe(commit);
  const reopened = openAuthorityStore(subject.repository, { clock: { read: () => 1_000 } });
  expect(reopened.inspect().integrations[0]?.status).toBe('published');
  expect(reopened.inspect().generations[0]?.status).toBe('integrated');
  reopened.close();
});

test('publication transactions are synchronous and never replay external effects at commit', async () => {
  const subject = fixture();
  const databasePath = resolveAuthorityDatabasePath(subject.repository);
  const readerReady = join(subject.repository, '.publication-reader-ready');
  const reader = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs'; const database = new Database(process.argv[1]); database.run('PRAGMA busy_timeout = 0'); database.run('BEGIN'); database.query('SELECT count(*) FROM authority_generation').get(); writeFileSync(process.argv[2], 'ready'); Bun.sleepSync(80); database.run('ROLLBACK'); database.close();`,
      databasePath,
      readerReady,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  const readerStderr = new Response(reader.stderr).text();
  await waitForPath(readerReady);
  let callbackAttempts = 0;
  expect(
    subject.store.transactPublication((transaction) => {
      callbackAttempts += 1;
      const state = transaction.readState();
      transaction.writeState(state);
      return 'committed';
    }),
  ).toBe('committed');
  expect(await reader.exited).toBe(0);
  expect(await readerStderr).toBe('');
  expect(callbackAttempts).toBe(1);

  expect(() =>
    subject.store.transactPublication(async () => Promise.resolve('not synchronous')),
  ).toThrow('authority transaction callback must be synchronous');
  expect(subject.store.inspect().nextGeneration).toBe(1);
  subject.store.close();
});

test('a preexisting private publication marker cannot collide with a new reservation', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options('marker-collision'));
  const queue = recordIntegrationCheck(subject.store, 'marker-collision', candidate);
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    queue,
    options('marker-collision').commit,
  );
  const publicationMarker = `refs/wbs-wiki/publications/${hashCanonical({
    integrationId: 'marker-collision',
    targetRef: 'refs/heads/main',
  })}`;
  git(subject.repository, ['update-ref', publicationMarker, subject.base.commit]);
  expect(() =>
    reserveIntegrationPublication(
      subject.store,
      subject.repository,
      checked,
      commit,
      'marker-collision',
      queue.attemptIdentity,
    ),
  ).toThrow('integration publication marker already exists');
  subject.store.close();
});

test('publication uses frozen patch bytes and leaves writer and unrelated session files untouched', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const other = subject.submission('other', 'src/two.ts', 'export const two = 2;\n');
  writeFileSync(join(one.worktree, 'src/one.ts'), 'export const one = 99;\n');
  git(one.worktree, ['add', 'src/one.ts']);
  const otherStatus = git(other.worktree, ['status', '--porcelain=v1']);
  const report = await integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('immutable'),
  );
  expect(report.status).toBe('integrated');
  if (report.status !== 'integrated') throw new Error('fixture integration did not publish');
  expect(git(subject.repository, ['show', `${report.commit}:src/one.ts`])).toBe(
    'export const one = 2;',
  );
  expect(git(other.worktree, ['status', '--porcelain=v1'])).toBe(otherStatus);
  expect(
    subject.store.inspect().generations.find(({ sessionId }) => sessionId === 'other')?.status,
  ).toBe('submitted');
  subject.store.close();
});

test('queue caps batches, separates resource prerequisites, and reports starvation', async () => {
  const clock = { now: 1_000 };
  const subject = fixture(clock);
  const submissions = ['one', 'two', 'three', 'four', 'five'].map((name) =>
    subject.submission(name, `src/${name}.ts`, `export const ${name} = 2;\n`),
  );
  const oversized = await captureRejection(() =>
    integrateWithRecovery(
      subject.store,
      subject.repository,
      { policy, submissions },
      options('too-many'),
    ),
  );
  expect(oversized.message).toContain('integration batch exceeds 4 submissions');
  const blockedProbe: IntegrationResourceProbe = {
    inspect: ({ compositionIdentity, integrationId, requirements, requirementsIdentity }) => ({
      compositionIdentity,
      integrationId,
      probeIdentity: '8'.repeat(64),
      requirementsIdentity,
      unavailable: requirements,
    }),
  };
  const blockedOptions = {
    ...options('blocked'),
    resourceProbe: blockedProbe,
    resources: [
      { identity: 'heavy', kind: 'lane' as const },
      { identity: '4200', kind: 'port' as const },
    ],
  };
  const waiting = await integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: submissions.slice(0, 4) },
    blockedOptions,
  );
  expect(waiting).toMatchObject({
    status: 'waiting',
    unavailableResources: blockedOptions.resources,
  });
  if (waiting.status !== 'waiting') throw new Error('fixture did not wait');
  expect(waiting.fileClaimGenerations).toHaveLength(4);
  expect(
    subject.store
      .inspect()
      .generations.flatMap(({ claims }) => claims)
      .some(({ identity }) => identity === 'heavy' || identity === '4200'),
  ).toBe(false);
  const persisted = subject.store.inspect();
  const queued = persisted.integrations[0];
  expect(
    () =>
      new MemoryAuthorityStore({
        ...persisted,
        integrations: [
          {
            ...queued,
            submissions: submissions.map(({ packet, report }) => ({
              generation: packet.generation,
              packetIdentity: packet.packetIdentity,
              patchIdentity: report.patchIdentity,
              sessionId: packet.sessionId,
            })),
          },
        ],
      }),
  ).toThrow('invalid authority integration batch size');
  subject.store.close();
  const reopened = openAuthorityStore(subject.repository, { clock: { read: () => clock.now } });
  clock.now += 300_000;
  const starved = await integrateWithRecovery(
    reopened,
    subject.repository,
    { policy, submissions: submissions.slice(0, 4) },
    blockedOptions,
  );
  expect(starved).toMatchObject({ reason: 'starvation', status: 'terminal' });
  expect(reopened.inspect().generations.every(({ status }) => status === 'submitted')).toBe(true);
  reopened.close();
});

test('resource probe receipts must bind the exact separately modeled prerequisites', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const forgedCandidateProbe: IntegrationResourceProbe = {
    inspect: ({ integrationId, requirementsIdentity }) => ({
      compositionIdentity: '0'.repeat(64),
      integrationId,
      probeIdentity: '8'.repeat(64),
      requirementsIdentity,
      unavailable: [],
    }),
  };
  const forgedCandidate = await captureRejection(() =>
    integrateWithRecovery(
      subject.store,
      subject.repository,
      { policy, submissions: [one] },
      {
        ...options('forged-candidate-resource'),
        resourceProbe: forgedCandidateProbe,
        resources: [{ identity: 'heavy', kind: 'lane' }],
      },
    ),
  );
  expect(forgedCandidate.message).toContain('resource probe receipt does not bind');
  const forgedPrerequisiteProbe: IntegrationResourceProbe = {
    inspect: ({ compositionIdentity, integrationId }) => ({
      compositionIdentity,
      integrationId,
      probeIdentity: '8'.repeat(64),
      requirementsIdentity: '0'.repeat(64),
      unavailable: [],
    }),
  };
  const forgedPrerequisite = await captureRejection(() =>
    integrateWithRecovery(
      subject.store,
      subject.repository,
      { policy, submissions: [one] },
      {
        ...options('forged-prerequisite-resource'),
        resourceProbe: forgedPrerequisiteProbe,
        resources: [{ identity: 'heavy', kind: 'lane' }],
      },
    ),
  );
  expect(forgedPrerequisite.message).toContain('resource probe receipt does not bind');
  expect(subject.store.inspect().generations[0]?.claims).not.toContainEqual({
    identity: 'heavy',
    kind: 'group',
  });
  subject.store.close();
});

test('three failed certifications terminate with exact submissions retained', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const report = await integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('terminal', {
      certify: () => ({ reason: 'check failed', status: 'failed' }),
    }),
  );
  expect(report).toMatchObject({ attempts: 3, reason: 'attempts-exhausted', status: 'terminal' });
  expect(subject.store.inspect().generations[0]).toMatchObject({
    status: 'submitted',
    submission: { patchIdentity: one.report.patchIdentity },
  });
  expect(git(one.worktree, ['status', '--porcelain=v1'])).not.toBe('');
  subject.store.close();
});

test('existing v3 authority state is refused instead of silently defaulting queue history', () => {
  const subject = fixture();
  subject.store.close();
  const database = new Database(resolveAuthorityDatabasePath(subject.repository), { strict: true });
  database
    .query<never, [string]>('UPDATE authority_meta SET schema_version = ? WHERE singleton = 1')
    .run('wbs-wiki-authority.v3');
  database.close();
  expect(() => openAuthorityStore(subject.repository)).toThrow(
    'authority database version is incompatible',
  );
});

test('memory authority refuses partial or mismatched durable integration records', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  enqueueIntegration(subject.store, request, options('malformed'));
  const state = subject.store.inspect();
  const queued = state.integrations[0];
  expect(
    () =>
      new MemoryAuthorityStore({
        ...state,
        integrations: [
          {
            ...queued,
            baseCommit: subject.base.commit,
            compositionIdentity: '7'.repeat(64),
            status: 'checking',
          },
        ],
      }),
  ).toThrow('partial publication fields');
  expect(
    () =>
      new MemoryAuthorityStore({
        ...state,
        integrations: [
          {
            ...queued,
            resources: [
              { identity: 'heavy', kind: 'lane' },
              { identity: 'heavy', kind: 'lane' },
            ],
          },
        ],
      }),
  ).toThrow('duplicate authority integration resource');
  const submission = queued.submissions[0];
  expect(
    () =>
      new MemoryAuthorityStore({
        ...state,
        integrations: [
          {
            ...queued,
            submissions: [{ ...submission, packetIdentity: '6'.repeat(64) }],
          },
        ],
      }),
  ).toThrow('authority integration submission is not retained');
  expect(
    () =>
      new MemoryAuthorityStore({
        ...state,
        integrations: [
          {
            ...queued,
            attemptCount: 1,
            attemptIdentity: '8'.repeat(64),
            baseCommit: subject.base.commit,
            candidateTree: subject.base.tree,
            compositionIdentity: '7'.repeat(64),
            status: 'checking',
          },
          {
            ...queued,
            attemptCount: 1,
            attemptIdentity: '9'.repeat(64),
            baseCommit: subject.base.commit,
            candidateTree: subject.base.tree,
            compositionIdentity: '6'.repeat(64),
            integrationId: 'malformed-other',
            status: 'checking',
          },
        ],
      }),
  ).toThrow('authority generation has competing integrations');
  subject.store.close();
});

test('a wrong-tree or extra-parent candidate commit is refused before refs or lifecycle change', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options('wrong-commit'));
  const queue = recordIntegrationCheck(subject.store, 'wrong-commit', candidate);
  const checked = certify(candidate);
  const unrelatedParent = git(subject.repository, ['commit-tree', subject.base.tree], {
    stdin: 'unrelated parent\n',
  });
  const extraParent = git(
    subject.repository,
    ['commit-tree', candidate.candidateTree, '-p', subject.base.commit, '-p', unrelatedParent],
    { stdin: 'extra parent\n' },
  );
  const wrongTree = git(
    subject.repository,
    ['commit-tree', subject.base.tree, '-p', subject.base.commit],
    { stdin: 'wrong tree\n' },
  );
  const targetBefore = git(subject.repository, ['rev-parse', 'refs/heads/main']);

  expect(() =>
    reserveIntegrationPublication(
      subject.store,
      subject.repository,
      checked,
      extraParent,
      'wrong-commit',
      queue.attemptIdentity,
    ),
  ).toThrow('integration commit differs from the checked candidate');
  expect(() =>
    reserveIntegrationPublication(
      subject.store,
      subject.repository,
      checked,
      wrongTree,
      'wrong-commit',
      queue.attemptIdentity,
    ),
  ).toThrow('integration commit differs from the checked candidate');
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(targetBefore);
  expect(subject.store.inspect().integrations[0]?.status).toBe('checking');
  expect(
    git(subject.repository, ['for-each-ref', '--format=%(refname)', 'refs/wbs-wiki/publications']),
  ).toBe('');

  const publicationMarker = `refs/wbs-wiki/publications/${hashCanonical({
    integrationId: 'wrong-commit',
    targetRef: 'refs/heads/main',
  })}`;
  subject.store.transact((transaction) => {
    const state = transaction.readState();
    transaction.writeState({
      ...state,
      integrations: state.integrations.map((integration) =>
        integration.integrationId === 'wrong-commit'
          ? {
              ...integration,
              candidateCommit: wrongTree,
              markerRef: publicationMarker,
              status: 'publishing',
            }
          : integration,
      ),
    });
  });
  expect(() =>
    publishIntegrationRefs(subject.store, subject.repository, {
      attemptIdentity: queue.attemptIdentity,
      baseCommit: checked.baseCommit,
      candidateCommit: wrongTree,
      candidateTree: checked.candidateTree,
      compositionIdentity: checked.compositionIdentity,
      integrationId: 'wrong-commit',
      markerRef: publicationMarker,
      submissions: queue.submissions,
      targetRef: 'refs/heads/main',
    }),
  ).toThrow('integration commit differs from the checked candidate');
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(targetBefore);
  expect(subject.store.inspect().integrations[0]?.status).toBe('publishing');
  expect(
    git(subject.repository, ['for-each-ref', '--format=%(refname)', 'refs/wbs-wiki/publications']),
  ).toBe('');
  subject.store.close();
});

test('a crafted reservation cannot redirect publication or substitute its checked tree', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options('crafted-reservation'));
  const queue = recordIntegrationCheck(subject.store, 'crafted-reservation', candidate);
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    queue,
    options('crafted-reservation').commit,
  );
  const reserved = reserveIntegrationPublication(
    subject.store,
    subject.repository,
    checked,
    commit,
    'crafted-reservation',
    queue.attemptIdentity,
  );
  git(subject.repository, ['update-ref', 'refs/heads/other', subject.base.commit]);

  expect(() =>
    publishReservedIntegration(subject.store, subject.repository, {
      ...reserved,
      submissions: [],
    }),
  ).toThrow('integration publication reservation changed');
  expect(() =>
    publishReservedIntegration(subject.store, subject.repository, {
      ...reserved,
      targetRef: 'refs/heads/other',
    }),
  ).toThrow('integration publication reservation changed');
  expect(() =>
    publishReservedIntegration(subject.store, subject.repository, {
      ...reserved,
      candidateTree: subject.base.tree,
    }),
  ).toThrow('integration publication reservation changed');
  expect(() =>
    publishReservedIntegration(subject.store, subject.repository, {
      ...reserved,
      attemptIdentity: '0'.repeat(64),
    }),
  ).toThrow('integration publication reservation changed');
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(git(subject.repository, ['rev-parse', 'refs/heads/other'])).toBe(subject.base.commit);
  expect(subject.store.inspect().integrations[0]?.status).toBe('publishing');
  subject.store.close();
});

test('one checking integration fences an overlapping integration without spending its attempt', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  let releaseOwner: (() => void) | undefined;
  let announceOwner: (() => void) | undefined;
  const ownerStarted = new Promise<void>((resolve) => {
    announceOwner = resolve;
  });
  const heldOwner = new Promise<void>((resolve) => {
    releaseOwner = resolve;
  });
  const owner = integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('owner', {
      certify: async (candidate) => {
        announceOwner?.();
        await heldOwner;
        return certify(candidate);
      },
    }),
  );
  await ownerStarted;

  const blocked = await integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('blocked-owner'),
  );
  expect(blocked).toMatchObject({
    attempts: 0,
    blockingIntegrationIds: ['owner'],
    reason: 'submission-reserved',
    status: 'waiting',
  });
  expect(
    subject.store
      .inspect()
      .integrations.find(({ integrationId }) => integrationId === 'blocked-owner')?.attemptCount,
  ).toBe(0);
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  releaseOwner?.();
  expect((await owner).status).toBe('integrated');
  subject.store.close();
});

test('a crashed publisher fences an overlapping integration until exact recovery', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  enqueueIntegration(subject.store, request, options('crashed-owner'));
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  const checking = recordIntegrationCheck(subject.store, 'crashed-owner', candidate);
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    checking,
    options('crashed-owner').commit,
  );
  const reserved = reserveIntegrationPublication(
    subject.store,
    subject.repository,
    checked,
    commit,
    'crashed-owner',
    checking.attemptIdentity,
  );
  expect(publishIntegrationRefs(subject.store, subject.repository, reserved)).toBe(true);

  const blocked = await integrateWithRecovery(
    subject.store,
    subject.repository,
    request,
    options('crash-blocked'),
  );
  expect(blocked).toMatchObject({
    attempts: 0,
    blockingIntegrationIds: ['crashed-owner'],
    reason: 'submission-reserved',
    status: 'waiting',
  });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(commit);
  expect(finalizeIntegrationPublication(subject.store, subject.repository, reserved).commit).toBe(
    commit,
  );
  const refused = await integrateWithRecovery(
    subject.store,
    subject.repository,
    request,
    options('crash-blocked'),
  );
  expect(refused).toMatchObject({
    attempts: 0,
    reason: 'candidate-refused',
    status: 'terminal',
  });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(commit);
  expect(
    subject.store
      .inspect()
      .integrations.find(({ integrationId }) => integrationId === 'crash-blocked')?.status,
  ).toBe('terminal');
  subject.store.close();
});

test('a restarted coordinator fences a durable checking attempt and stale certification', async () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  let releaseStale: (() => void) | undefined;
  let announceStale: (() => void) | undefined;
  let releaseResume: (() => void) | undefined;
  let announceResume: (() => void) | undefined;
  const staleStarted = new Promise<void>((resolve) => {
    announceStale = resolve;
  });
  const heldStale = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  const resumeStarted = new Promise<void>((resolve) => {
    announceResume = resolve;
  });
  const heldResume = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const stale = integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('restart', {
      certify: async (candidate) => {
        announceStale?.();
        await heldStale;
        return certify(candidate);
      },
    }),
  );
  await staleStarted;
  const resumed = integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    options('restart', {
      certify: async (candidate) => {
        announceResume?.();
        await heldResume;
        return certify(candidate);
      },
    }),
  );
  await resumeStarted;
  releaseStale?.();
  expect(await stale).toMatchObject({ reason: 'attempt-fenced', status: 'waiting' });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  expect(subject.store.inspect().integrations[0]?.attemptCount).toBe(2);
  releaseResume?.();
  expect(await resumed).toMatchObject({ attempts: 2, status: 'integrated' });
  subject.store.close();
});

test('a stale attempt identity cannot reserve an equal checked candidate', () => {
  const subject = fixture();
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  const request = { policy, submissions: [one] };
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, request);
  enqueueIntegration(subject.store, request, options('stale-reservation'));
  const stale = recordIntegrationCheck(subject.store, 'stale-reservation', candidate);
  subject.store.transact((transaction) => {
    const state = transaction.readState();
    transaction.writeState({
      ...state,
      integrations: state.integrations.map((integration) =>
        integration.integrationId === 'stale-reservation'
          ? { ...integration, attemptCount: 2, attemptIdentity: '8'.repeat(64) }
          : integration,
      ),
    });
  });
  const checked = certify(candidate);
  const commit = createIntegrationCommit(
    subject.repository,
    checked,
    stale,
    options('stale-reservation').commit,
  );
  expect(() =>
    reserveIntegrationPublication(
      subject.store,
      subject.repository,
      checked,
      commit,
      'stale-reservation',
      stale.attemptIdentity,
    ),
  ).toThrow('integration is not checking this candidate');
  expect(() => recordIntegrationRework(subject.store, stale)).toThrow(
    'integration attempt changed',
  );
  expect(subject.store.inspect().integrations[0]).toMatchObject({
    attemptCount: 2,
    attemptIdentity: '8'.repeat(64),
    status: 'checking',
  });
  expect(git(subject.repository, ['rev-parse', 'refs/heads/main'])).toBe(subject.base.commit);
  subject.store.close();
});

test('held resource and certification runtime count toward the trusted queue deadline', async () => {
  const resourceClock = { now: 1_000 };
  const resourceSubject = fixture(resourceClock);
  const resourceSubmission = resourceSubject.submission(
    'resource',
    'src/one.ts',
    'export const one = 2;\n',
  );
  let announceResource: (() => void) | undefined;
  let releaseResource: (() => void) | undefined;
  const resourceStarted = new Promise<void>((resolve) => {
    announceResource = resolve;
  });
  const resourceHold = new Promise<void>((resolve) => {
    releaseResource = resolve;
  });
  const heldResource: IntegrationResourceProbe = {
    inspect: async ({ compositionIdentity, integrationId, requirements, requirementsIdentity }) => {
      announceResource?.();
      await resourceHold;
      return {
        compositionIdentity,
        integrationId,
        probeIdentity: '9'.repeat(64),
        requirementsIdentity,
        unavailable: requirements,
      };
    },
  };
  const resourceRun = integrateWithRecovery(
    resourceSubject.store,
    resourceSubject.repository,
    { policy, submissions: [resourceSubmission] },
    {
      ...options('resource-expiry'),
      resourceProbe: heldResource,
      resources: [{ identity: 'heavy', kind: 'lane' }],
    },
  );
  await resourceStarted;
  resourceClock.now += 300_000;
  releaseResource?.();
  const resourceExpired = await resourceRun;
  expect(resourceExpired).toMatchObject({
    attempts: 0,
    queueTimeMs: 300_000,
    reason: 'starvation',
    status: 'terminal',
  });
  expect(git(resourceSubject.repository, ['rev-parse', 'refs/heads/main'])).toBe(
    resourceSubject.base.commit,
  );
  resourceSubject.store.close();

  const certificationClock = { now: 1_000 };
  const certificationSubject = fixture(certificationClock);
  const certificationSubmission = certificationSubject.submission(
    'certification',
    'src/one.ts',
    'export const one = 2;\n',
  );
  let announceCertification: (() => void) | undefined;
  let releaseCertification: (() => void) | undefined;
  const certificationStarted = new Promise<void>((resolve) => {
    announceCertification = resolve;
  });
  const certificationHold = new Promise<void>((resolve) => {
    releaseCertification = resolve;
  });
  const certificationRun = integrateWithRecovery(
    certificationSubject.store,
    certificationSubject.repository,
    { policy, submissions: [certificationSubmission] },
    options('certification-expiry', {
      certify: async (candidate) => {
        announceCertification?.();
        await certificationHold;
        return certify(candidate);
      },
    }),
  );
  await certificationStarted;
  certificationClock.now += 300_000;
  releaseCertification?.();
  const certificationExpired = await certificationRun;
  expect(certificationExpired).toMatchObject({
    attempts: 1,
    queueTimeMs: 300_000,
    reason: 'starvation',
    status: 'terminal',
  });
  expect(git(certificationSubject.repository, ['rev-parse', 'refs/heads/main'])).toBe(
    certificationSubject.base.commit,
  );
  certificationSubject.store.close();
});

test('the queue deadline is refreshed between failed attempts', async () => {
  const clock = { now: 1_000 };
  const subject = fixture(clock);
  const one = subject.submission('one', 'src/one.ts', 'export const one = 2;\n');
  let probes = 0;
  const advancingProbe: IntegrationResourceProbe = {
    inspect: ({ compositionIdentity, integrationId, requirementsIdentity }) => {
      probes += 1;
      if (probes === 2) clock.now = 301_001;
      return {
        compositionIdentity,
        integrationId,
        probeIdentity: '9'.repeat(64),
        requirementsIdentity,
        unavailable: [],
      };
    },
  };
  const report = await integrateWithRecovery(
    subject.store,
    subject.repository,
    { policy, submissions: [one] },
    {
      ...options('between-attempts', {
        certify: (candidate) => {
          if (probes === 1) {
            clock.now = 300_999;
            return { reason: 'first attempt failed', status: 'failed' };
          }
          return certify(candidate);
        },
      }),
      resourceProbe: advancingProbe,
    },
  );
  expect(report).toMatchObject({
    attempts: 1,
    queueTimeMs: 300_001,
    reason: 'starvation',
    status: 'terminal',
  });
  expect(probes).toBe(2);
  subject.store.close();
});
