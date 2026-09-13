import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import { createProjectGraphAsync, type ProjectGraph } from 'nx/src/devkit-exports';

import { productConstraints, readProjects } from '../workspace-projects.mjs';

const WORKSPACE = new URL('../../../', import.meta.url);

const EXPECTED_WBS_PROJECTS = [
  ['apps/wbs/be-01', 'wbs-be-01'],
  ['apps/wbs/fe-01', 'wbs-fe-01'],
  ['apps/wbs/gw-01', 'wbs-gw-01'],
  ['apps/wbs/mcp-01', 'wbs-mcp-01'],
  ['libs/wbs/adapters/auth', 'wbs-auth'],
  ['libs/wbs/adapters/config', 'wbs-config'],
  ['libs/wbs/adapters/observability', 'wbs-observability'],
  ['libs/wbs/adapters/realtime', 'wbs-realtime'],
  ['libs/wbs/adapters/runtime-portable', 'wbs-runtime-portable'],
  ['libs/wbs/adapters/solver-py', 'wbs-solver-py'],
  ['libs/wbs/adapters/solver-supervisor-protocol', 'wbs-solver-supervisor-protocol'],
  ['libs/wbs/adapters/store-memory', 'wbs-store-memory'],
  ['libs/wbs/adapters/store-sqlite', 'wbs-store-sqlite'],
  ['libs/wbs/application/conformance', 'wbs-conformance'],
  ['libs/wbs/application/core', 'wbs-core'],
  ['libs/wbs/domain/contracts', 'wbs-contracts'],
  ['libs/wbs/domain/domain', 'wbs-domain'],
  ['libs/wbs/domain/validation', 'wbs-validation'],
] as const;

const EXPECTED_WBS_TAGS: Readonly<
  Record<(typeof EXPECTED_WBS_PROJECTS)[number][1], readonly string[]>
> = {
  'wbs-be-01': ['scope:app', 'type:app', 'runtime:bun', 'ring:adapter', 'product:wbs'],
  'wbs-fe-01': ['scope:app', 'type:app', 'runtime:browser', 'ring:adapter', 'product:wbs'],
  'wbs-gw-01': ['scope:app', 'type:app', 'runtime:bun', 'ring:adapter', 'product:wbs'],
  'wbs-mcp-01': ['scope:app', 'type:app', 'runtime:bun', 'ring:adapter', 'product:wbs'],
  'wbs-auth': ['scope:shared', 'type:auth', 'runtime:bun', 'ring:adapter', 'product:wbs'],
  'wbs-config': ['scope:shared', 'type:config', 'runtime:bun', 'ring:adapter', 'product:wbs'],
  'wbs-observability': [
    'scope:shared',
    'type:observability',
    'ring:adapter',
    'runtime:bun',
    'product:wbs',
  ],
  'wbs-realtime': [
    'scope:shared',
    'type:realtime',
    'runtime:browser',
    'ring:adapter',
    'product:wbs',
  ],
  'wbs-runtime-portable': ['scope:shared', 'ring:adapter', 'runtime:isomorphic', 'product:wbs'],
  'wbs-solver-py': ['scope:lib', 'type:lib', 'runtime:python', 'ring:adapter', 'product:wbs'],
  'wbs-solver-supervisor-protocol': [
    'scope:shared',
    'type:contracts',
    'runtime:isomorphic',
    'ring:adapter',
    'product:wbs',
  ],
  'wbs-store-memory': ['scope:shared', 'ring:adapter', 'runtime:isomorphic', 'product:wbs'],
  'wbs-store-sqlite': ['scope:shared', 'ring:adapter', 'runtime:bun', 'product:wbs'],
  'wbs-conformance': ['scope:shared', 'ring:application', 'runtime:bun', 'product:wbs'],
  'wbs-core': ['scope:shared', 'ring:application', 'runtime:isomorphic', 'product:wbs'],
  'wbs-contracts': [
    'scope:shared',
    'type:contracts',
    'runtime:isomorphic',
    'ring:domain',
    'product:wbs',
  ],
  'wbs-domain': ['scope:shared', 'type:domain', 'runtime:isomorphic', 'ring:domain', 'product:wbs'],
  'wbs-validation': [
    'scope:shared',
    'type:validation',
    'runtime:isomorphic',
    'ring:domain',
    'product:wbs',
  ],
};

