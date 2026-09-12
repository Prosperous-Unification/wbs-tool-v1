import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSync } from '@wbs/tool-test-scratch';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { installedDaggerSdkVersion } from './main';
import {
  applyRunnerHostAlias,
  assertBuildCapacity,
  assertCleanTree,
  assertEngineContract,
  type BuildCapacity,
  cleanTreeRepository,
  createDockerEngineControl,
  type EngineControl,
  engineCreateArgs,
  readBuildCapacity,
  requireRegistryPassword,
  runAdmittedPublish,
  runEngineLifecycle,
} from './main';

const sdkVersion = await installedDaggerSdkVersion();

const expectedEngine = {
  State: {
    Running: false,
  },
  Config: {
    Image: `registry.dagger.io/engine:v${sdkVersion}`,
    Cmd: [
      '--addr',
      'unix:///run/buildkit/buildkitd.sock',
      '--addr',
      'unix:///run/dagger/engine.sock',
      '--addr',
      'tcp://0.0.0.0:8080',
    ],
  },
  HostConfig: {
    Memory: 8 * 1024 ** 3,
    MemorySwap: 8 * 1024 ** 3,
    NanoCpus: 6_000_000_000,
    PidsLimit: 2048,
    Privileged: true,
    RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    NetworkMode: 'bridge',
    PortBindings: {
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8081' }],
    },
  },
  Mounts: [
    {
      Type: 'volume',
      Name: 'wbs-dagger-engine',
      Destination: '/var/lib/dagger',
      RW: true,
    },
  ],
  NetworkSettings: {
    Networks: {
      bridge: {},
    },
  },
};

const safeCapacity: BuildCapacity = {
  availableMemoryBytes: 9 * 1024 ** 3,
  tmpfsAvailableBytes: 15 * 1024 ** 3,
  tmpfsCapacityBytes: 16 * 1024 ** 3,
  load1: 7,
  cpuCount: 8,
};

async function captureFailure(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw new Error(`expected Error, received ${String(error)}`, { cause: error });
  }
  throw new Error('expected work to fail');
}

describe('assertBuildCapacity', () => {
  it('admits the exact safe boundaries', () => {
    expect(() => {
      assertBuildCapacity({
        availableMemoryBytes: 8 * 1024 ** 3,
        tmpfsAvailableBytes: 12 * 1024 ** 3,
        tmpfsCapacityBytes: 16 * 1024 ** 3,
        load1: 8,
        cpuCount: 8,
      });
    }).not.toThrow();
  });

  it.each([
    ['available memory', { availableMemoryBytes: 8 * 1024 ** 3 - 1 }],
    ['tmpfs occupancy', { tmpfsAvailableBytes: 12 * 1024 ** 3 - 1 }],
    ['one-minute load', { load1: 8.01 }],
  ])('refuses unsafe %s before an engine starts', (name, unsafe) => {
    // Proof: each injected measurement crosses exactly one production limit.
    expect(() => {
      assertBuildCapacity({ ...safeCapacity, ...unsafe });
    }).toThrow(name);
  });
});

describe('readBuildCapacity', () => {
  let root: string;

  beforeEach(() => {
    root = scratchSync('wbs-capacity-');
  });

  afterEach(() => {
    chmodSync(join(root, 'meminfo'), 0o600);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads available memory and filesystem capacity from the host snapshot', () => {
    const meminfo = join(root, 'meminfo');
    writeFileSync(meminfo, 'MemTotal: 16384000 kB\nMemAvailable: 9437184 kB\n');

    const capacity = readBuildCapacity({
      meminfoPath: meminfo,
      tmpPath: root,
      shmPath: root,
      load1: () => 3.5,
      cpuCount: () => 8,
    });

    expect(capacity.availableMemoryBytes).toBe(9 * 1024 ** 3);
    expect(capacity.tmpfsCapacityBytes).toBeGreaterThan(0);
    expect(capacity.tmpfsAvailableBytes).toBeGreaterThan(0);
    expect(capacity.load1).toBe(3.5);
    expect(capacity.cpuCount).toBe(8);
  });

  it('fails closed when MemAvailable is absent', () => {
    const meminfo = join(root, 'meminfo');
    writeFileSync(meminfo, 'MemTotal: 16384000 kB\n');

    expect(() => readBuildCapacity({ meminfoPath: meminfo })).toThrow('MemAvailable');
  });

  it('fails closed when the capacity source is unreadable', () => {
    const meminfo = join(root, 'meminfo');
    writeFileSync(meminfo, 'MemAvailable: 9437184 kB\n');
    chmodSync(meminfo, 0o000);

    // Proof: the production reader must surface the filesystem refusal.
    expect(() => readBuildCapacity({ meminfoPath: meminfo })).toThrow();
  });
});

