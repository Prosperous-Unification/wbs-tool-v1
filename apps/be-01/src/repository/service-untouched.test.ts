import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import { rollbackTo } from './migrate-down';

/**
 * **Tasks 8.3 and 8.4 — the two tables the split is not allowed to touch.**
 *
 * A service is a thing work is *for*. A team is who does it, and a person is
 * who is on the team. So the split adds a dimension beside those two facts and
 * changes neither, and the two places where "changed neither" could quietly
 * stop being true are:
 *
 * - `project_team_capacity` (8.3) — the pool. R2-5 §2 refused to generalise it
 *   into a `project_<dimension>_capacity`, and re-keying it on a service is the
 *   single edit that would turn a grouping label into a scheduling input
 *   without any code looking like it schedules.
 * - `person_team` (8.4) — membership. The assignee signal (task 7) **reads**
 *   this to decide whether a person is outside the row's team, and a read that
 *   grew a column would be a write.
 *
 * Asserted against the migration rather than against the ORM on purpose: the
 * schema is where a re-key would have to happen, and a `pragma` answer cannot
 * be satisfied by a type that merely looks unchanged.
 *
 * The last release before this change is the baseline; the two service
 * migrations are the diff under test.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** The release immediately before the split — everything after it is this change. */
const BEFORE_SERVICE = '20260819120000_add_tag';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-service-untouched-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function columnsOf(dbPath: string, table: string): { name: string; type: string; pk: number }[] {
  const sqlite = openDatabase(dbPath);
  try {
    return sqlite
      .query<
        { name: string; type: string; pk: number },
        [string]
      >('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid')
      .all(table);
  } finally {
    sqlite.close();
  }
}

function rowsOf(dbPath: string, sql: string): unknown[] {
  const sqlite = openDatabase(dbPath);
  try {
    return sqlite.query<Record<string, unknown>, []>(sql).all();
  } finally {
    sqlite.close();
  }
}

describe('the pool and the membership list, across the service migrations', () => {
  it('8.3 leaves project_team_capacity row-for-row and column-for-column as it found it', () => {
    // The strong form of the claim, and the reason this is a migration test and
    // not a schema snapshot: rows written **before** the split exist **after**
    // it, unchanged and still keyed the same way. A re-key that preserved the
    // shape would still have to rewrite or drop these rows to do it.
    //
    // Proof: `ALTER TABLE project_team_capacity ADD service_id text REFERENCES
    // service(id);` appended to `20260821000000_add_service/migration.sql` — the
    // split reaching into the pool, which is the one edit R2-5 §2 refused —
    // and **1 pass, 2 fail**: this case on the column comparison and `does not
    // generalise the pool` beside it. Watched on h2puni 2026-08-21, reverted.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const reversed = rollbackTo(db.path, FOLDER, BEFORE_SERVICE);
      // Non-vacuity: if the rollback reversed nothing, the database below is
      // already the post-split one and this whole case compares it with itself.
      expect(reversed.length).toBeGreaterThan(0);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1', 'owner', 'x', 1)",
        );
        sqlite.run(
          "INSERT INTO project (id, name, owner_id, created_at) VALUES ('p1', 'Shed', 'u1', 1)",
        );
        sqlite.run("INSERT INTO service_team (id, name) VALUES ('t1', 'Platform')");
        sqlite.run(
          "INSERT INTO project_team_capacity (project_id, service_team_id, size) VALUES ('p1', 't1', 3)",
        );
      } finally {
        sqlite.close();
      }

      const CAPACITY = 'SELECT * FROM project_team_capacity ORDER BY project_id, service_team_id';
      const before = rowsOf(db.path, CAPACITY);
      const shapeBefore = columnsOf(db.path, 'project_team_capacity');
      expect(before).toHaveLength(1);

      runMigrations(db.path, FOLDER);

      expect(rowsOf(db.path, CAPACITY)).toEqual(before);
      expect(columnsOf(db.path, 'project_team_capacity')).toEqual(shapeBefore);
    } finally {
      db.cleanup();
    }
  });

  it('8.3 does not generalise the pool onto the new dimension', () => {
    // The named absence. A service has no size and no pool, so there is no
    // `project_service_capacity` and no `service_id` on the team's pool — and a
    // change that wanted either would have to delete this case to get it, which
    // is the conversation R2-5 §2 asked for.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const columns = columnsOf(db.path, 'project_team_capacity');

      expect(columns.map((c) => c.name)).toEqual(['project_id', 'service_team_id', 'size']);
      expect(columns.map((c) => c.name)).not.toContain('service_id');
      // Still keyed on the plan and the team, both halves — not re-keyed onto a
      // third thing and not widened to a surrogate id.
      expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
        'project_id',
        'service_team_id',
      ]);

      const tables = rowsOf(db.path, "SELECT name FROM sqlite_master WHERE type = 'table'").map(
        (row) => (row as { name: string }).name,
      );
      expect(tables).not.toContain('project_service_capacity');
      // The map the split *did* add is a directory fact with no size on it.
      expect(tables).toContain('team_service');
      expect(columnsOf(db.path, 'team_service').map((c) => c.name)).not.toContain('size');
    } finally {
      db.cleanup();
    }
  });

  it('8.4 leaves person_team exactly as it found it, because the signal only reads it', () => {
    // Task 7's assignee signal asks "is this person on this team" and writes
    // nothing back. So membership keeps both of its columns and neither a
    // service nor a mismatch flag joins them: a flag stored here would be a
    // *decision* cached against a plan it cannot see, and the signal is derived
    // on every read for exactly that reason.
    //
    // Proof: the same append one table over — `ALTER TABLE person_team ADD
    // service_id text REFERENCES service(id);` — **1 pass, 2 fail**, this case
    // and 8.3's row comparison. Watched on h2puni 2026-08-21, reverted.
    //
    // **The guard that made both reds trustworthy, and it nearly did not.** The
    // first two attempts appended to `up.sql`, a file this repo does not have
    // (the pair on disk is `migration.sql` + `down.sql`), so each one *created*
    // it — and `git diff --quiet` says clean about a file git has never seen.
    // A no-diff reported as a green. The runner asserts a non-empty diff before
    // believing anything, which is what caught it, and the lesson on top of the
    // three earlier quoting misses is that the assertion has to cover untracked
    // files too: `git status --porcelain`, not `git diff`.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const before = columnsOf(db.path, 'person_team');
      const reversed = rollbackTo(db.path, FOLDER, BEFORE_SERVICE);
      expect(reversed.length).toBeGreaterThan(0);

      expect(columnsOf(db.path, 'person_team')).toEqual(before);
      expect(before.map((c) => c.name)).toEqual(['person_id', 'service_team_id']);
      expect(before.map((c) => c.name)).not.toContain('service_id');
    } finally {
      db.cleanup();
    }
  });
});
