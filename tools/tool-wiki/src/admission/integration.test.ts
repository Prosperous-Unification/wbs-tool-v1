import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'bun:test';

import { hashBytes, hashCanonical } from '../evidence/content-manifest';
import { readCandidate } from '../inventory/read-candidate';
import { MemoryAuthorityStore, openAuthorityStore } from './authority-store';
import { acquireClaims } from './claims';
import { rejectGeneration } from './generations';
import {
  certifyIntegrationCandidate,
  composeIntegrationCandidate,
  type IntegrationEvidence,
} from './integrate';
import { createAdmissionPacket } from './packet';
import { packetBody, packetBodyBytes, withPacketIdentity } from './packet-codec';
import { submitPacket } from './submit';

const scratch: string[] = [];

afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

function git(repository: string, argv: readonly string[], env?: Record<string, string>): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    env: env === undefined ? undefined : { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) throw new Error(invocation.stderr.toString('utf8'));
  return invocation.stdout.toString('utf8').replace(/\n$/, '');
}

function integrationFixture() {
  const repository = mkdtempSync(join(tmpdir(), 'wiki-integrate-'));
  scratch.push(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  git(repository, ['config', 'user.name', 'Fixture']);
  mkdirSync(join(repository, 'src'));
  writeFileSync(join(repository, 'src', 'producer.ts'), 'export const version = 1;\n');
  writeFileSync(join(repository, 'src', 'consumer.ts'), 'export const consumed = 1;\n');
  writeFileSync(join(repository, 'gate.ts'), 'export const gate = 1;\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '--message', 'base']);
  const root = realpathSync(repository);
  const base = {
    commit: git(root, ['rev-parse', 'HEAD']),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
  };
  const store = openAuthorityStore(root);

  function submission(
    sessionId: string,
    ownedPath: string,
    source: string,
    options: {
      consumedContracts?: string[];
      producedContracts?: string[];
      consumedInterfaces?: string[];
    } = {},
  ) {
    const worktree = join(repository, `.writer-${sessionId}`);
    git(root, ['worktree', 'add', '--quiet', '--detach', worktree, base.commit]);
    const canonical = realpathSync(worktree);
    const token = acquireClaims(store, {
      conflictGroups: [],
      owner: { sessionId, worktreePath: canonical },
      paths: [{ access: 'write', path: ownedPath }],
    });
    const packet = createAdmissionPacket(store, token, canonical, {
      base,
      checks: [`check.${sessionId}`],
      conflictGroups: [],
      consumedContracts: options.consumedContracts ?? [],
      consumedInterfaces: options.consumedInterfaces ?? [],
      evidenceRequirements: [`review.${sessionId}`],
      invariants: ['invariant.combined'],
      mappingIdentity: '2'.repeat(64),
      objective: `Change ${ownedPath}`,
      outcome: `${ownedPath} is changed`,
      ownedPaths: [ownedPath],
      policyIdentity: policy.policyIdentity,
      producedContracts: options.producedContracts ?? [],
      producedInterfaces: [],
      readPaths: [],
    });
    writeFileSync(join(canonical, ownedPath), source);
    git(canonical, ['add', ownedPath]);
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

  return { base, repository: root, store, submission };
}

const policyBody = {
  schemaVersion: 1 as const,
  contractRules: [{ contractId: 'contract.api', requiredConsumerInterfaceIds: ['interface.api'] }],
  mappingIdentity: '2'.repeat(64),
  selectorRules: [
    {
      checks: ['check.trusted-gate'],
      kind: 'path' as const,
      path: 'gate.ts',
      reviews: ['review.trusted-gate'],
    },
    {
      checks: ['check.relationships'],
      kind: 'path' as const,
      path: 'src/consumer.ts',
      reviews: ['review.relationships'],
    },
  ],
};
const policy = { ...policyBody, policyIdentity: hashCanonical(policyBody) };

function receiptsFor(candidate: {
  candidateTree: string;
  contentManifestIdentity: string;
  candidateDiffIdentity: string;
  declarationIdentity: string;
  selectedChecks: readonly string[];
  selectedReviews: readonly string[];
}): IntegrationEvidence {
  const binding = {
    candidateDiffIdentity: candidate.candidateDiffIdentity,
    candidateTree: candidate.candidateTree,
    contentManifestIdentity: candidate.contentManifestIdentity,
    declarationIdentity: candidate.declarationIdentity,
    mappingIdentity: policy.mappingIdentity,
    policyIdentity: policy.policyIdentity,
    selectedChecks: [...candidate.selectedChecks],
    selectedReviews: [...candidate.selectedReviews],
  };
  return {
    ...binding,
    checks: candidate.selectedChecks.map((checkId) => ({
      checkId,
      receipt: {
        candidateManifest: candidate.contentManifestIdentity,
        command: ['bun', 'run', checkId],
        cwdIdentity: 'coordinator',
        elapsedMs: 1,
        endedAt: '2026-09-12T00:00:00.001Z',
        exitCode: 0,
        receiptId: `receipt.${checkId}`,
        receiptKind: 'check' as const,
        resourceLane: 'lane.tool-wiki',
        schemaVersion: 1 as const,
        skips: [],
        startedAt: '2026-09-12T00:00:00.000Z',
        status: 'passed' as const,
        stderrArtifact: hashBytes(''),
        stdoutArtifact: hashBytes('ok'),
        toolIdentity: '9'.repeat(64),
      },
    })),
    reviews: candidate.selectedReviews.map((reviewId) => ({
      receipt: {
        executor: {
          effort: 'high',
          model: 'astra',
          provider: 'fixture',
          toolchain: 'codex',
          version: '1',
        },
        invocationId: `invocation.${reviewId}`,
        observedReadIds: [candidate.contentManifestIdentity],
        priceIdentity: {
          currency: 'USD',
          model: 'astra',
          priceId: 'fixture.price',
          provider: 'fixture',
          source: 'fixture',
        },
        rawResponseArtifact: '8'.repeat(64),
        rawUsage: [{ category: 'input', quantity: 1, unit: 'token' }],
        receiptId: `receipt.${reviewId}`,
        receiptKind: 'review' as const,
        schemaVersion: 1 as const,
        suppliedContextIds: [candidate.contentManifestIdentity],
        trust: { journalId: 'journal.fixture', scope: 'trusted-harness' as const },
      },
      reviewId,
    })),
  };
}

function withReceiptField(receipt: unknown, field: string, value: unknown): unknown {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    throw new Error('fixture receipt is not an object');
  }
  return { ...Object.fromEntries(Object.entries(receipt)), [field]: value };
}

test('composes two immutable submissions into one checked candidate without mutating writers', () => {
  const subject = integrationFixture();
  const producer = subject.submission('producer', 'src/producer.ts', 'export const version = 2;\n');
  const consumer = subject.submission(
    'consumer',
    'src/consumer.ts',
    'export const consumed = 2;\n',
  );
  const writerHeads = [producer, consumer].map(({ worktree }) =>
    git(worktree, ['status', '--porcelain=v1']),
  );
  const coordinatorBefore = {
    head: git(subject.repository, ['rev-parse', 'HEAD']),
    index: git(subject.repository, ['write-tree']),
    status: git(subject.repository, ['status', '--porcelain=v1']),
  };
  const composed = composeIntegrationCandidate(subject.store, subject.repository, {
    policy,
    submissions: [producer, consumer],
  });
  expect(composed.status).toBe('unchecked');
  const reversed = composeIntegrationCandidate(subject.store, subject.repository, {
    policy,
    submissions: [consumer, producer],
  });
  expect(reversed).toEqual(composed);
  expect(composed.selectedChecks).toContain('check.relationships');
  expect(composed.selectedReviews).toContain('review.relationships');
  const checked = certifyIntegrationCandidate(composed, receiptsFor(composed));
  expect(checked.status).toBe('checked');
  expect(checked.candidateTree).not.toBe(subject.base.tree);
  expect(checked.submissions.map(({ sessionId }) => sessionId)).toEqual(['consumer', 'producer']);
  expect(
    [producer, consumer].map(({ worktree }) => git(worktree, ['status', '--porcelain=v1'])),
  ).toEqual(writerHeads);
  expect({
    head: git(subject.repository, ['rev-parse', 'HEAD']),
    index: git(subject.repository, ['write-tree']),
    status: git(subject.repository, ['status', '--porcelain=v1']),
  }).toEqual(coordinatorBefore);
  expect(subject.store.inspect().generations.map(({ status }) => status)).toEqual([
    'submitted',
    'submitted',
  ]);
  subject.store.close();
});

test('requires a contract consumer in the same batch', () => {
  const contractOnly = integrationFixture();
  const producer = contractOnly.submission(
    'producer',
    'src/producer.ts',
    'export const version = 2;\n',
    { producedContracts: ['contract.api'] },
  );
  expect(() =>
    composeIntegrationCandidate(contractOnly.store, contractOnly.repository, {
      policy,
      submissions: [producer],
    }),
  ).toThrow('required consumer is absent from integration batch');
  const consumer = contractOnly.submission(
    'consumer',
    'src/consumer.ts',
    'export const consumed = 2;\n',
    { consumedContracts: ['contract.api'], consumedInterfaces: ['interface.api'] },
  );
  expect(
    composeIntegrationCandidate(contractOnly.store, contractOnly.repository, {
      policy,
      submissions: [producer, consumer],
    }).status,
  ).toBe('unchecked');
  contractOnly.store.close();
});

test('refuses a stale read in the actual combined candidate', () => {
  const subject = integrationFixture();
  const producer = subject.submission('producer', 'src/producer.ts', 'export const version = 2;\n');
  const consumer = subject.submission(
    'consumer',
    'src/consumer.ts',
    'export const consumed = 2;\n',
  );
  const snapshot = readCandidate(subject.repository, {
    kind: 'committed',
    revision: subject.base.commit,
  });
  const dependency = snapshot.entries.find(({ path }) => path === 'src/consumer.ts');
  if (dependency === undefined) throw new Error('fixture consumer dependency is absent');
  const reboundPacket = withPacketIdentity({
    ...packetBody(producer.packet),
    readDependencies: [dependency],
  });
  const reboundState = {
    ...subject.store.inspect(),
    generations: subject.store.inspect().generations.map((generation) =>
      generation.sessionId === producer.packet.sessionId
        ? {
            ...generation,
            claims: [
              ...generation.claims,
              { access: 'read' as const, identity: dependency.path, kind: 'path' as const },
            ],
            packet: {
              packetBytes: packetBodyBytes(reboundPacket),
              packetIdentity: reboundPacket.packetIdentity,
            },
          }
        : generation,
    ),
  };
  const reboundStore = new MemoryAuthorityStore(reboundState);
  expect(() =>
    composeIntegrationCandidate(reboundStore, subject.repository, {
      policy,
      submissions: [{ ...producer, packet: reboundPacket }, consumer],
    }),
  ).toThrow('integration read dependency changed: src/consumer.ts');
  subject.store.close();
});

test('reselects gate evidence and refuses standalone or mismatched receipts', () => {
  const subject = integrationFixture();
  const producer = subject.submission('producer', 'src/producer.ts', 'export const version = 2;\n');
  const standalone = composeIntegrationCandidate(subject.store, subject.repository, {
    policy,
    submissions: [producer],
  });
  const standaloneEvidence = receiptsFor(standalone);
  const gate = subject.submission('gate', 'gate.ts', 'export const gate = 2;\n');
  const composed = composeIntegrationCandidate(subject.store, subject.repository, {
    policy,
    submissions: [producer, gate],
  });
  expect(composed.selectedChecks).toEqual(['check.gate', 'check.producer', 'check.trusted-gate']);
  expect(composed.selectedReviews).toEqual([
    'review.gate',
    'review.producer',
    'review.trusted-gate',
  ]);
  expect(() => certifyIntegrationCandidate(composed, standaloneEvidence)).toThrow(
    'evidence candidate binding mismatch',
  );
  const evidence = receiptsFor(composed);
  const bad = { ...evidence, contentManifestIdentity: hashBytes('standalone') };
  expect(() => certifyIntegrationCandidate(composed, bad)).toThrow(
    'evidence candidate binding mismatch',
  );
  subject.store.close();
});

test('refuses duplicate, stale, identity-mismatched and non-submitted inputs', () => {
  const subject = integrationFixture();
  const one = subject.submission('one', 'src/producer.ts', 'export const version = 2;\n');
  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, {
      policy,
      submissions: [one, one],
    }),
  ).toThrow('duplicate integration session');
  expect(() =>
    composeIntegrationCandidate(subject.store, one.worktree, { policy, submissions: [one] }),
  ).toThrow('coordinator cannot be a source writer worktree');
  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, {
      policy,
      submissions: [{ ...one, patch: new TextEncoder().encode('broken') }],
    }),
  ).toThrow('immutable submission patch identity mismatch');
  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, {
      policy: { ...policy, policyIdentity: '3'.repeat(64) },
      submissions: [one],
    }),
  ).toThrow('integration policy identity mismatch');
  const alternateBody = { ...policyBody, selectorRules: [] };
  const alternatePolicy = { ...alternateBody, policyIdentity: hashCanonical(alternateBody) };
  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, {
      policy: alternatePolicy,
      submissions: [one],
    }),
  ).toThrow('submission policy identity mismatch');
  const remappedPacket = withPacketIdentity({
    ...packetBody(one.packet),
    mappingIdentity: '3'.repeat(64),
  });
  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, {
      policy,
      submissions: [{ ...one, packet: remappedPacket }],
    }),
  ).toThrow('submission mapping identity mismatch');
  rejectGeneration(subject.store, one.token);
  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, { policy, submissions: [one] }),
  ).toThrow('integration generation is not submitted');
  subject.store.close();
});

