import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { readProjects } from '../workspace-projects.mjs';

const WORKSPACE = new URL('../../../', import.meta.url);

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
  const nxRun = Bun.spawn(['bunx', 'nx', 'show', 'projects', '--json'], {
    cwd: new URL(WORKSPACE).pathname,
    env: { ...process.env, NX_DAEMON: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
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

    expect(names).toContain('solver-supervisor-protocol');
    expect(names).toEqual((await runNxProjectNames()).sort());
  });

  it('discovers projects below another project and ignores only named generated trees', async () => {
    const workspace = await createWorkspace();
    await Promise.all([
      writeManifest(workspace, 'libs/outer', manifestOf('outer')),
      writeManifest(workspace, 'libs/outer/nested/protocol', manifestOf('protocol')),
      writeManifest(workspace, 'libs/outer/node_modules/hidden', manifestOf('dependency-copy')),
      writeManifest(workspace, 'libs/outer/dist/hidden', manifestOf('generated-copy')),
    ]);

    expect(await readProjects(workspace)).toEqual([
      expect.objectContaining({ root: 'libs/outer', name: 'outer' }),
      expect.objectContaining({ root: 'libs/outer/nested/protocol', name: 'protocol' }),
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
      'project directory is symlinked: libs/linked',
    );
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
