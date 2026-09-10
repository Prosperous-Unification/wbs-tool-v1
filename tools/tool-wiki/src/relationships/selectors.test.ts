import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

interface SelectorReport {
  declarations: {
    coverage: { declarationId: string; scope: string; families: string[] }[];
    edges: { relationshipId: string; status: string; provenance: { kind: string } }[];
    facts: {
      factId: string;
      actual: unknown;
      provenance: { kind: string; declarationId: string };
      identity: string;
    }[];
    unresolved: { relationshipId: string; reason: string }[];
  };
  extractors: { extractorId: string; version: string; blob: string }[];
  manifestInputs: { relationshipInputs: { inputId: string; blob: string }[] };
}

type Fact = Record<string, unknown>;
type Edge = Record<string, unknown>;

const pathsToRemove: string[] = [];
const cliPath = join(import.meta.dir, '..', 'cli.ts');

function write(repository: string, path: string, source: string): void {
  const absolutePath = join(repository, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
}

function runGit(repository: string, argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(invocation.exitCode, invocation.stderr.toString('utf8')).toBe(0);
  return invocation.stdout.toString('utf8').trim();
}

function commitAll(repository: string, message: string): string {
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '--message', message]);
  return runGit(repository, ['rev-parse', 'HEAD']);
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-selectors-'));
  pathsToRemove.push(repository);
  runGit(repository, ['init', '--initial-branch=main']);
  runGit(repository, ['config', 'user.email', 'selectors@example.test']);
  runGit(repository, ['config', 'user.name', 'Selector Fixture']);
  write(
    repository,
    'package.json',
    `${JSON.stringify({
      name: 'selector-fixture',
      private: true,
      scripts: { gate: 'nx run app:check' },
    })}\n`,
  );
  write(repository, 'nx.json', `${JSON.stringify({ plugins: [], useInferencePlugins: false })}\n`);
  write(
    repository,
    'tsconfig.json',
    `${JSON.stringify({
      compilerOptions: {
        declaration: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        target: 'ES2022',
      },
      include: ['src/index.ts'],
    })}\n`,
  );
  write(
    repository,
    'project.json',
    `${JSON.stringify({
      name: 'app',
      root: '.',
      sourceRoot: 'src',
      projectType: 'application',
      targets: {
        check: { executor: 'nx:run-commands', options: { command: 'bun test' } },
      },
    })}\n`,
  );
  write(repository, 'src/index.ts', "export const publicValue = 'fixture';\n");
  write(
    repository,
    'src/schema.ts',
    "const sqliteTable = <T>(name: string, columns: T) => ({ name, columns });\nconst text = (name: string) => name;\nexport const workItem = sqliteTable('work_item', { id: text('id') });\n",
  );
  write(
    repository,
    'src/routes.ts',
    "const defineEndpointShape = <T>(shape: T): T => shape;\nexport const listWork = defineEndpointShape({ method: 'GET', path: '/api/work-items' });\n",
  );
  write(
    repository,
    '.github/workflows/ci.yml',
    'name: ci\non: [push]\njobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Gate\n        run: bun run gate\n',
  );
  write(
    repository,
    'lefthook.yml',
    'pre-commit:\n  commands:\n    gate:\n      run: bun run gate\n',
  );
  write(
    repository,
    'Dockerfile',
    'FROM oven/bun:1.4.2 AS runtime\nCOPY generated/openapi.json /srv/openapi.json\nEXPOSE 3100\n',
  );
  write(repository, '.env.example', 'PORT=3100\nAUTH_MODE=local\n');
  write(repository, 'generated/openapi.json', '{"openapi":"3.1.0"}\n');
  write(repository, 'vendor/requirements.lock', 'solver==1.2.3 --hash=sha256:abcd\n');
  write(
    repository,
    'migrations/001_create_work_item/migration.sql',
    'CREATE TABLE `work_item` (`id` text PRIMARY KEY);\n',
  );
  return repository;
}

function blob(repository: string, path: string): string {
  return runGit(repository, ['hash-object', path]);
}

