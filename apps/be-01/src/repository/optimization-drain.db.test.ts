import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

import { type Drizzle, openDatabase, openDrizzle } from './db';
import type { WriteStamp } from './index';
import { runMigrations } from './migrate';
import {
  beginOptimizationDrain,
  finishOptimizationDrain,
  readOptimizationClosedState,
  reconcileOptimizationDrains,
  releaseSolverSlot,
} from './optimization-drain';
import { allocateGeneration, readGeneration } from './optimization-generation';
import {
  optimizationGeneration,
  optimizedScheduleCache,
  project,
  solverQueue,
  solverSlot,
} from './schema';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** The two releases running against one file during a swap. */
const BLUE = '7+1.0.0';
const GREEN = '8+1.0.0';

const stampAt = (at: number): WriteStamp => ({ at, by: 'u-1' });

let dir: string;
let path: string;
let db: Drizzle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-drain-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const seed = openDatabase(path);
  try {
    seed.run(
      `INSERT INTO users (id, username, password_hash, created_at) VALUES ('u-1', 'u', 'h', 1)`,
    );
    seed.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at)
       VALUES ('p-1', 'Rewire the shed', 'u-1', 0, 0, 1)`,
    );
    // The bystander. Deleting one project closes every release of THAT project,
    // which is only a meaningful claim beside a project it must not touch.
    seed.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at)
       VALUES ('p-2', 'Re-tile the roof', 'u-1', 0, 0, 1)`,
    );
  } finally {
    seed.close();
  }
  db = openDrizzle(path);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedQueue(contractVersion: string, generation: number, projectId = 'p-1'): void {
  db.insert(solverQueue)
    .values({
      projectId,
      contractVersion,
      objective: 'time',
      budgetMs: 60000,
      generation,
      admittedCancelEpoch: 0,
      enqueuedAt: 1,
    })
    .run();
}

function seedSlot(
  contractVersion: string,
  objective: 'pri' | 'time',
  cancelRequestedAt: number | null,
  projectId = 'p-1',
  admittedDeadlineAt = 61000,
): void {
  db.insert(solverSlot)
    .values({
      projectId,
      contractVersion,
      generation: 1,
      objective,
      budgetMs: 60000,
      ownerId: 'own-1',
      attemptToken: `tok-${projectId}-${contractVersion}-${objective}`,
      lifecycle: 'running',
      pid: 4242,
      startedAt: 1,
      heartbeatAt: 1,
      cancelRequestedAt,
      admittedDeadlineAt,
    })
    .run();
}

/** Every stored slot as `contractVersion/objective/cancelRequestedAt`. */
function slotRows(): string[] {
  return db
    .select()
    .from(solverSlot)
    .all()
    .map((row) => `${row.contractVersion}/${row.objective}/${String(row.cancelRequestedAt)}`)
    .sort();
}

function queueRows(): string[] {
  return db
    .select()
    .from(solverQueue)
    .all()
    .map((row) => `${row.contractVersion}/${String(row.generation)}`)
    .sort();
}

/**
 * The same two views with the project id in front.
 *
 * The retirement cases above seed one project and read the table bare, which
 * says everything they are about. A deletion is a claim about which project's
 * rows moved, so its cases need the id in the value they compare.
 */
function slotRowsByProject(): string[] {
  return db
    .select()
    .from(solverSlot)
    .all()
    .map(
      (row) =>
        `${row.projectId}/${row.contractVersion}/${row.objective}/${String(row.cancelRequestedAt)}`,
    )
    .sort();
}

function queueRowsByProject(): string[] {
  return db
    .select()
    .from(solverQueue)
    .all()
    .map((row) => `${row.projectId}/${row.contractVersion}`)
    .sort();
}

/** `projectId/admissionState/cancelEpoch` for every generation row on file. */
function generationRows(): string[] {
  return db
    .select()
    .from(optimizationGeneration)
    .all()
    .map(
      (row) =>
        `${row.projectId}/${row.contractVersion}/${row.admissionState}/${String(row.cancelEpoch)}`,
    )
    .sort();
}

