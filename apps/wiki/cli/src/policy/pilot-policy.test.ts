import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { markdownAnchors } from '../indexes/read-indexes';
import { extractNxRelationships } from '../relationships/nx';
import { loadTrustedPolicy, resolveValidatorArtifactPaths } from './trust';

interface ExactTuple {
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
  blob: string;
}

const repositoryRoot = resolve(import.meta.dir, '../../../../..');
const cliPath = join(import.meta.dir, '..', 'cli.ts');
const pilotPaths = [
  'docs/refactoring/w4-4/README.md',
  'docs/wiki-policy/modules.json',
  'docs/wiki-policy/modules.bootstrap.json',
  'docs/wiki-policy/policy.json',
  'docs/wiki-policy/bootstrap-policy.json',
  'docs/wiki-policy/relationships.json',
  'docs/wiki-policy/relationships.bootstrap.json',
  'libs/wbs/application/core/src/use-cases/README.md',
  'libs/wbs/domain/domain/src/saved-plan/README.md',
  'libs/wbs/adapters/store-memory/src/README.md',
  'openspec/changes/archive/2026-09-08-bounded-replay-sweep/README.md',
  'tools/tool-dagger/src/lib/README.md',
  'apps/wiki/cli/README.md',
] as const;
const scratch: string[] = [];

function run(argv: string[], cwd = repositoryRoot): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(argv, { cwd, stderr: 'pipe', stdout: 'pipe' });
}

function pipeText(pipe: Uint8Array | undefined, subject: string): string {
  if (pipe === undefined) throw new Error(`${subject} was not captured`);
  return Buffer.from(pipe).toString('utf8');
}

