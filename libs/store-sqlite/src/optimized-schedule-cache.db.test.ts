import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodeOptimizedResult,
  encodeOptimizedResult,
  type OptimizedResult,
} from '@wbs/contracts/solver/optimized-result';
import {
  decodeSchedule,
  encodeSchedule,
  type PlannedRow,
  type Schedule,
  schedule,
  type Slice,
  sliceKey,
} from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import { runMigrations } from './migrate';
import { readMigrationFolders, rollbackTo } from './migrate-down';
import { allocateGeneration } from './optimization-generation';
import { storeOptimizedOutcome } from './optimized-schedule-cache';
import { toOptimizedScheduleCacheRow } from './optimizer-rows';
import { optimizedScheduleCache } from './schema';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

/** The migration under test; `PROJECT_SETTINGS` below it is now the newest. */
const OPTIMIZER_TABLES = '20260904100000_add_optimizer_tables';

/**
 * The migration that lands immediately after this one: slice 3b.1's three
 * project settings columns. Named here only so the ordering and rollback claims
 * below stay about *this* migration's position rather than about whichever
 * folder happens to be last.
 */
const CALENDAR_MARKER = '20260905090000_add_calendar_marker';
const PROJECT_SETTINGS = '20260904140000_add_project_settings';
/**
 * The newest: the `(project_id, id)` index that serves
 * `listByProject`'s stated `ORDER BY` (ADR 0016). Additive and
 * index-only, so it heads every descending reversal list here and tails
 * every ascending one, exactly as {@link PROJECT_SETTINGS} did while it
 * was newest.
 */
const READ_ORDER_INDEX = '20260906003000_add_work_item_read_order_index';
/**
 * The newest: `work_item.deadline`, the nullable date-only column slice 1 adds.
 * Additive forward and `DROP COLUMN` on the way back, so it heads every
 * descending reversal list here and tails every ascending one, exactly as
 * {@link READ_ORDER_INDEX} did while it was newest.
 */
const WORK_ITEM_DEADLINE = '20260906090000_add_work_item_deadline';
/**
 * The newest: `work_item_external_ref.name`, the `NOT NULL DEFAULT ''` column
 * `link-names-and-card` adds. Additive forward and `DROP COLUMN` on the way
 * back, so it heads every descending reversal list here, exactly as
 * {@link WORK_ITEM_DEADLINE} did while it was newest.
 */
const EXTERNAL_REF_NAME = '20260909120000_add_external_ref_name';

/** The one below it, which is where every rollback here stops. */
const LOOKUP_INDEXES = '20260902120000_add_lookup_indexes';
// The two saved-plan migrations main added between LOOKUP_INDEXES and this
// slice's own. A rollback to LOOKUP_INDEXES reverses them too, so they are
// named here rather than filtered out — the list is the literal answer
// `rollbackTo` gave.
const CREATED_BY_ID = '20260904020000_add_saved_plan_created_by_id';
const SAVED_PLAN = '20260903190000_add_saved_plan';

/**
 * What `20260904100000_add_optimizer_tables` adds, enumerated rather than
 * counted (tasks.md 3.7, Fable r14 Important 1).
 *
 * "Three companion tables" beside the cache is the phrase a `down.sql` gets
 * built from, and an implementer working from a three-item list ships a
 * rollback that strands one table — the aborted blue/green deploy this proof
 * exists to prevent. So the count is four, and the list is written out.
 */
const ADDED_TABLES = [
  'optimization_generation',
  'optimized_schedule_cache',
  'solver_queue',
  'solver_slot',
] as const;

/**
 * Not this migration's, and gone all the same.
 *
 * The rollback below targets `LOOKUP_INDEXES`, and main's two saved-plan
 * migrations were applied after it, so `rollbackTo` reverses them on the way
 * down. "Every pre-existing table intact" is a claim about tables that existed
 * BEFORE the target — these did not — so they are subtracted by name here
 * rather than by widening the predicate until it passes.
 */
// Every table a rollback to LOOKUP_INDEXES takes that this migration did not
// add: the two the saved-plan migrations above the target add, and
// `calendar_marker`, which landed above all of them on 2026-09-05.
const ALSO_ROLLED_BACK = ['saved_plan', 'saved_plan_body', 'calendar_marker'] as const;

