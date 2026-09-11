import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

interface SourceBlock {
  sourceId: string;
  locator: { kind: 'heading' } | { kind: 'block'; ordinal: number };
  sha256: string;
  destinationAnchor: string;
}

interface RootMigrationFixture {
  schemaVersion: number;
  migrationId: string;
  sources: {
    sourcePath: string;
    sourceRevision: string;
    sourceBlob: string;
    sourceHeading: string;
    destinationPath: string;
    blocks: SourceBlock[];
  }[];
}

const repositories: string[] = [];
const cliPath = join(import.meta.dir, '..', 'cli.ts');
const sourceRepository = join(import.meta.dir, '..', '..', '..', '..');

function git(repository: string, argv: string[]): string {
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

function writeBytes(repository: string, path: string, source: Uint8Array): void {
  const absolutePath = join(repository, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function hash(source: string): string {
  return new Bun.CryptoHasher('sha256').update(source).digest('hex');
}

function forgedSourceBlocks(source: string, heading: string): SourceBlock[] {
  const headingText = `## ${heading}`;
  const lines = source.split('\n');
  const start = lines.indexOf(headingText);
  expect(start).toBeGreaterThanOrEqual(0);
  const endOffset = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  const payloads = body.length === 0 ? [] : body.split(/\n\n+/);
  return [
    {
      sourceId: 'forged.migrations.heading',
      locator: { kind: 'heading' },
      sha256: hash(headingText),
      destinationAnchor: 'forged-migrations-heading',
    },
    ...payloads.map((payload, index) => ({
      sourceId: `forged.migrations.${String(index + 1).padStart(3, '0')}`,
      locator: { kind: 'block' as const, ordinal: index + 1 },
      sha256: hash(payload),
      destinationAnchor: `forged-migrations-${String(index + 1).padStart(3, '0')}`,
    })),
  ];
}

function forgedDestination(source: string, heading: string, blocks: SourceBlock[]): string {
  const headingText = `## ${heading}`;
  const lines = source.split('\n');
  const start = lines.indexOf(headingText);
  const endOffset = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  const payloads = body.length === 0 ? [] : body.split(/\n\n+/);
  return `${blocks
    .map((block, index) => {
      const payload = index === 0 ? headingText : payloads[index - 1];
      return `<a id="${block.destinationAnchor}"></a>\n<!-- root-source:${block.sourceId} -->\n\n${payload}`;
    })
    .join('\n\n')}\n`;
}

function createRepository(): string {
  const parent = mkdtempSync(join(tmpdir(), 'tool-wiki-root-migration-'));
  repositories.push(parent);
  const repository = join(parent, 'repository');
  const invocation = Bun.spawnSync(
    ['git', 'clone', '--quiet', '--shared', '--no-hardlinks', sourceRepository, repository],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  expect(invocation.exitCode, invocation.stderr.toString('utf8')).toBe(0);
  git(repository, ['config', 'user.email', 'root-migration@example.test']);
  git(repository, ['config', 'user.name', 'Root Migration Fixture']);
  return repository;
}

function commit(repository: string, message: string): string {
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '--message', message]);
  return git(repository, ['rev-parse', 'HEAD']);
}

function buildFixture(repository: string): { candidate: string; map: RootMigrationFixture } {
  const map = JSON.parse(
    readFileSync(join(repository, 'docs/findings/root-migration.v1.json'), 'utf8'),
  ) as RootMigrationFixture;
  return { candidate: git(repository, ['rev-parse', 'HEAD']), map };
}

function runCheck(repository: string, revision: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cliPath,
      'check-root-migration',
      'committed',
      repository,
      revision,
      'docs/findings/root-migration.v1.json',
    ],
    { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
  );
}

function output(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${Buffer.from(invocation.stdout ?? []).toString('utf8')}${Buffer.from(invocation.stderr ?? []).toString('utf8')}`;
}

function expectRefusal(invocation: ReturnType<typeof Bun.spawnSync>, message: string): void {
  const observed = output(invocation);
  expect(invocation.exitCode, observed).toBe(1);
  expect(observed).toContain(message);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true });
});

describe('root migration production CLI', () => {
  test('verifies historical source blocks, live exact destinations, root caps and links', () => {
    const repository = createRepository();
    const { candidate } = buildFixture(repository);
    const invocation = runCheck(repository, candidate);
    expect(invocation.exitCode, output(invocation)).toBe(0);
    expect(JSON.parse(Buffer.from(invocation.stdout ?? []).toString('utf8'))).toMatchObject({
      schemaVersion: 1,
      migrationId: 'root-knowledge.v1',
      selection: { kind: 'committed', revision: candidate },
      sourceCount: 3,
      blockCount: 58,
      caps: { agents: 120, llmReadme: 150 },
    });
  });

  test('refuses a mapped destination deleted from the selected candidate', () => {
    const repository = createRepository();
    buildFixture(repository);
    rmSync(join(repository, 'docs/findings/checks-that-cannot-fail.md'));
    expectRefusal(
      runCheck(repository, commit(repository, 'delete destination')),
      'mapped destination absent: docs/findings/checks-that-cannot-fail.md',
    );
  });

  test('refuses AGENTS at 121 lines', () => {
    const repository = createRepository();
    buildFixture(repository);
    write(
      repository,
      'AGENTS.md',
      `${Array.from({ length: 121 }, (_, index) => `line ${String(index + 1)}`).join('\n')}\n`,
    );
    expectRefusal(
      runCheck(repository, commit(repository, 'oversized agents')),
      'AGENTS.md exceeds 120 lines: 121',
    );
  });

  test('refuses LLM_README at 151 lines', () => {
    const repository = createRepository();
    buildFixture(repository);
    write(
      repository,
      'LLM_README.md',
      `${Array.from({ length: 151 }, (_, index) => `line ${String(index + 1)}`).join('\n')}\n`,
    );
    expectRefusal(
      runCheck(repository, commit(repository, 'oversized router')),
      'LLM_README.md exceeds 150 lines: 151',
    );
  });

  test('refuses malformed versions, path escape and symlink destinations', () => {
    const repository = createRepository();
    const fixture = buildFixture(repository);
    fixture.map.schemaVersion = 2;
    write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(fixture.map)}\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'unknown version')),
      'root migration schema',
    );

    const escapeRepository = createRepository();
    const escapeFixture = buildFixture(escapeRepository);
    escapeFixture.map.sources[0].destinationPath = '../escape.md';
    write(
      escapeRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(escapeFixture.map)}\n`,
    );
    expectRefusal(
      runCheck(escapeRepository, commit(escapeRepository, 'escaping destination')),
      'root migration path escapes candidate: ../escape.md',
    );

    const symlinkRepository = createRepository();
    buildFixture(symlinkRepository);
    rmSync(join(symlinkRepository, 'docs/findings/checks-that-cannot-fail.md'));
    symlinkSync('current.md', join(symlinkRepository, 'docs/findings/checks-that-cannot-fail.md'));
    expectRefusal(
      runCheck(symlinkRepository, commit(symlinkRepository, 'symlink destination')),
      'mapped destination is not a regular selected blob: docs/findings/checks-that-cannot-fail.md',
    );
  });

  test('refuses malformed JSON and a historical source blob substitution', () => {
    const repository = createRepository();
    buildFixture(repository);
    write(repository, 'docs/findings/root-migration.v1.json', '{');
    expectRefusal(
      runCheck(repository, commit(repository, 'malformed map')),
      'root migration JSON malformed:',
    );

    const blobRepository = createRepository();
    const fixture = buildFixture(blobRepository);
    fixture.map.sources[0].sourceBlob = '0'.repeat(40);
    write(
      blobRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(fixture.map)}\n`,
    );
    expectRefusal(
      runCheck(blobRepository, commit(blobRepository, 'substitute source blob')),
      'historical source blob mismatch: AGENTS.md',
    );
  });

  test('refuses absent historical authority and non-UTF-8 destination bytes', () => {
    const repository = createRepository();
    const fixture = buildFixture(repository);
    fixture.map.sources[0].sourceRevision = '0'.repeat(40);
    write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(fixture.map)}\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'absent source revision')),
      'cannot resolve historical root source AGENTS.md:',
    );

    const bytesRepository = createRepository();
    buildFixture(bytesRepository);
    writeBytes(bytesRepository, 'docs/findings/checks-that-cannot-fail.md', Uint8Array.of(0xff));
    expectRefusal(
      runCheck(bytesRepository, commit(bytesRepository, 'invalid destination UTF-8')),
      'cannot decode selected docs/findings/checks-that-cannot-fail.md: non-UTF-8 content:',
    );
  });

  test('refuses duplicate source identities and duplicate or missing destination anchors', () => {
    const repository = createRepository();
    const fixture = buildFixture(repository);
    fixture.map.sources[1].blocks[0].sourceId = fixture.map.sources[0].blocks[0].sourceId;
    write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(fixture.map)}\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'duplicate source')),
      'duplicate root source id: r5.catalogue.heading',
    );

    const duplicateRepository = createRepository();
    buildFixture(duplicateRepository);
    const destinationPath = 'docs/findings/current.md';
    const current = readFileSync(join(duplicateRepository, destinationPath), 'utf8');
    write(
      duplicateRepository,
      destinationPath,
      `${current}\n<a id="router-findings-heading"></a>\n`,
    );
    expectRefusal(
      runCheck(duplicateRepository, commit(duplicateRepository, 'duplicate anchor')),
      'mapped destination block mismatch: docs/findings/current.md#router-findings-003',
    );

    const missingRepository = createRepository();
    buildFixture(missingRepository);
    const path = 'docs/findings/current.md';
    write(
      missingRepository,
      path,
      readFileSync(join(missingRepository, path), 'utf8').replace(
        '<a id="router-findings-heading"></a>',
        '',
      ),
    );
    expectRefusal(
      runCheck(missingRepository, commit(missingRepository, 'missing anchor')),
      'unexpected root source marker: docs/findings/current.md#router.findings.heading',
    );
  });

  test('refuses duplicate source entries, locators and destination identities', () => {
    const repository = createRepository();
    const fixture = buildFixture(repository);
    fixture.map.sources.push(structuredClone(fixture.map.sources[0]));
    write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(fixture.map)}\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'duplicate source entry')),
      'duplicate root source entry:',
    );

    const locatorRepository = createRepository();
    const locatorFixture = buildFixture(locatorRepository);
    locatorFixture.map.sources[0].blocks[1].locator = { kind: 'heading' };
    write(
      locatorRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(locatorFixture.map)}\n`,
    );
    expectRefusal(
      runCheck(locatorRepository, commit(locatorRepository, 'duplicate locator')),
      'duplicate historical source locator in AGENTS.md#Checks that cannot fail: heading',
    );

    const destinationRepository = createRepository();
    const destinationFixture = buildFixture(destinationRepository);
    destinationFixture.map.sources[1].blocks[0].destinationAnchor =
      destinationFixture.map.sources[0].blocks[0].destinationAnchor;
    destinationFixture.map.sources[1].destinationPath =
      destinationFixture.map.sources[0].destinationPath;
    write(
      destinationRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(destinationFixture.map)}\n`,
    );
    expectRefusal(
      runCheck(destinationRepository, commit(destinationRepository, 'duplicate destination')),
      'duplicate root destination: docs/findings/checks-that-cannot-fail.md#r5-catalogue-heading',
    );
  });

  test('refuses incomplete maps and destination payload substitution', () => {
    const repository = createRepository();
    const fixture = buildFixture(repository);
    fixture.map.sources[0].blocks.shift();
    write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(fixture.map)}\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'omit heading')),
      'root source heading is not mapped: AGENTS.md#Checks that cannot fail',
    );

    const blockRepository = createRepository();
    const blockFixture = buildFixture(blockRepository);
    blockFixture.map.sources[0].blocks.pop();
    write(
      blockRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(blockFixture.map)}\n`,
    );
    expectRefusal(
      runCheck(blockRepository, commit(blockRepository, 'omit paragraph')),
      'root source block is not mapped: AGENTS.md#Checks that cannot fail block 51',
    );

    const payloadRepository = createRepository();
    buildFixture(payloadRepository);
    const destinationPath = 'docs/findings/checks-that-cannot-fail.md';
    write(
      payloadRepository,
      destinationPath,
      readFileSync(join(payloadRepository, destinationPath), 'utf8').replace(
        'R5 exists because this failure keeps recurring',
        'R5 once existed because this failure kept recurring',
      ),
    );
    expectRefusal(
      runCheck(payloadRepository, commit(payloadRepository, 'rewrite payload')),
      'mapped destination block mismatch: docs/findings/checks-that-cannot-fail.md#r5-catalogue-001',
    );
  });

  test('refuses absent historical headings and out-of-range block locators', () => {
    const repository = createRepository();
    const fixture = buildFixture(repository);
    fixture.map.sources[0].sourceHeading = 'Missing catalogue';
    write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(fixture.map)}\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'missing historical heading')),
      'historical source heading absent: Missing catalogue',
    );

    const locatorRepository = createRepository();
    const locatorFixture = buildFixture(locatorRepository);
    locatorFixture.map.sources[0].blocks[1].locator = { kind: 'block', ordinal: 52 };
    write(
      locatorRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(locatorFixture.map)}\n`,
    );
    expectRefusal(
      runCheck(locatorRepository, commit(locatorRepository, 'out of range locator')),
      'historical source locator absent: r5.catalogue.001',
    );
  });

  test('refuses changed historical locator content and wrong-case Markdown destinations', () => {
    const repository = createRepository();
    const fixture = buildFixture(repository);
    fixture.map.sources[0].blocks[1].sha256 = '0'.repeat(64);
    write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(fixture.map)}\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'bad historical locator')),
      'historical source content digest mismatch: r5.catalogue.001',
    );

    const linksRepository = createRepository();
    buildFixture(linksRepository);
    write(
      linksRepository,
      'LLM_README.md',
      '# Router\n\n[Findings](docs/Findings/README.md#current-findings)\n',
    );
    expectRefusal(
      runCheck(linksRepository, commit(linksRepository, 'wrong-case link')),
      'Markdown path case mismatch in LLM_README.md: docs/Findings/README.md -> docs/findings/README.md',
    );
  });

  test('refuses missing Markdown anchors and migrated headings retained at roots', () => {
    const repository = createRepository();
    buildFixture(repository);
    write(repository, 'LLM_README.md', '# Router\n\n[Findings](docs/findings/README.md#absent)\n');
    expectRefusal(
      runCheck(repository, commit(repository, 'missing linked anchor')),
      'Markdown anchor must occur once in LLM_README.md: docs/findings/README.md#absent',
    );

    const agentsRepository = createRepository();
    buildFixture(agentsRepository);
    write(agentsRepository, 'AGENTS.md', '# Rules\n\n## Checks that cannot fail\n');
    expectRefusal(
      runCheck(agentsRepository, commit(agentsRepository, 'retain incidents heading')),
      'AGENTS.md retains migrated incident catalogue',
    );

    const routerRepository = createRepository();
    buildFixture(routerRepository);
    write(routerRepository, 'LLM_README.md', '# Router\n\n## Open findings\n');
    expectRefusal(
      runCheck(routerRepository, commit(routerRepository, 'retain findings heading')),
      'LLM_README.md retains migrated mutable findings',
    );
  });

  test('refuses an absent Markdown destination', () => {
    const repository = createRepository();
    buildFixture(repository);
    write(repository, 'LLM_README.md', '# Router\n\n[Findings](docs/findings/absent.md)\n');
    expectRefusal(
      runCheck(repository, commit(repository, 'missing linked path')),
      'Markdown path absent in LLM_README.md: docs/findings/absent.md',
    );
  });

  test('refuses a candidate map that omits the trusted historical authority', () => {
    const emptyRepository = createRepository();
    const emptyFixture = buildFixture(emptyRepository);
    emptyFixture.map.sources = [];
    write(
      emptyRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(emptyFixture.map)}\n`,
    );
    expectRefusal(
      runCheck(emptyRepository, commit(emptyRepository, 'omit historical authority')),
      'root migration authority mismatch',
    );
  });

  test('refuses a candidate map that replaces the trusted historical authority', () => {
    const replacementRepository = createRepository();
    const replacementFixture = buildFixture(replacementRepository);
    const agents = readFileSync(join(replacementRepository, 'AGENTS.md'), 'utf8');
    const blocks = forgedSourceBlocks(agents, 'Migrations');
    replacementFixture.map.sources = [
      {
        sourcePath: 'AGENTS.md',
        sourceRevision: replacementFixture.candidate,
        sourceBlob: git(replacementRepository, [
          'rev-parse',
          `${replacementFixture.candidate}:AGENTS.md`,
        ]),
        sourceHeading: 'Migrations',
        destinationPath: 'docs/findings/forged.md',
        blocks,
      },
    ];
    write(
      replacementRepository,
      'docs/findings/forged.md',
      forgedDestination(agents, 'Migrations', blocks),
    );
    write(
      replacementRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(replacementFixture.map)}\n`,
    );
    expectRefusal(
      runCheck(replacementRepository, commit(replacementRepository, 'replace authority')),
      'root migration authority mismatch',
    );
  });

  test('refuses appended payload text', () => {
    const appendedRepository = createRepository();
    buildFixture(appendedRepository);
    const path = 'docs/findings/checks-that-cannot-fail.md';
    write(
      appendedRepository,
      path,
      readFileSync(join(appendedRepository, path), 'utf8').replace(
        '<a id="r5-catalogue-002"></a>',
        'Appended text outside the preserved payload.\n\n<a id="r5-catalogue-002"></a>',
      ),
    );
    expectRefusal(
      runCheck(appendedRepository, commit(appendedRepository, 'append mapped payload text')),
      'mapped destination block mismatch: docs/findings/checks-that-cannot-fail.md#r5-catalogue-001',
    );
  });

  test('refuses orphan source markers', () => {
    const orphanRepository = createRepository();
    buildFixture(orphanRepository);
    const path = 'docs/findings/checks-that-cannot-fail.md';
    const source = readFileSync(join(orphanRepository, path), 'utf8');
    write(
      orphanRepository,
      path,
      `${source}\n<a id="r5-catalogue-orphan"></a>\n<!-- root-source:r5.catalogue.orphan -->\n\nOrphan payload.\n`,
    );
    expectRefusal(
      runCheck(orphanRepository, commit(orphanRepository, 'append orphan source marker')),
      'unexpected root source marker: docs/findings/checks-that-cannot-fail.md#r5.catalogue.orphan',
    );
  });

  test('refuses an anchor moved away from the payload it owns', () => {
    const repository = createRepository();
    buildFixture(repository);
    const path = 'docs/findings/checks-that-cannot-fail.md';
    const source = readFileSync(join(repository, path), 'utf8');
    write(
      repository,
      path,
      `${source.replace('<a id="r5-catalogue-001"></a>\n', '')}\n<a id="r5-catalogue-001"></a>\n`,
    );
    expectRefusal(
      runCheck(repository, commit(repository, 'move mapped anchor')),
      'unexpected root source marker: docs/findings/checks-that-cannot-fail.md#r5.catalogue.001',
    );
  });

  test('resolves fragment-only links against their current document', () => {
    const repository = createRepository();
    buildFixture(repository);
    const source = readFileSync(join(repository, 'LLM_README.md'), 'utf8');
    write(repository, 'LLM_README.md', `${source}\n[Missing incident](#absent-incident)\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'missing same-document anchor')),
      'Markdown anchor must occur once in LLM_README.md: LLM_README.md#absent-incident',
    );
  });
});
