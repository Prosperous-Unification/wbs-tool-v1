import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeOptimizedResult } from '@wbs/contracts/solver/optimized-result';
import { encodePlanInfeasible } from '@wbs/contracts/solver/plan-infeasible';
import { encodeSchedule, type Schedule, schedule } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

import { capturedOptimizationReaderOf } from './captured-optimization-reader';
import { type Drizzle, openDatabase, openDrizzle } from './db';
import { runMigrations } from './migrate';
import { allocateGeneration } from './optimization-generation';
import { scheduleInputHash } from './schedule-input-hash';
import { optimizationGeneration, optimizedScheduleCache, solverQueue, solverSlot } from './schema';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;
const CONTRACT = '7+1.0.0';
const BUDGET = 60_000;
const NOW = 100;

const INPUT: ScheduleInput = {
  rows: [{ id: 'leaf', parentId: null, position: 10, frozenNumber: null, priority: 3 }],
  edges: [],
  slices: [
    {
      workItemId: 'leaf',
      stepId: 'build',
      days: 2,
      personId: null,
      width: 1,
      poolIds: [],
    },
  ],
  notBefore: new Map([['leaf', 1]]),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map([['leaf', 9]]),
};

const PLAN = schedule(
  INPUT.rows,
  INPUT.edges,
  INPUT.slices,
  INPUT.notBefore,
  INPUT.poolSizes,
  INPUT.reach,
  INPUT.deadlines,
);