const EXPECTED_ALIAS_KEYS = [
  '@wbs/auth',
  '@wbs/be-01',
  '@wbs/config',
  '@wbs/conformance',
  '@wbs/conformance/*',
  '@wbs/contracts',
  '@wbs/contracts/solver/build-request',
  '@wbs/contracts/solver/materialise-optimized',
  '@wbs/contracts/solver/optimized-result',
  '@wbs/contracts/solver/parse-solver-response',
  '@wbs/contracts/solver/plan-infeasible',
  '@wbs/contracts/solver/quantised-baseline',
  '@wbs/contracts/solver/revalidate-solver-result',
  '@wbs/contracts/solver/solver-failure-disposition',
  '@wbs/contracts/solver/supervisor-protocol',
  '@wbs/contracts/ws-frames',
  '@wbs/core',
  '@wbs/core/*',
  '@wbs/deploy-contract',
  '@wbs/domain',
  '@wbs/domain/arrange-siblings',
  '@wbs/domain/assumed-duration',
  '@wbs/domain/canonical-schedule-input',
  '@wbs/domain/deadline-offsets',
  '@wbs/domain/dependency-reach',
  '@wbs/domain/effective-service',
  '@wbs/domain/effective-tag',
  '@wbs/domain/effective-team',
  '@wbs/domain/external-system',
  '@wbs/domain/is-within',
  '@wbs/domain/label-mismatch',
  '@wbs/domain/marker-color',
  '@wbs/domain/priority-band',
  '@wbs/domain/progress',
  '@wbs/domain/stored-vocabularies',
  '@wbs/domain/tree-order',
  '@wbs/domain/workday',
  '@wbs/gw-01',
  '@wbs/observability',
  '@wbs/realtime',
  '@wbs/runtime-portable',
  '@wbs/runtime-portable/testing',
  '@wbs/store-memory',
  '@wbs/store-memory/*',
  '@wbs/store-sqlite',
  '@wbs/store-sqlite/*',
  '@wbs/tool-compose',
  '@wbs/tool-env',
  '@wbs/tool-test-scratch',
  '@wbs/validation',
  '@wbs/validation/fixtures',
] as const;

const EXPECTED_ALIAS_ROOTS = [
  ['@wbs/contracts/solver/supervisor-protocol', 'libs/wbs/adapters/solver-supervisor-protocol'],
  ['@wbs/conformance', 'libs/wbs/application/conformance'],
  ['@wbs/contracts', 'libs/wbs/domain/contracts'],
  ['@wbs/core', 'libs/wbs/application/core'],
  ['@wbs/domain', 'libs/wbs/domain/domain'],
  ['@wbs/runtime-portable', 'libs/wbs/adapters/runtime-portable'],
  ['@wbs/store-memory', 'libs/wbs/adapters/store-memory'],
  ['@wbs/store-sqlite', 'libs/wbs/adapters/store-sqlite'],
  ['@wbs/validation', 'libs/wbs/domain/validation'],
  ['@wbs/auth', 'libs/wbs/adapters/auth'],
  ['@wbs/be-01', 'apps/wbs/be-01'],
  ['@wbs/config', 'libs/wbs/adapters/config'],
  ['@wbs/gw-01', 'apps/wbs/gw-01'],
  ['@wbs/observability', 'libs/wbs/adapters/observability'],
  ['@wbs/realtime', 'libs/wbs/adapters/realtime'],
  ['@wbs/deploy-contract', 'tools/tool-remote-scripts'],
  ['@wbs/tool-compose', 'tools/tool-compose'],
  ['@wbs/tool-env', 'tools/tool-remote-scripts'],
  ['@wbs/tool-test-scratch', 'tools/test/scratch'],
] as const;

