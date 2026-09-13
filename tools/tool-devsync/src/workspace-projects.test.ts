import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import { createProjectGraphAsync, type ProjectGraph } from 'nx/src/devkit-exports';

import { productConstraints, readProjects } from '../workspace-projects.mjs';

const WORKSPACE = new URL('../../../', import.meta.url);

const EXPECTED_WBS_PROJECTS = [
  ['apps/be-01', 'be-01'],
  ['apps/fe-01', 'fe-01'],
  ['apps/gw-01', 'gw-01'],
  ['apps/mcp-01', 'mcp-01'],
  ['libs/auth', 'auth'],
  ['libs/config', 'config'],
  ['libs/conformance', 'conformance'],
  ['libs/contracts', 'contracts'],
  ['libs/contracts/solver/supervisor-protocol', 'solver-supervisor-protocol'],
  ['libs/core', 'core'],
  ['libs/domain', 'domain'],
  ['libs/observability', 'observability'],
  ['libs/realtime', 'realtime'],
  ['libs/runtime-portable', 'runtime-portable'],
  ['libs/solver-py', 'solver-py'],
  ['libs/store-memory', 'store-memory'],
  ['libs/store-sqlite', 'store-sqlite'],
  ['libs/validation', 'validation'],
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

describe('readProjects', () => {
  it('matches the Nx graph and includes its nested supervisor protocol project', async () => {
    const projects = await readProjects(WORKSPACE);
    const names = projects.map((project) => project.name).sort();
    const pairs = projects.map(({ root, name }) => [root, name] as const);

    expect(names).toContain('solver-supervisor-protocol');
    expect(names).toEqual((await runNxProjectNames()).sort());
    expect(pairs).toEqual(await nxProjectPairs());
  });

  it('pins every pre-move WBS root and Nx identity in the destination map', async () => {
    const projects = await readProjects(WORKSPACE);
    const wbsProjects = projects
      .filter(({ root }) => root.startsWith('apps/') || root.startsWith('libs/'))
      .map(({ root, name }) => [root, name] as const);

    expect(wbsProjects).toEqual([...EXPECTED_WBS_PROJECTS]);
  });

  it('activates the WBS product axis on every pre-move app and library', async () => {
    const projects = await readProjects(WORKSPACE);
    const products = projects
      .filter(({ root }) => root.startsWith('apps/') || root.startsWith('libs/'))
      .map(({ root, tags }) => [root, tags.filter((tag) => tag.startsWith('product:'))] as const);

    // Proof: deleting `product:wbs` from libs/contracts/project.json made this
    // assertion report that root with an empty product-tag array (2026-09-13).
    expect(products).toEqual(EXPECTED_WBS_PROJECTS.map(([root]) => [root, ['product:wbs']]));
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

    // Proof: deleting `product:wbs` from libs/contracts/project.json made this
    // production-graph oracle report ten product:wbs -> contracts edges,
    // including core, all four apps, and store-sqlite (2026-09-13).
    expect(violations).toEqual([]);
  });
});