function deletePendingAt(projectId: string): number | null {
  const row = db.select().from(project).where(eq(project.id, projectId)).get();
  return row?.optimizationDeletePendingAt ?? null;
}

function seedCache(contractVersion: string, projectId = 'p-1'): void {
  db.insert(optimizedScheduleCache)
    .values({
      projectId,
      inputHash: 'h1',
      objective: 'pri',
      contractVersion,
      budgetMs: 60000,
      generation: 1,
      status: 'ok',
      resultJson: '{}',
      failureReason: null,
      createdAt: 1,
    })
    .run();
}

function cacheRows(): string[] {
  return db
    .select()
    .from(optimizedScheduleCache)
    .all()
    .map((row) => `${row.projectId}/${row.contractVersion}`)
    .sort();
}

function projectIds(): string[] {
  return db
    .select()
    .from(project)
    .all()
    .map((row) => row.id)
    .sort();
}

describe('beginning a contract retirement', () => {
  it('closes admission and advances the cancel epoch of that release alone', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);

    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    const blue = readGeneration(db, 'p-1', BLUE);
    expect(blue?.admissionState).toBe('draining');
    expect(blue?.cancelEpoch).toBe(1);
    // Retiring blue is not a statement about green, which is the release that
    // is still serving readers through the swap.
    const green = readGeneration(db, 'p-1', GREEN);
    expect(green?.admissionState).toBe('open');
    expect(green?.cancelEpoch).toBe(0);
  });

  it('stamps the retired release’s live slots and leaves the other release’s alone', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    seedSlot(GREEN, 'pri', null);

    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    expect(slotRows()).toEqual([`${BLUE}/pri/20`, `${GREEN}/pri/null`]);
  });

  it('leaves the slot rows counted and undeleted, whatever it asked of them', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    seedSlot(BLUE, 'time', null);

    // Freeing the capacity before the children are proved dead is what let six
    // real processes run while SQLite counted two. Begin asks; it never reaps.
    expect(beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE)).toBe(2);
    expect(slotRows()).toEqual([`${BLUE}/pri/20`, `${BLUE}/time/20`]);
  });

  it('deletes the retired release’s queued work and not the other release’s', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    seedQueue(BLUE, 1);
    seedQueue(GREEN, 1);

    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    // A queue row is unstarted work with no process behind it, so removing it
    // frees nothing early — the asymmetry with the slot rows is the point.
    expect(queueRows()).toEqual([`${GREEN}/1`]);
  });

  it('keeps the instant a cancellation was first requested when it runs again', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    beginOptimizationDrain(db, 'p-1', stampAt(30), BLUE);

    // The reconciler re-runs this every 60 s. Re-stamping would push the
    // request instant forward for ever, and that instant is what a reader uses
    // to judge whether a child is ignoring the request.
    expect(slotRows()).toEqual([`${BLUE}/pri/20`]);
  });

  it('is a no-op on a release that never allocated, rather than creating it', () => {
    expect(beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE)).toBe(0);

    // Draining a release that never allocated must not create the row it is
    // trying to retire.
    expect(readGeneration(db, 'p-1', BLUE)).toBeNull();
  });
});

