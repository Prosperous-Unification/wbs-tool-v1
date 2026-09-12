import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { decodeRecord, type RecordKind } from './decode-record';

const SHA1_A = '1111111111111111111111111111111111111111';
const SHA1_B = '2222222222222222222222222222222222222222';
const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const ISO_START = '2026-09-10T17:00:00.000Z';
const ISO_END = '2026-09-10T17:01:00.000Z';

const membership = { kind: 'path', path: 'libs/domain/src/index.ts' };
const mapping = (groupId: string) => ({ groups: [{ groupId, memberships: [membership] }] });

const candidateInventory = {
  schemaVersion: 1,
  inventoryId: 'inventory.baseline.7851161b',
  protocol: { protocolId: 'inventory.v1', blob: SHA256_A },
  selection: { kind: 'committed', revision: SHA1_A, tree: SHA1_B },
  entries: [{ path: 'libs/domain/src/index.ts', mode: '100644', blob: SHA1_A }],
  untracked: [],
  classificationPolicy: { policyId: 'policy.baseline', blob: SHA256_B },
};

const candidateEntry = {
  schemaVersion: 1,
  path: 'libs/domain/src/index.ts',
  mode: '100644',
  blob: SHA1_A,
};

const classificationPolicy = {
  schemaVersion: 1,
  policyId: 'classification.baseline.v1',
  selectorVersion: 1,
  contentClasses: [
    'source',
    'test',
    'config',
    'script',
    'migration',
    'fixture',
    'generated',
    'vendored',
    'placeholder',
    'document',
    'openspec',
  ],
  contentRules: [
    {
      contentClass: 'source',
      include: [{ kind: 'suffix', value: '.ts' }],
      exclude: [{ kind: 'suffix', value: '.test.ts' }],
    },
    {
      contentClass: 'test',
      include: [{ kind: 'suffix', value: '.test.ts' }],
      exclude: [],
    },
    {
      contentClass: 'config',
      include: [{ kind: 'name', value: 'project.json' }],
      exclude: [],
    },
    {
      contentClass: 'script',
      include: [{ kind: 'suffix', value: '.sh' }],
      exclude: [],
    },
    {
      contentClass: 'migration',
      include: [{ kind: 'segment', value: 'migrations' }],
      exclude: [],
    },
    {
      contentClass: 'fixture',
      include: [{ kind: 'segment', value: 'fixtures' }],
      exclude: [],
    },
    {
      contentClass: 'generated',
      include: [{ kind: 'segment', value: 'generated' }],
      exclude: [],
    },
    {
      contentClass: 'vendored',
      include: [{ kind: 'segment', value: 'vendor' }],
      exclude: [],
    },
    {
      contentClass: 'placeholder',
      include: [{ kind: 'name', value: '.gitkeep' }],
      exclude: [],
    },
    {
      contentClass: 'document',
      include: [{ kind: 'suffix', value: '.md' }],
      exclude: [{ kind: 'prefix', value: 'openspec' }],
    },
    {
      contentClass: 'openspec',
      include: [{ kind: 'prefix', value: 'openspec' }],
      exclude: [],
    },
  ],
  evidenceRoots: [
    {
      path: 'docs/review-evidence',
      allowedRecordKinds: ['review-receipt', 'opaque-transcript'],
    },
    { path: 'docs/experiment-evidence', allowedRecordKinds: ['experiment-manifest'] },
  ],
  binaryDeclarations: [],
  gitlinkBoundaries: [],
  symlinks: 'inventory-only',
  gitlinks: 'declared-external-boundary',
};

const granularityPolicy = {
  schemaVersion: 1,
  policyId: 'granularity.baseline.v1',
  mappingVersion: 'baseline-layout-v1',
  mappings: {
    knowledge: mapping('knowledge.domain'),
    review: mapping('review.domain'),
    ownership: mapping('ownership.domain'),
    task: mapping('task.domain'),
    integration: mapping('integration.domain'),
  },
};

const moduleMapping = {
  schemaVersion: 1,
  mappingId: 'modules.baseline.v1',
  mappingVersion: 'baseline-layout-v1',
  sourceRevision: SHA1_A,
  modules: [
    {
      moduleId: 'module.domain.schedule',
      name: 'Schedule domain',
      memberships: [membership],
      predecessorModuleIds: [],
      indexPath: 'libs/domain/README.md',
      externalConsumers: { kind: 'declared', memberships: [{ kind: 'path', path: 'apps/be-01' }] },
    },
  ],
};

