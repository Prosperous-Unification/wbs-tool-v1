import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scratchAsync } from '@tools/test-scratch';
import { $ } from 'bun';
import { describe, expect, it } from 'bun:test';

import { readProjects } from '../workspace-projects.mjs';
import { SOLVER_COMPATIBILITY_PATHS as PREPARATION_PATHS } from './solver-preparation';
import {
  assertDevSolverSourceCompatible,
  assertMcpEnv,
  deploySolverTarget,
  devSolverMappingOf,
  devSyncFailureMessage,
  LOCK_BUSY_EXIT_CODE,
  MCP_ENV,
  needsRestart,
  preflightSolver,
  RECREATE_PATHS,
  requireSolverImageInHost,
  RESTART_PATHS,
  runDevSyncLock,
  SOLVER_COMPATIBILITY_PATHS,
  solverPreflightDependencies,
  solverTargetDependencies,
  sync,
} from './sync';

const DEV_IMAGE = `registry.example/wbs-be@sha256:${'a'.repeat(64)}`;
const WORKSPACE = new URL('../../../', import.meta.url);

function solverConfigBytes(sourceSha: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      devSourceSha: sourceSha,
      images: [{ callerName: 'wbs-dev-src', solverImage: DEV_IMAGE }],
    }),
  );
}

describe('needsRestart', () => {
  it('uses the same solver path identity for detection and preparation', () => {
    expect(SOLVER_COMPATIBILITY_PATHS).toBe(PREPARATION_PATHS);
  });

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
    expect(needsRestart({ 'apps/wbs/be-01/drizzle': 'a' }, { 'apps/wbs/be-01/drizzle': 'b' })).toBe(
      true,
    );
  });

  // The Nx supervisor reads these once at startup. A changed port, command or
  // serve target leaves the old topology running while HEAD moves on.
  it('restarts when a serve target changed', () => {
    expect(
      needsRestart({ 'apps/wbs/be-01/project.json': 'a' }, { 'apps/wbs/be-01/project.json': 'b' }),
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
    expect(RESTART_PATHS).toContain('apps/wbs/be-01/drizzle');
    expect(RESTART_PATHS).toContain('package.json');
    expect(RESTART_PATHS).toContain('apps/wbs/fe-01/vite.config.ts');
  });
});

describe('RESTART_PATHS coverage', () => {
  // The list is hand-maintained, which is how tsconfig and the library
  // project.json files were missing from it for a month. This walks the repo
  // instead of trusting the list: a library added without an entry fails here
  // rather than on dev, silently, as a stale project graph.
  it('names every library project.json that exists on disk', async () => {
    const libs = (await readProjects(WORKSPACE))
      .filter((project) => project.root.startsWith('libs/'))
      .map((project) => `${project.root}/project.json`);
    expect(libs.length).toBeGreaterThan(0);
    for (const lib of libs) {
      expect(RESTART_PATHS).toContain(lib);
    }
  });

  it('names every app tsconfig, which is read once at process start', async () => {
    const apps = (await readProjects(WORKSPACE)).filter((project) =>
      project.root.startsWith('apps/'),
    );
    expect(apps.map((project) => project.name)).toContain('wbs-mcp-01');
    for (const app of apps) {
      expect(RESTART_PATHS).toContain(`${app.root}/tsconfig.json`);
    }
    expect(RESTART_PATHS).toContain('tsconfig.base.json');
  });

  // Every app manifest, serve target or not: the supervisor reads the project graph once at
  // startup, and `wiki-cli` — an app on disk with no serve target — is still a manifest that
  // graph is built from. Narrowing this to apps that declare a serve target would let the next
  // serve-less app's manifest drift past a running stack unnoticed.
  it('names every app project.json, which the supervisor reads once at startup', async () => {
    const apps = (await readProjects(WORKSPACE))
      .filter((project) => project.root.startsWith('apps/'))
      .map((project) => ({ name: project.name, manifest: `${project.root}/project.json` }));
    expect(apps.map((app) => app.name)).toContain('wbs-mcp-01');
    for (const app of apps) {
      expect(RESTART_PATHS).toContain(app.manifest);
    }
  });
});

