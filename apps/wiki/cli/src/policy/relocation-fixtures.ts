import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import { readCandidate } from '../inventory/read-candidate';
import { prepareActivation, selectActivation } from './activation';
import type { RelocationSources } from './relocation-activation';

/**
 * The relocation fixture: one repository whose enforced boundary owns a real, rebuildable
 * validator, moved from `src/old` to `src/new` by one commit. Everything a relocation activation
 * reads — policy, mapping, declarations, launcher, snapshotter and the validator entry — is a
 * committed candidate file, so the tests exercise the production path rather than a stub.
 */
export interface RelocationFixture {
  readonly repository: string;
  readonly workspace: string;
  /** The commit whose tree the policy pins as reviewed (`pilot.sourceRevision`). */
  readonly reviewedRevision: string;
  /** The base activation's commit: the boundary still at `src/old`. */
  readonly baseRevision: string;
  /** The candidate: the same boundary at `src/new` with `sourceSelector` naming `src/old`. */
  readonly candidateRevision: string;
}

export interface ExactTuple {
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
  blob: string;
}

const workspaceRoot = resolve(import.meta.dir, '..', '..', '..', '..', '..');
const scratchPaths: string[] = [];

export function disposeRelocationFixtures(): void {
  for (const path of scratchPaths.splice(0)) rmSync(path, { force: true, recursive: true });
}

function gitBytes(repository: string, argv: string[]): Uint8Array {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    throw new Error(`fixture git ${argv.join(' ')} failed: ${invocation.stderr.toString('utf8')}`);
  }
  return invocation.stdout;
}

function git(repository: string, argv: string[]): string {
  return new TextDecoder().decode(gitBytes(repository, argv)).trim();
}

/** The exact committed bytes of one candidate file, as the command itself reads them. */
export function showFile(repository: string, revision: string, path: string): Uint8Array {
  return gitBytes(repository, ['show', `${revision}:${path}`]);
}

export function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}

