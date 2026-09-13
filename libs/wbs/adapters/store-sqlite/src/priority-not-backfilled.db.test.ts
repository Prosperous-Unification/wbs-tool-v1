import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import { readMigrationFolders, rollbackTo } from './migrate-down';

/**
 * **The check that a thing was _not_ done.**
 *
 * `priority-default-medium` gives every *newly created* work item the project's
 * middle rung and deliberately ships **no migration and no backfill**: a plan
 * written before it keeps its blank priorities, because moving every row on
 * screen for a default nobody typed is the one thing the change refused
 * (proposal.md, Non-Goals). Null still draws as nothing on all four faces.
 *
 * A claim about an absence cannot be asserted by reading the code that is not
 * there, so it is asserted against the **migrator**: a plan holding null
 * priorities is put into the schema of the previous release, every migration
 * since is run forward over it, and the nulls have to still be nulls. Any
 * backfill anybody adds later is a migration this run applies.
 *
 * Proof: a scratch migration `20260830000000_backfill_priority` added to
 * `apps/be-01/drizzle/` — `UPDATE work_item SET priority = 50 WHERE priority IS
 * NULL;` with a no-op `down.sql` — and this failed on
 * `expected [ 50, 50 ] to equal [ null, null ]`. The folder was then deleted.
 * Watched 2026-08-29.
 */
const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-priority-backfill-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The migration before the newest one on disk, read rather than named.
 *
 * Read, because the point of the baseline here is "one release back, whatever
 * that is now" — a name written into this file would freeze the window and stop
 * covering the migration somebody adds tomorrow, which is the only migration
 * that could ever do the backfill.
 */
function releaseBefore(): string {
  const folders = readMigrationFolders(FOLDER);
  const baseline = folders.at(-2);
  if (baseline === undefined) {
    throw new Error(`${FOLDER} holds fewer than two migrations, so there is no previous release`);
  }
  return baseline.name;
}

describe('the priorities of a plan written before the default', () => {
  it('an existing plan is unchanged', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, releaseBefore());

      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('ada', 'ada', 'hash', 1)",
        );
        before.run(
          "INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at) VALUES ('p', 'Rewire the shed', 'ada', 0, 'pert', NULL, 0, 1)",
        );
        // Two rows nobody prioritised — the state every plan in the database is
        // in on the day this change ships.
        before.run(
          "INSERT INTO work_item (id, project_id, position, name) VALUES ('strip', 'p', 10, 'Strip')",
        );
        before.run(
          "INSERT INTO work_item (id, project_id, position, name) VALUES ('sand', 'p', 20, 'Sand')",
        );
        expect(
          before
            .query<{ priority: number | null }, []>('SELECT priority FROM work_item ORDER BY id')
            .all()
            .map((row) => row.priority),
        ).toEqual([null, null]);
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<{ id: string; priority: number | null }, []>(
              'SELECT id, priority FROM work_item ORDER BY id',
            )
            .all(),
        ).toEqual([
          { id: 'sand', priority: null },
          { id: 'strip', priority: null },
        ]);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });
});
