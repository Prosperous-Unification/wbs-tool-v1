import { describe, expect, it } from 'bun:test';

import {
  decodeSolverPreparationState,
  prepareSolverBindingBeforeReset,
  prepareSolverBindingUnderExclusion,
  resumeSolverBindingBeforeReset,
  runTargetPinnedSolverPreparation,
  SOLVER_COMPATIBILITY_PATHS,
  solverCompatibilityIdentityAt,
  type SolverPreparationState,
} from './solver-preparation';

const SOURCE_SHA = 'a'.repeat(40);
const OTHER_SOURCE_SHA = 'b'.repeat(40);
const IDENTITY = 'c'.repeat(64);
const IMAGE = `registry.example/wbs-be@sha256:${'d'.repeat(64)}`;

const STATE: SolverPreparationState = {
  schemaVersion: 1,
  compatibilityIdentity: IDENTITY,
  sourceSha: SOURCE_SHA,
  image: IMAGE,
  phase: 'published',
};

const stateBytes = (state: unknown = STATE): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(state));

describe('the solver compatibility identity', () => {
  it('moves for a solver byte and stays put for an unrelated source change', async () => {
    const solverTreeA = '1'.repeat(40);
    const solverTreeB = '2'.repeat(40);
    const dockerfile = '3'.repeat(40);
    const objects = new Map([
      [`${SOURCE_SHA}:libs/solver-py`, solverTreeA],
      [`${SOURCE_SHA}:apps/be-01/Dockerfile`, dockerfile],
      [`${OTHER_SOURCE_SHA}:libs/solver-py`, solverTreeA],
      [`${OTHER_SOURCE_SHA}:apps/be-01/Dockerfile`, dockerfile],
      [`${'e'.repeat(40)}:libs/solver-py`, solverTreeB],
      [`${'e'.repeat(40)}:apps/be-01/Dockerfile`, dockerfile],
    ]);
    const reads: string[] = [];
    const objectIdAt = (sourceSha: string, path: string): Promise<string> => {
      reads.push(`${sourceSha}:${path}`);
      const objectId = objects.get(`${sourceSha}:${path}`);
      if (objectId === undefined) throw new Error('fixture has no object id');
      return Promise.resolve(objectId);
    };

    const original = await solverCompatibilityIdentityAt(SOURCE_SHA, { objectIdAt });
    const unrelated = await solverCompatibilityIdentityAt(OTHER_SOURCE_SHA, { objectIdAt });
    const solverChanged = await solverCompatibilityIdentityAt('e'.repeat(40), { objectIdAt });

    expect(original).toBe(unrelated);
    expect(solverChanged).not.toBe(original);
    expect(reads.slice(0, 2)).toEqual(
      SOLVER_COMPATIBILITY_PATHS.map((path) => `${SOURCE_SHA}:${path}`),
    );
  });

  it('refuses an unreadable compatibility entry instead of hashing partial evidence', async () => {
    expect(
      await rejection(
        solverCompatibilityIdentityAt(SOURCE_SHA, {
          objectIdAt: (_sourceSha, path) =>
            path === 'libs/solver-py'
              ? Promise.resolve('1'.repeat(40))
              : Promise.resolve('(missing)'),
        }),
      ),
    ).toContain('invalid git object id');
  });
});

describe('durable solver preparation state', () => {
  it('decodes one complete published record', () => {
    expect(decodeSolverPreparationState(stateBytes())).toEqual(STATE);
  });

  it('refuses missing and partial state', () => {
    expect(() => decodeSolverPreparationState(undefined)).toThrow(/state is missing/);
    expect(() =>
      decodeSolverPreparationState(
        stateBytes({
          schemaVersion: 1,
          compatibilityIdentity: IDENTITY,
          sourceSha: SOURCE_SHA,
          phase: 'published',
        }),
      ),
    ).toThrow(/image/);
  });

  it('refuses a non-immutable image identity', () => {
    expect(() =>
      decodeSolverPreparationState(stateBytes({ ...STATE, image: 'registry.example/wbs-be:main' })),
    ).toThrow(/digest-pinned/);
  });
});