describe('engineCreateArgs', () => {
  it('pins the engine image, loopback port, cache, memory, CPU, and PID ceilings', () => {
    expect(engineCreateArgs()).toEqual([
      'docker',
      'run',
      '--detach',
      '--privileged',
      '--name=wbs-dagger-engine',
      '--memory=8g',
      '--memory-swap=8g',
      '--cpus=6',
      '--pids-limit=2048',
      '--publish',
      '127.0.0.1:8081:8080',
      '--volume',
      'wbs-dagger-engine:/var/lib/dagger',
      `registry.dagger.io/engine:v${sdkVersion}`,
      '--addr',
      'unix:///run/buildkit/buildkitd.sock',
      '--addr',
      'unix:///run/dagger/engine.sock',
      '--addr',
      'tcp://0.0.0.0:8080',
    ]);
  });
});

describe('assertEngineContract', () => {
  it('accepts the exact named-engine resource contract', () => {
    expect(() => {
      assertEngineContract(expectedEngine);
    }).not.toThrow();
  });

  it('refuses an existing engine without the loopback TCP listener', () => {
    expect(() => {
      assertEngineContract({ ...expectedEngine, Config: { ...expectedEngine.Config, Cmd: null } });
    }).toThrow('listener');
  });

  it('refuses an additional public port binding before starting the engine', () => {
    expect(() => {
      assertEngineContract({
        ...expectedEngine,
        HostConfig: {
          ...expectedEngine.HostConfig,
          PortBindings: {
            ...expectedEngine.HostConfig.PortBindings,
            '2375/tcp': [{ HostIp: '0.0.0.0', HostPort: '2375' }],
          },
        },
      });
    }).toThrow('port');
  });

  it.each([
    ['running state', { State: { Running: true } }],
    [
      'restart policy',
      {
        HostConfig: {
          ...expectedEngine.HostConfig,
          RestartPolicy: { Name: 'always', MaximumRetryCount: 0 },
        },
      },
    ],
    [
      'network mode',
      {
        HostConfig: { ...expectedEngine.HostConfig, NetworkMode: 'host' },
        NetworkSettings: { Networks: { host: {} } },
      },
    ],
  ])('refuses existing-engine %s drift before reuse', (name, drift) => {
    expect(() => {
      assertEngineContract({ ...expectedEngine, ...drift });
    }).toThrow(name.split(' ')[0]);
  });

  it('refuses a mismatched memory ceiling before starting the engine', async () => {
    const calls: string[][] = [];
    const engine = createDockerEngineControl((argv: string[]) => {
      calls.push(argv);
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { ...expectedEngine, HostConfig: { ...expectedEngine.HostConfig, Memory: 0 } },
        ]),
        stderr: '',
      };
    });

    // Proof: drift in a real `docker inspect` shape reaches the production control.
    const failure = await captureFailure(() => engine.start());
    expect(failure.message).toContain('memory');
    expect(calls).toHaveLength(1);
  });

  it('creates the bounded engine when Docker reports the named container absent', async () => {
    const calls: string[][] = [];
    const engine = createDockerEngineControl((argv: string[]) => {
      calls.push(argv);
      if (calls.length === 1) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Error response from daemon: No such container: wbs-dagger-engine',
        };
      }
      return { exitCode: 0, stdout: 'created', stderr: '' };
    });

    // Proof: this is `docker container inspect`'s exact live absence spelling.
    await engine.start();
    expect(calls).toEqual([
      ['docker', 'container', 'inspect', 'wbs-dagger-engine'],
      engineCreateArgs(),
    ]);
  });
});

