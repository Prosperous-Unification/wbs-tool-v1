import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseOrThrow } from '@wbs/validation';
import { afterEach, describe, expect, test } from 'bun:test';

import { ClassificationPolicy, RelationshipRequest } from '../contracts/records';
import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import type { ClassifiedEntry } from '../inventory/classify-entries';
import { readCandidate } from '../inventory/read-candidate';
import { extractRelationships } from '../relationships';
import type { AuditObligation } from './audit';
import {
  deriveExhaustivePopulation,
  evaluateExhaustiveCoverage,
  type ExhaustiveFreezeDocuments,
  type ExhaustivePlan,
  freezeExhaustivePlan,
  verifyExhaustivePlan,
} from './exhaustive-coverage';
import type { ReviewEvidence } from './protocol';

const SHA_A = 'a'.repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function runGit(repository: string, argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${invocation.stdout.toString()}${invocation.stderr.toString()}`;
  if (invocation.exitCode !== 0) throw new Error(`git ${argv.join(' ')} failed: ${output}`);
  return invocation.stdout.toString('utf8').trim();
}

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}

function document(input: unknown) {
  return { input, bytes: Buffer.from(serializeCanonical(input), 'utf8') };
}

interface RepositoryFixture {
  repository: string;
  revision: string;
  documents: ExhaustiveFreezeDocuments;
  paths: string[];
}

function syncDocumentPaths(fixture: RepositoryFixture): void {
  exhaustiveDocumentNames.forEach((name, index) => {
    const path = fixture.paths.at(index);
    if (path === undefined) throw new Error(`fixture ${name} path is absent`);
    writeFileSync(path, fixture.documents[name].bytes);
  });
}

function refreshCandidate(fixture: RepositoryFixture, revision: string): void {
  const snapshot = readCandidate(fixture.repository, { kind: 'committed', revision });
  if (snapshot.selection.kind !== 'committed') throw new Error('fixture commit was not selected');
  const inventoryProtocol = fixture.documents.inventoryProtocol;
  const classification = parseOrThrow(
    ClassificationPolicy,
    fixture.documents.classificationPolicy.input,
  );
  const relationshipRequest = parseOrThrow(
    RelationshipRequest,
    fixture.documents.relationshipRequest.input,
  );
  const relationships = extractRelationships(fixture.repository, snapshot, relationshipRequest);
  fixture.documents.inventory = document({
    schemaVersion: 1,
    inventoryId: `inventory.exhaustive.${revision.slice(0, 12)}`,
    protocol: {
      protocolId: 'inventory.exhaustive.v1',
      blob: hashBytes(inventoryProtocol.bytes),
    },
    selection: snapshot.selection,
    entries: snapshot.entries,
    untracked: snapshot.untracked,
    classificationPolicy: {
      policyId: classification.policyId,
      blob: hashBytes(fixture.documents.classificationPolicy.bytes),
    },
  });
  fixture.documents.contentManifestRequest = document({
    schemaVersion: 1,
    protocol: {
      protocolId: 'inventory.exhaustive.v1',
      blob: hashBytes(inventoryProtocol.bytes),
    },
    classificationPolicy: {
      policyId: classification.policyId,
      blob: hashBytes(fixture.documents.classificationPolicy.bytes),
    },
    ...relationships.manifestInputs,
  });
  const mapping = structuredClone(fixture.documents.moduleMapping.input) as {
    sourceRevision: string;
  };
  mapping.sourceRevision = revision;
  fixture.documents.moduleMapping = document(mapping);
  const evidenceEntry = snapshot.entries.find(
    ({ path }) => path === 'docs/review-evidence/receipt.json',
  );
  if (evidenceEntry === undefined) throw new Error('fixture evidence tuple is absent');
  const evidenceBytes = readFileSync(join(fixture.repository, evidenceEntry.path));
  const artifactId = hashBytes(evidenceBytes);
  fixture.documents.artifactGraph = document({
    schemaVersion: 1,
    validationId: `validation.exhaustive.${revision.slice(0, 12)}`,
    roots: [artifactId],
    artifacts: [
      {
        artifactId,
        path: evidenceEntry.path,
        blob: evidenceEntry.blob,
        recordKind: 'opaque-transcript',
        references: [],
      },
    ],
  });
  fixture.revision = revision;
  syncDocumentPaths(fixture);
}

function runFreezeCli(fixture: RepositoryFixture, paths = fixture.paths) {
  const cli = join(import.meta.dir, '..', 'cli.ts');
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cli,
      'freeze-exhaustive',
      fixture.repository,
      fixture.revision,
      'seed.fixture',
      ...paths,
    ],
    {
      cwd: join(import.meta.dir, '..', '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

function runCoverageCli(
  fixture: RepositoryFixture,
  plan: ExhaustivePlan,
  expectedIdentity: string,
) {
  const directory = dirname(fixture.paths[0]);
  const planPath = join(directory, 'plan.json');
  const auditPath = join(directory, 'audit.json');
  writeFileSync(planPath, serializeCanonical(plan));
  writeFileSync(auditPath, '{}');
  const cli = join(import.meta.dir, '..', 'cli.ts');
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cli,
      'evaluate-exhaustive-coverage',
      fixture.repository,
      planPath,
      expectedIdentity,
      'seed.fixture',
      auditPath,
      ...fixture.paths,
    ],
    {
      cwd: join(import.meta.dir, '..', '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

function cliOutput(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${invocation.stdout?.toString() ?? ''}${invocation.stderr?.toString() ?? ''}`;
}

