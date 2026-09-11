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

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-root-migration-'));
  repositories.push(repository);
  git(repository, ['init', '--initial-branch=main']);
  git(repository, ['config', 'user.email', 'root-migration@example.test']);
  git(repository, ['config', 'user.name', 'Root Migration Fixture']);
  return repository;
}

function commit(repository: string, message: string): string {
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '--message', message]);
  return git(repository, ['rev-parse', 'HEAD']);
}

function sourceBlocks(heading: string, blocks: string[], prefix: string): SourceBlock[] {
  return [
    {
      sourceId: `${prefix}.heading`,
      locator: { kind: 'heading' },
      sha256: hash(`## ${heading}`),
      destinationAnchor: `${prefix}-heading`,
    },
    ...blocks.map((block, index) => ({
      sourceId: `${prefix}.${String(index + 1).padStart(3, '0')}`,
      locator: { kind: 'block' as const, ordinal: index + 1 },
      sha256: hash(block),
      destinationAnchor: `${prefix}-${String(index + 1).padStart(3, '0')}`,
    })),
  ];
}

function destination(heading: string, blocks: string[], sourceBlocks: SourceBlock[]): string {
  const [headingBlock, ...paragraphs] = sourceBlocks;
  return [
    `<a id="${headingBlock.destinationAnchor}"></a>`,
    `<!-- root-source:${headingBlock.sourceId} -->`,
    '',
    `## ${heading}`,
    '',
    ...paragraphs.flatMap((entry, index) => [
      `<a id="${entry.destinationAnchor}"></a>`,
      `<!-- root-source:${entry.sourceId} -->`,
      '',
      blocks[index] ?? '',
      '',
    ]),
  ].join('\n');
}

function buildFixture(repository: string): { candidate: string; map: RootMigrationFixture } {
  const agentBlocks = ['A production check needs a watched negative and an adjacent proof.'];
  const landmineBlocks = ['- A current landmine belongs outside the root router.'];
  const findingBlocks = ['1. A current finding stays explicit until it is closed.'];
  const historicalAgents = `# Agent rules\n\n## Checks that cannot fail\n\n${agentBlocks.join('\n\n')}\n`;
  const historicalReadme = `# Router\n\n## Landmines\n\n${landmineBlocks.join('\n\n')}\n\n## Open findings\n\n${findingBlocks.join('\n\n')}\n`;
  write(repository, 'AGENTS.md', historicalAgents);
  write(repository, 'LLM_README.md', historicalReadme);
  const sourceRevision = commit(repository, 'historical roots');

  const agentSourceBlocks = sourceBlocks('Checks that cannot fail', agentBlocks, 'agents-r5');
  const landmineSourceBlocks = sourceBlocks('Landmines', landmineBlocks, 'router-landmines');
  const findingSourceBlocks = sourceBlocks('Open findings', findingBlocks, 'router-findings');
  const map: RootMigrationFixture = {
    schemaVersion: 1,
    migrationId: 'root-knowledge.v1',
    sources: [
      {
        sourcePath: 'AGENTS.md',
        sourceRevision,
        sourceBlob: git(repository, [`rev-parse`, `${sourceRevision}:AGENTS.md`]),
        sourceHeading: 'Checks that cannot fail',
        destinationPath: 'docs/findings/checks-that-cannot-fail.md',
        blocks: agentSourceBlocks,
      },
      {
        sourcePath: 'LLM_README.md',
        sourceRevision,
        sourceBlob: git(repository, [`rev-parse`, `${sourceRevision}:LLM_README.md`]),
        sourceHeading: 'Landmines',
        destinationPath: 'docs/findings/current.md',
        blocks: landmineSourceBlocks,
      },
      {
        sourcePath: 'LLM_README.md',
        sourceRevision,
        sourceBlob: git(repository, [`rev-parse`, `${sourceRevision}:LLM_README.md`]),
        sourceHeading: 'Open findings',
        destinationPath: 'docs/findings/current.md',
        blocks: findingSourceBlocks,
      },
    ],
  };

  write(
    repository,
    'AGENTS.md',
    [
      '# Agent rules',
      '',
      'Keep the operational rule.',
      '',
      '[Incident catalogue](docs/findings/checks-that-cannot-fail.md)',
      '',
    ].join('\n'),
  );
  write(
    repository,
    'LLM_README.md',
    ['# Router', '', '[Findings](docs/findings/README.md#current-findings)', ''].join('\n'),
  );
  write(
    repository,
    'docs/findings/checks-that-cannot-fail.md',
    `# Checks that cannot fail\n\n${destination('Checks that cannot fail', agentBlocks, agentSourceBlocks)}`,
  );
  write(
    repository,
    'docs/findings/current.md',
    `# Current findings\n\n${destination('Landmines', landmineBlocks, landmineSourceBlocks)}\n${destination('Open findings', findingBlocks, findingSourceBlocks)}`,
  );
  write(
    repository,
    'docs/findings/README.md',
    '# Findings\n\n## Current findings\n\n- [Current findings](current.md#router-findings-heading)\n- [R5 catalogue](checks-that-cannot-fail.md#agents-r5-heading)\n',
  );
  write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(map, null, 2)}\n`);
  return { candidate: commit(repository, 'migrated roots'), map };
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
      blockCount: 6,
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
      'duplicate root source id: agents-r5.heading',
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
      'destination anchor must occur once: docs/findings/current.md#router-findings-heading (found 2)',
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
      'destination anchor must occur once: docs/findings/current.md#router-findings-heading (found 0)',
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
      'duplicate root destination: docs/findings/checks-that-cannot-fail.md#agents-r5-heading',
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
      'root source block is not mapped: AGENTS.md#Checks that cannot fail block 1',
    );

    const payloadRepository = createRepository();
    buildFixture(payloadRepository);
    const destinationPath = 'docs/findings/checks-that-cannot-fail.md';
    write(
      payloadRepository,
      destinationPath,
      readFileSync(join(payloadRepository, destinationPath), 'utf8').replace(
        'A production check needs a watched negative',
        'A production check lost its observed wording',
      ),
    );
    expectRefusal(
      runCheck(payloadRepository, commit(payloadRepository, 'rewrite payload')),
      'mapped destination payload must occur once: docs/findings/checks-that-cannot-fail.md#agents-r5-001 (found 0)',
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
    locatorFixture.map.sources[0].blocks[1].locator = { kind: 'block', ordinal: 2 };
    write(
      locatorRepository,
      'docs/findings/root-migration.v1.json',
      `${JSON.stringify(locatorFixture.map)}\n`,
    );
    expectRefusal(
      runCheck(locatorRepository, commit(locatorRepository, 'out of range locator')),
      'historical source locator absent: agents-r5.001',
    );
  });

  test('refuses changed historical locator content and wrong-case Markdown destinations', () => {
    const repository = createRepository();
    const fixture = buildFixture(repository);
    fixture.map.sources[0].blocks[1].sha256 = '0'.repeat(64);
    write(repository, 'docs/findings/root-migration.v1.json', `${JSON.stringify(fixture.map)}\n`);
    expectRefusal(
      runCheck(repository, commit(repository, 'bad historical locator')),
      'historical source content digest mismatch: agents-r5.001',
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
});