describe('runEngineLifecycle', () => {
  function control(stopError?: Error): { control: EngineControl; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      control: {
        start: () => {
          calls.push('start');
          return Promise.resolve();
        },
        stop: () => {
          calls.push('stop');
          return stopError === undefined ? Promise.resolve() : Promise.reject(stopError);
        },
      },
    };
  }

  it('stops the engine after a successful publish', async () => {
    const fixture = control();
    const published = await runEngineLifecycle(fixture.control, () => Promise.resolve('published'));
    expect(published).toBe('published');
    expect(fixture.calls).toEqual(['start', 'stop']);
  });

  it('stops the engine after a publish failure', async () => {
    const fixture = control();
    const failure = await captureFailure(() =>
      runEngineLifecycle(fixture.control, () => Promise.reject(new Error('registry refused'))),
    );
    expect(failure.message).toContain('registry refused');
    expect(fixture.calls).toEqual(['start', 'stop']);
  });

  it('fails the run when stopping the engine fails', async () => {
    const fixture = control(new Error('engine remained resident'));
    // Proof: success cannot mask failure to return host capacity.
    const failure = await captureFailure(() =>
      runEngineLifecycle(fixture.control, () => Promise.resolve('published')),
    );
    expect(failure.message).toContain('engine remained resident');
  });

  it('preserves the publish failure when stopping the engine also fails', async () => {
    const publishError = new Error('registry refused');
    const stopError = new Error('engine remained resident');
    const fixture = control(stopError);

    const failure = await captureFailure(() =>
      runEngineLifecycle(fixture.control, () => Promise.reject(publishError)),
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain('registry refused');
    expect(failure.message).toContain('engine remained resident');
    expect(failure.cause).toBe(publishError);
    expect((failure as AggregateError).errors).toEqual([publishError, stopError]);
  });

  it('stops the engine before a real SIGTERM exits the publish process', async () => {
    const root = scratchSync('wbs-engine-signal-');
    const marker = join(root, 'lifecycle.log');
    const moduleUrl = new URL('./main.ts', import.meta.url).href;
    const childScript = `
      import { appendFileSync } from 'node:fs';
      import { runEngineLifecycle } from ${JSON.stringify(moduleUrl)};
      const marker = process.env['WBS_SIGNAL_MARKER'];
      if (marker === undefined) throw new Error('missing marker');
      await runEngineLifecycle(
        {
          start: () => { appendFileSync(marker, 'started\\n'); return Promise.resolve(); },
          stop: () => { appendFileSync(marker, 'stopped\\n'); return Promise.resolve(); },
        },
        () => { appendFileSync(marker, 'ready\\n'); return new Promise(() => {}); },
      );
    `;
    const child = Bun.spawn(['bun', '-e', childScript], {
      env: { ...process.env, WBS_SIGNAL_MARKER: marker },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        try {
          if (readFileSync(marker, 'utf8').includes('ready')) break;
        } catch (error: unknown) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error;
        }
        await Bun.sleep(10);
      }
      expect(readFileSync(marker, 'utf8')).toContain('ready');

      child.kill('SIGTERM');
      expect(await child.exited).toBe(143);
      expect(readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual([
        'started',
        'ready',
        'stopped',
      ]);
    } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('owns SIGTERM cleanup while engine startup is still in progress', async () => {
    const root = scratchSync('wbs-engine-start-signal-');
    const marker = join(root, 'lifecycle.log');
    const moduleUrl = new URL('./main.ts', import.meta.url).href;
    const childScript = `
      import { appendFileSync } from 'node:fs';
      import { runEngineLifecycle } from ${JSON.stringify(moduleUrl)};
      const marker = process.env['WBS_SIGNAL_MARKER'];
      if (marker === undefined) throw new Error('missing marker');
      await runEngineLifecycle(
        {
          start: () => {
            appendFileSync(marker, 'start-entered\\nengine-running\\n');
            return new Promise(() => {});
          },
          stop: () => { appendFileSync(marker, 'stopped\\n'); return Promise.resolve(); },
        },
        () => { appendFileSync(marker, 'publish-entered\\n'); return Promise.resolve(); },
      );
    `;
    const child = Bun.spawn(['bun', '-e', childScript], {
      env: { ...process.env, WBS_SIGNAL_MARKER: marker },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        try {
          if (readFileSync(marker, 'utf8').includes('engine-running')) break;
        } catch (error: unknown) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error;
        }
        await Bun.sleep(10);
      }
      expect(readFileSync(marker, 'utf8')).toContain('engine-running');

      child.kill('SIGTERM');
      expect(await child.exited).toBe(143);
      expect(readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual([
        'start-entered',
        'engine-running',
        'stopped',
      ]);
    } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runAdmittedPublish', () => {
  it('refuses unsafe capacity before starting the engine or calling publish', async () => {
    const calls: string[] = [];
    const engine: EngineControl = {
      start: () => {
        calls.push('start');
        return Promise.resolve();
      },
      stop: () => {
        calls.push('stop');
        return Promise.resolve();
      },
    };

    const failure = await captureFailure(() =>
      runAdmittedPublish(
        { ...safeCapacity, availableMemoryBytes: 8 * 1024 ** 3 - 1 },
        engine,
        () => {
          calls.push('publish');
          return Promise.resolve();
        },
      ),
    );
    expect(failure.message).toContain('available memory');
    // Proof: this is the production ordering boundary, not a detached parser.
    expect(calls).toEqual([]);
  });

  it('publishes inside the bounded engine lifecycle after admission', async () => {
    const calls: string[] = [];
    const engine: EngineControl = {
      start: () => {
        calls.push('start');
        return Promise.resolve();
      },
      stop: () => {
        calls.push('stop');
        return Promise.resolve();
      },
    };

    await runAdmittedPublish(safeCapacity, engine, () => {
      calls.push('publish');
      return Promise.resolve();
    });
    expect(calls).toEqual(['start', 'publish', 'stop']);
  });
});

describe('applyRunnerHostAlias', () => {
  it('populates the real variable when only the friendly one is set', () => {
    const env: NodeJS.ProcessEnv = { DAGGER_RUNNER_HOST: 'tcp://127.0.0.1:8080' };
    applyRunnerHostAlias(env);
    expect(env['_EXPERIMENTAL_DAGGER_RUNNER_HOST']).toBe('tcp://127.0.0.1:8080');
  });

  it('leaves an already-set real variable untouched', () => {
    const env: NodeJS.ProcessEnv = {
      DAGGER_RUNNER_HOST: 'tcp://127.0.0.1:9999',
      _EXPERIMENTAL_DAGGER_RUNNER_HOST: 'tcp://127.0.0.1:8080',
    };
    applyRunnerHostAlias(env);
    expect(env['_EXPERIMENTAL_DAGGER_RUNNER_HOST']).toBe('tcp://127.0.0.1:8080');
  });
});

describe('requireRegistryPassword', () => {
  it('returns the password when REGISTRY_PASS is set', () => {
    const env: NodeJS.ProcessEnv = { REGISTRY_PASS: 'hunter2' };
    expect(requireRegistryPassword(env)).toBe('hunter2');
  });

  it('fails fast, naming the variable, rather than allowing an unauthenticated push', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => requireRegistryPassword(env)).toThrow(/REGISTRY_PASS/);
  });

  it('treats an empty string the same as unset', () => {
    const env: NodeJS.ProcessEnv = { REGISTRY_PASS: '' };
    expect(() => requireRegistryPassword(env)).toThrow(/REGISTRY_PASS/);
  });
});

// I3: publishAll's build context is the working tree, but publish-all labels
// the result with HEAD, and tool-deploy's migration gate reads migrations
// from git at that label. An uncommitted migration would therefore ship
// inside the image while being invisible to the gate. Driven against a real
// throwaway git repo rather than a stubbed `git`, because the property under
// test is what `git status --porcelain` actually reports.
describe('assertCleanTree', () => {
  let repo: string;
  let cwd: string;

  const git = (...args: string[]): void => {
    const p = Bun.spawnSync(['git', ...args], { cwd: repo });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString('utf8')}`);
  };

  beforeEach(() => {
    cwd = process.cwd();
    repo = scratchSync('wbs-cleantree-');
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('passes on a clean tree', () => {
    expect(() => {
      assertCleanTree();
    }).not.toThrow();
  });

  it('checks an explicit repository while publishing from an exported non-repository tree', () => {
    const exportedTree = scratchSync('wbs-exported-tree-');
    process.chdir(exportedTree);
    try {
      expect(() => {
        assertCleanTree(repo);
      }).not.toThrow();
    } finally {
      process.chdir(repo);
      rmSync(exportedTree, { recursive: true, force: true });
    }
  });

  // Proof: before assertCleanTree passed `-C repository`, both cases failed in
  // the exported tree with exit 128 instead of inspecting the injected fault.
  it('refuses a dirty explicit repository while cwd is an exported tree', () => {
    const exportedTree = scratchSync('wbs-exported-tree-');
    writeFileSync(join(repo, 'tracked.txt'), 'injected dirty source\n');
    process.chdir(exportedTree);
    try {
      expect(() => {
        assertCleanTree(repo);
      }).toThrow(/tracked\.txt/);
    } finally {
      process.chdir(repo);
      rmSync(exportedTree, { recursive: true, force: true });
    }
  });

  it('fails closed and names an explicit non-repository path', () => {
    const nonRepository = scratchSync('wbs-non-repository-');
    try {
      expect(() => {
        assertCleanTree(nonRepository);
      }).toThrow(new RegExp(`git -C ${nonRepository} status --porcelain failed`));
    } finally {
      rmSync(nonRepository, { recursive: true, force: true });
    }
  });

  it('refuses when a tracked file is modified, naming the file', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'uncommitted edit\n');
    expect(() => {
      assertCleanTree();
    }).toThrow(/tracked\.txt/);
  });

  it('refuses on an untracked migration, which is the fail-open it closes', () => {
    writeFileSync(join(repo, '0002_add_column.sql'), 'ALTER TABLE t ADD COLUMN c;\n');
    expect(() => {
      assertCleanTree();
    }).toThrow(/dirty working tree/);
  });
});

describe('cleanTreeRepository', () => {
  it('uses the devsync contract variable and otherwise keeps the ordinary cwd default', () => {
    expect(cleanTreeRepository({ WBS_CLEAN_TREE_REPOSITORY: '/real/source' })).toBe('/real/source');
    expect(cleanTreeRepository({})).toBe('.');
  });
});

/**
 * The engine tag is derived from the SDK (see `ENGINE_IMAGE`), so those two
 * cannot drift; the runbook's stated CLI version is the third copy, and the
 * one a person installs on h2puni from. Held here to the same string.
 *
 * Proof: with the SDK at 0.21.9 and the runbook still saying v0.21.8, both
 * cases failed on `Expected to contain: "\`dagger\` v0.21.9"` and
 * `Expected to contain: "registry.dagger.io/engine:v0.21.9"`. And with
 * `ENGINE_IMAGE` pinned back to the v0.21.8 literal, `engineCreateArgs` and
 * two `assertEngineContract` cases failed on `engine image mismatch: expected
 * registry.dagger.io/engine:v0.21.8` — the SDK had moved and the engine had
 * not, which is the drift this arrangement exists to stop (2026-09-06).
 */
describe("the prod runbook names the SDK's dagger", () => {
  const runbook = readFileSync(
    new URL('../../../docs/runbook-prod-deploy.md', import.meta.url),
    'utf8',
  );

  it('as the CLI version to install on h2puni', () => {
    expect(runbook).toContain(`\`dagger\` v${sdkVersion}`);
  });

  it('as the engine image the CLI is pinned to', () => {
    expect(runbook).toContain(`registry.dagger.io/engine:v${sdkVersion}`);
  });
});
