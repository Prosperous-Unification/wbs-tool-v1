import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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

const workspace = join(import.meta.dir, '..', '..', '..', '..');
const adapterPath = join(workspace, 'bin', 'tool-wiki-lint.sh');
const gateLibraryPath = join(workspace, 'bin', 'h2puni-gate-lib.sh');
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
  repository: string;
  activationRoot: string;
  cliPath: string;
  bindingPath: string;
  evidencePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'tool-wiki-entrypoints-'));
  scratchPaths.push(directory);
  const repository = join(directory, 'candidate');
  const activationRoot = join(directory, 'activation');
  const cliPath = join(directory, 'validator', 'trusted-cli.ts');
  const bindingPath = join(directory, 'trust', 'binding.json');
  const evidencePath = join(directory, 'trust', 'evidence.json');
  mkdirSync(repository);
  write(
    cliPath,
    "process.stdout.write(`${JSON.stringify({ argv: process.argv.slice(2), binding: process.env['TOOL_WIKI_CI_TRUSTED_BINDING'] })}\\n`);\n",
  );
  write(
    bindingPath,
    `${JSON.stringify({ validator: { artifacts: [{ path: cliPath, sha256: sha256(readFileSync(cliPath)) }] } })}\n`,
  );
  write(evidencePath, '{}\n');
  write(join(activationRoot, 'active-v1'), 'tool-wiki-active-v1\n');
  write(join(activationRoot, 'validator-path'), `${cliPath}\n`);
  write(
    join(activationRoot, 'snapshotter-path'),
    `${join(workspace, 'tools', 'tool-wiki', 'src', 'policy', 'snapshot-validator.ts')}\n`,
  );
  write(join(activationRoot, 'local-binding-path'), `${bindingPath}\n`);
  write(join(activationRoot, 'ci-binding-path'), `${bindingPath}\n`);
  write(join(activationRoot, 'evidence-path'), `${evidencePath}\n`);
  return { directory, repository, activationRoot, cliPath, bindingPath, evidencePath };
}