describe('the target-pinned solver preparation runner', () => {
  it('runs the target module from a separate target checkout', async () => {
    const invocations: { cwd: string; argv: readonly string[] }[] = [];

    await runTargetPinnedSolverPreparation(
      {
        root: '/home/puni1/wbs-dev/targets/solver-a',
        modulePath: '/home/puni1/wbs-dev/targets/solver-a/tools/tool-devsync/src/prepare-solver.ts',
        sourceSha: SOURCE_SHA,
        compatibilityIdentity: IDENTITY,
        statePath: '/home/puni1/wbs-dev/state/solver-preparation.json',
      },
      stateBytes(),
      {
        bunPath: '/home/puni1/wbs-dev/bin/bun',
        command: (invocation) => {
          invocations.push(invocation);
          return Promise.resolve({ exitCode: 0, stderr: '' });
        },
      },
    );

    expect(invocations).toEqual([
      {
        cwd: '/home/puni1/wbs-dev/targets/solver-a',
        argv: [
          '/home/puni1/wbs-dev/bin/bun',
          '/home/puni1/wbs-dev/targets/solver-a/tools/tool-devsync/src/prepare-solver.ts',
          `--source-sha=${SOURCE_SHA}`,
          `--compatibility-identity=${IDENTITY}`,
          '--state=/home/puni1/wbs-dev/state/solver-preparation.json',
        ],
      },
    ]);
  });

  it('refuses code imported from the old live checkout before host mutation', async () => {
    let commands = 0;

    expect(
      await rejection(
        runTargetPinnedSolverPreparation(
          {
            root: '/home/puni1/wbs-dev/src',
            modulePath: '/home/puni1/wbs-dev/src/tools/tool-devsync/src/prepare-solver.ts',
            sourceSha: SOURCE_SHA,
            compatibilityIdentity: IDENTITY,
            statePath: '/home/puni1/wbs-dev/state/solver-preparation.json',
          },
          stateBytes(),
          {
            bunPath: '/home/puni1/wbs-dev/bin/bun',
            command: () => {
              commands += 1;
              return Promise.resolve({ exitCode: 0, stderr: '' });
            },
          },
        ),
      ),
    ).toContain('old live checkout');
    expect(commands).toBe(0);
  });

  it('refuses missing, partial, and target-mismatched state before host mutation', async () => {
    let commands = 0;
    const target = {
      root: '/home/puni1/wbs-dev/targets/solver-a',
      modulePath: '/home/puni1/wbs-dev/targets/solver-a/prepare-solver.ts',
      sourceSha: SOURCE_SHA,
      compatibilityIdentity: IDENTITY,
      statePath: '/home/puni1/wbs-dev/state/solver-preparation.json',
    };
    const dependencies = {
      bunPath: '/home/puni1/wbs-dev/bin/bun',
      command: () => {
        commands += 1;
        return Promise.resolve({ exitCode: 0, stderr: '' });
      },
    };

    expect(
      await rejection(runTargetPinnedSolverPreparation(target, undefined, dependencies)),
    ).toContain('state is missing');
    expect(
      await rejection(
        runTargetPinnedSolverPreparation(
          target,
          stateBytes({ ...STATE, image: undefined }),
          dependencies,
        ),
      ),
    ).toContain('image');
    expect(
      await rejection(
        runTargetPinnedSolverPreparation(
          target,
          stateBytes({ ...STATE, sourceSha: OTHER_SOURCE_SHA }),
          dependencies,
        ),
      ),
    ).toContain('source SHA does not match target');
    expect(
      await rejection(
        runTargetPinnedSolverPreparation(
          target,
          stateBytes({ ...STATE, compatibilityIdentity: 'f'.repeat(64) }),
          dependencies,
        ),
      ),
    ).toContain('compatibility identity does not match target');
    expect(commands).toBe(0);
  });
});

