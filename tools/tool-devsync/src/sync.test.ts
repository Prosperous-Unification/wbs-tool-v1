import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { assertMcpEnv, needsRestart, RECREATE_PATHS, RESTART_PATHS, sync } from './sync';

describe('needsRestart', () => {
  it('does not restart when nothing in the manifest changed', () => {
    expect(needsRestart({ 'bun.lock': 'a' }, { 'bun.lock': 'a' })).toBe(false);
  });

  it('restarts when the lockfile moved, because bun install must run', () => {
    expect(needsRestart({ 'bun.lock': 'a' }, { 'bun.lock': 'b' })).toBe(true);
  });

  // A migration is not imported by any watched module, so bun --watch never
  // sees it. Without this, dev serves new code against the old schema and
  // reports success -- be-01 sets migrationsApplied=true regardless.
  it('restarts when a migration appeared', () => {
    expect(needsRestart({ 'apps/be-01/drizzle': 'a' }, { 'apps/be-01/drizzle': 'b' })).toBe(true);
  });

  // The Nx supervisor reads these once at startup. A changed port, command or
  // serve target leaves the old topology running while HEAD moves on.
  it('restarts when a serve target changed', () => {
    expect(
      needsRestart({ 'apps/be-01/project.json': 'a' }, { 'apps/be-01/project.json': 'b' }),
    ).toBe(true);
  });

  it('restarts when the root dev script changed', () => {
    expect(needsRestart({ 'package.json': 'a' }, { 'package.json': 'b' })).toBe(true);
  });

  // Missing evidence is not evidence of absence. Guessing "nothing to do" is
  // how dev keeps serving against a stale schema or stale dependencies.
  it('restarts when a hash was unreadable before', () => {
    expect(needsRestart({ 'bun.lock': '' }, { 'bun.lock': 'b' })).toBe(true);
  });

  it('restarts when a hash was unreadable after', () => {
    expect(needsRestart({ 'bun.lock': 'a' }, { 'bun.lock': '' })).toBe(true);
  });

  it('restarts when a manifest entry appeared that was not there before', () => {
    expect(needsRestart({}, { 'bun.lock': 'b' })).toBe(true);
  });

  it('restarts when a manifest entry disappeared', () => {
    expect(needsRestart({ 'bun.lock': 'a' }, {})).toBe(true);
  });

  it('watches the paths that cannot reach a running process any other way', () => {
    expect(RESTART_PATHS).toContain('bun.lock');
    expect(RESTART_PATHS).toContain('apps/be-01/drizzle');
    expect(RESTART_PATHS).toContain('package.json');
    expect(RESTART_PATHS).toContain('apps/fe-01/vite.config.ts');
  });
});

describe('RESTART_PATHS coverage', () => {
  // The list is hand-maintained, which is how tsconfig and the library
  // project.json files were missing from it for a month. This walks the repo
  // instead of trusting the list: a library added without an entry fails here
  // rather than on dev, silently, as a stale project graph.
  it('names every library project.json that exists on disk', async () => {
    const { readdir } = await import('node:fs/promises');
    const libs = (await readdir(new URL('../../../libs', import.meta.url), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => `libs/${e.name}/project.json`);
    expect(libs.length).toBeGreaterThan(0);
    for (const lib of libs) {
      expect(RESTART_PATHS).toContain(lib);
    }
  });

  it('names every app tsconfig, which is read once at process start', () => {
    for (const app of ['be-01', 'gw-01', 'fe-01', 'mcp-01']) {
      expect(RESTART_PATHS).toContain(`apps/${app}/tsconfig.json`);
    }
    expect(RESTART_PATHS).toContain('tsconfig.base.json');
  });

  it('names every app project.json, whose serve target the supervisor reads once', async () => {
    const { readdir } = await import('node:fs/promises');
    const apps = (await readdir(new URL('../../../apps', import.meta.url), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(apps).toContain('mcp-01');
    for (const app of apps) {
      expect(RESTART_PATHS).toContain(`apps/${app}/project.json`);
    }
  });
});

describe('dev supervisor', () => {
  // The root `dev` script feeds `nx run-many -t serve --projects=...`. A tier
  // left out of that list has no watcher and no supervisor, so it never
  // starts. mcp-01 must run beside be-01, gw-01 and fe-01.
  it('names mcp-01 in the root serve target', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toContain('mcp-01');
  });
});

describe('RECREATE_PATHS', () => {
  // Restarting a container does not re-create it, so a changed compose file or
  // Dockerfile is not applied by the deploy at all. These must not overlap with
  // RESTART_PATHS, or a restart would be reported as having handled them.
  it('does not overlap with the paths a restart can apply', () => {
    for (const p of RECREATE_PATHS) {
      expect(RESTART_PATHS).not.toContain(p);
    }
  });
});

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '(resolved without throwing)';
  } catch (error) {
    return String(error);
  }
}

describe('MCP environment prerequisite', () => {
  it('fails clearly before restarting a supervisor that cannot start mcp-01', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wbs-mcp-env-'));
    const missing = join(directory, '.env');

    expect(await rejection(assertMcpEnv(missing))).toContain(
      `missing ${missing}; seed the gitignored mcp-01 environment before deploying`,
    );
  });

  it('checks the gitignored environment before fetch or reset can move the tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wbs-mcp-env-order-'));
    const missing = join(directory, '.env');

    expect(await rejection(sync('unreachable-sha', { mcpEnvPath: missing }))).toContain(
      `missing ${missing}; seed the gitignored mcp-01 environment before deploying`,
    );
  });
});
