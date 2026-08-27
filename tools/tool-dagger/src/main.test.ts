import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  applyRunnerHostAlias,
  assertBuildCapacity,
  assertCleanTree,
  assertEngineContract,
  type BuildCapacity,
  createDockerEngineControl,
  type EngineControl,
  engineCreateArgs,
  readBuildCapacity,
  requireRegistryPassword,
  runAdmittedPublish,
  runEngineLifecycle,
} from './main';

const expectedEngine = {
  Config: {
    Image: 'registry.dagger.io/engine:v0.21.8',
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
    throw new Error(`expected Error, received ${String(error)}`);
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
    root = mkdtempSync(join(tmpdir(), 'wbs-capacity-'));
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
      'registry.dagger.io/engine:v0.21.8',
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
        return { exitCode: 1, stdout: '', stderr: 'error: no such object: wbs-dagger-engine' };
      }
      return { exitCode: 0, stdout: 'created', stderr: '' };
    });

    // Proof: this is Docker 29.0.3's exact live missing-container spelling.
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
    repo = mkdtempSync(join(tmpdir(), 'wbs-cleantree-'));
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
