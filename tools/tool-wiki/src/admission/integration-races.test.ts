import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  function advance(path = 'other.ts', source = 'export const other = 2;\n'): string {
    const worktree = join(
      root,
      `.advance-${String(Date.now())}-${Math.random().toString(16).slice(2)}`,
    );
    git(root, ['worktree', 'add', '--quiet', '--detach', worktree, 'refs/heads/main']);
    writeFileSync(join(worktree, path), source);
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

async function captureRejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw new Error('fixture received a non-error rejection', { cause });
  }
  throw new Error('fixture promise resolved unexpectedly');
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
