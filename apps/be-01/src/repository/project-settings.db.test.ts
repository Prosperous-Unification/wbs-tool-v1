import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import { rollbackTo } from './migrate-down';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** The migration under test: slice 3b.1's three project settings columns. */
const CALENDAR_MARKER = '20260905090000_add_calendar_marker';
const PROJECT_SETTINGS = '20260904140000_add_project_settings';

/** The one below it, which is where every rollback here stops. */
const OPTIMIZER_TABLES = '20260904100000_add_optimizer_tables';

/**
 * What `20260904140000_add_project_settings` adds, **enumerated rather than
 * counted** (tasks.md 3b.7).
 *
 * A `down.sql` written from "the settings columns" drops two of three and
 * leaves the last one behind, and a column that survived a rollback is an
 * `ADD COLUMN` that throws on the re-apply — the aborted blue/green deploy.
 * Counting three columns off `PRAGMA table_info` would pass on exactly that
 * fault if some unrelated column moved at the same time, so the list is
 * written out and each name is asserted.
 */
const ADDED_COLUMNS = ['optimization_enabled', 'schedule_engine', 'schedule_objective'] as const;

/**
 * Slice 3's fence, which lands in the migration *below* this one and must
 * survive this one's rollback.
 *
 * It is here because it is the single column most likely to be swept up: it is
 * named `optimization_…`, it sits on `project`, and it was moved out of this
 * slice into 3.1b precisely so the two slices could ship as separate PRs
 * (tasks.md 3.1b, 3b.7). A `down.sql` that took it too would leave slice 3
 * unimplementable against its own schema.
 */
const NOT_OURS = 'optimization_delete_pending_at';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-project-settings-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
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

/**
 * The stored `CREATE TABLE` text for `project`, which is where SQLite keeps a
 * column's `CHECK`.
 *
 * `PRAGMA table_info` answers names, types and defaults and says nothing about
 * constraints, so a migration that dropped every `CHECK` would pass every
 * column assertion in this file. This is the only reader that can see them.
 */