function auditReview(obligation: AuditObligation, plan: ExhaustivePlan, sequence: number) {
  const reviewId = `review.exhaustive.${String(sequence)}`;
  const invocationId = `invocation.exhaustive.${String(sequence)}`;
  const response = `review ${String(sequence)}\n`;
  const responseArtifact = hashBytes(response);
  const executor = {
    provider: 'fixture-provider',
    model: 'fixture-model',
    version: 'fixture-version',
    effort: 'high',
    toolchain: 'fixture-harness',
  };
  const priceIdentity = {
    priceId: 'price.fixture.v1',
    provider: 'fixture-provider',
    model: 'fixture-model',
    currency: 'USD',
    source: 'fixture-receipt',
  };
  const startedAt = '2026-09-12T10:00:00.000Z';
  const endedAt = '2026-09-12T10:00:01.000Z';
  const phase = (name: 'cold' | 'informed') => ({
    status: 'verified' as const,
    receipt: {
      schemaVersion: 1 as const,
      receiptKind: 'invocation' as const,
      receiptId: `receipt.${reviewId}.${name}`,
      invocationId,
      startedAt,
      endedAt,
      status: 'completed' as const,
      executor,
      rawUsage: [{ category: `${name}_tokens`, quantity: 1, unit: 'tokens' }],
      priceIdentity,
      chargedAmountMicros: 1,
      inputArtifact: 'a'.repeat(64),
      outputArtifact: responseArtifact,
    },
    elapsedReceipts: [
      {
        schemaVersion: 1 as const,
        receiptKind: 'elapsed' as const,
        receiptId: `elapsed.${reviewId}.${name}`,
        trialId: 'trial.exhaustive.fixture',
        outcomeId: 'outcome.exhaustive.fixture',
        attemptId: `attempt.${reviewId}.${name}`,
        phase: 'review' as const,
        startedAt,
        endedAt,
        elapsedMs: 1000,
        status: 'completed' as const,
      },
    ],
  });
  const cold = {
    sequence: 1 as const,
    judgments: { purpose: 'yes' as const, relationships: 'yes' as const, impact: 'yes' as const },
    observedReadIds: [obligation.subject.contentIdentity],
  };
  const coldReceipt = phase('cold');
  const informedReceipt = phase('informed');
  const rawUsage = [...coldReceipt.receipt.rawUsage, ...informedReceipt.receipt.rawUsage];
  const evidence: ReviewEvidence = {
    schemaVersion: 1,
    receipt: {
      schemaVersion: 1,
      receiptKind: 'review',
      receiptId: `review-receipt.${reviewId}`,
      invocationId,
      executor,
      suppliedContextIds: [plan.reviewProtocol.protocolBlob, obligation.subject.contentIdentity],
      observedReadIds: [obligation.subject.contentIdentity, obligation.subject.contentIdentity],
      rawResponseArtifact: responseArtifact,
      rawUsage,
      priceIdentity,
      trust: { scope: 'local-cooperative', journalId: 'journal.exhaustive.fixture' },
    },
    protocolEvidence: {
      schemaVersion: 1,
      protocol: plan.reviewProtocol,
      subject: obligation.subject,
      cold,
      expansion: {
        sequence: 2,
        coldJudgmentArtifact: hashCanonical(cold),
        suppliedContextIds: [],
      },
      informed: {
        sequence: 3,
        judgments: { purpose: 'yes', relationships: 'yes', impact: 'yes' },
        observedReadIds: [obligation.subject.contentIdentity],
      },
    },
    phaseReceipts: { cold: coldReceipt, informed: informedReceipt },
    phaseTools: {
      cold: [{ toolId: 'read-file', version: '1' }],
      informed: [{ toolId: 'run-check', version: '1' }],
    },
    actualTools: [
      { toolId: 'read-file', version: '1' },
      { toolId: 'run-check', version: '1' },
    ],
    rawResponse: { artifact: responseArtifact, retention: { kind: 'journal-inline' } },
  };
  return {
    reviewId,
    obligationId: obligation.obligationId,
    sourceBase: plan.source.commit,
    candidateIdentity: plan.contentIdentity,
    generation: 1,
    reviewRound: 1,
    recordedAt: '2026-09-12T10:01:00.000Z',
    evidence,
    findings: [],
  };
}