const invocationReceipt = {
  schemaVersion: 1,
  receiptKind: 'invocation',
  receiptId: 'receipt.invocation.1',
  invocationId: 'invocation.1',
  startedAt: ISO_START,
  endedAt: ISO_END,
  status: 'completed',
  executor: {
    provider: 'openai',
    model: 'gpt-5',
    version: '2026-09-10',
    effort: 'high',
    toolchain: 'codex',
  },
  rawUsage: [
    { category: 'input_tokens', quantity: 1200, unit: 'tokens' },
    { category: 'output_tokens', quantity: 300, unit: 'tokens' },
  ],
  priceIdentity: {
    priceId: 'openai.gpt-5.2026-09-10',
    provider: 'openai',
    model: 'gpt-5',
    currency: 'USD',
    source: 'provider-receipt',
  },
  chargedAmountMicros: 25_000,
  inputArtifact: SHA256_A,
  outputArtifact: SHA256_B,
};

const elapsedReceipt = {
  schemaVersion: 1,
  receiptKind: 'elapsed',
  receiptId: 'receipt.elapsed.1',
  trialId: 'trial.1',
  outcomeId: 'outcome.independent.1',
  attemptId: 'attempt.1',
  phase: 'discovery',
  startedAt: ISO_START,
  endedAt: ISO_END,
  elapsedMs: 60_000,
  status: 'completed',
};

const checkReceipt = {
  schemaVersion: 1,
  receiptKind: 'check',
  receiptId: 'receipt.check.1',
  command: ['bunx', 'nx', 'test', 'tool-wiki'],
  cwdIdentity: 'repository-root',
  startedAt: ISO_START,
  endedAt: ISO_END,
  elapsedMs: 60_000,
  status: 'passed',
  exitCode: 0,
  candidateManifest: SHA256_A,
  toolIdentity: SHA256_B,
  resourceLane: 'default',
  stdoutArtifact: SHA256_A,
  stderrArtifact: SHA256_B,
  skips: [],
};

const reviewReceipt = {
  schemaVersion: 1,
  receiptKind: 'review',
  receiptId: 'receipt.review.1',
  invocationId: 'invocation.1',
  executor: invocationReceipt.executor,
  suppliedContextIds: [SHA256_A],
  observedReadIds: [SHA256_B],
  rawResponseArtifact: SHA256_A,
  rawUsage: invocationReceipt.rawUsage,
  priceIdentity: invocationReceipt.priceIdentity,
  trust: { scope: 'local-cooperative', journalId: 'journal.local.1' },
};

const experimentManifest = {
  schemaVersion: 1,
  manifestId: 'experiment.radical-modularity.baseline.v1',
  repository: { revision: SHA1_A, tree: SHA1_B, inventoryId: candidateInventory.inventoryId },
  corpus: {
    corpusId: 'radical-modularity.fixed-corpus.v1',
    acceptanceId: 'radical-modularity.acceptance.v1',
    outcomes: [
      {
        outcomeId: 'outcome.independent.1',
        title: 'Independent module outcome',
        stratum: 'independent-module',
        heldOut: false,
        acceptanceCriteria: ['bunx nx test domain --skip-nx-cache exits 0'],
      },
      {
        outcomeId: 'outcome.shared.1',
        title: 'Shared contract outcome',
        stratum: 'shared-contract',
        heldOut: true,
        acceptanceCriteria: ['bunx nx typecheck contracts --skip-nx-cache exits 0'],
      },
    ],
  },
  granularity: {
    policyId: granularityPolicy.policyId,
    mappingVersion: granularityPolicy.mappingVersion,
    mappingBlob: SHA256_A,
  },
  reviewProtocol: { protocolId: 'review.cold-informed.v1', protocolBlob: SHA256_B },
  execution: {
    provider: 'openai',
    model: 'gpt-5',
    version: '2026-09-10',
    effort: 'high',
    promptHash: SHA256_A,
    toolHash: SHA256_B,
  },
  resources: {
    resourceId: 'h2puni.controlled.v1',
    allocationMode: 'fixed-total',
    maxConcurrentSessions: 8,
    cacheCondition: 'cold',
  },
  seeds: [104729, 130363, 155921],
  retryPolicy: { maxAttemptsPerOutcome: 3, timeBudgetMs: 3_600_000 },
  integrationPolicy: { maxSubmissions: 4, maxWaitMs: 300_000 },
  priceIdentity: invocationReceipt.priceIdentity,
  receiptJournal: { journalId: 'receipts.radical-modularity.v1', schemaVersion: 1 },
  observation: { postAcceptanceDefectWindowHours: 24 },
  hypotheses: {
    q2OverQ1Minimum: 1.6,
    q4OverQ1Minimum: 3.2,
    q8OverQ1Minimum: 6.4,
    conflictRateMaximum: 0.05,
    integrationReworkRateMaximum: 0.1,
    medianDiscoveryMsMaximum: 300_000,
    reviewAmplificationMaximum: 3,
    leaseWaitFractionMaximum: 0.1,
  },
};

