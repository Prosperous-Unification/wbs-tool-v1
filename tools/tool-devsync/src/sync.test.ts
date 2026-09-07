import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  assertDevSolverSourceCompatible,
  assertMcpEnv,
  devSolverMappingOf,
  devSyncFailureMessage,
  LOCK_BUSY_EXIT_CODE,
  needsRestart,
  preflightSolver,
  RECREATE_PATHS,
  RESTART_PATHS,
  SOLVER_COMPATIBILITY_PATHS,
  sync,
} from './sync';

const DEV_IMAGE = `registry.example/wbs-be@sha256:${'a'.repeat(64)}`;

function solverConfigBytes(sourceSha: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      devSourceSha: sourceSha,
      images: [{ callerName: 'wbs-dev-src', solverImage: DEV_IMAGE }],
    }),
  );
}

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
    expect(pkg.scripts['dev']).toContain('mcp-01');
  });

  it('binds the dev mapping to the solver sources and package image', () => {
    expect(SOLVER_COMPATIBILITY_PATHS).toEqual(['libs/solver-py', 'apps/be-01/Dockerfile']);
    expect(
      devSolverMappingOf(
        JSON.stringify({
          devSourceSha: 'b'.repeat(40),
          images: [{ callerName: 'wbs-dev-src', solverImage: DEV_IMAGE }],
        }),
      ),
    ).toEqual({ sourceSha: 'b'.repeat(40), image: DEV_IMAGE });
    expect(() => {
      assertDevSolverSourceCompatible([]);
    }).not.toThrow();
    expect(() => {
      assertDevSolverSourceCompatible(['libs/solver-py/src/wbs_solver/solve.py']);
    }).toThrow(/mapping is stale.*publish the backend image/);
  });

  it('runs the solver preflight after fetch and before reset can deploy source', async () => {
    const source = await readFile(new URL('./sync.ts', import.meta.url), 'utf8');
    const fetchAt = source.indexOf('git -C ${SRC} fetch --quiet origin');
    const preflightAt = source.indexOf('await preflightSolver(sha);');
    const resetAt = source.indexOf('git -C ${SRC} reset --hard --quiet ${sha}');

    expect(fetchAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeGreaterThan(fetchAt);
    expect(resetAt).toBeGreaterThan(preflightAt);
  });

  it('does not require supervisor host state for source-unrelated deploys', async () => {
    const deployedSha = 'b'.repeat(40);
    const targetSha = 'c'.repeat(40);
    let configReads = 0;
    let hostChecks = 0;

    await preflightSolver(targetSha, {
      currentSha: () => Promise.resolve(deployedSha),
      changedPaths: (from, to) => {
        expect(from).toBe(deployedSha);
        expect(to).toBe(targetSha);
        return Promise.resolve([]);
      },
      readConfig: () => {
        configReads += 1;
        return Promise.resolve(undefined);
      },
      requireHost: () => {
        hostChecks += 1;
        return Promise.resolve();
      },
    });

    expect(configReads).toBe(1);
    expect(hostChecks).toBe(0);
  });

  it('names the materialize and install remedy when changed solver sources have no config', async () => {
    let configReads = 0;

    expect(
      await rejection(
        preflightSolver('c'.repeat(40), {
          currentSha: () => Promise.resolve('b'.repeat(40)),
          changedPaths: () => Promise.resolve(['libs/solver-py/src/wbs_solver/solve.py']),
          readConfig: () => {
            configReads += 1;
            return Promise.resolve(undefined);
          },
          requireHost: () => Promise.reject(new Error('host check must follow config validation')),
        }),
      ),
    ).toContain(
      'materialize-solver-supervisor-config and install-solver-supervisor before deploying',
    );
    expect(configReads).toBe(1);
  });

  it('refuses an unrelated deploy while a future solver mapping is staged', async () => {
    const deployedSha = 'b'.repeat(40);
    const targetSha = 'c'.repeat(40);
    const futureMappingSha = 'd'.repeat(40);
    let changedPathReads = 0;
    let hostChecks = 0;

    expect(
      await rejection(
        preflightSolver(targetSha, {
          currentSha: () => Promise.resolve(deployedSha),
          changedPaths: (from, to) => {
            changedPathReads += 1;
            expect(to).toBe(targetSha);
            expect(from).toBe(changedPathReads === 1 ? deployedSha : futureMappingSha);
            return Promise.resolve(
              changedPathReads === 1 ? [] : ['libs/solver-py/src/wbs_solver/solve.py'],
            );
          },
          readConfig: () => Promise.resolve(solverConfigBytes(futureMappingSha)),
          requireHost: () => {
            hostChecks += 1;
            return Promise.resolve();
          },
        }),
      ),
    ).toContain('dev solver mapping is stale');
    expect(changedPathReads).toBe(2);
    expect(hostChecks).toBe(0);
  });

  it('refuses a stale solver mapping before the host preflight', async () => {
    const deployedSha = 'b'.repeat(40);
    const targetSha = 'c'.repeat(40);
    const mappingSha = 'd'.repeat(40);
    let changedPathReads = 0;
    let hostChecks = 0;

    expect(
      await rejection(
        preflightSolver(targetSha, {
          currentSha: () => Promise.resolve(deployedSha),
          changedPaths: (from, to) => {
            changedPathReads += 1;
            expect(to).toBe(targetSha);
            expect(from).toBe(changedPathReads === 1 ? deployedSha : mappingSha);
            return Promise.resolve(['libs/solver-py/src/wbs_solver/solve.py']);
          },
          readConfig: () => Promise.resolve(solverConfigBytes(mappingSha)),
          requireHost: () => {
            hostChecks += 1;
            return Promise.resolve();
          },
        }),
      ),
    ).toContain('dev solver mapping is stale');
    expect(changedPathReads).toBe(2);
    expect(hostChecks).toBe(0);
  });

  it('runs the host preflight with the mapped image when solver sources are compatible', async () => {
    const deployedSha = 'b'.repeat(40);
    const targetSha = 'c'.repeat(40);
    const mappingSha = 'd'.repeat(40);
    let changedPathReads = 0;
    let hostImage: string | undefined;

    await preflightSolver(targetSha, {
      currentSha: () => Promise.resolve(deployedSha),
      changedPaths: () => {
        changedPathReads += 1;
        return Promise.resolve(changedPathReads === 1 ? ['apps/be-01/Dockerfile'] : []);
      },
      readConfig: () => Promise.resolve(solverConfigBytes(mappingSha)),
      requireHost: (image) => {
        hostImage = image;
        return Promise.resolve();
      },
    });

    expect(changedPathReads).toBe(2);
    expect(hostImage).toBe(DEV_IMAGE);
  });
});

describe('dev-sync lock diagnostics', () => {
  it('identifies only flock lock contention as a held deploy lock', () => {
    expect(devSyncFailureMessage(LOCK_BUSY_EXIT_CODE)).toBe(
      '[dev-sync] skipped: another deploy holds the lock',
    );
    expect(devSyncFailureMessage(1)).toBe('[dev-sync] failed (exit 1); see the error above');
  });

  it('guards the sync source shape that passes the reserved contention code to flock', async () => {
    const source = await readFile(new URL('./sync.ts', import.meta.url), 'utf8');
    expect(source).toContain('flock -E ${LOCK_BUSY_EXIT_CODE} -n ${LOCK}');
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

  it('mounts the supervisor runtime directory, never its replaceable socket inode', async () => {
    const { readFile } = await import('node:fs/promises');
    const compose = await readFile(
      new URL('../../../deploy/dev-src/compose.yml', import.meta.url),
      'utf8',
    );

    expect(compose).toContain('- /run/user/1000/wbs-solver:/run/wbs-solver:ro');
    expect(compose).not.toMatch(/^\s*- .*supervisor\.sock:/m);
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