export function entriesAt(repository: string, revision: string): ExactTuple[] {
  return git(repository, ['ls-tree', '-r', revision])
    .split('\n')
    .map((record) => {
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

export function candidateIdentityAt(repository: string, revision: string): string {
  return hashCanonical({
    selection: {
      kind: 'committed',
      revision,
      tree: git(repository, ['rev-parse', `${revision}^{tree}`]),
    },
    entries: entriesAt(repository, revision),
    untracked: [],
  });
}

function contentInputs(entries: readonly ExactTuple[]): object[] {
  return entries.map((entry, index) => ({
    kind: 'content',
    inputId: `content.${String(index)}`,
    ...entry,
  }));
}

function classificationPolicy(): object {
  const rule = (contentClass: string, include: object[]) => ({
    contentClass,
    include,
    exclude: [],
  });
  return {
    schemaVersion: 1,
    policyId: 'classification.relocation-fixture.v1',
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
      rule('source', [{ kind: 'suffix', value: '.ts' }]),
      rule('test', [{ kind: 'suffix', value: '.spec.ts' }]),
      rule('config', [
        { kind: 'suffix', value: '.json' },
        { kind: 'name', value: '.bun-version' },
        { kind: 'name', value: '.gitignore' },
      ]),
      rule('script', [{ kind: 'suffix', value: '.sh' }]),
      rule('migration', [{ kind: 'segment', value: 'migrations' }]),
      rule('fixture', [{ kind: 'segment', value: 'fixtures' }]),
      rule('generated', [{ kind: 'segment', value: 'generated' }]),
      rule('vendored', [{ kind: 'segment', value: 'vendor' }]),
      rule('placeholder', [{ kind: 'name', value: '.keep' }]),
      rule('document', [{ kind: 'suffix', value: '.md' }]),
      rule('openspec', [{ kind: 'prefix', value: 'openspec' }]),
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

function indexSource(moduleId: string, memberships: object[]): string {
  const metadata = {
    schemaVersion: 1,
    moduleId,
    memberships,
    relationshipSelectors: [],
    applicableChecks: [],
    inapplicableSections: [
      { section: 'relationships', reason: 'The relocation fixture declares no relationships.' },
      { section: 'invariants', reason: 'The relocation fixture has no cross-file invariant.' },
      { section: 'checks', reason: 'The fixture Nx target is the boundary check.' },
    ],
    externalConsumers: {
      kind: 'none-known',
      knowledgeLimit: 'Only the fixture repository was considered.',
    },
  };
  return `# Relocation fixture\n\n<!-- module-index ${JSON.stringify(metadata)} -->\n`;
}

export function fixturePolicy(
  fixture: { repository: string; reviewedRevision: string },
  prefix: 'src/old' | 'src/new',
  sourcePrefix?: 'src/old',
  minimumMode: 'observe' | 'enforce' = 'enforce',
): object {
  const baselineEntries = entriesAt(fixture.repository, fixture.reviewedRevision).filter(
    ({ path }) => path.startsWith('src/old/'),
  );
  return {
    schemaVersion: 1,
    policyId: 'policy.relocation-fixture.v1',
    minimumMode,
    classificationPolicy: classificationPolicy(),
    adoptedBoundaryIds: ['boundary.fixture.module'],
    activationBoundaryIds: [],
    boundaries: [
      {
        boundaryId: 'boundary.fixture.module',
        selector: { kind: 'prefix', value: prefix },
        ...(sourcePrefix === undefined
          ? {}
          : { sourceSelector: { kind: 'prefix', value: sourcePrefix } }),
        baselineEntries,
        obligationIds: ['obligation.fixture.module'],
      },
    ],
    obligations: [
      {
        obligationId: 'obligation.fixture.module',
        boundaryId: 'boundary.fixture.module',
        checkIds: ['check.fixture.module'],
        reviewIds: ['review.fixture.module'],
      },
    ],
    exemptions: [],
    pilot: {
      sourceRevision: fixture.reviewedRevision,
      coverage: 'selected-boundaries-only',
      exclusions: [],
    },
    relationshipRequest: {
      schemaVersion: 1,
      declarationPaths: ['docs/wiki-policy/relationships.json'],
      typescript: {
        configPaths: ['nx.json'],
        publicEntrypoints: [`${prefix}/cli.ts`],
      },
    },
  };
}

export function fixtureMapping(
  reviewedRevision: string,
  prefix: 'src/old' | 'src/new',
  mappingVersion: string,
): object {
  return {
    schemaVersion: 1,
    mappingId: 'mapping.relocation-fixture',
    mappingVersion,
    sourceRevision: reviewedRevision,
    modules: [
      {
        moduleId: 'module.fixture.module',
        name: 'Relocation fixture boundary',
        memberships: [{ kind: 'directory-prefix', prefix, exclusions: [] }],
        predecessorModuleIds: [],
        indexPath: `${prefix}/README.md`,
        externalConsumers: { kind: 'none' },
      },
    ],
  };
}

/** The fixture's three Nx targets, as their `project.json` declares them. */
const fixtureTargets = {
  check: { command: "printf 'relocation fixture check\\n'" },
  fail: { command: 'exit 3' },
  skip: { command: 'bun test {projectRoot}/skip.test.ts' },
} as const;

type FixtureTarget = keyof typeof fixtureTargets;

function declarations(target: FixtureTarget): object {
  return {
    schemaVersion: 1,
    declarationId: 'declaration.relocation-fixture',
    selectorVersion: 1,
    coverage: 'selected-facts-only',
    facts: [
      {
        factId: 'check.fixture.module',
        family: 'targets',
        at: { kind: 'current' },
        kind: 'nx-target',
        project: 'fixture',
        target,
        expectedConfiguration: {
          executor: 'nx:run-commands',
          options: { command: fixtureTargets[target].command },
        },
      },
    ],
    edges: [],
  };
}

function buildValidatorInto(entry: string, output: string): void {
  const built = Bun.spawnSync(
    ['bun', 'build', entry, '--target=bun', '--format=esm', `--outfile=${output}`],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  if (built.exitCode !== 0) {
    throw new Error(`fixture validator build failed: ${built.stderr.toString('utf8')}`);
  }
}

/**
 * Builds the two-commit relocation repository and returns its revisions. `failingCheck` points
 * the candidate's declared boundary check at an Nx target that exits non-zero, which is the only
 * honest way to observe the refusal on the production path.
 */
export function createRelocationCandidate(
  options: {
    /** Point the declared boundary check at a target that exits non-zero. */
    failingCheck?: boolean;
    /** Point it at a `bun test` target that reports one skipped test and still exits 0. */
    skippingCheck?: boolean;
    minimumMode?: 'observe' | 'enforce';
  } = {},
): RelocationFixture {
  const parent = mkdtempSync(join(tmpdir(), 'tool-wiki-relocation-'));
  scratchPaths.push(parent);
  const repository = join(parent, 'candidate');
  mkdirSync(repository, { recursive: true });
  git(repository, ['init', '--initial-branch=main']);
  git(repository, ['config', 'user.email', 'relocation@example.test']);
  git(repository, ['config', 'user.name', 'Relocation Fixture']);
  symlinkSync(join(workspaceRoot, 'node_modules'), join(repository, 'node_modules'), 'dir');
  write(join(repository, '.gitignore'), 'node_modules\n.nx\n');
  write(
    join(repository, '.bun-version'),
    readFileSync(join(workspaceRoot, '.bun-version'), 'utf8'),
  );
  write(
    join(repository, 'package.json'),
    `${JSON.stringify({
      name: 'relocation-fixture',
      private: true,
      devDependencies: { nx: '23.2.0', typescript: 'npm:@typescript/typescript6@6.0.2' },
    })}\n`,
  );
  write(join(repository, 'nx.json'), `${JSON.stringify({ targetDefaults: {} })}\n`);
  cpSync(
    join(workspaceRoot, 'bin', 'tool-wiki-lint.sh'),
    join(repository, 'bin/tool-wiki-lint.sh'),
  );
  cpSync(
    join(workspaceRoot, 'apps/wiki/cli/src/policy/snapshot-validator.ts'),
    join(repository, 'src/old/policy/snapshot-validator.ts'),
  );
  buildValidatorInto(
    join(workspaceRoot, 'apps/wiki/cli/src/cli.ts'),
    join(repository, 'src/old/cli.ts'),
  );
  write(
    join(repository, 'src/old/project.json'),
    `${JSON.stringify({
      name: 'fixture',
      targets: Object.fromEntries(
        Object.entries(fixtureTargets).map(([target, { command }]) => [
          target,
          { executor: 'nx:run-commands', options: { command } },
        ]),
      ),
    })}\n`,
  );
  write(
    join(repository, 'src/old/skip.test.ts'),
    "import { expect, test } from 'bun:test';\n\n" +
      "test('runs', () => {\n  expect(1).toBe(1);\n});\n\n" +
      "test.skip('is skipped', () => {\n  expect(1).toBe(2);\n});\n",
  );
  write(
    join(repository, 'src/old/README.md'),
    indexSource('module.fixture.module', [
      { kind: 'path', path: 'cli.ts' },
      { kind: 'path', path: 'project.json' },
      { kind: 'path', path: 'skip.test.ts' },
      { kind: 'path', path: 'policy/snapshot-validator.ts' },
    ]),
  );
  write(
    join(repository, 'docs/wiki-policy/relationships.json'),
    serializeCanonical(declarations('check')),
  );
  write(join(repository, 'docs/wiki-policy/policy.json'), '{}\n');
  write(join(repository, 'docs/wiki-policy/modules.json'), '{}\n');
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '--message', 'reviewed source revision']);
  const reviewedRevision = git(repository, ['rev-parse', 'HEAD']);
  const partial = { repository, reviewedRevision };
  write(
    join(repository, 'docs/wiki-policy/policy.json'),
    serializeCanonical(fixturePolicy(partial, 'src/old', undefined, options.minimumMode)),
  );
  write(
    join(repository, 'docs/wiki-policy/modules.json'),
    serializeCanonical(fixtureMapping(reviewedRevision, 'src/old', 'relocation-fixture-v1')),
  );
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '--message', 'base activation policy']);
  const baseRevision = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['mv', 'src/old', 'src/new']);
  const candidateTarget: FixtureTarget =
    options.failingCheck === true ? 'fail' : options.skippingCheck === true ? 'skip' : 'check';
  if (candidateTarget !== 'check') {
    write(
      join(repository, 'docs/wiki-policy/relationships.json'),
      serializeCanonical(declarations(candidateTarget)),
    );
  }
  write(
    join(repository, 'docs/wiki-policy/policy.json'),
    serializeCanonical(fixturePolicy(partial, 'src/new', 'src/old', options.minimumMode)),
  );
  write(
    join(repository, 'docs/wiki-policy/modules.json'),
    serializeCanonical(fixtureMapping(reviewedRevision, 'src/new', 'relocation-fixture-v2')),
  );
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '--message', 'relocate the fixture boundary']);
  return {
    repository,
    workspace: parent,
    reviewedRevision,
    baseRevision,
    candidateRevision: git(repository, ['rev-parse', 'HEAD']),
  };
}

