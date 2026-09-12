import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import { runMigrations } from './migrate';
import {
  toOptimizationGenerationRow,
  toOptimizedScheduleCacheRow,
  toSolverQueueRow,
  toSolverSlotRow,
} from './optimizer-rows';
import {
  optimizationGeneration,
  OPTIMIZED_SCHEDULE_STATUSES,
  optimizedScheduleCache,
  solverQueue,
  solverSlot,
} from './schema';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

/**
 * The negative injections of tasks.md 3.8, run against a real migrated file.
 *
 * A `CHECK` refuses a bad *write*; every case below is about a row that is
 * already stored, which is the only state the read validator exists for. So the
 * corrupt value goes in with `PRAGMA ignore_check_constraints = ON` — the
 * constraint dropped for exactly one statement rather than the schema rewritten
 * — and each test first proves the same statement is REFUSED with enforcement
 * on. Without that half the injection could be landing on a table whose `CHECK`
 * was never declared, and the test would pass while proving nothing about the
 * constraint it names.
 */

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimizer-rows-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedProject(path: string): void {
  const db = openDatabase(path);
  try {
    db.run(
      `INSERT INTO users (id, username, password_hash, created_at) VALUES ('u-1', 'u', 'h', 1)`,
    );
    db.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at)
       VALUES ('p-1', 'Rewire the shed', 'u-1', 0, 0, 1)`,
    );
  } finally {
    db.close();
  }
}

/** Runs one statement under the ordinary rules; answers the refusal, or null. */
function refusal(path: string, statement: string): string | null {
  const db = openDatabase(path);
  try {
    db.run(statement);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    db.close();
  }
}

/**
 * Stores a row the `CHECK`s would refuse.
 *
 * `ignore_check_constraints` is per-connection and this connection is closed
 * immediately, so nothing else in the test ever runs with the constraints off.
 */
function inject(path: string, statement: string): void {
  const db = openDatabase(path);
  try {
    db.run('PRAGMA ignore_check_constraints = ON;');
    db.run(statement);
  } finally {
    db.close();
  }
}

/**
 * The whole shape of one case: the statement, and the two things the read must
 * say about the row it stored.
 */
interface Injection {
  readonly what: string;
  readonly statement: string;
  readonly column: string;
  readonly stored: string;
  readonly read: (path: string) => unknown;
}

function migrated(): { path: string; cleanup: () => void } {
  const db = tempDb();
  runMigrations(db.path, FOLDER);
  seedProject(db.path);
  return db;
}

const GENERATION = `INSERT INTO optimization_generation
  (project_id, contract_version, generation, cancel_epoch, admission_state, updated_at)
  VALUES ('p-1', '7+1.0.0', 1, 0, 'draning', 1)`;

const CACHE_OBJECTIVE = `INSERT INTO optimized_schedule_cache
  (project_id, input_hash, objective, contract_version, budget_ms,
   generation, status, result_json, failure_reason, created_at)
  VALUES ('p-1', 'h1', 'prio', '7+1.0.0', 60000, 1, 'ok', '{}', NULL, 1)`;

const CACHE_STATUS = `INSERT INTO optimized_schedule_cache
  (project_id, input_hash, objective, contract_version, budget_ms,
   generation, status, result_json, failure_reason, created_at)
  VALUES ('p-1', 'h2', 'pri', '7+1.0.0', 60000, 1, 'okay', '{}', NULL, 1)`;

const CACHE_FAILURE_REASON = `INSERT INTO optimized_schedule_cache
  (project_id, input_hash, objective, contract_version, budget_ms,
   generation, status, result_json, failure_reason, created_at)
  VALUES ('p-1', 'h3', 'pri', '7+1.0.0', 60000, 1, 'failed', NULL, 'exploded', 1)`;

const SLOT_OBJECTIVE = `INSERT INTO solver_slot
  (project_id, contract_version, generation, objective, budget_ms, owner_id,
   attempt_token, lifecycle, pid, started_at, heartbeat_at,
   cancel_requested_at, admitted_deadline_at)
  VALUES ('p-1', '7+1.0.0', 1, 'prio', 60000, 'own-1', 'tok-1', 'running', 4242, 1, 1, NULL, 61000)`;

const SLOT_LIFECYCLE = `INSERT INTO solver_slot
  (project_id, contract_version, generation, objective, budget_ms, owner_id,
   attempt_token, lifecycle, pid, started_at, heartbeat_at,
   cancel_requested_at, admitted_deadline_at)
  VALUES ('p-1', '7+1.0.0', 1, 'pri', 60000, 'own-1', 'tok-1', 'startingg', NULL, 1, 1, NULL, 61000)`;

const QUEUE_OBJECTIVE = `INSERT INTO solver_queue
  (project_id, contract_version, objective, budget_ms, generation,
   admitted_cancel_epoch, enqueued_at)
  VALUES ('p-1', '7+1.0.0', 'prio', 60000, 1, 0, 1)`;

/** Reads every row of one table back through its own production validator. */
function readCache(path: string): unknown {
  const db = openDrizzle(path);
  return db.select().from(optimizedScheduleCache).all().map(toOptimizedScheduleCacheRow);
}

function readGeneration(path: string): unknown {
  const db = openDrizzle(path);
  return db.select().from(optimizationGeneration).all().map(toOptimizationGenerationRow);
}

function readSlot(path: string): unknown {
  const db = openDrizzle(path);
  return db.select().from(solverSlot).all().map(toSolverSlotRow);
}

function readQueue(path: string): unknown {
  const db = openDrizzle(path);
  return db.select().from(solverQueue).all().map(toSolverQueueRow);
}

/**
 * The five scalar enums of the four optimizer tables, one case each.
 *
 * `solver_slot.objective` and `solver_queue.objective` are listed separately
 * from the cache's on purpose: a stored enum is a column and not a type, and
 * the reason 3.8 exists is that validating one `objective` column was taken to
 * have covered its two siblings.
 */
const INJECTIONS: readonly Injection[] = [
  {
    what: 'optimized_schedule_cache.objective',
    statement: CACHE_OBJECTIVE,
    column: 'optimized_schedule_cache.objective',
    stored: 'prio',
    read: readCache,
  },
  {
    what: 'optimized_schedule_cache.status',
    statement: CACHE_STATUS,
    column: 'optimized_schedule_cache.status',
    stored: 'okay',
    read: readCache,
  },
  {
    what: 'optimized_schedule_cache.failure_reason',
    statement: CACHE_FAILURE_REASON,
    column: 'optimized_schedule_cache.failure_reason',
    stored: 'exploded',
    read: readCache,
  },
  {
    what: 'optimization_generation.admission_state',
    statement: GENERATION,
    column: 'optimization_generation.admission_state',
    stored: 'draning',
    read: readGeneration,
  },
  {
    what: 'solver_slot.lifecycle',
    statement: SLOT_LIFECYCLE,
    column: 'solver_slot.lifecycle',
    stored: 'startingg',
    read: readSlot,
  },
  {
    what: 'solver_slot.objective',
    statement: SLOT_OBJECTIVE,
    column: 'solver_slot.objective',
    stored: 'prio',
    read: readSlot,
  },
  {
    what: 'solver_queue.objective',
    statement: QUEUE_OBJECTIVE,
    column: 'solver_queue.objective',
    stored: 'prio',
    read: readQueue,
  },
];

describe('a stored optimizer enum', () => {
  for (const injection of INJECTIONS) {
    it(`is refused on write by the CHECK on ${injection.what}`, () => {
      const db = migrated();
      try {
        expect(refusal(db.path, injection.statement)).toContain('CHECK constraint failed');
      } finally {
        db.cleanup();
      }
    });

    it(`throws on read naming ${injection.what} and the stored value`, () => {
      const db = migrated();
      try {
        inject(db.path, injection.statement);

        // Naming the stored value is what proves the injection landed: an
        // empty read throws nothing, and a read of some other row cannot
        // produce this message.
        expect(() => injection.read(db.path)).toThrow(
          // The column name is escaped: an unescaped `.` matches any character,
          // so the assertion would pass on a message naming another column.
          new RegExp(`${injection.column.replaceAll('.', '\\.')}.*${injection.stored}`),
        );
      } finally {
        db.cleanup();
      }
    });
  }

  /**
   * The other half of the case above: the validator must not throw on a row
   * that is merely unusual. Remove the guards and this stays green while every
   * test above goes red, which is what makes those reds mean "the validator
   * ran" rather than "the read blew up".
   */
  it('reads every well-formed row back unchanged', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path);

      const write = openDatabase(db.path);
      try {
        write.run(`INSERT INTO optimization_generation
          (project_id, contract_version, generation, cancel_epoch, admission_state, updated_at)
          VALUES ('p-1', '7+1.0.0', 1, 0, 'draining', 1)`);
        write.run(`INSERT INTO optimized_schedule_cache
          (project_id, input_hash, objective, contract_version, budget_ms,
           generation, status, result_json, failure_reason, created_at)
          VALUES ('p-1', 'h1', 'time', '7+1.0.0', 60000, 1, 'failed', NULL, 'oom', 1)`);
        write.run(`INSERT INTO solver_slot
          (project_id, contract_version, generation, objective, budget_ms, owner_id,
           attempt_token, lifecycle, pid, started_at, heartbeat_at,
           cancel_requested_at, admitted_deadline_at)
          VALUES ('p-1', '7+1.0.0', 1, 'time', 60000, 'own-1', 'tok-1', 'starting', NULL, 1, 1, NULL, 61000)`);
        write.run(`INSERT INTO solver_queue
          (project_id, contract_version, objective, budget_ms, generation,
           admitted_cancel_epoch, enqueued_at)
          VALUES ('p-1', '7+1.0.0', 'time', 60000, 1, 0, 1)`);
      } finally {
        write.close();
      }

      expect(readGeneration(db.path)).toMatchObject([{ admissionState: 'draining' }]);
      expect(readCache(db.path)).toMatchObject([
        { objective: 'time', status: 'failed', failureReason: 'oom' },
      ]);
      expect(readSlot(db.path)).toMatchObject([{ lifecycle: 'starting', objective: 'time' }]);
      expect(readQueue(db.path)).toMatchObject([{ objective: 'time' }]);
    } finally {
      db.cleanup();
    }
  });

  /**
   * `failure_reason` is the one nullable enum here, and its NULL is a fact
   * about the row rather than a missing value: an `ok` row has no failure. A
   * validator that treated NULL as an unknown value would refuse every
   * successful cache row on read.
   */
  it('accepts the null failure reason of a row that did not fail', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path);

      const write = openDatabase(db.path);
      try {
        write.run(`INSERT INTO optimized_schedule_cache
          (project_id, input_hash, objective, contract_version, budget_ms,
           generation, status, result_json, failure_reason, created_at)
          VALUES ('p-1', 'h1', 'pri', '7+1.0.0', 60000, 1, 'ok', '{}', NULL, 1)`);
      } finally {
        write.close();
      }

      expect(readCache(db.path)).toMatchObject([{ status: 'ok', failureReason: null }]);
    } finally {
      db.cleanup();
    }
  });
});

/**
 * The status vocabulary against the artifact that declares it.
 *
 * `plan-infeasible` reached `OPTIMIZED_SCHEDULE_STATUSES` and both CHECKs on
 * the shipped table, and `tasks.md` 3.1 was amended with it, while
 * `design.md`'s own Cache identity bullet still read `status` (`'ok' |
 * 'failed'`) and `CHECK (status IN ('ok','failed'))`. Nothing failed, because
 * no assertion anywhere read that bullet — the identical check for
 * `failure_reason` exists one directory away in
 * `solver-failure-disposition.test.ts` and is why that vocabulary never
 * drifted.
 *
 * Non-circular for the same reason that one is: the expectation is parsed out
 * of the design text and compared with the constant the table is built from,
 * so the two can only agree by actually agreeing.
 */
describe('the cache status vocabulary is the one design.md declares', () => {
  const DESIGN = readFileSync(
    new URL('../../../openspec/changes/dual-optimized-scheduler/design.md', import.meta.url),
    'utf8',
  );

  it('matches the status CHECK constraint exactly, in order', () => {
    const match = /CHECK \(status IN \(([^)]*)\)\)/.exec(DESIGN);
    if (!match) throw new Error('design.md no longer declares a cache status CHECK constraint');
    const declared = match[1].split(',').map((token) => token.trim().replace(/^'|'$/g, ''));
    expect(OPTIMIZED_SCHEDULE_STATUSES.map(String)).toEqual(declared);
  });

  /**
   * The payload half, and the reason 3.1 insists the two CHECKs move together:
   * a status admitted by the first CHECK and absent from the second is a value
   * the table declares legal and then refuses on every insert.
   *
   * MEASURED (control E, first attempt): asserting that the Cache identity
   * bullet merely *mentions* each status gave **18 pass / 0 fail** with the
   * `plan-infeasible` disjunct deleted, because the surrounding prose names the
   * status too. An assertion that cannot fail for the reason it claims is worse
   * than no assertion, so the design text now writes the CHECK out per status
   * as SQL — the same form `tasks.md` 3.1 uses — and this reads the disjuncts.
   */
  it('gives every admitted status its own payload disjunct', () => {
    const payload = /CHECK \(\(status='[\s\S]*?\)\)/.exec(DESIGN);
    if (!payload) throw new Error('design.md no longer declares a cache payload CHECK constraint');
    const disjuncts = [...payload[0].matchAll(/status='([^']*)'/g)].map((m) => m[1]);
    expect(disjuncts).toEqual(OPTIMIZED_SCHEDULE_STATUSES.map(String));
  });
});