function output(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${pipeText(invocation.stdout, 'stdout')}${pipeText(invocation.stderr, 'stderr')}`;
}

function git(repository: string, argv: string[]): string {
  const invocation = run(['git', '-C', repository, ...argv]);
  expect(invocation.exitCode, output(invocation)).toBe(0);
  return pipeText(invocation.stdout, 'git stdout').trim();
}

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}

/** Whether `path` is `prefix` itself or lies beneath it, the containment every selector uses. */
function underPrefix(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function entriesAt(repository: string, revision: string): ExactTuple[] {
  const source = git(repository, ['ls-tree', '-r', revision]);
  return source.split('\n').map((record) => {
    const match = /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]+)\t(.+)$/.exec(record);
    if (match === null) throw new Error(`malformed pilot tuple: ${record}`);
    return { mode: match[1] as ExactTuple['mode'], blob: match[2], path: match[3] };
  });
}

function candidateIdentity(repository: string, revision: string, entries: ExactTuple[]): string {
  return hashCanonical({
    selection: {
      kind: 'committed',
      revision,
      tree: git(repository, ['rev-parse', `${revision}^{tree}`]),
    },
    entries,
    untracked: [],
  });
}

function createCandidate(): { repository: string; revision: string } {
  const parent = mkdtempSync(join(tmpdir(), 'tool-wiki-pilot-candidate-'));
  scratch.push(parent);
  const repository = join(parent, 'candidate');
  const clone = run(['git', 'clone', '--quiet', '--no-hardlinks', repositoryRoot, repository]);
  expect(clone.exitCode, output(clone)).toBe(0);
  git(repository, ['config', 'user.email', 'pilot@example.test']);
  git(repository, ['config', 'user.name', 'Pilot Policy Test']);
  for (const path of pilotPaths) {
    const destination = join(repository, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, path), destination);
  }
  git(repository, ['add', '--all']);
  // The source checkout contains the pilot after its implementation commit; keep constructing a
  // fresh immutable candidate even when the reviewed overlay is byte-identical.
  git(repository, ['commit', '--quiet', '--allow-empty', '--message', 'pilot candidate']);
  return { repository, revision: git(repository, ['rev-parse', 'HEAD']) };
}

function createExternalTrust(
  candidate: { repository: string; revision: string },
  trustedMappingBytes = readFileSync(join(candidate.repository, 'docs/wiki-policy/modules.json')),
): {
  authorityPath: string;
  bindingPath: string;
  evidencePath: string;
  mappingPath: string;
  policyPath: string;
} {
  const trust = mkdtempSync(join(tmpdir(), 'tool-wiki-pilot-trust-'));
  scratch.push(trust);
  const entries = entriesAt(candidate.repository, candidate.revision);
  const identity = candidateIdentity(candidate.repository, candidate.revision, entries);
  const policyPath = join(trust, 'policy.json');
  cpSync(join(candidate.repository, 'docs/wiki-policy/policy.json'), policyPath);
  const mappingPath = join(trust, 'modules.json');
  write(mappingPath, new TextDecoder().decode(trustedMappingBytes));
  const authorityPath = join(trust, 'authority.json');
  const content = entries.map((entry, index) => ({
    kind: 'content',
    inputId: `content.${String(index)}`,
    ...entry,
  }));
  write(
    authorityPath,
    `${JSON.stringify({
      schemaVersion: 1,
      authorityId: 'authority.pilot-observe.v1',
      obligationRequest: {
        reviewed: {
          sourceBase: candidate.revision,
          candidateIdentity: identity,
          inputs: { content, structural: [], semantic: [], topology: [] },
        },
        current: {
          sourceBase: candidate.revision,
          candidateIdentity: identity,
          inputs: { content, structural: [], semantic: [], topology: [] },
        },
        judgments: [],
        policy: { policyId: 'policy.radical-modularity-pilot.v1', behaviorRules: [] },
        impactClassifications: [],
        writerLabels: [],
        checks: [],
        reviews: [],
      },
      checkReceipts: [],
      audit: {
        schemaVersion: 1,
        auditId: 'audit.pilot-observe.v1',
        sourceBase: candidate.revision,
        candidateIdentity: identity,
        generation: 1,
        seed: 'seed.pilot-observe.v1',
        coverage: 'exhaustive',
        strata: [],
        obligations: [],
        mode: 'observe',
        claimedCoverage: 'exhaustive',
        reviews: [],
        corrections: [],
        closures: [],
        adjudications: [],
      },
    })}\n`,
  );
  const validatorArtifacts = resolveValidatorArtifactPaths([
    cliPath,
    join(import.meta.dir, 'trust.ts'),
  ]).map((path) => ({ path, sha256: sha256(readFileSync(path)) }));
  const bindingPath = join(trust, 'binding.json');
  write(
    bindingPath,
    `${JSON.stringify({
      schemaVersion: 1,
      bindingId: 'binding.pilot-observe.v1',
      trustScope: 'local-operator',
      policy: { path: policyPath, sha256: sha256(readFileSync(policyPath)) },
      pilotModuleMapping: {
        candidatePath: 'docs/wiki-policy/modules.json',
        artifact: { path: mappingPath, sha256: sha256(readFileSync(mappingPath)) },
      },
      authority: {
        authorityId: 'authority.pilot-observe.v1',
        journalId: 'journal.pilot-observe.v1',
        trustScope: 'external-verifier',
        artifact: { path: authorityPath, sha256: sha256(readFileSync(authorityPath)) },
      },
      validator: { validatorId: 'validator.tool-wiki.pilot.v1', artifacts: validatorArtifacts },
    })}\n`,
  );
  const evidencePath = join(trust, 'evidence.json');
  write(evidencePath, '{"schemaVersion":1,"reportMode":"observe","obligations":[]}\n');
  return { authorityPath, bindingPath, evidencePath, mappingPath, policyPath };
}

interface PilotBinding {
  policy: { path: string; sha256: string };
  pilotModuleMapping: {
    candidatePath: string;
    artifact: { path: string; sha256: string };
  };
}

function readPilotBinding(path: string): PilotBinding {
  return JSON.parse(readFileSync(path, 'utf8')) as PilotBinding;
}

function writePilotBinding(path: string, binding: PilotBinding): void {
  write(path, `${JSON.stringify(binding)}\n`);
}

function lint(
  candidate: { repository: string; revision: string },
  trust: { bindingPath: string; evidencePath: string },
): ReturnType<typeof Bun.spawnSync> {
  return run([
    process.execPath,
    'run',
    cliPath,
    'lint-local',
    'observe',
    'committed',
    candidate.repository,
    candidate.revision,
    trust.bindingPath,
    trust.evidencePath,
  ]);
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('reviewed radical-modularity pilot through production CLI', () => {
  test('loads the narrow enforced Tool Wiki bootstrap policy through the trusted boundary', () => {
    const candidate = createCandidate();
    const trust = createExternalTrust(candidate);
    const binding = readPilotBinding(trust.bindingPath);
    binding.policy = {
      path: trust.policyPath,
      sha256: sha256(
        readFileSync(join(candidate.repository, 'docs/wiki-policy/bootstrap-policy.json')),
      ),
    };
    cpSync(join(candidate.repository, 'docs/wiki-policy/bootstrap-policy.json'), trust.policyPath);
    binding.pilotModuleMapping.artifact = {
      path: trust.mappingPath,
      sha256: sha256(
        readFileSync(join(candidate.repository, 'docs/wiki-policy/modules.bootstrap.json')),
      ),
    };
    cpSync(
      join(candidate.repository, 'docs/wiki-policy/modules.bootstrap.json'),
      trust.mappingPath,
    );
    const authority = JSON.parse(readFileSync(trust.authorityPath, 'utf8')) as {
      obligationRequest: { policy: { policyId: string } };
    };
    authority.obligationRequest.policy.policyId = 'policy.tool-wiki-bootstrap.v1';
    write(trust.authorityPath, `${JSON.stringify(authority)}\n`);
    const completeBinding = JSON.parse(readFileSync(trust.bindingPath, 'utf8')) as PilotBinding & {
      authority: { artifact: { sha256: string } };
    };
    completeBinding.policy = binding.policy;
    completeBinding.pilotModuleMapping = binding.pilotModuleMapping;
    completeBinding.authority.artifact.sha256 = sha256(readFileSync(trust.authorityPath));
    writePilotBinding(trust.bindingPath, completeBinding);

    const loaded = loadTrustedPolicy(trust.bindingPath, candidate.repository);
    // Proof: deleting the sole adopted boundary made this production-loader test fail on the exact
    // object diff `adoptedBoundaryIds: []` instead of the required Tool Wiki boundary.
    expect(loaded.policy).toMatchObject({
      activationBoundaryIds: [],
      adoptedBoundaryIds: ['boundary.infra.tool-wiki'],
      minimumMode: 'enforce',
      obligations: [
        {
          boundaryId: 'boundary.infra.tool-wiki',
          checkIds: [
            'check.wiki-cli.test',
            'check.wiki-cli.lint-source',
            'check.wiki-cli.typecheck',
          ],
          obligationId: 'obligation.tool-wiki.bootstrap',
          reviewIds: ['review.tool-wiki.bootstrap'],
        },
      ],
      policyId: 'policy.tool-wiki-bootstrap.v1',
    });
    expect(loaded.pilotModuleMapping?.mapping.modules.at(-1)?.moduleId).toBe(
      'module.infra.tool-wiki',
    );
  });

  test('pins exact pre-index tuples and passes observe lint from external trust', () => {
    const candidate = createCandidate();
    const policy = JSON.parse(
      readFileSync(join(candidate.repository, 'docs/wiki-policy/policy.json'), 'utf8'),
    ) as {
      pilot: { sourceRevision: string; coverage: string; exclusions: object[] };
      boundaries: {
        selector: { value: string };
        sourceSelector?: { value: string };
        baselineEntries: ExactTuple[];
      }[];
    };
    expect(policy.pilot).toMatchObject({
      sourceRevision: '7851161bf96312750d07b933ca5d42b75ce575c7',
      coverage: 'selected-boundaries-only',
    });
    expect(policy.pilot.exclusions.length).toBeGreaterThan(0);
    expect(policy.boundaries.at(0)).toMatchObject({
      selector: { value: 'libs/wbs/domain/domain/src/saved-plan' },
      sourceSelector: { value: 'libs/domain/src/saved-plan' },
    });
    const baseline = entriesAt(repositoryRoot, policy.pilot.sourceRevision);
    for (const boundary of policy.boundaries) {
      const selector = boundary.sourceSelector ?? boundary.selector;
      expect(boundary.baselineEntries).toEqual(
        baseline.filter(
          ({ path }) => path === selector.value || path.startsWith(`${selector.value}/`),
        ),
      );
    }

    const mappingPath = join(candidate.repository, 'docs/wiki-policy/modules.json');
    const mapping = run([
      process.execPath,
      'run',
      cliPath,
      'validate',
      'module-mapping',
      mappingPath,
    ]);
    expect(mapping.exitCode, output(mapping)).toBe(0);
    const modules = (
      JSON.parse(readFileSync(mappingPath, 'utf8')) as {
        modules: { moduleId: string; predecessorModuleIds: string[] }[];
      }
    ).modules;
    expect(modules).toHaveLength(6);
    expect(modules.every(({ predecessorModuleIds }) => predecessorModuleIds.length === 0)).toBe(
      true,
    );
    const indexInvocation = run([
      process.execPath,
      'run',
      cliPath,
      'check-indexes',
      'committed',
      candidate.repository,
      candidate.revision,
    ]);
    expect(indexInvocation.exitCode, output(indexInvocation)).toBe(0);
    const indexReport = JSON.parse(pipeText(indexInvocation.stdout, 'index stdout')) as {
      indexes: { moduleId: string; applicableChecks: string[]; externalConsumers: string[] }[];
    };
    expect(indexReport.indexes.map(({ moduleId }) => moduleId).sort()).toEqual(
      [
        ...modules.map(({ moduleId }) => moduleId),
        'module.docs.findings',
        'module.infra.tool-wiki',
      ].sort(),
    );
    expect(indexReport.indexes.every(({ applicableChecks }) => applicableChecks.length > 0)).toBe(
      true,
    );
    expect(indexReport.indexes.every(({ externalConsumers }) => externalConsumers.length > 0)).toBe(
      true,
    );
    const trust = createExternalTrust(candidate);
    const invocation = lint(candidate, trust);
    // Proof: omitting the five namespaced Dagger target inputs from the live relationship
    // declaration made this production CLI report the exact authority-selector mismatch (0/1).
    expect(invocation.exitCode, output(invocation)).toBe(0);
    expect(JSON.parse(pipeText(invocation.stdout, 'lint stdout'))).toMatchObject({
      mode: 'observe',
      trustProvenance: 'local-operator',
      accepted: true,
      certified: false,
    });
  }, 120_000);

  test('refuses an externally selected mapping that resolves inside the candidate', () => {
    const candidate = createCandidate();
    const trust = createExternalTrust(candidate);
    const binding = readPilotBinding(trust.bindingPath);
    binding.pilotModuleMapping.artifact = {
      path: join(candidate.repository, 'docs/wiki-policy/modules.json'),
      sha256: sha256(readFileSync(join(candidate.repository, 'docs/wiki-policy/modules.json'))),
    };
    writePilotBinding(trust.bindingPath, binding);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: removing the mapping's external-boundary guard returned accepted true here and failed
    // on `Expected: 1 / Received: 0`.
    expect(observed).toContain('trusted pilot module mapping resolves inside selected candidate:');
  }, 120_000);

  test('refuses a missing externally selected mapping', () => {
    const candidate = createCandidate();
    const trust = createExternalTrust(candidate);
    const binding = readPilotBinding(trust.bindingPath);
    const missingPath = join(dirname(trust.mappingPath), 'missing-modules.json');
    binding.pilotModuleMapping.artifact.path = missingPath;
    writePilotBinding(trust.bindingPath, binding);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: pointing this dependency at the existing readable mapping returned accepted true and
    // failed on `Expected: 1 / Received: 0`.
    expect(observed).toContain(`cannot open trusted pilot module mapping ${missingPath}:`);
    expect(observed).toContain('ENOENT');
  }, 120_000);

  test('refuses an unreadable externally selected mapping distinctly from absence', () => {
    const candidate = createCandidate();
    const trust = createExternalTrust(candidate);
    chmodSync(trust.mappingPath, 0o000);
    let invocation: ReturnType<typeof Bun.spawnSync>;
    try {
      invocation = lint(candidate, trust);
    } finally {
      chmodSync(trust.mappingPath, 0o600);
    }
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: making this file readable returned accepted true and failed on
    // `Expected: 1 / Received: 0`.
    expect(observed).toContain(`cannot open trusted pilot module mapping ${trust.mappingPath}:`);
    expect(observed).toContain('EACCES');
    expect(observed).not.toContain('ENOENT');
  }, 120_000);

  test('refuses an externally selected mapping whose digest differs from its binding', () => {
    const candidate = createCandidate();
    const trust = createExternalTrust(candidate);
    const binding = readPilotBinding(trust.bindingPath);
    binding.pilotModuleMapping.artifact.sha256 = '0'.repeat(64);
    writePilotBinding(trust.bindingPath, binding);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: removing the mapping digest comparison returned accepted true here and failed on
    // `Expected: 1 / Received: 0`.
    expect(observed).toContain('trusted pilot module mapping digest does not match binding');
  }, 120_000);

  test('refuses an externally selected mapping for a different source revision', () => {
    const candidate = createCandidate();
    const mappingPath = join(candidate.repository, 'docs/wiki-policy/modules.json');
    const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as {
      sourceRevision: string;
    };
    mapping.sourceRevision = '0'.repeat(40);
    write(mappingPath, `${JSON.stringify(mapping)}\n`);
    git(candidate.repository, ['add', mappingPath]);
    git(candidate.repository, ['commit', '--quiet', '--message', 'change mapping source revision']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
    // Build authority, evidence and the external mapping binding from the same committed candidate
    // so no stale candidate identity can become a second reason for refusal.
    const trust = createExternalTrust(candidate);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    // Proof: removing only the source-revision comparison returned accepted true here after both
    // mapping copies and every candidate-bound authority field were regenerated; this failed on
    // `Expected: 1 / Received: 0`.
    expect(invocation.exitCode, observed).toBe(1);
    expect(observed).toContain('trusted pilot module mapping source does not match pilot policy');
  }, 120_000);

  test('fails observe lint when one actual pilot member leaves its index', () => {
    const candidate = createCandidate();
    const trust = createExternalTrust(candidate);
    const readme = join(candidate.repository, 'libs/wbs/domain/domain/src/saved-plan/README.md');
    write(
      readme,
      readFileSync(readme, 'utf8').replace('{"kind":"path","path":"canonical-plan-input.ts"},', ''),
    );
    git(candidate.repository, ['add', readme]);
    git(candidate.repository, ['commit', '--quiet', '--message', 'remove actual membership']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: removing canonical-plan-input.ts from the production pilot index failed here with
    // `unindexed candidate path in libs/wbs/domain/domain/src/saved-plan/README.md: ...`.
    expect(observed).toContain(
      'unindexed candidate path in libs/wbs/domain/domain/src/saved-plan/README.md: libs/wbs/domain/domain/src/saved-plan/canonical-plan-input.ts',
    );
  }, 120_000);

  test('refuses prose facts presented as applicable checks', () => {
    const candidate = createCandidate();
    const declarationPath = join(candidate.repository, 'docs/wiki-policy/relationships.json');
    const declaration = JSON.parse(readFileSync(declarationPath, 'utf8')) as {
      facts: { factId: string }[];
    };
    declaration.facts = declaration.facts.map(({ factId }) => ({
      factId,
      family: 'external-consumers',
      at: { kind: 'current' },
      kind: 'external-consumer',
      system: 'review-prose',
      contract: 'claims to be a check without executable authority',
      knowledgeLimit: 'The declaration carries no executable check.',
    }));
    write(declarationPath, `${JSON.stringify(declaration)}\n`);
    git(candidate.repository, ['add', declarationPath]);
    git(candidate.repository, ['commit', '--quiet', '--message', 'replace checks with prose']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
    const trust = createExternalTrust(candidate);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: replacing every executable check with external-consumer prose was refused at
    // `apps/wiki/cli/README.md: check.wiki-cli.test (external-consumer)`. The refusal names the
    // first offending index in path order, which moved from `docs/findings/README.md` to this
    // one when tool-wiki became `apps/wiki/cli` (2026-09-16).
    expect(observed).toContain(
      'applicable check has no executable authority in apps/wiki/cli/README.md: check.wiki-cli.test (external-consumer)',
    );
  }, 120_000);

  test('refuses an owned README declared as its own external consumer', () => {
    const candidate = createCandidate();
    const readme = join(candidate.repository, 'libs/wbs/domain/domain/src/saved-plan/README.md');
    const source = readFileSync(readme, 'utf8');
    const block = /<!-- module-index ([\s\S]+) -->/.exec(source);
    if (block === null) throw new Error('saved-plan index metadata absent');
    const metadata = JSON.parse(block[1]) as Record<string, unknown>;
    metadata['externalConsumers'] = {
      kind: 'declared',
      memberships: [{ kind: 'path', path: 'libs/wbs/domain/domain/src/saved-plan/README.md' }],
      knowledgeLimit: 'The boundary index is not an external consumer.',
    };
    write(readme, source.replace(block[0], `<!-- module-index ${JSON.stringify(metadata)} -->`));
    git(candidate.repository, ['add', readme]);
    git(candidate.repository, ['commit', '--quiet', '--message', 'claim owned README as consumer']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
    const trust = createExternalTrust(candidate);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: naming the saved-plan README as its own consumer failed at this ownership assertion.
    expect(observed).toContain(
      'external consumer is owned by libs/wbs/domain/domain/src/saved-plan/README.md: libs/wbs/domain/domain/src/saved-plan/README.md',
    );
  }, 120_000);

  test('refuses a pilot mapping whose pinned predecessor identity differs from the candidate', () => {
    const candidate = createCandidate();
    const mappingPath = join(candidate.repository, 'docs/wiki-policy/modules.json');
    const trustedMapping = readFileSync(mappingPath);
    const mapping = JSON.parse(new TextDecoder().decode(trustedMapping)) as {
      modules: { moduleId: string; predecessorModuleIds: string[] }[];
    };
    const savedPlan = mapping.modules.find(
      ({ moduleId }) => moduleId === 'module.domain.saved-plan',
    );
    if (savedPlan === undefined) throw new Error('saved-plan module mapping absent');
    savedPlan.predecessorModuleIds = ['module.domain.saved-plan.legacy'];
    write(mappingPath, `${JSON.stringify(mapping)}\n`);
    git(candidate.repository, ['add', mappingPath]);
    git(candidate.repository, ['commit', '--quiet', '--message', 'change mapped predecessor']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
    const trust = createExternalTrust(candidate, trustedMapping);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: without candidate-to-binding identity reconciliation this predecessor change
    // returned accepted true with regenerated candidate authority and evidence.
    expect(observed).toContain(
      'candidate pilot module mapping does not match externally bound identity: docs/wiki-policy/modules.json',
    );
  }, 120_000);

  test('refuses a missing mapped pilot index with current candidate evidence', () => {
    const candidate = createCandidate();
    const readme = join(candidate.repository, 'libs/wbs/domain/domain/src/saved-plan/README.md');
    rmSync(readme);
    git(candidate.repository, ['add', '--all']);
    git(candidate.repository, ['commit', '--quiet', '--message', 'delete mapped index']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
    const trust = createExternalTrust(candidate);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: before mapping reconciliation, deleting this required index returned accepted true
    // with regenerated candidate authority and evidence.
    expect(observed).toContain(
      'pilot module index absent for module.domain.saved-plan: libs/wbs/domain/domain/src/saved-plan/README.md',
    );
  }, 120_000);

  test('refuses externally pinned module and ownership claims that disagree with indexes', () => {
    const mutations: {
      name: string;
      mutate: (module: { moduleId: string; memberships: unknown[]; indexPath: string }) => void;
      expected: string;
    }[] = [
      {
        name: 'change mapped module identity',
        mutate(module: { moduleId: string }): void {
          module.moduleId = 'module.domain.saved-plan.renamed';
        },
        expected:
          'pilot module identity disagrees with index libs/wbs/domain/domain/src/saved-plan/README.md: module.domain.saved-plan.renamed != module.domain.saved-plan',
      },
      {
        name: 'point the mapped index at a file that carries no index metadata',
        mutate(module: { indexPath: string }): void {
          module.indexPath = 'libs/wbs/domain/domain/src/saved-plan/canonical-plan-input.ts';
        },
        // This refusal's text had no assertion anywhere until now.
        // Proof: rewording the throw in `trust.ts` to `pilot module index is not an index:`
        // failed this case on `Expected substring: "pilot module index has no module-index
        // metadata: ..."`; the production message is what is pinned, not the branch (2026-09-16).
        expected:
          'pilot module index has no module-index metadata: libs/wbs/domain/domain/src/saved-plan/canonical-plan-input.ts',
      },
      {
        name: 'change mapped ownership',
        mutate(module: { moduleId: string; memberships: unknown[] }): void {
          module.memberships = [
            {
              kind: 'directory-prefix',
              prefix: 'libs/wbs/application/core/src/use-cases',
              exclusions: [],
            },
          ];
        },
        expected:
          'pilot module ownership disagrees with index libs/wbs/domain/domain/src/saved-plan/README.md: module.domain.saved-plan',
      },
    ];
    for (const mutation of mutations) {
      const candidate = createCandidate();
      const mappingPath = join(candidate.repository, 'docs/wiki-policy/modules.json');
      const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as {
        modules: { moduleId: string; memberships: unknown[]; indexPath: string }[];
      };
      const savedPlan = mapping.modules.find(
        ({ moduleId }) => moduleId === 'module.domain.saved-plan',
      );
      if (savedPlan === undefined) throw new Error('saved-plan module mapping absent');
      mutation.mutate(savedPlan);
      write(mappingPath, `${JSON.stringify(mapping)}\n`);
      git(candidate.repository, ['add', mappingPath]);
      git(candidate.repository, ['commit', '--quiet', '--message', mutation.name]);
      candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
      // Authority and evidence are rebuilt for this candidate, while the external binding pins
      // the exact mapping bytes the operator selected.
      const trust = createExternalTrust(candidate);

      const invocation = lint(candidate, trust);
      const observed = output(invocation);
      expect(invocation.exitCode, observed).toBe(1);
      expect(observed).toContain(mutation.expected);
    }
  }, 180_000);

  test('refuses mapped external consumers that disagree with the owned index', () => {
    const candidate = createCandidate();
    const mappingPath = join(candidate.repository, 'docs/wiki-policy/modules.json');
    const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as {
      modules: { moduleId: string; externalConsumers: unknown }[];
    };
    const savedPlan = mapping.modules.find(
      ({ moduleId }) => moduleId === 'module.domain.saved-plan',
    );
    if (savedPlan === undefined) throw new Error('saved-plan module mapping absent');
    savedPlan.externalConsumers = { kind: 'none' };
    write(mappingPath, `${JSON.stringify(mapping)}\n`);
    git(candidate.repository, ['add', mappingPath]);
    git(candidate.repository, ['commit', '--quiet', '--message', 'drop mapped consumers']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
    const trust = createExternalTrust(candidate);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: without mapping-consumer reconciliation this candidate returned accepted true.
    expect(observed).toContain(
      'pilot module external consumers disagree with index libs/wbs/domain/domain/src/saved-plan/README.md: module.domain.saved-plan',
    );
  }, 120_000);

  test('refuses a selected pilot index omitted from the externally pinned mapping', () => {
    const candidate = createCandidate();
    const mappingPath = join(candidate.repository, 'docs/wiki-policy/modules.json');
    const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as {
      modules: { moduleId: string }[];
    };
    mapping.modules = mapping.modules.filter(
      ({ moduleId }) => moduleId !== 'module.domain.saved-plan',
    );
    write(mappingPath, `${JSON.stringify(mapping)}\n`);
    git(candidate.repository, ['add', mappingPath]);
    git(candidate.repository, ['commit', '--quiet', '--message', 'omit mapped module']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
    const trust = createExternalTrust(candidate);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: without mapping completeness this omitted module returned accepted true.
    expect(observed).toContain(
      'pilot index has no module mapping: libs/wbs/domain/domain/src/saved-plan/README.md',
    );
  }, 120_000);

  test('refuses a trusted selector left at the pre-move directory of a relocated boundary', () => {
    const candidate = createCandidate();
    const trust = createExternalTrust(candidate);
    const policy = JSON.parse(readFileSync(trust.policyPath, 'utf8')) as {
      boundaries: {
        boundaryId: string;
        selector: { kind: string; value: string };
        sourceSelector?: { kind: string; value: string };
      }[];
    };
    const relocated = policy.boundaries.find(
      ({ boundaryId }) => boundaryId === 'boundary.domain.saved-plan',
    );
    if (relocated === undefined) throw new Error('pilot domain boundary absent');
    const preMove = relocated.sourceSelector;
    if (preMove === undefined) throw new Error('pilot source selector unexpectedly absent');
    relocated.selector = preMove;
    delete relocated.sourceSelector;
    write(trust.policyPath, `${JSON.stringify(policy)}\n`);
    const binding = JSON.parse(readFileSync(trust.bindingPath, 'utf8')) as {
      policy: { sha256: string };
    };
    binding.policy.sha256 = sha256(readFileSync(trust.policyPath));
    write(trust.bindingPath, `${JSON.stringify(binding)}\n`);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    // Proof: leaving this boundary's selector at the candidate's post-move path made production
    // observe lint report `accepted: true`, and this exit-code assertion failed on
    // `Expected: 1 / Received: 0`.
    expect(invocation.exitCode, observed).toBe(1);
    expect(observed).toContain(
      'trusted boundary selector selects no candidate input: boundary.domain.saved-plan (selector prefix libs/domain/src/saved-plan); if the candidate moved these files, prepare a relocation activation from the candidate SHA: see docs/runbook-tool-wiki-activation.md#relocation',
    );
    // The trusted policy is intact; only its selector missed.
    expect(observed).not.toContain('trusted policy digest does not match binding');

    // The refusal sends an operator to a runbook section, and no Markdown document links that
    // anchor, so the repository link check never resolves it. Take the destination out of the
    // message itself rather than repeating it, and resolve it with the same production anchor
    // reader `check-indexes` uses, so renaming the heading breaks this test and not only the
    // operator's day.
    const named = /see (docs\/[^\s#]+\.md)#([^\s.,)]+)/.exec(observed);
    if (named === null) throw new Error(`refusal names no runbook anchor: ${observed}`);
    const [, runbook, anchor] = named;
    // Proof: renaming the runbook heading to `## Relocating the boundary` left this assertion
    // observing `["tool-wiki-trusted-activation", "prepare", "transport-and-admission",
    // "relocating-the-boundary", "final-binding-and-recovery"]` with no `relocation` (2026-09-16).
    expect([...markdownAnchors(readFileSync(join(repositoryRoot, runbook), 'utf8'))]).toContain(
      anchor,
    );
  }, 120_000);

  test('refuses an empty, unmapped, incompatible, or escaping pre-index tuple manifest', () => {
    const mutations = [
      {
        mutate(boundary: {
          baselineEntries: ExactTuple[];
          sourceSelector?: { kind: string };
        }): void {
          boundary.baselineEntries = [];
        },
        expected: 'trusted boundary baseline is empty: boundary.domain.saved-plan',
      },
      {
        mutate(boundary: {
          baselineEntries: ExactTuple[];
          sourceSelector?: { kind: string };
        }): void {
          delete boundary.sourceSelector;
        },
        expected:
          'trusted boundary baseline escapes selector boundary.domain.saved-plan: libs/domain/src/saved-plan/canonical-plan-input.test.ts',
      },
      {
        mutate(boundary: {
          baselineEntries: ExactTuple[];
          sourceSelector?: { kind: string };
        }): void {
          if (boundary.sourceSelector === undefined) {
            throw new Error('pilot source selector unexpectedly absent');
          }
          boundary.sourceSelector.kind = 'path';
        },
        expected: 'trusted boundary source selector kind differs: boundary.domain.saved-plan',
      },
      {
        mutate(boundary: {
          baselineEntries: ExactTuple[];
          sourceSelector?: { kind: string };
        }): void {
          const entry = boundary.baselineEntries.at(0);
          if (entry === undefined) throw new Error('pilot baseline unexpectedly empty');
          entry.path = 'libs/core/src/use-cases/replay.ts';
        },
        expected:
          'trusted boundary baseline escapes selector boundary.domain.saved-plan: libs/core/src/use-cases/replay.ts',
      },
    ];
    for (const mutation of mutations) {
      const candidate = createCandidate();
      const trust = createExternalTrust(candidate);
      const policy = JSON.parse(readFileSync(trust.policyPath, 'utf8')) as {
        boundaries: {
          boundaryId: string;
          baselineEntries: ExactTuple[];
          sourceSelector?: { kind: string };
        }[];
      };
      const boundary = policy.boundaries.find(
        ({ boundaryId }) => boundaryId === 'boundary.domain.saved-plan',
      );
      if (boundary === undefined) throw new Error('pilot domain boundary absent');
      mutation.mutate(boundary);
      write(trust.policyPath, `${JSON.stringify(policy)}\n`);
      const binding = JSON.parse(readFileSync(trust.bindingPath, 'utf8')) as {
        policy: { sha256: string };
      };
      binding.policy.sha256 = sha256(readFileSync(trust.policyPath));
      write(trust.bindingPath, `${JSON.stringify(binding)}\n`);

      const invocation = lint(candidate, trust);
      const observed = output(invocation);
      expect(invocation.exitCode, observed).toBe(1);
      expect(observed).toContain(mutation.expected);
    }
  }, 120_000);
});

/**
 * These cases read the committed `docs/wiki-policy` bootstrap files and the repository at `HEAD`
 * directly. They are not admission: they are the standing oracle that keeps the trusted policy,
 * its module mapping and its relationship declarations pointing at paths and projects that still
 * exist, so a move that forgets one of the three files is red here instead of in CI's
 * `trusted-wiki` job.
 */
describe('on-disk bootstrap policy, mapping and relationship files', () => {
  test('the bootstrap policy and mapping select the moved pilot boundaries at HEAD', () => {
    const bootstrapPolicy = JSON.parse(
      readFileSync(join(repositoryRoot, 'docs/wiki-policy/bootstrap-policy.json'), 'utf8'),
    ) as {
      pilot: { sourceRevision: string };
      boundaries: {
        boundaryId: string;
        selector: { kind: string; value: string };
        sourceSelector?: { kind: string; value: string };
        baselineEntries: ExactTuple[];
      }[];
    };
    const bootstrapMapping = JSON.parse(
      readFileSync(join(repositoryRoot, 'docs/wiki-policy/modules.bootstrap.json'), 'utf8'),
    ) as {
      modules: {
        moduleId: string;
        indexPath: string;
        memberships: { kind: string; prefix?: string; path?: string }[];
      }[];
    };
    const headPaths = entriesAt(repositoryRoot, 'HEAD').map(({ path }) => path);
    // The baselines are reviewed tuples at this revision; the relocation command refuses a
    // revision that lacks them, so a bump here is a policy change, not a maintenance detail.
    expect(bootstrapPolicy.pilot.sourceRevision).toBe('364cc0f8ef901cbfc574c6391c385e7f79bf27b4');
    const wiki = bootstrapPolicy.boundaries.find(
      ({ boundaryId }) => boundaryId === 'boundary.infra.tool-wiki',
    );
    // The selector pair of the boundary W6 moved, pinned literally. The HEAD assertions below
    // only ask that a selector match something, which a widened `apps` would also do.
    // Proof: widening the boundary's selector to `apps` in the real policy file left every
    // assertion below green — `apps` matches at HEAD and every mapped path still lies under it —
    // and failed here alone on `- "value": "apps/wiki/cli" · + "value": "apps"` (2026-09-16).
    expect(wiki?.selector).toEqual({ kind: 'prefix', value: 'apps/wiki/cli' });
    expect(wiki?.sourceSelector).toEqual({ kind: 'prefix', value: 'tools/tool-wiki' });
    // Proof: with the three moved boundaries still selecting `libs/domain/src/saved-plan`,
    // `libs/core/src/use-cases` and `libs/store-memory/src`, this assertion failed with exactly
    // those three boundary ids received against `[]` (2026-09-16).
    expect(
      bootstrapPolicy.boundaries
        .filter(({ selector }) => !headPaths.some((path) => underPrefix(selector.value, path)))
        .map(({ boundaryId }) => boundaryId),
    ).toEqual([]);
    // Proof: moving one baseline path of `boundary.domain.saved-plan` to the post-move prefix
    // while its `sourceSelector` named the pre-move one failed here with that boundary id.
    expect(
      bootstrapPolicy.boundaries
        .filter(({ selector, sourceSelector, baselineEntries }) =>
          baselineEntries.some(
            ({ path }) => !underPrefix((sourceSelector ?? selector).value, path),
          ),
        )
        .map(({ boundaryId }) => boundaryId),
    ).toEqual([]);
    // Proof: with `modules.bootstrap.json` still mapping the three moved modules to their
    // pre-move prefixes, this assertion failed with their index paths and membership prefixes
    // listed as strays under the new selectors (2026-09-16).
    expect(
      bootstrapPolicy.boundaries
        .map(({ boundaryId, selector }) => {
          const moduleId = boundaryId.replace('boundary.', 'module.');
          const mapped = bootstrapMapping.modules.find((entry) => entry.moduleId === moduleId);
          if (mapped === undefined) {
            throw new Error(`bootstrap mapping has no module for ${boundaryId}`);
          }
          const claimed = [
            mapped.indexPath,
            ...mapped.memberships.map((membership) => {
              const path = membership.prefix ?? membership.path;
              if (path === undefined) {
                throw new Error(`membership of ${moduleId} names neither prefix nor path`);
              }
              return path;
            }),
          ];
          return { moduleId, strays: claimed.filter((path) => !underPrefix(selector.value, path)) };
        })
        .filter(({ strays }) => strays.length > 0),
    ).toEqual([]);
  }, 30_000);

  test('every obligation check id resolves to a fact its policy declares', () => {
    const unresolved: string[] = [];
    let resolved = 0;
    for (const policyPath of [
      'docs/wiki-policy/bootstrap-policy.json',
      'docs/wiki-policy/policy.json',
    ]) {
      const policy = JSON.parse(readFileSync(join(repositoryRoot, policyPath), 'utf8')) as {
        relationshipRequest: { declarationPaths: string[] };
        obligations: { obligationId: string; checkIds: string[] }[];
      };
      const declared = new Set(
        policy.relationshipRequest.declarationPaths.flatMap((declarationPath) => {
          const declarations = JSON.parse(
            readFileSync(join(repositoryRoot, declarationPath), 'utf8'),
          ) as { facts: { factId: string }[] };
          return declarations.facts.map(({ factId }) => factId);
        }),
      );
      // A policy whose declarations were empty would satisfy nothing below by resolving nothing.
      expect(declared.size).toBeGreaterThan(0);
      for (const { obligationId, checkIds } of policy.obligations) {
        for (const checkId of checkIds) {
          if (declared.has(checkId)) resolved += 1;
          else unresolved.push(`${policyPath}: ${obligationId} -> ${checkId}`);
        }
      }
    }
    // Proof: with `obligation.tool-wiki.bootstrap` still naming `check.tool-wiki.test`,
    // `.lint-source` and `.typecheck` while `relationships.bootstrap.json` declared only the
    // renamed `check.wiki-cli.*`, this assertion observed exactly those three
    // `bootstrap-policy.json: obligation.tool-wiki.bootstrap -> check.tool-wiki.*` entries
    // against `[]`. Nothing else in the repository resolved an obligation's check ids against
    // the facts its `declarationPaths` declare, so that disagreement was silent until the
    // enforcing path (2026-09-16).
    expect(unresolved).toEqual([]);
    // Two obligation-free policies would pass the assertion above without resolving anything,
    // so the enforced obligation has to still be there for this oracle to mean something.
    expect(resolved).toBeGreaterThan(0);
  });

  test('every bootstrap nx-target fact names a workspace project whose cwd exists at HEAD', () => {
    const declarations = JSON.parse(
      readFileSync(join(repositoryRoot, 'docs/wiki-policy/relationships.bootstrap.json'), 'utf8'),
    ) as {
      facts: {
        factId: string;
        kind: string;
        project: string;
        expectedConfiguration: { options?: { cwd?: string } };
      }[];
    };
    const targets = declarations.facts.filter(({ kind }) => kind === 'nx-target');
    expect(targets.length).toBeGreaterThan(0);
    const projects = new Set(
      extractNxRelationships(repositoryRoot).relationships.projects.map(({ name }) => name),
    );
    const headPaths = entriesAt(repositoryRoot, 'HEAD').map(({ path }) => path);

    // Proof: pointing `check.core.test` at project `core` — the pre-move name — made this
    // assertion observe `["check.core.test -> core"]` against `[]` (2026-09-16).
    expect(
      targets
        .filter(({ project }) => !projects.has(project))
        .map(({ factId, project }) => `${factId} -> ${project}`),
    ).toEqual([]);
    // Proof: pointing the same fact's `options.cwd` at `libs/core` observed
    // `["check.core.test -> libs/core"]` against `[]` (2026-09-16).
    expect(
      targets
        .filter(({ expectedConfiguration }) => {
          const cwd = expectedConfiguration.options?.cwd;
          return cwd !== undefined && !headPaths.some((path) => underPrefix(cwd, path));
        })
        .map(({ factId, expectedConfiguration }) => {
          const cwd = expectedConfiguration.options?.cwd;
          if (cwd === undefined) throw new Error(`${factId} lost its cwd between filters`);
          return `${factId} -> ${cwd}`;
        }),
    ).toEqual([]);
  }, 60_000);

  test('every bootstrap module declares external consumers that exist at HEAD', () => {
    const bootstrapMapping = JSON.parse(
      readFileSync(join(repositoryRoot, 'docs/wiki-policy/modules.bootstrap.json'), 'utf8'),
    ) as {
      modules: {
        moduleId: string;
        externalConsumers?: { memberships: { prefix?: string; path?: string }[] };
      }[];
    };
    const headPaths = entriesAt(repositoryRoot, 'HEAD').map(({ path }) => path);

    // Proof: rewriting `module.domain.saved-plan`'s consumer prefix `libs/wbs/application/core/src`
    // back to `libs/core/src` made this assertion observe
    // `["module.domain.saved-plan -> libs/core/src"]` against `[]` (2026-09-16).
    expect(
      bootstrapMapping.modules.flatMap(({ moduleId, externalConsumers }) =>
        (externalConsumers?.memberships ?? [])
          .map((membership) => {
            const claimed = membership.prefix ?? membership.path;
            if (claimed === undefined) {
              throw new Error(`external consumer of ${moduleId} names neither prefix nor path`);
            }
            return claimed;
          })
          .filter((claimed) => !headPaths.some((path) => underPrefix(claimed, path)))
          .map((claimed) => `${moduleId} -> ${claimed}`),
      ),
    ).toEqual([]);
  }, 30_000);
});
