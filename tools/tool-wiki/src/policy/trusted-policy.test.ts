import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { resolveValidatorArtifactPaths } from './trust';

const cliPath = join(import.meta.dir, '..', 'cli.ts');
const trustPath = join(import.meta.dir, 'trust.ts');
const scratchPaths: string[] = [];

type Mode = 'observe' | 'ratchet' | 'enforce';

interface CandidateFixture {
  repository: string;
  baselineRevision: string;
  revision: string;
  trustDirectory: string;
  bindingPath: string;
  evidencePath: string;
  policyPath: string;
}

interface LintReportFixture {
  accepted: boolean;
  certified: boolean;
  candidateSelection: { kind: string };
  untrackedPaths: string[];
  debtObligationIds: string[];
  unmetObligationIds: string[];
  deterministicChecks: { kind: string }[];
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function runGit(repository: string, argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = invocation.stderr.toString('utf8');
  expect(invocation.exitCode, stderr).toBe(0);
  return invocation.stdout.toString('utf8').trim();
}

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}

function commit(repository: string, message: string): string {
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '--message', message]);
  return runGit(repository, ['rev-parse', 'HEAD']);
}

function indexSource(paths: string[]): string {
  const metadata = {
    schemaVersion: 1,
    moduleId: 'module.fixture',
    memberships: paths.map((path) => ({ kind: 'path', path })),
    relationshipSelectors: [],
    inapplicableSections: [
      { section: 'relationships', reason: 'The trust fixture has no declared relationships.' },
      { section: 'invariants', reason: 'The trust fixture has no cross-file runtime invariant.' },
      { section: 'checks', reason: 'The trusted lint command is the fixture boundary check.' },
    ],
    externalConsumers: {
      kind: 'none-known',
      knowledgeLimit: 'Only consumers visible in the selected fixture were considered.',
    },
  };
  return `# Fixture\n\n<!-- wbs-index ${JSON.stringify(metadata)} -->\n`;
}

function classificationPolicy(): object {
  const empty = (contentClass: string, include: object[]) => ({
    contentClass,
    include,
    exclude: [],
  });
  return {
    schemaVersion: 1,
    policyId: 'classification.fixture.v1',
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
      empty('source', [{ kind: 'suffix', value: '.ts' }]),
      empty('test', [{ kind: 'suffix', value: '.test.ts' }]),
      empty('config', [{ kind: 'suffix', value: '.json' }]),
      empty('script', [{ kind: 'suffix', value: '.sh' }]),
      empty('migration', [{ kind: 'segment', value: 'migrations' }]),
      empty('fixture', [{ kind: 'segment', value: 'fixtures' }]),
      empty('generated', [{ kind: 'segment', value: 'generated' }]),
      empty('vendored', [{ kind: 'segment', value: 'vendor' }]),
      empty('placeholder', [{ kind: 'name', value: '.keep' }]),
      empty('document', [{ kind: 'suffix', value: '.md' }]),
      empty('openspec', [{ kind: 'prefix', value: 'openspec' }]),
    ],
    evidenceRoots: [
      { path: 'docs/review-evidence', allowedRecordKinds: ['review-receipt'] },
      { path: 'docs/experiment-evidence', allowedRecordKinds: ['experiment-manifest'] },
    ],
    binaryDeclarations: [],
    gitlinkBoundaries: [],
    symlinks: 'inventory-only',
    gitlinks: 'declared-external-boundary',
  };
}

function exactTuple(repository: string, revision: string, path: string): object {
  const record = runGit(repository, ['ls-tree', revision, '--', path]);
  const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(record);
  if (match === null) throw new Error(`missing fixture tuple: ${path}`);
  return { path: match[3], mode: match[1], blob: match[2] };
}

interface ExactTupleFixture {
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
  blob: string;
}

function entriesAt(repository: string, revision: string): ExactTupleFixture[] {
  const source = runGit(repository, ['ls-tree', '-r', revision]);
  return source.length === 0
    ? []
    : source.split('\n').map((record) => {
        const match = /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]+)\t(.+)$/.exec(
          record,
        );
        if (match === null) throw new Error(`malformed fixture tuple: ${record}`);
        const mode = match[1];
        if (mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') {
          throw new Error(`unsupported fixture mode: ${mode}`);
        }
        return { path: match[3], mode, blob: match[2] };
      });
}

function candidateIdentityAt(repository: string, revision: string): string {
  const tree = runGit(repository, ['rev-parse', `${revision}^{tree}`]);
  return hashCanonical({
    selection: { kind: 'committed', revision, tree },
    entries: entriesAt(repository, revision),
    untracked: [],
  });
}

function contentInputs(entries: ExactTupleFixture[]): object[] {
  return entries.map((entry, index) => ({
    kind: 'content',
    inputId: `content.${String(index)}`,
    ...entry,
  }));
}

function checkReceipt(checkId: string, identity: string): object {
  return {
    schemaVersion: 1,
    receiptKind: 'check',
    receiptId: `receipt.${checkId}`,
    command: ['bun', 'run', checkId],
    cwdIdentity: 'fixture.repository',
    startedAt: '2026-09-11T10:00:00.000Z',
    endedAt: '2026-09-11T10:00:01.000Z',
    elapsedMs: 1000,
    status: 'passed',
    exitCode: 0,
    candidateManifest: identity,
    toolIdentity: 'a'.repeat(64),
    resourceLane: 'fixture',
    stdoutArtifact: 'b'.repeat(64),
    stderrArtifact: 'c'.repeat(64),
    skips: [],
  };
}

