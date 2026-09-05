import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { projectRow } from '../testing/project-fixture';
import { openConnection, openDatabase } from './db';
import type { WriteStamp } from './index';
import { runMigrations } from './migrate';
import { duplicateMigrationStamps, rollbackTo } from './migrate-down';
import { ProjectRepository } from './project';
import { calendarMarker } from './schema';
import { UserRepository } from './user';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CALENDAR_MARKER = '20260905090000_add_calendar_marker';
/** The folder this one is stamped after — the newest on main before it. */
// The folder immediately before this one, which moved when TASK-219 landed two
// migrations of its own between it and `saved_plan_created_by_id`. Named
// rather than computed, so a third folder arriving here is a red test and not
// a silently widened rollback.
const PREVIOUS = '20260904140000_add_project_settings';

const wrote: WriteStamp = { at: 1, by: 'owner' };

/** Past the first weekend, for the reason `calendar-marker.db.test.ts` states. */
const PAST_THE_WEEKEND = '2026-08-24';

async function seedProjectWithMarkers(path: string): Promise<void> {
  const seed = openConnection(path);
  await new UserRepository(seed.db).create(
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote,
  );
  // **No starting steps, deliberately.** `step`, `work_item`, `dependency` and
  // `project_access` all reference `project` with no `ON DELETE` action at all
  // (`schema.ts:244,277,498,1639`), so a project holding any of them refuses a
  // bare `DELETE FROM project` today, before this change exists. Seeding one
  // here would make the case below fail for a constraint that is not
  // `calendar_marker`'s — a red that says nothing about the diff, and one that
  // would still be red with the cascade in place. The project is left bare so
  // that the only reference standing between the delete and success is the one
  // this migration adds.
  await new ProjectRepository(seed.db).create(
    projectRow({ id: 'p1', name: 'Rewire the shed', ownerId: 'owner' }),
    [],
    wrote,
  );
  await seed.db.insert(calendarMarker).values([
    {
      id: 'cm-demo',
      projectId: 'p1',
      date: PAST_THE_WEEKEND,
      name: 'Client demo',
      color: null,
      createdAt: 1_756_000_000,
    },
    {
      id: 'cm-deadline',
      projectId: 'p1',
      date: PAST_THE_WEEKEND,
      name: 'Grant deadline',
      color: '#3b82f6',
      createdAt: 1_756_000_001,
    },
  ]);
  seed.close();
}

function tableNames(path: string): string[] {
  const db = openDatabase(path);
  try {
    return db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

describe('20260905090000_add_calendar_marker', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-calendar-marker-migration-'));
    path = join(dir, 'test.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets a plain DELETE FROM project take its markers with it', async () => {
    // **The cascade is a deployment property, not tidiness.** Blue and green
    // share one SQLite file through a swap, and the outgoing release knows
    // nothing of `calendar_marker`: whatever delete sequence it was built with
    // ends at a `DELETE FROM project` that names only the tables it knows.
    // Without `ON DELETE CASCADE` that last statement hits a constraint it
    // cannot see and the release answers 500 for the length of the swap — which
    // is what this case is watching, not row hygiene.
    //
    // **It watches this table's constraint and no other.** The other
    // project-scoped tables the outgoing release *does* know are deleted by it
    // first; see `seedProjectWithMarkers` for why nothing else is seeded here.
    //
    // Proof: with `ON DELETE CASCADE` removed from the `FOREIGN KEY` clause in
    // `20260905090000_add_calendar_marker/migration.sql` (leaving the reference
    // in place), this fails on the `DELETE` with `FOREIGN KEY constraint
    // failed`, because `openDatabase` asserts `PRAGMA foreign_keys = ON` rather
    // than requesting it. Watched failing exactly that way on h2puni,
    // 2026-09-05, before the seed was narrowed — the fault reproduces, and the
    // narrowing is what makes the red mean this table.
    runMigrations(path, FOLDER);
    await seedProjectWithMarkers(path);

    const db = openDatabase(path);
    try {
      db.run("DELETE FROM project WHERE id = 'p1'");
      const left = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM calendar_marker').get();
      expect(left?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rolls back to the previous migration, taking the table and leaving the rest', () => {
    // `rollbackTo` rather than a CLI: `migrate-down.ts` exports the runner and
    // `readMigrationFolders` is the lint — a missing or empty `down.sql` throws
    // there, so both halves of the negative below are reachable from this file.
    //
    // Proof, two mutations, each watched separately:
    //   (a) `20260905090000_add_calendar_marker/down.sql` deleted — every test
    //       that calls `readMigrationFolders` or `rollbackTo` fails with
    //       `has no down.sql`, including this one and
    //       `pairs every migration on disk with a down script` in
    //       `migrate-down.db.test.ts`.
    //   (b) the same file emptied — the lint still passes, because a file
    //       exists, and *this* case fails instead: the rollback reports
    //       `[CALENDAR_MARKER]` while `calendar_marker` is still in
    //       `sqlite_master`. That gap between the two is why the empty file is
    //       a separate mutation and not a restatement of the first.
    runMigrations(path, FOLDER);
    const withTable = tableNames(path);
    expect(withTable).toContain('calendar_marker');

    const reversed = rollbackTo(path, FOLDER, PREVIOUS);

    expect(reversed).toEqual([CALENDAR_MARKER]);
    const afterRollback = tableNames(path);
    expect(afterRollback).not.toContain('calendar_marker');
    // Nothing else moved: the forward migration is additive, so its reversal
    // owes the rest of the schema byte-for-byte.
    expect(afterRollback).toEqual(withTable.filter((n) => n !== 'calendar_marker'));
  });

  it('is stamped later than every folder on disk and collides with none', () => {
    // A colliding stamp is the failure with no error message: drizzle records
    // the folder's numeric prefix as `created_at`, `migrationsToRollback`
    // filters on a strict `created_at >`, and a rollback whose baseline names
    // either of a colliding pair reverses nothing and reports success.
    //
    // Proof: with this folder renamed to `20260904020000_add_calendar_marker`,
    // `duplicateMigrationStamps` returns `[20260904020000]` and this fails on
    // the first assertion.
    const names = readdirSync(FOLDER).sort();

    expect(names).toContain(CALENDAR_MARKER);
    expect(duplicateMigrationStamps(names)).toEqual([]);
    expect(names.at(-1)).toBe(CALENDAR_MARKER);
  });
});
