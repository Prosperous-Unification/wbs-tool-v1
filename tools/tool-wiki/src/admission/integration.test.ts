import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'bun:test';

import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import { readCandidate } from '../inventory/read-candidate';
import { MemoryAuthorityStore, openAuthorityStore } from './authority-store';
import { acquireClaims } from './claims';
import { rejectGeneration } from './generations';
import {
  certifyIntegrationCandidate,
  composeIntegrationCandidate,
  decodeIntegrationPolicy,
  type IntegrationEvidence,
  type IntegrationEvidenceVerifier,
  type VerifiedIntegrationReceipt,
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
  checkSpecs: [
    'check.consumer',
    'check.gate',
    'check.one',
    'check.producer',
    'check.relationships',
    'check.trusted-gate',
  ].map((checkId) => ({
    checkId,
    command: ['bun', 'run', checkId === 'check.trusted-gate' ? 'check.gate' : checkId],
    cwdIdentity: 'coordinator',
    journalId: 'journal.checks',
    resourceLane: 'lane.tool-wiki',
    toolIdentity: '9'.repeat(64),
  })),
  contractRules: [
    {
      contractId: 'contract.api',
      requiredConsumers: [
        {
          implementationSelectors: [{ kind: 'path' as const, path: 'src/consumer.ts' }],
          interfaceId: 'interface.api',
        },
      ],
    },
  ],
  mappingIdentity: '2'.repeat(64),
  reviewSpecs: [
    'review.consumer',
    'review.gate',
    'review.one',
    'review.producer',
    'review.relationships',
    'review.trusted-gate',
  ].map((reviewId) => ({
    executor: {
      effort: 'high',
      model: 'astra',
      provider: 'fixture',
      toolchain: 'codex',
      version: '1',
    },
    journalId: 'journal.reviews',
    reviewId,
    trustScope: 'trusted-harness' as const,
  })),
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
  compositionIdentity: string;
  selectedChecks: readonly string[];
  selectedReviews: readonly string[];
}): IntegrationEvidence {
  const binding = {
    candidateDiffIdentity: candidate.candidateDiffIdentity,
    candidateTree: candidate.candidateTree,
    contentManifestIdentity: candidate.contentManifestIdentity,
    declarationIdentity: candidate.declarationIdentity,
    compositionIdentity: candidate.compositionIdentity,
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
        candidateManifest: candidate.compositionIdentity,
        command:
          policy.checkSpecs.find((specification) => specification.checkId === checkId)?.command ??
          [],
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
        receiptId: `receipt.${reviewId}`,
        receiptKind: 'review' as const,
        schemaVersion: 1 as const,
        suppliedContextIds: [candidate.compositionIdentity],
        trust: { journalId: 'journal.reviews', scope: 'trusted-harness' as const },
      },
      reviewId,
    })),
  };
}

class FixtureEvidenceVerifier implements IntegrationEvidenceVerifier {
  readonly #entries = new Map<string, VerifiedIntegrationReceipt>();

  constructor(candidate: { compositionIdentity: string }, evidence: IntegrationEvidence) {
    for (const check of evidence.checks) {
      const identity = hashBytes(serializeCanonical(check.receipt));
      this.#entries.set(identity, {
        compositionIdentity: candidate.compositionIdentity,
        invocationId: `invocation.${check.checkId}`,
        journalId: 'journal.checks',
        obligationId: check.checkId,
        receiptIdentity: identity,
      });
    }
    for (const review of evidence.reviews) {
      const identity = hashBytes(serializeCanonical(review.receipt));
      const receipt = review.receipt;
      if (typeof receipt !== 'object' || receipt === null || !('invocationId' in receipt)) {
        throw new Error('fixture review invocation is absent');
      }
      const invocationId = Reflect.get(receipt, 'invocationId');
      if (typeof invocationId !== 'string') throw new Error('fixture review invocation is invalid');
      this.#entries.set(identity, {
        compositionIdentity: candidate.compositionIdentity,
        invocationId,
        journalId: 'journal.reviews',
        obligationId: review.reviewId,
        receiptIdentity: identity,
      });
    }
  }

  verifyCheck(request: { receiptBytes: string }): VerifiedIntegrationReceipt {
    return this.#verify(request.receiptBytes);
  }

  verifyReview(request: { receiptBytes: string }): VerifiedIntegrationReceipt {
    return this.#verify(request.receiptBytes);
  }

  #verify(receiptBytes: string): VerifiedIntegrationReceipt {
    const identity = hashBytes(receiptBytes);
    const verification = this.#entries.get(identity);
    if (verification === undefined) throw new Error(`unknown integration invocation: ${identity}`);
    return verification;
  }
}

