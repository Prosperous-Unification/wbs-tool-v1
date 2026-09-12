import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OptimizedResult } from '@wbs/contracts/solver/optimized-result';
import type { SolverFailureReason } from '@wbs/contracts/solver/solver-failure-disposition';
import { schedule } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import { DrizzleEventLogStore } from './event-log';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { reserveSolverSlot } from './optimization-admission';
import { allocateGeneration } from './optimization-generation';
import { storeOptimizedOutcomeAndRecord } from './optimized-outcome';
import type { OutcomeWrite } from './optimized-schedule-cache';
import { scheduleInputHash } from './schedule-input-hash';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;
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
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimized-outcome-'));
  dirs.push(dir);
  const path = join(dir, 'outcome.db');
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
      const eventLog = new DrizzleEventLogStore(db, OPEN);
      const committed = storeOptimizedOutcomeAndRecord(db, eventLog, {
        ...admittedWrite(db),
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
    // Proof: restricting the event transaction to ok outcomes leaves the first event absent.
  });

  it('rolls a plan-infeasible certificate back when recording its event crashes', () => {
    const { path, db } = database();
    const write: OutcomeWrite = {
      ...admittedWrite(db),
      outcome: {
        kind: 'plan-infeasible',
        certificate: {
          items: [{ ownerWorkItemId: 'w-1', boundWorkItemId: 'w-1', effectiveDeadlineOffset: 0 }],
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
    // Proof: putting the cache insert outside this transaction leaves one cache row after the crash.
  });

  it('replays the durable record when the process stops before the live push', async () => {
    const { db } = database();
    const eventLog = new DrizzleEventLogStore(db, OPEN);
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
    // Proof: deleting recordEventIn from the transaction leaves the replay empty.
  });
});
