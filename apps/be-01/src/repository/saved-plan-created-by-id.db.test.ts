import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import { rollbackTo } from './migrate-down';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CREATED_BY_ID = '20260904020000_add_saved_plan_created_by_id';
/**
 * The newest: `calendar_marker`, one table and one index added whole. It heads
 * every descending reversal list in this file because it was applied last, and
 * it takes nothing with it. Its own cases live in
 * `calendar-marker-migration.db.test.ts`.
 */
const CALENDAR_MARKER = '20260905090000_add_calendar_marker';
const SAVED_PLAN = '20260903190000_add_saved_plan';
// The two migrations the dual-scheduler branch adds after this one. `rollbackTo`
// reverses everything applied after its target, newest first, so a rollback to
// SAVED_PLAN reverses them before it reaches this file's own column.
const OPTIMIZER_TABLES = '20260904100000_add_optimizer_tables';
const PROJECT_SETTINGS = '20260904140000_add_project_settings';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-created-by-id-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

/** Two accounts, one project owned by the first, and a plan saved by the second. */
function seed(): void {
  const db = openDatabase(path);
  try {
    db.run(`INSERT INTO users (id, username, created_at) VALUES ('owner', 'owner', 1000)`);
    db.run(`INSERT INTO users (id, username, created_at) VALUES ('ada', 'Ada', 1000)`);
    db.run(
      `INSERT INTO project (id, name, owner_id, created_at) VALUES ('p1', 'P', 'owner', 1000)`,
    );
    db.run(
      `INSERT INTO saved_plan (
         id, project_id, name, created_by, created_by_id, created_at,
         input_schema_version, input_bytes, input_sha256, schedule_absent_reason
       ) VALUES ('sp1', 'p1', 'Q3', 'Ada', 'ada', 1000, 1, 2, 'deadbeef', 'pending')`,
    );
    db.run(
      `INSERT INTO saved_plan_body (saved_plan_id, kind, bytes) VALUES ('sp1', 'input', '{}')`,
    );
  } finally {
    db.close();
  }
}

/** The header's two creator columns, as stored. */
function creatorOf(id: string): { created_by: string; created_by_id: string | null } | null {
  const db = openDatabase(path);
  try {
    return (
      db
        .query<
          { created_by: string; created_by_id: string | null },
          [string]
        >(`SELECT created_by, created_by_id FROM saved_plan WHERE id = ?`)
        .get(id) ?? null
    );
  } finally {
    db.close();
  }
}

