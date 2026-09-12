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
  recordIntegrationCheck,
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
  );
  expect(publishIntegrationRefs(subject.repository, reserved)).toBe(true);
  expect(() =>
    finalizeIntegrationPublication(subject.store, subject.repository, {
      ...reserved,
      candidateTree: subject.base.tree,
    }),
  ).toThrow('published integration commit differs from the checked candidate');
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
  reserveIntegrationPublication(subject.store, subject.repository, checked, commit, 'fenced');
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
  );
  git(subject.repository, ['update-ref', reserved.markerRef, subject.base.commit]);
  expect(() => publishIntegrationRefs(subject.repository, reserved)).toThrow(
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
  subject.store.close();
});