const EXPECTED_GENERATED_OUTPUTS = [
  ['wbs-be-01', '{workspaceRoot}/dist/apps/wbs/be-01'],
  ['wbs-fe-01', '{workspaceRoot}/dist/apps/wbs/fe-01'],
  ['wbs-gw-01', '{workspaceRoot}/dist/apps/wbs/gw-01'],
  ['wbs-mcp-01', '{workspaceRoot}/dist/apps/wbs/mcp-01'],
  [
    'wbs-solver-supervisor-protocol',
    '{workspaceRoot}/dist/out-tsc/libs/wbs/adapters/solver-supervisor-protocol',
  ],
  ['wbs-core', '{workspaceRoot}/dist/libs/wbs/application/core/portable-composition.js'],
] as const;

interface ProjectManifest {
  readonly name: string;
  readonly tags: readonly string[];
  readonly targets: Readonly<Record<string, object>>;
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'workspace-projects-'));
  await Promise.all(
    ['apps', 'libs', 'tools'].map((group) => mkdir(join(workspace, group), { recursive: true })),
  );
  return workspace;
}

function manifestOf(name: string): ProjectManifest {
  return {
    name,
    tags: ['scope:lib', 'ring:domain', 'runtime:isomorphic'],
    targets: { test: { executor: 'nx:run-commands' } },
  };
}

async function writeManifest(
  workspace: string,
  root: string,
  manifest: ProjectManifest = manifestOf(root.replaceAll('/', '-')),
): Promise<string> {
  const directory = join(workspace, root);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'project.json');
  await writeFile(path, `${JSON.stringify(manifest)}\n`);
  return path;
}

async function runNxProjectNames(): Promise<string[]> {
  // `bunx nx` invoked through Bun.spawn exited 0 with empty stdout while the
  // installed executable returned the graph. Calling that same pinned Nx CLI
  // directly keeps empty output an observable failure instead of a parse race.
  const nxRun = Bun.spawn(
    [process.execPath, 'node_modules/.bin/nx', 'show', 'projects', '--json'],
    {
      cwd: new URL(WORKSPACE).pathname,
      env: { ...process.env, NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(nxRun.stdout).text(),
    new Response(nxRun.stderr).text(),
    nxRun.exited,
  ]);
  if (code !== 0) throw new Error(`Nx project graph failed: ${stderr}`);
  const names: unknown = JSON.parse(stdout);
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw new Error('Nx project graph did not return a string array');
  }
  return names;
}

async function nxProjectGraph(): Promise<ProjectGraph> {
  const inheritedDaemon = process.env['NX_DAEMON'];
  const inheritedIsolation = process.env['NX_ISOLATE_PLUGINS'];
  process.env['NX_DAEMON'] = 'false';
  process.env['NX_ISOLATE_PLUGINS'] = 'false';
  try {
    return await createProjectGraphAsync({ exitOnError: true });
  } finally {
    if (inheritedDaemon === undefined) delete process.env['NX_DAEMON'];
    else process.env['NX_DAEMON'] = inheritedDaemon;
    if (inheritedIsolation === undefined) delete process.env['NX_ISOLATE_PLUGINS'];
    else process.env['NX_ISOLATE_PLUGINS'] = inheritedIsolation;
  }
}

