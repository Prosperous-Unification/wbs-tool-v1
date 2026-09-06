import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from '../repository/db';
import { DrizzleEventLogRepo } from '../repository/event-log';
import { runMigrations } from '../repository/migrate';
import { reserveSolverSlot } from '../repository/optimization-admission';
import { releaseSolverSlot } from '../repository/optimization-drain';
import { allocateGeneration, readGeneration } from '../repository/optimization-generation';
import { enqueueSolverRequest } from '../repository/optimization-queue';
import { solverQueue, solverSlot } from '../repository/schema';
import {
  OptimizationCoordinator,
  type ReservedSolverChild,
  type ReservedSpawnRequest,
} from './optimization-coordinator';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CONTRACT = '7+0.1.0';
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

function stream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepared(): { path: string; db: ReturnType<typeof openDrizzle>; generation: number } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-restart-'));
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
  const db = openDrizzle(path);
  const generation = allocateGeneration(db, 'p-1', CONTRACT, scheduleInputHash(INPUT), 1);
  return { path, db, generation };
}

function queued(
  db: ReturnType<typeof openDrizzle>,
  generation: number,
  objective: 'pri' | 'time',
): void {
  expect(
    enqueueSolverRequest(db, {
      projectId: 'p-1',
      contractVersion: CONTRACT,
      generation,
      objective,
      budgetMs: BUDGET,
      enqueuedAt: 2,
    }),
  ).toEqual({ kind: 'queued' });
}

function restarted(
  db: ReturnType<typeof openDrizzle>,
  calls: ReservedSpawnRequest[],
  interval: (callback: () => void) => unknown = () => 'timer',
): OptimizationCoordinator {
  let token = 0;
  return new OptimizationCoordinator({
    db,
    contractVersion: CONTRACT,
    solverVersion: '0.1.0',
    budgetMs: BUDGET,
    ownerId: 'restarted',
    now: () => 10,
    attemptToken: () => `restart-token-${String(token++)}`,
    inputOf: () => Promise.resolve(INPUT),
    enabledOf: () => Promise.resolve(true),
    spawn: (request): Promise<ReservedSolverChild> => {
      calls.push(request);
      return Promise.resolve({
        pid: 200 + calls.length,
        stdout: stream(),
        stderr: stream(),
        exited: Promise.resolve(1),
        verdict: () => undefined,
        kill: () => undefined,
      });
    },
    eventLog: new DrizzleEventLogRepo(db),
    pushRecorded: () => Promise.resolve(),
    setInterval: interval,
    clearInterval: () => undefined,
    onChildError: (error) => {
      throw error;
    },
  });
}

describe('OptimizationCoordinator restart semantics', () => {
  it('does not adopt or duplicate old children and retries their durable variants after release', async () => {
    const { db, generation } = prepared();
    for (const objective of ['pri', 'time'] as const) {
      expect(
        reserveSolverSlot(db, {
          projectId: 'p-1',
          contractVersion: CONTRACT,
          generation,
          objective,
          budgetMs: BUDGET,
          ownerId: 'dead-coordinator',
          attemptToken: `orphan-${objective}`,
          now: 1,
        }),
      ).toMatchObject({ kind: 'reserved' });
      queued(db, generation, objective);
    }

    let tick = (): void => {
      throw new Error('restart interval was not installed');
    };
    const calls: ReservedSpawnRequest[] = [];
    const instance = restarted(db, calls, (callback) => {
      tick = callback;
      return 'timer';
    });
    instance.start();
    await instance.drain();

    expect(calls).toEqual([]);
    expect(db.select().from(solverQueue).all()).toHaveLength(2);
    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    await instance.drain();
    expect(calls).toEqual([]);
    expect(readGeneration(db, 'p-1', CONTRACT)?.generation).toBe(generation);

    for (const objective of ['pri', 'time'] as const) {
      expect(
        releaseSolverSlot(db, {
          projectId: 'p-1',
          contractVersion: CONTRACT,
          generation,
          objective,
          budgetMs: BUDGET,
          attemptToken: `orphan-${objective}`,
        }).released,
      ).toBe(true);
    }
    tick();
    await instance.drain();

    expect(calls.map(({ objective }) => objective)).toEqual(['pri', 'time']);
    expect(
      calls.every(({ admission }) => admission.attemptToken.startsWith('restart-token-')),
    ).toBe(true);
    expect(calls.every((request) => request.generation === generation)).toBe(true);
    expect(db.select().from(solverQueue).all()).toEqual([]);
    expect(db.select().from(solverSlot).all()).toEqual([]);
    await instance.stop();

    // Proof: consuming `already-present` at dequeue makes the post-release
    // tick spawn zero. Ignoring the slot makes startup spawn beside both live
    // orphans; allocating on the unchanged read changes `generation` to 2.
  });

  it('launches a valid durable entry left by the prior coordinator', async () => {
    const { db, generation } = prepared();
    queued(db, generation, 'pri');
    const calls: ReservedSpawnRequest[] = [];
    const instance = restarted(db, calls);

    instance.start();
    await instance.drain();

    expect(calls.map(({ objective }) => objective)).toEqual(['pri']);
    expect(calls[0].generation).toBe(generation);
    expect(db.select().from(solverQueue).all()).toEqual([]);
    await instance.stop();

    // Proof: discarding all prior-process queue entries leaves `calls` empty.
  });

  it('discards generation, cancel-epoch, and project-toggle failures without spawning', async () => {
    const mutations = [
      `UPDATE optimization_generation SET generation = generation + 1 WHERE project_id = 'p-1'`,
      `UPDATE optimization_generation SET cancel_epoch = cancel_epoch + 1 WHERE project_id = 'p-1'`,
      `UPDATE project SET optimization_enabled = 0 WHERE id = 'p-1'`,
    ];
    for (const mutation of mutations) {
      const { path, db, generation } = prepared();
      queued(db, generation, 'pri');
      const raw = openDatabase(path);
      try {
        raw.run(mutation);
      } finally {
        raw.close();
      }
      const calls: ReservedSpawnRequest[] = [];
      const instance = restarted(db, calls);

      instance.start();
      await instance.drain();

      expect(calls).toEqual([]);
      expect(db.select().from(solverQueue).all()).toEqual([]);
      expect(db.select().from(solverSlot).all()).toEqual([]);
      await instance.stop();
    }

    // Proof: weakening any one dequeue predicate makes its corresponding loop
    // iteration reserve a slot and invoke the injected spawner.
  });
});
