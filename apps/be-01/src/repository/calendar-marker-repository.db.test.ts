import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { automaticColor } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { projectRow } from '../testing/project-fixture';
import { CalendarMarkerRepository } from './calendar-marker';
import type { Connection } from './db';
import { openConnection } from './db';
import type { CalendarMarker, WriteStamp } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

/** `calendar-marker.db.test.ts`'s constant, for its reason: not a workday number. */
const PAST_THE_WEEKEND = '2026-08-24';

/**
 * The two ids the ordering case turns on, and they are not arbitrary.
 *
 * They are **fixed in the reverse of their lexical order and inserted in that
 * reverse order**, so insertion order and lexical order disagree: a list that
 * came back in insertion order is a different sequence from the asserted one,
 * which is what lets the `id` key be watched failing. Two reads of a tied pair
 * can both come back in insertion order with the key gone, so an
 * equality-of-two-reads assertion would pass against the fault whenever
 * insertion order happened to match.
 *
 * They also land in **different palette buckets** — `TIED_LEXICALLY_FIRST` is
 * bucket 7 (`magenta`) and `TIED_INSERTED_FIRST` bucket 6 (`violet`) — so the
 * same-date distinctness assertion below is not passing by luck. The palette
 * holds eight fills, so an unpinned pair collides one time in eight and a
 * negative that is green one run in eight is not a negative.
 */
const TIED_LEXICALLY_FIRST = 'b1000000-0000-4000-8000-000000000001';
const TIED_INSERTED_FIRST = 'f1000000-0000-4000-8000-000000000002';
/** The rename-stability marker. Bucket 0, `crimson`. */
const RENAMED = 'c1000000-0000-4000-8000-000000000003';

/**
 * A fixed clock, as a constant rather than an injected function: the repository
 * layer has no clock of its own, so every instant a marker carries arrived as an
 * argument and a test drives time by choosing one.
 *
 * The two tied markers share it, which is the tie the third ordering key exists
 * to break.
 */
const AT = 1_700_000_000_000;

function marker(overrides: Partial<CalendarMarker> = {}): CalendarMarker {
  return {
    id: crypto.randomUUID(),
    projectId: 'p1',
    date: PAST_THE_WEEKEND,
    name: 'Site visit',
    color: null,
    createdAt: AT,
    ...overrides,
  };
}

/**
 * `CalendarMarkerRepository` against real SQLite (task 4.1, storage half).
 *
 * **Real SQLite and not a fake store**, and for one case in particular: the
 * total ordering's third key is the *database's* tie-break, so a stub that
 * sorted in TypeScript would prove the test's own `sort` rather than the
 * `ORDER BY` that ships. The refusals are here for the same reason — an absent
 * project is refused by a read inside the write's transaction, and what it is
 * being kept from is a foreign key that throws.
 *
 * Two projects, because project isolation is a claim about a query and one
 * project cannot separate it from its wrong versions.
 */