function projectDdl(path: string): string {
  const db = openDatabase(path);
  try {
    const row = db
      .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'project'`)
      .get();
    return row?.sql ?? '';
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

function settingsOf(path: string, id: string): Record<string, unknown> | null {
  const db = openDatabase(path);
  try {
    return db
      .query(
        `SELECT optimization_enabled, schedule_engine, schedule_objective
           FROM project WHERE id = '${id}'`,
      )
      .get() as Record<string, unknown> | null;
  } finally {
    db.close();
  }
}

describe('the project settings migration', () => {
  it('adds the three settings columns and touches nothing else on project', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const migrated = projectColumns(db.path);

      for (const column of ADDED_COLUMNS) expect(migrated).toContain(column);
      expect(migrated).toContain(NOT_OURS);

      // Rolling this one migration off leaves exactly the three columns behind
      // and nothing else, which is the claim `PRAGMA`-plus-`toContain` alone
      // cannot make: a migration that also dropped a column would still pass
      // every line above.
      expect(rollbackTo(db.path, FOLDER, OPTIMIZER_TABLES)).toEqual([
        CALENDAR_MARKER,
        PROJECT_SETTINGS,
      ]);
      expect(projectColumns(db.path)).toEqual(
        migrated.filter((name) => !ADDED_COLUMNS.includes(name as never)),
      );
    } finally {
      db.cleanup();
    }
  });

  /**
   * The safety property of the whole slice, and the reason the defaults are
   * written into the `ADD COLUMN` rather than backfilled after it: a project
   * that existed before the optimizer shipped must come out of the migration
   * switched **off**.
   *
   * The row is seeded while the database is rolled back to the migration below
   * this one, so it is genuinely written by a release that has never heard of
   * these columns — the blue half of a blue/green swap. Seeding after the
   * migration and asserting the same three values would prove only that the
   * defaults apply to new rows, which is not the deploy anybody is afraid of.
   *
   * **Watched red (tasks.md 3b.5):** change the migration's
   * `optimization_enabled` default from `0` to `1` and this case fails on the
   * first expectation. That default is what decides whether deploying this
   * migration starts a solver for every project in the database.
   */
  it('leaves a project written before it switched off, on the fast engine', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      expect(rollbackTo(db.path, FOLDER, OPTIMIZER_TABLES)).toEqual([
        CALENDAR_MARKER,
        PROJECT_SETTINGS,
      ]);

      seedProject(db.path, 'p-unmigrated');
      runMigrations(db.path, FOLDER);

      expect(settingsOf(db.path, 'p-unmigrated')).toEqual({
        optimization_enabled: 0,
        schedule_engine: 'fast',
        schedule_objective: 'pri',
      });
    } finally {
      db.cleanup();
    }
  });

  /**
   * The `CHECK` half of tasks.md 3b.8, read off the database rather than off
   * `schema.ts`.
   *
   * These constraints are the reason the columns are safe to read as a closed
   * vocabulary at all: a value the database refuses is a value no read-time
   * validator ever has to have seen. Each is exercised through a direct `UPDATE`
   * — the path a migration, a fixture or a future writer takes when it bypasses
   * the repository entirely, which is exactly who a constraint in `schema.ts`
   * alone would not stop.
   */
  it('refuses a value outside each column vocabulary', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');

      expect(
        refusal(db.path, `UPDATE project SET optimization_enabled = 2 WHERE id = 'p-1'`),
      ).toContain('CHECK');
      expect(
        refusal(db.path, `UPDATE project SET schedule_engine = 'turbo' WHERE id = 'p-1'`),
      ).toContain('CHECK');
      expect(
        refusal(db.path, `UPDATE project SET schedule_objective = 'cost' WHERE id = 'p-1'`),
      ).toContain('CHECK');

      // The control: every value the vocabulary does hold is accepted, so the
      // three refusals above are about the value and not about the column.
      expect(
        refusal(
          db.path,
          `UPDATE project SET optimization_enabled = 1, schedule_engine = 'optimized',
             schedule_objective = 'time' WHERE id = 'p-1'`,
        ),
      ).toBeNull();
      expect(settingsOf(db.path, 'p-1')).toEqual({
        optimization_enabled: 1,
        schedule_engine: 'optimized',
        schedule_objective: 'time',
      });
    } finally {
      db.cleanup();
    }
  });

  /**
   * The 3b.7 proof: the rollback names each of the three columns, keeps slice
   * 3's fence, and the re-apply lands the schema it started from — `CHECK`s
   * included.
   */
  it('rolls back each named column and re-applies onto the rolled-back file', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path, 'p-1');
      const migratedDdl = projectDdl(db.path);

      expect(rollbackTo(db.path, FOLDER, OPTIMIZER_TABLES)).toEqual([
        CALENDAR_MARKER,
        PROJECT_SETTINGS,
      ]);

      const rolledBack = projectColumns(db.path);
      for (const column of ADDED_COLUMNS) expect(rolledBack).not.toContain(column);
      expect(rolledBack).toContain(NOT_OURS);
      for (const column of ADDED_COLUMNS) expect(projectDdl(db.path)).not.toContain(column);

      // The project survived: this migration carries settings, and a rollback
      // that lost a plan would be a different and much worse kind of bug.
      const stillThere = openDatabase(db.path);
      try {
        expect(stillThere.query(`SELECT id FROM project`).all()).toEqual([{ id: 'p-1' }]);
      } finally {
        stillThere.close();
      }

      runMigrations(db.path, FOLDER);

      // The whole stored `CREATE TABLE`, so a re-apply that dropped a `CHECK`
      // or reordered a column is a diff rather than a pass.
      expect(projectDdl(db.path)).toEqual(migratedDdl);
      expect(settingsOf(db.path, 'p-1')).toEqual({
        optimization_enabled: 0,
        schedule_engine: 'fast',
        schedule_objective: 'pri',
      });
    } finally {
      db.cleanup();
    }
  });
});
