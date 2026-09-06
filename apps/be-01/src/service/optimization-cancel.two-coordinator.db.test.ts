import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from '../repository/db';
import { DrizzleEventLogRepo } from '../repository/event-log';
import { runMigrations } from '../repository/migrate';
import { bindSolverSlot, reserveSolverSlot } from '../repository/optimization-admission';
import { allocateGeneration } from '../repository/optimization-generation';
import { storeOptimizedOutcome } from '../repository/optimized-schedule-cache';
import { ProjectRepository } from '../repository/project';
import { optimizedScheduleCache, solverQueue, solverSlot } from '../repository/schema';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { clockOf } from './clock';
import {
  OptimizationCoordinator,
  type ReservedSolverChild,
  type ReservedSpawnRequest,
} from './optimization-coordinator';
import { ProjectService } from './project.service';
import {
  runSolverChildLifecycle,
  type SolverChildLifecycleOptions,
  type SolverChildSlot,
} from './solver-child-lifecycle';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CONTRACT = '7+1.0.0';
const BUDGET = 60_000;
const INPUT: ScheduleInput = {
  rows: [{ id: 'w-1', parentId: null, position: 10, frozenNumber: null, priority: null }],
  edges: [],
  slices: [
    {
      workItemId: 'w-1',
      stepId: 'step-dev',
      days: 2,
      personId: null,
      width: 1,
      poolIds: [],
    },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
};
const dirs: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-cancel-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const raw = openDatabase(path);
  try {
    raw.run(
      `INSERT INTO users (id, username, password_hash, created_at)
       VALUES ('u-1', 'owner', 'hash', 1)`,
    );
    raw.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at,
                            optimization_enabled, schedule_engine, schedule_objective)
       VALUES ('p-1', 'Plan', 'u-1', 0, 0, 1, 1, 'optimized', 'pri')`,
    );
  } finally {
    raw.close();
  }
  return { path, blue: openDrizzle(path), green: openDrizzle(path) };
}

function childProcess(): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => undefined, 1000)'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  return child;
}

function heartbeatGate(): {
  readonly sleep: NonNullable<SolverChildLifecycleOptions['sleep']>;
  readonly wake: () => void;
} {
  let wake = (): void => {
    throw new Error('heartbeat wait was not armed');
  };
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    wake: () => {
      wake();
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('optimizer cancellation condition did not arrive');
}

describe('cross-coordinator cancellation', () => {
  it('kills both real children inside one heartbeat and fences their late outcomes', async () => {
    const { blue, green } = database();
    const generation = allocateGeneration(blue, 'p-1', CONTRACT, 'hash-1', 10);
    const running = (['pri', 'time'] as const).map((objective) => {
      const child = childProcess();
      const admission = reserveSolverSlot(blue, {
        projectId: 'p-1',
        contractVersion: CONTRACT,
        generation,
        objective,
        budgetMs: BUDGET,
        ownerId: 'blue',
        attemptToken: `blue-${objective}`,
        now: 10,
      });
      if (admission.kind !== 'reserved') throw new Error(`expected ${objective} reservation`);
      const slot: SolverChildSlot = {
        projectId: 'p-1',
        contractVersion: CONTRACT,
        generation,
        objective,
        budgetMs: BUDGET,
        attemptToken: admission.attemptToken,
        admittedCancelEpoch: admission.admittedCancelEpoch,
      };
      expect(bindSolverSlot(blue, { ...slot, pid: child.pid })).toBe(true);
      const heartbeat = heartbeatGate();
      const lifecycle = runSolverChildLifecycle({
        db: blue,
        slot,
        child,
        now: () => 50,
        sleep: heartbeat.sleep,
        onExit: () => {
          throw new Error('a cancelled child reached the outcome path');
        },
      });
      return { admission, child, heartbeat, lifecycle, slot };
    });
    blue
      .insert(solverQueue)
      .values({
        projectId: 'p-1',
        contractVersion: CONTRACT,
        objective: 'pri',
        budgetMs: 120_000,
        generation,
        admittedCancelEpoch: 0,
        enqueuedAt: 10,
      })
      .run();

    const broadcast = recordingBroadcaster();
    const service = new ProjectService({
      projects: new ProjectRepository(green),
      broadcast,
      optimizerAvailable: () => true,
      clock: clockOf({ now: () => 50 }),
    });
    expect(await service.update('p-1', 'u-1', { optimizationEnabled: false })).toMatchObject({
      ok: true,
    });
    expect(await service.update('p-1', 'u-1', { optimizationEnabled: true })).toMatchObject({
      ok: true,
    });

    for (const attempt of running) {
      expect(
        storeOptimizedOutcome(blue, {
          claim: { ...attempt.slot, ownerId: 'blue' },
          inputHash: 'hash-1',
          admittedCancelEpoch: attempt.admission.admittedCancelEpoch,
          outcome: { kind: 'failed', reason: 'internal-error' },
          now: 50,
        }),
      ).toBe('superseded');
      attempt.heartbeat.wake();
    }

    const terminal = await Promise.all(running.map((attempt) => attempt.lifecycle));
    expect(terminal).toEqual([
      { kind: 'cancelled', reason: 'requested', code: 143 },
      { kind: 'cancelled', reason: 'requested', code: 143 },
    ]);
    expect(blue.select().from(solverSlot).all()).toEqual([]);
    expect(blue.select().from(solverQueue).all()).toEqual([]);
    expect(blue.select().from(optimizedScheduleCache).all()).toEqual([]);
    expect(broadcast.published.map(({ event }) => event.type)).toEqual([
      'project_settings_changed',
      'project_settings_changed',
    ]);

    // Proof: without the OFF transaction's epoch increment, both late writes
    // store after the ON patch and this fails on `superseded` before heartbeat.
  });

  it('ends the old real children and fences their outcomes during edit overlap', async () => {
    const { blue } = database();
    let input = INPUT;
    let token = 0;
    const attempts: {
      readonly request: ReservedSpawnRequest;
      readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
      readonly heartbeat: ReturnType<typeof heartbeatGate>;
    }[] = [];
    const errors: unknown[] = [];
    const instance = new OptimizationCoordinator({
      db: blue,
      contractVersion: CONTRACT,
      solverVersion: '0.1.0',
      budgetMs: BUDGET,
      ownerId: 'blue',
      now: () => 10,
      attemptToken: () => `blue-${String(token++)}`,
      inputOf: () => Promise.resolve(input),
      enabledOf: () => Promise.resolve(true),
      editDebounceMs: 0,
      sleep: () => Promise.resolve(),
      spawn: (request): Promise<ReservedSolverChild> => {
        const process = childProcess();
        const heartbeat = heartbeatGate();
        attempts.push({ request, process, heartbeat });
        return Promise.resolve({
          pid: process.pid,
          stdout: process.stdout,
          stderr: process.stderr,
          exited: process.exited,
          verdict: () => undefined,
          kill: () => {
            process.kill();
          },
        });
      },
      runChild: (options) => {
        const attempt = attempts.find(({ process }) => process.pid === options.child.pid);
        if (attempt === undefined) throw new Error('spawned child was not recorded');
        return runSolverChildLifecycle({ ...options, sleep: attempt.heartbeat.sleep });
      },
      eventLog: new DrizzleEventLogRepo(blue),
      pushRecorded: () => Promise.resolve(),
      onChildError: (error) => errors.push(error),
    });

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input })).toBeNull();
    await until(
      () =>
        attempts.length === 2 &&
        blue
          .select({ lifecycle: solverSlot.lifecycle })
          .from(solverSlot)
          .all()
          .every(({ lifecycle }) => lifecycle === 'running'),
    );
    const firstGeneration = attempts[0].request.generation;

    input = {
      ...INPUT,
      slices: INPUT.slices.map((slice) => ({ ...slice, days: (slice.days ?? 0) + 1 })),
    };
    instance.inputChanged('p-1');
    await until(
      () =>
        attempts.length === 4 &&
        blue
          .select({ lifecycle: solverSlot.lifecycle })
          .from(solverSlot)
          .all()
          .every(({ lifecycle }) => lifecycle === 'running'),
    );

    expect(attempts.map(({ request }) => request.objective)).toEqual([
      'pri',
      'time',
      'pri',
      'time',
    ]);
    expect(new Set(attempts.slice(0, 2).map(({ request }) => request.generation))).toEqual(
      new Set([firstGeneration]),
    );
    expect(new Set(attempts.slice(2).map(({ request }) => request.generation))).toEqual(
      new Set([firstGeneration + 1]),
    );
    expect(blue.select().from(solverSlot).all()).toHaveLength(4);

    for (const attempt of attempts.slice(0, 2)) attempt.heartbeat.wake();
    const oldExitCodes = await Promise.all(
      attempts.slice(0, 2).map(({ process }) => process.exited),
    );
    await until(() => blue.select().from(solverSlot).all().length === 2);
    expect(oldExitCodes.every((code) => typeof code === 'number')).toBe(true);
    expect(
      blue
        .select()
        .from(optimizedScheduleCache)
        .all()
        .filter(({ generation }) => generation === firstGeneration),
    ).toEqual([]);

    for (const attempt of attempts.slice(2)) attempt.process.kill();
    await instance.drain();
    expect(blue.select().from(solverSlot).all()).toEqual([]);
    expect(errors).toEqual([]);
    expect(scheduleInputHash(input)).not.toBe(scheduleInputHash(INPUT));

    // Proof: dropping both durable generation-cancellation signals leaves the
    // first pair alive at its next heartbeat; releasing old seats before their
    // actual exits makes the sampled overlap exceed the SQLite-owned count.
  });
});