describe('solver binding preparation order', () => {
  const target = {
    sourceSha: SOURCE_SHA,
    compatibilityIdentity: IDENTITY,
  };

  it('publishes, materializes, installs, and verifies before reset', async () => {
    const events: string[] = [];

    await prepareSolverBindingBeforeReset(target, {
      publish: (received) => {
        expect(received).toEqual(target);
        events.push('publish');
        return Promise.resolve(IMAGE);
      },
      materialize: (binding) => {
        expect(binding).toEqual({ ...target, image: IMAGE });
        events.push('materialize');
        return Promise.resolve();
      },
      install: (binding) => {
        expect(binding).toEqual({ ...target, image: IMAGE });
        events.push('install');
        return Promise.resolve();
      },
      preflight: (binding) => {
        expect(binding).toEqual({ ...target, image: IMAGE });
        events.push('preflight');
        return Promise.resolve();
      },
      reset: (sourceSha) => {
        expect(sourceSha).toBe(SOURCE_SHA);
        events.push('reset');
        return Promise.resolve();
      },
    });

    expect(events).toEqual(['publish', 'materialize', 'install', 'preflight', 'reset']);
  });

  it('never resets when any required preparation phase fails', async () => {
    for (const failing of ['publish', 'materialize', 'install', 'preflight'] as const) {
      const events: string[] = [];
      const phase = (name: typeof failing): Promise<void> => {
        events.push(name);
        if (name === failing) return Promise.reject(new Error(`${name} refused`));
        return Promise.resolve();
      };

      expect(
        await rejection(
          prepareSolverBindingBeforeReset(target, {
            publish: async () => {
              await phase('publish');
              return IMAGE;
            },
            materialize: () => phase('materialize'),
            install: () => phase('install'),
            preflight: () => phase('preflight'),
            reset: () => {
              events.push('reset');
              return Promise.resolve();
            },
          }),
        ),
      ).toContain(`${failing} refused`);
      expect(events).not.toContain('reset');
    }
  });

  it('refuses a tag-only publish result before materialization or reset', async () => {
    const events: string[] = [];

    expect(
      await rejection(
        prepareSolverBindingBeforeReset(target, {
          publish: () => Promise.resolve('registry.example/wbs-be:main'),
          materialize: () => {
            events.push('materialize');
            return Promise.resolve();
          },
          install: () => Promise.resolve(),
          preflight: () => Promise.resolve(),
          reset: () => {
            events.push('reset');
            return Promise.resolve();
          },
        }),
      ),
    ).toContain('digest-pinned');
    expect(events).toEqual([]);
  });
});

describe('solver binding exclusion', () => {
  it('refuses an overlapping target before it can publish or install', async () => {
    let held = false;
    const exclusion = {
      tryAcquire: () => {
        if (held) return Promise.resolve(undefined);
        held = true;
        return Promise.resolve({
          release: () => {
            held = false;
            return Promise.resolve();
          },
        });
      },
    };
    let unblockPublish: (() => void) | undefined;
    const publishBlocked = new Promise<void>((resolve) => {
      unblockPublish = resolve;
    });
    const events: string[] = [];
    const dependencies = (label: string, blocked: boolean) => ({
      publish: async () => {
        events.push(`publish:${label}`);
        if (blocked) await publishBlocked;
        return IMAGE;
      },
      materialize: () => {
        events.push(`materialize:${label}`);
        return Promise.resolve();
      },
      install: () => {
        events.push(`install:${label}`);
        return Promise.resolve();
      },
      preflight: () => {
        events.push(`preflight:${label}`);
        return Promise.resolve();
      },
      reset: () => {
        events.push(`reset:${label}`);
        return Promise.resolve();
      },
    });

    const first = prepareSolverBindingUnderExclusion(
      { sourceSha: SOURCE_SHA, compatibilityIdentity: IDENTITY },
      exclusion,
      dependencies('first', true),
    );
    await Promise.resolve();
    expect(
      await rejection(
        prepareSolverBindingUnderExclusion(
          { sourceSha: OTHER_SOURCE_SHA, compatibilityIdentity: IDENTITY },
          exclusion,
          dependencies('second', false),
        ),
      ),
    ).toContain('exclusion is already held');
    expect(events).toEqual(['publish:first']);

    unblockPublish?.();
    await first;
    expect(events).toEqual([
      'publish:first',
      'materialize:first',
      'install:first',
      'preflight:first',
      'reset:first',
    ]);
    expect(held).toBe(false);
  });
});