interface RealFixture {
  repository: string;
  revision: string;
  activationRoot: string;
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
    memberships: [
      { kind: 'path', path: 'src/app.ts' },
      { kind: 'path', path: 'bin/tool-wiki-lint.sh' },
      { kind: 'path', path: 'bin/h2puni-gate-steps.sh' },
    ],
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
  write(join(repository, 'bin', 'tool-wiki-lint.sh'), '#!/usr/bin/env bash\nexit 1\n');
  write(join(repository, 'bin', 'h2puni-gate-steps.sh'), '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(join(repository, 'bin', 'tool-wiki-lint.sh'), 0o755);
  chmodSync(join(repository, 'bin', 'h2puni-gate-steps.sh'), 0o755);
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
      { contentClass: 'script', include: [{ kind: 'suffix', value: '.sh' }], exclude: [] },
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
  write(join(trust, 'active-v1'), 'tool-wiki-active-v1\n');
  write(join(trust, 'validator-path'), `${realpathSync(trustedCliPath)}\n`);
  write(
    join(trust, 'snapshotter-path'),
    `${join(workspace, 'tools', 'tool-wiki', 'src', 'policy', 'snapshot-validator.ts')}\n`,
  );
  write(join(trust, 'local-binding-path'), `${bindingPath}\n`);
  write(join(trust, 'ci-binding-path'), `${bindingPath}\n`);
  write(join(trust, 'evidence-path'), `${evidencePath}\n`);
  return { repository, revision, activationRoot: trust, bindingPath, evidencePath };
}

function runRealAdapter(
  selection: 'working' | 'staged' | 'committed',
  fixturePaths: RealFixture,
  environment: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    ['bash', adapterPath, selection, fixturePaths.repository, fixturePaths.revision],
    {
      env: {
        ...process.env,
        TOOL_WIKI_ACTIVATION_ROOT: fixturePaths.activationRoot,
        ...environment,
      },
      cwd: fixturePaths.repository,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
}

function runNxLint(
  fixturePaths: RealFixture,
  nxWorkspace = workspace,
): ReturnType<typeof Bun.spawnSync> {
  const command = `bash ${adapterPath} committed ${fixturePaths.repository} HEAD`;
  return Bun.spawnSync(
    [
      join(workspace, 'node_modules', '.bin', 'nx'),
      'run',
      'tool-wiki:lint',
      `--command=${command}`,
      '--output-style=stream',
    ],
    {
      cwd: nxWorkspace,
      env: {
        ...process.env,
        NX_DAEMON: 'false',
        TOOL_WIKI_ACTIVATION_ROOT: fixturePaths.activationRoot,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
}

function nxFixture(cache: boolean, inputs: string[]): string {
  const nxWorkspace = mkdtempSync(join(tmpdir(), 'tool-wiki-nx-target-'));
  scratchPaths.push(nxWorkspace);
  write(join(nxWorkspace, 'package.json'), '{"name":"nx-target","private":true}\n');
  write(join(nxWorkspace, 'nx.json'), '{"plugins":[]}\n');
  write(join(nxWorkspace, 'sentinel.txt'), 'unchanged Nx input\n');
  write(
    join(nxWorkspace, 'project.json'),
    `${JSON.stringify({
      name: 'tool-wiki',
      root: '.',
      targets: {
        lint: {
          executor: 'nx:run-commands',
          cache,
          inputs,
          options: { command: 'false' },
        },
      },
    })}\n`,
  );
  symlinkSync(join(workspace, 'node_modules'), join(nxWorkspace, 'node_modules'), 'dir');
  return nxWorkspace;
}

function runAdapter(
  selection: 'working' | 'staged' | 'committed',
  paths: ReturnType<typeof fixture>,
  overrides: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  const environment = Object.fromEntries(
    Object.entries({
      PATH: process.env['PATH'] ?? '',
      TOOL_WIKI_ACTIVATION_ROOT: paths.activationRoot,
      ...overrides,
    }),
  );
  return Bun.spawnSync(['bash', adapterPath, selection, paths.repository, 'abc123'], {
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
    ['working', ['lint-local', 'observe', 'working']],
    ['staged', ['lint-local', 'ratchet', 'staged']],
    ['committed', ['lint-ci', 'committed']],
  ] as const)('%s selects its explicit production CLI route', (selection, expected) => {
    const paths = fixture();
    const invocation = runAdapter(selection, paths);
    const output = streamText(invocation.stdout, 'adapter stdout');

    expect(invocation.exitCode, streamText(invocation.stderr, 'adapter stderr')).toBe(0);
    const routePrefix = [...expected, realpathSync(paths.repository), 'abc123'];
    const route =
      selection === 'committed'
        ? [...routePrefix, paths.evidencePath]
        : [...routePrefix, paths.bindingPath, paths.evidencePath];
    expect(JSON.parse(output)).toMatchObject({ argv: route });
  });

  test('an absent external activation root reports a visible non-certifying rollout state', () => {
    const paths = fixture();
    const invocation = Bun.spawnSync(['bash', adapterPath, 'staged', paths.repository, 'HEAD'], {
      env: { PATH: process.env['PATH'] ?? '' },
      stderr: 'pipe',
      stdout: 'pipe',
    });

    expect(invocation.exitCode, streamText(invocation.stderr, 'adapter stderr')).toBe(0);
    expect(JSON.parse(streamText(invocation.stdout, 'adapter stdout'))).toMatchObject({
      status: 'inactive',
      certified: false,
    });
  });

  test('an absent external activation marker reports a visible non-certifying rollout state', () => {
    const paths = fixture();
    rmSync(join(paths.activationRoot, 'active-v1'));
    const invocation = runAdapter('staged', paths);

    expect(invocation.exitCode, streamText(invocation.stderr, 'adapter stderr')).toBe(0);
    expect(JSON.parse(streamText(invocation.stdout, 'adapter stdout'))).toMatchObject({
      status: 'inactive',
      certified: false,
    });
  });

  test.each([
    ['active-v1', 'committed', 'malformed'],
    ['validator-path', 'committed', 'missing'],
    ['validator-path', 'committed', 'malformed'],
    ['ci-binding-path', 'committed', 'missing'],
    ['ci-binding-path', 'committed', 'malformed'],
    ['local-binding-path', 'staged', 'missing'],
    ['local-binding-path', 'staged', 'malformed'],
    ['evidence-path', 'committed', 'missing'],
    ['evidence-path', 'committed', 'malformed'],
    ['snapshotter-path', 'committed', 'missing'],
    ['snapshotter-path', 'committed', 'malformed'],
  ] as const)(
    'an active rollout refuses a %s artifact for %s selection that is %s',
    (artifact, selection, state) => {
      const paths = fixture();
      const artifactPath = join(paths.activationRoot, artifact);
      if (state === 'missing') rmSync(artifactPath);
      else write(artifactPath, artifact === 'active-v1' ? 'wrong\n' : 'relative\n');
      const invocation = runAdapter(selection, paths);

      expect(invocation.exitCode).not.toBe(0);
      expect(streamText(invocation.stderr, 'adapter stderr')).toContain(
        artifact === 'active-v1' ? 'rollout marker' : 'active rollout',
      );
    },
  );

  test('candidate-local activation state cannot select committed authority', () => {
    const paths = fixture();
    const candidateActivation = join(paths.repository, '.activation');
    write(join(candidateActivation, 'active-v1'), 'tool-wiki-active-v1\n');
    const invocation = runAdapter('committed', paths, {
      TOOL_WIKI_ACTIVATION_ROOT: candidateActivation,
    });

    expect(invocation.exitCode).not.toBe(0);
    expect(streamText(invocation.stderr, 'adapter stderr')).toContain(
      'activation root must be outside',
    );
  });

  test('an external validator-path symlink into the candidate is refused before execution', () => {
    const paths = fixture();
    const marker = join(paths.directory, 'candidate-validator-ran');
    const candidateCli = join(paths.repository, 'candidate-cli.ts');
    const validatorLink = join(paths.directory, 'validator-link.ts');
    write(candidateCli, `await Bun.write(${JSON.stringify(marker)}, 'ran\\n');\n`);
    symlinkSync(candidateCli, validatorLink);
    write(join(paths.activationRoot, 'validator-path'), `${validatorLink}\n`);

    const invocation = runAdapter('committed', paths);

    expect(invocation.exitCode).not.toBe(0);
    expect(streamText(invocation.stderr, 'adapter stderr')).toContain('validator must be outside');
    expect(existsSync(marker)).toBe(false);
  });

  test('validator execution uses its complete snapshot after the reviewed original is swapped', () => {
    const paths = fixture();
    const marker = join(paths.directory, 'swapped-validator-ran');
    const candidateCli = join(paths.repository, 'candidate-cli.ts');
    const wrapperDirectory = join(paths.directory, 'bun-wrapper');
    const wrapperPath = join(wrapperDirectory, 'bun');
    const swapMarker = join(paths.directory, 'snapshot-finished');
    write(candidateCli, `await Bun.write(${JSON.stringify(marker)}, 'ran\\n');\n`);
    write(
      wrapperPath,
      `#!/usr/bin/env bash
set -euo pipefail
real_bun=${JSON.stringify(realpathSync(Bun.which('bun') ?? ''))}
if [[ "$*" == *snapshot-validator.ts* ]]; then
  "$real_bun" "$@"
  status=$?
  mv ${JSON.stringify(paths.cliPath)} ${JSON.stringify(`${paths.cliPath}.reviewed`)}
  ln -s ${JSON.stringify(candidateCli)} ${JSON.stringify(paths.cliPath)}
  printf ready > ${JSON.stringify(swapMarker)}
  exit "$status"
fi
if [[ ! -e ${JSON.stringify(swapMarker)} ]]; then
  mv ${JSON.stringify(paths.cliPath)} ${JSON.stringify(`${paths.cliPath}.reviewed`)}
  ln -s ${JSON.stringify(candidateCli)} ${JSON.stringify(paths.cliPath)}
fi
exec "$real_bun" "$@"
`,
    );
    chmodSync(wrapperPath, 0o755);

    const invocation = runAdapter('committed', paths, {
      PATH: `${wrapperDirectory}:${process.env['PATH'] ?? ''}`,
    });

    expect(invocation.exitCode, streamText(invocation.stderr, 'adapter stderr')).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(swapMarker)).toBe(true);
    const output = JSON.parse(streamText(invocation.stdout, 'adapter stdout')) as {
      argv: string[];
    };
    expect(output.argv.slice(0, 2)).toEqual(['lint-ci', 'committed']);
  });

  test('the snapshot refuses a binding that omits an executed validator dependency', () => {
    const paths = fixture();
    const marker = join(paths.directory, 'omitted-dependency-ran');
    const dependency = join(dirname(paths.cliPath), 'dependency.ts');
    write(dependency, `await Bun.write(${JSON.stringify(marker)}, 'ran\\n');\n`);
    write(
      paths.cliPath,
      `import './dependency';\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n`,
    );
    write(
      paths.bindingPath,
      `${JSON.stringify({ validator: { artifacts: [{ path: paths.cliPath, sha256: sha256(readFileSync(paths.cliPath)) }] } })}\n`,
    );

    const invocation = runAdapter('committed', paths);

    expect(invocation.exitCode).not.toBe(0);
    expect(streamText(invocation.stderr, 'adapter stderr')).toContain(
      'binding artifacts do not match the complete validator closure',
    );
    expect(existsSync(marker)).toBe(false);
  });

  test('trusted Bun ignores a candidate-cwd bunfig preload and inherited execution variables', () => {
    const paths = realFixture();
    const marker = join(paths.repository, '..candidate-preload-ran');
    write(join(paths.repository, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    write(
      join(paths.repository, 'preload.ts'),
      "await Bun.write(process.env['BUN_PRELOAD_MARKER'] ?? 'missing-marker', 'candidate ran\\n');\n",
    );

    const invocation = runRealAdapter('committed', paths, {
      BUN_PRELOAD_MARKER: marker,
      NODE_OPTIONS: '--require=./preload.ts',
    });

    expect(invocation.exitCode, streamText(invocation.stderr, 'lint stderr')).toBe(0);
    expect(existsSync(marker)).toBe(false);
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
    const trustedCi = readFileSync(
      join(workspace, '.github', 'workflows', 'trusted-wiki.yml'),
      'utf8',
    );
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
    expect(hostGate).not.toContain('cp "$repo_root/bin/tool-wiki-lint.sh"');
    expect(hostGate).toContain('launcher_descriptor="$activation_root/launcher-path"');
    expect(hostGate).toContain('if [[ -n "$1" ]]; then bash "$1" committed');
    expect(ci).toContain('bash bin/tool-wiki-lint.sh committed . "$GITHUB_SHA"');
    expect(ci).toContain("github.event_name == 'push'");
    expect(ci).toContain('diagnostic/non-certifying');
    expect(ci).toContain('bash "$launcher" committed . "$GITHUB_SHA"');
    expect(trustedCi).toContain('pull_request_target:');
    expect(trustedCi).toContain('permissions:\n  contents: read');
    expect(trustedCi.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(trustedCi).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(trustedCi).toContain('$RUNNER_TEMP/tool-wiki-lint.sh');
    expect(trustedCi).not.toContain('candidate/bin/');
    expect(trustedCi).not.toContain('h2puni-gate-steps.sh');
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
    git(paths.repository, 'add', '--all');
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
    const trustedCheckout = paths.revision;
    write(join(paths.repository, 'src', 'app.ts'), 'export const value = 2;\n');
    const candidateAdapter = join(paths.repository, 'bin', 'tool-wiki-lint.sh');
    const candidateSteps = join(paths.repository, 'bin', 'h2puni-gate-steps.sh');
    const suppressedMarker = join(dirname(paths.bindingPath), 'candidate-step-ran');
    write(candidateAdapter, '#!/usr/bin/env bash\nexit 0\n');
    write(
      candidateSteps,
      `#!/usr/bin/env bash\nprintf ran > ${JSON.stringify(suppressedMarker)}\n`,
    );
    chmodSync(candidateAdapter, 0o755);
    chmodSync(candidateSteps, 0o755);
    git(paths.repository, 'add', '--all');
    git(paths.repository, 'commit', '--message', 'stale host candidate');
    paths.revision = git(paths.repository, 'rev-parse', 'HEAD');
    git(paths.repository, 'checkout', '--detach', '--quiet', trustedCheckout);
    const lock = join(dirname(paths.bindingPath), 'host-lock');
    const command =
      'source "$1"; gate_with_pinned_head "$2" "$3" "$4" -- bash -c \'set -euo pipefail; bash "$1" committed "$2" "$3"; exec bash "$4" "$2" "$3"\' pinned "$5" "$2" HEAD "$2/bin/h2puni-gate-steps.sh"';
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
        adapterPath,
      ],
      {
        env: {
          ...process.env,
          HEAVY_LOCK_WAIT_SECONDS: '0',
          TOOL_WIKI_ACTIVATION_ROOT: paths.activationRoot,
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
    expect(existsSync(suppressedMarker)).toBe(false);
    expect(git(paths.repository, 'rev-parse', 'HEAD')).toBe(trustedCheckout);

    const secondInvocation = Bun.spawnSync(
      [
        'bash',
        '-c',
        command,
        'tool-wiki-host-gate-test',
        gateLibraryPath,
        paths.repository,
        lock,
        paths.revision,
        adapterPath,
      ],
      {
        env: {
          ...process.env,
          HEAVY_LOCK_WAIT_SECONDS: '0',
          TOOL_WIKI_ACTIVATION_ROOT: paths.activationRoot,
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    expect(secondInvocation.exitCode).toBe(1);
    expect(git(paths.repository, 'rev-parse', 'HEAD')).toBe(trustedCheckout);
    expect(existsSync(suppressedMarker)).toBe(false);
  });

  test('the real Nx target reruns an omitted-input mutation and a controlled cache fault does not', () => {
    const paths = realFixture();
    if (process.env['NX_TASK_TARGET_PROJECT'] !== undefined) {
      expect(runRealAdapter('committed', paths).exitCode).toBe(0);
      write(join(paths.repository, 'src', 'app.ts'), 'export const nestedNxFault = true;\n');
      git(paths.repository, 'add', 'src/app.ts');
      git(paths.repository, 'commit', '--message', 'nested Nx direct oracle');
      paths.revision = git(paths.repository, 'rev-parse', 'HEAD');
      expect(runRealAdapter('committed', paths).exitCode).toBe(1);
      return;
    }
    const warm = runNxLint(paths);
    expect(
      warm.exitCode,
      `${streamText(warm.stdout, 'warm stdout')}${streamText(warm.stderr, 'warm stderr')}`,
    ).toBe(0);

    write(join(paths.repository, 'src', 'app.ts'), 'export const omittedInputFault = true;\n');
    git(paths.repository, 'add', 'src/app.ts');
    git(paths.repository, 'commit', '--message', 'mutate would-be omitted input');
    paths.revision = git(paths.repository, 'rev-parse', 'HEAD');
    const afterMutation = runNxLint(paths);
    // Proof: the production tool-wiki:lint target reran and failed on obligation.application;
    // the cache-enabled target below returned its warmed success for this same omitted mutation.
    expect(afterMutation.exitCode, streamText(afterMutation.stderr, 'mutated stderr')).toBe(1);

    const cachedPaths = realFixture();
    const nxWorkspace = nxFixture(true, ['{projectRoot}/sentinel.txt']);
    const cachedWarm = runNxLint(cachedPaths, nxWorkspace);
    expect(cachedWarm.exitCode, streamText(cachedWarm.stderr, 'cached warm stderr')).toBe(0);
    write(join(cachedPaths.repository, 'src', 'app.ts'), 'export const cachedFault = true;\n');
    git(cachedPaths.repository, 'add', 'src/app.ts');
    git(cachedPaths.repository, 'commit', '--message', 'cached omitted input');
    cachedPaths.revision = git(cachedPaths.repository, 'rev-parse', 'HEAD');
    const uncachedOracle = runRealAdapter('committed', cachedPaths);
    expect(uncachedOracle.exitCode).toBe(1);
    const cachedMutation = runNxLint(cachedPaths, nxWorkspace);
    const cachedOutput = `${streamText(cachedMutation.stdout, 'cached stdout')}${streamText(cachedMutation.stderr, 'cached stderr')}`;
    expect(cachedMutation.exitCode, cachedOutput).toBe(0);
  }, 30_000);
});
