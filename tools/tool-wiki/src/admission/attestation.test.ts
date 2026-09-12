import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'bun:test';

import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import {
  emitIntegrationBinding,
  type IntegrationBindingActivation,
  verifyIntegrationBinding,
} from './attestation';
import type {
  CheckedIntegrationCandidate,
  IntegrationEvidenceVerifier,
  VerifiedIntegrationReceipt,
} from './integrate';

const scratch: string[] = [];

afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

function git(repository: string, argv: readonly string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) throw new Error(invocation.stderr.toString('utf8'));
  return invocation.stdout.toString('utf8').trimEnd();
}

function fixture() {
  const repository = mkdtempSync(join(tmpdir(), 'wiki-binding-candidate-'));
  const store = mkdtempSync(join(tmpdir(), 'wiki-binding-store-'));
  scratch.push(repository, store);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  git(repository, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(repository, 'source.ts'), 'export const version = 1;\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '--message', 'base']);
  const baseCommit = git(repository, ['rev-parse', 'HEAD']);
  writeFileSync(join(repository, 'source.ts'), 'export const version = 2;\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '--message', 'candidate']);
  const commit = git(repository, ['rev-parse', 'HEAD']);
  const tree = git(repository, ['rev-parse', 'HEAD^{tree}']);
  const checkReceipt = {
    candidateManifest: '',
    command: ['bunx', 'nx', 'run', 'tool-wiki:test', '--skip-nx-cache'],
    cwdIdentity: 'repository.root',
    elapsedMs: 1,
    endedAt: '2026-09-12T00:00:00.001Z',
    exitCode: 0,
    receiptId: 'receipt.tool-wiki.test',
    receiptKind: 'check' as const,
    resourceLane: 'lane.tool-wiki',
    schemaVersion: 1 as const,
    skips: [],
    startedAt: '2026-09-12T00:00:00.000Z',
    status: 'passed' as const,
    stderrArtifact: hashBytes(''),
    stdoutArtifact: hashBytes('ok'),
    toolIdentity: '9'.repeat(64),
  };
  const unchecked = {
    baseCommit,
    baseTree: git(repository, ['rev-parse', `${baseCommit}^{tree}`]),
    candidateDiffIdentity: '1'.repeat(64),
    candidateTree: tree,
    changedPaths: ['source.ts'],
    contentManifestIdentity: '2'.repeat(64),
    declarationIdentity: '3'.repeat(64),
    mappingIdentity: '4'.repeat(64),
    policyIdentity: '5'.repeat(64),
    publicationBoundary:
      '5.2 must atomically recheck authority and target ref before publication' as const,
    schemaVersion: 1 as const,
    selectedCheckSpecs: [
      {
        checkId: 'check.tool-wiki.test',
        command: checkReceipt.command,
        cwdIdentity: checkReceipt.cwdIdentity,
        journalId: 'journal.checks',
        resourceLane: checkReceipt.resourceLane,
        toolIdentity: checkReceipt.toolIdentity,
      },
    ],
    selectedChecks: ['check.tool-wiki.test'],
    selectedReviewSpecs: [],
    selectedReviews: [],
    status: 'unchecked' as const,
    submissions: [
      {
        generation: 7,
        packetIdentity: '6'.repeat(64),
        patchIdentity: '7'.repeat(64),
        sessionId: 'session.tool-wiki',
        status: 'submitted' as const,
      },
    ],
  };
  const compositionIdentity = hashCanonical(unchecked);
  const boundReceipt = { ...checkReceipt, candidateManifest: compositionIdentity };
  const verification = {
    compositionIdentity,
    invocationId: 'invocation.tool-wiki.test',
    journalId: 'journal.checks',
    obligationId: 'check.tool-wiki.test',
    receiptIdentity: hashBytes(serializeCanonical(boundReceipt)),
  };
  const evidence = {
    candidateDiffIdentity: unchecked.candidateDiffIdentity,
    candidateTree: tree,
    checks: [{ checkId: 'check.tool-wiki.test', receipt: boundReceipt }],
    compositionIdentity,
    contentManifestIdentity: unchecked.contentManifestIdentity,
    declarationIdentity: unchecked.declarationIdentity,
    mappingIdentity: unchecked.mappingIdentity,
    policyIdentity: unchecked.policyIdentity,
    reviews: [],
    selectedChecks: unchecked.selectedChecks,
    selectedReviews: unchecked.selectedReviews,
  };
  const checked: CheckedIntegrationCandidate = {
    ...unchecked,
    checkReceipts: [boundReceipt],
    compositionIdentity,
    evidenceIdentity: hashCanonical(evidence),
    receiptVerifications: [verification],
    reviewReceipts: [],
    status: 'checked',
  };
  const markerRef = 'refs/wbs-wiki/publications/fixture';
  git(repository, ['update-ref', markerRef, commit]);
  const activation: IntegrationBindingActivation = {
    activationIdentity: '8'.repeat(64),
    mappingIdentity: checked.mappingIdentity,
    policyIdentity: checked.policyIdentity,
    reviewReceiptIdentity: 'a'.repeat(64),
    validatorIdentity: 'b'.repeat(64),
  };
  const verifier: IntegrationEvidenceVerifier = {
    verifyCheck(request): VerifiedIntegrationReceipt {
      if (hashBytes(request.receiptBytes) !== verification.receiptIdentity) {
        throw new Error('unknown check receipt');
      }
      return verification;
    },
    verifyReview(): VerifiedIntegrationReceipt {
      throw new Error('unexpected review receipt');
    },
  };
  return {
    activation,
    checked,
    commit,
    markerRef,
    repository: realpathSync(repository),
    store: realpathSync(store),
    tree,
    verifier,
  };
}

function trustedVerification(subject: ReturnType<typeof fixture>) {
  return {
    admissionProvenance: {
      kind: 'not-applicable' as const,
      reason: 'pre-authority bootstrap commit' as const,
    },
    publication: {
      commit: subject.commit,
      markerRef: subject.markerRef,
      parent: subject.checked.baseCommit,
      tree: subject.tree,
    },
  };
}

test('external binding retains distinct candidate, content, evidence, activation, generation, and receipt identities', () => {
  const subject = fixture();
  const destination = join(subject.store, 'bindings', `${subject.commit}.json`);
  const before = {
    head: git(subject.repository, ['rev-parse', 'HEAD']),
    index: git(subject.repository, ['write-tree']),
    status: git(subject.repository, ['status', '--porcelain=v1']),
  };
  const emitted = emitIntegrationBinding({
    activation: subject.activation,
    admissionProvenance: { kind: 'not-applicable', reason: 'pre-authority bootstrap commit' },
    candidate: subject.checked,
    contentManifestIdentity: 'c'.repeat(64),
    destination,
    evidenceValidation: {
      validationId: 'validation.tool-wiki.bootstrap',
      validationIdentity: 'd'.repeat(64),
    },
    publication: {
      commit: subject.commit,
      markerRef: subject.markerRef,
      tree: subject.tree,
    },
    repository: subject.repository,
  });
  expect(emitted.binding.commit).toBe(subject.commit);
  expect(emitted.binding.compositionIdentity).toBe(subject.checked.compositionIdentity);
  expect(emitted.binding.contentManifestIdentity).toBe('c'.repeat(64));
  expect(emitted.binding.candidateCompositionManifestIdentity).toBe(
    subject.checked.contentManifestIdentity,
  );
  expect(emitted.binding.evidenceValidation.validationIdentity).toBe('d'.repeat(64));
  expect(emitted.binding.generations).toEqual([...subject.checked.submissions]);
  expect(emitted.binding.checks).toHaveLength(1);
  expect(emitted.bytes).not.toContain(emitted.identity);
  expect(emitIntegrationBinding({ ...emitted.request, destination }).identity).toBe(
    emitted.identity,
  );
  expect({
    head: git(subject.repository, ['rev-parse', 'HEAD']),
    index: git(subject.repository, ['write-tree']),
    status: git(subject.repository, ['status', '--porcelain=v1']),
  }).toEqual(before);
  expect(
    verifyIntegrationBinding({
      ...trustedVerification(subject),
      activation: subject.activation,
      bindingBytes: readFileSync(destination, 'utf8'),
      candidate: subject.checked,
      contentManifestIdentity: 'c'.repeat(64),
      evidenceValidation: emitted.binding.evidenceValidation,
      repository: subject.repository,
      verifier: subject.verifier,
    }).identity,
  ).toBe(emitted.identity);
});

test('trusted verification refuses forged candidate or policy identity and an omitted required check', () => {
  const subject = fixture();
  const emitted = emitIntegrationBinding({
    activation: subject.activation,
    admissionProvenance: { kind: 'not-applicable', reason: 'pre-authority bootstrap commit' },
    candidate: subject.checked,
    contentManifestIdentity: 'c'.repeat(64),
    destination: join(subject.store, 'binding.json'),
    evidenceValidation: {
      validationId: 'validation.tool-wiki.bootstrap',
      validationIdentity: 'd'.repeat(64),
    },
    publication: { commit: subject.commit, markerRef: subject.markerRef, tree: subject.tree },
    repository: subject.repository,
  });
  const forgedCommit = { ...emitted.binding, commit: subject.checked.baseCommit };
  expect(() =>
    verifyIntegrationBinding({
      ...trustedVerification(subject),
      activation: subject.activation,
      bindingBytes: serializeCanonical(forgedCommit),
      candidate: subject.checked,
      contentManifestIdentity: emitted.binding.contentManifestIdentity,
      evidenceValidation: emitted.binding.evidenceValidation,
      repository: subject.repository,
      verifier: subject.verifier,
    }),
  ).toThrow('integration binding publication differs from retained authority');
  const forgedPolicy = {
    ...emitted.binding,
    activation: { ...emitted.binding.activation, policyIdentity: 'e'.repeat(64) },
  };
  expect(() =>
    verifyIntegrationBinding({
      ...trustedVerification(subject),
      activation: subject.activation,
      bindingBytes: serializeCanonical(forgedPolicy),
      candidate: subject.checked,
      contentManifestIdentity: emitted.binding.contentManifestIdentity,
      evidenceValidation: emitted.binding.evidenceValidation,
      repository: subject.repository,
      verifier: subject.verifier,
    }),
  ).toThrow('integration binding activation differs from external selection');
  const missingCheck = { ...emitted.binding, checks: [] };
  expect(() =>
    verifyIntegrationBinding({
      ...trustedVerification(subject),
      activation: subject.activation,
      bindingBytes: serializeCanonical(missingCheck),
      candidate: subject.checked,
      contentManifestIdentity: emitted.binding.contentManifestIdentity,
      evidenceValidation: emitted.binding.evidenceValidation,
      repository: subject.repository,
      verifier: subject.verifier,
    }),
  ).toThrow('integration check receipt set is incomplete');
  const forgedContent = { ...emitted.binding, contentManifestIdentity: 'f'.repeat(64) };
  expect(() =>
    verifyIntegrationBinding({
      ...trustedVerification(subject),
      activation: subject.activation,
      bindingBytes: serializeCanonical(forgedContent),
      candidate: subject.checked,
      contentManifestIdentity: emitted.binding.contentManifestIdentity,
      evidenceValidation: emitted.binding.evidenceValidation,
      repository: subject.repository,
      verifier: subject.verifier,
    }),
  ).toThrow('integration binding content or evidence validation differs from trusted inputs');
});

test('trusted verification refuses invented provenance, mismatched binding kind, and a same-tree publication', () => {
  const subject = fixture();
  const emitted = emitIntegrationBinding({
    activation: subject.activation,
    admissionProvenance: { kind: 'not-applicable', reason: 'pre-authority bootstrap commit' },
    candidate: subject.checked,
    contentManifestIdentity: 'c'.repeat(64),
    destination: join(subject.store, 'binding.json'),
    evidenceValidation: {
      validationId: 'validation.tool-wiki.bootstrap',
      validationIdentity: 'd'.repeat(64),
    },
    publication: { commit: subject.commit, markerRef: subject.markerRef, tree: subject.tree },
    repository: subject.repository,
  });
  const verify = (binding: typeof emitted.binding) =>
    verifyIntegrationBinding({
      ...trustedVerification(subject),
      activation: subject.activation,
      bindingBytes: serializeCanonical(binding),
      candidate: subject.checked,
      contentManifestIdentity: emitted.binding.contentManifestIdentity,
      evidenceValidation: emitted.binding.evidenceValidation,
      repository: subject.repository,
      verifier: subject.verifier,
    });
  expect(() =>
    verify({
      ...emitted.binding,
      admissionProvenance: {
        kind: 'integrated',
        integrationId: 'invented.integration',
        attemptIdentity: 'f'.repeat(64),
      },
      bindingKind: 'integrated',
    }),
  ).toThrow('integration binding admission provenance differs from retained authority');
  expect(() => verify({ ...emitted.binding, bindingKind: 'integrated' })).toThrow(
    'integration binding kind differs from admission provenance',
  );

  git(subject.repository, ['checkout', '--quiet', subject.checked.baseCommit]);
  writeFileSync(join(subject.repository, 'source.ts'), 'export const version = 2;\n');
  git(subject.repository, ['add', '.']);
  git(subject.repository, ['commit', '--quiet', '--message', 'same tree, different commit']);
  const impostorCommit = git(subject.repository, ['rev-parse', 'HEAD']);
  const impostorMarker = 'refs/wbs-wiki/publications/impostor';
  git(subject.repository, ['update-ref', impostorMarker, impostorCommit]);
  expect(git(subject.repository, ['rev-parse', 'HEAD^{tree}'])).toBe(subject.tree);
  expect(() =>
    verify({ ...emitted.binding, commit: impostorCommit, markerRef: impostorMarker }),
  ).toThrow('integration binding publication differs from retained authority');
});

test('trusted verification refuses forged serialized receipt provenance', () => {
  const subject = fixture();
  const emitted = emitIntegrationBinding({
    activation: subject.activation,
    admissionProvenance: { kind: 'not-applicable', reason: 'pre-authority bootstrap commit' },
    candidate: subject.checked,
    contentManifestIdentity: 'c'.repeat(64),
    destination: join(subject.store, 'binding.json'),
    evidenceValidation: {
      validationId: 'validation.tool-wiki.bootstrap',
      validationIdentity: 'd'.repeat(64),
    },
    publication: { commit: subject.commit, markerRef: subject.markerRef, tree: subject.tree },
    repository: subject.repository,
  });
  const [check] = emitted.binding.checks;
  const forged = {
    ...emitted.binding,
    checks: [
      {
        ...check,
        verification: {
          ...check.verification,
          invocationId: 'never.invoked',
          receiptIdentity: '0'.repeat(64),
        },
      },
    ],
  };
  expect(() =>
    verifyIntegrationBinding({
      ...trustedVerification(subject),
      activation: subject.activation,
      bindingBytes: serializeCanonical(forged),
      candidate: subject.checked,
      contentManifestIdentity: emitted.binding.contentManifestIdentity,
      evidenceValidation: emitted.binding.evidenceValidation,
      repository: subject.repository,
      verifier: subject.verifier,
    }),
  ).toThrow();
});

test('external emission refuses candidate-local destinations and symlink escapes', () => {
  const subject = fixture();
  const request = {
    activation: subject.activation,
    admissionProvenance: {
      kind: 'not-applicable' as const,
      reason: 'pre-authority bootstrap commit' as const,
    },
    candidate: subject.checked,
    contentManifestIdentity: 'c'.repeat(64),
    evidenceValidation: {
      validationId: 'validation.tool-wiki.bootstrap',
      validationIdentity: 'd'.repeat(64),
    },
    publication: { commit: subject.commit, markerRef: subject.markerRef, tree: subject.tree },
    repository: subject.repository,
  };
  expect(() =>
    emitIntegrationBinding({ ...request, destination: join(subject.repository, 'binding.json') }),
  ).toThrow('integration binding destination must be outside the candidate repository');
  expect(() =>
    emitIntegrationBinding({
      ...request,
      destination: join(subject.repository, '..inside', 'binding.json'),
    }),
  ).toThrow('integration binding destination must be outside the candidate repository');
  mkdirSync(join(subject.store, 'links'));
  symlinkSync(subject.repository, join(subject.store, 'links', 'candidate'));
  expect(() =>
    emitIntegrationBinding({
      ...request,
      destination: join(subject.store, 'links', 'candidate', 'binding.json'),
    }),
  ).toThrow('integration binding destination must be outside the candidate repository');
});