describe('solver binding retries', () => {
  it('reuses one published digest after an interrupted install', async () => {
    const checkpoints: SolverPreparationState[] = [];
    const events: string[] = [];
    let publishes = 0;
    let interruptInstall = true;
    const dependencies = {
      publish: () => {
        publishes += 1;
        return Promise.resolve(IMAGE);
      },
      checkpoint: (state: SolverPreparationState) => {
        checkpoints.push(state);
        return Promise.resolve();
      },
      withHostMutationLock: (action: () => Promise<void>) => action(),
      materialize: (binding: { image: string }) => {
        events.push(`materialize:${binding.image}`);
        return Promise.resolve();
      },
      install: (binding: { image: string }) => {
        events.push(`install:${binding.image}`);
        return interruptInstall
          ? Promise.reject(new Error('install interrupted'))
          : Promise.resolve();
      },
      preflight: (binding: { image: string }) => {
        events.push(`preflight:${binding.image}`);
        return Promise.resolve();
      },
      reset: () => {
        events.push('reset');
        return Promise.resolve();
      },
    };
    const target = { sourceSha: SOURCE_SHA, compatibilityIdentity: IDENTITY };

    expect(
      await rejection(resumeSolverBindingBeforeReset(target, undefined, dependencies)),
    ).toContain('install interrupted');
    expect(checkpoints).toEqual([{ ...STATE, phase: 'published' }]);
    expect(events).not.toContain('reset');

    interruptInstall = false;
    await resumeSolverBindingBeforeReset(target, stateBytes(checkpoints[0]), dependencies);
    expect(publishes).toBe(1);
    expect(checkpoints).toEqual([
      { ...STATE, phase: 'published' },
      { ...STATE, phase: 'complete' },
    ]);
    expect(events.at(-1)).toBe('reset');
    expect(events.filter((event) => event.includes(IMAGE))).toHaveLength(5);
  });

  it('rebinds a published digest when an unrelated successor changes only the source SHA', async () => {
    const checkpoints: SolverPreparationState[] = [];
    const events: string[] = [];
    await resumeSolverBindingBeforeReset(
      { sourceSha: SOURCE_SHA, compatibilityIdentity: IDENTITY },
      stateBytes({ ...STATE, sourceSha: OTHER_SOURCE_SHA }),
      {
        publish: () => Promise.reject(new Error('matching identity must reuse its image')),
        checkpoint: (state) => {
          checkpoints.push(state);
          return Promise.resolve();
        },
        withHostMutationLock: async (action) => {
          events.push('lock');
          await action();
          events.push('unlock');
        },
        materialize: () => {
          events.push('materialize');
          return Promise.resolve();
        },
        install: () => {
          events.push('install');
          return Promise.resolve();
        },
        preflight: () => {
          events.push('preflight');
          return Promise.resolve();
        },
        reset: () => {
          events.push('reset');
          return Promise.resolve();
        },
      },
    );
    expect(checkpoints).toEqual([
      { ...STATE, sourceSha: SOURCE_SHA, phase: 'published' },
      { ...STATE, sourceSha: SOURCE_SHA, phase: 'complete' },
    ]);
    expect(events).toEqual(['lock', 'materialize', 'install', 'preflight', 'unlock', 'reset']);
  });

  it('rechecks a completed binding before reset', async () => {
    const events: string[] = [];
    await resumeSolverBindingBeforeReset(
      { sourceSha: SOURCE_SHA, compatibilityIdentity: IDENTITY },
      stateBytes({ ...STATE, phase: 'complete' }),
      {
        publish: () => Promise.reject(new Error('completed binding must not publish')),
        checkpoint: () => Promise.reject(new Error('completed binding must not checkpoint')),
        withHostMutationLock: () =>
          Promise.reject(new Error('healthy completed binding must not take mutation lock')),
        materialize: () => Promise.reject(new Error('completed binding must not materialize')),
        install: () => Promise.reject(new Error('completed binding must not install')),
        preflight: () => {
          events.push('preflight');
          return Promise.resolve();
        },
        reset: () => {
          events.push('reset');
          return Promise.resolve();
        },
      },
    );
    expect(events).toEqual(['preflight', 'reset']);
  });

  it('repairs an overwritten completed binding once under the host mutation lock', async () => {
    const events: string[] = [];
    let checks = 0;
    await resumeSolverBindingBeforeReset(
      { sourceSha: SOURCE_SHA, compatibilityIdentity: IDENTITY },
      stateBytes({ ...STATE, phase: 'complete' }),
      {
        publish: () => Promise.reject(new Error('completed binding must not publish')),
        checkpoint: () => Promise.resolve(),
        withHostMutationLock: async (action) => {
          events.push('lock');
          await action();
          events.push('unlock');
        },
        materialize: () => {
          events.push('materialize');
          return Promise.resolve();
        },
        install: () => {
          events.push('install');
          return Promise.resolve();
        },
        preflight: () => {
          checks += 1;
          events.push(`preflight:${String(checks)}`);
          return checks === 1
            ? Promise.reject(new Error('mapping overwritten'))
            : Promise.resolve();
        },
        reset: () => {
          events.push('reset');
          return Promise.resolve();
        },
      },
    );
    expect(events).toEqual([
      'preflight:1',
      'lock',
      'materialize',
      'install',
      'preflight:2',
      'unlock',
      'reset',
    ]);
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