async function nxProjectPairs(): Promise<(readonly [string, string])[]> {
  const graph = await nxProjectGraph();
  return Object.values(graph.nodes)
    .map(({ name, data: { root } }) => [root, name] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

async function failureMessageOf(reading: Promise<readonly unknown[]>): Promise<string> {
  try {
    await reading;
  } catch (failure) {
    if (failure instanceof Error) return failure.message;
    throw new Error('readProjects rejected without an Error', { cause: failure });
  }
  throw new Error('readProjects unexpectedly succeeded');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('readProjects', () => {
  it('matches the Nx graph and includes its nested supervisor protocol project', async () => {
    const projects = await readProjects(WORKSPACE);
    const names = projects.map((project) => project.name).sort();
    const pairs = projects.map(({ root, name }) => [root, name] as const);

    expect(names).toContain('wbs-solver-supervisor-protocol');
    expect(names).toEqual((await runNxProjectNames()).sort());
    expect(pairs).toEqual(await nxProjectPairs());
  });

  it('pins every namespaced WBS root and Nx identity in the destination map', async () => {
    const projects = await readProjects(WORKSPACE);
    const wbsProjects = projects
      .filter(({ root }) => root.startsWith('apps/') || root.startsWith('libs/'))
      .map(({ root, name }) => [root, name] as const);

    expect(wbsProjects).toEqual([...EXPECTED_WBS_PROJECTS]);
  });

  it('preserves the WBS product axis on every namespaced app and library', async () => {
    const projects = await readProjects(WORKSPACE);
    const products = projects
      .filter(({ root }) => root.startsWith('apps/') || root.startsWith('libs/'))
      .map(({ root, tags }) => [root, tags.filter((tag) => tag.startsWith('product:'))] as const);

    // Proof: deleting `product:wbs` from libs/wbs/domain/contracts/project.json made this
    // assertion report that root with an empty product-tag array (2026-09-13).
    expect(products).toEqual(EXPECTED_WBS_PROJECTS.map(([root]) => [root, ['product:wbs']]));
  });

  it('preserves every mapped WBS project tag byte for byte', async () => {
    const projects = await readProjects(WORKSPACE);
    const tags = Object.fromEntries(
      projects
        .filter(({ root }) => root.startsWith('apps/') || root.startsWith('libs/'))
        .map(({ name, tags }) => [name, tags]),
    );

    // Proof: changing only wbs-realtime's runtime:browser tag to runtime:bun
    // made this exact manifest oracle report the changed tag (2026-09-13).
    expect(tags).toEqual(EXPECTED_WBS_TAGS);
  });

  it('preserves every public TypeScript alias key and maps it to its namespaced root', async () => {
    const tsconfig: unknown = JSON.parse(
      await readFile(new URL('../../../tsconfig.base.json', import.meta.url), 'utf8'),
    );
    if (
      typeof tsconfig !== 'object' ||
      tsconfig === null ||
      !('compilerOptions' in tsconfig) ||
      typeof tsconfig.compilerOptions !== 'object' ||
      tsconfig.compilerOptions === null ||
      !('paths' in tsconfig.compilerOptions) ||
      typeof tsconfig.compilerOptions.paths !== 'object' ||
      tsconfig.compilerOptions.paths === null
    ) {
      throw new Error('tsconfig.base.json has no compilerOptions.paths object');
    }

    const aliases = Object.entries(tsconfig.compilerOptions.paths);
    expect(aliases.map(([alias]) => alias).sort()).toEqual([...EXPECTED_ALIAS_KEYS]);

    for (const [alias, targets] of aliases) {
      if (!Array.isArray(targets) || !targets.every((target) => typeof target === 'string')) {
        throw new Error(`${alias} does not map to a string array`);
      }
      const expected = EXPECTED_ALIAS_ROOTS.find(
        ([prefix]) => alias === prefix || alias.startsWith(`${prefix}/`),
      );
      if (expected === undefined) throw new Error(`${alias} has no pinned destination root`);
      for (const target of targets) {
        // Proof: restoring @wbs/core to ./libs/core/src/index.ts made this
        // production tsconfig oracle report the old root (2026-09-13).
        expect(target).toStartWith(`./${expected[1]}/`);
      }
    }
  });

  it('maps every explicit app and library artifact output to its namespaced root', async () => {
    const projects = await readProjects(WORKSPACE);
    const generated = projects.flatMap(({ name, targets }) =>
      Object.values(targets).flatMap((target) => {
        if (!isRecord(target) || !Array.isArray(target['outputs'])) return [];
        return target['outputs']
          .filter(
            (output): output is string =>
              typeof output === 'string' &&
              (output.startsWith('{workspaceRoot}/dist/apps/') ||
                output.startsWith('{workspaceRoot}/dist/libs/') ||
                output.startsWith('{workspaceRoot}/dist/out-tsc/libs/')),
          )
          .map((output) => [name, output] as const);
      }),
    );

    // Proof: restoring the backend output to dist/apps/be-01 made this oracle
    // report the legacy root instead of dist/apps/wbs/be-01 (2026-09-13).
    expect(generated).toEqual([...EXPECTED_GENERATED_OUTPUTS]);
  });

  it('discovers projects below another project and ignores only named generated trees', async () => {
    const workspace = await createWorkspace();
    await Promise.all([
      writeManifest(workspace, 'libs/outer', manifestOf('outer')),
      writeManifest(workspace, 'libs/outer/nested/protocol', manifestOf('protocol')),
      writeManifest(workspace, 'libs/probe/application/nested/core', manifestOf('probe-core')),
      writeManifest(workspace, 'libs/outer/node_modules/hidden', manifestOf('dependency-copy')),
      writeManifest(workspace, 'libs/outer/dist/hidden', manifestOf('generated-copy')),
      writeManifest(workspace, 'libs/outer/.nx/hidden', manifestOf('nx-copy')),
      writeManifest(workspace, 'libs/outer/coverage/hidden', manifestOf('coverage-copy')),
      writeManifest(workspace, 'libs/outer/.git/hidden', manifestOf('git-copy')),
    ]);

    expect(await readProjects(workspace)).toEqual([
      expect.objectContaining({ root: 'libs/outer', name: 'outer' }),
      expect.objectContaining({ root: 'libs/outer/nested/protocol', name: 'protocol' }),
      expect.objectContaining({
        root: 'libs/probe/application/nested/core',
        name: 'probe-core',
      }),
    ]);
  });

  it('models an ordinary directory without a manifest', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'apps', 'ordinary'), { recursive: true });

    expect(await readProjects(workspace)).toEqual([]);
  });

  it('rejects a duplicate project name', async () => {
    const workspace = await createWorkspace();
    await Promise.all([
      writeManifest(workspace, 'apps/one', manifestOf('duplicate')),
      writeManifest(workspace, 'libs/two', manifestOf('duplicate')),
    ]);

    expect(await failureMessageOf(readProjects(workspace))).toBe(
      'duplicate project name duplicate: apps/one and libs/two',
    );
  });

  it('rejects malformed and structurally invalid manifests', async () => {
    const malformedWorkspace = await createWorkspace();
    const malformed = await writeManifest(malformedWorkspace, 'apps/broken');
    await writeFile(malformed, '{');
    expect(await failureMessageOf(readProjects(malformedWorkspace))).toMatch(
      /cannot parse apps\/broken\/project\.json/,
    );

    const invalidWorkspace = await createWorkspace();
    const invalid = await writeManifest(invalidWorkspace, 'apps/broken');
    await writeFile(
      invalid,
      '{"name":"broken","tags":["scope:lib","ring:domain","runtime:isomorphic"],"targets":[]}',
    );
    expect(await failureMessageOf(readProjects(invalidWorkspace))).toMatch(
      /apps\/broken\/project\.json has invalid targets/,
    );
  });

  it('rejects a manifest with no ring tag', async () => {
    const workspace = await createWorkspace();
    const manifest = manifestOf('missing-ring');
    await writeManifest(workspace, 'libs/missing-ring', {
      ...manifest,
      tags: manifest.tags.filter((tag) => !tag.startsWith('ring:')),
    });

    expect(await failureMessageOf(readProjects(workspace))).toMatch(
      /libs\/missing-ring\/project\.json must carry exactly one ring: tag; found 0/,
    );
  });

  it('rejects a manifest with two ring tags', async () => {
    const workspace = await createWorkspace();
    const manifest = manifestOf('duplicate-ring');
    await writeManifest(workspace, 'libs/duplicate-ring', {
      ...manifest,
      tags: [...manifest.tags, 'ring:adapter'],
    });

    expect(await failureMessageOf(readProjects(workspace))).toMatch(
      /libs\/duplicate-ring\/project\.json must carry exactly one ring: tag; found 2/,
    );
  });

  it('rejects a manifest with no targets', async () => {
    const workspace = await createWorkspace();
    await writeManifest(workspace, 'tools/no-targets', {
      ...manifestOf('no-targets'),
      targets: {},
    });

    expect(await failureMessageOf(readProjects(workspace))).toMatch(
      /tools\/no-targets\/project\.json must declare at least one target/,
    );
  });

  it('rejects a project directory reached through a symlink', async () => {
    const workspace = await createWorkspace();
    const source = join(workspace, 'source-project');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'project.json'), `${JSON.stringify(manifestOf('linked'))}\n`);
    await symlink(source, join(workspace, 'libs', 'linked'));

    expect(await failureMessageOf(readProjects(workspace))).toBe(
      'directory is symlinked: libs/linked',
    );
  });

  it('rejects every symlinked directory even when it has no manifest', async () => {
    const workspace = await createWorkspace();
    const source = join(workspace, 'ordinary-source');
    await mkdir(source, { recursive: true });
    await symlink(source, join(workspace, 'apps', 'linked'));

    expect(await failureMessageOf(readProjects(workspace))).toBe(
      'directory is symlinked: apps/linked',
    );
  });

  it('rejects each symlinked top-level project group before traversing it', async () => {
    const messages = await Promise.all(
      ['apps', 'libs', 'tools'].map(async (group) => {
        const workspace = await createWorkspace();
        const source = join(workspace, `borrowed-${group}`);
        await writeManifest(source, 'project', manifestOf(`borrowed-${group}`));
        await rm(join(workspace, group), { recursive: true });
        await symlink(source, join(workspace, group));
        try {
          return await failureMessageOf(readProjects(workspace));
        } catch (failure) {
          if (failure instanceof Error) return failure.message;
          throw failure;
        }
      }),
    );

    expect(messages).toEqual([
      'directory is symlinked: apps',
      'directory is symlinked: libs',
      'directory is symlinked: tools',
    ]);
  });

  it('rejects an unreadable directory', async () => {
    const workspace = await createWorkspace();
    const blocked = join(workspace, 'tools', 'blocked');
    await mkdir(blocked, { recursive: true });
    await chmod(blocked, 0o000);
    try {
      expect(await failureMessageOf(readProjects(workspace))).toMatch(
        /cannot read directory tools\/blocked/,
      );
    } finally {
      await chmod(blocked, 0o700);
    }
  });

  it('rejects an unreadable manifest', async () => {
    const workspace = await createWorkspace();
    const manifest = await writeManifest(workspace, 'tools/blocked');
    await chmod(manifest, 0o000);
    try {
      expect(await failureMessageOf(readProjects(workspace))).toMatch(
        /cannot read tools\/blocked\/project\.json/,
      );
    } finally {
      await chmod(manifest, 0o600);
    }
  });
});