describe('saved_plan.created_by_id', () => {
  /**
   * The column exists and is nullable, read off `pragma table_info` rather than
   * off the fact that the migration ran.
   *
   * `rollbackTo` answering with a folder name says the down script ran, not that
   * it did anything — `steps-schema-rename` shipped a `REFERENCES` clause SQLite
   * had never applied and every check written for it passed. So the assertion is
   * the pragma, before and after the reversal and after re-applying.
   */
  it('adds one nullable column and takes it away again', () => {
    expect(columnsOf('saved_plan')).toContain('created_by_id');
    // `notnull` is 0: a plan whose creator's account is gone has to be storable.
    const nullable = () => {
      const db = openDatabase(path);
      try {
        return db
          .query<{ name: string; notnull: number }, []>(`PRAGMA table_info(saved_plan)`)
          .all()
          .find((c) => c.name === 'created_by_id')?.notnull;
      } finally {
        db.close();
      }
    };
    expect(nullable()).toBe(0);

    expect(rollbackTo(path, FOLDER, SAVED_PLAN)).toEqual([
      CALENDAR_MARKER,
      PROJECT_SETTINGS,
      OPTIMIZER_TABLES,
      CREATED_BY_ID,
    ]);

    // The precondition for the line above meaning anything: the table is still
    // there, so `not.toContain` is a statement about the column and not about a
    // dropped table reporting no columns at all.
    expect(columnsOf('saved_plan')).toContain('created_by');
    expect(columnsOf('saved_plan')).not.toContain('created_by_id');

    runMigrations(path, FOLDER);
    expect(columnsOf('saved_plan')).toContain('created_by_id');
  });

  /**
   * Task 6.3's second half, and the whole point of A-8: **the deletion keeps the
   * name and drops the right.**
   *
   * Two assertions, because either alone passes against a wrong constraint.
   * `created_by` surviving alone would also pass under `ON DELETE CASCADE` if the
   * plan happened to be read before the cascade — so the row count is asserted
   * too. `created_by_id` going null alone would also pass if the whole row were
   * gone, which is why the name is read back from a row that still exists.
   */
  it('nulls the reference and keeps the value when the creator is deleted', () => {
    seed();
    expect(creatorOf('sp1')).toEqual({ created_by: 'Ada', created_by_id: 'ada' });

    const db = openDatabase(path);
    try {
      // Not wrapped in `.toThrow()` on purpose: `RESTRICT` would block this, and
      // an account deletion that a permanent record can veto is the failure this
      // constraint choice exists to avoid.
      db.run(`DELETE FROM users WHERE id = 'ada'`);
    } finally {
      db.close();
    }

    expect(creatorOf('sp1')).toEqual({ created_by: 'Ada', created_by_id: null });
    // The plan is still whole — the header survived and so did its body.
    const bodies = openDatabase(path);
    try {
      expect(
        bodies.query<{ n: number }, []>(`SELECT count(*) AS n FROM saved_plan_body`).get()?.n ?? 0,
      ).toBe(1);
    } finally {
      bodies.close();
    }
  });

  /**
   * The reference is **enforced**, not merely declared. `steps-schema-rename` is
   * the precedent: a `REFERENCES` clause SQLite had not applied, and the check
   * written for it passed against the broken database. A missing constraint would
   * let this insert succeed.
   */
  it('refuses a creator id that names no account', () => {
    seed();
    const db = openDatabase(path);
    try {
      expect(() =>
        db.run(
          `INSERT INTO saved_plan (
             id, project_id, name, created_by, created_by_id, created_at,
             input_schema_version, input_bytes, input_sha256, schedule_absent_reason
           ) VALUES ('sp2', 'p1', 'Q4', 'Nobody', 'ghost', 1000, 1, 2, 'deadbeef', 'pending')`,
        ),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  /**
   * No backfill, and the null it leaves is a **decision**, not a gap.
   *
   * A row written before this migration ran reads `NULL`, which means the same
   * thing a deleted creator means: no live account claims this plan, so the rule
   * falls back to the project owner. Written as a rollback-then-insert-then-
   * re-apply rather than by inserting a null directly, because that is the only
   * way to produce a row that genuinely predates the column.
   */
  it('leaves a row written before the column reading null', () => {
    expect(rollbackTo(path, FOLDER, SAVED_PLAN)).toEqual([
      CALENDAR_MARKER,
      PROJECT_SETTINGS,
      OPTIMIZER_TABLES,
      CREATED_BY_ID,
    ]);

    const before = openDatabase(path);
    try {
      before.run(`INSERT INTO users (id, username, created_at) VALUES ('owner', 'owner', 1000)`);
      before.run(
        `INSERT INTO project (id, name, owner_id, created_at) VALUES ('p1', 'P', 'owner', 1000)`,
      );
      before.run(
        `INSERT INTO saved_plan (
           id, project_id, name, created_by, created_at,
           input_schema_version, input_bytes, input_sha256, schedule_absent_reason
         ) VALUES ('old', 'p1', 'Q1', 'Ada', 1000, 1, 2, 'deadbeef', 'pending')`,
      );
    } finally {
      before.close();
    }

    runMigrations(path, FOLDER);

    expect(creatorOf('old')).toEqual({ created_by: 'Ada', created_by_id: null });
  });
});
