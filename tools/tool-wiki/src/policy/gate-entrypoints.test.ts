import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { resolveValidatorArtifactPaths } from './trust';

const workspace = join(import.meta.dir, '..', '..', '..', '..');
const adapterPath = join(workspace, 'bin', 'tool-wiki-lint.sh');
const gateLibraryPath = join(workspace, 'bin', 'h2puni-gate-lib.sh');
const gateStepsPath = join(workspace, 'bin', 'h2puni-gate-steps.sh');
const trustedCliPath = join(workspace, 'tools', 'tool-wiki', 'src', 'cli.ts');
const scratchPaths: string[] = [];

function streamText(stream: Uint8Array | undefined, subject: string): string {
  if (stream === undefined) throw new Error(`${subject} was unavailable`);
  return Buffer.from(stream).toString('utf8');
}

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
}

function fixture(): {
  directory: string;
  cliPath: string;
  bindingPath: string;
  evidencePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'tool-wiki-entrypoints-'));
  scratchPaths.push(directory);
  const cliPath = join(directory, 'trusted-cli.ts');
  const bindingPath = join(directory, 'binding.json');
  const evidencePath = join(directory, 'evidence.json');
  write(
    cliPath,
    "process.stdout.write(`${JSON.stringify({ argv: process.argv.slice(2), binding: process.env['TOOL_WIKI_CI_TRUSTED_BINDING'] })}\\n`);\n",
  );
  write(bindingPath, '{}\n');
  write(evidencePath, '{}\n');
  return { directory, cliPath, bindingPath, evidencePath };
}

interface RealFixture {
  repository: string;
  revision: string;
  bindingPath: string;
  evidencePath: string;
}

interface ExactEntry {
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
  blob: string;
}

function git(repository: string, ...argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const detail = streamText(invocation.stderr, 'git stderr');
  if (invocation.exitCode !== 0) throw new Error(`git ${argv.join(' ')}: ${detail}`);
  return streamText(invocation.stdout, 'git stdout').trim();
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function entries(repository: string, revision: string): ExactEntry[] {
  const output = git(repository, 'ls-tree', '-r', revision);
  return output.split('\n').map((line) => {
    const match = /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match === null) throw new Error(`malformed fixture tuple: ${line}`);
    const mode = match[1];
    if (mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') {
      throw new Error(`unsupported fixture mode: ${mode}`);
    }
    return { path: match[3], mode, blob: match[2] };
  });
}

function candidateIdentity(
  repository: string,
  revision: string,
  exactEntries: ExactEntry[],
): string {
  return hashCanonical({
    selection: {
      kind: 'committed',
      revision,
      tree: git(repository, 'rev-parse', `${revision}^{tree}`),
    },
    entries: exactEntries,
    untracked: [],
  });
}

