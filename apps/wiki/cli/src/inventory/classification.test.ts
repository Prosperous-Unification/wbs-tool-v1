import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

const repositories: string[] = [];
const cliPath = join(import.meta.dir, '..', 'cli.ts');
const shippedPolicyPath = join(
  import.meta.dir,
  '..',
  'contracts',
  'fixtures',
  'classification-policy.v1.json',
);
const wasmHeader = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

function runGit(repository: string, argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = invocation.stderr.toString('utf8');
  expect(invocation.exitCode, stderr).toBe(0);
  return invocation.stdout.toString('utf8').trim();
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-classification-'));
  repositories.push(repository);
  runGit(repository, ['init', '--initial-branch=main']);
  runGit(repository, ['config', 'user.email', 'classification@example.test']);
  runGit(repository, ['config', 'user.name', 'Classification Fixture']);
  return repository;
}

function write(repository: string, path: string, source: string | Uint8Array): void {
  const absolutePath = join(repository, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function hash(repository: string, path: string): string {
  return runGit(repository, ['hash-object', path]);
}

function commitAll(repository: string): string {
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '--message', 'classification fixture']);
  return runGit(repository, ['rev-parse', 'HEAD']);
}

function policy(gitlinkObject: string, includeGitlink = true): object {
  return {
    schemaVersion: 1,
    policyId: 'classification.test.v1',
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
        contentClass: 'test',
        include: [
          { kind: 'suffix', value: '.test.ts' },
          { kind: 'suffix', value: '.spec.ts' },
          { kind: 'segment', value: 'e2e' },
        ],
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
        contentClass: 'fixture',
        include: [{ kind: 'segment', value: 'fixtures' }],
        exclude: [],
      },
      {
        contentClass: 'migration',
        include: [{ kind: 'segment', value: 'migrations' }],
        exclude: [],
      },
      {
        contentClass: 'openspec',
        include: [{ kind: 'prefix', value: 'openspec' }],
        exclude: [],
      },
      {
        contentClass: 'placeholder',
        include: [{ kind: 'name', value: '.gitkeep' }],
        exclude: [],
      },
      {
        contentClass: 'script',
        include: [{ kind: 'suffix', value: '.sh' }],
        exclude: [],
      },
      {
        contentClass: 'config',
        include: [
          { kind: 'name', value: 'project.json' },
          { kind: 'suffix', value: '.config.ts' },
        ],
        exclude: [],
      },
      {
        contentClass: 'source',
        include: [
          { kind: 'suffix', value: '.ts' },
          { kind: 'suffix', value: '.js' },
          { kind: 'suffix', value: '.svg' },
        ],
        exclude: [
          { kind: 'suffix', value: '.test.ts' },
          { kind: 'suffix', value: '.spec.ts' },
          { kind: 'segment', value: 'e2e' },
          { kind: 'segment', value: 'fixtures' },
          { kind: 'segment', value: 'generated' },
          { kind: 'segment', value: 'vendor' },
        ],
      },
      {
        contentClass: 'document',
        include: [
          { kind: 'suffix', value: '.md' },
          { kind: 'suffix', value: '.txt' },
        ],
        exclude: [{ kind: 'prefix', value: 'openspec' }],
      },
    ],
    evidenceRoots: [
      {
        path: 'docs/review-evidence',
        allowedRecordKinds: ['review-receipt', 'opaque-transcript'],
      },
      {
        path: 'docs/experiment-evidence',
        allowedRecordKinds: ['benchmark-corpus', 'candidate-inventory', 'experiment-manifest'],
      },
    ],
    binaryDeclarations: [
      {
        path: 'assets/module.wasm',
        format: 'application/wasm',
        consumer: 'apps/fe-01',
        regenerationAuthority: { kind: 'source', path: 'tools/assets/module-source.ts' },
      },
    ],
    gitlinkBoundaries: includeGitlink
      ? [
          {
            path: 'external/tool',
            object: gitlinkObject,
            boundaryId: 'external.tool.v1',
            repository: 'https://example.test/tool.git',
          },
        ]
      : [],
    symlinks: 'inventory-only',
    gitlinks: 'declared-external-boundary',
  };
}

function writePolicy(repository: string, policyRecord: object): string {
  const path = join(repository, '.classification-policy.json');
  writeFileSync(path, `${JSON.stringify(policyRecord)}\n`, 'utf8');
  return path;
}

function classify(
  repository: string,
  revision: string,
  policyPath: string,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cliPath,
      'classify-candidate',
      'committed',
      repository,
      revision,
      policyPath,
    ],
    { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
  );
}