function blobBytes(repository: string, bytes: Uint8Array): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, 'hash-object', '--stdin'], {
    stdin: bytes,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(invocation.exitCode, invocation.stderr.toString('utf8')).toBe(0);
  return invocation.stdout.toString('utf8').trim();
}

function currentFacts(repository: string): Fact[] {
  return [
    {
      factId: 'script.gate',
      family: 'scripts',
      at: { kind: 'current' },
      kind: 'package-script',
      path: 'package.json',
      name: 'gate',
      expected: 'nx run app:check',
    },
    {
      factId: 'ci.gate',
      family: 'ci',
      at: { kind: 'current' },
      kind: 'ci-step-command',
      path: '.github/workflows/ci.yml',
      job: 'gate',
      step: 'Gate',
      expected: 'bun run gate',
    },
    {
      factId: 'hook.gate',
      family: 'hooks',
      at: { kind: 'current' },
      kind: 'hook-command',
      path: 'lefthook.yml',
      hook: 'pre-commit',
      command: 'gate',
      expected: 'bun run gate',
    },
    {
      factId: 'docker.expose',
      family: 'docker',
      at: { kind: 'current' },
      kind: 'docker-instruction',
      path: 'Dockerfile',
      stage: 'runtime',
      instruction: 'EXPOSE',
      ordinal: 1,
      expected: '3100',
    },
    {
      factId: 'generated.openapi',
      family: 'generated',
      at: { kind: 'current' },
      kind: 'generated-blob',
      path: 'generated/openapi.json',
      expectedBlob: blob(repository, 'generated/openapi.json'),
    },
    {
      factId: 'environment.auth-mode',
      family: 'environment',
      at: { kind: 'current' },
      kind: 'environment-variable',
      path: '.env.example',
      name: 'AUTH_MODE',
      expected: 'local',
    },
    {
      factId: 'port.backend',
      family: 'ports',
      at: { kind: 'current' },
      kind: 'port',
      path: '.env.example',
      name: 'PORT',
      expected: 3100,
    },
    {
      factId: 'table.work-item',
      family: 'tables',
      at: { kind: 'current' },
      kind: 'drizzle-table',
      path: 'src/schema.ts',
      exportName: 'workItem',
      expected: 'work_item',
    },
    {
      factId: 'migration.work-item',
      family: 'migrations',
      at: { kind: 'current' },
      kind: 'migration-table',
      path: 'migrations/001_create_work_item/migration.sql',
      operation: 'create',
      occurrence: 1,
      expected: 'work_item',
    },
    {
      factId: 'http.list-work',
      family: 'http',
      at: { kind: 'current' },
      kind: 'http-endpoint',
      path: 'src/routes.ts',
      exportName: 'listWork',
      expectedMethod: 'GET',
      expectedPath: '/api/work-items',
    },
    {
      factId: 'target.check',
      family: 'targets',
      at: { kind: 'current' },
      kind: 'nx-target',
      project: 'app',
      target: 'check',
      expectedConfiguration: {
        executor: 'nx:run-commands',
        options: { command: 'bun test' },
        configurations: {},
        parallelism: true,
      },
    },
    {
      factId: 'lock.solver',
      family: 'vendored-locks',
      at: { kind: 'current' },
      kind: 'vendored-lock',
      path: 'vendor/requirements.lock',
      expectedBlob: blob(repository, 'vendor/requirements.lock'),
    },
    {
      factId: 'external.public-api',
      family: 'external-consumers',
      at: { kind: 'current' },
      kind: 'external-consumer',
      system: 'partner-automation',
      contract: 'GET /api/work-items',
      knowledgeLimit: 'operator declaration; no external repository access',
    },
  ];
}

function declaration(facts: Fact[], edges: Edge[]): object {
  return {
    schemaVersion: 1,
    declarationId: 'fixture.relationships',
    selectorVersion: 1,
    coverage: 'selected-facts-only',
    facts,
    edges,
  };
}