function realFixture(): RealFixture {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-entry-candidate-'));
  const trust = mkdtempSync(join(tmpdir(), 'tool-wiki-entry-trust-'));
  scratchPaths.push(repository, trust);
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'entrypoint@example.test');
  git(repository, 'config', 'user.name', 'Entrypoint Fixture');
  const metadata = {
    schemaVersion: 1,
    moduleId: 'module.fixture',
    memberships: [{ kind: 'path', path: 'src/app.ts' }],
    relationshipSelectors: [],
    applicableChecks: [],
    inapplicableSections: [
      { section: 'relationships', reason: 'No declared relationships.' },
      { section: 'invariants', reason: 'No cross-file invariant.' },
      { section: 'checks', reason: 'The trusted lint is the check.' },
    ],
    externalConsumers: { kind: 'none-known', knowledgeLimit: 'Fixture-local knowledge only.' },
  };
  write(
    join(repository, 'README.md'),
    `# Fixture\n\n<!-- wbs-index ${JSON.stringify(metadata)} -->\n`,
  );
  write(join(repository, 'src', 'app.ts'), 'export const value = 1;\n');
  git(repository, 'add', '--all');
  git(repository, 'commit', '--message', 'baseline');
  const revision = git(repository, 'rev-parse', 'HEAD');
  const exactEntries = entries(repository, revision);
  const identity = candidateIdentity(repository, revision, exactEntries);
  const policyPath = join(trust, 'policy.json');
  const authorityPath = join(trust, 'authority.json');
  const evidencePath = join(trust, 'evidence.json');
  const bindingPath = join(trust, 'binding.json');
  const classificationPolicy = {
    schemaVersion: 1,
    policyId: 'classification.entrypoint.v1',
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
      { contentClass: 'source', include: [{ kind: 'suffix', value: '.ts' }], exclude: [] },
      { contentClass: 'test', include: [{ kind: 'name', value: 'fixture.test.ts' }], exclude: [] },
      { contentClass: 'config', include: [{ kind: 'name', value: 'fixture.json' }], exclude: [] },
      { contentClass: 'script', include: [{ kind: 'name', value: 'fixture.sh' }], exclude: [] },
      {
        contentClass: 'migration',
        include: [{ kind: 'segment', value: 'migrations' }],
        exclude: [],
      },
      { contentClass: 'fixture', include: [{ kind: 'segment', value: 'fixtures' }], exclude: [] },
      {
        contentClass: 'generated',
        include: [{ kind: 'segment', value: 'generated' }],
        exclude: [],
      },
      { contentClass: 'vendored', include: [{ kind: 'segment', value: 'vendor' }], exclude: [] },
      { contentClass: 'placeholder', include: [{ kind: 'name', value: '.keep' }], exclude: [] },
      { contentClass: 'document', include: [{ kind: 'suffix', value: '.md' }], exclude: [] },
      { contentClass: 'openspec', include: [{ kind: 'prefix', value: 'openspec' }], exclude: [] },
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
  const appEntry = exactEntries.find(({ path }) => path === 'src/app.ts');
  if (appEntry === undefined) throw new Error('fixture application tuple is absent');
  write(
    policyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyId: 'policy.entrypoint.v1',
      minimumMode: 'enforce',
      classificationPolicy,
      adoptedBoundaryIds: ['boundary.application'],
      activationBoundaryIds: [],
      boundaries: [
        {
          boundaryId: 'boundary.application',
          selector: { kind: 'prefix', value: 'src' },
          baselineEntries: [appEntry],
          obligationIds: ['obligation.application'],
        },
      ],
      obligations: [
        {
          obligationId: 'obligation.application',
          boundaryId: 'boundary.application',
          checkIds: [],
          reviewIds: [],
        },
      ],
      exemptions: [],
    })}\n`,
  );
  const content = exactEntries.map((entry, index) => ({
    kind: 'content',
    inputId: `content.${String(index)}`,
    ...entry,
  }));
  write(
    authorityPath,
    `${JSON.stringify({
      schemaVersion: 1,
      authorityId: 'authority.entrypoint.v1',
      obligationRequest: {
        reviewed: {
          sourceBase: revision,
          candidateIdentity: identity,
          inputs: { content, structural: [], semantic: [], topology: [] },
        },
        current: {
          sourceBase: revision,
          candidateIdentity: identity,
          inputs: { content, structural: [], semantic: [], topology: [] },
        },
        judgments: [],
        policy: { policyId: 'policy.entrypoint.v1', behaviorRules: [] },
        impactClassifications: [],
        writerLabels: [],
        checks: [],
        reviews: [],
      },
      checkReceipts: [],
      audit: {
        schemaVersion: 1,
        auditId: 'audit.entrypoint.v1',
        sourceBase: revision,
        candidateIdentity: identity,
        generation: 1,
        seed: 'seed.entrypoint',
        coverage: 'exhaustive',
        strata: [],
        obligations: [],
        mode: 'enforce',
        claimedCoverage: 'exhaustive',
        reviews: [],
        corrections: [],
        closures: [],
        adjudications: [],
      },
    })}\n`,
  );
  write(
    evidencePath,
    `${JSON.stringify({
      schemaVersion: 1,
      reportMode: 'enforce',
      obligations: [{ obligationId: 'obligation.application', checkIds: [], reviewIds: [] }],
    })}\n`,
  );
  const validatorArtifacts = resolveValidatorArtifactPaths([trustedCliPath]).map((path) => ({
    path,
    sha256: sha256(readFileSync(path)),
  }));
  write(
    bindingPath,
    `${JSON.stringify({
      schemaVersion: 1,
      bindingId: 'binding.entrypoint.v1',
      trustScope: 'ci',
      policy: { path: policyPath, sha256: sha256(readFileSync(policyPath)) },
      authority: {
        authorityId: 'authority.entrypoint.v1',
        journalId: 'journal.entrypoint.v1',
        trustScope: 'external-verifier',
        artifact: { path: authorityPath, sha256: sha256(readFileSync(authorityPath)) },
      },
      validator: { validatorId: 'validator.entrypoint.v1', artifacts: validatorArtifacts },
    })}\n`,
  );
  return { repository, revision, bindingPath, evidencePath };
}

function runRealAdapter(
  selection: 'working' | 'staged' | 'committed',
  fixturePaths: RealFixture,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    ['bash', adapterPath, selection, fixturePaths.repository, fixturePaths.revision],
    {
      env: {
        ...process.env,
        TOOL_WIKI_TRUSTED_CLI: realpathSync(trustedCliPath),
        TOOL_WIKI_LOCAL_TRUSTED_BINDING: fixturePaths.bindingPath,
        TOOL_WIKI_CI_TRUSTED_BINDING: fixturePaths.bindingPath,
        TOOL_WIKI_LINT_EVIDENCE: fixturePaths.evidencePath,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
}

function runAdapter(
  selection: 'working' | 'staged' | 'committed',
  paths: ReturnType<typeof fixture>,
  omitEnvironment?: string,
  overrides: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  const environment = Object.fromEntries(
    Object.entries({
      PATH: process.env['PATH'] ?? '',
      TOOL_WIKI_TRUSTED_CLI: paths.cliPath,
      TOOL_WIKI_LOCAL_TRUSTED_BINDING: paths.bindingPath,
      TOOL_WIKI_CI_TRUSTED_BINDING: paths.bindingPath,
      TOOL_WIKI_LINT_EVIDENCE: paths.evidencePath,
      ...overrides,
    }).filter(([name]) => name !== omitEnvironment),
  );
  return Bun.spawnSync(['bash', adapterPath, selection, '/candidate', 'abc123'], {
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('tool-wiki production entrypoint adapter', () => {
  test.each([
    ['working', ['lint-local', 'observe', 'working', '/candidate', 'abc123']],
    ['staged', ['lint-local', 'ratchet', 'staged', '/candidate', 'abc123']],
    ['committed', ['lint-ci', 'committed', '/candidate', 'abc123']],
  ] as const)('%s selects its explicit production CLI route', (selection, expected) => {
    const paths = fixture();
    const invocation = runAdapter(selection, paths);
    const output = streamText(invocation.stdout, 'adapter stdout');

    expect(invocation.exitCode, streamText(invocation.stderr, 'adapter stderr')).toBe(0);
    const route =
      selection === 'committed'
        ? [...expected, paths.evidencePath]
        : [...expected, paths.bindingPath, paths.evidencePath];
    expect(JSON.parse(output)).toMatchObject({ argv: route });
  });

  test.each([
    ['working', 'TOOL_WIKI_TRUSTED_CLI'],
    ['working', 'TOOL_WIKI_LINT_EVIDENCE'],
    ['staged', 'TOOL_WIKI_LOCAL_TRUSTED_BINDING'],
    ['committed', 'TOOL_WIKI_CI_TRUSTED_BINDING'],
  ] as const)('%s refuses absent external %s authority', (selection, variable) => {
    const paths = fixture();
    const invocation = runAdapter(selection, paths, variable);
    const output = streamText(invocation.stderr, 'adapter stderr');

    expect(invocation.exitCode).not.toBe(0);
    expect(output).toContain(variable);
  });

  test('candidate-local trust variables cannot replace the committed CI binding', () => {
    const paths = fixture();
    const invocation = runAdapter('committed', paths, undefined, {
      TOOL_WIKI_LOCAL_TRUSTED_BINDING: '/candidate/docs/wiki-policy/binding.json',
    });
    const output = streamText(invocation.stdout, 'adapter stdout');

    expect(invocation.exitCode, streamText(invocation.stderr, 'adapter stderr')).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      argv: ['lint-ci', 'committed', '/candidate', 'abc123', paths.evidencePath],
      binding: paths.bindingPath,
    });
    expect(output).not.toContain('/candidate/docs/wiki-policy/binding.json');
  });

  test('Nx, host gate, CI and lefthook select the whole tree without caching', () => {
    const project = JSON.parse(
      readFileSync(join(workspace, 'tools', 'tool-wiki', 'project.json'), 'utf8'),
    ) as {
      targets: Partial<
        Record<string, { cache?: boolean; inputs?: string[]; options?: { command?: string } }>
      >;
    };
    const hostGate = readFileSync(join(workspace, 'bin', 'h2puni-gate.sh'), 'utf8');
    const hostSteps = readFileSync(join(workspace, 'bin', 'h2puni-gate-steps.sh'), 'utf8');
    const ci = readFileSync(join(workspace, '.github', 'workflows', 'ci.yml'), 'utf8');
    const lefthook = readFileSync(join(workspace, 'lefthook.yml'), 'utf8');
    const workspacePackage = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    // Proof: changing cache to true while narrowing inputs to `{projectRoot}/**/*` failed here
    // with the received cache/input pair printed beside these exact whole-tree expectations.
    expect(project.targets['lint']).toMatchObject({
      cache: false,
      inputs: ['{workspaceRoot}/**/*'],
      options: { command: 'bash bin/tool-wiki-lint.sh working . HEAD' },
    });
    expect(project.targets['lint:source']?.options?.command).toBe(
      'bunx eslint tools/tool-wiki/src',
    );
    expect(hostGate).toContain('bash "$repo_root/bin/h2puni-gate-steps.sh" "$repo_root" HEAD');
    expect(ci).toContain('bash bin/tool-wiki-lint.sh committed . "$GITHUB_SHA"');
    expect(lefthook).toContain('run: bash bin/tool-wiki-lint.sh staged . HEAD');
    expect(hostSteps).toContain('--exclude=tool-wiki');
    expect(hostSteps).toContain('bunx nx run tool-wiki:lint:source --skip-nx-cache');
    expect(ci).toContain('--exclude=tool-wiki');
    expect(ci).toContain('bunx nx run tool-wiki:lint:source --skip-nx-cache');
    expect(workspacePackage.scripts['lint']).toBe(
      'nx run-many -t lint --exclude=tool-wiki && nx run tool-wiki:lint:source',
    );
  });

  test('committed entrypoint certifies the exact external-trust fixture', () => {
    const paths = realFixture();
    const invocation = runRealAdapter('committed', paths);
    const output = streamText(invocation.stdout, 'lint stdout');

    expect(invocation.exitCode, streamText(invocation.stderr, 'lint stderr')).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      accepted: true,
      certified: true,
      candidateSelection: { kind: 'committed', revision: paths.revision },
    });
  });

  test.each(['staged', 'committed'] as const)(
    '%s whole-tree lint finds a deletion through the unchanged reverse index',
    (selection) => {
      const paths = realFixture();
      git(paths.repository, 'rm', 'src/app.ts');
      if (selection === 'committed') {
        git(paths.repository, 'commit', '--message', 'delete indexed target');
        paths.revision = git(paths.repository, 'rev-parse', 'HEAD');
      }

      const invocation = runRealAdapter(selection, paths);
      const output = `${streamText(invocation.stdout, 'lint stdout')}${streamText(
        invocation.stderr,
        'lint stderr',
      )}`;
      expect(invocation.exitCode).toBe(1);
      expect(output).toContain('membership target absent: src/app.ts');
    },
  );

  test('working whole-tree lint reports untracked content instead of narrowing to tracked paths', () => {
    const paths = realFixture();
    write(join(paths.repository, 'src', 'untracked.ts'), 'export const untracked = true;\n');

    const invocation = runRealAdapter('working', paths);
    const output = `${streamText(invocation.stdout, 'lint stdout')}${streamText(
      invocation.stderr,
      'lint stderr',
    )}`;
    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('untracked.ts');
  });

  test('committed entrypoint refuses a stale enforced blob at wiki lint', () => {
    const paths = realFixture();
    write(join(paths.repository, 'src', 'app.ts'), 'export const value = 2;\n');
    git(paths.repository, 'add', 'src/app.ts');
    git(paths.repository, 'commit', '--message', 'stale application review');
    paths.revision = git(paths.repository, 'rev-parse', 'HEAD');

    const invocation = runRealAdapter('committed', paths);
    const output = streamText(invocation.stdout, 'lint stdout');
    expect(invocation.exitCode, streamText(invocation.stderr, 'lint stderr')).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      accepted: false,
      unmetObligationIds: ['obligation.application'],
      changedBoundaryIds: ['boundary.application'],
    });
  });

  test('the host gate fails specifically at wiki lint for a stale enforced blob', () => {
    const paths = realFixture();
    write(join(paths.repository, 'src', 'app.ts'), 'export const value = 2;\n');
    git(paths.repository, 'add', 'src/app.ts');
    git(paths.repository, 'commit', '--message', 'stale host candidate');
    paths.revision = git(paths.repository, 'rev-parse', 'HEAD');
    const lock = join(dirname(paths.bindingPath), 'host-lock');
    const command = 'source "$1"; shift; gate_with_pinned_head "$@"';
    const invocation = Bun.spawnSync(
      [
        'bash',
        '-c',
        command,
        'tool-wiki-host-gate-test',
        gateLibraryPath,
        paths.repository,
        lock,
        paths.revision,
        '--',
        'bash',
        gateStepsPath,
        paths.repository,
        'HEAD',
      ],
      {
        env: {
          ...process.env,
          HEAVY_LOCK_WAIT_SECONDS: '0',
          TOOL_WIKI_TRUSTED_CLI: realpathSync(trustedCliPath),
          TOOL_WIKI_CI_TRUSTED_BINDING: paths.bindingPath,
          TOOL_WIKI_LINT_EVIDENCE: paths.evidencePath,
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const output = `${streamText(invocation.stdout, 'host stdout')}${streamText(
      invocation.stderr,
      'host stderr',
    )}`;

    expect(invocation.exitCode, output).toBe(1);
    expect(output).toContain('"unmetObligationIds":["obligation.application"]');
    expect(output).not.toContain('Successfully ran');
  });

  test('the future cache fault mutates a whole-tree input after warming and must rerun', () => {
    const paths = realFixture();
    const warm = runRealAdapter('committed', paths);
    expect(warm.exitCode, streamText(warm.stderr, 'warm stderr')).toBe(0);

    write(join(paths.repository, 'src', 'app.ts'), 'export const omittedInputFault = true;\n');
    git(paths.repository, 'add', 'src/app.ts');
    git(paths.repository, 'commit', '--message', 'mutate would-be omitted input');
    paths.revision = git(paths.repository, 'rev-parse', 'HEAD');
    const afterMutation = runRealAdapter('committed', paths);
    const output = streamText(afterMutation.stdout, 'mutated stdout');

    // This fixture remains beside the cache:false assertion above so enabling cache while
    // narrowing inputs cannot turn a warmed verdict into acceptance of this changed blob.
    expect(afterMutation.exitCode, streamText(afterMutation.stderr, 'mutated stderr')).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      changedBoundaryIds: ['boundary.application'],
      unmetObligationIds: ['obligation.application'],
    });
  });
});