function output(invocation: ReturnType<typeof Bun.spawnSync>): string {
  const stdout = invocation.stdout;
  const stderr = invocation.stderr;
  if (stdout === undefined || stderr === undefined) throw new Error('classification pipe missing');
  return `${Buffer.from(stdout).toString('utf8')}${Buffer.from(stderr).toString('utf8')}`;
}

function standardOutput(invocation: ReturnType<typeof Bun.spawnSync>): string {
  const stdout = invocation.stdout;
  if (stdout === undefined) throw new Error('classification stdout pipe missing');
  return Buffer.from(stdout).toString('utf8');
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { force: true, recursive: true });
  }
});

describe('entry classification production CLI', () => {
  test('partitions every exact candidate tuple into ordinary content or an allowlisted evidence schema', () => {
    const repository = createRepository();
    const external = createRepository();
    write(external, 'README.md', 'external boundary\n');
    const gitlinkObject = commitAll(external);

    const ordinary: readonly (readonly [string, string, string])[] = [
      ['src/main.ts', 'export const main = true;\n', 'source'],
      ['src/main.test.ts', 'test("main", () => {});\n', 'test'],
      ['project.json', '{"name":"fixture"}\n', 'config'],
      ['bin/check.sh', '#!/bin/sh\nexit 0\n', 'script'],
      ['migrations/001/migration.sql', 'CREATE TABLE example(id TEXT);\n', 'migration'],
      ['fixtures/sample.json', '{"fixture":true}\n', 'fixture'],
      ['generated/client.ts', 'export const generated = true;\n', 'generated'],
      ['vendor/library.js', 'export const vendored = true;\n', 'vendored'],
      ['.gitkeep', '', 'placeholder'],
      ['README.md', '# Candidate\n', 'document'],
      ['openspec/changes/demo/proposal.md', '## Why\n\nBecause.\n', 'openspec'],
    ];
    for (const [path, source] of ordinary) write(repository, path, source);
    chmodSync(join(repository, 'bin/check.sh'), 0o755);
    write(repository, 'assets/module.wasm', wasmHeader);
    write(repository, 'tools/assets/module-source.ts', 'export const moduleSource = true;\n');
    symlinkSync('README.md', join(repository, 'readme-link'));
    write(
      repository,
      'docs/review-evidence/transcript.v1.json',
      JSON.stringify({
        schemaVersion: 1,
        recordKind: 'opaque-transcript',
        invocationId: 'invocation.test.v1',
        mediaType: 'text/plain',
        payload: 'opaque model prose\nwith no schema of its own',
      }),
    );
    write(
      repository,
      'docs/experiment-evidence/corpus.v1.json',
      JSON.stringify({
        schemaVersion: 1,
        corpusId: 'corpus.test.v1',
        acceptanceId: 'acceptance.test.v1',
        repository: {
          revision: '1'.repeat(40),
          tree: '2'.repeat(40),
          inventoryId: 'inventory.test.v1',
        },
        outcomes: [
          {
            outcomeId: 'outcome.test.v1',
            title: 'Test outcome',
            stratum: 'independent-module',
            heldOut: false,
            acceptanceCriteria: ['the named test passes'],
          },
        ],
      }),
    );
    runGit(repository, ['add', '--all']);
    runGit(repository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${gitlinkObject},external/tool`,
    ]);
    runGit(repository, ['commit', '--message', 'classification fixture']);
    const revision = runGit(repository, ['rev-parse', 'HEAD']);
    const tree = runGit(repository, ['rev-parse', 'HEAD^{tree}']);
    const policyPath = writePolicy(repository, policy(gitlinkObject));

    const invocation = classify(repository, revision, policyPath);
    const stdout = invocation.stdout?.toString('utf8') ?? '';
    expect(invocation.exitCode, output(invocation)).toBe(0);
    const expectedEntries = [
      ...ordinary.map(([path, , contentClass]) => ({
        path,
        mode: path === 'bin/check.sh' ? '100755' : '100644',
        blob: hash(repository, path),
        classification: { kind: 'content', contentClass },
      })),
      {
        path: 'assets/module.wasm',
        mode: '100644',
        blob: hash(repository, 'assets/module.wasm'),
        classification: {
          kind: 'content',
          contentClass: 'binary',
          format: 'application/wasm',
          consumer: 'apps/fe-01',
          regenerationAuthority: { kind: 'source', path: 'tools/assets/module-source.ts' },
        },
      },
      {
        path: 'docs/experiment-evidence/corpus.v1.json',
        mode: '100644',
        blob: hash(repository, 'docs/experiment-evidence/corpus.v1.json'),
        classification: {
          kind: 'evidence',
          evidenceRoot: 'docs/experiment-evidence',
          recordKind: 'benchmark-corpus',
        },
      },
      {
        path: 'docs/review-evidence/transcript.v1.json',
        mode: '100644',
        blob: hash(repository, 'docs/review-evidence/transcript.v1.json'),
        classification: {
          kind: 'evidence',
          evidenceRoot: 'docs/review-evidence',
          recordKind: 'opaque-transcript',
        },
      },
      {
        path: 'external/tool',
        mode: '160000',
        blob: gitlinkObject,
        classification: {
          kind: 'content',
          contentClass: 'gitlink',
          boundaryId: 'external.tool.v1',
          repository: 'https://example.test/tool.git',
        },
      },
      {
        path: 'readme-link',
        mode: '120000',
        blob: runGit(repository, ['rev-parse', 'HEAD:readme-link']),
        classification: {
          kind: 'content',
          contentClass: 'symlink',
          target: 'README.md',
          resolvedTarget: 'README.md',
        },
      },
      {
        path: 'tools/assets/module-source.ts',
        mode: '100644',
        blob: hash(repository, 'tools/assets/module-source.ts'),
        classification: { kind: 'content', contentClass: 'source' },
      },
    ].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    expect(JSON.parse(stdout) as unknown).toEqual({
      selection: { kind: 'committed', revision, tree },
      entries: expectedEntries,
      untracked: [],
      policyId: 'classification.test.v1',
    });
  });

  test('refuses disguised or malformed reserved evidence and undeclared Gitlinks', () => {
    const cases: readonly (readonly [string, (repository: string) => string, string])[] = [
      [
        'hidden source',
        (repository) => {
          write(
            repository,
            'docs/review-evidence/hidden.ts',
            JSON.stringify({
              schemaVersion: 1,
              recordKind: 'opaque-transcript',
              invocationId: 'invocation.hidden.v1',
              mediaType: 'text/plain',
              payload: 'export const hidden = true;',
            }),
          );
          return 'source-like path is not an evidence schema';
        },
        'source-like path is not an evidence schema',
      ],
      [
        'executable evidence',
        (repository) => {
          write(
            repository,
            'docs/review-evidence/executable.v1.json',
            JSON.stringify({
              schemaVersion: 1,
              recordKind: 'opaque-transcript',
              invocationId: 'invocation.executable.v1',
              mediaType: 'text/plain',
              payload: 'executable evidence',
            }),
          );
          chmodSync(join(repository, 'docs/review-evidence/executable.v1.json'), 0o755);
          return 'reserved evidence must use mode 100644';
        },
        'reserved evidence must use mode 100644',
      ],
      [
        'unknown evidence schema',
        (repository) => {
          write(
            repository,
            'docs/review-evidence/unknown.v1.json',
            '{"schemaVersion":1,"recordKind":"unknown"}\n',
          );
          return 'does not match exactly one allowlisted evidence schema';
        },
        'does not match exactly one allowlisted evidence schema',
      ],
      [
        'unenveloped prose',
        (repository) => {
          write(repository, 'docs/review-evidence/prose.v1.json', 'an unwrapped transcript\n');
          return 'is not JSON';
        },
        'is not JSON',
      ],
      [
        'undeclared Gitlink',
        (repository) => {
          const external = createRepository();
          write(external, 'README.md', 'external\n');
          const object = commitAll(external);
          runGit(repository, [
            'update-index',
            '--add',
            '--cacheinfo',
            `160000,${object},external/tool`,
          ]);
          return object;
        },
        'has no declared external boundary',
      ],
    ];

    for (const [name, arrange, expected] of cases) {
      const repository = createRepository();
      write(repository, 'README.md', `# ${name}\n`);
      runGit(repository, ['add', '--all']);
      const arranged = arrange(repository);
      const gitlinkObject = name === 'undeclared Gitlink' ? arranged : '1'.repeat(40);
      if (name !== 'undeclared Gitlink') runGit(repository, ['add', '--all']);
      runGit(repository, ['commit', '--message', name]);
      const revision = runGit(repository, ['rev-parse', 'HEAD']);
      const policyPath = writePolicy(
        repository,
        policy(gitlinkObject, name !== 'undeclared Gitlink'),
      );
      const invocation = classify(repository, revision, policyPath);
      expect(invocation.exitCode, `${name}: ${output(invocation)}`).toBe(1);
      expect(output(invocation)).toContain(expected);
    }
    // Proof: PR run 34694906449 timed this production path out at 5023.00ms under
    // Bun's 5-second default, after its child was still running (`Received: null`).
  }, 10_000);

  test('refuses unknown selector versions, changed evidence roots and silently dropped classes', () => {
    const repository = createRepository();
    write(repository, 'README.md', '# Policy boundary\n');
    const revision = commitAll(repository);
    const unknownVersion = structuredClone(policy('1'.repeat(40))) as {
      selectorVersion: number;
    };
    unknownVersion.selectorVersion = 99;
    const versionInvocation = classify(
      repository,
      revision,
      writePolicy(repository, unknownVersion),
    );
    expect(versionInvocation.exitCode, output(versionInvocation)).toBe(1);
    expect(output(versionInvocation)).toContain('selectorVersion must be 1');

    const changedRoots = structuredClone(policy('1'.repeat(40))) as {
      evidenceRoots: { path: string; allowedRecordKinds: string[] }[];
    };
    changedRoots.evidenceRoots = changedRoots.evidenceRoots.filter(
      (root) => root.path !== 'docs/review-evidence',
    );
    const rootsInvocation = classify(repository, revision, writePolicy(repository, changedRoots));
    expect(rootsInvocation.exitCode, output(rootsInvocation)).toBe(1);
    expect(output(rootsInvocation)).toContain('the two reserved evidence roots');

    const incomplete = structuredClone(policy('1'.repeat(40))) as {
      contentClasses: string[];
      contentRules: { contentClass: string }[];
    };
    incomplete.contentClasses = incomplete.contentClasses.filter(
      (contentClass) => contentClass !== 'source',
    );
    incomplete.contentRules = incomplete.contentRules.filter(
      (rule) => rule.contentClass !== 'source',
    );
    const invocation = classify(repository, revision, writePolicy(repository, incomplete));

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain('exactly one rule for every supported content class');
  });

  test('routes a reserved-root symlink through evidence validation', () => {
    const repository = createRepository();
    write(repository, 'README.md', '# Evidence symlink target\n');
    mkdirSync(join(repository, 'docs/review-evidence'), { recursive: true });
    symlinkSync('../../README.md', join(repository, 'docs/review-evidence/link.v1.json'));
    const revision = commitAll(repository);
    const invocation = classify(
      repository,
      revision,
      writePolicy(repository, policy('1'.repeat(40))),
    );

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain('reserved evidence must use mode 100644');
  });

  test('routes a reserved-root Gitlink through evidence validation', () => {
    const repository = createRepository();
    const external = createRepository();
    write(external, 'README.md', '# Evidence Gitlink target\n');
    const gitlinkObject = commitAll(external);
    runGit(repository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${gitlinkObject},docs/experiment-evidence/external.v1.json`,
    ]);
    runGit(repository, ['commit', '--message', 'reserved Gitlink']);
    const revision = runGit(repository, ['rev-parse', 'HEAD']);
    const policyRecord = structuredClone(policy(gitlinkObject)) as {
      gitlinkBoundaries: {
        path: string;
        object: string;
        boundaryId: string;
        repository: string;
      }[];
    };
    policyRecord.gitlinkBoundaries = [
      {
        path: 'docs/experiment-evidence/external.v1.json',
        object: gitlinkObject,
        boundaryId: 'evidence.external.v1',
        repository: 'https://example.test/evidence.git',
      },
    ];
    const invocation = classify(repository, revision, writePolicy(repository, policyRecord));

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain('reserved evidence must use mode 100644');
  });

  test('preserves a leading BOM byte sequence in a symlink target', () => {
    const repository = createRepository();
    const target = '\uFEFFREADME.md';
    write(repository, target, '# BOM target\n');
    symlinkSync(target, join(repository, 'bom-link'));
    const revision = commitAll(repository);
    const invocation = classify(
      repository,
      revision,
      writePolicy(repository, policy('1'.repeat(40))),
    );

    expect(invocation.exitCode, output(invocation)).toBe(0);
    const classified = JSON.parse(standardOutput(invocation)) as {
      entries: { path: string; mode: string; blob: string; classification: unknown }[];
    };
    expect(classified.entries.find((entry) => entry.path === 'bom-link')?.classification).toEqual({
      kind: 'content',
      contentClass: 'symlink',
      target,
      resolvedTarget: target,
    });
  });

  test('uses the shipped policy to classify a real TSX test suffix as test content', () => {
    const repository = createRepository();
    const path = 'apps/fe-01/src/app.test.tsx';
    write(repository, path, 'export const tested = true;\n');
    const revision = commitAll(repository);
    const invocation = classify(repository, revision, shippedPolicyPath);

    expect(invocation.exitCode, output(invocation)).toBe(0);
    const classified = JSON.parse(standardOutput(invocation)) as {
      entries: { path: string; mode: string; blob: string; classification: unknown }[];
    };
    // Proof: removing `.test.tsx`/`.spec.tsx` from the shipped test includes and source
    // exclusions changed this production CLI tuple's received content class to `source`.
    expect(classified.entries).toEqual([
      {
        path,
        mode: '100644',
        blob: hash(repository, path),
        classification: { kind: 'content', contentClass: 'test' },
      },
    ]);
  });

  test('refuses an ordinary path that matches no selector', () => {
    const repository = createRepository();
    write(repository, 'unknown.zzz', 'unknown\n');
    const revision = commitAll(repository);
    const invocation = classify(
      repository,
      revision,
      writePolicy(repository, policy('1'.repeat(40))),
    );

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain(
      'ordinary content unknown.zzz matched 0 classification rules',
    );
  });

  test('refuses an ordinary path that matches multiple selectors', () => {
    const repository = createRepository();
    const path = 'src/ambiguous.ts';
    write(repository, path, 'export const ambiguous = true;\n');
    const revision = commitAll(repository);
    const policyRecord = structuredClone(policy('1'.repeat(40))) as {
      contentRules: { contentClass: string; include: { kind: string; value: string }[] }[];
    };
    const testRule = policyRecord.contentRules.find((rule) => rule.contentClass === 'test');
    if (testRule === undefined) throw new Error('test rule missing from fixture');
    testRule.include.push({ kind: 'suffix', value: '.ts' });
    const invocation = classify(repository, revision, writePolicy(repository, policyRecord));

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain(`ordinary content ${path} matched 2 classification rules`);
  });

  test('refuses a Gitlink whose object differs from its pinned boundary', () => {
    const repository = createRepository();
    const external = createRepository();
    write(external, 'README.md', '# External\n');
    const gitlinkObject = commitAll(external);
    runGit(repository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${gitlinkObject},external/tool`,
    ]);
    runGit(repository, ['commit', '--message', 'mismatched Gitlink']);
    const revision = runGit(repository, ['rev-parse', 'HEAD']);
    const invocation = classify(
      repository,
      revision,
      writePolicy(repository, policy('1'.repeat(40))),
    );

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain(
      `Gitlink external/tool object ${gitlinkObject} differs from declared object ${'1'.repeat(40)}`,
    );
  });

  test('refuses a symlink target that escapes the repository', () => {
    const repository = createRepository();
    mkdirSync(join(repository, 'links'), { recursive: true });
    symlinkSync('../../outside', join(repository, 'links/escape'));
    const revision = commitAll(repository);
    const invocation = classify(
      repository,
      revision,
      writePolicy(repository, policy('1'.repeat(40))),
    );

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain(
      'symlink links/escape escapes the repository: ../../outside',
    );
  });

  test('refuses an undeclared NUL-bearing binary at a source path', () => {
    const repository = createRepository();
    const path = 'src/undeclared.ts';
    write(repository, path, wasmHeader);
    const revision = commitAll(repository);
    const invocation = classify(
      repository,
      revision,
      writePolicy(repository, policy('1'.repeat(40))),
    );

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain(`undeclared binary content at ${path}`);
  });

  test('bounds the NUL sniff so a later literal NUL remains UTF-8 source', () => {
    const repository = createRepository();
    const path = 'src/late-nul.test.ts';
    write(repository, path, `${'a'.repeat(8192)}\u0000`);
    const revision = commitAll(repository);
    const invocation = classify(
      repository,
      revision,
      writePolicy(repository, policy('1'.repeat(40))),
    );

    expect(invocation.exitCode, output(invocation)).toBe(0);
    const classified = JSON.parse(standardOutput(invocation)) as {
      entries: { path: string; mode: string; blob: string; classification: unknown }[];
    };
    expect(classified.entries[0]?.classification).toEqual({
      kind: 'content',
      contentClass: 'test',
    });
  });

  test('refuses invalid UTF-8 beyond the bounded NUL sniff', () => {
    const repository = createRepository();
    const path = 'src/invalid-utf8.ts';
    const bytes = new Uint8Array(8_002);
    bytes.fill(97);
    bytes[8_001] = 0xff;
    write(repository, path, bytes);
    const revision = commitAll(repository);
    const invocation = classify(
      repository,
      revision,
      writePolicy(repository, policy('1'.repeat(40))),
    );

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain(`undeclared binary content at ${path}`);
  });
});
