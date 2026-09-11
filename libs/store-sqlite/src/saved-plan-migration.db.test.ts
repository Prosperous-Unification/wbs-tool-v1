import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import { rollbackTo } from './migrate-down';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;
const SAVED_PLAN = '20260903190000_add_saved_plan';
/** Reversed ahead of {@link SAVED_PLAN}: it adds a column to the table below. */
const CREATED_BY_ID = '20260904020000_add_saved_plan_created_by_id';
/**
 * `calendar_marker`, one table and one index added whole. It sits directly
 * under {@link READ_ORDER_INDEX} in every descending reversal list in this
 * file, and it takes nothing with it. Its own cases live in
 * `calendar-marker-migration.db.test.ts`.
 */
const CALENDAR_MARKER = '20260905090000_add_calendar_marker';
const LOOKUP_INDEXES = '20260902120000_add_lookup_indexes';
// The two migrations the dual-scheduler branch adds after this file's own.
// `rollbackTo` reverses everything applied after its target, newest first, so
// they lead the list even though this file never mentions them otherwise.
const OPTIMIZER_TABLES = '20260904100000_add_optimizer_tables';
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

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-migration-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The column names SQLite reports for a table, or `[]` when there is no table. */
function columnsOf(table: string): string[] {
  const db = openDatabase(path);
  try {
    return db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name);
  } finally {
    db.close();
  }
}

function seedProject(): void {
  const db = openDatabase(path);
  try {
    db.run(`INSERT INTO users (id, username, created_at) VALUES ('u1', 'u1', 1000)`);
    db.run(`INSERT INTO project (id, name, owner_id, created_at) VALUES ('p1', 'P', 'u1', 1000)`);
  } finally {
    db.close();
  }
}

/** One header with an input body and no schedule, which is a lawful saved plan. */
function seedSavedPlan(): void {
  const db = openDatabase(path);
  try {
    db.run(
      `INSERT INTO saved_plan (
         id, project_id, name, created_by, created_at,
         input_schema_version, input_bytes, input_sha256, schedule_absent_reason
       ) VALUES ('sp1', 'p1', '2026-09-03 19:00', 'Ada', 1000, 1, 3, 'deadbeef', 'pending')`,
    );
    db.run(
      `INSERT INTO saved_plan_body (saved_plan_id, kind, bytes) VALUES ('sp1', 'input', '{}')`,
    );
  } finally {
    db.close();
  }
}

function countOf(table: string): number {
  const db = openDatabase(path);
  try {
    return db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
  } finally {
    db.close();
  }
}