const ADDED_INDEX = 'solver_queue_dequeue_order';
const ADDED_PROJECT_COLUMN = 'optimization_delete_pending_at';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimizer-cache-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function tables(path: string): string[] {
  const db = openDatabase(path);
  try {
    return db
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    db.close();
  }
}

function indexes(path: string): string[] {
  const db = openDatabase(path);
  try {
    return db
      .query(`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    db.close();
  }
}

function projectColumns(path: string): string[] {
  const db = openDatabase(path);
  try {
    return db
      .query('PRAGMA table_info(project)')
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    db.close();
  }
}

/** Runs one statement and answers the error message, or null when it succeeded. */
function refusal(path: string, sql: string): string | null {
  const db = openDatabase(path);
  try {
    db.run(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    db.close();
  }
}

function seedProject(path: string, id: string): void {
  const db = openDatabase(path);
  try {
    db.run(
      `INSERT INTO users (id, username, password_hash, created_at) VALUES ('u-1', 'u', 'h', 1)`,
    );
    db.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at)
       VALUES ('${id}', 'Rewire the shed', 'u-1', 0, 0, 1)`,
    );
  } finally {
    db.close();
  }
}

/**
 * The seat a writer must hold, plus the project switch, per contract version.
 *
 * `storeOptimizedOutcome` re-reads all four of its fences inside the write
 * transaction, and `optimization_enabled` defaults to `false`, so a fixture
 * that skipped this would get `superseded` back and prove nothing about
 * retention.
 */
function reserveSlot(path: string, contractVersion: string, budgetMs: number): void {
  const db = openDatabase(path);
  try {
    db.run(
      `INSERT INTO solver_slot
         (project_id, contract_version, generation, objective, budget_ms,
          owner_id, attempt_token, lifecycle, pid, started_at, heartbeat_at,
          cancel_requested_at, admitted_deadline_at)
       VALUES ('p-1', '${contractVersion}', 1, 'pri', ${String(budgetMs)},
               'coordinator-a', 'tok-${contractVersion}-${String(budgetMs)}', 'running',
               4242, 1, 1, NULL, 99)`,
    );
    db.run(`UPDATE project SET optimization_enabled = 1 WHERE id = 'p-1'`);
  } finally {
    db.close();
  }
}

function cacheRow(status: string, resultJson: string, failureReason: string): string {
  return `INSERT INTO optimized_schedule_cache
    (project_id, input_hash, objective, contract_version, budget_ms,
     generation, status, result_json, failure_reason, created_at)
    VALUES ('p-1', 'h1', 'pri', '7+1.0.0', 60000, 1, '${status}', ${resultJson}, ${failureReason}, 1)`;
}

