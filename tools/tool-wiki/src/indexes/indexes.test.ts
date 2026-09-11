import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

type Membership =
  | { kind: 'path'; path: string }
  | { kind: 'directory-prefix'; prefix: string; exclusions: string[] };

interface IndexMetadataFixture {
  schemaVersion: number;
  moduleId: string;
  memberships: Membership[];
  relationshipSelectors: string[];
  inapplicableSections: { section: string; reason: string }[];
  externalConsumers: { kind: 'none-known'; knowledgeLimit: string };
}

interface IndexCheckReport {
  schemaVersion: 1;
  selection: { kind: 'committed'; revision: string; tree: string };
  indexes: {
    indexPath: string;
    moduleId: string;
    identity: string;
    members: string[];
  }[];
  reviewDebt: { indexPath: string; directEntries: number; limit: 40 }[];
}

const repositories: string[] = [];
const cliPath = join(import.meta.dir, '..', 'cli.ts');

function runGit(repository: string, argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = invocation.stderr.toString('utf8');
  expect(invocation.exitCode, stderr).toBe(0);
  return invocation.stdout.toString('utf8').trim();
}

function write(repository: string, path: string, source: string): void {
  const absolutePath = join(repository, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
}

function metadata(moduleId: string, memberships: Membership[]): IndexMetadataFixture {
  return {
    schemaVersion: 1,
    moduleId,
    memberships,
    relationshipSelectors: [],
    inapplicableSections: [
      { section: 'relationships', reason: 'The fixture declares no non-derivable relationships.' },
      { section: 'invariants', reason: 'The fixture has no cross-file runtime invariant.' },
      { section: 'checks', reason: 'The index checker is the fixture boundary check.' },
    ],
    externalConsumers: {
      kind: 'none-known',
      knowledgeLimit: 'Only consumers visible in this immutable candidate were considered.',
    },
  };
}

function indexSource(
  heading: string,
  indexMetadata: IndexMetadataFixture,
  links: string[],
): string {
  return `# ${heading}\n\n<!-- wbs-index ${JSON.stringify(indexMetadata)} -->\n\n${links.join('\n')}\n`;
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-indexes-'));
  repositories.push(repository);
  runGit(repository, ['init', '--initial-branch=main']);
  runGit(repository, ['config', 'user.email', 'indexes@example.test']);
  runGit(repository, ['config', 'user.name', 'Index Fixture']);
  return repository;
}

function writeFixture(repository: string): void {
  write(
    repository,
    'README.md',
    indexSource(
      'Repository map',
      metadata('module.root', [
        { kind: 'path', path: 'apps/alpha/README.md' },
        { kind: 'path', path: 'docs/guide.md' },
        { kind: 'directory-prefix', prefix: 'tests', exclusions: [] },
        { kind: 'directory-prefix', prefix: 'vendor', exclusions: [] },
        {
          kind: 'directory-prefix',
          prefix: 'openspec/changes/archive/2026-09-01-frozen',
          exclusions: [],
        },
      ]),
      [
        '- [Alpha project](apps/alpha/README.md#public-api)',
        '- [Guide](docs/guide.md#details)',
        '- [Frozen proposal](openspec/changes/archive/2026-09-01-frozen/proposal.md#why)',
      ],
    ),
  );
  write(
    repository,
    'apps/alpha/README.md',
    indexSource(
      'Alpha',
      metadata('module.alpha', [
        { kind: 'path', path: 'src/index.ts' },
        { kind: 'directory-prefix', prefix: 'src/deep', exclusions: [] },
        { kind: 'path', path: 'packages/child/README.md' },
      ]),
      [
        '## Public API',
        '',
        '- [Entrypoint](src/index.ts)',
        '- [Nested child](packages/child/README.md#child-api)',
      ],
    ),
  );
  write(
    repository,
    'apps/alpha/packages/child/README.md',
    indexSource('Child', metadata('module.alpha-child', [{ kind: 'path', path: 'index.ts' }]), [
      '## Child API',
      '',
      '- [Entrypoint](index.ts)',
    ]),
  );
  write(repository, 'apps/alpha/src/index.ts', 'export const alpha = 1;\n');
  write(repository, 'apps/alpha/src/deep/tool.ts', 'export const tool = 2;\n');
  write(repository, 'apps/alpha/packages/child/index.ts', 'export const child = 3;\n');
  write(repository, 'docs/guide.md', '# Guide\n\n## Details\n\nCurrent guidance.\n');
  write(repository, 'tests/unit/alpha.test.ts', 'export const testName = "alpha";\n');
  write(repository, 'tests/fixtures/plan.json', '{"name":"fixture"}\n');
  write(repository, 'vendor/runtime/NOTICE', 'frozen vendor notice\n');
  write(
    repository,
    'openspec/changes/archive/2026-09-01-frozen/proposal.md',
    '# Frozen change\n\n## Why\n\nHistorical intent.\n',
  );
  write(
    repository,
    'openspec/changes/archive/2026-09-01-frozen/specs/example/spec.md',
    '# Frozen specification\n',
  );
}

function commit(repository: string, message: string): string {
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '-m', message]);
  return runGit(repository, ['rev-parse', 'HEAD']);
}

