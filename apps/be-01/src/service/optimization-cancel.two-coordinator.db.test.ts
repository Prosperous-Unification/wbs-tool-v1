import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { bindSolverSlot, reserveSolverSlot } from '../repository/optimization-admission';
import { allocateGeneration } from '../repository/optimization-generation';
import { storeOptimizedOutcome } from '../repository/optimized-schedule-cache';
import { ProjectRepository } from '../repository/project';
import { optimizedScheduleCache, solverQueue, solverSlot } from '../repository/schema';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { clockOf } from './clock';
import { ProjectService } from './project.service';
import {
  runSolverChildLifecycle,
  type SolverChildLifecycleOptions,
  type SolverChildSlot,
} from './solver-child-lifecycle';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CONTRACT = '7+1.0.0';
const BUDGET = 60_000;
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

describe('an OFF patch served by the other coordinator', () => {
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
});
