import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from '../repository/db';
import { DrizzleEventLogStore, type RecordedEvent } from '../repository/event-log';
import { OPEN } from '../repository/gate';
import { runMigrations } from '../repository/migrate';
import { scheduleInputHash } from '../repository/schedule-input-hash';
import { OptimizationCoordinator, type OptimizationOutcomeEvent } from './optimization-coordinator';

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
const HASH = scheduleInputHash(INPUT);
const DEADLINED_INPUT: ScheduleInput = {
  ...INPUT,
  deadlines: new Map([['w-1', 0]]),
};
const RESPONSE = `${JSON.stringify({
  wireVersion: 1,
  status: 'feasible',
  offsets: { 'w-1\u0000step-dev': 0 },
  objectiveValues: {
    makespan: { value: 96, stageValue: 96, bound: 96, status: 'optimal' },
    priority: { value: 0, stageValue: 0, bound: 0, status: 'optimal' },
    movement: { value: 0, stageValue: 0, bound: 0, status: 'optimal' },
  },
})}\n`;
const INFEASIBLE_RESPONSE = `${JSON.stringify({
  wireVersion: 1,
  status: 'infeasible',
})}\n`;
const dirs: string[] = [];

function database(): { path: string; db: ReturnType<typeof openDrizzle> } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-events-'));
  dirs.push(dir);
  const path = join(dir, 'events.db');
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
  return { path, db: openDrizzle(path) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('optimized outcome events', () => {
  it('records and pushes both preflight failures without launching a process', async () => {
    const { db } = database();
    const pushed: OptimizationOutcomeEvent[] = [];
    let launches = 0;
    let token = 0;
    const instance = new OptimizationCoordinator({
      db,
      contractVersion: CONTRACT,
      solverVersion: '0.1.0',
      budgetMs: BUDGET,
      ownerId: 'blue',
      now: () => 10,
      attemptToken: () => `attempt-${String(token++)}`,
      inputOf: () => Promise.resolve(INPUT),
      enabledOf: () => Promise.resolve(true),
      spawn: () => {
        launches += 1;
        throw new Error('preflight failure reached launcher');
      },
      eventLog: new DrizzleEventLogStore(db, OPEN),
      pushRecorded: (_subscription, _recorded, event) => {
        pushed.push(event);
        return Promise.resolve();
      },
      onChildError: (error) => {
        throw error;
      },
    });
    const tooLate: ScheduleInput = {
      ...INPUT,
      notBefore: new Map([['w-1', 50_000_000]]),
    };

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: tooLate })).toBeNull();
    await instance.drain();
    expect(launches).toBe(0);
    expect(pushed).toHaveLength(2);
    expect(pushed.map((event) => event.type)).toEqual([
      'schedule_optimization_failed',
      'schedule_optimization_failed',
    ]);
    expect(
      pushed.every(
        (event) =>
          event.type === 'schedule_optimization_failed' &&
          event.failureReason === 'horizon-overflow' &&
          event.budgetMs === BUDGET,
      ),
    ).toBe(true);
    // Proof: suppressing failure recording/pushing leaves this at zero events;
    // passing preflight failures to `spawn` increments `launches` instead.
  });

  it('records and pushes each plan-infeasible certificate with its full release identity', async () => {
    const { path, db } = database();
    const pushed: OptimizationOutcomeEvent[] = [];
    let token = 0;
    const instance = new OptimizationCoordinator({
      db,
      contractVersion: CONTRACT,
      solverVersion: '0.1.0',
      budgetMs: BUDGET,
      ownerId: 'blue',
      now: () => 10,
      attemptToken: () => `attempt-${String(token++)}`,
      inputOf: () => Promise.resolve(DEADLINED_INPUT),
      enabledOf: () => Promise.resolve(true),
      spawn: () =>
        Promise.resolve({
          pid: 100 + token,
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
          verdict: () => undefined,
          kill: () => undefined,
        }),
      runChild: async (options) => {
        await options.onExit({ code: 0, stdout: INFEASIBLE_RESPONSE, stderr: '' });
        return { kind: 'exited', code: 0 };
      },
      eventLog: new DrizzleEventLogStore(db, OPEN),
      pushRecorded: (_subscription, _recorded, event) => {
        pushed.push(event);
        return Promise.resolve();
      },
      onChildError: (error) => {
        throw error;
      },
    });

    expect(
      instance.read({ projectId: 'p-1', objective: 'pri', input: DEADLINED_INPUT }),
    ).toBeNull();
    await instance.drain();

    expect(pushed).toEqual([
      {
        type: 'schedule_optimization_infeasible',
        projectId: 'p-1',
        generation: 1,
        inputHash: scheduleInputHash(DEADLINED_INPUT),
        objective: 'pri',
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
      },
      {
        type: 'schedule_optimization_infeasible',
        projectId: 'p-1',
        generation: 1,
        inputHash: scheduleInputHash(DEADLINED_INPUT),
        objective: 'time',
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
      },
    ]);
    expect(await new DrizzleEventLogStore(db, OPEN).rangeSince('project:p-1', -1)).toHaveLength(2);
    const raw = openDatabase(path);
    try {
      expect(
        raw.query('SELECT status FROM optimized_schedule_cache ORDER BY objective').all(),
      ).toEqual([{ status: 'plan-infeasible' }, { status: 'plan-infeasible' }]);
    } finally {
      raw.close();
    }

    // 8.6 / WATCHED RED W5, and the reason the refusal is asserted *here*
    // rather than only in `optimization-coordinator.db.test.ts`: that suite
    // inserts the `plan-infeasible` row itself, so it proves the refusal for a
    // row a fixture wrote and can say nothing about how the row got its status.
    // This row is the one the solve above just produced from a real
    // `status: 'infeasible'` response, through `evaluateSolverOutcome`. W5's
    // substitution — `response.status === 'unknown' || === 'infeasible'` in
    // `solver-exit-outcome.ts` — therefore reaches this line: the row becomes
    // `failed`, `failed` is exactly what Retry admits, and an infeasible plan
    // starts offering a Retry that re-solves an unchanged input for the same
    // proof. That is W5's own sentence, and no test could carry it until 8.7d
    // gave the refusal a route to be refused at.
    for (const objective of ['pri', 'time'] as const) {
      expect(
        instance.retry({
          projectId: 'p-1',
          objective,
          inputHash: scheduleInputHash(DEADLINED_INPUT),
          input: DEADLINED_INPUT,
        }),
      ).toEqual({ kind: 'not-retryable', state: 'plan-infeasible' });
    }
    // Proof: restoring the plan-infeasible early return in
    // `storeOptimizedOutcomeAndRecord` leaves both durable events and pushes absent.
  });

  it('records each new result once and pushes only after both durable rows commit', async () => {
    const { path, db } = database();
    const pushed: {
      readonly recorded: RecordedEvent;
      readonly event: OptimizationOutcomeEvent;
    }[] = [];
    let token = 0;
    const instance = new OptimizationCoordinator({
      db,
      contractVersion: CONTRACT,
      solverVersion: '0.1.0',
      budgetMs: BUDGET,
      ownerId: 'blue',
      now: () => 10,
      attemptToken: () => `attempt-${String(token++)}`,
      inputOf: () => Promise.resolve(INPUT),
      enabledOf: () => Promise.resolve(true),
      spawn: () =>
        Promise.resolve({
          pid: 100 + token,
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
          verdict: () => undefined,
          kill: () => undefined,
        }),
      runChild: async (options) => {
        await options.onExit({ code: 0, stdout: RESPONSE, stderr: '' });
        return { kind: 'exited', code: 0 };
      },
      eventLog: new DrizzleEventLogStore(db, OPEN),
      pushRecorded: (_subscription, recorded, event) => {
        const raw = openDatabase(path);
        try {
          const cacheCount = raw
            .query('SELECT COUNT(*) AS n FROM optimized_schedule_cache')
            .get() as {
            n: number;
          };
          const eventCount = raw.query('SELECT COUNT(*) AS n FROM event_log').get() as {
            n: number;
          };
          expect(cacheCount.n).toBeGreaterThan(0);
          expect(eventCount.n).toBeGreaterThan(0);
        } finally {
          raw.close();
        }
        pushed.push({ recorded, event });
        return Promise.resolve();
      },
      onChildError: (error) => {
        throw error;
      },
    });

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    await instance.drain();
    expect(pushed).toHaveLength(2);
    expect(pushed.find(({ event }) => event.objective === 'pri')?.event).toEqual({
      type: 'schedule_optimized',
      projectId: 'p-1',
      generation: 1,
      inputHash: HASH,
      objective: 'pri',
      contractVersion: CONTRACT,
      budgetMs: BUDGET,
    });

    instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT });
    await instance.drain();
    expect(pushed).toHaveLength(2);
    const raw = openDatabase(path);
    try {
      expect((raw.query('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(2);
    } finally {
      raw.close();
    }
    // Proof: publishing `schedule_optimized` from `readPlan` when this cache
    // hit is observed makes `pushed` contain 3 above instead of 2.
  });
});