describe('beginning a project deletion', () => {
  it('writes the durable marker and closes every release of that project', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    allocateGeneration(db, 'p-2', BLUE, 'h1', 10);

    beginOptimizationDrain(db, 'p-1', stampAt(20));

    // Retirement names one release because the other is still serving readers.
    // A deletion has no such other: every release of this project is going.
    expect(deletePendingAt('p-1')).toBe(20);
    expect(generationRows()).toEqual([
      `p-1/${BLUE}/draining/1`,
      `p-1/${GREEN}/draining/1`,
      `p-2/${BLUE}/open/0`,
    ]);
    expect(deletePendingAt('p-2')).toBeNull();
  });

  it('leaves the physical project row in place while its children still run', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    seedSlot(GREEN, 'time', null);

    // The row survives its own deletion's phase 1 for the same reason a slot row
    // survives a retirement: the slots reference it, and their capacity
    // accounting has to stay alive while the children it counts are running.
    // Taking the row here is the immediate cascade that let six real processes
    // run while SQLite counted two.
    expect(beginOptimizationDrain(db, 'p-1', stampAt(20))).toBe(2);
    expect(db.select().from(project).where(eq(project.id, 'p-1')).get()).toBeDefined();
    expect(slotRowsByProject()).toEqual([`p-1/${BLUE}/pri/20`, `p-1/${GREEN}/time/20`]);
  });

  it('stamps and deletes across every release of that project and no other', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    allocateGeneration(db, 'p-2', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    seedSlot(GREEN, 'pri', null);
    seedSlot(BLUE, 'pri', null, 'p-2');
    seedQueue(BLUE, 1);
    seedQueue(GREEN, 1);
    seedQueue(BLUE, 1, 'p-2');

    beginOptimizationDrain(db, 'p-1', stampAt(20));

    expect(slotRowsByProject()).toEqual([
      `p-1/${BLUE}/pri/20`,
      `p-1/${GREEN}/pri/20`,
      `p-2/${BLUE}/pri/null`,
    ]);
    expect(queueRowsByProject()).toEqual([`p-2/${BLUE}`]);
  });

  it('keeps the instant the deletion was first requested when it runs again', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    beginOptimizationDrain(db, 'p-1', stampAt(30));

    // Same rule as the slot stamp, on the marker this time. A reader asking how
    // long this drain has been stuck needs when it started, not when something
    // last asked it to start.
    expect(deletePendingAt('p-1')).toBe(20);
  });

  it('fences a project that has never solved', () => {
    // No generation row, because nothing ever allocated one. The marker is still
    // owed: a project deleted before its first solve must be closed to admission
    // exactly like one deleted mid-solve, or the delete races the first solve.
    expect(beginOptimizationDrain(db, 'p-1', stampAt(20))).toBe(0);

    expect(deletePendingAt('p-1')).toBe(20);
    expect(generationRows()).toEqual([]);
  });

  it('is a no-op on a project that is not there', () => {
    expect(beginOptimizationDrain(db, 'ghost', stampAt(20))).toBe(0);

    // A contract case rather than a mutation-proved one, and it says so: no
    // guard makes this true, the four statements simply match no row. It is here
    // because a future upsert on any of them would break it.
    expect(deletePendingAt('p-1')).toBeNull();
    expect(deletePendingAt('p-2')).toBeNull();
    expect(generationRows()).toEqual([]);
  });
});