function runCheck(
  repository: string,
  revision: string,
  env?: Record<string, string>,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [process.execPath, 'run', cliPath, 'check-indexes', 'committed', repository, revision],
    {
      cwd: import.meta.dir,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
}

function pipeText(stream: Uint8Array | undefined, name: string): string {
  if (stream === undefined) throw new Error(`${name} pipe was unavailable`);
  return Buffer.from(stream).toString('utf8');
}

function outputOf(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${pipeText(invocation.stdout, 'index stdout')}${pipeText(invocation.stderr, 'index stderr')}`;
}

function expectRefusal(invocation: ReturnType<typeof Bun.spawnSync>, expected: string): void {
  const output = outputOf(invocation);
  expect(invocation.exitCode, output).toBe(1);
  expect(output).toContain(expected);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { force: true, recursive: true });
  }
});

describe('index production CLI', () => {
  test('checks nested indexes, grouped sets and frozen archive proposal navigation', () => {
    const repository = createRepository();
    writeFixture(repository);
    const revision = commit(repository, 'fixture');
    const tree = runGit(repository, ['rev-parse', `${revision}^{tree}`]);

    const invocation = runCheck(repository, revision);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(0);
    const report = JSON.parse(pipeText(invocation.stdout, 'index stdout')) as IndexCheckReport;
    expect(report).toMatchObject({
      schemaVersion: 1,
      selection: { kind: 'committed', revision, tree },
    });
    expect(
      report.indexes.map(({ indexPath, moduleId, members }) => ({ indexPath, moduleId, members })),
    ).toEqual([
      {
        indexPath: 'README.md',
        moduleId: 'module.root',
        members: [
          'apps/alpha/README.md',
          'docs/guide.md',
          'openspec/changes/archive/2026-09-01-frozen/proposal.md',
          'openspec/changes/archive/2026-09-01-frozen/specs/example/spec.md',
          'tests/fixtures/plan.json',
          'tests/unit/alpha.test.ts',
          'vendor/runtime/NOTICE',
        ],
      },
      {
        indexPath: 'apps/alpha/README.md',
        moduleId: 'module.alpha',
        members: [
          'apps/alpha/packages/child/README.md',
          'apps/alpha/src/deep/tool.ts',
          'apps/alpha/src/index.ts',
        ],
      },
      {
        indexPath: 'apps/alpha/packages/child/README.md',
        moduleId: 'module.alpha-child',
        members: ['apps/alpha/packages/child/index.ts'],
      },
    ]);
    expect(report.indexes.every(({ identity }) => /^[0-9a-f]{64}$/.test(identity))).toBe(true);
    expect(report.reviewDebt).toEqual([]);
  });

  test('refuses a declared child deleted from the selected candidate', () => {
    const repository = createRepository();
    writeFixture(repository);
    rmSync(join(repository, 'docs/guide.md'));

    expectRefusal(
      runCheck(repository, commit(repository, 'delete indexed child')),
      'membership target absent: docs/guide.md',
    );
  });

  test('refuses a selected child absent from its nearest index', () => {
    const repository = createRepository();
    writeFixture(repository);
    write(repository, 'unindexed.txt', 'new child\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'add unindexed child')),
      'unindexed candidate path in README.md: unindexed.txt',
    );
  });

  test('refuses a Markdown link whose case differs from the selected path', () => {
    const repository = createRepository();
    writeFixture(repository);
    const root = indexSource(
      'Repository map',
      metadata('module.root', [
        { kind: 'path', path: 'apps/alpha/README.md' },
        { kind: 'path', path: 'docs/guide.md' },
        { kind: 'directory-prefix', prefix: 'tests', exclusions: [] },
        { kind: 'directory-prefix', prefix: 'vendor', exclusions: [] },
        {
          kind: 'directory-prefix',
          prefix: 'openspec/changes/archive/2026-09-01-frozen',
          exclusions: [],
        },
      ]),
      ['- [Guide](docs/Guide.md#details)'],
    );
    write(repository, 'README.md', root);

    expectRefusal(
      runCheck(repository, commit(repository, 'wrong link case')),
      'Markdown path case mismatch in README.md: docs/Guide.md -> docs/guide.md',
    );
  });

  test('refuses a Markdown link to an absent anchor', () => {
    const repository = createRepository();
    writeFixture(repository);
    const rootPath = join(repository, 'README.md');
    const source = Bun.file(rootPath).text();
    return source.then((markdown) => {
      writeFileSync(
        rootPath,
        markdown.replace('docs/guide.md#details', 'docs/guide.md#missing'),
        'utf8',
      );
      expectRefusal(
        runCheck(repository, commit(repository, 'missing anchor')),
        'Markdown anchor absent in README.md: docs/guide.md#missing',
      );
    });
  });

  test('refuses invalid versioned metadata before inferring membership', () => {
    const repository = createRepository();
    writeFixture(repository);
    const malformed = metadata('module.root', []);
    malformed.schemaVersion = 2;
    write(repository, 'README.md', indexSource('Repository map', malformed, []));

    expectRefusal(
      runCheck(repository, commit(repository, 'invalid metadata')),
      'index metadata malformed at README.md',
    );
  });

  test('refuses duplicate relationship selectors in index metadata', () => {
    const repository = createRepository();
    const malformed = metadata('module.root', []);
    malformed.relationshipSelectors = ['typescript.public', 'typescript.public'];
    malformed.inapplicableSections = malformed.inapplicableSections.filter(
      ({ section }) => section !== 'relationships',
    );
    write(repository, 'README.md', indexSource('Root', malformed, []));

    expectRefusal(
      runCheck(repository, commit(repository, 'duplicate relationship selectors')),
      'unique relationship selectors',
    );
  });

  test('refuses duplicate inapplicable sections in index metadata', () => {
    const repository = createRepository();
    const malformed = metadata('module.root', []);
    malformed.inapplicableSections.push({
      section: 'checks',
      reason: 'A duplicate claim cannot define a canonical metadata identity.',
    });
    write(repository, 'README.md', indexSource('Root', malformed, []));

    expectRefusal(
      runCheck(repository, commit(repository, 'duplicate inapplicable sections')),
      'unique inapplicable sections',
    );
  });

  test('requires relationship selectors when relationships are applicable', () => {
    const repository = createRepository();
    const malformed = metadata('module.root', []);
    malformed.inapplicableSections = malformed.inapplicableSections.filter(
      ({ section }) => section !== 'relationships',
    );
    write(repository, 'README.md', indexSource('Root', malformed, []));

    expectRefusal(
      runCheck(repository, commit(repository, 'missing relationship selectors')),
      'relationship selectors or one explicit relationships inapplicability reason',
    );
  });

  test('refuses relationship selectors when relationships are inapplicable', () => {
    const repository = createRepository();
    const malformed = metadata('module.root', []);
    malformed.relationshipSelectors = ['typescript.public'];
    write(repository, 'README.md', indexSource('Root', malformed, []));

    expectRefusal(
      runCheck(repository, commit(repository, 'contradictory relationship selectors')),
      'relationship selectors or one explicit relationships inapplicability reason',
    );
  });

  test('refuses a directory exclusion outside its declared prefix', () => {
    const repository = createRepository();
    const malformed = metadata('module.root', [
      { kind: 'directory-prefix', prefix: 'docs', exclusions: ['other/guide.md'] },
    ]);
    write(repository, 'README.md', indexSource('Root', malformed, []));
    write(repository, 'docs/guide.md', '# Guide\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'outside directory exclusion')),
      'directory exclusions below their declared prefix',
    );
  });

  test('refuses a membership path that escapes its index boundary', () => {
    const repository = createRepository();
    writeFixture(repository);
    const escaping = metadata('module.alpha', [{ kind: 'path', path: '../outside.ts' }]);
    write(repository, 'apps/alpha/README.md', indexSource('Alpha', escaping, []));

    expectRefusal(
      runCheck(repository, commit(repository, 'escaping membership')),
      'index metadata malformed at apps/alpha/README.md',
    );
  });

  test('refuses a candidate path matched by two membership declarations', () => {
    const repository = createRepository();
    writeFixture(repository);
    const overlapping = metadata('module.root', [
      { kind: 'path', path: 'apps/alpha/README.md' },
      { kind: 'path', path: 'docs/guide.md' },
      { kind: 'directory-prefix', prefix: 'tests', exclusions: [] },
      { kind: 'path', path: 'tests/unit/alpha.test.ts' },
      { kind: 'directory-prefix', prefix: 'vendor', exclusions: [] },
      {
        kind: 'directory-prefix',
        prefix: 'openspec/changes/archive/2026-09-01-frozen',
        exclusions: [],
      },
    ]);
    write(repository, 'README.md', indexSource('Repository map', overlapping, []));

    expectRefusal(
      runCheck(repository, commit(repository, 'ambiguous membership')),
      'ambiguous membership in README.md: tests/unit/alpha.test.ts',
    );
  });

  test('refuses glob characters in Markdown links', () => {
    const repository = createRepository();
    writeFixture(repository);
    const rootPath = join(repository, 'README.md');
    const source = Bun.file(rootPath).text();
    return source.then((markdown) => {
      writeFileSync(rootPath, `${markdown}\n[No globs](tests/*.ts)\n`, 'utf8');
      expectRefusal(
        runCheck(repository, commit(repository, 'glob link')),
        'Markdown link contains a glob in README.md: tests/*.ts',
      );
    });
  });

  test('reports navigation review debt without moving or rejecting forty-one direct entries', () => {
    const repository = createRepository();
    const memberships: Membership[] = [];
    for (let index = 1; index <= 41; index += 1) {
      const path = `entry-${String(index).padStart(2, '0')}.md`;
      memberships.push({ kind: 'path', path });
      write(repository, path, `# Entry ${String(index)}\n`);
    }
    write(
      repository,
      'README.md',
      indexSource('Wide index', metadata('module.wide', memberships), []),
    );
    const revision = commit(repository, 'wide fixture');

    const invocation = runCheck(repository, revision);
    const output = outputOf(invocation);
    expect(invocation.exitCode, output).toBe(0);
    const report = JSON.parse(pipeText(invocation.stdout, 'index stdout')) as IndexCheckReport;
    expect(report.reviewDebt).toEqual([{ indexPath: 'README.md', directEntries: 41, limit: 40 }]);
    expect(report.indexes[0]?.members).toHaveLength(41);
    expect(runGit(repository, ['status', '--short'])).toBe('');
  });

  test('fails closed when a selected index blob cannot be read', () => {
    const repository = createRepository();
    writeFixture(repository);
    const revision = commit(repository, 'fixture');
    const wrapperDirectory = join(repository, 'git-wrapper');
    const wrapperPath = join(wrapperDirectory, 'git');
    mkdirSync(wrapperDirectory);
    const realGit = Bun.which('git');
    expect(realGit).not.toBeNull();
    if (realGit === null) throw new Error('required git executable disappeared during test');
    writeFileSync(
      wrapperPath,
      '#!/bin/sh\nif [ "$3" = "cat-file" ]; then printf "injected unreadable index\\n" >&2; exit 19; fi\nexec "$WIKI_REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    chmodSync(wrapperPath, 0o755);

    expectRefusal(
      runCheck(repository, revision, {
        PATH: `${wrapperDirectory}:${process.env['PATH'] ?? ''}`,
        WIKI_REAL_GIT: realGit,
      }),
      'cannot read selected index README.md: injected unreadable index',
    );
  });

  test('refuses a linked selected symlink at the membership boundary', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Symlink boundary',
        metadata('module.symlink', [{ kind: 'path', path: 'escape' }]),
        ['- [Escape](escape)'],
      ),
    );
    symlinkSync('../../outside', join(repository, 'escape'));

    expectRefusal(
      runCheck(repository, commit(repository, 'escaping symlink')),
      'membership symlink escapes candidate in README.md: escape -> ../../outside',
    );
  });

  test('binds canonical index identities and links to the selected candidate rather than host files', () => {
    const repository = createRepository();
    writeFixture(repository);
    const revision = commit(repository, 'immutable fixture');
    const first = runCheck(repository, revision);
    expect(first.exitCode, outputOf(first)).toBe(0);

    write(repository, 'README.md', '<!-- wbs-index {"schemaVersion":99} -->\n');
    rmSync(join(repository, 'docs/guide.md'));
    const second = runCheck(repository, revision);

    expect(second.exitCode, outputOf(second)).toBe(0);
    expect(pipeText(second.stdout, 'second index stdout')).toBe(
      pipeText(first.stdout, 'first index stdout'),
    );
  });

  test('refuses duplicate stable module identities across nested indexes', () => {
    const repository = createRepository();
    writeFixture(repository);
    write(
      repository,
      'apps/alpha/packages/child/README.md',
      indexSource('Child', metadata('module.alpha', [{ kind: 'path', path: 'index.ts' }]), [
        '## Child API',
        '',
        '- [Entrypoint](index.ts)',
      ]),
    );

    expectRefusal(
      runCheck(repository, commit(repository, 'duplicate module identity')),
      'duplicate index module identity: module.alpha',
    );
  });

  test('fails closed when the selected candidate declares no index metadata', () => {
    const repository = createRepository();
    write(repository, 'README.md', '# Ordinary readme\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'missing index metadata')),
      'selected candidate contains no wbs indexes',
    );
  });

  test('checks used reference-style links while ignoring images and external autolinks', () => {
    const repository = createRepository();
    writeFixture(repository);
    const rootPath = join(repository, 'README.md');
    const source = Bun.file(rootPath).text();
    return source.then((markdown) => {
      writeFileSync(
        rootPath,
        markdown.replace(
          '- [Guide](docs/guide.md#details)',
          '- [Guide][guide]\n- ![Decorative missing image](missing.png)\n- <https://example.test>\n\n[guide]: docs/guide.md#details',
        ),
        'utf8',
      );
      const invocation = runCheck(repository, commit(repository, 'reference link'));
      expect(invocation.exitCode, outputOf(invocation)).toBe(0);
    });
  });

  test('refuses a reference-style Markdown link to an absent path', () => {
    const repository = createRepository();
    writeFixture(repository);
    const rootPath = join(repository, 'README.md');
    const source = Bun.file(rootPath).text();
    return source.then((markdown) => {
      writeFileSync(
        rootPath,
        markdown.replace(
          '- [Guide](docs/guide.md#details)',
          '- [Guide][guide]\n\n[guide]: docs/absent.md',
        ),
        'utf8',
      );
      expectRefusal(
        runCheck(repository, commit(repository, 'absent reference target')),
        'Markdown path absent in README.md: docs/absent.md',
      );
    });
  });

  test('refuses a reference-style Markdown link whose path has the wrong case', () => {
    const repository = createRepository();
    writeFixture(repository);
    const rootPath = join(repository, 'README.md');
    const source = Bun.file(rootPath).text();
    return source.then((markdown) => {
      writeFileSync(
        rootPath,
        markdown.replace(
          '- [Guide](docs/guide.md#details)',
          '- [Guide][guide]\n\n[guide]: docs/Guide.md#details',
        ),
        'utf8',
      );
      expectRefusal(
        runCheck(repository, commit(repository, 'wrong-case reference target')),
        'Markdown path case mismatch in README.md: docs/Guide.md -> docs/guide.md',
      );
    });
  });

  test('refuses a reference-style Markdown link to an absent anchor', () => {
    const repository = createRepository();
    writeFixture(repository);
    const rootPath = join(repository, 'README.md');
    const source = Bun.file(rootPath).text();
    return source.then((markdown) => {
      writeFileSync(
        rootPath,
        markdown.replace(
          '- [Guide](docs/guide.md#details)',
          '- [Guide][guide]\n\n[guide]: docs/guide.md#missing',
        ),
        'utf8',
      );
      expectRefusal(
        runCheck(repository, commit(repository, 'absent reference anchor')),
        'Markdown anchor absent in README.md: docs/guide.md#missing',
      );
    });
  });

  test('refuses glob characters in a reference-style Markdown link', () => {
    const repository = createRepository();
    writeFixture(repository);
    const rootPath = join(repository, 'README.md');
    const source = Bun.file(rootPath).text();
    return source.then((markdown) => {
      writeFileSync(rootPath, `${markdown}\n[Tests][tests]\n\n[tests]: tests/*.ts\n`, 'utf8');
      expectRefusal(
        runCheck(repository, commit(repository, 'glob reference target')),
        'Markdown link contains a glob in README.md: tests/*.ts',
      );
    });
  });

  test('refuses a fenced HTML example as an anchor target', () => {
    const repository = createRepository();
    writeFixture(repository);
    write(repository, 'docs/guide.md', '# Guide\n\n```html\n<a id="details"></a>\n```\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'fenced anchor example')),
      'Markdown anchor absent in README.md: docs/guide.md#details',
    );
  });

  test('does not treat a fenced metadata example as an index envelope', () => {
    const repository = createRepository();
    const envelope = `<!-- wbs-index ${JSON.stringify(metadata('module.example', []))} -->`;
    write(repository, 'README.md', `# Example\n\n\`\`\`md\n${envelope}\n\`\`\`\n`);

    expectRefusal(
      runCheck(repository, commit(repository, 'fenced metadata example')),
      'selected candidate contains no wbs indexes',
    );
  });

  test('refuses an unlinked exact member symlink that escapes the candidate', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Symlink boundary',
        metadata('module.symlink', [{ kind: 'path', path: 'escape' }]),
        [],
      ),
    );
    symlinkSync('../../outside', join(repository, 'escape'));

    expectRefusal(
      runCheck(repository, commit(repository, 'unlinked exact escape')),
      'membership symlink escapes candidate in README.md: escape -> ../../outside',
    );
  });

  test('refuses an unlinked grouped member symlink that escapes the candidate', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Symlink boundary',
        metadata('module.symlink', [{ kind: 'directory-prefix', prefix: 'group', exclusions: [] }]),
        [],
      ),
    );
    mkdirSync(join(repository, 'group'));
    symlinkSync('../../../outside', join(repository, 'group/escape'));

    expectRefusal(
      runCheck(repository, commit(repository, 'unlinked grouped escape')),
      'membership symlink escapes candidate in README.md: group/escape -> ../../../outside',
    );
  });

  test('refuses an absolute member symlink target', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Symlink boundary',
        metadata('module.symlink', [{ kind: 'path', path: 'escape' }]),
        [],
      ),
    );
    symlinkSync('/outside', join(repository, 'escape'));

    expectRefusal(
      runCheck(repository, commit(repository, 'absolute member symlink')),
      'membership symlink escapes candidate in README.md: escape -> /outside',
    );
  });

  test('refuses a member symlink whose target is absent from the selected candidate', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Symlink boundary',
        metadata('module.symlink', [{ kind: 'path', path: 'missing' }]),
        [],
      ),
    );
    symlinkSync('not-selected', join(repository, 'missing'));

    expectRefusal(
      runCheck(repository, commit(repository, 'absent member symlink target')),
      'membership symlink target absent in README.md: missing -> not-selected',
    );
  });

  test('refuses a cycle in selected member symlinks', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Symlink boundary',
        metadata('module.symlink', [
          { kind: 'path', path: 'first' },
          { kind: 'path', path: 'second' },
        ]),
        [],
      ),
    );
    symlinkSync('second', join(repository, 'first'));
    symlinkSync('first', join(repository, 'second'));

    expectRefusal(
      runCheck(repository, commit(repository, 'cyclic member symlinks')),
      'membership symlink cycle in README.md: first',
    );
  });

  test('refuses an anchor spelling that exists only inside an HTML comment', () => {
    const repository = createRepository();
    writeFixture(repository);
    write(repository, 'docs/guide.md', '# Guide\n\n<!-- <a id="details"></a> -->\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'comment anchor example')),
      'Markdown anchor absent in README.md: docs/guide.md#details',
    );
  });

  test('refuses an anchor spelling inside an HTML raw-text element', () => {
    const repository = createRepository();
    writeFixture(repository);
    write(
      repository,
      'docs/guide.md',
      '# Guide\n\n<script>const example = \'<a id="details"></a>\';</script>\n',
    );

    expectRefusal(
      runCheck(repository, commit(repository, 'raw text anchor example')),
      'Markdown anchor absent in README.md: docs/guide.md#details',
    );
  });

  test('refuses an anchor spelling inside inert HTML template contents', () => {
    const repository = createRepository();
    writeFixture(repository);
    write(
      repository,
      'docs/guide.md',
      '# Guide\n\n<template><a id="details">Example</a></template>\n',
    );

    expectRefusal(
      runCheck(repository, commit(repository, 'template anchor example')),
      'Markdown anchor absent in README.md: docs/guide.md#details',
    );
  });

  test('accepts rendered HTML element ids and legacy anchor names', () => {
    const repository = createRepository();
    writeFixture(repository);
    write(
      repository,
      'docs/guide.md',
      '# Guide\n\n<section id="details">Details</section>\n\n<a name="legacy">Legacy</a>\n',
    );
    const rootPath = join(repository, 'README.md');
    const source = Bun.file(rootPath).text();

    return source.then((markdown) => {
      writeFileSync(rootPath, `${markdown}\n[Legacy](docs/guide.md#legacy)\n`, 'utf8');
      const invocation = runCheck(repository, commit(repository, 'rendered element anchors'));
      expect(invocation.exitCode, outputOf(invocation)).toBe(0);
    });
  });

  test('resolves a trailing-slash directory link', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'docs/README.md' }]), [
        '- [Docs](docs/#details)',
      ]),
    );
    write(repository, 'docs/README.md', '# Docs\n\n## Details\n');

    const invocation = runCheck(repository, commit(repository, 'directory links'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(0);
  });

  test('resolves a current-directory self link to its index README', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', []), ['- [Self](./#root)']),
    );

    const invocation = runCheck(repository, commit(repository, 'current-directory link'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(0);
  });

  test('refuses wrong case on a trailing-slash directory link', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'docs/README.md' }]), [
        '- [Docs](Docs/#details)',
      ]),
    );
    write(repository, 'docs/README.md', '# Docs\n\n## Details\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'wrong-case directory link')),
      'Markdown path case mismatch in README.md: Docs -> docs/README.md',
    );
  });

  test('refuses an absent trailing-slash directory link at its canonical path', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', []), ['- [Missing](missing/)']),
    );

    const invocation = runCheck(repository, commit(repository, 'absent directory link'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(1);
    expect(outputOf(invocation).trim()).toBe('Markdown path absent in README.md: missing');
  });

  test('uses the canonical directory path in a trailing-slash anchor diagnostic', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'docs/README.md' }]), [
        '- [Missing section](docs/#missing)',
      ]),
    );
    write(repository, 'docs/README.md', '# Docs\n');

    const invocation = runCheck(repository, commit(repository, 'directory anchor diagnostic'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(1);
    expect(outputOf(invocation).trim()).toBe('Markdown anchor absent in README.md: docs#missing');
  });

  test('refuses a Markdown heading rendered inside an inert HTML template', () => {
    const repository = createRepository();
    writeFixture(repository);
    write(repository, 'docs/guide.md', '# Guide\n\n<template>\n\n## Details\n\n</template>\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'template Markdown heading')),
      'Markdown anchor absent in README.md: docs/guide.md#details',
    );
  });

  test('slugs the rendered text of inline HTML in a Markdown heading', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'guide.md' }]), [
        '- [Guide](guide.md#release-notes)',
      ]),
    );
    write(
      repository,
      'guide.md',
      '# Guide\n\n## Release <template>Draft</template> <em>Notes</em>\n',
    );

    const invocation = runCheck(repository, commit(repository, 'rendered heading text'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(0);
  });

  test('allocates heading collisions against every previously used slug', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'guide.md' }]), [
        '- [Third collision](guide.md#a-1-1)',
      ]),
    );
    write(repository, 'guide.md', '# A\n\n## A\n\n## A-1\n');

    const invocation = runCheck(repository, commit(repository, 'heading slug collisions'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(0);
  });

  test('does not let source HTML forge an internal Markdown-heading marker', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'guide.md' }]), [
        '- [Forged](guide.md#forged)',
      ]),
    );
    write(
      repository,
      'guide.md',
      '# Real\n\n<div><WBS-INDEX-HEADING>Forged</WBS-INDEX-HEADING></div>\n',
    );

    expectRefusal(
      runCheck(repository, commit(repository, 'forged heading marker')),
      'Markdown anchor absent in README.md: guide.md#forged',
    );
  });

  test('does not let rendered heading text forge an internal Markdown-heading marker', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'guide.md' }]), [
        '- [Forged](guide.md#forged)',
      ]),
    );
    write(
      repository,
      'guide.md',
      '# Real\n\n## &lt;wbs-index-**heading**>Forged&lt;/wbs-index-**heading**>\n',
    );

    expectRefusal(
      runCheck(repository, commit(repository, 'rendered forged heading marker')),
      'Markdown anchor absent in README.md: guide.md#forged',
    );
  });

  test('preserves a leading UTF-8 BOM in a selected symlink target', () => {
    const repository = createRepository();
    const target = '\uFEFFdocs/guide.md';
    write(
      repository,
      'README.md',
      indexSource(
        'Root',
        metadata('module.root', [
          { kind: 'path', path: 'guide-link' },
          { kind: 'path', path: target },
        ]),
        ['- [Guide](guide-link#details)'],
      ),
    );
    write(repository, target, '# Guide\n\n## Details\n');
    symlinkSync(target, join(repository, 'guide-link'));

    const invocation = runCheck(repository, commit(repository, 'BOM symlink target'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(0);
  });

  test('names the exact BOM-prefixed target when a selected symlink is dangling', () => {
    const repository = createRepository();
    const target = '\uFEFFmissing.md';
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'missing-link' }]), []),
    );
    symlinkSync(target, join(repository, 'missing-link'));

    expectRefusal(
      runCheck(repository, commit(repository, 'dangling BOM symlink target')),
      `membership symlink target absent in README.md: missing-link -> ${target}`,
    );
  });

  test('refuses traversal through a selected regular-file component', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'docs/guide.md' }]), [
        '- [Guide](docs/guide.md/../guide.md#details)',
      ]),
    );
    write(repository, 'docs/guide.md', '# Guide\n\n## Details\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'regular-file path component')),
      'Markdown path component is not a directory in README.md: docs/guide.md',
    );
  });

  test('refuses a trailing separator on a selected regular file', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource('Root', metadata('module.root', [{ kind: 'path', path: 'guide.md' }]), [
        '- [Guide](guide.md/)',
      ]),
    );
    write(repository, 'guide.md', '# Guide\n');

    expectRefusal(
      runCheck(repository, commit(repository, 'regular file trailing separator')),
      'Markdown path component is not a directory in README.md: guide.md',
    );
  });

  test('resolves parent segments through selected directories and directory symlinks', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Root',
        metadata('module.root', [
          { kind: 'path', path: 'docs/guide.md' },
          { kind: 'path', path: 'docs/nested/keep.txt' },
          { kind: 'path', path: 'docs-link' },
        ]),
        [
          '- [Directory parent](docs/nested/../guide.md#details)',
          '- [Symlink directory](docs-link/guide.md#details)',
        ],
      ),
    );
    write(repository, 'docs/guide.md', '# Guide\n\n## Details\n');
    write(repository, 'docs/nested/keep.txt', 'keeps the selected directory concrete\n');
    symlinkSync('docs', join(repository, 'docs-link'));

    const invocation = runCheck(repository, commit(repository, 'directory component resolution'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(0);
  });

  test('permits finite reuse of a directory symlink after its expansion completes', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Root',
        metadata('module.root', [
          { kind: 'path', path: 'docs/guide.md' },
          { kind: 'path', path: 'docs-link' },
        ]),
        ['- [Guide](docs-link/../docs-link/guide.md#details)'],
      ),
    );
    write(repository, 'docs/guide.md', '# Guide\n\n## Details\n');
    symlinkSync('docs', join(repository, 'docs-link'));

    const invocation = runCheck(repository, commit(repository, 'finite symlink reuse'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(0);
  });

  test('resolves a directory README symlink before checking its anchor', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Root',
        metadata('module.root', [
          { kind: 'path', path: 'docs/README.md' },
          { kind: 'path', path: 'guide.md' },
        ]),
        ['- [Docs](docs/#details)'],
      ),
    );
    write(repository, 'guide.md', '# Guide\n\n## Details\n');
    mkdirSync(join(repository, 'docs'), { recursive: true });
    symlinkSync('../guide.md', join(repository, 'docs/README.md'));

    const invocation = runCheck(repository, commit(repository, 'directory README symlink'));
    expect(invocation.exitCode, outputOf(invocation)).toBe(0);
  });

  test('refuses a member symlink target that traverses through a selected regular file', () => {
    const repository = createRepository();
    write(
      repository,
      'README.md',
      indexSource(
        'Root',
        metadata('module.root', [
          { kind: 'path', path: 'broken-link' },
          { kind: 'path', path: 'docs/guide.md' },
        ]),
        [],
      ),
    );
    write(repository, 'docs/guide.md', '# Guide\n');
    symlinkSync('docs/guide.md/../guide.md', join(repository, 'broken-link'));

    expectRefusal(
      runCheck(repository, commit(repository, 'member regular-file component')),
      'membership symlink path component is not a directory in README.md: docs/guide.md',
    );
  });
});
