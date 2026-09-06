import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import { runMigrations } from './migrate';
import { reserveSolverSlot } from './optimization-admission';
import { releaseSolverSlot } from './optimization-drain';
import { allocateGeneration, readGeneration } from './optimization-generation';
import {
  currentQueueInputHash,
  dequeueSolverRequest,
  enqueueSolverRequest,
} from './optimization-queue';
import { solverQueue, solverSlot } from './schema';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const BLUE = '7+0.1.0';
const GREEN = '8+0.1.0';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepared() {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-queue-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const raw = openDatabase(path);
  try {
    raw.run(`INSERT INTO users (id, username, password_hash, created_at)
      VALUES ('u-1', 'owner', 'hash', 1)`);
    for (const id of ['p-a', 'p-b']) {
      raw.run(
        `INSERT INTO project (id, name, owner_id, restricted, revision, created_at,
                              optimization_enabled, schedule_engine, schedule_objective)
         VALUES (?, ?, 'u-1', 0, 0, 1, 1, 'optimized', 'pri')`,
        [id, id],
      );
    }
  } finally {
    raw.close();
  }
  const db = openDrizzle(path);
  for (const projectId of ['p-a', 'p-b']) {
    allocateGeneration(db, projectId, BLUE, `hash-${projectId}`, 1);
  }
  allocateGeneration(db, 'p-a', GREEN, 'hash-p-a', 1);
  return { path, db };
}

function enqueue(
  db: ReturnType<typeof openDrizzle>,
  entry: {
    projectId: string;
    contractVersion: string;
    objective: 'pri' | 'time';
    budgetMs?: number;
    enqueuedAt?: number;
  },
) {
  return enqueueSolverRequest(db, {
    generation: 1,
    budgetMs: 60_000,
    enqueuedAt: 10,
    ...entry,
  });
}