describe('finishing a contract retirement', () => {
  it('deletes the drained generation and that release’s cache, and no other’s', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    seedCache(BLUE);
    seedCache(GREEN);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    // 6.9c-d: the phase-1 draining marker authorizes phase-2 eviction. There
    // is no worker attempt token once the release has no counted slots.
    expect(generationRows()).toContain(`p-1/${BLUE}/draining/1`);
    expect(finishOptimizationDrain(db, 'p-1', BLUE)).toBe('finished');

    expect(generationRows()).toEqual([`p-1/${GREEN}/open/0`]);
    // A-1: nothing references the generation row, so retirement has no cascade
    // and takes the retired release's cache rows itself. They can never be read
    // again — the cache key carries the contract version — and 4.1b's retention
    // bound is stated per LIVE contract version, so left alone they accumulate
    // one release at a time for ever.
    expect(cacheRows()).toEqual([`p-1/${GREEN}`]);
    // Watched red: suppress either token-free phase-2 delete and this retired
    // release's generation or cache row remains observable above.
  });

  it('waits while a slot of that release is still counted, and deletes nothing', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE);
    seedSlot(BLUE, 'pri', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    expect(finishOptimizationDrain(db, 'p-1', BLUE)).toBe('waiting');

    expect(generationRows()).toEqual([`p-1/${BLUE}/draining/1`]);
    expect(cacheRows()).toEqual([`p-1/${BLUE}`]);
  });

  it('refuses a release nobody drained, however few slots it has', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE);

    // Zero slots is the ordinary state of an idle release. Deleting on that
    // observation alone would retire a live contract version the moment anybody
    // called finish, which is why the closed state is read too.
    expect(finishOptimizationDrain(db, 'p-1', BLUE)).toBe('open');

    expect(generationRows()).toEqual([`p-1/${BLUE}/open/0`]);
    expect(cacheRows()).toEqual([`p-1/${BLUE}`]);
  });

  it('is a no-op on a release already finished by whoever won the race', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);
    expect(finishOptimizationDrain(db, 'p-1', BLUE)).toBe('finished');

    // The initiator, every slot release and the reconciler all call this. Most
    // calls are expected to find the work already done.
    expect(finishOptimizationDrain(db, 'p-1', BLUE)).toBe('absent');
  });
});

describe('finishing a project deletion', () => {
  it('deletes the project and lets the cascade take everything under it', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    allocateGeneration(db, 'p-2', BLUE, 'h1', 10);
    seedCache(BLUE);
    seedCache(BLUE, 'p-2');
    seedQueue(BLUE, 1, 'p-2');
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    expect(finishOptimizationDrain(db, 'p-1')).toBe('finished');

    // Here the cascade IS the mechanism, because every optimizer table
    // references `project` with `ON DELETE CASCADE`.
    expect(projectIds()).toEqual(['p-2']);
    expect(generationRows()).toEqual([`p-2/${BLUE}/open/0`]);
    expect(cacheRows()).toEqual([`p-2/${BLUE}`]);
    expect(queueRowsByProject()).toEqual([`p-2/${BLUE}`]);
  });

  it('waits while any of the project’s slots is still counted', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    seedSlot(GREEN, 'time', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    // A project's outstanding count spans every release it has, so a green
    // child keeps a deletion waiting even with blue empty.
    expect(finishOptimizationDrain(db, 'p-1')).toBe('waiting');

    expect(projectIds()).toEqual(['p-1', 'p-2']);
    expect(slotRowsByProject()).toEqual([`p-1/${GREEN}/time/20`]);
  });

  it('refuses a project nobody is deleting, which is most projects', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);

    // The single most destructive thing this function could do. `p-1` has no
    // slots — the ordinary state — and no marker, so it is not a drain that
    // finished, it is a project going about its business.
    expect(finishOptimizationDrain(db, 'p-1')).toBe('open');

    expect(projectIds()).toEqual(['p-1', 'p-2']);
    expect(generationRows()).toEqual([`p-1/${BLUE}/open/0`]);
  });

  it('is a no-op on a project that is already gone', () => {
    expect(finishOptimizationDrain(db, 'ghost')).toBe('absent');

    expect(projectIds()).toEqual(['p-1', 'p-2']);
  });
});

/** The release an owner of that seeded slot would make, with its real token. */
function releaseOf(
  contractVersion: string,
  objective: 'pri' | 'time',
  projectId = 'p-1',
  attemptToken = `tok-${projectId}-${contractVersion}-${objective}`,
): Parameters<typeof releaseSolverSlot>[1] {
  return {
    projectId,
    contractVersion,
    generation: 1,
    objective,
    budgetMs: 60000,
    attemptToken,
  };
}