test('refuses authenticated patch application failure and frozen report mismatch', () => {
  const subject = integrationFixture();
  const one = subject.submission('one', 'src/producer.ts', 'export const version = 2;\n');
  const malformedPatch = new TextEncoder().encode('not a Git patch\n');
  const malformedIdentity = hashBytes(malformedPatch);
  const state = subject.store.inspect();
  const malformedState = {
    ...state,
    generations: state.generations.map((generation) => ({
      ...generation,
      submission:
        generation.submission === undefined
          ? undefined
          : { ...generation.submission, patchIdentity: malformedIdentity },
    })),
  };
  const malformedStore = new MemoryAuthorityStore(malformedState);
  const temporaryIndexesBefore = readdirSync(tmpdir())
    .filter((name) => name.startsWith('wiki-integration-index-'))
    .sort();
  expect(() =>
    composeIntegrationCandidate(malformedStore, subject.repository, {
      policy,
      submissions: [
        {
          ...one,
          patch: malformedPatch,
          report: { ...one.report, patchIdentity: malformedIdentity },
        },
      ],
    }),
  ).toThrow('immutable submission patch cannot be applied');
  expect(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith('wiki-integration-index-'))
      .sort(),
  ).toEqual(temporaryIndexesBefore);

  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, {
      policy,
      submissions: [{ ...one, report: { ...one.report, candidateTree: subject.base.tree } }],
    }),
  ).toThrow('immutable submission candidate identity mismatch');
  subject.store.close();
});