describe('productConstraints', () => {
  it('generates one same-or-shared dependency rule for every discovered product', () => {
    const project = (name: string, tags: readonly string[]) => ({
      root: `libs/${name}`,
      name,
      tags,
      targets: { lint: {} },
    });

    expect(
      productConstraints([
        project('wbs-core', ['product:wbs']),
        project('probe-core', ['product:probe']),
        project('shared-core', ['product:shared']),
        project('infra', ['scope:infra']),
        project('wbs-adapter', ['product:wbs']),
      ]),
    ).toEqual([
      {
        sourceTag: 'product:probe',
        onlyDependOnLibsWithTags: ['product:probe', 'product:shared'],
      },
      { sourceTag: 'product:shared', onlyDependOnLibsWithTags: ['product:shared'] },
      {
        sourceTag: 'product:wbs',
        onlyDependOnLibsWithTags: ['product:wbs', 'product:shared'],
      },
    ]);
  });

  it('is satisfiable by every internal dependency in the actual repository graph', async () => {
    const projects = await readProjects(WORKSPACE);
    const constraints = productConstraints(projects);
    const graph = await nxProjectGraph();
    const violations: string[] = [];
    for (const project of projects) {
      const sourceProduct = project.tags.find((tag) => tag.startsWith('product:'));
      if (sourceProduct === undefined) continue;
      const constraint = constraints.find(({ sourceTag }) => sourceTag === sourceProduct);
      if (constraint === undefined)
        throw new Error(`missing product constraint for ${sourceProduct}`);
      for (const dependency of graph.dependencies[project.name] ?? []) {
        if (!Object.hasOwn(graph.nodes, dependency.target)) continue;
        const target = graph.nodes[dependency.target];
        if (
          !constraint.onlyDependOnLibsWithTags.some((allowed) =>
            target.data.tags?.includes(allowed),
          )
        ) {
          violations.push(`${project.name} -> ${target.name}`);
        }
      }
    }

    // Proof: deleting `product:wbs` from libs/wbs/domain/contracts/project.json made this
    // production-graph oracle report ten product:wbs -> contracts edges,
    // including core, all four apps, and store-sqlite (2026-09-13).
    expect(violations).toEqual([]);
  });
});
