import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import { runMigrations } from './migrate';
import { bindSolverSlot, reserveSolverSlot } from './optimization-admission';
import { allocateGeneration } from './optimization-generation';
import { optimizationGeneration, solverSlot } from './schema';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CONTRACT = '7+0.1.0';
const BUDGET = 60_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepared() {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-admission-'));
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
  const generation = allocateGeneration(db, 'p-1', CONTRACT, 'hash-1', 2);
  return { path, db, generation };
}

describe('reserveSolverSlot', () => {
  it('binds exactly one launcher PID to the current starting token', () => {
    const { db, generation } = prepared();
    expect(
      reserveSolverSlot(db, {
        projectId: 'p-1',
        contractVersion: CONTRACT,
        generation,
        objective: 'pri',
        budgetMs: BUDGET,
        ownerId: 'blue',
        attemptToken: 'blue-token',
        now: 10,
      }),
    ).toMatchObject({ kind: 'reserved' });
    const common = {
      projectId: 'p-1',
      contractVersion: CONTRACT,
      generation,
      objective: 'pri' as const,
      budgetMs: BUDGET,
    };

    expect(bindSolverSlot(db, { ...common, attemptToken: 'stale-token', pid: 41 })).toBe(false);
    expect(bindSolverSlot(db, { ...common, attemptToken: 'blue-token', pid: 42 })).toBe(true);
    expect(bindSolverSlot(db, { ...common, attemptToken: 'blue-token', pid: 43 })).toBe(false);
    const [bound] = db.select().from(solverSlot).all();
    expect(bound.lifecycle).toBe('running');
    expect(bound.pid).toBe(42);
    expect(bound.attemptToken).toBe('blue-token');

    // Proof: dropping either the token or `starting` predicate lets PID 41 or
    // 43 claim a row that belongs to another lifecycle attempt.
  });

  it('coalesces two coordinators on one full slot key', () => {
    const { db, generation } = prepared();
    const common = {
      projectId: 'p-1',
      contractVersion: CONTRACT,
      generation,
      objective: 'pri' as const,
      budgetMs: BUDGET,
      now: 10,
    };

    expect(
      reserveSolverSlot(db, { ...common, ownerId: 'blue', attemptToken: 'blue-token' }),
    ).toMatchObject({ kind: 'reserved', attemptToken: 'blue-token' });
    for (const [index, objective] of ['time', 'pri', 'time'].entries()) {
      expect(
        reserveSolverSlot(db, {
          ...common,
          objective: objective as 'pri' | 'time',
          budgetMs: BUDGET + index + 1,
          ownerId: `other-${String(index)}`,
          attemptToken: `other-token-${String(index)}`,
        }),
      ).toMatchObject({ kind: 'reserved' });
    }
    expect(
      reserveSolverSlot(db, { ...common, ownerId: 'green', attemptToken: 'green-token' }),
    ).toEqual({ kind: 'already-present' });
    const slots = db.select().from(solverSlot).all();
    expect(slots).toHaveLength(4);
    const blue = slots.find((slot) => slot.ownerId === 'blue');
    expect(blue?.attemptToken).toBe('blue-token');
    expect(blue?.lifecycle).toBe('starting');
    expect(blue?.pid).toBeNull();

    // Proof: deleting the existing-key check makes the second result
    // `project-full` once four seats exist, rather than coalescing by identity.
  });

  it('refuses admission after the generation is closed', () => {
    const { path, db, generation } = prepared();
    const raw = openDatabase(path);
    try {
      raw.run(
        `UPDATE optimization_generation SET admission_state = 'draining' WHERE project_id = 'p-1'`,
      );
    } finally {
      raw.close();
    }

    expect(
      reserveSolverSlot(db, {
        projectId: 'p-1',
        contractVersion: CONTRACT,
        generation,
        objective: 'pri',
        budgetMs: 60_000,
        ownerId: 'blue',
        attemptToken: 'blue-token',
        now: 10,
      }),
    ).toEqual({ kind: 'closed' });
    expect(db.select().from(solverSlot).all()).toEqual([]);
  });

  it('counts every unreleased budget against the four-seat project ceiling', () => {
    const { db, generation } = prepared();
    for (const [index, objective] of ['pri', 'time', 'pri', 'time'].entries()) {
      expect(
        reserveSolverSlot(db, {
          projectId: 'p-1',
          contractVersion: CONTRACT,
          generation,
          objective: objective as 'pri' | 'time',
          budgetMs: 60_000 + index,
          ownerId: `owner-${String(index)}`,
          attemptToken: `token-${String(index)}`,
          now: 10,
        }),
      ).toMatchObject({ kind: 'reserved' });
    }

    expect(
      reserveSolverSlot(db, {
        projectId: 'p-1',
        contractVersion: CONTRACT,
        generation,
        objective: 'pri',
        budgetMs: 70_000,
        ownerId: 'fifth',
        attemptToken: 'fifth-token',
        now: 10,
      }),
    ).toEqual({ kind: 'project-full' });
    expect(db.select().from(solverSlot).all()).toHaveLength(4);

    // Proof: counting only one budget or only `running` rows fails here with a
    // fifth `starting` reservation, the overlap the SQLite ceiling must prevent.
  });

  it('reclaims only slots past their stored deadlines before counting capacity', () => {
    const { db, generation } = prepared();
    const common = {
      projectId: 'p-1',
      contractVersion: CONTRACT,
      generation,
      objective: 'pri' as const,
      ownerId: 'owner',
      now: 10,
    };
    for (const budgetMs of [0, 1, 2, 100_000]) {
      expect(
        reserveSolverSlot(db, {
          ...common,
          budgetMs,
          attemptToken: `token-${String(budgetMs)}`,
        }),
      ).toMatchObject({ kind: 'reserved' });
    }

    expect(
      reserveSolverSlot(db, {
        ...common,
        budgetMs: 200_000,
        attemptToken: 'replacement-token',
        now: 20_013,
      }),
    ).toMatchObject({ kind: 'reserved', attemptToken: 'replacement-token' });
    expect(
      db
        .select({ budgetMs: solverSlot.budgetMs })
        .from(solverSlot)
        .all()
        .map((row) => row.budgetMs)
        .sort((left, right) => left - right),
    ).toEqual([100_000, 200_000]);

    // Proof: omitting the reclaim returns `project-full`; recomputing a common
    // deadline incorrectly removes the 100_000 ms child as well.
  });

  it('finishes a drain in the transaction that reclaims its last expired slot', () => {
    const { path, db, generation } = prepared();
    expect(
      reserveSolverSlot(db, {
        projectId: 'p-1',
        contractVersion: CONTRACT,
        generation,
        objective: 'pri',
        budgetMs: 0,
        ownerId: 'old-owner',
        attemptToken: 'old-token',
        now: 10,
      }),
    ).toMatchObject({ kind: 'reserved' });
    const raw = openDatabase(path);
    try {
      raw.run(
        `UPDATE optimization_generation SET admission_state = 'draining' WHERE project_id = 'p-1'`,
      );
    } finally {
      raw.close();
    }

    expect(
      reserveSolverSlot(db, {
        projectId: 'p-1',
        contractVersion: CONTRACT,
        generation,
        objective: 'time',
        budgetMs: BUDGET,
        ownerId: 'new-owner',
        attemptToken: 'new-token',
        now: 20_011,
      }),
    ).toEqual({ kind: 'closed' });
    expect(db.select().from(solverSlot).all()).toEqual([]);
    expect(db.select().from(optimizationGeneration).all()).toEqual([]);

    // Proof: deleting the finish call reclaims the slot but leaves the retired
    // generation wedged with no owner left to complete it.
  });
});