describe('releasing a slot, which is how most drains finish', () => {
  it('gives the row back and finds no drain to finish, which is every ordinary release', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE);
    seedSlot(BLUE, 'pri', null);

    // Neither target is closed, so both re-reads return `open` and write
    // nothing. Two reads is what the ordinary path pays for never needing to
    // know whether it is the last one out.
    expect(releaseSolverSlot(db, releaseOf(BLUE, 'pri'))).toEqual({
      released: true,
      retirement: 'open',
      deletion: 'open',
    });
    expect(slotRowsByProject()).toEqual([]);
    expect(generationRows()).toEqual([`p-1/${BLUE}/open/0`]);
    expect(cacheRows()).toEqual([`p-1/${BLUE}`]);
    expect(projectIds()).toEqual(['p-1', 'p-2']);
  });

  it('retires the release in the same call that removes the last of its slots', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    seedCache(BLUE);
    seedCache(GREEN);
    seedSlot(BLUE, 'pri', null);
    seedSlot(GREEN, 'time', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    // Nobody had to notice this was the last one: the delete and the marker
    // re-read are one transaction, so there is no instant at which the release
    // is drained and unfinished.
    expect(releaseSolverSlot(db, releaseOf(BLUE, 'pri'))).toEqual({
      released: true,
      retirement: 'finished',
      deletion: 'open',
    });
    expect(generationRows()).toEqual([`p-1/${GREEN}/open/0`]);
    expect(cacheRows()).toEqual([`p-1/${GREEN}`]);
    expect(slotRowsByProject()).toEqual([`p-1/${GREEN}/time/null`]);
    expect(projectIds()).toEqual(['p-1', 'p-2']);
  });

  it('waits while another slot of the same release is still counted', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    seedSlot(BLUE, 'time', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    // The second child is still running and its capacity is still its own.
    expect(releaseSolverSlot(db, releaseOf(BLUE, 'pri'))).toEqual({
      released: true,
      retirement: 'waiting',
      deletion: 'open',
    });
    expect(generationRows()).toEqual([`p-1/${BLUE}/draining/1`]);
    expect(slotRowsByProject()).toEqual([`p-1/${BLUE}/time/20`]);
  });

  it('closes both targets when the last slot of a deleted project goes back', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE);
    seedSlot(BLUE, 'pri', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    // A deletion closes every release, so the last slot back retires its own
    // contract version AND takes the project — in that order, because retiring
    // first is what makes the observation the drain exists to make.
    expect(releaseSolverSlot(db, releaseOf(BLUE, 'pri'))).toEqual({
      released: true,
      retirement: 'finished',
      deletion: 'finished',
    });
    expect(projectIds()).toEqual(['p-2']);
    expect(generationRows()).toEqual([]);
    expect(cacheRows()).toEqual([]);
  });

  it('retires its own release and leaves the project waiting on the other one', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    seedSlot(GREEN, 'time', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    // The project's physical row stays while a child it counts is still
    // running, which is the same reason a slot row survives a retirement.
    expect(releaseSolverSlot(db, releaseOf(BLUE, 'pri'))).toEqual({
      released: true,
      retirement: 'finished',
      deletion: 'waiting',
    });
    expect(projectIds()).toEqual(['p-1', 'p-2']);
    expect(generationRows()).toEqual([`p-1/${GREEN}/draining/1`]);
    expect(deletePendingAt('p-1')).toBe(20);
  });

  it('releases nothing on a stale attempt token and leaves the capacity counted', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    // 6.11's fence. A reclaimed owner whose slot was re-admitted would
    // otherwise delete a row belonging to a live child and hand its capacity to
    // somebody else — so a stale token removes nothing and the drain waits.
    expect(releaseSolverSlot(db, releaseOf(BLUE, 'pri', 'p-1', 'tok-reclaimed'))).toEqual({
      released: false,
      retirement: 'waiting',
      deletion: 'open',
    });
    expect(slotRowsByProject()).toEqual([`p-1/${BLUE}/pri/20`]);
    expect(generationRows()).toEqual([`p-1/${BLUE}/draining/1`]);
  });
});