function reviewReceipt(reviewId: string): object {
  return {
    schemaVersion: 1,
    receiptKind: 'review',
    receiptId: `receipt.${reviewId}`,
    invocationId: `invocation.${reviewId}`,
    executor: {
      provider: 'fixture-provider',
      model: 'fixture-model',
      version: 'fixture-version',
      effort: 'fixture-effort',
      toolchain: 'fixture-toolchain',
    },
    suppliedContextIds: ['d'.repeat(64)],
    observedReadIds: ['e'.repeat(64)],
    rawResponseArtifact: 'f'.repeat(64),
    rawUsage: [],
    priceIdentity: {
      priceId: 'price.fixture',
      provider: 'fixture-provider',
      model: 'fixture-model',
      currency: 'USD',
      source: 'fixture-price-list',
    },
    trust: { scope: 'trusted-harness', journalId: 'journal.fixture' },
  };
}

function writeEvidence(
  fixture: CandidateFixture,
  reportMode: Mode,
  metObligationIds: string[],
): void {
  const reviewedEntries = entriesAt(fixture.repository, fixture.baselineRevision);
  const currentEntries = entriesAt(fixture.repository, fixture.revision);
  const identity = candidateIdentityAt(fixture.repository, fixture.revision);
  const obligationNames = ['policy', 'validator', 'exemptions', 'application'];
  const checks = obligationNames.map((name) => `check.${name}`);
  const reviews = obligationNames.map((name) => `review.${name}`);
  write(
    fixture.evidencePath,
    `${JSON.stringify({
      schemaVersion: 1,
      reportMode,
      obligationRequest: {
        reviewed: {
          sourceBase: fixture.baselineRevision,
          candidateIdentity: candidateIdentityAt(fixture.repository, fixture.baselineRevision),
          inputs: {
            content: contentInputs(reviewedEntries),
            structural: [],
            semantic: [],
            topology: [],
          },
        },
        current: {
          sourceBase: fixture.revision,
          candidateIdentity: identity,
          inputs: {
            content: contentInputs(currentEntries),
            structural: [],
            semantic: [],
            topology: [],
          },
        },
        judgments: [],
        policy: { policyId: 'policy.trusted.v1', behaviorRules: [] },
        impactClassifications: [],
        writerLabels: [],
        checks: checks.map((checkId) => ({
          observationId: `observation.${checkId}`,
          checkId,
          candidateIdentity: identity,
          status: 'passed',
        })),
        reviews: reviews.map((judgmentId) => ({
          observationId: `observation.${judgmentId}`,
          judgmentId,
          candidateIdentity: identity,
          status: 'current',
        })),
      },
      checkReceipts: checks.map((checkId) => ({
        observationId: `observation.${checkId}`,
        receipt: checkReceipt(checkId, identity),
      })),
      reviewReceipts: reviews.map((reviewId) => ({
        observationId: `observation.${reviewId}`,
        receipt: reviewReceipt(reviewId),
      })),
      obligations: metObligationIds.map((obligationId) => {
        const name = obligationId.slice('obligation.'.length);
        return {
          obligationId,
          checkIds: [`check.${name}`],
          reviewIds: [`review.${name}`],
        };
      }),
    })}\n`,
  );
}

function writeTrust(fixture: CandidateFixture, mode: Mode): void {
  const baselineEntries = ['policy.json', 'validator.ts', 'exemptions.json', 'src/app.ts'].map(
    (path) => exactTuple(fixture.repository, fixture.revision, path),
  );
  const policy = {
    schemaVersion: 1,
    policyId: 'policy.trusted.v1',
    minimumMode: mode,
    classificationPolicy: classificationPolicy(),
    adoptedBoundaryIds: [
      'boundary.application',
      'boundary.exemptions',
      'boundary.policy',
      'boundary.validator',
    ],
    activationBoundaryIds: ['boundary.exemptions', 'boundary.policy', 'boundary.validator'],
    boundaries: [
      {
        boundaryId: 'boundary.policy',
        selector: { kind: 'path', value: 'policy.json' },
        baselineEntries: [baselineEntries[0]],
        obligationIds: ['obligation.policy'],
      },
      {
        boundaryId: 'boundary.validator',
        selector: { kind: 'path', value: 'validator.ts' },
        baselineEntries: [baselineEntries[1]],
        obligationIds: ['obligation.validator'],
      },
      {
        boundaryId: 'boundary.exemptions',
        selector: { kind: 'path', value: 'exemptions.json' },
        baselineEntries: [baselineEntries[2]],
        obligationIds: ['obligation.exemptions'],
      },
      {
        boundaryId: 'boundary.application',
        selector: { kind: 'prefix', value: 'src' },
        baselineEntries: [baselineEntries[3]],
        obligationIds: ['obligation.application'],
      },
    ],
    obligations: [
      {
        obligationId: 'obligation.policy',
        boundaryId: 'boundary.policy',
        checkIds: ['check.policy'],
        reviewIds: ['review.policy'],
      },
      {
        obligationId: 'obligation.validator',
        boundaryId: 'boundary.validator',
        checkIds: ['check.validator'],
        reviewIds: ['review.validator'],
      },
      {
        obligationId: 'obligation.exemptions',
        boundaryId: 'boundary.exemptions',
        checkIds: ['check.exemptions'],
        reviewIds: ['review.exemptions'],
      },
      {
        obligationId: 'obligation.application',
        boundaryId: 'boundary.application',
        checkIds: ['check.application'],
        reviewIds: ['review.application'],
      },
    ],
    exemptions: [],
  };
  write(fixture.policyPath, `${JSON.stringify(policy)}\n`);
  const validatorArtifacts = resolveValidatorArtifactPaths([
    cliPath,
    ...(existsSync(trustPath) ? [trustPath] : []),
  ]).map((path) => ({ path, sha256: sha256(readFileSync(path)) }));
  const binding = {
    schemaVersion: 1,
    bindingId: `binding.${mode}.v1`,
    trustScope: mode === 'enforce' ? 'ci' : 'local-operator',
    policy: { path: fixture.policyPath, sha256: sha256(readFileSync(fixture.policyPath)) },
    validator: { validatorId: 'validator.tool-wiki.v1', artifacts: validatorArtifacts },
  };
  write(fixture.bindingPath, `${JSON.stringify(binding)}\n`);
}