function writeInputs(repository: string, declarationInput: object): string {
  write(repository, 'relationships.v1.json', `${JSON.stringify(declarationInput)}\n`);
  return writeRequest(repository, ['relationships.v1.json']);
}

function writeRequest(repository: string, declarationPaths: string[]): string {
  const requestPath = join(
    dirname(repository),
    `${repository.slice(repository.lastIndexOf('/') + 1)}.request.json`,
  );
  pathsToRemove.push(requestPath);
  writeFileSync(
    requestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      typescript: { configPaths: ['tsconfig.json'], publicEntrypoints: ['src/index.ts'] },
      declarationPaths,
    })}\n`,
    'utf8',
  );
  return requestPath;
}

function invoke(
  repository: string,
  revision: string,
  requestPath: string,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cliPath,
      'extract-relationships',
      'committed',
      repository,
      revision,
      requestPath,
    ],
    { cwd: repository, stderr: 'pipe', stdout: 'pipe' },
  );
}

function output(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${invocation.stdout?.toString('utf8') ?? ''}${invocation.stderr?.toString('utf8') ?? ''}`;
}

function report(invocation: ReturnType<typeof Bun.spawnSync>): SelectorReport {
  expect(invocation.exitCode, output(invocation)).toBe(0);
  return JSON.parse(invocation.stdout?.toString('utf8') ?? '') as SelectorReport;
}