const benchmarkCorpus = {
  schemaVersion: 1,
  corpusId: experimentManifest.corpus.corpusId,
  acceptanceId: experimentManifest.corpus.acceptanceId,
  repository: experimentManifest.repository,
  outcomes: experimentManifest.corpus.outcomes,
};

const validRecords: readonly (readonly [RecordKind, object])[] = [
  ['benchmark-corpus', benchmarkCorpus],
  ['candidate-entry', candidateEntry],
  ['candidate-inventory', candidateInventory],
  ['classification-policy', classificationPolicy],
  ['granularity-policy', granularityPolicy],
  ['module-mapping', moduleMapping],
  ['invocation-receipt', invocationReceipt],
  ['elapsed-receipt', elapsedReceipt],
  ['check-receipt', checkReceipt],
  ['review-receipt', reviewReceipt],
  ['experiment-manifest', experimentManifest],
];

const scratchRoot = join(import.meta.dir, '.contract-test-scratch');

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

const validateViaCli = (kind: RecordKind, record: object, name: string) => {
  mkdirSync(scratchRoot, { recursive: true });
  const recordPath = join(scratchRoot, `${name}.json`);
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`, 'utf8');
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      'run',
      join(import.meta.dir, '..', 'cli.ts'),
      'validate',
      kind,
      recordPath,
    ],
    cwd: join(import.meta.dir, '..', '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: child.exitCode,
    output: `${child.stdout.toString()}${child.stderr.toString()}`,
  };
};

describe('strict contract decoders', () => {
  test('keeps shipped schema fixtures valid', () => {
    const fixtureCases: readonly (readonly [RecordKind, string])[] = [
      ['benchmark-corpus', 'benchmark-corpus.v1.json'],
      ['classification-policy', 'classification-policy.v1.json'],
      ['elapsed-receipt', 'elapsed-receipt.v1.json'],
      ['experiment-manifest', 'experiment-manifest.v1.json'],
      ['granularity-policy', 'granularity-policy.v1.json'],
      ['invocation-receipt', 'invocation-receipt.v1.json'],
      ['module-mapping', 'module-mapping.v1.json'],
    ];

    for (const [kind, name] of fixtureCases) {
      const parsed = JSON.parse(
        readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8'),
      ) as unknown;
      expect(() => decodeRecord(kind, parsed)).not.toThrow();
    }
  });

  test('pins the unmet source-certification outcome to both real source gates', () => {
    const corpusPath = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      'docs',
      'experiment-evidence',
      'fixed-benchmark-corpus.v1.json',
    );
    const corpusRecord = decodeRecord(
      'benchmark-corpus',
      JSON.parse(readFileSync(corpusPath, 'utf8')) as unknown,
    );
    if (!('outcomes' in corpusRecord)) throw new Error('benchmark decoder returned another kind');
    const outcome = corpusRecord.outcomes.find(
      ({ outcomeId }) => outcomeId === 'outcome.source-certification-execution',
    );

    expect(outcome).toEqual({
      outcomeId: 'outcome.source-certification-execution',
      title: 'Real-source conformance certification execution',
      stratum: 'shared-contract',
      heldOut: false,
      acceptanceCriteria: [
        'both real sources independently execute every offered conformance body and refuse partial, skipped or failed certification',
        'bunx nx run store-sqlite:test:conformance --skip-nx-cache exits 0',
        'bunx nx run store-memory:test:conformance --skip-nx-cache exits 0',
      ],
    });
    expect(
      corpusRecord.outcomes.some(({ outcomeId }) => outcomeId === 'outcome.event-log-conformance'),
    ).toBe(false);
  });

  test('accept representative records without discarding their raw receipt fields', () => {
    for (const [kind, record] of validRecords) {
      expect(decodeRecord(kind, record) as object).toEqual(record);
    }
  });

  test('rejects a missing required field', () => {
    const malformed = structuredClone(candidateInventory);
    Reflect.deleteProperty(malformed.selection, 'tree');

    expect(() => decodeRecord('candidate-inventory', malformed)).toThrow('selection.tree');
  });

  test('accepts Git bytewise path order independently of the host locale', () => {
    const gitOrdered = structuredClone(candidateInventory);
    gitOrdered.entries = [
      { path: 'A.ts', mode: '100644', blob: SHA1_A },
      { path: 'a.ts', mode: '100644', blob: SHA1_B },
    ];

    expect(decodeRecord('candidate-inventory', gitOrdered) as object).toEqual(gitOrdered);
  });

  test('rejects every unknown schema version', () => {
    for (const [kind, record] of validRecords) {
      expect(() => decodeRecord(kind, { ...record, schemaVersion: 2 })).toThrow('schemaVersion');
    }
  });

  test('rejects traversal and wildcard membership grammar', () => {
    for (const invalidPath of [
      '../secrets',
      '/absolute',
      'libs/**',
      'libs/../apps',
      'libs\\core',
    ]) {
      const malformed = structuredClone(granularityPolicy);
      malformed.mappings.knowledge.groups[0].memberships[0] = {
        kind: 'path',
        path: invalidPath,
      };
      expect(() => decodeRecord('granularity-policy', malformed)).toThrow('memberships');
    }
  });

  test('requires five independently declared granularity mappings', () => {
    for (const dimension of ['knowledge', 'review', 'ownership', 'task', 'integration'] as const) {
      const malformed = structuredClone(granularityPolicy);
      Reflect.deleteProperty(malformed.mappings, dimension);
      expect(() => decodeRecord('granularity-policy', malformed)).toThrow(`mappings.${dimension}`);
    }
  });

  test('rejects duplicate stable module identities', () => {
    const malformed = structuredClone(moduleMapping);
    malformed.modules.push({ ...malformed.modules[0], name: 'Duplicate identity' });

    expect(() => decodeRecord('module-mapping', malformed)).toThrow('unique moduleId');
  });

  test('rejects duplicate fixed outcome identities', () => {
    const malformed = structuredClone(experimentManifest);
    malformed.corpus.outcomes.push({ ...malformed.corpus.outcomes[0], title: 'Duplicate outcome' });

    expect(() => decodeRecord('experiment-manifest', malformed)).toThrow('unique outcomeId');
  });

  test('requires append-only raw usage, price identity and elapsed-time receipts', () => {
    for (const field of ['rawUsage', 'priceIdentity'] as const) {
      const malformed = structuredClone(invocationReceipt);
      Reflect.deleteProperty(malformed, field);
      expect(() => decodeRecord('invocation-receipt', malformed)).toThrow(field);
    }
    const malformedElapsed = structuredClone(elapsedReceipt);
    Reflect.deleteProperty(malformedElapsed, 'elapsedMs');
    expect(() => decodeRecord('elapsed-receipt', malformedElapsed)).toThrow('elapsedMs');
  });
});

describe('production CLI validation boundary', () => {
  test('rejects noncanonical candidate and membership paths', () => {
    const dotEntry = { ...candidateEntry, path: '.' };
    const prefixedEntry = { ...candidateEntry, path: './libs/domain.ts' };
    const nulEntry = { ...candidateEntry, path: 'libs/domain\u0000.ts' };
    const internalDotPolicy = structuredClone(granularityPolicy);
    internalDotPolicy.mappings.knowledge.groups[0].memberships[0] = {
      kind: 'path',
      path: 'libs/./domain.ts',
    };

    const refusals = [
      validateViaCli('candidate-entry', dotEntry, 'dot-entry'),
      validateViaCli('candidate-entry', prefixedEntry, 'prefixed-entry'),
      validateViaCli('candidate-entry', nulEntry, 'nul-entry'),
      validateViaCli('granularity-policy', internalDotPolicy, 'internal-dot-policy'),
    ];

    expect(
      refusals.map(({ exitCode }) => exitCode),
      refusals.map(({ output }) => output).join('\n'),
    ).toEqual([1, 1, 1, 1]);
  });

  test('rejects invalid instants, reversed intervals and inconsistent elapsed milliseconds', () => {
    const invalidInstant = {
      ...invocationReceipt,
      startedAt: '2026-02-30T17:00:00.000Z',
    };
    const reversedInvocation = {
      ...invocationReceipt,
      startedAt: ISO_END,
      endedAt: ISO_START,
    };
    const inconsistentElapsed = { ...elapsedReceipt, elapsedMs: 59_999 };
    const inconsistentCheck = { ...checkReceipt, elapsedMs: 60_001 };

    const refusals = [
      validateViaCli('invocation-receipt', invalidInstant, 'invalid-instant'),
      validateViaCli('invocation-receipt', reversedInvocation, 'reversed-invocation'),
      validateViaCli('elapsed-receipt', inconsistentElapsed, 'inconsistent-elapsed'),
      validateViaCli('check-receipt', inconsistentCheck, 'inconsistent-check'),
    ];

    expect(
      refusals.map(({ exitCode }) => exitCode),
      refusals.map(({ output }) => output).join('\n'),
    ).toEqual([1, 1, 1, 1]);
  });

  test('rejects empty outcome sets and blank acceptance criteria on both corpus paths', () => {
    const emptyCorpus = { ...benchmarkCorpus, outcomes: [] };
    const emptyManifest = structuredClone(experimentManifest);
    emptyManifest.corpus.outcomes = [];
    const blankCorpus = structuredClone(benchmarkCorpus);
    blankCorpus.outcomes[0].acceptanceCriteria = ['   '];
    const blankManifest = structuredClone(experimentManifest);
    blankManifest.corpus.outcomes[0].acceptanceCriteria = ['\t'];

    const refusals = [
      validateViaCli('benchmark-corpus', emptyCorpus, 'empty-corpus'),
      validateViaCli('experiment-manifest', emptyManifest, 'empty-manifest'),
      validateViaCli('benchmark-corpus', blankCorpus, 'blank-corpus'),
      validateViaCli('experiment-manifest', blankManifest, 'blank-manifest'),
    ];

    expect(
      refusals.map(({ exitCode }) => exitCode),
      refusals.map(({ output }) => output).join('\n'),
    ).toEqual([1, 1, 1, 1]);
  });

  test('rejects completed invocation receipts with empty raw usage', () => {
    const emptyUsage = { ...invocationReceipt, rawUsage: [] };
    const refusal = validateViaCli('invocation-receipt', emptyUsage, 'empty-usage');

    expect(refusal.exitCode, refusal.output).toBe(1);
  });

  test('accepts every representative record and rejects each decoder fault', () => {
    mkdirSync(scratchRoot, { recursive: true });
    const cliPath = join(import.meta.dir, '..', 'cli.ts');

    const cases: {
      kind: RecordKind;
      record: object;
      expectedExit: number;
      expectedText: string;
    }[] = validRecords.map(([kind, record]) => ({
      kind,
      record,
      expectedExit: 0,
      expectedText: `valid ${kind}`,
    }));

    const missing = structuredClone(candidateInventory);
    Reflect.deleteProperty(missing.selection, 'tree');
    cases.push({
      kind: 'candidate-inventory',
      record: missing,
      expectedExit: 1,
      expectedText: 'selection.tree',
    });
    const duplicateEntries = structuredClone(candidateInventory);
    duplicateEntries.entries.push(duplicateEntries.entries[0]);
    cases.push({
      kind: 'candidate-inventory',
      record: duplicateEntries,
      expectedExit: 1,
      expectedText: 'unique paths',
    });
    const unsortedEntries = structuredClone(candidateInventory);
    unsortedEntries.entries = [
      { path: 'z.ts', mode: '100644', blob: SHA1_A },
      { path: 'a.ts', mode: '100644', blob: SHA1_B },
    ];
    cases.push({
      kind: 'candidate-inventory',
      record: unsortedEntries,
      expectedExit: 1,
      expectedText: 'sorted by path',
    });
    cases.push({
      kind: 'candidate-entry',
      record: { ...candidateEntry, schemaVersion: 99 },
      expectedExit: 1,
      expectedText: 'schemaVersion',
    });
    const badMembership = structuredClone(granularityPolicy);
    badMembership.mappings.ownership.groups[0].memberships[0] = {
      kind: 'path',
      path: '../escape',
    };
    cases.push({
      kind: 'granularity-policy',
      record: badMembership,
      expectedExit: 1,
      expectedText: 'memberships',
    });
    const badExclusion = structuredClone(granularityPolicy);
    Reflect.set(badExclusion.mappings.review.groups[0].memberships, 0, {
      kind: 'directory-prefix',
      prefix: 'libs/domain',
      exclusions: ['apps/be-01'],
    });
    cases.push({
      kind: 'granularity-policy',
      record: badExclusion,
      expectedExit: 1,
      expectedText: 'memberships',
    });
    const missingMapping = structuredClone(granularityPolicy);
    Reflect.deleteProperty(missingMapping.mappings, 'integration');
    cases.push({
      kind: 'granularity-policy',
      record: missingMapping,
      expectedExit: 1,
      expectedText: 'mappings.integration',
    });
    const duplicateGroups = structuredClone(granularityPolicy);
    duplicateGroups.mappings.task.groups.push(duplicateGroups.mappings.task.groups[0]);
    cases.push({
      kind: 'granularity-policy',
      record: duplicateGroups,
      expectedExit: 1,
      expectedText: 'unique groupId',
    });
    const duplicateModules = structuredClone(moduleMapping);
    duplicateModules.modules.push(duplicateModules.modules[0]);
    cases.push({
      kind: 'module-mapping',
      record: duplicateModules,
      expectedExit: 1,
      expectedText: 'unique moduleId',
    });
    const duplicateOutcomes = structuredClone(experimentManifest);
    duplicateOutcomes.corpus.outcomes.push(duplicateOutcomes.corpus.outcomes[0]);
    cases.push({
      kind: 'experiment-manifest',
      record: duplicateOutcomes,
      expectedExit: 1,
      expectedText: 'unique outcomeId',
    });
    const duplicateCorpusOutcomes = structuredClone(benchmarkCorpus);
    duplicateCorpusOutcomes.outcomes.push(duplicateCorpusOutcomes.outcomes[0]);
    cases.push({
      kind: 'benchmark-corpus',
      record: duplicateCorpusOutcomes,
      expectedExit: 1,
      expectedText: 'unique outcomeId',
    });
    const emptyAcceptance = structuredClone(benchmarkCorpus);
    emptyAcceptance.outcomes[0].acceptanceCriteria = [];
    cases.push({
      kind: 'benchmark-corpus',
      record: emptyAcceptance,
      expectedExit: 1,
      expectedText: 'acceptance criterion',
    });
    const insufficientSeeds = structuredClone(experimentManifest);
    insufficientSeeds.seeds = [104729, 130363];
    cases.push({
      kind: 'experiment-manifest',
      record: insufficientSeeds,
      expectedExit: 1,
      expectedText: 'three randomized seeds',
    });
    const missingUsage = structuredClone(invocationReceipt);
    Reflect.deleteProperty(missingUsage, 'rawUsage');
    cases.push({
      kind: 'invocation-receipt',
      record: missingUsage,
      expectedExit: 1,
      expectedText: 'rawUsage',
    });
    const missingPrice = structuredClone(invocationReceipt);
    Reflect.deleteProperty(missingPrice, 'priceIdentity');
    cases.push({
      kind: 'invocation-receipt',
      record: missingPrice,
      expectedExit: 1,
      expectedText: 'priceIdentity',
    });
    cases.push({
      kind: 'invocation-receipt',
      record: { ...invocationReceipt, receiptBlob: SHA256_A },
      expectedExit: 1,
      expectedText: 'receiptBlob',
    });
    const missingElapsed = structuredClone(elapsedReceipt);
    Reflect.deleteProperty(missingElapsed, 'elapsedMs');
    cases.push({
      kind: 'elapsed-receipt',
      record: missingElapsed,
      expectedExit: 1,
      expectedText: 'elapsedMs',
    });

    for (const [caseIndex, validationCase] of cases.entries()) {
      const recordPath = join(scratchRoot, `${String(caseIndex)}.json`);
      writeFileSync(recordPath, `${JSON.stringify(validationCase.record)}\n`, 'utf8');
      const child = Bun.spawnSync({
        cmd: [process.execPath, 'run', cliPath, 'validate', validationCase.kind, recordPath],
        cwd: join(import.meta.dir, '..', '..', '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = `${child.stdout.toString()}${child.stderr.toString()}`;
      expect(child.exitCode, output).toBe(validationCase.expectedExit);
      expect(output).toContain(validationCase.expectedText);
    }
    // Proof: the complete local suite timed this production path out at 25013.97ms
    // under its former 25-second ceiling, after its child returned no exit code.
  }, 45_000);
});