function createFixture(mode: Mode, reportMode: Mode = mode): CandidateFixture {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-trust-candidate-'));
  const trustDirectory = mkdtempSync(join(tmpdir(), 'tool-wiki-external-trust-'));
  scratchPaths.push(repository, trustDirectory);
  runGit(repository, ['init', '--initial-branch=main']);
  runGit(repository, ['config', 'user.email', 'trust@example.test']);
  runGit(repository, ['config', 'user.name', 'Trust Fixture']);
  const paths = ['exemptions.json', 'policy.json', 'src/app.ts', 'validator.ts'];
  write(join(repository, 'README.md'), indexSource(paths));
  write(join(repository, 'policy.json'), '{"boundaries":["policy","validator","exemptions"]}\n');
  write(join(repository, 'validator.ts'), 'export const accepts = true;\n');
  write(join(repository, 'exemptions.json'), '{"exemptions":[]}\n');
  write(join(repository, 'src/app.ts'), 'export const value = 1;\n');
  const revision = commit(repository, 'baseline');
  const fixture: CandidateFixture = {
    repository,
    baselineRevision: revision,
    revision,
    trustDirectory,
    bindingPath: join(trustDirectory, 'binding.json'),
    evidencePath: join(trustDirectory, 'evidence.json'),
    policyPath: join(trustDirectory, 'policy.json'),
  };
  writeEvidence(fixture, reportMode, [
    'obligation.policy',
    'obligation.validator',
    'obligation.exemptions',
  ]);
  writeTrust(fixture, mode);
  return fixture;
}

function runLocal(fixture: CandidateFixture, mode: Mode): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cliPath,
      'lint-local',
      mode,
      'committed',
      fixture.repository,
      fixture.revision,
      fixture.bindingPath,
      fixture.evidencePath,
    ],
    { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
  );
}

function runCi(
  fixture: CandidateFixture,
  bindingPath: string | null = fixture.bindingPath,
  extraArguments: string[] = [],
  kind: 'committed' | 'staged' | 'working' = 'committed',
): ReturnType<typeof Bun.spawnSync> {
  const env = { ...process.env };
  if (bindingPath === null) delete env['TOOL_WIKI_CI_TRUSTED_BINDING'];
  else env['TOOL_WIKI_CI_TRUSTED_BINDING'] = bindingPath;
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cliPath,
      'lint-ci',
      ...extraArguments,
      kind,
      fixture.repository,
      fixture.revision,
      fixture.evidencePath,
    ],
    { cwd: import.meta.dir, env, stderr: 'pipe', stdout: 'pipe' },
  );
}

function satisfyApplication(fixture: CandidateFixture): void {
  const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
    reportMode: Mode;
  };
  writeEvidence(fixture, evidence.reportMode, [
    'obligation.policy',
    'obligation.validator',
    'obligation.exemptions',
    'obligation.application',
  ]);
}

function artifactIdentity(artifacts: { path: string; sha256: string }[]): string {
  return hashCanonical(
    artifacts
      .map(({ path, sha256: digest }) => ({ path: realpathSync(path), sha256: digest }))
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
      ),
  );
}

function writeActivation(
  fixture: CandidateFixture,
  changePolicy: (policy: Record<string, unknown>) => void,
  declaredChanges: object,
  nextValidatorArtifacts?: { path: string; sha256: string }[],
): string {
  const previousBindingBytes = readFileSync(fixture.bindingPath);
  const previousBinding = JSON.parse(previousBindingBytes.toString('utf8')) as {
    bindingId: string;
    trustScope: 'ci' | 'local-operator';
    policy: { path: string; sha256: string };
    validator: { validatorId: string; artifacts: { path: string; sha256: string }[] };
  };
  const nextPolicyPath = join(fixture.trustDirectory, 'policy-next.json');
  const policy = JSON.parse(readFileSync(fixture.policyPath, 'utf8')) as Record<string, unknown>;
  changePolicy(policy);
  write(nextPolicyPath, `${JSON.stringify(policy)}\n`);
  const nextBindingPath = join(fixture.trustDirectory, 'binding-next.json');
  write(
    nextBindingPath,
    `${JSON.stringify({
      schemaVersion: 1,
      bindingId: 'binding.next.v1',
      trustScope: previousBinding.trustScope,
      policy: { path: nextPolicyPath, sha256: sha256(readFileSync(nextPolicyPath)) },
      validator: {
        validatorId: previousBinding.validator.validatorId,
        artifacts: nextValidatorArtifacts ?? previousBinding.validator.artifacts,
      },
      predecessor: {
        bindingId: previousBinding.bindingId,
        bindingIdentity: sha256(previousBindingBytes),
        policyId: 'policy.trusted.v1',
        policyIdentity: previousBinding.policy.sha256,
        validatorId: previousBinding.validator.validatorId,
        validatorIdentity: artifactIdentity(previousBinding.validator.artifacts),
      },
      activation: declaredChanges,
    })}\n`,
  );
  return nextBindingPath;
}

function runActivation(
  fixture: CandidateFixture,
  nextBindingPath: string,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cliPath,
      'validate-policy-activation',
      fixture.repository,
      fixture.bindingPath,
      nextBindingPath,
    ],
    { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
  );
}