function repositoryFixture(): RepositoryFixture {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-exhaustive-'));
  const inputs = mkdtempSync(join(tmpdir(), 'tool-wiki-exhaustive-inputs-'));
  roots.push(repository, inputs);
  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Tool Wiki Test']);
  write(join(repository, 'README.md'), '# Fixture\n');
  write(
    join(repository, 'package.json'),
    `${JSON.stringify({ name: 'fixture-root', private: true })}\n`,
  );
  write(join(repository, 'nx.json'), '{}\n');
  write(
    join(repository, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ESNext' }, include: ['apps/**/*.ts'] })}\n`,
  );
  write(
    join(repository, 'apps/alpha/project.json'),
    `${JSON.stringify({ name: 'alpha', root: 'apps/alpha', sourceRoot: 'apps/alpha/src', projectType: 'application', tags: [], targets: {} })}\n`,
  );
  write(join(repository, 'apps/alpha/src/index.ts'), 'export const alpha = true;\n');
  write(join(repository, 'apps/alpha/docs/guide.md'), '# Alpha guide\n');
  write(
    join(repository, 'apps/alpha/nested/project.json'),
    `${JSON.stringify({ name: 'nested', root: 'apps/alpha/nested', sourceRoot: 'apps/alpha/nested/src', projectType: 'library', tags: [], targets: {} })}\n`,
  );
  write(join(repository, 'apps/alpha/nested/src/index.ts'), 'export const nested = true;\n');
  const transcript = {
    schemaVersion: 1,
    recordKind: 'opaque-transcript',
    invocationId: 'invocation.fixture',
    mediaType: 'text/plain',
    payload: 'retained fixture',
  };
  const transcriptBytes = serializeCanonical(transcript);
  write(join(repository, 'docs/review-evidence/receipt.json'), transcriptBytes);
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '--quiet', '--message', 'fixture']);
  const revision = runGit(repository, ['rev-parse', 'HEAD']);
  const snapshot = readCandidate(repository, { kind: 'committed', revision });
  if (snapshot.selection.kind !== 'committed') throw new Error('fixture commit was not selected');
  const classificationBytes = readFileSync(
    join(import.meta.dir, '..', 'contracts', 'fixtures', 'classification-policy.v1.json'),
  );
  const classificationInput = JSON.parse(classificationBytes.toString('utf8')) as unknown;
  const classification = parseOrThrow(ClassificationPolicy, classificationInput);
  const inventoryProtocol = document({ schemaVersion: 1, protocolId: 'inventory.exhaustive.v1' });
  const relationshipRequest = {
    schemaVersion: 1 as const,
    typescript: {
      configPaths: ['tsconfig.json'],
      publicEntrypoints: ['apps/alpha/src/index.ts'],
    },
  };
  const relationships = extractRelationships(repository, snapshot, relationshipRequest);
  const inventory = document({
    schemaVersion: 1,
    inventoryId: 'inventory.exhaustive.fixture',
    protocol: {
      protocolId: 'inventory.exhaustive.v1',
      blob: hashBytes(inventoryProtocol.bytes),
    },
    selection: snapshot.selection,
    entries: snapshot.entries,
    untracked: snapshot.untracked,
    classificationPolicy: {
      policyId: classification.policyId,
      blob: hashBytes(classificationBytes),
    },
  });
  const contentManifestRequest = document({
    schemaVersion: 1,
    protocol: {
      protocolId: 'inventory.exhaustive.v1',
      blob: hashBytes(inventoryProtocol.bytes),
    },
    classificationPolicy: {
      policyId: classification.policyId,
      blob: hashBytes(classificationBytes),
    },
    ...relationships.manifestInputs,
  });
  const contentPaths = snapshot.entries
    .filter(({ path }) => path !== 'docs/review-evidence/receipt.json')
    .map(({ path }) => path);
  const group = (groupId: string) => ({
    groups: [
      {
        groupId,
        memberships: contentPaths.map((path) => ({ kind: 'path' as const, path })),
      },
    ],
  });
  const granularityPolicy = document({
    schemaVersion: 1,
    policyId: 'granularity.exhaustive.v1',
    mappingVersion: 'pre-namespace-v1',
    mappings: {
      knowledge: group('knowledge.all'),
      review: group('review.all'),
      ownership: group('ownership.all'),
      task: group('task.all'),
      integration: group('integration.all'),
    },
  });
  const moduleMapping = document({
    schemaVersion: 1,
    mappingId: 'modules.exhaustive.v1',
    mappingVersion: 'pre-namespace-v1',
    sourceRevision: revision,
    modules: [
      {
        moduleId: 'module.alpha',
        name: 'Alpha',
        memberships: contentPaths.map((path) => ({ kind: 'path' as const, path })),
        predecessorModuleIds: [],
        indexPath: 'README.md',
        externalConsumers: { kind: 'none' },
      },
    ],
  });
  const evidenceEntry = snapshot.entries.find(
    ({ path }) => path === 'docs/review-evidence/receipt.json',
  );
  if (evidenceEntry === undefined) throw new Error('fixture evidence tuple is absent');
  const artifactId = hashBytes(transcriptBytes);
  const artifactGraph = document({
    schemaVersion: 1,
    validationId: 'validation.exhaustive.fixture',
    roots: [artifactId],
    artifacts: [
      {
        artifactId,
        path: evidenceEntry.path,
        blob: evidenceEntry.blob,
        recordKind: 'opaque-transcript',
        references: [],
      },
    ],
  });
  const documents: ExhaustiveFreezeDocuments = {
    inventory,
    inventoryProtocol,
    classificationPolicy: { input: classificationInput, bytes: classificationBytes },
    contentManifestRequest,
    exhaustivePolicy: document({
      schemaVersion: 1,
      policyId: 'exhaustive.fixture.v1',
      explicitDocumentationPaths: ['README.md'],
      nonNxProjects: [],
      defaultRiskStratum: 'risk.standard',
      reviewGeneration: 1,
      auditStrata: [
        { stratumId: 'risk.standard', sampleRateBps: 500, disagreementTriggerBps: 1000 },
      ],
      shardRule: { ruleId: 'shard.sha256-prefix.v1', hashPrefixLength: 2 },
    }),
    reviewProtocol: document({
      protocolId: 'review.cold-informed.v1',
      protocolBlob: hashCanonical({ version: 1, sequence: ['cold', 'expand', 'informed'] }),
    }),
    moduleMapping,
    granularityPolicy,
    modelContext: document({
      schemaVersion: 1,
      configurationId: 'model-context.fixture.v1',
      executor: {
        provider: 'fixture-provider',
        model: 'fixture-model',
        version: 'fixture-version',
        effort: 'high',
        toolchain: 'fixture-harness',
      },
      promptBlob: 'b'.repeat(64),
      toolsBlob: 'c'.repeat(64),
      harnessId: 'harness.fixture.v1',
      coldContextRule: 'isolated-subject-only',
      informedContextRule: 'declared-expansion',
      budgets: { contextTokens: 4096, inputTokens: 2048, outputTokens: 1024 },
      overflow: 'refuse',
      resourceCondition: 'fixture-single-process',
      cacheCondition: 'cold',
    }),
    relationshipRequest: document(relationshipRequest),
    artifactGraph,
  };
  const paths = exhaustiveDocumentNames.map((name) => {
    const path = join(inputs, `${name}.json`);
    writeFileSync(path, documents[name].bytes);
    return path;
  });
  return { repository, revision, documents, paths };
}