describe('reconciling drains nobody finished', () => {
  it('reclaims a slot past its own stored deadline and retires the release', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null, 'p-1', 500);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    // Nobody called finish: the coordinator that began this died. The pass at
    // 600 is past the deadline stored on the row, so its child is presumed dead.
    expect(reconcileOptimizationDrains(db, 600)).toEqual({
      reclaimed: 1,
      finished: 1,
      waiting: 0,
    });
    expect(generationRows()).toEqual([]);
    expect(slotRowsByProject()).toEqual([]);
  });

  it('leaves a child inside its own deadline alone, whatever this pass thinks the budget is', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null, 'p-1', 900);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    // The deadline is read from the row, not computed from this coordinator's
    // configuration, so a coordinator running the smaller budget cannot reclaim
    // a larger-budget child that is still inside its own deadline.
    expect(reconcileOptimizationDrains(db, 600)).toEqual({
      reclaimed: 0,
      finished: 0,
      waiting: 1,
    });
    expect(generationRows()).toEqual([`p-1/${BLUE}/draining/1`]);
    expect(slotRowsByProject()).toEqual([`p-1/${BLUE}/pri/20`]);
  });

  it('physically deletes a project whose delete crashed between begin and finish', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    seedCache(BLUE);
    seedSlot(BLUE, 'pri', null, 'p-1', 500);
    seedSlot(GREEN, 'time', null, 'p-1', 500);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    // 3.9b's third watched red, at the repository layer: the project was hidden
    // with admission closed and nothing finished it. Admission is exactly what a
    // draining project rejects, so without this pass no read could ever sweep it
    // and the project is wedged and undeletable.
    const pass = reconcileOptimizationDrains(db, 600);

    expect(pass.reclaimed).toBe(2);
    expect(projectIds()).toEqual(['p-2']);
    expect(generationRows()).toEqual([]);
    expect(cacheRows()).toEqual([]);
  });

  it('touches nothing that is neither draining nor delete-pending', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE);
    // Long past its deadline, and still nobody's business: a slot is reclaimed
    // as part of a drain, and this project is not draining.
    seedSlot(BLUE, 'pri', null, 'p-1', 100);

    expect(reconcileOptimizationDrains(db, 600)).toEqual({
      reclaimed: 0,
      finished: 0,
      waiting: 0,
    });
    expect(projectIds()).toEqual(['p-1', 'p-2']);
    expect(generationRows()).toEqual([`p-1/${BLUE}/open/0`]);
    expect(slotRowsByProject()).toEqual([`p-1/${BLUE}/pri/null`]);
  });

  it('reaches the same end state when a second reconciler runs the same pass', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null, 'p-1', 500);
    beginOptimizationDrain(db, 'p-1', stampAt(20));
    const first = reconcileOptimizationDrains(db, 600);

    // The second coordinator finds the work done and says so, rather than
    // erroring: it reads `absent` where the first read `finished`.
    const second = reconcileOptimizationDrains(db, 600);

    expect(first.finished).toBeGreaterThan(0);
    expect(second).toEqual({ reclaimed: 0, finished: 0, waiting: 0 });
    expect(projectIds()).toEqual(['p-2']);
  });
});