function outputOf(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${pipeText(invocation.stdout, 'lint stdout')}${pipeText(invocation.stderr, 'lint stderr')}`;
}

function pipeText(stream: Uint8Array | undefined, subject: string): string {
  if (stream === undefined) throw new Error(`${subject} was unavailable`);
  return Buffer.from(stream).toString('utf8');
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('trusted policy production CLI', () => {
  test('all rollout modes run the same whole-tree checks while only changing debt disposition', () => {
    const reports = (['observe', 'ratchet', 'enforce'] as const).map((mode) => {
      const fixture = createFixture(mode);
      const invocation = runLocal(fixture, mode);
      return { invocation, output: outputOf(invocation) };
    });

    expect(reports[0].invocation.exitCode, reports[0].output).toBe(0);
    expect(reports[1].invocation.exitCode, reports[1].output).toBe(0);
    expect(reports[2].invocation.exitCode, reports[2].output).toBe(1);
    const parsed = reports.map(
      ({ invocation }) =>
        JSON.parse(pipeText(invocation.stdout, 'lint stdout')) as LintReportFixture,
    );
    expect(
      parsed.map((report) =>
        report.deterministicChecks.map((check: { kind: string }) => check.kind),
      ),
    ).toEqual([
      ['inventory', 'classification', 'schema', 'metadata-links', 'selector-input-coverage'],
      ['inventory', 'classification', 'schema', 'metadata-links', 'selector-input-coverage'],
      ['inventory', 'classification', 'schema', 'metadata-links', 'selector-input-coverage'],
    ]);
    expect(parsed[0]).toMatchObject({
      accepted: true,
      certified: false,
      debtObligationIds: ['obligation.application'],
    });
    expect(parsed[1]).toMatchObject({
      accepted: true,
      certified: false,
      debtObligationIds: ['obligation.application'],
    });
    expect(parsed[2]).toMatchObject({
      accepted: false,
      certified: false,
      unmetObligationIds: ['obligation.application'],
    });
  });

  test('enforce refuses observe evidence even when deterministic checks pass', () => {
    const fixture = createFixture('enforce', 'observe');
    const invocation = runLocal(fixture, 'enforce');
    const output = outputOf(invocation);

    expect(invocation.exitCode, output).toBe(1);
    const report = JSON.parse(pipeText(invocation.stdout, 'lint stdout')) as {
      accepted: boolean;
      refusals: { kind: string; reason: string }[];
    };
    expect(report.accepted).toBe(false);
    expect(report.refusals).toContainEqual({
      kind: 'mode',
      reason: 'observe evidence cannot satisfy enforce work',
    });
  });

  test('enforce names a trusted obligation omitted from candidate evidence', () => {
    const fixture = createFixture('enforce');
    const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
      obligations: { obligationId: string }[];
    };
    evidence.obligations = evidence.obligations.filter(
      ({ obligationId }) => obligationId !== 'obligation.application',
    );
    write(fixture.evidencePath, `${JSON.stringify(evidence)}\n`);

    const invocation = runLocal(fixture, 'enforce');
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(JSON.parse(pipeText(invocation.stdout, 'lint stdout'))).toMatchObject({
      unmetObligationIds: ['obligation.application'],
      refusals: [
        {
          kind: 'obligation',
          obligationId: 'obligation.application',
          reason: 'selected policy obligation is unmet',
        },
      ],
    });
  });

  test('ratchet refuses an exact-tuple regression in an adopted non-authority boundary', () => {
    const fixture = createFixture('ratchet');
    write(join(fixture.repository, 'src/app.ts'), 'export const value = 2;\n');
    fixture.revision = commit(fixture.repository, 'change adopted application tuple');

    const invocation = runLocal(fixture, 'ratchet');
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(JSON.parse(pipeText(invocation.stdout, 'lint stdout'))).toMatchObject({
      changedBoundaryIds: ['boundary.application'],
      unmetObligationIds: ['obligation.application'],
      refusals: [
        {
          kind: 'ratchet',
          boundaryId: 'boundary.application',
          obligationId: 'obligation.application',
          reason: 'changed adopted boundary has an unmet obligation',
        },
      ],
    });
  });

  test('ratchet refuses a candidate that removes an adopted boundary from its own policy', () => {
    const fixture = createFixture('ratchet');
    write(join(fixture.repository, 'policy.json'), '{"boundaries":["validator","exemptions"]}\n');
    fixture.revision = commit(fixture.repository, 'remove adopted policy boundary');

    const invocation = runLocal(fixture, 'ratchet');
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    const report = JSON.parse(pipeText(invocation.stdout, 'lint stdout')) as {
      accepted: boolean;
      changedBoundaryIds: string[];
      refusals: object[];
    };
    expect(report).toMatchObject({
      accepted: false,
      changedBoundaryIds: ['boundary.policy'],
    });
    expect(report.refusals).toContainEqual({
      kind: 'activation',
      boundaryId: 'boundary.policy',
      reason: 'trusted authority boundary changed without a separate activation',
    });
  });

  test('ratchet refuses a candidate that weakens its own validator', () => {
    const fixture = createFixture('ratchet');
    write(
      join(fixture.repository, 'validator.ts'),
      'export const accepts = true; // skip checks\n',
    );
    fixture.revision = commit(fixture.repository, 'weaken candidate validator');

    const invocation = runLocal(fixture, 'ratchet');
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    const report = JSON.parse(pipeText(invocation.stdout, 'lint stdout')) as {
      accepted: boolean;
      changedBoundaryIds: string[];
      refusals: object[];
    };
    expect(report).toMatchObject({
      accepted: false,
      changedBoundaryIds: ['boundary.validator'],
    });
    expect(report.refusals).toContainEqual({
      kind: 'activation',
      boundaryId: 'boundary.validator',
      reason: 'trusted authority boundary changed without a separate activation',
    });
  });

  test('ratchet refuses a candidate edit to its own exemptions', () => {
    const fixture = createFixture('ratchet');
    write(join(fixture.repository, 'exemptions.json'), '{"exemptions":["application"]}\n');
    fixture.revision = commit(fixture.repository, 'weaken candidate exemptions');

    const invocation = runLocal(fixture, 'ratchet');
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    const report = JSON.parse(pipeText(invocation.stdout, 'lint stdout')) as {
      accepted: boolean;
      changedBoundaryIds: string[];
      refusals: object[];
    };
    expect(report).toMatchObject({
      accepted: false,
      changedBoundaryIds: ['boundary.exemptions'],
    });
    expect(report.refusals).toContainEqual({
      kind: 'activation',
      boundaryId: 'boundary.exemptions',
      reason: 'trusted authority boundary changed without a separate activation',
    });
  });

  test('checks the whole selected tree when a new path is outside the edited authority boundary', () => {
    const fixture = createFixture('observe');
    write(join(fixture.repository, 'src/unindexed.ts'), 'export const hidden = true;\n');
    fixture.revision = commit(fixture.repository, 'add unindexed source');

    const invocation = runLocal(fixture, 'observe');
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('unindexed candidate path in README.md');
    expect(output).toContain('src/unindexed.ts');
  });

  test('CI uses only its preselected external binding and can certify complete enforce evidence', () => {
    const fixture = createFixture('enforce');
    satisfyApplication(fixture);

    const invocation = runCi(fixture);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(0);
    expect(JSON.parse(pipeText(invocation.stdout, 'lint stdout'))).toMatchObject({
      mode: 'enforce',
      trustProvenance: 'ci-preselected',
      certified: true,
      accepted: true,
    });
  });

  test('CI cannot certify changed candidate bytes with unchanged obligation evidence', () => {
    const fixture = createFixture('enforce');
    satisfyApplication(fixture);
    write(join(fixture.repository, 'src/app.ts'), 'export const value = 2;\n');
    fixture.revision = commit(fixture.repository, 'change source after evidence');

    const invocation = runCi(fixture);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    const report = JSON.parse(pipeText(invocation.stdout, 'lint stdout')) as {
      accepted: boolean;
      certified: boolean;
      unmetObligationIds: string[];
    };
    expect(report).toMatchObject({
      accepted: false,
      certified: false,
    });
    expect(report.unmetObligationIds).toContain('obligation.application');
  });

  test('caller labels cannot replace check receipts or trusted review provenance', () => {
    for (const fault of ['missing-check-receipt', 'local-review'] as const) {
      const fixture = createFixture('enforce');
      satisfyApplication(fixture);
      const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
        checkReceipts: { observationId: string }[];
        reviewReceipts: {
          observationId: string;
          receipt: { trust: { scope: string } };
        }[];
      };
      if (fault === 'missing-check-receipt') {
        evidence.checkReceipts = evidence.checkReceipts.filter(
          ({ observationId }) => observationId !== 'observation.check.application',
        );
      } else {
        const review = evidence.reviewReceipts.find(
          ({ observationId }) => observationId === 'observation.review.application',
        );
        if (review === undefined) throw new Error('application review receipt disappeared');
        review.receipt.trust.scope = 'local-cooperative';
      }
      write(fixture.evidencePath, `${JSON.stringify(evidence)}\n`);

      const invocation = runCi(fixture);
      const output = outputOf(invocation);
      expect(invocation.exitCode, `${fault}: ${output}`).toBe(1);
      const report = JSON.parse(pipeText(invocation.stdout, 'lint stdout')) as {
        accepted: boolean;
        unmetObligationIds: string[];
      };
      expect(report.accepted).toBe(false);
      expect(report.unmetObligationIds).toContain('obligation.application');
    }
  });

  test('a candidate child whose name starts with two dots is still inside the candidate', () => {
    const fixture = createFixture('enforce');
    satisfyApplication(fixture);
    const candidateBinding = join(fixture.repository, '..trust', 'binding.json');
    write(candidateBinding, readFileSync(fixture.bindingPath, 'utf8'));

    const invocation = runCi(fixture, candidateBinding);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('trusted binding resolves inside selected candidate');
  });

  test('binding cannot omit a transitive production module that decides acceptance', () => {
    const fixture = createFixture('enforce');
    satisfyApplication(fixture);
    const binding = JSON.parse(readFileSync(fixture.bindingPath, 'utf8')) as {
      validator: { artifacts: { path: string; sha256: string }[] };
    };
    binding.validator.artifacts = binding.validator.artifacts.filter(
      ({ path }) => !path.endsWith('/indexes/check-indexes.ts'),
    );
    write(fixture.bindingPath, `${JSON.stringify(binding)}\n`);

    const invocation = runCi(fixture);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain(
      'trusted validator artifacts do not match the executable implementation',
    );
  });

  test('CI reports but cannot certify a mutable working selection or its untracked paths', () => {
    const fixture = createFixture('enforce');
    satisfyApplication(fixture);
    write(join(fixture.repository, 'untracked.ts'), 'export const untracked = true;\n');
    const selected = Bun.spawnSync(
      [
        process.execPath,
        'run',
        cliPath,
        'read-candidate',
        'working',
        fixture.repository,
        fixture.revision,
      ],
      { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
    );
    expect(selected.exitCode, outputOf(selected)).toBe(0);
    const snapshot = JSON.parse(pipeText(selected.stdout, 'candidate stdout')) as {
      selection: object;
      entries: ExactTupleFixture[];
      untracked: string[];
    };
    const identity = hashCanonical(snapshot);
    const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
      obligationRequest: {
        current: { candidateIdentity: string; inputs: { content: object[] } };
        checks: { candidateIdentity: string }[];
        reviews: { candidateIdentity: string }[];
      };
      checkReceipts: { receipt: { candidateManifest: string } }[];
    };
    evidence.obligationRequest.current.candidateIdentity = identity;
    evidence.obligationRequest.current.inputs.content = contentInputs(snapshot.entries);
    for (const observation of evidence.obligationRequest.checks) {
      observation.candidateIdentity = identity;
    }
    for (const observation of evidence.obligationRequest.reviews) {
      observation.candidateIdentity = identity;
    }
    for (const { receipt } of evidence.checkReceipts) receipt.candidateManifest = identity;
    write(fixture.evidencePath, `${JSON.stringify(evidence)}\n`);

    const invocation = runCi(fixture, fixture.bindingPath, [], 'working');
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    const stdout = pipeText(invocation.stdout, 'lint stdout');
    expect(stdout.length, output).toBeGreaterThan(0);
    const report = JSON.parse(stdout) as LintReportFixture & { refusals: object[] };
    expect(report).toMatchObject({
      accepted: false,
      certified: false,
      candidateSelection: { kind: 'working' },
      untrackedPaths: ['untracked.ts'],
    });
    expect(report.refusals).toContainEqual({
      kind: 'selection',
      reason: 'mutable working selection cannot receive CI certification',
    });
  });

  test('lint validates that every trusted selector actually selects candidate inputs', () => {
    const fixture = createFixture('enforce');
    satisfyApplication(fixture);
    const policy = JSON.parse(readFileSync(fixture.policyPath, 'utf8')) as {
      boundaries: {
        boundaryId: string;
        selector: { kind: 'path'; value: string };
        baselineEntries: object[];
      }[];
    };
    const application = policy.boundaries.find(
      ({ boundaryId }) => boundaryId === 'boundary.application',
    );
    if (application === undefined) throw new Error('application boundary disappeared');
    application.selector = { kind: 'path', value: 'selector.does-not-exist' };
    application.baselineEntries = [];
    write(fixture.policyPath, `${JSON.stringify(policy)}\n`);
    const binding = JSON.parse(readFileSync(fixture.bindingPath, 'utf8')) as {
      policy: { path: string; sha256: string };
    };
    binding.policy.sha256 = sha256(readFileSync(fixture.policyPath));
    write(fixture.bindingPath, `${JSON.stringify(binding)}\n`);

    const invocation = runCi(fixture);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain(
      'trusted boundary selector selects no candidate input: boundary.application',
    );
    expect(output).not.toContain('trusted policy digest does not match binding');
  });

  test('trusted obligations must retain one exact boundary assignment', () => {
    const fixture = createFixture('enforce');
    satisfyApplication(fixture);
    const policy = JSON.parse(readFileSync(fixture.policyPath, 'utf8')) as {
      obligations: { obligationId: string; boundaryId: string }[];
    };
    const application = policy.obligations.find(
      ({ obligationId }) => obligationId === 'obligation.application',
    );
    if (application === undefined) throw new Error('application obligation disappeared');
    application.boundaryId = 'boundary.policy';
    write(fixture.policyPath, `${JSON.stringify(policy)}\n`);
    const binding = JSON.parse(readFileSync(fixture.bindingPath, 'utf8')) as {
      policy: { sha256: string };
    };
    binding.policy.sha256 = sha256(readFileSync(fixture.policyPath));
    write(fixture.bindingPath, `${JSON.stringify(binding)}\n`);

    const invocation = runCi(fixture);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain(
      'trusted obligation boundary assignment mismatch: obligation.application',
    );
  });

  test('CI rejects an ordinary mode argument and a candidate field that tries to select trust', () => {
    const fixture = createFixture('enforce');
    satisfyApplication(fixture);
    const withMode = runCi(fixture, fixture.bindingPath, ['observe']);
    expect(withMode.exitCode, outputOf(withMode)).toBe(1);
    expect(outputOf(withMode)).toContain('usage: tool-wiki');

    const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as object;
    write(
      fixture.evidencePath,
      `${JSON.stringify({ ...evidence, trustedBindingPath: fixture.bindingPath })}\n`,
    );
    const withBindingField = runCi(fixture);
    expect(withBindingField.exitCode, outputOf(withBindingField)).toBe(1);
    expect(outputOf(withBindingField)).toContain('trustedBindingPath must be removed');
  });

  test('CI fails closed when its caller did not preselect a trusted binding', () => {
    const fixture = createFixture('enforce');
    const invocation = runCi(fixture, null);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('CI trusted binding was not preselected by the caller');
  });

  test('binding, policy and validator aliases cannot resolve inside the selected candidate', () => {
    const cases = ['binding', 'policy', 'validator'] as const;
    for (const subject of cases) {
      const fixture = createFixture('enforce');
      satisfyApplication(fixture);
      let bindingPath = fixture.bindingPath;
      if (subject === 'binding') {
        bindingPath = join(fixture.repository, 'candidate-binding.json');
        write(bindingPath, readFileSync(fixture.bindingPath, 'utf8'));
      } else {
        const binding = JSON.parse(readFileSync(fixture.bindingPath, 'utf8')) as {
          policy: { path: string; sha256: string };
          validator: { artifacts: { path: string; sha256: string }[] };
        };
        if (subject === 'policy') {
          const alias = join(fixture.trustDirectory, 'candidate-policy-alias.json');
          symlinkSync(join(fixture.repository, 'policy.json'), alias);
          binding.policy = { path: alias, sha256: sha256(readFileSync(alias)) };
        } else {
          binding.validator.artifacts = [
            {
              path: join(fixture.repository, 'validator.ts'),
              sha256: sha256(readFileSync(join(fixture.repository, 'validator.ts'))),
            },
          ];
        }
        write(fixture.bindingPath, `${JSON.stringify(binding)}\n`);
      }

      const invocation = runCi(fixture, bindingPath);
      const output = outputOf(invocation);
      expect(invocation.exitCode, output).toBe(1);
      expect(output).toContain('resolves inside selected candidate');
    }
  });

  test('binding cannot omit executable source that actually decides acceptance', () => {
    const fixture = createFixture('enforce');
    const binding = JSON.parse(readFileSync(fixture.bindingPath, 'utf8')) as {
      validator: { artifacts: { path: string; sha256: string }[] };
    };
    binding.validator.artifacts = binding.validator.artifacts.filter(
      ({ path }) => realpathSync(path) !== realpathSync(trustPath),
    );
    write(fixture.bindingPath, `${JSON.stringify(binding)}\n`);

    const invocation = runLocal(fixture, 'enforce');
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain(
      'trusted validator artifacts do not match the executable implementation',
    );
  });

  test('compatible activation retains both identities and deterministically reselects affected checks', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(
      fixture,
      (policy) => {
        const boundaries = policy['boundaries'] as object[];
        const obligations = policy['obligations'] as object[];
        boundaries.push({
          boundaryId: 'boundary.docs',
          selector: { kind: 'path', value: 'README.md' },
          baselineEntries: [exactTuple(fixture.repository, fixture.revision, 'README.md')],
          obligationIds: ['obligation.docs'],
        });
        obligations.push({
          obligationId: 'obligation.docs',
          boundaryId: 'boundary.docs',
          checkIds: ['check.docs'],
          reviewIds: ['review.docs'],
        });
      },
      {
        addedBoundaryIds: ['boundary.docs'],
        changedBoundaryIds: [],
        addedObligationIds: ['obligation.docs'],
        removedExemptionIds: [],
        validatorChanged: false,
      },
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(0);
    expect(JSON.parse(pipeText(invocation.stdout, 'activation stdout'))).toMatchObject({
      compatible: true,
      previous: { bindingId: 'binding.enforce.v1', policyId: 'policy.trusted.v1' },
      next: { bindingId: 'binding.next.v1', policyId: 'policy.trusted.v1' },
      reselectedCheckIds: [
        'check.application',
        'check.docs',
        'check.exemptions',
        'check.policy',
        'check.validator',
      ],
      reselectedReviewIds: [
        'review.application',
        'review.docs',
        'review.exemptions',
        'review.policy',
        'review.validator',
      ],
    });
  });

  test('compatible activation rejects a predecessor identity selected from somewhere else', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(fixture, () => undefined, {
      addedBoundaryIds: [],
      changedBoundaryIds: [],
      addedObligationIds: [],
      removedExemptionIds: [],
      validatorChanged: false,
    });
    const binding = JSON.parse(readFileSync(nextBindingPath, 'utf8')) as {
      predecessor: { bindingIdentity: string };
    };
    binding.predecessor.bindingIdentity = '0'.repeat(64);
    write(nextBindingPath, `${JSON.stringify(binding)}\n`);

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('activation predecessor does not match the previous trusted binding');
  });

  test('compatible activation rejects a boundary addition omitted from its declaration', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(
      fixture,
      (policy) => {
        const boundaries = policy['boundaries'] as object[];
        boundaries.push({
          boundaryId: 'boundary.docs',
          selector: { kind: 'path', value: 'README.md' },
          baselineEntries: [exactTuple(fixture.repository, fixture.revision, 'README.md')],
          obligationIds: [],
        });
      },
      {
        addedBoundaryIds: [],
        changedBoundaryIds: [],
        addedObligationIds: [],
        removedExemptionIds: [],
        validatorChanged: false,
      },
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain(
      'added boundary declaration mismatch: expected boundary.docs, received (none)',
    );
  });

  test('compatible activation requires an explicit boundary declaration for obligation coverage changes', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(
      fixture,
      (policy) => {
        const obligations = policy['obligations'] as {
          obligationId: string;
          checkIds: string[];
        }[];
        const application = obligations.find(
          ({ obligationId }) => obligationId === 'obligation.application',
        );
        if (application === undefined) throw new Error('application obligation disappeared');
        application.checkIds.push('check.application.new');
      },
      {
        addedBoundaryIds: [],
        changedBoundaryIds: [],
        addedObligationIds: [],
        removedExemptionIds: [],
        validatorChanged: false,
      },
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain(
      'changed boundary declaration mismatch: expected boundary.application, received (none)',
    );
  });

  test('compatible activation can retain a historical validator and select all checks for its replacement', () => {
    const fixture = createFixture('enforce');
    const historicalValidatorPath = join(fixture.trustDirectory, 'validator-historical.ts');
    write(historicalValidatorPath, 'export const accepts = false;\n');
    const previousBinding = JSON.parse(readFileSync(fixture.bindingPath, 'utf8')) as {
      validator: { validatorId: string; artifacts: { path: string; sha256: string }[] };
    };
    previousBinding.validator.artifacts = [
      { path: historicalValidatorPath, sha256: sha256(readFileSync(historicalValidatorPath)) },
    ];
    write(fixture.bindingPath, `${JSON.stringify(previousBinding)}\n`);
    const nextArtifacts = resolveValidatorArtifactPaths([cliPath, trustPath]).map((path) => ({
      path,
      sha256: sha256(readFileSync(path)),
    }));
    const nextBindingPath = writeActivation(
      fixture,
      () => undefined,
      {
        addedBoundaryIds: [],
        changedBoundaryIds: [],
        addedObligationIds: [],
        removedExemptionIds: [],
        validatorChanged: true,
      },
      nextArtifacts,
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(0);
    const report = JSON.parse(pipeText(invocation.stdout, 'activation stdout')) as {
      previous: { validatorIdentity: string };
      next: { validatorIdentity: string };
      reselectedCheckIds: string[];
    };
    expect(report.previous.validatorIdentity).not.toBe(report.next.validatorIdentity);
    expect(report.reselectedCheckIds).toEqual([
      'check.application',
      'check.exemptions',
      'check.policy',
      'check.validator',
    ]);
  });

  test('compatible activation rejects an undeclared coverage shrink', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(
      fixture,
      (policy) => {
        policy['boundaries'] = (policy['boundaries'] as { boundaryId: string }[]).filter(
          ({ boundaryId }) => boundaryId !== 'boundary.application',
        );
        policy['obligations'] = (policy['obligations'] as { boundaryId: string }[]).filter(
          ({ boundaryId }) => boundaryId !== 'boundary.application',
        );
        policy['adoptedBoundaryIds'] = (policy['adoptedBoundaryIds'] as string[]).filter(
          (boundaryId) => boundaryId !== 'boundary.application',
        );
      },
      {
        addedBoundaryIds: [],
        changedBoundaryIds: [],
        addedObligationIds: [],
        removedExemptionIds: [],
        validatorChanged: false,
      },
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('compatible activation cannot remove boundary: boundary.application');
  });

  test('compatible activation cannot narrow an existing selector', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(
      fixture,
      (policy) => {
        const boundaries = policy['boundaries'] as {
          boundaryId: string;
          selector: { kind: string; value: string };
        }[];
        const application = boundaries.find(
          ({ boundaryId }) => boundaryId === 'boundary.application',
        );
        if (application === undefined) throw new Error('application boundary disappeared');
        application.selector = { kind: 'path', value: 'src/app.ts' };
      },
      {
        addedBoundaryIds: [],
        changedBoundaryIds: ['boundary.application'],
        addedObligationIds: [],
        removedExemptionIds: [],
        validatorChanged: false,
      },
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain(
      'compatible activation cannot narrow selector coverage: boundary.application',
    );
  });

  test('compatible activation cannot delete existing check or review requirements', () => {
    for (const requirement of ['checkIds', 'reviewIds'] as const) {
      const fixture = createFixture('enforce');
      const nextBindingPath = writeActivation(
        fixture,
        (policy) => {
          const obligations = policy['obligations'] as {
            obligationId: string;
            checkIds: string[];
            reviewIds: string[];
          }[];
          const application = obligations.find(
            ({ obligationId }) => obligationId === 'obligation.application',
          );
          if (application === undefined) throw new Error('application obligation disappeared');
          application[requirement] = [];
        },
        {
          addedBoundaryIds: [],
          changedBoundaryIds: ['boundary.application'],
          addedObligationIds: [],
          removedExemptionIds: [],
          validatorChanged: false,
        },
      );

      const invocation = runActivation(fixture, nextBindingPath);
      const output = outputOf(invocation);
      expect(invocation.exitCode, `${requirement}: ${output}`).toBe(1);
      expect(output).toContain(
        `compatible activation cannot remove ${requirement === 'checkIds' ? 'check' : 'review'} requirement from obligation.application`,
      );
    }
  });

  test('compatible activation cannot move an existing obligation to another boundary', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(
      fixture,
      (policy) => {
        const boundaries = policy['boundaries'] as {
          boundaryId: string;
          obligationIds: string[];
        }[];
        const obligations = policy['obligations'] as {
          obligationId: string;
          boundaryId: string;
        }[];
        const application = obligations.find(
          ({ obligationId }) => obligationId === 'obligation.application',
        );
        if (application === undefined) throw new Error('application obligation disappeared');
        application.boundaryId = 'boundary.policy';
        const applicationBoundary = boundaries.find(
          ({ boundaryId }) => boundaryId === 'boundary.application',
        );
        const policyBoundary = boundaries.find(
          ({ boundaryId }) => boundaryId === 'boundary.policy',
        );
        if (applicationBoundary === undefined || policyBoundary === undefined) {
          throw new Error('fixture boundary disappeared');
        }
        applicationBoundary.obligationIds = [];
        policyBoundary.obligationIds.push('obligation.application');
      },
      {
        addedBoundaryIds: [],
        changedBoundaryIds: ['boundary.application', 'boundary.policy'],
        addedObligationIds: [],
        removedExemptionIds: [],
        validatorChanged: false,
      },
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain(
      'compatible activation cannot move obligation obligation.application from boundary.application',
    );
  });

  test('compatible activation rejects a minimum-mode weakening', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(
      fixture,
      (policy) => {
        policy['minimumMode'] = 'observe';
      },
      {
        addedBoundaryIds: [],
        changedBoundaryIds: [],
        addedObligationIds: [],
        removedExemptionIds: [],
        validatorChanged: false,
      },
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('compatible activation cannot weaken minimum mode');
  });

  test('compatible activation rejects a new exemption that weakens enforcement', () => {
    const fixture = createFixture('enforce');
    const nextBindingPath = writeActivation(
      fixture,
      (policy) => {
        policy['exemptions'] = [
          {
            exemptionId: 'exemption.application',
            obligationId: 'obligation.application',
            reason: 'candidate wants to skip application review',
            reviewIdentity: 'a'.repeat(64),
          },
        ];
      },
      {
        addedBoundaryIds: [],
        changedBoundaryIds: [],
        addedObligationIds: [],
        removedExemptionIds: [],
        validatorChanged: false,
      },
    );

    const invocation = runActivation(fixture, nextBindingPath);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('compatible activation cannot add or weaken exemption');
  });
});