function checkReceipt(checkId: string, identity: string): object {
  return {
    schemaVersion: 1,
    receiptKind: 'check',
    receiptId: `receipt.${checkId}.base`,
    command: ['bunx', 'nx', 'run', 'fixture:check', '--skip-nx-cache'],
    cwdIdentity: 'fixture.repository',
    startedAt: '2026-09-16T10:00:00.000Z',
    endedAt: '2026-09-16T10:00:01.000Z',
    elapsedMs: 1000,
    status: 'passed',
    exitCode: 0,
    candidateManifest: identity,
    toolIdentity: 'a'.repeat(64),
    resourceLane: 'fixture.lane',
    stdoutArtifact: 'b'.repeat(64),
    stderrArtifact: 'c'.repeat(64),
    skips: [],
  };
}

/**
 * The operator attestation this command never produces: an `AuditReview` recorded against one
 * exact revision and candidate identity.
 */
export function auditReview(
  obligationId: string,
  sourceBase: string,
  identity: string,
  instanceId = 'relocation',
): object {
  const invocationId = `invocation.${instanceId}`;
  const protocolBlob = 'd'.repeat(64);
  const executor = {
    provider: 'fixture-provider',
    model: 'fixture-model',
    version: 'fixture-version',
    effort: 'fixture-effort',
    toolchain: 'fixture-toolchain',
  };
  const priceIdentity = {
    priceId: 'price.fixture',
    provider: 'fixture-provider',
    model: 'fixture-model',
    currency: 'USD',
    source: 'fixture-price-list',
  };
  const startedAt = '2026-09-16T10:00:00.000Z';
  const endedAt = '2026-09-16T10:00:01.000Z';
  const cold = {
    sequence: 1,
    judgments: { purpose: 'yes', relationships: 'yes', impact: 'partial' },
    observedReadIds: [identity],
  };
  const phase = (name: 'cold' | 'informed', response: string, charge: number) => ({
    status: 'verified',
    receipt: {
      schemaVersion: 1,
      receiptKind: 'invocation',
      receiptId: `receipt.${instanceId}.${name}`,
      invocationId,
      startedAt,
      endedAt,
      status: 'completed',
      executor,
      rawUsage: [{ category: `${name}_tokens`, quantity: charge, unit: 'tokens' }],
      priceIdentity,
      chargedAmountMicros: charge,
      inputArtifact: 'e'.repeat(64),
      outputArtifact: hashBytes(response),
    },
    elapsedReceipts: [
      {
        schemaVersion: 1,
        receiptKind: 'elapsed',
        receiptId: `elapsed.${instanceId}.${name}`,
        trialId: 'trial.fixture',
        outcomeId: 'outcome.fixture',
        attemptId: `attempt.${instanceId}.${name}`,
        phase: 'review',
        startedAt,
        endedAt,
        elapsedMs: 1000,
        status: 'completed',
      },
    ],
  });
  const informedResponse = `informed ${instanceId}\n`;
  const coldReceipt = phase('cold', `cold ${instanceId}\n`, 11);
  const informedReceipt = phase('informed', informedResponse, 14);
  return {
    reviewId: `audit.${instanceId}`,
    obligationId,
    sourceBase,
    candidateIdentity: identity,
    generation: 1,
    reviewRound: 1,
    recordedAt: '2026-09-16T10:01:00.000Z',
    evidence: {
      schemaVersion: 1,
      receipt: {
        schemaVersion: 1,
        receiptKind: 'review',
        receiptId: `receipt.${instanceId}`,
        invocationId,
        executor,
        suppliedContextIds: [protocolBlob, identity],
        observedReadIds: [identity, identity],
        rawResponseArtifact: hashBytes(informedResponse),
        rawUsage: [coldReceipt.receipt.rawUsage[0], informedReceipt.receipt.rawUsage[0]],
        priceIdentity,
        trust: { scope: 'external-verifier', journalId: 'journal.relocation-fixture' },
      },
      protocolEvidence: {
        schemaVersion: 1,
        protocol: { protocolId: 'review.cold-informed.v1', protocolBlob },
        subject: {
          subjectId: `subject.${obligationId}`,
          kind: 'project',
          locator: { kind: 'repository-root' },
          contentIdentity: identity,
        },
        cold,
        expansion: {
          sequence: 2,
          coldJudgmentArtifact: hashCanonical(cold),
          suppliedContextIds: [],
        },
        informed: {
          sequence: 3,
          judgments: { purpose: 'yes', relationships: 'yes', impact: 'yes' },
          observedReadIds: [identity],
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
      rawResponse: { artifact: hashBytes(informedResponse), retention: { kind: 'journal-inline' } },
    },
    findings: [],
  };
}

function baseAuthority(fixture: RelocationFixture): object {
  const identity = candidateIdentityAt(fixture.repository, fixture.baseRevision);
  const entries = entriesAt(fixture.repository, fixture.baseRevision);
  const content = contentInputs(entries);
  return {
    schemaVersion: 1,
    authorityId: 'authority.relocation-fixture.base',
    obligationRequest: {
      reviewed: {
        sourceBase: fixture.baseRevision,
        candidateIdentity: identity,
        inputs: { content, structural: [], semantic: [], topology: [] },
      },
      current: {
        sourceBase: fixture.baseRevision,
        candidateIdentity: identity,
        inputs: { content, structural: [], semantic: [], topology: [] },
      },
      judgments: [],
      policy: { policyId: 'policy.relocation-fixture.v1', behaviorRules: [] },
      impactClassifications: [],
      writerLabels: [],
      checks: [
        {
          observationId: 'observation.check.fixture.module',
          checkId: 'check.fixture.module',
          candidateIdentity: identity,
          status: 'passed',
        },
      ],
      reviews: [],
    },
    checkReceipts: [
      {
        observationId: 'observation.check.fixture.module',
        receipt: checkReceipt('check.fixture.module', identity),
      },
    ],
    audit: {
      schemaVersion: 1,
      auditId: 'audit.relocation-fixture.base',
      sourceBase: fixture.baseRevision,
      candidateIdentity: identity,
      generation: 1,
      seed: 'seed.relocation-fixture.base',
      coverage: 'exhaustive',
      strata: [
        { stratumId: 'risk.public-admission', sampleRateBps: 10000, disagreementTriggerBps: 10000 },
      ],
      obligations: [
        {
          obligationId: 'review.fixture.module',
          riskStratum: 'risk.public-admission',
          subject: {
            subjectId: 'subject.review.fixture.module',
            kind: 'project',
            locator: { kind: 'repository-root' },
            contentIdentity: identity,
          },
        },
      ],
      mode: 'enforce',
      claimedCoverage: 'exhaustive',
      reviews: [],
      corrections: [],
      closures: [],
      adjudications: [],
    },
  };
}

export interface BaseActivation {
  readonly root: string;
  readonly directory: string;
}

/**
 * Prepares the activation the relocation starts from: the same ten roles, taken at the base
 * revision, so the command under test reads a real base rather than a hand-written manifest.
 */
export function prepareBaseActivation(fixture: RelocationFixture): BaseActivation {
  const sources = join(fixture.workspace, 'base-sources');
  const root = join(fixture.workspace, 'base-root');
  mkdirSync(sources, { recursive: true });
  mkdirSync(root, { recursive: true });
  const show = (path: string): Uint8Array =>
    showFile(fixture.repository, fixture.baseRevision, path);
  const policy = join(sources, 'policy.json');
  const mapping = join(sources, 'mapping.json');
  const authority = join(sources, 'authority.json');
  const evidence = join(sources, 'evidence.json');
  const binding = join(sources, 'binding.json');
  const reviewReceipt = join(sources, 'review-receipt.json');
  const launcher = join(sources, 'launcher.sh');
  const snapshotter = join(sources, 'snapshotter.ts');
  const validator = join(sources, 'validator.mjs');
  writeFileSync(policy, show('docs/wiki-policy/policy.json'));
  writeFileSync(mapping, show('docs/wiki-policy/modules.json'));
  write(authority, serializeCanonical(baseAuthority(fixture)));
  write(
    evidence,
    serializeCanonical({
      schemaVersion: 1,
      reportMode: 'enforce',
      obligations: [
        {
          obligationId: 'obligation.fixture.module',
          checkIds: ['check.fixture.module'],
          reviewIds: ['review.fixture.module'],
        },
      ],
    }),
  );
  write(reviewReceipt, serializeCanonical({ schemaVersion: 1, receiptKind: 'review' }));
  cpSync(join(fixture.repository, 'bin/tool-wiki-lint.sh'), launcher);
  cpSync(join(fixture.repository, 'src/new/policy/snapshot-validator.ts'), snapshotter);
  buildValidatorInto(join(fixture.repository, 'src/new/cli.ts'), validator);
  write(
    binding,
    serializeCanonical({
      schemaVersion: 1,
      bindingId: 'binding.relocation-fixture.base',
      trustScope: 'ci',
      policy: { path: 'policy.json', sha256: hashBytes(readFileSync(policy)) },
      pilotModuleMapping: {
        candidatePath: 'docs/wiki-policy/modules.json',
        artifact: { path: 'mapping.json', sha256: hashBytes(readFileSync(mapping)) },
      },
      authority: {
        authorityId: 'authority.relocation-fixture.base',
        journalId: 'journal.relocation-fixture',
        trustScope: 'external-verifier',
        artifact: { path: 'authority.json', sha256: hashBytes(readFileSync(authority)) },
      },
      validator: {
        validatorId: 'validator.relocation-fixture.base',
        artifacts: [{ path: 'validator.mjs', sha256: hashBytes(readFileSync(validator)) }],
      },
    }),
  );
  const prepared = prepareActivation({
    candidateRepository: fixture.repository,
    destination: join(root, `activation-${fixture.baseRevision}`),
    roleSources: {
      authority,
      ciBinding: binding,
      evidence,
      launcher,
      localBinding: binding,
      mapping,
      policy,
      reviewReceipt,
      snapshotter,
      validator,
    },
    sourceRevision: fixture.baseRevision,
    policyIdentity: hashBytes(readFileSync(policy)),
    mappingIdentity: hashBytes(readFileSync(mapping)),
    validatorIdentity: hashBytes(readFileSync(validator)),
    reviewReceiptIdentity: hashBytes(readFileSync(reviewReceipt)),
  });
  selectActivation(root, prepared.directory, prepared.identity);
  return { root, directory: prepared.directory };
}

/** Assembles the planner inputs the shell would assemble, from committed fixture bytes. */
export function relocationSources(
  fixture: RelocationFixture,
  base: BaseActivation,
  overrides: {
    basePolicyBytes?: Uint8Array;
    baseMappingBytes?: Uint8Array;
    baseAuthorityBytes?: Uint8Array;
    policyBytes?: Uint8Array;
    mappingBytes?: Uint8Array;
    reviewedRevision?: string;
    validatorEntry?: string;
  } = {},
): RelocationSources {
  const show = (revision: string, path: string): Uint8Array =>
    showFile(fixture.repository, revision, path);
  const reviewedRevision = overrides.reviewedRevision ?? fixture.reviewedRevision;
  return {
    base: {
      kind: 'base',
      policyBytes:
        overrides.basePolicyBytes ?? readFileSync(join(base.directory, 'artifacts/policy.json')),
      mappingBytes:
        overrides.baseMappingBytes ?? readFileSync(join(base.directory, 'artifacts/mapping.json')),
      authorityBytes:
        overrides.baseAuthorityBytes ??
        readFileSync(join(base.directory, 'artifacts/authority.json')),
      validatorIdentity: hashBytes(readFileSync(join(base.directory, 'artifacts/validator.mjs'))),
      validatorEntry: overrides.validatorEntry ?? 'src/new/cli.ts',
    },
    candidate: {
      sha: fixture.candidateRevision,
      tree: readCandidate(fixture.repository, {
        kind: 'committed',
        revision: fixture.candidateRevision,
      }),
      reviewed: readCandidate(fixture.repository, {
        kind: 'committed',
        revision: reviewedRevision,
      }),
      policyBytes:
        overrides.policyBytes ?? show(fixture.candidateRevision, 'docs/wiki-policy/policy.json'),
      mappingBytes:
        overrides.mappingBytes ?? show(fixture.candidateRevision, 'docs/wiki-policy/modules.json'),
      mappingPath: 'docs/wiki-policy/modules.json',
      declarations: [
        {
          path: 'docs/wiki-policy/relationships.json',
          bytes: show(fixture.candidateRevision, 'docs/wiki-policy/relationships.json'),
        },
      ],
      validatorIdentity: 'f'.repeat(64),
    },
  };
}

/** Encodes a JSON value the way the fixture commits it, so digests match the committed bytes. */
export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonical(value));
}
