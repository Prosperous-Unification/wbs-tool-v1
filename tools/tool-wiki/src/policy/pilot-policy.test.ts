import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { resolveValidatorArtifactPaths } from './trust';

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
  'docs/wiki-policy/policy.json',
  'docs/wiki-policy/relationships.json',
  'libs/core/src/use-cases/README.md',
  'libs/domain/src/saved-plan/README.md',
  'libs/store-memory/src/README.md',
  'openspec/changes/archive/2026-09-08-bounded-replay-sweep/README.md',
  'tools/tool-dagger/src/lib/README.md',
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
  git(repository, ['commit', '--quiet', '--message', 'pilot candidate']);
  return { repository, revision: git(repository, ['rev-parse', 'HEAD']) };
}

function createExternalTrust(candidate: { repository: string; revision: string }): {
  bindingPath: string;
  evidencePath: string;
  policyPath: string;
} {
  const trust = mkdtempSync(join(tmpdir(), 'tool-wiki-pilot-trust-'));
  scratch.push(trust);
  const entries = entriesAt(candidate.repository, candidate.revision);
  const identity = candidateIdentity(candidate.repository, candidate.revision, entries);
  const policyPath = join(trust, 'policy.json');
  cpSync(join(candidate.repository, 'docs/wiki-policy/policy.json'), policyPath);
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
  return { bindingPath, evidencePath, policyPath };
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
      modules.map(({ moduleId }) => moduleId).sort(),
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
