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
import { loadTrustedPolicy, resolveValidatorArtifactPaths } from './trust';

interface ExactTuple {
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
  blob: string;
}

const repositoryRoot = resolve(import.meta.dir, '../../../..');
const cliPath = join(import.meta.dir, '..', 'cli.ts');
const pilotPaths = [
  'docs/refactoring/w4-4/README.md',
  'docs/wiki-policy/modules.json',
  'docs/wiki-policy/modules.bootstrap.json',
  'docs/wiki-policy/policy.json',
  'docs/wiki-policy/bootstrap-policy.json',
  'docs/wiki-policy/relationships.json',
  'docs/wiki-policy/relationships.bootstrap.json',
  'libs/core/src/use-cases/README.md',
  'libs/domain/src/saved-plan/README.md',
  'libs/store-memory/src/README.md',
  'openspec/changes/archive/2026-09-08-bounded-replay-sweep/README.md',
  'tools/tool-dagger/src/lib/README.md',
  'tools/tool-wiki/README.md',
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
            'check.tool-wiki.test',
            'check.tool-wiki.lint-source',
            'check.tool-wiki.typecheck',
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
      boundaries: { selector: { value: string }; baselineEntries: ExactTuple[] }[];
    };
    expect(policy.pilot).toMatchObject({
      sourceRevision: '7851161bf96312750d07b933ca5d42b75ce575c7',
      coverage: 'selected-boundaries-only',
    });
    expect(policy.pilot.exclusions.length).toBeGreaterThan(0);
    const baseline = entriesAt(repositoryRoot, policy.pilot.sourceRevision);
    for (const boundary of policy.boundaries) {
      expect(boundary.baselineEntries).toEqual(
        baseline.filter(
          ({ path }) =>
            path === boundary.selector.value || path.startsWith(`${boundary.selector.value}/`),
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
    const readme = join(candidate.repository, 'libs/domain/src/saved-plan/README.md');
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
    // `unindexed candidate path in libs/domain/src/saved-plan/README.md: ...`.
    expect(observed).toContain(
      'unindexed candidate path in libs/domain/src/saved-plan/README.md: libs/domain/src/saved-plan/canonical-plan-input.ts',
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
    // `docs/findings/README.md: check.tool-wiki.test (external-consumer)`.
    expect(observed).toContain(
      'applicable check has no executable authority in docs/findings/README.md: check.tool-wiki.test (external-consumer)',
    );
  }, 120_000);

  test('refuses an owned README declared as its own external consumer', () => {
    const candidate = createCandidate();
    const readme = join(candidate.repository, 'libs/domain/src/saved-plan/README.md');
    const source = readFileSync(readme, 'utf8');
    const block = /<!-- wbs-index ([\s\S]+) -->/.exec(source);
    if (block === null) throw new Error('saved-plan index metadata absent');
    const metadata = JSON.parse(block[1]) as Record<string, unknown>;
    metadata['externalConsumers'] = {
      kind: 'declared',
      memberships: [{ kind: 'path', path: 'libs/domain/src/saved-plan/README.md' }],
      knowledgeLimit: 'The boundary index is not an external consumer.',
    };
    write(readme, source.replace(block[0], `<!-- wbs-index ${JSON.stringify(metadata)} -->`));
    git(candidate.repository, ['add', readme]);
    git(candidate.repository, ['commit', '--quiet', '--message', 'claim owned README as consumer']);
    candidate.revision = git(candidate.repository, ['rev-parse', 'HEAD']);
    const trust = createExternalTrust(candidate);

    const invocation = lint(candidate, trust);
    const observed = output(invocation);
    expect(invocation.exitCode, observed).toBe(1);
    // Proof: naming the saved-plan README as its own consumer failed at this ownership assertion.
    expect(observed).toContain(
      'external consumer is owned by libs/domain/src/saved-plan/README.md: libs/domain/src/saved-plan/README.md',
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
    const readme = join(candidate.repository, 'libs/domain/src/saved-plan/README.md');
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
      'pilot module index absent for module.domain.saved-plan: libs/domain/src/saved-plan/README.md',
    );
  }, 120_000);

  test('refuses externally pinned module and ownership claims that disagree with indexes', () => {
    const mutations = [
      {
        name: 'change mapped module identity',
        mutate(module: { moduleId: string; memberships: unknown[] }): void {
          module.moduleId = 'module.domain.saved-plan.renamed';
        },
        expected:
          'pilot module identity disagrees with index libs/domain/src/saved-plan/README.md: module.domain.saved-plan.renamed != module.domain.saved-plan',
      },
      {
        name: 'change mapped ownership',
        mutate(module: { moduleId: string; memberships: unknown[] }): void {
          module.memberships = [
            {
              kind: 'directory-prefix',
              prefix: 'libs/core/src/use-cases',
              exclusions: [],
            },
          ];
        },
        expected:
          'pilot module ownership disagrees with index libs/domain/src/saved-plan/README.md: module.domain.saved-plan',
      },
    ];
    for (const mutation of mutations) {
      const candidate = createCandidate();
      const mappingPath = join(candidate.repository, 'docs/wiki-policy/modules.json');
      const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as {
        modules: { moduleId: string; memberships: unknown[] }[];
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
      'pilot module external consumers disagree with index libs/domain/src/saved-plan/README.md: module.domain.saved-plan',
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
      'pilot index has no module mapping: libs/domain/src/saved-plan/README.md',
    );
  }, 120_000);

  test('refuses an empty or selector-escaping pre-index tuple manifest', () => {
    const mutations = [
      {
        mutate(boundary: { baselineEntries: ExactTuple[] }): void {
          boundary.baselineEntries = [];
        },
        expected: 'trusted boundary baseline is empty: boundary.domain.saved-plan',
      },
      {
        mutate(boundary: { baselineEntries: ExactTuple[] }): void {
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
        boundaries: { boundaryId: string; baselineEntries: ExactTuple[] }[];
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