function certify(
  candidate: Parameters<typeof receiptsFor>[0] & Parameters<typeof certifyIntegrationCandidate>[0],
  evidence = receiptsFor(candidate),
) {
  return certifyIntegrationCandidate(
    candidate,
    evidence,
    new FixtureEvidenceVerifier(candidate, evidence),
  );
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
  const checked = certify(composed);
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
  expect(() => certify(composed, standaloneEvidence)).toThrow(
    'evidence candidate binding mismatch',
  );
  const evidence = receiptsFor(composed);
  const bad = { ...evidence, contentManifestIdentity: hashBytes('standalone') };
  expect(() => certify(composed, bad)).toThrow('evidence candidate binding mismatch');
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
  expect(() => certify(candidate, { ...evidence, compositionIdentity: '7'.repeat(64) })).toThrow(
    'evidence candidate binding mismatch',
  );
  expect(() => certify(candidate, { ...evidence, checks: evidence.checks.slice(1) })).toThrow(
    'integration check receipt set is incomplete',
  );
  expect(() => certify(candidate, { ...evidence, reviews: evidence.reviews.slice(1) })).toThrow(
    'integration review receipt set is incomplete',
  );
  const skipped = evidence.checks.map((entry, index) =>
    index === 0
      ? { ...entry, receipt: withReceiptField(entry.receipt, 'status', 'skipped') }
      : entry,
  );
  expect(() => certify(candidate, { ...evidence, checks: skipped })).toThrow(
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
  expect(() => certify(candidate, { ...evidence, reviews: staleReviews })).toThrow(
    'integration review receipt does not certify candidate',
  );
  expect(() => certify({ ...candidate, candidateTree: subject.base.tree }, evidence)).toThrow(
    'unchecked integration candidate identity mismatch',
  );
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

test('authenticated receipt obligations cannot be relabeled, duplicated, or envelope-rewritten', () => {
  const subject = integrationFixture();
  const gate = subject.submission('gate', 'gate.ts', 'export const gate = 2;\n');
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, {
    policy,
    submissions: [gate],
  });
  const evidence = receiptsFor(candidate);
  const verifier = new FixtureEvidenceVerifier(candidate, evidence);
  const relabeledChecks = evidence.checks.map((entry) => ({
    ...entry,
    receipt:
      evidence.checks.find(({ checkId }) => checkId !== entry.checkId)?.receipt ?? entry.receipt,
  }));
  expect(() =>
    certifyIntegrationCandidate(candidate, { ...evidence, checks: relabeledChecks }, verifier),
  ).toThrow('integration verifier binding mismatch');
  const relabeledReviews = evidence.reviews.map((entry) => ({
    ...entry,
    receipt:
      evidence.reviews.find(({ reviewId }) => reviewId !== entry.reviewId)?.receipt ??
      entry.receipt,
  }));
  expect(() =>
    certifyIntegrationCandidate(candidate, { ...evidence, reviews: relabeledReviews }, verifier),
  ).toThrow('integration verifier binding mismatch');
  const gateReceipt = evidence.checks.find(({ checkId }) => checkId === 'check.gate')?.receipt;
  if (gateReceipt === undefined) throw new Error('fixture gate receipt is absent');
  const duplicate = evidence.checks.map((entry) =>
    entry.checkId === 'check.trusted-gate' ? { ...entry, receipt: gateReceipt } : entry,
  );
  expect(() =>
    certifyIntegrationCandidate(candidate, { ...evidence, checks: duplicate }, verifier),
  ).toThrow('duplicate integration receipt identity');
  const rewritten = evidence.checks.map((entry, index) =>
    index === 0
      ? { ...entry, receipt: withReceiptField(entry.receipt, 'receiptId', 'receipt.rewritten') }
      : entry,
  );
  expect(() =>
    certifyIntegrationCandidate(candidate, { ...evidence, checks: rewritten }, verifier),
  ).toThrow('unknown integration invocation');
  const wrongCommand = evidence.checks.map((entry, index) =>
    index === 0
      ? { ...entry, receipt: withReceiptField(entry.receipt, 'command', ['bun', 'run', 'other']) }
      : entry,
  );
  expect(() => certify(candidate, { ...evidence, checks: wrongCommand })).toThrow(
    'integration check receipt does not certify candidate',
  );
  const wrongExecutor = evidence.reviews.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          receipt: withReceiptField(entry.receipt, 'executor', {
            effort: 'low',
            model: 'other',
            provider: 'fixture',
            toolchain: 'codex',
            version: '1',
          }),
        }
      : entry,
  );
  expect(() => certify(candidate, { ...evidence, reviews: wrongExecutor })).toThrow(
    'integration review receipt does not certify candidate',
  );
  subject.store.close();
});