describe('the closed-state predicate admission and dequeue share', () => {
  it('lets an ordinary allocated release through, which is every admission', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);

    expect(readOptimizationClosedState(db, 'p-1', BLUE)).toBeNull();
  });

  it('refuses the retired release and lets its sibling through', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-1', GREEN, 'h1', 10);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);

    // A retirement is per contract version, and that is the whole difference
    // between the two targets: green keeps admitting through the swap.
    expect(readOptimizationClosedState(db, 'p-1', BLUE)).toBe('draining');
    expect(readOptimizationClosedState(db, 'p-1', GREEN)).toBeNull();
  });

  it('says deleting rather than draining when the project is going', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    // Both are true — a deletion closes every release — and the marker is the
    // more useful of the two to report, because it is about the project.
    expect(readOptimizationClosedState(db, 'p-1', BLUE)).toBe('deleting');
    expect(readOptimizationClosedState(db, 'p-2', BLUE)).toBe('absent');
  });

  it('refuses a release that finish has already retired', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);
    expect(finishOptimizationDrain(db, 'p-1', BLUE)).toBe('finished');

    // The trap: `finish` DELETES the generation row, so a predicate reading
    // absence as "nothing closed here" would admit work for a contract version
    // one transaction after the drain it was supposed to respect completed.
    expect(readOptimizationClosedState(db, 'p-1', BLUE)).toBe('absent');
  });

  it('refuses a project that is already gone', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    beginOptimizationDrain(db, 'p-1', stampAt(20));
    expect(finishOptimizationDrain(db, 'p-1')).toBe('finished');

    expect(readOptimizationClosedState(db, 'p-1', BLUE)).toBe('absent');
    expect(projectIds()).toEqual(['p-2']);
  });

  it('keeps a bystander project admitting while its neighbour drains', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-2', BLUE, 'h1', 10);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    expect(readOptimizationClosedState(db, 'p-1', BLUE)).toBe('deleting');
    expect(readOptimizationClosedState(db, 'p-2', BLUE)).toBeNull();
  });
});

describe('two coordinators against one file, which is the point of all of it', () => {
  /** Green: a second connection to the same database, with its own everything. */
  let green: Drizzle;

  beforeEach(() => {
    green = openDrizzle(path);
  });

  it('refuses on the second coordinator throughout the whole drain, not just at the end', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null);
    expect(readOptimizationClosedState(green, 'p-1', BLUE)).toBeNull();

    // 3.9b's second watched red, at the repository layer. The interval the red
    // targets is the one BETWEEN the drain opening and the row physically
    // going: after the zero-slot observation and before the final deletion.
    // Green must refuse at every instant in it, and the reason it can is that
    // the closed state is a row in SQLite rather than something blue knows.
    beginOptimizationDrain(db, 'p-1', stampAt(20), BLUE);
    expect(readOptimizationClosedState(green, 'p-1', BLUE)).toBe('draining');

    expect(finishOptimizationDrain(db, 'p-1', BLUE)).toBe('waiting');
    expect(readOptimizationClosedState(green, 'p-1', BLUE)).toBe('draining');

    releaseSolverSlot(db, releaseOf(BLUE, 'pri'));
    expect(readOptimizationClosedState(green, 'p-1', BLUE)).toBe('absent');
  });

  it('sees a project deletion from the other coordinator and still admits its neighbour', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    allocateGeneration(db, 'p-2', BLUE, 'h1', 10);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    expect(readOptimizationClosedState(green, 'p-1', BLUE)).toBe('deleting');
    expect(readOptimizationClosedState(green, 'p-2', BLUE)).toBeNull();
  });

  it('lets the other coordinator’s release finish the drain this one began', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE);
    seedSlot(BLUE, 'pri', null);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    // The child belongs to green, so green is who releases it — and the finish
    // is not the initiator's job precisely so that this works.
    expect(releaseSolverSlot(green, releaseOf(BLUE, 'pri'))).toEqual({
      released: true,
      retirement: 'finished',
      deletion: 'finished',
    });
    expect(projectIds()).toEqual(['p-2']);
  });

  it('lets a different coordinator reconcile a drain the first one died inside', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 'pri', null, 'p-1', 500);
    beginOptimizationDrain(db, 'p-1', stampAt(20));

    // 3.9b's third watched red with the restart made real: the coordinator that
    // began this is gone, and the one sweeping never saw it happen.
    const pass = reconcileOptimizationDrains(green, 600);

    expect(pass.reclaimed).toBe(1);
    expect(projectIds()).toEqual(['p-2']);
    expect(readOptimizationClosedState(db, 'p-1', BLUE)).toBe('absent');
  });
});