describe('the saved-plan migration', () => {
  /**
   * Task 2.2's proof, and the reason it is not an exit code.
   *
   * `rollbackTo` answering with the folder name says the down script ran, not
   * that it did anything: `steps-schema-rename` shipped a `REFERENCES` clause
   * SQLite had never applied and every check written for it passed. So the
   * assertion is `pragma table_info` on both tables, before, after and after
   * re-applying — a table that is still there reports its columns, and one that
   * is gone reports none.
   */
  it('rolls both tables away and puts them back, read off pragma table_info', () => {
    expect(columnsOf('saved_plan')).toContain('input_sha256');
    expect(columnsOf('saved_plan_body')).toContain('bytes');

    expect(rollbackTo(path, FOLDER, LOOKUP_INDEXES)).toEqual([
      EXTERNAL_REF_NAME,
      WORK_ITEM_DEADLINE,
      READ_ORDER_INDEX,
      CALENDAR_MARKER,
      PROJECT_SETTINGS,
      OPTIMIZER_TABLES,
      CREATED_BY_ID,
      SAVED_PLAN,
    ]);

    // The precondition for the two lines above meaning anything: `toContain` on
    // an empty list already fails, so these say the rollback emptied them.
    expect(columnsOf('saved_plan')).toEqual([]);
    expect(columnsOf('saved_plan_body')).toEqual([]);

    runMigrations(path, FOLDER);

    expect(columnsOf('saved_plan')).toContain('input_sha256');
    expect(columnsOf('saved_plan_body')).toContain('bytes');
  });

  it('takes the whole header column list forward, not a subset', () => {
    expect(columnsOf('saved_plan')).toEqual([
      'id',
      'project_id',
      'name',
      'created_by',
      'created_at',
      'input_schema_version',
      'input_bytes',
      'input_sha256',
      'schedule_schema_version',
      'schedule_bytes',
      'schedule_sha256',
      'schedule_input_sha256',
      'scheduler_algorithm_id',
      'schedule_absent_reason',
      // Added by its own later folder, 20260904020000_add_saved_plan_created_by_id,
      // so it lands after every column the create statement names rather than
      // beside `created_by` where the drizzle schema declares it. `ADD COLUMN`
      // appends; column order is physical here and only this list depends on it.
      'created_by_id',
    ]);
  });

  /**
   * Task 2.3. The cascade is **enforced**, not merely declared.
   *
   * `steps-schema-rename` is the precedent: a `REFERENCES` clause SQLite had not
   * applied, and the check written for it passed against the broken database.
   * So this writes a header and a body, deletes the project, and reads both
   * tables back — and asserts the delete itself was not blocked, which is the
   * half a `RESTRICT` would fail and a missing constraint would pass.
   */
  it('deletes header and body with the project, and does not block the delete', () => {
    seedProject();
    seedSavedPlan();
    expect(countOf('saved_plan')).toBe(1);
    expect(countOf('saved_plan_body')).toBe(1);

    const db = openDatabase(path);
    try {
      // Not `.toThrow()`-wrapped on purpose: an outgoing blue/green release runs
      // exactly this statement knowing nothing of these tables, and a constraint
      // it cannot see would surface as a 500 for the length of the swap.
      db.run(`DELETE FROM project WHERE id = 'p1'`);
    } finally {
      db.close();
    }

    expect(countOf('saved_plan')).toBe(0);
    expect(countOf('saved_plan_body')).toBe(0);
  });

  it('deletes a body with its header', () => {
    seedProject();
    seedSavedPlan();

    const db = openDatabase(path);
    try {
      db.run(`DELETE FROM saved_plan WHERE id = 'sp1'`);
    } finally {
      db.close();
    }

    expect(countOf('saved_plan_body')).toBe(0);
  });

  it('refuses half a schedule', () => {
    seedProject();
    const db = openDatabase(path);
    try {
      // A hash and a length but no algorithm identity and no absent reason: the
      // state in which a reader cannot say whether dates were saved.
      expect(() =>
        db.run(
          `INSERT INTO saved_plan (
             id, project_id, name, created_by, created_at,
             input_schema_version, input_bytes, input_sha256,
             schedule_schema_version, schedule_bytes, schedule_sha256
           ) VALUES ('sp2', 'p1', 'half', 'Ada', 1000, 1, 3, 'deadbeef', 1, 9, 'feedface')`,
        ),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('refuses a body of an unknown kind', () => {
    seedProject();
    seedSavedPlan();
    const db = openDatabase(path);
    try {
      expect(() =>
        db.run(
          `INSERT INTO saved_plan_body (saved_plan_id, kind, bytes) VALUES ('sp1', 'dates', '{}')`,
        ),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  /**
   * `created_by` is a value, not a reference — an account deletion must not
   * orphan or erase a permanent record.
   *
   * Asserted by naming an account that does not exist rather than by deleting
   * one: `project.owner_id` is `NOT NULL` and references `users`, so no project
   * with a saved plan can outlive its owner's row in the first place, and a
   * delete-then-read test would be measuring that constraint instead of this
   * one. Foreign keys are on for every connection `openDatabase` hands out
   * (`db.ts`, asserted there), so a reference quietly applied to this column
   * would refuse the row below.
   */
  it('stores a creator no account row backs', () => {
    seedProject();
    const db = openDatabase(path);
    try {
      db.run(
        `INSERT INTO saved_plan (
           id, project_id, name, created_by, created_at,
           input_schema_version, input_bytes, input_sha256, schedule_absent_reason
         ) VALUES ('sp3', 'p1', 'left the company', 'nobody-by-that-id', 1000, 1, 3, 'deadbeef', 'pending')`,
      );

      expect(
        db.query<{ created_by: string }, []>(`SELECT created_by FROM saved_plan`).get()?.created_by,
      ).toBe('nobody-by-that-id');
      // The precondition: the same insert against a column that *is* a
      // reference does fail, so the line above is not passing on a disabled
      // pragma.
      expect(() =>
        db.run(
          `INSERT INTO saved_plan (
             id, project_id, name, created_by, created_at,
             input_schema_version, input_bytes, input_sha256, schedule_absent_reason
           ) VALUES ('sp4', 'no-such-project', 'orphan', 'Ada', 1000, 1, 3, 'deadbeef', 'pending')`,
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });
});