const exhaustiveDocumentNames: (keyof ExhaustiveFreezeDocuments)[] = [
  'inventory',
  'inventoryProtocol',
  'classificationPolicy',
  'contentManifestRequest',
  'exhaustivePolicy',
  'reviewProtocol',
  'moduleMapping',
  'granularityPolicy',
  'modelContext',
  'relationshipRequest',
  'artifactGraph',
];

function entry(
  path: string,
  contentClass: 'source' | 'document' | 'openspec' = 'source',
): ClassifiedEntry {
  return {
    path,
    mode: '100644',
    blob: SHA_A,
    classification: { kind: 'content', contentClass },
  };
}

describe('exhaustive repository coverage', () => {
  test('enumerates every file, ancestor, project and documentation duty with explicit root', () => {
    const population = deriveExhaustivePopulation({
      entries: [
        entry('README.md', 'document'),
        entry('apps/alpha/src/index.ts'),
        entry('apps/alpha/docs/guide.md', 'document'),
        {
          path: 'docs/review-evidence/receipt.json',
          mode: '100644',
          blob: SHA_A,
          classification: {
            kind: 'evidence',
            evidenceRoot: 'docs/review-evidence',
            recordKind: 'review-receipt',
          },
        },
      ],
      projects: [
        { projectId: 'nx.alpha', locator: { kind: 'path', path: 'apps/alpha' } },
        { projectId: 'nx.nested', locator: { kind: 'path', path: 'apps/alpha/src' } },
      ],
      explicitDocumentationPaths: ['README.md'],
      riskStratum: 'risk.standard',
      shardPrefixLength: 2,
    });

    expect(population.subjects.map(({ kind, locator }) => ({ kind, locator }))).toContainEqual({
      kind: 'directory',
      locator: { kind: 'repository-root' },
    });
    expect(population.subjects.map(({ kind, locator }) => ({ kind, locator }))).toContainEqual({
      kind: 'project',
      locator: { kind: 'repository-root' },
    });
    expect(
      population.subjects.filter(
        ({ locator }) => locator.kind === 'path' && locator.path === 'README.md',
      ),
    ).toHaveLength(2);
    expect(population.subjects.map(({ kind, locator }) => ({ kind, locator }))).toContainEqual({
      kind: 'directory',
      locator: { kind: 'path', path: 'docs/review-evidence' },
    });
    expect(population.subjects.map(({ kind, locator }) => ({ kind, locator }))).toContainEqual({
      kind: 'project',
      locator: { kind: 'path', path: 'apps/alpha/src' },
    });
    expect(population.obligations).toHaveLength(population.subjects.length);
  });

  test('refuses an explicit documentation selection outside the content candidate', () => {
    expect(() =>
      deriveExhaustivePopulation({
        entries: [entry('README.md', 'document')],
        projects: [],
        explicitDocumentationPaths: ['docs/missing.md'],
        riskStratum: 'risk.standard',
        shardPrefixLength: 2,
      }),
    ).toThrow('exhaustive documentation selection is unresolved: docs/missing.md');
  });

  test('refuses duplicate stable project identities and unresolved project locators', () => {
    const inputs = {
      entries: [entry('README.md', 'document')],
      explicitDocumentationPaths: [],
      riskStratum: 'risk.standard',
      shardPrefixLength: 2,
    };
    expect(() =>
      deriveExhaustivePopulation({
        ...inputs,
        projects: [{ projectId: 'repository-root', locator: { kind: 'repository-root' } }],
      }),
    ).toThrow('exhaustive population contains duplicate stable project identities');
    expect(() =>
      deriveExhaustivePopulation({
        ...inputs,
        projects: [{ projectId: 'nx.missing', locator: { kind: 'path', path: 'apps/missing' } }],
      }),
    ).toThrow('exhaustive project nx.missing is unresolved: apps/missing');
  });

  test('freezes and independently verifies the exact committed repository census', () => {
    const fixture = repositoryFixture();
    const frozen = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );

    expect(frozen.plan.source.commit).toBe(fixture.revision);
    expect(
      frozen.plan.subjects.some(
        (subject) =>
          subject.kind === 'project' &&
          subject.locator.kind === 'path' &&
          subject.locator.path === 'apps/alpha/nested',
      ),
    ).toBe(true);
    expect(
      frozen.plan.subjects.some(
        (subject) => subject.kind === 'directory' && subject.locator.kind === 'repository-root',
      ),
    ).toBe(true);
    expect(
      verifyExhaustivePlan(
        fixture.repository,
        frozen.identity,
        frozen.plan,
        fixture.documents,
        'seed.fixture',
      ).identity,
    ).toBe(frozen.identity);
  }, 20_000);

  test('verification names every omitted root, nested project, documentation and evidence directory duty', () => {
    const fixture = repositoryFixture();
    const frozen = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );
    const omissions = [
      ['directory', 'repository-root'],
      ['project', 'apps/alpha/nested'],
      ['documentation', 'README.md'],
      ['directory', 'docs/review-evidence'],
    ] as const;
    for (const [kind, locator] of omissions) {
      const submitted = structuredClone(frozen.plan);
      submitted.subjects = submitted.subjects.filter(
        (subject) =>
          !(
            subject.kind === kind &&
            (subject.locator.kind === 'repository-root'
              ? locator === 'repository-root'
              : subject.locator.path === locator)
          ),
      );
      expect(() =>
        verifyExhaustivePlan(
          fixture.repository,
          frozen.identity,
          submitted,
          fixture.documents,
          'seed.fixture',
        ),
      ).toThrow(`exhaustive plan omitted subject: ${kind}:${locator}`);
      if (kind === 'documentation') {
        expect(
          submitted.subjects.some(
            (subject) =>
              subject.kind === 'file' &&
              subject.locator.kind === 'path' &&
              subject.locator.path === locator,
          ),
        ).toBe(true);
      }
    }
  }, 30_000);

  test('coverage CLI verifies the frozen population before reading review claims', () => {
    const fixture = repositoryFixture();
    const frozen = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );
    const submitted = structuredClone(frozen.plan);
    submitted.subjects = submitted.subjects.filter(
      (subject) => !(subject.kind === 'directory' && subject.locator.kind === 'repository-root'),
    );
    const invocation = runCoverageCli(fixture, submitted, frozen.identity);

    expect(invocation.exitCode).toBe(1);
    expect(cliOutput(invocation)).toContain(
      'exhaustive plan omitted subject: directory:repository-root',
    );
    expect(cliOutput(invocation)).not.toContain('auditId must be');
  }, 20_000);

  test('all grouping changes leave logical obligations, memberships and shards stable', () => {
    const fixture = repositoryFixture();
    const baseline = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );
    const changed = structuredClone(fixture.documents);
    const input = structuredClone(fixture.documents.granularityPolicy.input) as {
      mappings: Record<string, { groups: { groupId: string; memberships: unknown[] }[] }>;
    };
    for (const [dimension, mapping] of Object.entries(input.mappings)) {
      const memberships = mapping.groups.flatMap((group) => group.memberships).reverse();
      mapping.groups = [
        { groupId: `${dimension}.regrouped-b`, memberships: memberships.slice(0, 1) },
        { groupId: `${dimension}.regrouped-a`, memberships: memberships.slice(1) },
      ].filter((group) => group.memberships.length > 0);
    }
    changed.granularityPolicy = document(input);
    const regrouped = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      changed,
      'seed.fixture',
    );

    expect(regrouped.plan.subjects).toEqual(baseline.plan.subjects);
    expect(regrouped.plan.obligations).toEqual(baseline.plan.obligations);
    expect(regrouped.plan.shards).toEqual(baseline.plan.shards);
  }, 20_000);

  test('authoritative coverage refuses a merged assignment with one omitted receipt and a shrunken claim', () => {
    const fixture = repositoryFixture();
    const frozen = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );
    const omitted = frozen.plan.obligations.at(0);
    if (omitted === undefined) throw new Error('fixture exhaustive obligation is absent');
    const claimed = frozen.plan.obligations.slice(1);
    const reviews = claimed.map((obligation, index) => auditReview(obligation, frozen.plan, index));
    const report = evaluateExhaustiveCoverage(frozen.plan, {
      schemaVersion: 1,
      auditId: 'audit.exhaustive.coverage',
      sourceBase: frozen.plan.source.commit,
      candidateIdentity: frozen.plan.contentIdentity,
      generation: 1,
      seed: 'seed.attacker-shrunk',
      coverage: 'exhaustive',
      strata: frozen.plan.audit.strata,
      obligations: claimed,
      mode: 'enforce',
      claimedCoverage: 'exhaustive',
      reviews,
      corrections: [],
      closures: [],
      adjudications: [],
    });

    expect(report.accepted).toBe(false);
    expect(report.unreviewedObligationIds).toContain(omitted.obligationId);
    expect(
      report.refusals.some(
        (refusal) => refusal.obligationId === omitted.obligationId && refusal.kind === 'review',
      ),
    ).toBe(true);
  }, 20_000);

  test('coverage binds submitted reviews to frozen generation, protocol and executor', () => {
    const fixture = repositoryFixture();
    const frozen = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );
    const reviews = frozen.plan.obligations.map((obligation, index) =>
      auditReview(obligation, frozen.plan, index),
    );
    const envelope = {
      schemaVersion: 1,
      auditId: 'audit.attacker',
      sourceBase: 'f'.repeat(40),
      candidateIdentity: 'f'.repeat(64),
      generation: 99,
      seed: 'seed.attacker',
      coverage: 'sampled',
      strata: [],
      obligations: [],
      mode: 'enforce',
      claimedCoverage: 'sampled',
      reviews,
      corrections: [],
      closures: [],
      adjudications: [],
    };
    expect(evaluateExhaustiveCoverage(frozen.plan, envelope).accepted).toBe(true);

    const wrongProtocol = structuredClone(envelope);
    const firstProtocolReview = wrongProtocol.reviews.at(0);
    if (firstProtocolReview === undefined) throw new Error('fixture review is absent');
    firstProtocolReview.evidence.protocolEvidence.protocol.protocolBlob = 'f'.repeat(64);
    expect(() => evaluateExhaustiveCoverage(frozen.plan, wrongProtocol)).toThrow(
      /does not bind the frozen protocol/,
    );

    const wrongExecutor = structuredClone(envelope);
    const firstExecutorReview = wrongExecutor.reviews.at(0);
    if (firstExecutorReview === undefined) throw new Error('fixture review is absent');
    firstExecutorReview.evidence.receipt.executor.version = 'forged-version';
    firstExecutorReview.evidence.phaseReceipts.cold.receipt.executor.version = 'forged-version';
    firstExecutorReview.evidence.phaseReceipts.informed.receipt.executor.version = 'forged-version';
    expect(() => evaluateExhaustiveCoverage(frozen.plan, wrongExecutor)).toThrow(
      /does not bind the frozen executor/,
    );
  }, 20_000);

  test('directory currency follows direct topology rather than descendant source bytes', () => {
    const inputs = {
      entries: [entry('apps/alpha/src/index.ts')],
      projects: [],
      explicitDocumentationPaths: [],
      riskStratum: 'risk.standard',
      shardPrefixLength: 2,
    };
    const baseline = deriveExhaustivePopulation(inputs);
    const edited = deriveExhaustivePopulation({
      ...inputs,
      entries: [{ ...inputs.entries[0], blob: 'b'.repeat(40) }],
    });
    const expanded = deriveExhaustivePopulation({
      ...inputs,
      entries: [...inputs.entries, entry('apps/alpha/src/new.ts')],
    });
    const newRootChild = deriveExhaustivePopulation({
      ...inputs,
      entries: [...inputs.entries, entry('new-project/src/index.ts')],
    });
    const directoryIdentity = (population: ReturnType<typeof deriveExhaustivePopulation>) =>
      population.subjects.find(
        (subject) =>
          subject.kind === 'directory' &&
          subject.locator.kind === 'path' &&
          subject.locator.path === 'apps/alpha/src',
      )?.contentIdentity;

    expect(directoryIdentity(edited)).toBe(directoryIdentity(baseline));
    expect(directoryIdentity(expanded)).not.toBe(directoryIdentity(baseline));
    const rootIdentity = (population: ReturnType<typeof deriveExhaustivePopulation>) =>
      population.subjects.find(
        (subject) => subject.kind === 'directory' && subject.locator.kind === 'repository-root',
      )?.contentIdentity;
    expect(rootIdentity(newRootChild)).not.toBe(rootIdentity(baseline));
  });

  test('valid evidence bytes rerun graph validation without changing content-only identity', () => {
    const fixture = repositoryFixture();
    const baseline = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );
    const baselineGraph = fixture.documents.artifactGraph;
    write(
      join(fixture.repository, 'docs/review-evidence/receipt.json'),
      serializeCanonical({
        schemaVersion: 1,
        recordKind: 'opaque-transcript',
        invocationId: 'invocation.fixture',
        mediaType: 'text/plain',
        payload: 'changed but valid retained fixture',
      }),
    );
    runGit(fixture.repository, ['add', '--all']);
    runGit(fixture.repository, ['commit', '--quiet', '--message', 'change evidence']);
    refreshCandidate(fixture, runGit(fixture.repository, ['rev-parse', 'HEAD']));
    const changed = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );

    expect(changed.plan.contentIdentity).toBe(baseline.plan.contentIdentity);
    expect(changed.plan.evidenceValidationIdentity).not.toBe(
      baseline.plan.evidenceValidationIdentity,
    );
    const staleGraph = structuredClone(fixture.documents);
    staleGraph.artifactGraph = baselineGraph;
    expect(() =>
      freezeExhaustivePlan(fixture.repository, fixture.revision, staleGraph, 'seed.fixture'),
    ).toThrow('artifact descriptor differs from selected evidence');
  }, 20_000);

  test('pinned pre-move mapping survives checkout drift but refuses a different candidate', () => {
    const fixture = repositoryFixture();
    const frozen = freezeExhaustivePlan(
      fixture.repository,
      fixture.revision,
      fixture.documents,
      'seed.fixture',
    );
    runGit(fixture.repository, ['mv', 'apps/alpha/src/index.ts', 'apps/alpha/src/moved.ts']);
    expect(
      verifyExhaustivePlan(
        fixture.repository,
        frozen.identity,
        frozen.plan,
        fixture.documents,
        'seed.fixture',
      ).identity,
    ).toBe(frozen.identity);
    const pinnedMapping = fixture.documents.moduleMapping;
    runGit(fixture.repository, ['commit', '--quiet', '--message', 'move source']);
    const movedRevision = runGit(fixture.repository, ['rev-parse', 'HEAD']);
    const relationshipRequest = structuredClone(fixture.documents.relationshipRequest.input) as {
      typescript: { publicEntrypoints: string[] };
    };
    relationshipRequest.typescript.publicEntrypoints = ['apps/alpha/src/moved.ts'];
    fixture.documents.relationshipRequest = document(relationshipRequest);
    refreshCandidate(fixture, movedRevision);
    fixture.documents.moduleMapping = pinnedMapping;
    expect(() =>
      freezeExhaustivePlan(fixture.repository, movedRevision, fixture.documents, 'seed.fixture'),
    ).toThrow(/module mapping source .* differs from candidate/);
  }, 20_000);

  test('production freeze refuses a hidden executable in the evidence root', () => {
    const fixture = repositoryFixture();
    write(join(fixture.repository, 'docs/review-evidence/run.sh'), '#!/bin/sh\nexit 0\n');
    runGit(fixture.repository, ['add', '--all']);
    runGit(fixture.repository, ['commit', '--quiet', '--message', 'hide executable evidence']);
    refreshCandidate(fixture, runGit(fixture.repository, ['rev-parse', 'HEAD']));

    expect(() =>
      freezeExhaustivePlan(fixture.repository, fixture.revision, fixture.documents, 'seed.fixture'),
    ).toThrow('source-like path is not an evidence schema: docs/review-evidence/run.sh');
  }, 20_000);

  test('freeze names wrong bytes for every policy, protocol, mapping, model and graph input', () => {
    const fixture = repositoryFixture();
    const names = [
      'modelContext',
      'classificationPolicy',
      'inventoryProtocol',
      'reviewProtocol',
      'moduleMapping',
      'granularityPolicy',
      'artifactGraph',
    ] as const;
    for (const name of names) {
      const changed = structuredClone(fixture.documents);
      changed[name] = { ...changed[name], bytes: Buffer.from('{}', 'utf8') };
      expect(() =>
        freezeExhaustivePlan(fixture.repository, fixture.revision, changed, 'seed.fixture'),
      ).toThrow(`exhaustive ${name} bytes differ from decoded input`);
    }
  });

  test('freeze names an unresolved stable module membership', () => {
    const fixture = repositoryFixture();
    const changed = structuredClone(fixture.documents);
    const mapping = structuredClone(changed.moduleMapping.input) as {
      modules: { memberships: { kind: 'path'; path: string }[] }[];
    };
    const module = mapping.modules.at(0);
    if (module === undefined) throw new Error('fixture module is absent');
    module.memberships[0] = { kind: 'path', path: 'missing/module-path.ts' };
    changed.moduleMapping = document(mapping);
    expect(() =>
      freezeExhaustivePlan(fixture.repository, fixture.revision, changed, 'seed.fixture'),
    ).toThrow(
      'exhaustive module mapping group module.alpha has unresolved membership: missing/module-path.ts',
    );
  }, 20_000);

  test('production CLI names missing and unreadable exhaustive inputs', () => {
    const fixture = repositoryFixture();
    const missingPaths = [...fixture.paths];
    missingPaths[8] = join(fixture.repository, 'missing-model-context.json');
    const missing = runFreezeCli(fixture, missingPaths);
    expect(missing.exitCode).toBe(1);
    expect(cliOutput(missing)).toContain('cannot read JSON input');
    expect(cliOutput(missing)).toContain('missing-model-context.json');

    const unreadablePaths = [...fixture.paths];
    unreadablePaths[10] = fixture.repository;
    const unreadable = runFreezeCli(fixture, unreadablePaths);
    expect(unreadable.exitCode).toBe(1);
    expect(cliOutput(unreadable)).toContain(`cannot read JSON input ${fixture.repository}`);
  }, 20_000);

  test('production freeze refuses equal-count path, mode and blob inventory substitutions', () => {
    const fixture = repositoryFixture();
    const baseline = runFreezeCli(fixture);
    expect(baseline.exitCode, cliOutput(baseline)).toBe(0);

    const inventoryPath = fixture.paths.at(0);
    if (inventoryPath === undefined) throw new Error('fixture inventory path is absent');
    const original = structuredClone(fixture.documents.inventory.input) as {
      inventoryId: string;
      entries: { path: string; mode: string; blob: string }[];
    };
    const root = original.entries.find(({ path }) => path === 'apps/alpha/src/index.ts');
    if (root === undefined) throw new Error('fixture source tuple is absent');
    const assertRefused = (inventory: typeof original, expected: string): void => {
      inventory.entries.sort((left, right) =>
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
      );
      inventory.inventoryId = `inventory.${hashCanonical(inventory)}`;
      writeFileSync(inventoryPath, serializeCanonical(inventory));
      const invocation = runFreezeCli(fixture);
      expect(invocation.exitCode, cliOutput(invocation)).toBe(1);
      expect(cliOutput(invocation)).toContain(expected);
    };

    const pathSubstitution = structuredClone(original);
    const replaced = pathSubstitution.entries.find(({ path }) => path === root.path);
    if (replaced === undefined) throw new Error('fixture replacement tuple is absent');
    replaced.path = 'apps/alpha/src/substitute.ts';
    assertRefused(pathSubstitution, 'exhaustive inventory missing tuple: apps/alpha/src/index.ts');

    const modeSubstitution = structuredClone(original);
    const remoded = modeSubstitution.entries.find(({ path }) => path === root.path);
    if (remoded === undefined) throw new Error('fixture mode tuple is absent');
    remoded.mode = '100755';
    assertRefused(
      modeSubstitution,
      'exhaustive inventory mode differs for apps/alpha/src/index.ts',
    );

    const blobSubstitution = structuredClone(original);
    const reblobbed = blobSubstitution.entries.find(({ path }) => path === root.path);
    if (reblobbed === undefined) throw new Error('fixture blob tuple is absent');
    reblobbed.blob = 'f'.repeat(40);
    assertRefused(
      blobSubstitution,
      'exhaustive inventory blob differs for apps/alpha/src/index.ts',
    );
  }, 20_000);
});