afterEach(() => {
  for (const path of pathsToRemove.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('declared relationship selectors through the production CLI', () => {
  test('extracts every supported fact family and keeps declared and unresolved provenance explicit', () => {
    const repository = createRepository();
    const facts = currentFacts(repository);
    const requestPath = writeInputs(
      repository,
      declaration(facts, [
        {
          relationshipId: 'ci-invokes-script',
          kind: 'invokes',
          status: 'declared',
          source: { kind: 'fact', factId: 'ci.gate' },
          target: { kind: 'fact', factId: 'script.gate' },
        },
        {
          relationshipId: 'external-uses-http',
          kind: 'consumes',
          status: 'declared',
          source: { kind: 'fact', factId: 'external.public-api' },
          target: { kind: 'fact', factId: 'http.list-work' },
        },
        {
          relationshipId: 'dynamic-shell-read',
          kind: 'reads',
          status: 'unresolved',
          source: { kind: 'path', path: 'package.json' },
          target: { kind: 'path', path: '.env.example' },
          reason: 'the shell computes the variable name at runtime',
        },
      ]),
    );
    const revision = commitAll(repository, 'all selector families');
    const extracted = report(invoke(repository, revision, requestPath));

    expect(extracted.declarations.coverage).toEqual([
      {
        declarationId: 'fixture.relationships',
        scope: 'selected-facts-only',
        families: [
          'ci',
          'docker',
          'environment',
          'external-consumers',
          'generated',
          'hooks',
          'http',
          'migrations',
          'ports',
          'scripts',
          'tables',
          'targets',
          'vendored-locks',
        ],
      },
    ]);
    expect(extracted.declarations.facts.map(({ factId }) => factId).sort()).toEqual(
      facts.map((fact) => String(fact['factId'])).sort(),
    );
    expect(
      extracted.declarations.facts
        .filter(({ factId }) => factId !== 'external.public-api')
        .every(({ provenance }) => provenance.kind === 'extracted'),
    ).toBe(true);
    expect(
      extracted.declarations.facts.find(({ factId }) => factId === 'external.public-api')
        ?.provenance.kind,
    ).toBe('declared');
    expect(
      extracted.declarations.facts.every(({ identity }) => /^[0-9a-f]{64}$/.test(identity)),
    ).toBe(true);
    expect(
      extracted.declarations.edges.map(({ relationshipId, status }) => ({
        relationshipId,
        status,
      })),
    ).toEqual([
      { relationshipId: 'ci-invokes-script', status: 'declared' },
      { relationshipId: 'dynamic-shell-read', status: 'unresolved' },
      { relationshipId: 'external-uses-http', status: 'declared' },
    ]);
    expect(
      extracted.declarations.edges.every(({ provenance }) => provenance.kind === 'declared'),
    ).toBe(true);
    expect(extracted.declarations.unresolved).toEqual([
      {
        relationshipId: 'dynamic-shell-read',
        reason: 'the shell computes the variable name at runtime',
      },
    ]);
    expect(extracted.extractors.map(({ extractorId }) => extractorId)).toContain(
      'relationship-declarations',
    );
    expect(
      extracted.extractors.find(({ extractorId }) => extractorId === 'relationship-declarations')
        ?.version,
    ).toBe('v1');
    const relationshipInputs = extracted.manifestInputs.relationshipInputs.map(
      ({ inputId }) => inputId,
    );
    expect(relationshipInputs).toContain('declarations.edges');
    expect(relationshipInputs).toContain('declarations.facts');
    expect(relationshipInputs).toContain('declarations.unresolved');
  }, 20_000);

  test('reports the named fact or edge mismatch when a selector or authority is forged', () => {
    const mutations: {
      name: string;
      mutate(repository: string, facts: Fact[], edges: Edge[]): void;
      expected: string;
    }[] = [
      {
        name: 'selector',
        mutate: (_repository, facts) => {
          const port = facts.find((fact) => fact['factId'] === 'port.backend');
          if (port === undefined) throw new Error('port fixture absent');
          port['expected'] = 9999;
        },
        expected: 'fact port.backend authority-selector mismatch',
      },
      {
        name: 'edge',
        mutate: (_repository, _facts, edges) => {
          edges.push({
            relationshipId: 'forged-edge',
            kind: 'invokes',
            status: 'declared',
            source: { kind: 'fact', factId: 'missing.fact' },
            target: { kind: 'fact', factId: 'script.gate' },
          });
        },
        expected: 'relationship forged-edge source fact missing.fact is not declared',
      },
      {
        name: 'edge-path',
        mutate: (_repository, _facts, edges) => {
          edges.push({
            relationshipId: 'forged-path-edge',
            kind: 'reads',
            status: 'declared',
            source: { kind: 'path', path: 'missing.ts' },
            target: { kind: 'fact', factId: 'script.gate' },
          });
        },
        expected: 'relationship forged-path-edge source path missing.ts is not selected',
      },
      {
        name: 'port',
        mutate: (repository) => {
          write(repository, '.env.example', 'PORT=3200\nAUTH_MODE=local\n');
        },
        expected: 'fact port.backend authority-selector mismatch',
      },
      {
        name: 'route',
        mutate: (repository) => {
          write(
            repository,
            'src/routes.ts',
            "const defineEndpointShape = <T>(shape: T): T => shape;\nexport const listWork = defineEndpointShape({ method: 'GET', path: '/api/tasks' });\n",
          );
        },
        expected: 'fact http.list-work authority-selector mismatch',
      },
      {
        name: 'table',
        mutate: (repository) => {
          write(
            repository,
            'src/schema.ts',
            "const sqliteTable = <T>(name: string, columns: T) => ({ name, columns });\nconst text = (name: string) => name;\nexport const workItem = sqliteTable('task', { id: text('id') });\n",
          );
        },
        expected: 'fact table.work-item authority-selector mismatch',
      },
      {
        name: 'target',
        mutate: (repository) => {
          write(
            repository,
            'project.json',
            `${JSON.stringify({
              name: 'app',
              root: '.',
              sourceRoot: 'src',
              projectType: 'application',
              targets: {
                check: { executor: 'nx:run-commands', options: { command: 'bun test --watch' } },
              },
            })}\n`,
          );
        },
        expected: 'fact target.check authority-selector mismatch',
      },
    ];

    for (const fault of mutations) {
      const repository = createRepository();
      const facts = currentFacts(repository);
      const edges: Edge[] = [];
      fault.mutate(repository, facts, edges);
      const requestPath = writeInputs(repository, declaration(facts, edges));
      const failed = invoke(repository, commitAll(repository, `forged ${fault.name}`), requestPath);
      expect(failed.exitCode).toBe(1);
      expect(output(failed)).toContain(fault.expected);
    }
  }, 30_000);

  test('applies statically resolvable HTTP object overrides and refuses dynamic ones', () => {
    const cases = [
      {
        name: 'object spread',
        route:
          "const defineEndpointShape = <T>(shape: T): T => shape;\nexport const listWork = defineEndpointShape({ method: 'GET', path: '/api/work-items', ...{ path: '/changed' } });\n",
        expected:
          'fact http.list-work authority-selector mismatch: expected {"method":"GET","path":"/api/work-items"}; received {"method":"GET","path":"/changed"}',
      },
      {
        name: 'computed property',
        route:
          "const defineEndpointShape = <T>(shape: T): T => shape;\nexport const listWork = defineEndpointShape({ method: 'GET', path: '/api/work-items', ['path']: '/computed' });\n",
        expected:
          'fact http.list-work authority-selector mismatch: expected {"method":"GET","path":"/api/work-items"}; received {"method":"GET","path":"/computed"}',
      },
      {
        name: 'dynamic spread',
        route:
          "const defineEndpointShape = <T>(shape: T): T => shape;\ndeclare const runtime: { path?: string };\nexport const listWork = defineEndpointShape({ method: 'GET', path: '/api/work-items', ...runtime });\n",
        expected: 'fact http.list-work selector unsupported: HTTP object spread runtime',
      },
    ];
    for (const boundary of cases) {
      const repository = createRepository();
      write(repository, 'src/routes.ts', boundary.route);
      const fact = currentFacts(repository).find(
        (candidate) => candidate['factId'] === 'http.list-work',
      );
      if (fact === undefined) throw new Error('HTTP fixture absent');
      const requestPath = writeInputs(repository, declaration([fact], []));
      const failed = invoke(repository, commitAll(repository, boundary.name), requestPath);
      expect(failed.exitCode).toBe(1);
      expect(output(failed)).toContain(boundary.expected);
    }
  }, 15_000);

  test('reads current authorities only through exact selected candidate entries', () => {
    const repository = createRepository();
    const typescriptPackage = Bun.resolveSync('typescript/package.json', import.meta.dir);
    const hostFact = {
      factId: 'host.typescript-package',
      family: 'generated',
      at: { kind: 'current' },
      kind: 'generated-blob',
      path: 'node_modules/typescript/package.json',
      expectedBlob: blobBytes(repository, readFileSync(typescriptPackage)),
    };
    const hostRequest = writeInputs(repository, declaration([hostFact], []));
    const hostRevision = commitAll(repository, 'host authority escape');
    const escaped = invoke(repository, hostRevision, hostRequest);
    expect(escaped.exitCode).toBe(1);
    expect(output(escaped)).toContain(
      'fact host.typescript-package authority outside selected candidate: node_modules/typescript/package.json',
    );

    const linkedGitRepository = createRepository();
    const gitlinkRevision = commitAll(linkedGitRepository, 'gitlink authority base');
    symlinkSync('gitlink', join(linkedGitRepository, 'selected.env'));
    const gitlinkPort = currentFacts(linkedGitRepository).find(
      (candidate) => candidate['factId'] === 'port.backend',
    );
    if (gitlinkPort === undefined) throw new Error('gitlink port fixture absent');
    gitlinkPort['path'] = 'selected.env';
    const gitlinkRequest = writeInputs(linkedGitRepository, declaration([gitlinkPort], []));
    runGit(linkedGitRepository, ['add', 'relationships.v1.json', 'selected.env']);
    runGit(linkedGitRepository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${gitlinkRevision},gitlink`,
    ]);
    runGit(linkedGitRepository, ['commit', '--message', 'selected symlink resolves to gitlink']);
    const gitlink = invoke(
      linkedGitRepository,
      runGit(linkedGitRepository, ['rev-parse', 'HEAD']),
      gitlinkRequest,
    );
    expect(gitlink.exitCode).toBe(1);
    expect(output(gitlink)).toContain(
      'fact port.backend authority resolved outside selected candidate: selected.env -> gitlink',
    );

    const linkedRepository = createRepository();
    symlinkSync('.env.example', join(linkedRepository, 'selected.env'));
    const port = currentFacts(linkedRepository).find(
      (candidate) => candidate['factId'] === 'port.backend',
    );
    if (port === undefined) throw new Error('port fixture absent');
    port['path'] = 'selected.env';
    const linkedRequest = writeInputs(linkedRepository, declaration([port], []));
    const linked = report(
      invoke(
        linkedRepository,
        commitAll(linkedRepository, 'selected authority symlink'),
        linkedRequest,
      ),
    );
    expect(linked.declarations.facts.map(({ factId, actual }) => ({ factId, actual }))).toEqual([
      { factId: 'port.backend', actual: 3100 },
    ]);
  }, 15_000);

  test('extracts migration tables only from complete executable SQL statements', () => {
    const cases = [
      {
        name: 'SQL string and comment',
        migration:
          "SELECT 'CREATE TABLE ghost';\n-- CREATE TABLE comment_ghost (`id` text);\n/* ALTER TABLE block_ghost ADD COLUMN name text; */\n",
        expected:
          'fact migration.work-item authority-selector mismatch: expected "ghost"; received <unresolved>',
      },
      {
        name: 'unsupported trailing SQL',
        migration: 'CREATE TABLE real (`id` text PRIMARY KEY);\ninvalid SQL after;\n',
        expected:
          'fact migration.work-item selector unsupported: migration statement 2 starts with INVALID',
      },
    ];
    for (const boundary of cases) {
      const repository = createRepository();
      write(repository, 'migrations/001_create_work_item/migration.sql', boundary.migration);
      const fact = currentFacts(repository).find(
        (candidate) => candidate['factId'] === 'migration.work-item',
      );
      if (fact === undefined) throw new Error('migration fixture absent');
      fact['expected'] = boundary.name === 'SQL string and comment' ? 'ghost' : 'real';
      const requestPath = writeInputs(repository, declaration([fact], []));
      const failed = invoke(repository, commitAll(repository, boundary.name), requestPath);
      expect(failed.exitCode).toBe(1);
      expect(output(failed)).toContain(boundary.expected);
    }
  }, 15_000);

  test('selects one exact occurrence from the real four-table migration', () => {
    const repository = createRepository();
    const migrationPath = 'migrations/teams/migration.sql';
    const realMigration = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      'apps/be-01/drizzle/20260806190000_add_teams_and_assignees/migration.sql',
    );
    write(repository, migrationPath, readFileSync(realMigration, 'utf8'));
    const tables = ['service_team', 'person', 'person_team', 'assignment'];
    const facts = tables.map((expected, index) => ({
      factId: `migration.teams.${expected}`,
      family: 'migrations',
      at: { kind: 'current' },
      kind: 'migration-table',
      path: migrationPath,
      operation: 'create',
      occurrence: index + 1,
      expected,
    }));
    const requestPath = writeInputs(repository, declaration(facts, []));
    const revision = commitAll(repository, 'real multi-table migration');
    const extracted = report(invoke(repository, revision, requestPath));
    expect(
      Object.fromEntries(
        extracted.declarations.facts.map(({ factId, actual }) => [factId, actual]),
      ),
    ).toEqual({
      'migration.teams.assignment': 'assignment',
      'migration.teams.person': 'person',
      'migration.teams.person_team': 'person_team',
      'migration.teams.service_team': 'service_team',
    });

    facts[3].expected = 'service_team';
    const mismatchRequest = writeInputs(repository, declaration(facts, []));
    const mismatch = invoke(
      repository,
      commitAll(repository, 'forged fourth table'),
      mismatchRequest,
    );
    expect(mismatch.exitCode).toBe(1);
    expect(output(mismatch)).toContain(
      'fact migration.teams.assignment authority-selector mismatch: expected "service_team"; received "assignment"',
    );
  }, 15_000);

  test('resolves a historical selector at its explicit Git base while checking current facts at the candidate', () => {
    const repository = createRepository();
    const historicalRevision = commitAll(repository, 'port 3100');
    write(repository, '.env.example', 'PORT=3200\nAUTH_MODE=local\n');
    const currentPort = currentFacts(repository).find((fact) => fact['factId'] === 'port.backend');
    if (currentPort === undefined) throw new Error('current port fixture absent');
    currentPort['expected'] = 3200;
    const facts = [currentPort];
    facts.push({
      ...currentPort,
      factId: 'port.backend-historical',
      at: { kind: 'historical', revision: historicalRevision },
      expected: 3100,
    });
    const requestPath = writeInputs(repository, declaration(facts, []));
    const revision = commitAll(repository, 'port 3200 with historical declaration');
    const extracted = report(invoke(repository, revision, requestPath));

    expect(extracted.declarations.facts.map(({ factId, actual }) => ({ factId, actual }))).toEqual([
      { factId: 'port.backend', actual: 3200 },
      { factId: 'port.backend-historical', actual: 3100 },
    ]);
  }, 15_000);

  test('fails closed for absent, unselected and malformed authorities and unavailable history', () => {
    const cases: {
      name: string;
      prepare(repository: string, fact: Fact): void;
      expected: string;
    }[] = [
      {
        name: 'absent',
        prepare: (_repository, fact) => {
          fact['path'] = 'missing.env';
        },
        expected: 'fact port.backend authority absent: missing.env',
      },
      {
        name: 'unselected directory',
        prepare: (_repository, fact) => {
          fact['path'] = 'src';
        },
        expected: 'fact port.backend authority outside selected candidate: src',
      },
      {
        name: 'malformed',
        prepare: (repository) => {
          write(repository, '.env.example', 'PORT\n');
        },
        expected: 'fact port.backend authority malformed: .env.example',
      },
      {
        name: 'history',
        prepare: (_repository, fact) => {
          fact['at'] = { kind: 'historical', revision: 'f'.repeat(40) };
        },
        expected: `fact port.backend historical base unavailable: ${'f'.repeat(40)}`,
      },
    ];
    for (const boundary of cases) {
      const repository = createRepository();
      const fact = currentFacts(repository).find(
        (candidate) => candidate['factId'] === 'port.backend',
      );
      if (fact === undefined) throw new Error('port fixture absent');
      boundary.prepare(repository, fact);
      const requestPath = writeInputs(repository, declaration([fact], []));
      const failed = invoke(
        repository,
        commitAll(repository, `${boundary.name} authority`),
        requestPath,
      );
      expect(failed.exitCode).toBe(1);
      expect(output(failed)).toContain(boundary.expected);
    }
  }, 20_000);

  test('fails closed for absent, unreadable and malformed declaration documents', () => {
    const cases: {
      name: string;
      declarationPath: string;
      prepare?(repository: string): void;
      expected: string;
    }[] = [
      {
        name: 'absent',
        declarationPath: 'missing.v1.json',
        expected: 'relationship declaration absent: missing.v1.json',
      },
      {
        name: 'unreadable',
        declarationPath: 'src',
        expected: 'relationship declaration unreadable: src',
      },
      {
        name: 'malformed',
        declarationPath: 'relationships.v1.json',
        prepare: (repository) => {
          write(repository, 'relationships.v1.json', '{ malformed\n');
        },
        expected: 'relationship declaration malformed: relationships.v1.json',
      },
    ];
    for (const boundary of cases) {
      const repository = createRepository();
      boundary.prepare?.(repository);
      const requestPath = writeRequest(repository, [boundary.declarationPath]);
      const failed = invoke(
        repository,
        commitAll(repository, `${boundary.name} declaration`),
        requestPath,
      );
      expect(failed.exitCode).toBe(1);
      expect(output(failed)).toContain(boundary.expected);
    }
  }, 15_000);

  test('rejects unknown declaration versions and duplicate identities at the JSON boundary', () => {
    const repository = createRepository();
    const facts = currentFacts(repository).filter(({ factId }) => factId === 'port.backend');
    const boundaries = [
      {
        input: { ...declaration(facts, []), selectorVersion: 99 },
        expected: 'selectorVersion must be 1',
      },
      {
        input: declaration([...facts, ...facts], []),
        expected: 'facts with unique factId values',
      },
      {
        input: declaration(facts, [
          {
            relationshipId: 'duplicate.edge',
            kind: 'reads',
            status: 'unresolved',
            source: { kind: 'path', path: 'package.json' },
            target: { kind: 'path', path: '.env.example' },
            reason: 'first unknown edge',
          },
          {
            relationshipId: 'duplicate.edge',
            kind: 'reads',
            status: 'unresolved',
            source: { kind: 'path', path: 'package.json' },
            target: { kind: 'path', path: '.env.example' },
            reason: 'second unknown edge',
          },
        ]),
        expected: 'edges with unique relationshipId values',
      },
    ];
    for (const [index, boundary] of boundaries.entries()) {
      const requestPath = writeInputs(repository, boundary.input);
      const failed = invoke(
        repository,
        commitAll(repository, `strict declaration ${String(index)}`),
        requestPath,
      );
      expect(failed.exitCode).toBe(1);
      expect(output(failed)).toContain(boundary.expected);
    }
    const requestRepository = createRepository();
    const validRequestPath = writeInputs(
      requestRepository,
      declaration(
        currentFacts(requestRepository).filter(({ factId }) => factId === 'port.backend'),
        [],
      ),
    );
    const requestRevision = commitAll(requestRepository, 'valid request paths');
    const validRequest = report(invoke(requestRepository, requestRevision, validRequestPath));
    expect(validRequest.declarations.facts).toHaveLength(1);
    const duplicateRequest = writeRequest(requestRepository, [
      'relationships.v1.json',
      'relationships.v1.json',
    ]);
    const requestFailure = invoke(requestRepository, requestRevision, duplicateRequest);
    expect(requestFailure.exitCode).toBe(1);
    expect(output(requestFailure)).toContain('unique relationship declaration paths');
  }, 20_000);

  test('rejects declaration, fact and relationship identities repeated across documents', () => {
    const cases = [
      {
        name: 'declaration',
        secondId: 'fixture.relationships',
        includeFactTwice: false,
        includeEdgeTwice: false,
        expected: 'relationship declarations must have unique declarationId values',
      },
      {
        name: 'fact',
        secondId: 'fixture.relationships.second',
        includeFactTwice: true,
        includeEdgeTwice: false,
        expected: 'relationship fact port.backend is declared in more than one document',
      },
      {
        name: 'edge',
        secondId: 'fixture.relationships.second',
        includeFactTwice: false,
        includeEdgeTwice: true,
        expected: 'relationship shared.edge is declared in more than one document',
      },
    ];
    for (const boundary of cases) {
      const repository = createRepository();
      const fact = currentFacts(repository).find(
        (candidate) => candidate['factId'] === 'port.backend',
      );
      if (fact === undefined) throw new Error('port fixture absent');
      const edge = {
        relationshipId: 'shared.edge',
        kind: 'reads',
        status: 'unresolved',
        source: { kind: 'path', path: 'package.json' },
        target: { kind: 'path', path: '.env.example' },
        reason: 'cross-document fixture',
      };
      const firstFacts = boundary.includeFactTwice ? [fact] : [];
      const firstEdges = boundary.includeEdgeTwice ? [edge] : [];
      write(
        repository,
        'first.v1.json',
        `${JSON.stringify(declaration(firstFacts, firstEdges))}\n`,
      );
      write(
        repository,
        'second.v1.json',
        `${JSON.stringify({
          ...declaration(firstFacts, firstEdges),
          declarationId: boundary.secondId,
        })}\n`,
      );
      const requestPath = writeRequest(repository, ['first.v1.json', 'second.v1.json']);
      const failed = invoke(
        repository,
        commitAll(repository, `cross-document duplicate ${boundary.name}`),
        requestPath,
      );
      expect(failed.exitCode).toBe(1);
      expect(output(failed)).toContain(boundary.expected);
    }
  }, 10_000);
});