describe('the optimizer migration', () => {
  it('creates the four tables, the dequeue index and the project fence', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);

      for (const table of ADDED_TABLES) expect(tables(db.path)).toContain(table);
      expect(indexes(db.path)).toContain(ADDED_INDEX);
      expect(projectColumns(db.path)).toContain(ADDED_PROJECT_COLUMN);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The position claim, rewritten when 3b.1's project-settings migration landed
   * after this one: this migration is no longer last in the folder, so "newest"
   * is the wrong assertion and would have to be rewritten again by the next
   * slice. What actually matters to this file is the **adjacency** — that
   * nothing was inserted between the optimizer tables and the settings columns,
   * because a folder ordered any other way would apply the four tables after
   * the columns that steer them.
   */
  it('is applied immediately before the project-settings migration', () => {
    const names = readMigrationFolders(FOLDER).map((folder) => folder.name);

    // The adjacency itself, not `at(-1)`/`at(-2)`. Those were true while
    // project-settings was the newest folder, and they made every later
    // migration a failure of this file — which is not what it is about.
    // Two folders have landed above it since: `calendar_marker` on 2026-09-05
    // and the read-order index on 2026-09-06.
    const settings = names.indexOf(PROJECT_SETTINGS);
    expect(settings).toBeGreaterThan(0);
    expect(names[settings - 1]).toBe(OPTIMIZER_TABLES);
  });

  it('is idempotent on an already-migrated file', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const before = [...tables(db.path), ...indexes(db.path)];

      // The second run applies nothing: every folder is already stamped, and
      // `CREATE TABLE` without `IF NOT EXISTS` would throw if it ran again.
      runMigrations(db.path, FOLDER);

      expect([...tables(db.path), ...indexes(db.path)]).toEqual(before);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The 3.7 proof, and the reason it enumerates: a `down.sql` written from
   * "three companion tables" leaves one behind, and a table that survived a
   * rollback is a `CREATE TABLE` that throws on the re-apply — the aborted
   * blue/green deploy, reproduced.
   */
  it('rolls back everything it added and leaves every pre-existing table intact', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const migrated = tables(db.path);

      // Newest first, so the settings columns come off before the tables they
      // steer — this migration is no longer the only thing above LOOKUP_INDEXES.
      expect(rollbackTo(db.path, FOLDER, LOOKUP_INDEXES)).toEqual([
        EXTERNAL_REF_NAME,
        WORK_ITEM_DEADLINE,
        READ_ORDER_INDEX,
        CALENDAR_MARKER,
        PROJECT_SETTINGS,
        OPTIMIZER_TABLES,
        CREATED_BY_ID,
        SAVED_PLAN,
      ]);

      const rolledBack = tables(db.path);
      for (const table of ADDED_TABLES) expect(rolledBack).not.toContain(table);
      expect(indexes(db.path)).not.toContain(ADDED_INDEX);
      expect(projectColumns(db.path)).not.toContain(ADDED_PROJECT_COLUMN);

      // Everything else is untouched: the rollback took exactly the four tables
      // this migration adds, plus the three the migrations above the target
      // add, and nothing that was there before any of them.
      expect(rolledBack).toEqual(
        migrated.filter(
          (name) =>
            !ADDED_TABLES.includes(name as never) && !ALSO_ROLLED_BACK.includes(name as never),
        ),
      );
    } finally {
      db.cleanup();
    }
  });

  it('re-applies onto the rolled-back file and lands the same schema', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const first = [...tables(db.path), ...indexes(db.path), ...projectColumns(db.path)];

      rollbackTo(db.path, FOLDER, LOOKUP_INDEXES);
      runMigrations(db.path, FOLDER);

      expect([...tables(db.path), ...indexes(db.path), ...projectColumns(db.path)]).toEqual(first);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The blue/green half: the outgoing release reads and writes `project`
   * knowing nothing about the new column, and the migration must not make its
   * statements invalid. A column-less `INSERT` is exactly what that release
   * runs, and it fails against a `NOT NULL` addition without a default —
   * which is why the fence is nullable.
   */
  it('leaves the outgoing release’s project writes running', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');

      const read = openDatabase(db.path);
      try {
        expect(read.query(`SELECT id FROM project WHERE id = 'p-1'`).all()).toHaveLength(1);
      } finally {
        read.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('what the cache table refuses', () => {
  /**
   * SQLite text columns otherwise hold any combination a past bug wrote, so
   * each of these is the database refusing rather than the code remembering to
   * check (tasks.md 3.5).
   *
   * Proof: with `CONSTRAINT optimized_schedule_cache_payload` removed from
   * `20260904100000_add_optimizer_tables/migration.sql`, the first two cases
   * below accept their row and the `toContain('CHECK')` assertion fails
   * (2026-09-04).
   */
  it('refuses an ok row with no result and a failed row with one', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');

      expect(refusal(db.path, cacheRow('ok', 'NULL', 'NULL'))).toContain('CHECK');
      expect(refusal(db.path, cacheRow('failed', `'{}'`, `'timeout'`))).toContain('CHECK');
      expect(refusal(db.path, cacheRow('failed', 'NULL', 'NULL'))).toContain('CHECK');
      expect(refusal(db.path, cacheRow('plan-infeasible', 'NULL', 'NULL'))).toContain('CHECK');
    } finally {
      db.cleanup();
    }
  });

  it('accepts the three well-formed shapes', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');

      expect(refusal(db.path, cacheRow('ok', `'{"dtoVersion":1}'`, 'NULL'))).toBeNull();
      expect(
        refusal(db.path, cacheRow('failed', 'NULL', `'timeout'`).replace(`'h1'`, `'h2'`)),
      ).toBeNull();
      expect(
        refusal(
          db.path,
          cacheRow('plan-infeasible', `'{"dtoVersion":1,"items":[]}'`, 'NULL').replace(
            `'h1'`,
            `'h3'`,
          ),
        ),
      ).toBeNull();
    } finally {
      db.cleanup();
    }
  });

  it('refuses an unknown objective, status and failure reason', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');

      expect(refusal(db.path, cacheRow('ok', `'{}'`, 'NULL').replace(`'pri'`, `'prio'`))).toContain(
        'CHECK',
      );
      expect(refusal(db.path, cacheRow('done', `'{}'`, 'NULL'))).toContain('CHECK');
      expect(refusal(db.path, cacheRow('failed', 'NULL', `'exploded'`))).toContain('CHECK');
    } finally {
      db.cleanup();
    }
  });

  it('takes its rows with the project, by the cascade and nothing else', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');
      expect(refusal(db.path, cacheRow('ok', `'{"dtoVersion":1}'`, 'NULL'))).toBeNull();

      const db2 = openDatabase(db.path);
      try {
        db2.run(`DELETE FROM project WHERE id = 'p-1'`);
        expect(db2.query(`SELECT project_id FROM optimized_schedule_cache`).all()).toHaveLength(0);
      } finally {
        db2.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('a plan through the column it is stored in', () => {
  /**
   * tasks.md 4.12's watched red, the half `libs/domain`'s own cases cannot
   * reach: a **non-empty** plan out of the real engine, into
   * `optimized_schedule_cache.result_json`, and back through the repository's
   * read boundary.
   *
   * `schedule-cache-dto.test.ts` proves the codec against
   * `JSON.parse(JSON.stringify(...))`, which is the encoding. This proves the
   * **column**: SQLite's TEXT affinity, the row's `CHECK`s, and
   * {@link toOptimizedScheduleCacheRow} standing between the stored row and the
   * decode. The two are not the same claim — a payload that survives a string
   * round trip can still be refused by a constraint, truncated by a column, or
   * lost by a mapper that drops the field it does not name.
   */
  const DEV = 'step-dev';
  const PLATFORM = 'team-platform';

  /** Three two-day blocks in a pool of one, so the plan has real waits in it. */
  function realPlan(): Schedule {
    const rows: PlannedRow[] = ['a', 'b', 'c'].map((id, at) => ({
      id,
      parentId: null,
      position: (at + 1) * 10,
      frozenNumber: null,
      priority: null,
    }));
    const slices: Slice[] = ['a', 'b', 'c'].map((workItemId) => ({
      workItemId,
      stepId: DEV,
      days: 2,
      personId: null,
      width: 1,
      poolIds: [PLATFORM],
    }));
    return schedule(rows, [], slices, new Map(), new Map([[PLATFORM, 1]]));
  }

  function storeAndRead(path: string, resultJson: string): Schedule {
    const db = openDrizzle(path);
    db.insert(optimizedScheduleCache)
      .values({
        projectId: 'p-1',
        inputHash: 'h1',
        objective: 'pri',
        contractVersion: '7+1.0.0',
        budgetMs: 60000,
        generation: 1,
        status: 'ok',
        resultJson,
        failureReason: null,
        createdAt: 1,
      })
      .run();
    const stored = db.select().from(optimizedScheduleCache).get();
    if (stored === undefined) throw new Error('broken fixture: nothing stored');
    // Through the 3.8 boundary, not off the raw select: that is where every
    // repository read of this table goes, and a mapper that dropped
    // `resultJson` would otherwise never be noticed by this case.
    const row = toOptimizedScheduleCacheRow(stored);
    if (row.resultJson === null) throw new Error('broken fixture: no payload stored');
    return decodeSchedule(JSON.parse(row.resultJson));
  }

  it('reloads a real plan out of result_json with both maps intact', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');
      const plan = realPlan();

      // Load-bearing: over an empty plan every assertion below is vacuous.
      expect(plan.slices.size).toBe(3);
      expect(plan.waitingForCapacity).toBeGreaterThan(0);
      expect(plan.eventsVisited).toBeGreaterThan(0);

      const reloaded = storeAndRead(db.path, JSON.stringify(encodeSchedule(plan)));

      expect(reloaded).toEqual(plan);
      expect(reloaded.slices.get(sliceKey('a', DEV))).toEqual(plan.slices.get(sliceKey('a', DEV)));
      expect([...reloaded.slices.values()].some((one) => one.boundBy === 'capacity')).toBe(true);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The 4.12b envelope through the same column, and the reason it is a separate
   * claim from the plan above: the row stores an `OptimizedResult`, so
   * `objectiveValues` and `publication` have to survive the trip too, and they
   * are the two things `Schedule` never carried and the old `scheduleJson`
   * write silently discarded (Sol r7 Critical 6).
   *
   * It also proves the seam is REACHABLE from here. Until this run
   * `libs/contracts/solver` had no path alias at all, so the decoder 4.1's read
   * half has to call could not be named from `apps/be-01` by anything but a
   * relative climb out of the app's own root.
   */
  function storeAndReadResult(path: string, resultJson: string): OptimizedResult {
    const db = openDrizzle(path);
    db.insert(optimizedScheduleCache)
      .values({
        projectId: 'p-1',
        inputHash: 'h1',
        objective: 'pri',
        contractVersion: '7+1.0.0',
        budgetMs: 60000,
        generation: 1,
        status: 'ok',
        resultJson,
        failureReason: null,
        createdAt: 1,
      })
      .run();
    const stored = db.select().from(optimizedScheduleCache).get();
    if (stored === undefined) throw new Error('broken fixture: nothing stored');
    const row = toOptimizedScheduleCacheRow(stored);
    if (row.resultJson === null) throw new Error('broken fixture: no payload stored');
    return decodeOptimizedResult(JSON.parse(row.resultJson));
  }

  const solverResult = (plan: Schedule): OptimizedResult => ({
    publication: 'solver',
    objectiveValues: {
      makespan: { value: 288, stageValue: 288, bound: 288, status: 'optimal' },
      priority: { value: 41, stageValue: 41, bound: 40, status: 'feasible' },
      movement: { value: 7, stageValue: null, bound: null, status: 'unknown' },
    },
    schedule: plan,
  });

  it('reloads an OptimizedResult out of result_json, objectiveValues included', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');
      const plan = realPlan();
      const source = solverResult(plan);

      const reloaded = storeAndReadResult(db.path, JSON.stringify(encodeOptimizedResult(source)));

      expect(reloaded.publication).toBe('solver');
      expect(reloaded.objectiveValues).toEqual(source.objectiveValues);
      expect(reloaded.schedule).toEqual(plan);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The fractional half of 4.12b's second watched red, as far as this layer can
   * carry it: the value is asserted **bit-equal to the sum**, not to the
   * literal `0.6`, because `0.2 + 0.2 + 0.2 !== 0.6` in IEEE-754 and a column
   * that round-tripped through a decimal string would pass a `0.6` assertion
   * while having changed the number. The scorer half waits for the real plan
   * read.
   */
  it("keeps a quantisation-floor row's real-domain value bit-equal through the column", () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');
      const fractional = 0.2 + 0.2 + 0.2;
      const floor: OptimizedResult = {
        publication: 'quantisation-floor',
        objectiveValues: {
          makespan: { value: fractional, stageValue: null, bound: null, status: 'unknown' },
          priority: { value: 0, stageValue: null, bound: null, status: 'unknown' },
          movement: { value: 1.5, stageValue: null, bound: null, status: 'unknown' },
        },
        schedule: realPlan(),
      };

      const reloaded = storeAndReadResult(db.path, JSON.stringify(encodeOptimizedResult(floor)));

      expect(reloaded.publication).toBe('quantisation-floor');
      expect(reloaded.objectiveValues.makespan.value).toBe(fractional);
      expect(Number.isSafeInteger(reloaded.objectiveValues.makespan.value)).toBe(false);
      expect(reloaded.objectiveValues.makespan.stageValue).toBeNull();
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.12b, Sol r10 Important 11: neither JSON-held enum may be caught by a
   * database constraint. Both payloads below are syntactically valid JSON and
   * both are stored without complaint; the decode is what refuses them, which
   * is what keeps a corrupt row `corrupt` and retryable rather than a failed
   * write of a solve that already happened.
   */
  it('stores an invalid publication and an invalid stage status, and throws on the read', () => {
    for (const [defect, corrupt] of [
      ['publication', (row: Record<string, unknown>) => (row['publication'] = 'fast')],
      [
        'movement.status',
        (row: Record<string, unknown>) => {
          const terms = row['objectiveValues'] as Record<string, Record<string, unknown>>;
          terms['movement']['status'] = 'proved';
        },
      ],
    ] as [string, (row: Record<string, unknown>) => void][]) {
      const db = tempDb();
      try {
        runMigrations(db.path, FOLDER);
        seedProject(db.path, 'p-1');
        const payload = JSON.parse(
          JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        ) as Record<string, unknown>;
        corrupt(payload);
        const text = JSON.stringify(payload);

        expect(() => storeAndReadResult(db.path, text)).toThrow(new RegExp(defect.split('.')[0]));
        const row = openDatabase(db.path)
          .query(`SELECT length(result_json) AS n FROM optimized_schedule_cache`)
          .get() as { n: number } | null;
        expect(row?.n).toBe(text.length);
      } finally {
        db.cleanup();
      }
    }
  });

  /**
   * Said directly rather than inferred from the case above — and stated as
   * precisely as the DDL allows, because the naive form of this assertion is
   * FALSE here and went red on its first run.
   *
   * `optimized_schedule_cache_payload` does name `result_json` inside a
   * `CHECK`: it makes `status` the discriminant of whether the column is NULL.
   * That is a nullity rule and 4.12b does not object to it. What 4.12b forbids
   * is a constraint over the column's CONTENTS, which would turn a corrupt
   * payload into a failed write instead of a `corrupt` read. So the claim
   * asserted is the one that is true and load-bearing: every mention of the
   * column inside a `CHECK` is a NULL test and nothing else.
   */
  it("constrains only result_json's nullity, never its contents", () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const ddl = openDatabase(db.path)
        .query(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'optimized_schedule_cache'`,
        )
        .get() as { sql: string } | null;
      const text = ddl?.sql ?? '';
      expect(text).toContain('result_json');

      const checks = text.split(/\bCHECK\b/i).slice(1);
      expect(checks.length).toBeGreaterThan(0);
      const mentions = checks
        .join(' ')
        .split(/`?result_json`?/)
        .slice(1);
      expect(mentions.length).toBeGreaterThan(0);
      for (const after of mentions) {
        expect(after.trimStart()).toMatch(/^IS (NOT )?NULL\b/i);
      }
    } finally {
      db.cleanup();
    }
  });

  it('stores a truncated payload without complaint, so the decode is the only guard', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');
      const whole = JSON.stringify(encodeSchedule(realPlan()));

      // No `CHECK` covers `result_json`'s contents (4.8), which is deliberate:
      // corruption must surface as `corrupt` on the read and be retryable,
      // rather than failing the write of a solve that already happened.
      expect(() => storeAndRead(db.path, whole.slice(0, whole.length - 20))).toThrow();
      const row = openDatabase(db.path)
        .query(`SELECT length(result_json) AS n FROM optimized_schedule_cache`)
        .get() as { n: number } | null;
      expect(row?.n).toBe(whole.length - 20);
    } finally {
      db.cleanup();
    }
  });
});

/**
 * `work-item-deadline` tasks.md 7.4 and 7.5, the cache half of the deadline
 * change — and both are claims that something did **not** move.
 *
 * A deadline is a plan fact. It reaches this table only through `input_hash`,
 * which the canonical input already carries it into as its seventh entry
 * (`canonical-schedule-input.ts`, slice 7.1). Nothing about it is a deployment
 * fact, so nothing about it belongs in the key beside `contract_version` and
 * `budget_ms`. Adding it would key every project's cache on a column the plan
 * read cannot supply.
 */
describe('what the deadline change must not do to the cache key', () => {
  const BLUE = '7+1.0.0';
  const GREEN = '8+1.0.0';

  /** The key SQLite actually enforces, in its declared order. */
  function primaryKeyColumns(path: string, table: string): string[] {
    const db = openDatabase(path);
    try {
      return (db.query(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[])
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
    } finally {
      db.close();
    }
  }

  /**
   * 7.4. Read off the migrated file rather than off `schema.ts`, because the
   * drizzle table and the shipped DDL are two artifacts and the one that keys
   * a running deployment is this one.
   */
  it('leaves the key columns exactly as they were, deadline included in none of them', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);

      expect(primaryKeyColumns(db.path, 'optimized_schedule_cache')).toEqual([
        'project_id',
        'input_hash',
        'objective',
        'contract_version',
        'budget_ms',
      ]);

      // NOT load-bearing, and saying so is the point: the equality above is
      // exact, so it reds on a sixth column first and this line cannot fail on
      // its own. It is a grep target — the string a later reader adding
      // `deadline` to the key will land on — and it survives only because
      // naming the negative is cheaper than the review that rediscovers why the
      // key stops where it does.
      expect(primaryKeyColumns(db.path, 'optimized_schedule_cache')).not.toContain('deadline');
    } finally {
      db.cleanup();
    }
  });

  /**
   * 7.5, a **regression** test and deliberately not a new rule.
   *
   * The retention requirement already reads "for that contract version" and
   * `enforceLiveBudgetBound` already scopes its `DELETE` to one
   * `(projectId, objective, contractVersion, inputHash)`. What this pins is
   * that a store on **either** side of a blue/green swap leaves the other
   * side's rows standing — the symmetric claim
   * `optimization-generation.db.test.ts` does not make, since its two-release
   * cases drive `allocateGeneration` from one side only and assert the mover's
   * own rows are gone.
   *
   * Both sides store under the same `input_hash`, which is the case that can
   * actually go wrong: an unscoped bound would count the two versions' rows as
   * one budget set and evict across the seam.
   *
   * **Four rows, and each of the two scopings needs its own of them.**
   * `MAX_LIVE_BUDGETS` is 2, so a two-row fixture is under the bound and no
   * `DELETE` runs at all — the scoping could be removed outright and a two-row
   * assertion would stay green.
   *
   * Three rows catch an unscoped **count**: green stores first, so under a
   * count that sees all three green's is the oldest and the surplus the last
   * store evicts. They do **not** catch an unscoped **delete**, and the peer
   * seat's Important at chunk 2 is why the fourth is here: with the count still
   * scoped, blue and green each hold at most two rows, `live.slice(2)` never
   * iterates, and the delete predicate is never reached to be wrong. Blue's
   * third budget makes blue itself go over — the count then yields
   * `BLUE/60000` as surplus, and a delete that has dropped `contractVersion`
   * matches green's identically-budgeted row on the way past.
   *
   * Measured rather than argued, both arms separately, in the same file:
   * dropping `contractVersion` from the count alone, from the delete alone, and
   * from both, each reds this case and nothing else.
   */
  it('keeps both contract versions’ rows through a store on each side', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');
      const handle = openDrizzle(db.path);

      for (const contractVersion of [BLUE, GREEN]) {
        expect(allocateGeneration(handle, 'p-1', contractVersion, 'h1', 1)).toBe(1);
        reserveSlot(db.path, contractVersion, 60000);
      }
      // Blue's second live budget, the one a swap has in flight beside the
      // first, and then a third that puts blue itself over the bound. Each
      // needs its own seat, because the slot is keyed by budget too.
      reserveSlot(db.path, BLUE, 120000);
      reserveSlot(db.path, BLUE, 180000);

      const store = (contractVersion: string, budgetMs: number, now: number): unknown =>
        storeOptimizedOutcome(handle, {
          claim: {
            projectId: 'p-1',
            contractVersion,
            generation: 1,
            objective: 'pri',
            budgetMs,
            ownerId: 'coordinator-a',
            attemptToken: `tok-${contractVersion}-${String(budgetMs)}`,
          },
          inputHash: 'h1',
          admittedCancelEpoch: 0,
          outcome: { kind: 'failed', reason: 'timeout' },
          now,
        });

      const live = (): string[] =>
        handle
          .select()
          .from(optimizedScheduleCache)
          .all()
          .map((row) => `${row.contractVersion}/${String(row.budgetMs)}`)
          .sort();

      expect(store(GREEN, 60000, 1_700)).toBe('stored');
      expect(store(BLUE, 60000, 1_800)).toBe('stored');
      expect(store(BLUE, 120000, 1_900)).toBe('stored');

      // Three rows: nobody is over their own bound yet, so nothing has been
      // counted as surplus and green is standing on the count's scoping alone.
      expect(live()).toEqual([`${BLUE}/120000`, `${BLUE}/60000`, `${GREEN}/60000`]);

      expect(store(BLUE, 180000, 2_000)).toBe('stored');

      // Blue is now over and gives up its own oldest budget. Green's row has
      // the same `budget_ms` as the one that went, and it stays.
      expect(live()).toEqual([`${BLUE}/120000`, `${BLUE}/180000`, `${GREEN}/60000`]);
    } finally {
      db.cleanup();
    }
  });
});
