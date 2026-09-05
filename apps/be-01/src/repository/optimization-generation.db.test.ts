import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type Drizzle, openDatabase, openDrizzle } from './db';
import { runMigrations } from './migrate';
import { allocateGeneration, readGeneration } from './optimization-generation';
import { optimizedScheduleCache, solverQueue, solverSlot } from './schema';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** The two releases running against one file during a swap. */
const BLUE = '7+1.0.0';
const GREEN = '8+1.0.0';

let dir: string;
let path: string;
let db: Drizzle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-generation-'));
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
  } finally {
    seed.close();
  }
  db = openDrizzle(path);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedCache(contractVersion: string, generation: number, inputHash: string): void {
  db.insert(optimizedScheduleCache)
    .values({
      projectId: 'p-1',
      inputHash,
      objective: 'pri',
      contractVersion,
      budgetMs: 60000,
      generation,
      status: 'ok',
      resultJson: '{}',
      failureReason: null,
      createdAt: 1,
    })
    .run();
}

function seedQueue(contractVersion: string, generation: number): void {
  db.insert(solverQueue)
    .values({
      projectId: 'p-1',
      contractVersion,
      objective: 'time',
      budgetMs: 60000,
      generation,
      admittedCancelEpoch: 0,
      enqueuedAt: 1,
    })
    .run();
}

function seedSlot(contractVersion: string, generation: number): void {
  db.insert(solverSlot)
    .values({
      projectId: 'p-1',
      contractVersion,
      generation,
      objective: 'pri',
      budgetMs: 60000,
      ownerId: 'own-1',
      attemptToken: 'tok-1',
      lifecycle: 'running',
      pid: 4242,
      startedAt: 1,
      heartbeatAt: 1,
      cancelRequestedAt: null,
      admittedDeadlineAt: 61000,
    })
    .run();
}

/** Every stored cache row as `contractVersion/generation/inputHash`. */
function cacheRows(): string[] {
  return db
    .select()
    .from(optimizedScheduleCache)
    .all()
    .map((row) => `${row.contractVersion}/${String(row.generation)}/${row.inputHash}`)
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

function slotRows(): string[] {
  return db
    .select()
    .from(solverSlot)
    .all()
    .map((row) => `${row.contractVersion}/${String(row.generation)}`)
    .sort();
}

/**
 * The blue/green half of tasks.md 3.9.
 *
 * The whole point of keying the generation on `(projectId, contractVersion)` is
 * that two releases share one database file during a swap. If the counter lived
 * on the `project` row, blue computing one hash and green computing another
 * would alternately increment it and delete each other's rows for ever, on a
 * plan nobody edited — a livelock, not a cache miss.
 *
 * **Watched red:** key the allocation on `projectId` alone — the generation
 * back on `project` in all but name — and the three cases named below fail.
 */
describe('two releases against one file', () => {
  it('allocate independently, each in its own row', () => {
    expect(allocateGeneration(db, 'p-1', BLUE, 'h1', 10)).toBe(1);
    expect(allocateGeneration(db, 'p-1', GREEN, 'h2', 11)).toBe(1);
    expect(allocateGeneration(db, 'p-1', BLUE, 'h3', 12)).toBe(2);

    // Green is untouched by two blue allocations: its own counter, not a
    // shared one it has to skip past.
    expect(readGeneration(db, 'p-1', GREEN)?.generation).toBe(1);
    expect(readGeneration(db, 'p-1', BLUE)?.generation).toBe(2);
  });

  it("do not delete each other's cache rows", () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE, 1, 'h1');
    allocateGeneration(db, 'p-1', GREEN, 'h2', 11);
    seedCache(GREEN, 1, 'h2');

    // Blue moves on. Its own generation-1 row goes; green's does not.
    allocateGeneration(db, 'p-1', BLUE, 'h3', 12);

    expect(cacheRows()).toEqual([`${GREEN}/1/h2`]);
  });

  it("do not delete each other's queue rows", () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedQueue(BLUE, 1);
    allocateGeneration(db, 'p-1', GREEN, 'h2', 11);
    seedQueue(GREEN, 1);

    allocateGeneration(db, 'p-1', BLUE, 'h3', 12);

    expect(queueRows()).toEqual([`${GREEN}/1`]);
  });

  it('are both fenced by one real plan edit, because the hash is not per release', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE, 1, 'h1');
    allocateGeneration(db, 'p-1', GREEN, 'h1', 11);
    seedCache(GREEN, 1, 'h1');

    // One edit, so each release allocates for the new hash — blue/green
    // isolation is about the counter and never about the input.
    allocateGeneration(db, 'p-1', BLUE, 'h2', 12);
    allocateGeneration(db, 'p-1', GREEN, 'h2', 13);

    expect(cacheRows()).toEqual([]);
    expect(readGeneration(db, 'p-1', BLUE)?.inputHash).toBe('h2');
    expect(readGeneration(db, 'p-1', GREEN)?.inputHash).toBe('h2');
  });
});

