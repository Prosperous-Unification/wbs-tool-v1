import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  applyRunnerHostAlias,
  assertBuildCapacity,
  assertCleanTree,
  engineCreateArgs,
  requireRegistryPassword,
  runAdmittedPublish,
  runEngineLifecycle,
  type BuildCapacity,
  type EngineControl,
} from './main';

const safeCapacity: BuildCapacity = {
  availableMemoryBytes: 9 * 1024 ** 3,
  tmpfsAvailableBytes: 15 * 1024 ** 3,
  tmpfsCapacityBytes: 16 * 1024 ** 3,
  load1: 7,
  cpuCount: 8,
};

describe('assertBuildCapacity', () => {
  it('admits the exact safe boundaries', () => {
    expect(() =>
      assertBuildCapacity({
        availableMemoryBytes: 8 * 1024 ** 3,
        tmpfsAvailableBytes: 12 * 1024 ** 3,
        tmpfsCapacityBytes: 16 * 1024 ** 3,
        load1: 8,
        cpuCount: 8,
      }),
    ).not.toThrow();
  });

  it.each([
    ['available memory', { availableMemoryBytes: 8 * 1024 ** 3 - 1 }],
    ['tmpfs occupancy', { tmpfsAvailableBytes: 12 * 1024 ** 3 - 1 }],
    ['one-minute load', { load1: 8.01 }],
  ])('refuses unsafe %s before an engine starts', (name, unsafe) => {
    // Proof: each injected measurement crosses exactly one production limit.
    expect(() => assertBuildCapacity({ ...safeCapacity, ...unsafe })).toThrow(name);
  });
});

describe('engineCreateArgs', () => {
  it('pins the engine image, loopback port, cache, memory, CPU, and PID ceilings', () => {
    expect(engineCreateArgs()).toEqual(
      expect.arrayContaining([
        '--memory=8g',
        '--memory-swap=8g',
        '--cpus=6',
        '--pids-limit=2048',
        '127.0.0.1:8081:8080',
        'wbs-dagger-engine:/var/lib/dagger',
        'registry.dagger.io/engine:v0.21.8',
      ]),
    );
  });
});

describe('runEngineLifecycle', () => {
  function control(stopError?: Error): { control: EngineControl; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      control: {
        start: async () => {
          calls.push('start');
        },
        stop: async () => {
          calls.push('stop');
          if (stopError !== undefined) throw stopError;
        },
      },
    };
  }

  it('stops the engine after a successful publish', async () => {
    const fixture = control();
    await expect(runEngineLifecycle(fixture.control, async () => 'published')).resolves.toBe(
      'published',
    );
    expect(fixture.calls).toEqual(['start', 'stop']);
  });

  it('stops the engine after a publish failure', async () => {
    const fixture = control();
    await expect(
      runEngineLifecycle(fixture.control, async () => {
        throw new Error('registry refused');
      }),
    ).rejects.toThrow('registry refused');
    expect(fixture.calls).toEqual(['start', 'stop']);
  });

  it('fails the run when stopping the engine fails', async () => {
    const fixture = control(new Error('engine remained resident'));
    // Proof: success cannot mask failure to return host capacity.
    await expect(runEngineLifecycle(fixture.control, async () => 'published')).rejects.toThrow(
      'engine remained resident',
    );
  });
});

describe('runAdmittedPublish', () => {
  it('refuses unsafe capacity before starting the engine or calling publish', async () => {
    const calls: string[] = [];
    const engine: EngineControl = {
      start: async () => {
        calls.push('start');
      },
      stop: async () => {
        calls.push('stop');
      },
    };

    await expect(
      runAdmittedPublish(
        { ...safeCapacity, availableMemoryBytes: 8 * 1024 ** 3 - 1 },
        engine,
        async () => {
          calls.push('publish');
        },
      ),
    ).rejects.toThrow('available memory');
    // Proof: this is the production ordering boundary, not a detached parser.
    expect(calls).toEqual([]);
  });

  it('publishes inside the bounded engine lifecycle after admission', async () => {
    const calls: string[] = [];
    const engine: EngineControl = {
      start: async () => {
        calls.push('start');
      },
      stop: async () => {
        calls.push('stop');
      },
    };

    await runAdmittedPublish(safeCapacity, engine, async () => {
      calls.push('publish');
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