function database(): { readonly db: Drizzle; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-captured-optimizer-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const raw = openDatabase(path);
  try {
    raw.run(
      `INSERT INTO users (id, username, password_hash, created_at) VALUES ('u-1', 'u', 'h', 1)`,
    );
    raw.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at)
       VALUES ('p-1', 'Captured plan', 'u-1', 0, 0, 1)`,
    );
  } finally {
    raw.close();
  }
  return {
    db: openDrizzle(path),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function allocate(db: Drizzle, input: ScheduleInput = INPUT): number {
  return allocateGeneration(db, 'p-1', CONTRACT, scheduleInputHash(input), 1);
}

function store(
  db: Drizzle,
  generation: number,
  values: {
    readonly objective: 'pri' | 'time';
    readonly status: 'ok' | 'failed' | 'plan-infeasible';
    readonly resultJson: string | null;
    readonly failureReason: 'timeout' | null;
    readonly input?: ScheduleInput;
  },
): void {
  db.insert(optimizedScheduleCache)
    .values({
      projectId: 'p-1',
      inputHash: scheduleInputHash(values.input ?? INPUT),
      objective: values.objective,
      contractVersion: CONTRACT,
      budgetMs: BUDGET,
      generation,
      status: values.status,
      resultJson: values.resultJson,
      failureReason: values.failureReason,
      createdAt: 7,
    })
    .run();
}

function encodedPlan(plan: Schedule = PLAN): string {
  return JSON.stringify(
    encodeOptimizedResult({
      publication: 'solver',
      objectiveValues: {
        makespan: { value: 2, stageValue: 2, bound: 2, status: 'optimal' },
        priority: { value: 0, stageValue: 0, bound: 0, status: 'optimal' },
        movement: { value: 0, stageValue: 0, bound: 0, status: 'optimal' },
      },
      schedule: plan,
    }),
  );
}

const ask = (input: ScheduleInput = INPUT) => ({
  projectId: 'p-1',
  objective: 'pri' as const,
  input,
  enabled: false,
});

describe('capturedOptimizationReaderOf', () => {
  it('reads a ready exact key even though capture never enables admission', () => {
    const fixture = database();
    try {
      const generation = allocate(fixture.db);
      store(fixture.db, generation, {
        objective: 'pri',
        status: 'ok',
        resultJson: encodedPlan(),
        failureReason: null,
      });
      const read = capturedOptimizationReaderOf(fixture.db, {
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
        now: () => NOW,
      });

      const answer = read(ask());
      // Proof: reusing live readPlan's `enabled:false` early return made this
      // `null` instead of 1 and removed the stored PRI schedule from the answer.
      expect(answer.generation).toBe(generation);
      expect(answer.variants).toEqual({
        pri: { state: 'ready', proof: 'proven' },
        time: { state: 'idle' },
      });
      expect(answer.schedules.pri === null ? null : encodeSchedule(answer.schedules.pri)).toEqual(
        encodeSchedule(PLAN),
      );
      expect(answer.schedules.time).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('adds exact-key slot and queue liveness without admitting work', () => {
    const fixture = database();
    try {
      const generation = allocate(fixture.db);
      store(fixture.db, generation, {
        objective: 'pri',
        status: 'failed',
        resultJson: null,
        failureReason: 'timeout',
      });
      fixture.db
        .insert(solverSlot)
        .values({
          projectId: 'p-1',
          contractVersion: CONTRACT,
          generation,
          objective: 'pri',
          budgetMs: BUDGET,
          ownerId: 'owner-1',
          attemptToken: 'attempt-1',
          lifecycle: 'running',
          pid: 42,
          startedAt: 1,
          heartbeatAt: 1,
          cancelRequestedAt: null,
          admittedDeadlineAt: NOW + 1,
        })
        .run();
      fixture.db
        .insert(solverQueue)
        .values({
          projectId: 'p-1',
          contractVersion: CONTRACT,
          generation,
          objective: 'time',
          budgetMs: BUDGET,
          admittedCancelEpoch: 0,
          enqueuedAt: 2,
        })
        .run();

      const before = {
        generations: fixture.db.select().from(optimizationGeneration).all(),
        slots: fixture.db.select().from(solverSlot).all(),
        queue: fixture.db.select().from(solverQueue).all(),
      };
      const answer = capturedOptimizationReaderOf(fixture.db, {
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
        now: () => NOW,
      })(ask());

      expect(answer.variants).toEqual({
        pri: { state: 'retrying' },
        time: { state: 'pending' },
      });
      expect({
        generations: fixture.db.select().from(optimizationGeneration).all(),
        slots: fixture.db.select().from(solverSlot).all(),
        queue: fixture.db.select().from(solverQueue).all(),
      }).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it('reports failed, corrupt and infeasible stored outcomes without schedules', () => {
    const fixture = database();
    try {
      const generation = allocate(fixture.db);
      store(fixture.db, generation, {
        objective: 'pri',
        status: 'failed',
        resultJson: null,
        failureReason: 'timeout',
      });
      store(fixture.db, generation, {
        objective: 'time',
        status: 'ok',
        resultJson: '{',
        failureReason: null,
      });
      const read = capturedOptimizationReaderOf(fixture.db, {
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
        now: () => NOW,
      });

      expect(read(ask()).variants).toEqual({
        pri: { state: 'failed', reason: 'timeout' },
        time: { state: 'corrupt', message: "JSON Parse error: Expected '}'" },
      });
      fixture.db
        .delete(optimizedScheduleCache)
        .where(eq(optimizedScheduleCache.projectId, 'p-1'))
        .run();
      store(fixture.db, generation, {
        objective: 'pri',
        status: 'plan-infeasible',
        resultJson: JSON.stringify(
          encodePlanInfeasible({
            items: [
              { ownerWorkItemId: 'leaf', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 0 },
            ],
          }),
        ),
        failureReason: null,
      });
      const infeasible = read(ask());
      expect(infeasible.variants.pri).toEqual({
        state: 'plan-infeasible',
        items: [{ ownerWorkItemId: 'leaf', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 0 }],
      });
      expect(infeasible.schedules).toEqual({ pri: null, time: null });
    } finally {
      fixture.cleanup();
    }
  });

  it('misses an unallocated or mismatched key and leaves every state table unchanged', () => {
    const fixture = database();
    try {
      const changed: ScheduleInput = { ...INPUT, deadlines: new Map([['leaf', 8]]) };
      const beforeUnallocated = {
        generations: fixture.db.select().from(optimizationGeneration).all(),
        slots: fixture.db.select().from(solverSlot).all(),
        queue: fixture.db.select().from(solverQueue).all(),
      };
      const read = capturedOptimizationReaderOf(fixture.db, {
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
        now: () => NOW,
      });
      const unallocated = read(ask());
      // Proof: replacing this capture read with the production coordinator's
      // `readPlan({ enabled:true })` returned generation 1 instead of `null`.
      expect(unallocated.generation).toBeNull();
      expect(unallocated.variants).toEqual({ pri: { state: 'idle' }, time: { state: 'idle' } });
      expect({
        generations: fixture.db.select().from(optimizationGeneration).all(),
        slots: fixture.db.select().from(solverSlot).all(),
        queue: fixture.db.select().from(solverQueue).all(),
      }).toEqual(beforeUnallocated);

      const generation = allocate(fixture.db);
      store(fixture.db, generation, {
        objective: 'pri',
        status: 'ok',
        resultJson: encodedPlan(),
        failureReason: null,
      });
      const mismatched = read(ask(changed));
      expect(mismatched.generation).toBe(generation);
      expect(mismatched.variants).toEqual({ pri: { state: 'idle' }, time: { state: 'idle' } });
      expect(mismatched.schedules).toEqual({ pri: null, time: null });
    } finally {
      fixture.cleanup();
    }
  });
});