test('certification requires the whole selected receipt set and exact review/check bindings', () => {
  const subject = integrationFixture();
  const gate = subject.submission('gate', 'gate.ts', 'export const gate = 2;\n');
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, {
    policy,
    submissions: [gate],
  });
  const evidence = receiptsFor(candidate);
  expect(() =>
    certifyIntegrationCandidate(candidate, { ...evidence, checks: evidence.checks.slice(1) }),
  ).toThrow('integration check receipt set is incomplete');
  expect(() =>
    certifyIntegrationCandidate(candidate, { ...evidence, reviews: evidence.reviews.slice(1) }),
  ).toThrow('integration review receipt set is incomplete');
  const skipped = evidence.checks.map((entry, index) =>
    index === 0
      ? { ...entry, receipt: withReceiptField(entry.receipt, 'status', 'skipped') }
      : entry,
  );
  expect(() => certifyIntegrationCandidate(candidate, { ...evidence, checks: skipped })).toThrow(
    'integration check receipt does not certify candidate',
  );
  const staleReviews = evidence.reviews.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          receipt: withReceiptField(entry.receipt, 'observedReadIds', ['7'.repeat(64)]),
        }
      : entry,
  );
  expect(() =>
    certifyIntegrationCandidate(candidate, { ...evidence, reviews: staleReviews }),
  ).toThrow('integration review receipt does not certify candidate');
  expect(() =>
    certifyIntegrationCandidate({ ...candidate, candidateTree: subject.base.tree }, evidence),
  ).toThrow('unchecked integration candidate identity mismatch');
  subject.store.close();
});

test('refuses caller-labelled weakened policy bytes before composition', () => {
  const subject = integrationFixture();
  const gate = subject.submission('gate', 'gate.ts', 'export const gate = 2;\n');
  const weakened = { ...policy, selectorRules: [] };
  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, {
      policy: weakened,
      submissions: [gate],
    }),
  ).toThrow('integration policy identity mismatch');
  subject.store.close();
});

test('refuses a caller packet that differs from the authority-bound packet', () => {
  const subject = integrationFixture();
  const one = subject.submission('one', 'src/producer.ts', 'export const version = 2;\n');
  const forged = withPacketIdentity({ ...packetBody(one.packet), outcome: 'A forged outcome' });
  expect(() =>
    composeIntegrationCandidate(subject.store, subject.repository, {
      policy,
      submissions: [{ ...one, packet: forged }],
    }),
  ).toThrow('integration packet differs from authority binding');
  subject.store.close();
});