describe('one allocation', () => {
  it('reuses the current generation when the input hash is unchanged', () => {
    const otherCoordinator = openDrizzle(path);
    expect(allocateGeneration(db, 'p-1', BLUE, 'h1', 10)).toBe(1);
    seedCache(BLUE, 1, 'h1');
    seedQueue(BLUE, 1);

    expect(allocateGeneration(otherCoordinator, 'p-1', BLUE, 'h1', 11)).toBe(1);
    expect(cacheRows()).toEqual([`${BLUE}/1/h1`]);
    expect(queueRows()).toEqual([`${BLUE}/1`]);

    // Proof: unconditionally incrementing the row returns 2 and evicts both
    // current-key artifacts on every restart read.
  });

  it('evicts only the generations below the one it just allocated', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedCache(BLUE, 1, 'h1');
    allocateGeneration(db, 'p-1', BLUE, 'h2', 11);
    seedCache(BLUE, 2, 'h2');

    // The row this allocation's own solve will write carries generation 2 and
    // must survive; a delete written as "not the current one" would race it.
    expect(cacheRows()).toEqual([`${BLUE}/2/h2`]);
  });

  it('leaves slot rows alone, whatever generation they carry', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    seedSlot(BLUE, 1);

    allocateGeneration(db, 'p-1', BLUE, 'h2', 11);

    // Freeing the count before the children are proved dead is what let six
    // real children run while SQLite counted two. The owner releases its own
    // slot; an allocation never does, but it does ask that old owner to stop.
    expect(slotRows()).toEqual([`${BLUE}/1`]);
    expect(db.select({ at: solverSlot.cancelRequestedAt }).from(solverSlot).all()).toEqual([
      { at: 11 },
    ]);
  });

  it('does not reopen a draining generation or move the cancel epoch', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    const write = openDatabase(path);
    try {
      write.run(
        `UPDATE optimization_generation SET admission_state = 'draining', cancel_epoch = 3
           WHERE project_id = 'p-1' AND contract_version = '${BLUE}'`,
      );
    } finally {
      write.close();
    }

    allocateGeneration(db, 'p-1', BLUE, 'h2', 11);

    // A new generation is not a cancellation, and it is not an un-drain.
    const row = readGeneration(db, 'p-1', BLUE);
    expect(row?.generation).toBe(2);
    expect(row?.admissionState).toBe('draining');
    expect(row?.cancelEpoch).toBe(3);
  });

  it('answers null for a release that has never allocated', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    expect(readGeneration(db, 'p-1', GREEN)).toBeNull();
  });

  // `optimization_generation` carries no audit columns and is exempt from
  // `audit.test.ts` for the reason recorded there — it holds machine state with
  // no acting user. That exemption is only honest while the one column it does
  // carry is genuinely maintained, so this is the case that keeps it honest:
  // BOTH branches of the upsert must move `updated_at`, not just the insert.
  // An upsert stamping only its insert branch leaves the column at the instant
  // of the first allocation for ever, which is exactly the fault `audit.test.ts`
  // calls the quiet half — and with the table exempt, nothing else would see it.
  it('moves updated_at on the conflict branch, not only when the row is created', () => {
    allocateGeneration(db, 'p-1', BLUE, 'h1', 10);
    expect(readGeneration(db, 'p-1', BLUE)?.updatedAt).toBe(10);

    allocateGeneration(db, 'p-1', BLUE, 'h2', 11);

    expect(readGeneration(db, 'p-1', BLUE)?.updatedAt).toBe(11);
  });
});