test('review provenance requires the externally supplied journal verifier', () => {
  const subject = integrationFixture();
  const gate = subject.submission('gate', 'gate.ts', 'export const gate = 2;\n');
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, {
    policy,
    submissions: [gate],
  });
  const evidence = receiptsFor(candidate);
  const unavailable: IntegrationEvidenceVerifier = {
    verifyCheck: () => {
      throw new Error('trusted integration journal is unavailable');
    },
    verifyReview: () => {
      throw new Error('trusted integration journal is unavailable');
    },
  };
  expect(() => certifyIntegrationCandidate(candidate, evidence, unavailable)).toThrow(
    'trusted integration journal is unavailable',
  );
  const relabeled = evidence.reviews.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          receipt: withReceiptField(entry.receipt, 'trust', {
            journalId: 'journal.does-not-exist',
            scope: 'trusted-harness',
          }),
        }
      : entry,
  );
  expect(() => certify(candidate, { ...evidence, reviews: relabeled })).toThrow(
    'integration review receipt does not certify candidate',
  );
  subject.store.close();
});

test('equal trees cannot reuse evidence across policy, mapping, declaration, or generation identity', () => {
  const subject = integrationFixture();
  const one = subject.submission('one', 'src/producer.ts', 'export const version = 2;\n');
  const candidate = composeIntegrationCandidate(subject.store, subject.repository, {
    policy,
    submissions: [one],
  });
  const evidence = receiptsFor(candidate);
  const reidentify = (
    changes: Partial<Omit<typeof candidate, 'compositionIdentity'>>,
  ): typeof candidate => {
    const { compositionIdentity: _identity, ...body } = { ...candidate, ...changes };
    return { ...body, compositionIdentity: hashCanonical(body) };
  };
  for (const changed of [
    reidentify({ policyIdentity: '3'.repeat(64) }),
    reidentify({ mappingIdentity: '4'.repeat(64) }),
    reidentify({ declarationIdentity: '5'.repeat(64) }),
    reidentify({
      submissions: candidate.submissions.map((submission) => ({
        ...submission,
        generation: submission.generation + 1,
      })),
    }),
  ]) {
    expect(changed.candidateTree).toBe(candidate.candidateTree);
    expect(() => certify(changed, evidence)).toThrow('evidence candidate binding mismatch');
  }
  const changedPolicy = reidentify({ policyIdentity: '6'.repeat(64) });
  const rewrittenEnvelope = {
    ...evidence,
    compositionIdentity: changedPolicy.compositionIdentity,
    policyIdentity: changedPolicy.policyIdentity,
  };
  expect(() =>
    certifyIntegrationCandidate(
      changedPolicy,
      rewrittenEnvelope,
      new FixtureEvidenceVerifier(candidate, evidence),
    ),
  ).toThrow('integration check receipt does not certify candidate');
  const contentOnlyReceipts = evidence.checks.map((entry) => ({
    ...entry,
    receipt: withReceiptField(
      entry.receipt,
      'candidateManifest',
      candidate.contentManifestIdentity,
    ),
  }));
  expect(() => certify(candidate, { ...evidence, checks: contentOnlyReceipts })).toThrow(
    'integration check receipt does not certify candidate',
  );
  subject.store.close();
});

test('contract consumers must be distinct and change trusted implementation paths', () => {
  const self = integrationFixture();
  const producerConsumer = self.submission(
    'producer',
    'src/producer.ts',
    'export const version = 2;\n',
    {
      consumedContracts: ['contract.api'],
      consumedInterfaces: ['interface.api'],
      producedContracts: ['contract.api'],
    },
  );
  expect(() =>
    composeIntegrationCandidate(self.store, self.repository, {
      policy,
      submissions: [producerConsumer],
    }),
  ).toThrow('required consumer is absent from integration batch');
  self.store.close();

  const unrelated = integrationFixture();
  const producer = unrelated.submission(
    'producer',
    'src/producer.ts',
    'export const version = 2;\n',
    { producedContracts: ['contract.api'] },
  );
  const labelOnly = unrelated.submission('consumer', 'gate.ts', 'export const gate = 2;\n', {
    consumedContracts: ['contract.api'],
    consumedInterfaces: ['interface.api'],
  });
  expect(() =>
    composeIntegrationCandidate(unrelated.store, unrelated.repository, {
      policy,
      submissions: [producer, labelOnly],
    }),
  ).toThrow('required consumer is absent from integration batch');
  unrelated.store.close();
});

test('strict policy decoding rejects unknown selector kinds and malformed primitive fields', () => {
  const globBody = {
    ...policyBody,
    selectorRules: [{ checks: [], kind: 'glob', path: '*.ts', reviews: [] }],
  };
  expect(() =>
    decodeIntegrationPolicy({
      ...globBody,
      policyIdentity: hashCanonical(globBody),
    }),
  ).toThrow('Validation failed');
  expect(() => decodeIntegrationPolicy({ ...policy, contractRules: 'not-an-array' })).toThrow(
    'Validation failed',
  );
});