describe('CalendarMarkerRepository', () => {
  let dir: string;
  let conn: Connection;
  let markers: CalendarMarkerRepository;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-calendar-marker-repo-'));
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const seed = openConnection(path);
    await new UserRepository(seed.db).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    const projects = new ProjectRepository(seed.db);
    await projects.create(
      projectRow({ id: 'p1', name: 'Rewire the shed', ownerId: 'owner' }),
      [{ id: 'st-1', projectId: 'p1', name: 'Build', position: 10 }],
      wrote,
    );
    await projects.create(
      projectRow({ id: 'p2', name: 'Re-roof the barn', ownerId: 'owner' }),
      [{ id: 'st-2', projectId: 'p2', name: 'Strip', position: 10 }],
      wrote,
    );
    seed.close();
    conn = openConnection(path);
    markers = new CalendarMarkerRepository(conn.db);
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a marker through create and list', async () => {
    const made = marker({ id: RENAMED, name: 'Council inspection' });
    const written = await markers.create(made);

    expect(written).toEqual({ ok: true, marker: made });
    expect(await markers.listFor('p1')).toEqual([made]);
  });

  it('stores a date outside the plan horizon exactly as given', async () => {
    // Well past any bar this project's plan reaches. A marker is not a work
    // item and schedules nothing, so there is no horizon for it to be inside.
    const made = marker({ date: '2031-12-31', name: 'Guarantee expires' });
    await markers.create(made);

    const [read] = await markers.listFor('p1');
    expect(read.date).toBe('2031-12-31');
  });

  it('orders a tie on (date, created_at) by id', async () => {
    // Inserted in the reverse of their lexical order, at one instant, on one
    // date: `(date, created_at)` cannot separate them and insertion order is
    // the wrong answer.
    await markers.create(marker({ id: TIED_INSERTED_FIRST, name: 'Second' }));
    await markers.create(marker({ id: TIED_LEXICALLY_FIRST, name: 'First' }));

    const once = await markers.listFor('p1');
    const twice = await markers.listFor('p1');

    // The explicit sequence, twice — not merely that the two reads agree. Two
    // reads of a tied pair can agree with the `id` key gone.
    expect(once.map((m) => m.id)).toEqual([TIED_LEXICALLY_FIRST, TIED_INSERTED_FIRST]);
    expect(twice.map((m) => m.id)).toEqual([TIED_LEXICALLY_FIRST, TIED_INSERTED_FIRST]);
  });

  it('orders by date before anything else', async () => {
    await markers.create(marker({ id: TIED_INSERTED_FIRST, date: '2026-09-07' }));
    await markers.create(marker({ id: TIED_LEXICALLY_FIRST, date: '2026-08-24' }));

    expect((await markers.listFor('p1')).map((m) => m.date)).toEqual(['2026-08-24', '2026-09-07']);
  });

  it('refuses a marker on a project nothing holds, and writes nothing', async () => {
    const written = await markers.create(marker({ projectId: 'no-such-project' }));

    expect(written).toEqual({ ok: false, reason: 'not_found' });
    expect(await markers.listFor('no-such-project')).toEqual([]);
  });

  it('refuses a repeated id and leaves the stored marker untouched', async () => {
    const first = marker({ id: RENAMED, name: 'Council inspection', date: PAST_THE_WEEKEND });
    await markers.create(first);

    const again = await markers.create(
      marker({
        id: RENAMED,
        name: 'Something else entirely',
        date: '2026-09-07',
        color: '#f70100',
      }),
    );

    expect(again).toEqual({ ok: false, reason: 'taken' });
    // The whole row, not just the status: an upsert answers a duplicate-id
    // assertion that only reads the status, having already destroyed the row.
    expect(await markers.listFor('p1')).toEqual([first]);
  });

  it('renames a marker without disturbing its date or its colour', async () => {
    const made = marker({ id: RENAMED, name: 'Council inspection', color: '#0386a5' });
    await markers.create(made);

    const written = await markers.rename('p1', RENAMED, 'Council inspection, rescheduled');

    expect(written).toEqual({
      ok: true,
      marker: { ...made, name: 'Council inspection, rescheduled' },
    });
    expect(await markers.listFor('p1')).toEqual([
      { ...made, name: 'Council inspection, rescheduled' },
    ]);
  });

  it("keeps an automatic marker's colour across a rename", async () => {
    // Slice 3.1(b)'s oracle, and it cannot live in `marker-color.test.ts`:
    // `automaticColor(markerId)` never sees a name, so the fault that keys on
    // `marker.name` is only reachable where a marker is actually renamed.
    await markers.create(marker({ id: RENAMED, name: 'Council inspection' }));
    const before = automaticColor((await markers.listFor('p1'))[0].id);

    await markers.rename('p1', RENAMED, 'Council inspection, rescheduled');
    const after = automaticColor((await markers.listFor('p1'))[0].id);

    expect(after).toBe(before);
    expect(after).toBe('#f70100');
  });

  it('gives two markers on one date different automatic colours', async () => {
    // Slice 3.1(c)'s oracle, for 3.1(b)'s reason: `automaticColor` never sees a
    // date either, so the fault that keys on `marker.date` needs two markers
    // sharing one.
    await markers.create(marker({ id: TIED_INSERTED_FIRST }));
    await markers.create(marker({ id: TIED_LEXICALLY_FIRST }));

    const [first, second] = await markers.listFor('p1');
    expect(first.date).toBe(second.date);
    expect(automaticColor(first.id)).not.toBe(automaticColor(second.id));
  });

  it('sets a custom colour and clears it back to automatic', async () => {
    const made = marker({ id: RENAMED });
    await markers.create(made);

    expect(await markers.recolor('p1', RENAMED, '#0386a5')).toEqual({
      ok: true,
      marker: { ...made, color: '#0386a5' },
    });
    expect((await markers.listFor('p1'))[0]?.color).toBe('#0386a5');

    // `null` and not a resolved hex: automatic has one spelling, and it is the
    // absence of one.
    expect(await markers.recolor('p1', RENAMED, null)).toEqual({ ok: true, marker: made });
    expect((await markers.listFor('p1'))[0]?.color).toBeNull();
  });

  it('removes a marker, and refuses to remove it twice', async () => {
    const made = marker({ id: RENAMED });
    await markers.create(made);

    expect(await markers.remove('p1', RENAMED)).toEqual({ ok: true, marker: made });
    expect(await markers.listFor('p1')).toEqual([]);
    expect(await markers.remove('p1', RENAMED)).toEqual({ ok: false, reason: 'not_found' });
  });

  it("answers not_found for another project's marker, and never touches it", async () => {
    // `not_found` rather than `forbidden`, because the caller may not learn it
    // exists — the refusal table's own distinction.
    const made = marker({ id: RENAMED, projectId: 'p2', name: 'Scaffolding up' });
    await markers.create(made);

    expect(await markers.rename('p1', RENAMED, 'Mine now')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await markers.recolor('p1', RENAMED, '#f70100')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await markers.remove('p1', RENAMED)).toEqual({ ok: false, reason: 'not_found' });

    expect(await markers.listFor('p1')).toEqual([]);
    expect(await markers.listFor('p2')).toEqual([made]);
  });
});
