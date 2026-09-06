import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { asc } from 'drizzle-orm';

import { projectRow } from '../testing/project-fixture';
import type { Connection } from './db';
import { openConnection } from './db';
import type { WriteStamp } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { calendarMarker } from './schema';
import { UserRepository } from './user';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

/**
 * **2026-08-24, not a workday number.** The project fixtures across this suite
 * start Monday 2026-08-10, and a marker on the first working week would land at
 * the same x under the calendar axis and under the workday axis — so it would
 * prove nothing about which of the two the date means. Every marker date in
 * this change sits past the first weekend for that reason;
 * `openspec/changes/gantt-calendar-markers/tasks.md` states it once at the top
 * and this is the storage end of it.
 */
const PAST_THE_WEEKEND = '2026-08-24';

describe('calendar_marker', () => {
  let dir: string;
  let path: string;
  let conn: Connection;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-calendar-marker-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const seed = openConnection(path);
    await new UserRepository(seed.db).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(seed.db).create(
      projectRow({ id: 'p1', name: 'Rewire the shed', ownerId: 'owner' }),
      [{ id: 'st-1', projectId: 'p1', name: 'Build', position: 10 }],
      wrote,
    );
    seed.close();
    conn = openConnection(path);
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a marker', async () => {
    await conn.db.insert(calendarMarker).values({
      id: 'cm-1',
      projectId: 'p1',
      date: PAST_THE_WEEKEND,
      name: 'Client demo',
      color: '#3b82f6',
      createdAt: 1_756_000_000,
    });

    const rows = await conn.db.select().from(calendarMarker);

    expect(rows).toEqual([
      {
        id: 'cm-1',
        projectId: 'p1',
        date: PAST_THE_WEEKEND,
        name: 'Client demo',
        color: '#3b82f6',
        createdAt: 1_756_000_000,
      },
    ]);
  });

  it('stores a chosen colour as null when it is automatic', async () => {
    // `NULL` means automatic, and the column is nullable precisely so that a
    // marker whose colour was never chosen stays distinguishable from one that
    // was. Materialising the derived value here would freeze today's palette
    // into storage — design.md §5.
    await conn.db.insert(calendarMarker).values({
      id: 'cm-auto',
      projectId: 'p1',
      date: PAST_THE_WEEKEND,
      name: 'Automatic',
      color: null,
      createdAt: 1_756_000_001,
    });

    const rows = await conn.db.select().from(calendarMarker);

    expect(rows[0]?.color).toBeNull();
  });

  it('accepts a second marker on the same date', async () => {
    // **The one property of this table nothing else in the change can
    // observe.** A demo and an external deadline can land on one day, and the
    // render carries the stacked case. The round-trip above passes with the
    // index made unique, so this is the assertion that holds it open.
    //
    // Proof: with `index('calendar_marker_project_date')` in `schema.ts` and the
    // `CREATE INDEX` in `20260905090000_add_calendar_marker/migration.sql` both
    // replaced by a `uniqueIndex` / `CREATE UNIQUE INDEX`, this case fails on
    // the second insert with `UNIQUE constraint failed:
    // calendar_marker.project_id, calendar_marker.date`, and every other case in
    // this file still passes. Named as a replacement rather than as "a
    // `.unique()` added to the index" because drizzle's `IndexBuilder` has no
    // such method and that mutation would not compile.
    await conn.db.insert(calendarMarker).values({
      id: 'cm-demo',
      projectId: 'p1',
      date: PAST_THE_WEEKEND,
      name: 'Client demo',
      color: null,
      createdAt: 1_756_000_000,
    });
    await conn.db.insert(calendarMarker).values({
      id: 'cm-deadline',
      projectId: 'p1',
      date: PAST_THE_WEEKEND,
      name: 'Grant deadline',
      color: null,
      createdAt: 1_756_000_001,
    });

    const rows = await conn.db.select().from(calendarMarker).orderBy(asc(calendarMarker.createdAt));

    expect(rows.map((r) => r.name)).toEqual(['Client demo', 'Grant deadline']);
  });

  it('stores the date as the exact IsoDate text it was given', async () => {
    // `date` is `text`, and the text that goes in is the text that comes out —
    // no time component appears, no zone is applied, and nothing is reparsed. A
    // marker means one absolute calendar day, so a storage layer that
    // round-tripped it through a Date would be free to move it across a zone
    // boundary.
    await conn.db.insert(calendarMarker).values({
      id: 'cm-exact',
      projectId: 'p1',
      date: PAST_THE_WEEKEND,
      name: 'Exactly this day',
      color: null,
      createdAt: 1_756_000_000,
    });

    const rows = await conn.db.select().from(calendarMarker);

    expect(rows[0]?.date).toBe('2026-08-24');
  });
});
