import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';
import { createProjectGraphAsync, type ProjectGraph } from 'nx/src/devkit-exports';

import { productConstraints, readProjects } from '../workspace-projects.mjs';

const WORKSPACE = new URL('../../../', import.meta.url);

// Every app and library, each one qualified by the product directory it sits
// in. The product is read back off the root below rather than spelled out per
// row, so a second product cannot be added here without its directory agreeing.
const EXPECTED_PRODUCT_PROJECTS = [
  ['apps/wbs/be-01', 'wbs-be-01'],
  ['apps/wbs/fe-01', 'wbs-fe-01'],
  ['apps/wbs/gw-01', 'wbs-gw-01'],
  ['apps/wbs/mcp-01', 'wbs-mcp-01'],
  // Proof: leaving this row out after tool-wiki moved to apps/wiki/cli failed the owning
  // Nx target on the exact extra `['apps/wiki/cli', 'wiki-cli']` tuple, and the product-axis
  // case below on its `['apps/wiki/cli', ['product:wiki']]` companion (2026-09-16).
  ['apps/wiki/cli', 'wiki-cli'],
  ['libs/shared/domain/validation', 'shared-validation'],
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

/**
 * The root ESLint config's `allow` list, each alias paired with the project it reaches. It is
 * repeated here rather than imported because loading `eslint.config.js` runs product lint policy
 * discovery at import time; `eslint-boundaries.test.ts` pins the list itself against the
 * effective config and fails once an entry stops being imported.
 */
const ALLOWED_INFRA_TO_PRODUCT_EDGES = [
  ['@wbs/contracts/solver/supervisor-protocol', 'wbs-solver-supervisor-protocol'],
  ['@wbs/domain', 'wbs-domain'],
] as const;

/** Every `from '…';` specifier under `root`, skipping comment lines that merely name one. */
async function importSpecifiersOf(root: string): Promise<readonly string[]> {
  const entries = await readdir(join(fileURLToPath(WORKSPACE), root), {
    recursive: true,
    withFileTypes: true,
  });
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  );
  return sources.flatMap((source) =>
    source
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .flatMap((line) => /from '([^']+)';$/.exec(line)?.slice(1) ?? []),
  );
}

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
  const nxCli = fileURLToPath(import.meta.resolve('nx/bin/nx.js'));
  const nxRun = Bun.spawn([process.execPath, nxCli, 'show', 'projects', '--json'], {
    cwd: new URL(WORKSPACE).pathname,
    env: { ...process.env, NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(nxRun.stdout).text(),
    new Response(nxRun.stderr).text(),
    nxRun.exited,
  ]);
  if (code !== 0) throw new Error(`Nx project graph failed: ${stderr}`);
  // Proof: spawning `bunx nx` from this Bun test exited 0 with empty stdout,
  // and JSON parsing failed on `Unexpected EOF` (2026-09-14). Resolving the
  // installed CLI makes empty output a failure instead of accepting no graph.
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

    expect(names).toContain('wbs-solver-supervisor-protocol');
    expect(names).toEqual((await runNxProjectNames()).sort());
    expect(pairs).toEqual(await nxProjectPairs());
  });

  it('pins every product root and qualified Nx identity in the destination map', async () => {
    const projects = await readProjects(WORKSPACE);
    const productProjects = projects
      .filter(({ root }) => root.startsWith('apps/') || root.startsWith('libs/'))
      .map(({ root, name }) => [root, name] as const);

    // Proof: before the coordinated move this owning Nx target returned all 18
    // unqualified roots and names against this exact destination oracle.
    expect(productProjects).toEqual([...EXPECTED_PRODUCT_PROJECTS]);
  });

  it('activates the product axis of its own directory on every app and library', async () => {
    const projects = await readProjects(WORKSPACE);
    const products = projects
      .filter(({ root }) => root.startsWith('apps/') || root.startsWith('libs/'))
      .map(({ root, tags }) => [root, tags.filter((tag) => tag.startsWith('product:'))] as const);

    // Proof: removing product:wbs from libs/wbs/domain/contracts made the owning Nx target
    // report its exact root with an empty product-tag collection (2026-09-14).
    // Proof: removing product:shared from libs/shared/domain/validation made it
    // report that root with an empty product-tag collection (2026-09-15).
    expect(products).toEqual(
      EXPECTED_PRODUCT_PROJECTS.map(([root]) => [root, [`product:${root.split('/')[1]}`]]),
    );
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
        return failureMessageOf(readProjects(workspace));
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
  it('generates a sorted same-or-shared rule per product, then one infra rule', () => {
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
      // One trailing infra rule, after every per-product rule and never repeated.
      { sourceTag: 'scope:infra', onlyDependOnLibsWithTags: ['scope:infra', 'product:shared'] },
    ]);
  });

  it('is satisfiable by every internal dependency in the actual repository graph', async () => {
    const projects = await readProjects(WORKSPACE);
    const constraints = productConstraints(projects);
    const graph = await nxProjectGraph();
    const violations: string[] = [];
    for (const project of projects) {
      // A product-less project is the infra rule's subject: the tools reach infra and the
      // shared product, plus whatever the root config's `allow` list excuses.
      const sourceTag = project.tags.find((tag) => tag.startsWith('product:')) ?? 'scope:infra';
      const constraint = constraints.find((candidate) => candidate.sourceTag === sourceTag);
      if (constraint === undefined) throw new Error(`missing product constraint for ${sourceTag}`);
      const specifiers = sourceTag === 'scope:infra' ? await importSpecifiersOf(project.root) : [];
      for (const dependency of graph.dependencies[project.name] ?? []) {
        if (!Object.hasOwn(graph.nodes, dependency.target)) continue;
        const target = graph.nodes[dependency.target];
        if (
          constraint.onlyDependOnLibsWithTags.some((allowed) => target.data.tags?.includes(allowed))
        ) {
          continue;
        }
        // Excused only when the edge is reached through an allowed alias and through no
        // subpath of it: another subpath resolves to the same project, so matching on the
        // project alone would widen the exception past what lint permits. The root config's
        // entries are anchored regular expressions and excuse the exact specifier only, and
        // this oracle refuses the subpaths independently of that spelling.
        const excusing = ALLOWED_INFRA_TO_PRODUCT_EDGES.filter(
          ([alias, reached]) => reached === target.name && specifiers.includes(alias),
        );
        const subpathed = excusing.some(([alias]) =>
          specifiers.some((specifier) => specifier.startsWith(`${alias}/`)),
        );
        if (excusing.length > 0 && !subpathed) continue;
        violations.push(`${project.name} -> ${target.name}`);
      }
    }

    // Proof: removing product:wbs from libs/wbs/domain/contracts made this real Nx graph
    // oracle report all ten incoming WBS dependency edges (2026-09-14). Emptying
    // `ALLOWED_INFRA_TO_PRODUCT_EDGES` made the product-less half report
    // `tool-dev-setup -> wbs-domain` and `tool-remote-scripts ->
    // wbs-solver-supervisor-protocol`, the two edges lint's `allow` list excuses. Importing
    // `@wbs/core` from tools/tool-smoke reported `tool-smoke -> wbs-core`, and importing the
    // unlisted `@wbs/domain/workday` from tools/dev reported `tool-dev-setup -> wbs-domain`
    // even with `@wbs/domain` itself allowed (2026-09-15).
    expect(violations).toEqual([]);
  });
});