describe('the durable solver FIFO', () => {
  it('uses every ordering term to dequeue one deterministic global order', () => {
    const { db } = prepared();
    const entries = [
      { projectId: 'p-b', contractVersion: BLUE, objective: 'time' as const },
      { projectId: 'p-a', contractVersion: GREEN, objective: 'pri' as const },
      { projectId: 'p-a', contractVersion: BLUE, objective: 'time' as const },
      {
        projectId: 'p-a',
        contractVersion: BLUE,
        objective: 'pri' as const,
        budgetMs: 60_001,
      },
      { projectId: 'p-a', contractVersion: BLUE, objective: 'pri' as const },
    ];
    for (const entry of entries) expect(enqueue(db, entry)).toEqual({ kind: 'queued' });

    const order: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const next = dequeueSolverRequest(db, {
        ownerId: `owner-${String(index)}`,
        attemptToken: `token-${String(index)}`,
        now: 20,
      });
      if (next.kind !== 'reserved') throw new Error(`expected reservation, got ${next.kind}`);
      order.push(
        `${next.entry.projectId}/${next.entry.contractVersion}/${next.entry.objective}/${String(next.entry.budgetMs)}`,
      );
    }
    expect(order).toEqual([
      `p-a/${BLUE}/pri/60000`,
      `p-a/${BLUE}/pri/60001`,
      `p-a/${BLUE}/time/60000`,
      `p-a/${GREEN}/pri/60000`,
      `p-b/${BLUE}/time/60000`,
    ]);
    expect(
      dequeueSolverRequest(db, {
        ownerId: 'last',
        attemptToken: 'last',
        now: 20,
      }),
    ).toEqual({
      kind: 'empty',
    });

    // Proof: each fixture is inserted in reverse order at the tie it breaks;
    // dropping a trailing ORDER BY term changes this exact spawn identity list.
  });

  it('coalesces one key and stores the generation cancel epoch at enqueue', () => {
    const { db } = prepared();
    const entry = {
      projectId: 'p-a',
      contractVersion: BLUE,
      objective: 'pri' as const,
    };
    expect(enqueue(db, entry)).toEqual({ kind: 'queued' });
    expect(enqueue(db, { ...entry, enqueuedAt: 99 })).toEqual({
      kind: 'already-present',
    });
    expect(
      db
        .select({
          epoch: solverQueue.admittedCancelEpoch,
          enqueuedAt: solverQueue.enqueuedAt,
        })
        .from(solverQueue)
        .all(),
    ).toEqual([{ epoch: 0, enqueuedAt: 10 }]);
  });

  it('keeps a capacity-blocked head until a slot can be reserved', () => {
    const { db } = prepared();
    for (let index = 0; index < 4; index += 1) {
      expect(
        reserveSolverSlot(db, {
          projectId: 'p-a',
          contractVersion: BLUE,
          generation: 1,
          objective: index % 2 === 0 ? 'pri' : 'time',
          budgetMs: 60_000 + index,
          ownerId: `owner-${String(index)}`,
          attemptToken: `token-${String(index)}`,
          now: 10,
        }),
      ).toMatchObject({ kind: 'reserved' });
    }
    expect(
      enqueue(db, {
        projectId: 'p-a',
        contractVersion: GREEN,
        objective: 'pri',
      }),
    ).toEqual({ kind: 'queued' });

    expect(
      dequeueSolverRequest(db, {
        ownerId: 'queued-owner',
        attemptToken: 'queued-token',
        now: 20,
      }),
    ).toEqual({ kind: 'capacity-full' });
    expect(db.select().from(solverQueue).all()).toHaveLength(1);

    expect(
      releaseSolverSlot(db, {
        projectId: 'p-a',
        contractVersion: BLUE,
        generation: 1,
        objective: 'pri',
        budgetMs: 60_000,
        attemptToken: 'token-0',
      }).released,
    ).toBe(true);
    expect(
      dequeueSolverRequest(db, {
        ownerId: 'queued-owner',
        attemptToken: 'queued-token',
        now: 20,
      }),
    ).toMatchObject({
      kind: 'reserved',
      entry: { projectId: 'p-a', contractVersion: GREEN, objective: 'pri' },
    });
    expect(db.select().from(solverQueue).all()).toEqual([]);

    // Proof: deleting a capacity-blocked head in dequeueSolverRequest makes
    // the second dequeue empty after the slot is released.
  });

  it('discards each stale or closed front entry without spending a slot', () => {
    const mutations = [
      `UPDATE optimization_generation SET generation = 2 WHERE project_id = 'p-a'`,
      `UPDATE optimization_generation SET admission_state = 'draining' WHERE project_id = 'p-a'`,
      `UPDATE optimization_generation SET cancel_epoch = 1 WHERE project_id = 'p-a'`,
      `UPDATE project SET optimization_enabled = 0 WHERE id = 'p-a'`,
      `UPDATE project SET optimization_delete_pending_at = 30 WHERE id = 'p-a'`,
    ];
    for (const mutation of mutations) {
      const { path, db } = prepared();
      expect(
        enqueue(db, {
          projectId: 'p-a',
          contractVersion: BLUE,
          objective: 'pri',
        }),
      ).toEqual({
        kind: 'queued',
      });
      const raw = openDatabase(path);
      try {
        raw.run(mutation);
      } finally {
        raw.close();
      }
      if (mutation.includes('generation = 2')) {
        const entry = db.select().from(solverQueue).get();
        if (entry === undefined) throw new Error('stale queue fixture disappeared');
        expect(currentQueueInputHash(readGeneration(db, 'p-a', BLUE), entry)).toBeNull();
      }
      expect(
        dequeueSolverRequest(db, {
          ownerId: 'blue',
          attemptToken: 'token',
          now: 40,
        }),
      ).toEqual({
        kind: 'empty',
      });
      expect(db.select().from(solverQueue).all()).toEqual([]);
      expect(db.select().from(solverSlot).all()).toEqual([]);
    }

    // Proof: removing the generation comparison makes the focused assertion
    // accept the old entry's hash even though generation 2 is current.
    // The epoch mutation leaves the generation current, open and ON;
    // omitting admittedCancelEpoch alone turns that case into a reservation.
    // Removing the project-toggle condition from reserveSolverSlotIn turns the
    // direct OFF mutation into a reservation through this dequeue path.
  });

  it('validates a stored objective before it reaches the spawn identity', () => {
    const { path, db } = prepared();
    enqueue(db, { projectId: 'p-a', contractVersion: BLUE, objective: 'pri' });
    const raw = openDatabase(path);
    try {
      raw.run('PRAGMA ignore_check_constraints = ON');
      raw.run(`UPDATE solver_queue SET objective = 'prio' WHERE project_id = 'p-a'`);
    } finally {
      raw.close();
    }

    expect(() =>
      dequeueSolverRequest(db, {
        ownerId: 'blue',
        attemptToken: 'token',
        now: 20,
      }),
    ).toThrow(/solver_queue\.objective.*prio/);
    expect(db.select().from(solverSlot).all()).toEqual([]);

    // Proof: removing toSolverQueueRow returns a reserved spawn identity whose
    // objective is the corrupt literal `prio` instead of throwing here.
  });
});