describe('dev supervisor', () => {
  it('refuses a mutable solver image before touching the host daemon', async () => {
    const events: string[] = [];
    expect(
      await rejection(
        requireSolverImageInHost('registry.example/wbs-be:latest', {
          inspect: () => {
            events.push('inspect');
            return Promise.resolve(true);
          },
          pull: () => {
            events.push('pull');
            return Promise.resolve();
          },
        }),
      ),
    ).toContain('solver host image must be digest-pinned');
    expect(events).toEqual([]);
  });

  it('skips the registry when the exact solver digest is already in the host daemon', async () => {
    let inspections = 0;
    let pulls = 0;
    await requireSolverImageInHost(DEV_IMAGE, {
      inspect: () => {
        inspections += 1;
        return Promise.resolve(true);
      },
      pull: () => {
        pulls += 1;
        return Promise.resolve();
      },
    });
    expect({ inspections, pulls }).toEqual({ inspections: 1, pulls: 0 });
  });

  it('pulls one missing solver digest and verifies the host daemon afterwards', async () => {
    let inspections = 0;
    let pulls = 0;
    await requireSolverImageInHost(DEV_IMAGE, {
      inspect: () => {
        inspections += 1;
        return Promise.resolve(inspections === 2);
      },
      pull: () => {
        pulls += 1;
        return Promise.resolve();
      },
    });
    expect({ inspections, pulls }).toEqual({ inspections: 2, pulls: 1 });
  });

  // Proof: a pull that returns without installing the requested digest must
  // not let the service, socket, mapping, or checkout-reset phases begin.
  it('refuses when a pull leaves the exact solver digest absent', async () => {
    let pulls = 0;
    expect(
      await rejection(
        requireSolverImageInHost(DEV_IMAGE, {
          inspect: () => Promise.resolve(false),
          pull: () => {
            pulls += 1;
            return Promise.resolve();
          },
        }),
      ),
    ).toContain(`solver host image is unavailable after pull: ${DEV_IMAGE}`);
    expect(pulls).toBe(1);
  });

  it('propagates a solver image pull refusal without a second inspection', async () => {
    let inspections = 0;
    expect(
      await rejection(
        requireSolverImageInHost(DEV_IMAGE, {
          inspect: () => {
            inspections += 1;
            return Promise.resolve(false);
          },
          pull: () => Promise.reject(new Error('registry unavailable')),
        }),
      ),
    ).toContain('registry unavailable');
    expect(inspections).toBe(1);
  });

  // Proof: a missing-image refusal at the production command boundary leaves
  // every later service/socket/mapping probe untouched. Removing the image
  // call, or moving it later, changes this exact ledger.
  it('wires the production host preflight in fail-closed image-first order', async () => {
    const events: string[] = [];
    const configPath = '/srv/wbs/solver-supervisor.json';
    const dependencies = solverPreflightDependencies('/srv/wbs/source', configPath, {
      requireImage: (image) => {
        events.push(`image:${image}`);
        return Promise.reject(new Error('No such image: exact solver digest'));
      },
      requireService: () => {
        events.push('service');
        return Promise.resolve();
      },
      requireSocket: () => {
        events.push('socket');
        return Promise.resolve();
      },
      requireMapping: (image, path) => {
        events.push(`mapping:${image}:${path}`);
        return Promise.resolve();
      },
    });

    expect(await rejection(dependencies.requireHost(DEV_IMAGE))).toContain(
      'No such image: exact solver digest',
    );
    expect(events).toEqual([`image:${DEV_IMAGE}`]);
  });

  // The dev stack's project list feeds `nx run-many -t <target> --projects=...`.
  // A tier left out of that list has no watcher and no supervisor, so it never
  // starts. mcp-01 must run beside be-01, gw-01 and fe-01.
  //
  // **The list moved out of `package.json` and into `bin/dev.sh`**, which is
  // where both dev modes now build their nx arguments — the root scripts are
  // `bin/dev.sh` and `bin/dev.sh --local-solver`, and neither carries a project
  // name of its own. Reading `package.json` for this fact would now pass on a
  // `dev` script that names nothing at all, which is the fault this test exists
  // to catch wearing the new arrangement's clothes.
  //
  // Proof: dropping mcp-01 from `bin/dev.sh`'s `--projects=` list failed this
  // case on `- "mcp-01", · Expected - 1 · Received + 0`. Pointing the read back
  // at `package.json`'s `dev` script instead passes with that same tier gone,
  // because the script no longer names any project.
  it('names every tier in the dev stack, for both dev modes', async () => {
    const { readFile } = await import('node:fs/promises');
    const script = await readFile(new URL('../../../bin/dev.sh', import.meta.url), 'utf8');
    const projects = /--projects=([A-Za-z0-9,-]+)/.exec(script)?.[1];
    expect(projects).toBeDefined();
    // One list serves both `serve` and `serve-local-solver`, so a tier missing
    // here is missing from both modes at once.
    expect(projects?.split(',').sort()).toEqual([
      'wbs-be-01',
      'wbs-fe-01',
      'wbs-gw-01',
      'wbs-mcp-01',
    ]);

    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['dev']).toBe('bin/dev.sh');
    expect(pkg.scripts['dev:local-solver']).toBe('bin/dev.sh --local-solver');
  });

  it('binds the dev mapping to the solver sources and package image', () => {
    expect(SOLVER_COMPATIBILITY_PATHS).toEqual([
      'libs/wbs/adapters/solver-py',
      'apps/wbs/be-01/Dockerfile',
    ]);
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
      assertDevSolverSourceCompatible(['libs/wbs/adapters/solver-py/src/wbs_solver/solve.py']);
    }).toThrow(/mapping is stale.*publish the backend image/);
  });

  it('checks the namespaced MCP environment before moving the live checkout', () => {
    // Proof: restoring sync.ts's default to `src/apps/mcp-01/.env` failed this
    // exact production default assertion without reading a live remote file.
    expect(MCP_ENV).toBe('/home/puni1/wbs-dev/src/apps/wbs/mcp-01/.env');
  });

  it('routes the solver target after fetch and before deployed HEAD is believed', async () => {
    const source = await readFile(new URL('./sync.ts', import.meta.url), 'utf8');
    const fetchAt = source.indexOf('git -C ${SRC} fetch --quiet origin');
    const targetAt = source.indexOf('await deploySolverTarget(sha, solverTargetDependencies());');
    const proofAt = source.indexOf('git -C ${SRC} rev-parse HEAD', targetAt);

    expect(fetchAt).toBeGreaterThan(-1);
    expect(targetAt).toBeGreaterThan(fetchAt);
    expect(proofAt).toBeGreaterThan(targetAt);
    expect(source).toContain('const sourceRepository = options.sourceRepository ?? SRC;');
  });

  it('prepares a changed solver target and keeps unchanged targets on the existing preflight', async () => {
    const changedEvents: string[] = [];
    await deploySolverTarget('c'.repeat(40), {
      currentSha: () => Promise.resolve('b'.repeat(40)),
      changedPaths: () => Promise.resolve(['libs/wbs/adapters/solver-py/src/wbs_solver/solve.py']),
      compatibilityIdentity: () => Promise.resolve('d'.repeat(64)),
      readState: () => Promise.resolve(undefined),
      prepare: (target, state) => {
        expect(target).toEqual({
          sourceSha: 'c'.repeat(40),
          compatibilityIdentity: 'd'.repeat(64),
        });
        expect(state).toBeUndefined();
        changedEvents.push('prepare');
        return Promise.resolve();
      },
      preflight: () => Promise.reject(new Error('changed target uses automatic preparation')),
      reset: () => Promise.reject(new Error('preparation owns changed-target reset')),
    });
    expect(changedEvents).toEqual(['prepare']);

    const unchangedEvents: string[] = [];
    await deploySolverTarget('c'.repeat(40), {
      currentSha: () => Promise.resolve('b'.repeat(40)),
      changedPaths: () => Promise.resolve([]),
      compatibilityIdentity: () =>
        Promise.reject(new Error('unchanged target has no new identity')),
      readState: () => Promise.reject(new Error('unchanged target has no preparation state')),
      prepare: () => Promise.reject(new Error('unchanged target does not prepare')),
      preflight: () => {
        unchangedEvents.push('preflight');
        return Promise.resolve();
      },
      reset: () => {
        unchangedEvents.push('reset');
        return Promise.resolve();
      },
    });
    expect(unchangedEvents).toEqual(['preflight', 'reset']);
  });

  it('reads target compatibility from the source repository, not the exported deployer tree', async () => {
    const directory = await scratchAsync('wbs-devsync-source-repository-');
    const sourceRepository = join(directory, 'source');
    const exportedRuntime = join(directory, 'bin', 'sync.target');
    await mkdir(join(sourceRepository, 'libs', 'wbs', 'adapters', 'solver-py'), {
      recursive: true,
    });
    await mkdir(join(sourceRepository, 'apps', 'wbs', 'be-01'), { recursive: true });
    await mkdir(exportedRuntime, { recursive: true });
    await writeFile(
      join(sourceRepository, 'libs', 'wbs', 'adapters', 'solver-py', 'solver.py'),
      'version = 1\n',
    );
    await writeFile(join(sourceRepository, 'apps', 'wbs', 'be-01', 'Dockerfile'), 'FROM scratch\n');
    await $`git -C ${sourceRepository} init --quiet`;
    await $`git -C ${sourceRepository} add libs/wbs/adapters/solver-py apps/wbs/be-01/Dockerfile`;
    await $`git -C ${sourceRepository} -c user.name=devsync-test -c user.email=devsync@example.invalid commit --quiet -m compatibility`;
    const compatibilitySha = (await $`git -C ${sourceRepository} rev-parse HEAD`.text()).trim();
    const dependencies = solverTargetDependencies({
      sourceRepository,
      runtimeRoot: exportedRuntime,
      solverConfigPath: join(directory, 'missing-solver-config.json'),
    });

    const exportedQuery = await $`git -C ${exportedRuntime} rev-parse --git-dir`.nothrow().quiet();
    expect(exportedQuery.exitCode).toBe(128);
    expect(exportedQuery.stderr.toString()).toContain('not a git repository');
    const identity = await dependencies.compatibilityIdentity(compatibilitySha);
    expect(identity).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(sourceRepository, 'README.md'), 'unrelated change\n');
    await $`git -C ${sourceRepository} add README.md`;
    await $`git -C ${sourceRepository} -c user.name=devsync-test -c user.email=devsync@example.invalid commit --quiet -m unrelated`;
    const unrelatedSha = (await $`git -C ${sourceRepository} rev-parse HEAD`.text()).trim();
    expect(await dependencies.compatibilityIdentity(unrelatedSha)).toBe(identity);

    await $`git -C ${sourceRepository} reset --hard --quiet ${compatibilitySha}`;
    let preparations = 0;
    await deploySolverTarget(unrelatedSha, {
      ...dependencies,
      prepare: () => {
        preparations += 1;
        return Promise.reject(new Error('unrelated target must not prepare the solver'));
      },
    });
    expect(preparations).toBe(0);
    expect((await $`git -C ${sourceRepository} rev-parse HEAD`.text()).trim()).toBe(unrelatedSha);
  });

  it('names the source repository and compatibility path when git cannot answer the query', async () => {
    const directory = await scratchAsync('wbs-devsync-missing-source-repository-');
    const missingRepository = join(directory, 'missing-source');
    const exportedRuntime = join(directory, 'bin', 'sync.target');
    await mkdir(exportedRuntime, { recursive: true });

    const message = await rejection(
      solverTargetDependencies({
        sourceRepository: missingRepository,
        runtimeRoot: exportedRuntime,
      }).compatibilityIdentity('a'.repeat(40)),
    );
    expect(message).toContain(`git repository ${missingRepository}`);
    expect(message).toContain(`${'a'.repeat(40)}:libs/wbs/adapters/solver-py`);
  });

  it('validates every injected solver path before constructing host dependencies', () => {
    for (const options of [
      { sourceRepository: 'relative/source' },
      { runtimeRoot: '/runtime/../other' },
      { solverConfigPath: 'relative/config.json' },
    ]) {
      expect(() => solverTargetDependencies(options)).toThrow(
        /path must be absolute and normalized/,
      );
    }
  });

  it('allows absent optional host state for source-unrelated deploys', async () => {
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

  // Proof: injecting the incident's missing-image refusal into an unrelated
  // deploy now makes the poller fail instead of resetting and leaving the only
  // evidence in the supervisor user journal.
  it('surfaces host-image refusal for a compatible unrelated deploy', async () => {
    const deployedSha = 'b'.repeat(40);
    const targetSha = 'c'.repeat(40);
    let changedPathReads = 0;

    expect(
      await rejection(
        preflightSolver(targetSha, {
          currentSha: () => Promise.resolve(deployedSha),
          changedPaths: () => {
            changedPathReads += 1;
            return Promise.resolve([]);
          },
          readConfig: () => Promise.resolve(solverConfigBytes(deployedSha)),
          requireHost: () => Promise.reject(new Error('No such image: exact solver digest')),
        }),
      ),
    ).toContain('No such image: exact solver digest');
    expect(changedPathReads).toBe(2);
  });

  it('names the materialize and install remedy when changed solver sources have no config', async () => {
    let configReads = 0;
    const injectedConfig = '/srv/wbs/state/injected-solver-config.json';

    expect(
      await rejection(
        preflightSolver(
          'c'.repeat(40),
          {
            currentSha: () => Promise.resolve('b'.repeat(40)),
            changedPaths: () =>
              Promise.resolve(['libs/wbs/adapters/solver-py/src/wbs_solver/solve.py']),
            readConfig: () => {
              configReads += 1;
              return Promise.resolve(undefined);
            },
            requireHost: () =>
              Promise.reject(new Error('host check must follow config validation')),
          },
          injectedConfig,
        ),
      ),
    ).toContain(injectedConfig);
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
              changedPathReads === 1 ? [] : ['libs/wbs/adapters/solver-py/src/wbs_solver/solve.py'],
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
            return Promise.resolve(['libs/wbs/adapters/solver-py/src/wbs_solver/solve.py']);
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
        return Promise.resolve(changedPathReads === 1 ? ['apps/wbs/be-01/Dockerfile'] : []);
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
  it('passes the dedicated contention exit code to the production flock invocation', async () => {
    const directory = await scratchAsync('wbs-devsync-flock-');
    const argumentsPath = join(directory, 'arguments');
    const flockPath = join(directory, 'flock');
    const lockPath = join(directory, 'devsync.lock');
    const scriptPath = join(directory, 'sync.ts');
    await writeFile(flockPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsPath}'\n`);
    await chmod(flockPath, 0o755);

    expect(
      await runDevSyncLock('target-sha', {
        bunPath: 'test-bun',
        flockPath,
        lockPath,
        scriptPath,
      }),
    ).toBe(0);
    expect((await readFile(argumentsPath, 'utf8')).trim().split('\n')).toEqual([
      '-E',
      '75',
      '-n',
      lockPath,
      'test-bun',
      scriptPath,
      '--locked',
      'target-sha',
    ]);
  });

  // The locked child performs every mutating step -- reset, install, restart
  // and the solver preflight -- so it, not the short-lived parent, is the run
  // whose interpreter matters. A default of `'bun'` let PATH decide: on h2puni
  // the poller launched the deploy with its own pinned binary while the child
  // fell through to a root-owned /usr/local/bin/bun 1.2.20, matching neither
  // that binary nor the 1.3.14 that .bun-version and CI pin. dev-poll-sync.sh
  // refuses to exec a mismatched interpreter, and this default is where that
  // guarantee was being discarded one process later.
  //
  // Asserted through the recorded argv rather than the source text, because
  // the shape this file used to grep for no longer exists.
  it('defaults the locked child to this process interpreter, never PATH', async () => {
    const directory = await scratchAsync('wbs-devsync-interpreter-');
    const argumentsPath = join(directory, 'arguments');
    const flockPath = join(directory, 'flock');
    const lockPath = join(directory, 'devsync.lock');
    const scriptPath = join(directory, 'sync.ts');
    await writeFile(flockPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsPath}'\n`);
    await chmod(flockPath, 0o755);

    expect(await runDevSyncLock('target-sha', { flockPath, lockPath, scriptPath })).toBe(0);

    const argv = (await readFile(argumentsPath, 'utf8')).trim().split('\n');
    expect(argv[4]).toBe(process.execPath);
    expect(argv[4]).not.toBe('bun');
  });

  it('identifies only flock lock contention as a held deploy lock', () => {
    expect(devSyncFailureMessage(LOCK_BUSY_EXIT_CODE)).toBe(
      '[dev-sync] skipped: another deploy holds the lock',
    );
    expect(devSyncFailureMessage(1)).toBe('[dev-sync] failed (exit 1); see the error above');
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
    const directory = await scratchAsync('wbs-mcp-env-');
    const missing = join(directory, '.env');

    expect(await rejection(assertMcpEnv(missing))).toContain(
      `missing ${missing}; seed the gitignored mcp-01 environment before deploying`,
    );
  });

  it('checks the gitignored environment before fetch or reset can move the tree', async () => {
    const directory = await scratchAsync('wbs-mcp-env-order-');
    const missing = join(directory, '.env');

    expect(await rejection(sync('unreachable-sha', { mcpEnvPath: missing }))).toContain(
      `missing ${missing}; seed the gitignored mcp-01 environment before deploying`,
    );
  });
});
