import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OptimizedResult } from '@wbs/contracts/solver/optimized-result';
import { schedule } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from '../repository/db';
import { DrizzleEventLogRepo, type RecordedEvent } from '../repository/event-log';
import { runMigrations } from '../repository/migrate';
import { reserveSolverSlot } from '../repository/optimization-admission';
import { allocateGeneration } from '../repository/optimization-generation';
import type { OutcomeWrite } from '../repository/optimized-schedule-cache';
import type { SolverFailureReason } from '../repository/schema';
import {
  OptimizationCoordinator,
  type OptimizationOutcomeEvent,
  storeOptimizedOutcomeAndRecord,
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
const RESULT: OptimizedResult = {
  publication: 'solver',
  objectiveValues: {
    makespan: { value: 96, stageValue: 96, bound: 96, status: 'optimal' },
    priority: { value: 0, stageValue: 0, bound: 0, status: 'optimal' },
    movement: { value: 0, stageValue: 0, bound: 0, status: 'optimal' },
  },
  schedule: schedule(INPUT.rows, INPUT.edges, INPUT.slices, INPUT.notBefore, INPUT.poolSizes),
};

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

function admittedWrite(db: ReturnType<typeof openDrizzle>): OutcomeWrite {
  const generation = allocateGeneration(db, 'p-1', CONTRACT, HASH, 2);
  const admission = reserveSolverSlot(db, {
    projectId: 'p-1',
    contractVersion: CONTRACT,
    generation,
    objective: 'pri',
    budgetMs: BUDGET,
    ownerId: 'blue',
    attemptToken: 'attempt-1',
    now: 3,
  });
  if (admission.kind !== 'reserved') throw new Error(`unexpected admission ${admission.kind}`);
  return {
    claim: {
      projectId: 'p-1',
      contractVersion: CONTRACT,
      generation,
      objective: 'pri',
      budgetMs: BUDGET,
      ownerId: 'blue',
      attemptToken: admission.attemptToken,
    },
    inputHash: HASH,
    admittedCancelEpoch: admission.admittedCancelEpoch,
    outcome: { kind: 'ok', result: RESULT },
    now: 10,
  };
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
      eventLog: new DrizzleEventLogRepo(db),
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

  it('records each typed failure with its full release identity and no schedule', async () => {
    const reasons: readonly SolverFailureReason[] = [
      'timeout',
      'invalid-output',
      'no-solution',
      'internal-error',
      'oom',
      'horizon-overflow',
      'objective-overflow',
    ];

    for (const reason of reasons) {
      const { path, db } = database();
      const eventLog = new DrizzleEventLogRepo(db);
      const base = admittedWrite(db);
      const committed = storeOptimizedOutcomeAndRecord(db, eventLog, {
        ...base,
        outcome: { kind: 'failed', reason },
      });

      expect(committed.result).toBe('stored');
      expect(committed.event).toEqual({
        type: 'schedule_optimization_failed',
        projectId: 'p-1',
        generation: 1,
        inputHash: HASH,
        objective: 'pri',
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
        failureReason: reason,
      });
      expect(await eventLog.rangeSince('project:p-1', -1)).toHaveLength(1);
      const raw = openDatabase(path);
      try {
        expect(
          raw
            .query(
              `SELECT status, result_json AS resultJson, failure_reason AS failureReason
               FROM optimized_schedule_cache`,
            )
            .get(),
        ).toEqual({ status: 'failed', resultJson: null, failureReason: reason });
      } finally {
        raw.close();
      }
    }
    // Proof: restricting the event transaction to `outcome.kind === 'ok'`
    // leaves `committed.event` undefined on the first reason and fails here.
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
      eventLog: new DrizzleEventLogRepo(db),
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
    expect(await new DrizzleEventLogRepo(db).rangeSince('project:p-1', -1)).toHaveLength(2);
    const raw = openDatabase(path);
    try {
      expect(
        raw.query('SELECT status FROM optimized_schedule_cache ORDER BY objective').all(),
      ).toEqual([{ status: 'plan-infeasible' }, { status: 'plan-infeasible' }]);
    } finally {
      raw.close();
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
      eventLog: new DrizzleEventLogRepo(db),
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

  it('rolls a plan-infeasible certificate back when recording its event crashes', () => {
    const { path, db } = database();
    const write: OutcomeWrite = {
      ...admittedWrite(db),
      outcome: {
        kind: 'plan-infeasible',
        certificate: {
          items: [
            {
              ownerWorkItemId: 'w-1',
              boundWorkItemId: 'w-1',
              effectiveDeadlineOffset: 0,
            },
          ],
        },
      },
    };

    expect(() =>
      storeOptimizedOutcomeAndRecord(
        db,
        {
          recordEventIn: () => {
            throw new Error('injected event write crash');
          },
        },
        write,
      ),
    ).toThrow('injected event write crash');

    const raw = openDatabase(path);
    try {
      expect(
        (raw.query('SELECT COUNT(*) AS n FROM optimized_schedule_cache').get() as { n: number }).n,
      ).toBe(0);
      expect((raw.query('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(0);
    } finally {
      raw.close();
    }
    // Proof: split the cache insert into its own transaction and the first
    // assertion reads 1 after the injected event-write crash.
  });

  it('replays the durable record when the process stops before the live push', async () => {
    const { db } = database();
    const eventLog = new DrizzleEventLogRepo(db);
    const committed = storeOptimizedOutcomeAndRecord(db, eventLog, admittedWrite(db));

    expect(committed.result).toBe('stored');
    expect(committed.recorded?.seq).toBe(0);
    expect(await eventLog.rangeSince('project:p-1', -1)).toEqual([
      {
        subscription: 'project:p-1',
        seq: 0,
        message: committed.event,
        createdAt: 10,
      },
    ]);
    // Proof: deleting `recordEventIn` from the outcome transaction leaves the
    // replay empty; there is deliberately no live-push spy in this case.
  });
});
