import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { projectRow } from '../testing/project-fixture';
import { CapacityRepository } from './capacity';
import { openDatabase, openDrizzle } from './db';
import { DirectoryRepository } from './directory';
import { OPEN } from './gate';
import type { Project, WriteStamp } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** The stamp every write here carries; `owner` is the account the setup creates first. */
const wrote: WriteStamp = { at: 1, by: 'owner' };

/**
 * The one thing this file exists to pin: `slotsFor` answers **one project's own
 * numbers**, and the global column it replaced is read nowhere.
 *
 * That sounds like it needs no test until you notice the one wrong answer most
 * likely to be written by accident — `serviceTeam.size`, the fallback
 * `capacity-per-project` refuses — passes every other test in the suite. The
 * migration seeds every project from that column, so a `slotsFor` reading it
 * back agrees with the seeding on the day the migration runs and disagrees with
 * every write afterwards. See `design.md` D7's last paragraph.
 */
describe('a project’s capacity for a team', () => {
  let dir: string;
  /** The raw handle, for the two claims that are about rows rather than about the store. */
  let sqlite: Database;
  let capacity: CapacityRepository;

  const project = (id: string, name: string): Project =>
    projectRow({
      id,
      name,
      ownerId: 'owner',
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-capacity-'));
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const db = openDrizzle(path);
    sqlite = openDatabase(path);
    capacity = new CapacityRepository(db, OPEN);
    await new UserRepository(db, OPEN).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    const projects = new ProjectRepository(db, OPEN);
    await projects.create(project('p1', 'Rewire the shed'), [], wrote);
    await projects.create(project('p2', 'Reroof the barn'), [], wrote);
    const directory = new DirectoryRepository(db, OPEN);
    // Both created unsized, because a global size is read by nothing now — and a
    // fixture that seeded one would be handing the fallback a way to look right.
    // `addTeam` has no size to give them any more; the one test below that needs
    // a number in that column writes it as SQL, on purpose.
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    await directory.addTeam({ id: 't-backend', name: 'Backend' }, wrote);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers one project’s own numbers, and never another’s', async () => {
    // Proof: `slotsFor` pointed at `service_team.size` instead — the fallback
    // this change refuses, and the one wrong answer the seeding makes look right
    // — with the fixture's two teams globally sized 2 and 9 to match `p1`. Three
    // tests went red, this one on `p2`'s map: `"t-platform" => 5` became
    // `"t-platform" => 2, "t-backend" => 9`, so the project that asked for five
    // was handed the *other* project's two numbers. Watched 2026-08-13.
    await capacity.set('p1', 't-platform', 2, wrote);
    await capacity.set('p1', 't-backend', 9, wrote);
    await capacity.set('p2', 't-platform', 5, wrote);

    expect(await capacity.slotsFor('p1')).toEqual(
      new Map([
        ['t-platform', 2],
        ['t-backend', 9],
      ]),
    );
    expect(await capacity.slotsFor('p2')).toEqual(new Map([['t-platform', 5]]));
  });

  it('never falls back to a globally sized team nobody stated per project', async () => {
    // **Dany's second sentence, and the one fault the rest of this file cannot
    // see.** The test above refuses the *replacement* — `slotsFor` reading
    // `service_team.size` instead of the per-project row. The fault a maintainer
    // actually writes is the *addition*: keep the per-project read and fall back
    // to the global number for a pair with no row, which is the design D1
    // rejects by name and the first thing anybody proposes the day a new
    // project schedules unconstrained.
    //
    // Every other fixture in this suite creates its teams unsized on purpose, so
    // a fallback to a `NULL` adds nothing to the map and the whole suite stays
    // green with it in. That care is exactly what makes the gap: the number has
    // to be written into the retired column for the fallback to have anything to
    // reach for, and this is the only test that writes one.
    //
    // Proof, and the reason this test exists: the fallback put back in
    // `slotsFor` — the per-project rows, then `serviceTeam.size` for every pair
    // without one — left **693 pass, 0 fail** across the whole of be-01 while
    // this test was missing. With it the same injection is **695 pass, 1 fail**
    // and the one is this: `expect(received).toBe(expected) / Expected: false /
    // Received: true`, on a team `p1` never stated. Watched 2026-08-13.
    sqlite.run("UPDATE service_team SET size = 7 WHERE id = 't-platform'");
    await capacity.set('p1', 't-backend', 3, wrote);

    const slots = await capacity.slotsFor('p1');

    // Stated for nothing on this plan, so absent — not 7, and not present as a
    // `null` either.
    expect(slots.has('t-platform')).toBe(false);
    expect(slots).toEqual(new Map([['t-backend', 3]]));
    // And a project that has stated nothing at all is bounded by nothing at all,
    // which is D1 case 2 said as a map: a plan created after the migration is
    // unconstrained rather than quietly inheriting numbers nobody typed for it.
    expect(await capacity.slotsFor('p2')).toEqual(new Map());
  });

  it('leaves a team it has stated nothing about out of the map entirely', async () => {
    // Absent, not `null` and not a zero: the engine reads an absent key as
    // unconstrained, which is what unstated means. A `null` in the map would be
    // a value every caller had to test for, and a `0` would be a pool of no
    // slots — a plan of `Infinity` dates.
    await capacity.set('p1', 't-platform', 3, wrote);

    const slots = await capacity.slotsFor('p1');

    expect(slots.has('t-backend')).toBe(false);
    expect([...slots.keys()]).toEqual(['t-platform']);
  });

  it('has nothing to say about a project nobody has stated anything for', async () => {
    expect(await capacity.slotsFor('p2')).toEqual(new Map());
    expect(await capacity.listFor('p2')).toEqual([]);
  });

  it('replaces the number rather than adding a second one', async () => {
    // The primary key on the pair, through the write: two numbers for one pair
    // would be two answers to one question, and the reader would get whichever
    // the query planner handed back first.
    await capacity.set('p1', 't-platform', 2, wrote);
    await capacity.set('p1', 't-platform', 7, wrote);

    expect(await capacity.listFor('p1')).toEqual([{ serviceTeamId: 't-platform', size: 7 }]);
  });

  it('clears to unstated by deleting the row, not by storing a null', async () => {
    await capacity.set('p1', 't-platform', 2, wrote);

    expect(await capacity.set('p1', 't-platform', null, wrote)).toEqual({ ok: true });

    expect(await capacity.listFor('p1')).toEqual([]);
    // Read off the table itself: the claim is about the absence of a row, and a
    // stored null would satisfy every assertion above it.
    const rows = sqlite
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project_team_capacity')
      .get();
    expect(rows?.n).toBe(0);
  });

  it('clearing what was never stated changes nothing and is not an error', async () => {
    // Idempotent by shape rather than by asking: a client that clears a box
    // twice, or clears one that was already empty, has not made a mistake.
    expect(await capacity.set('p1', 't-platform', null, wrote)).toEqual({ ok: true });
    expect(await capacity.listFor('p1')).toEqual([]);
  });

  it('refuses a project or a team that is not there, and writes nothing', async () => {
    // Both ids are checked inside the write's own transaction. The foreign keys
    // would refuse this anyway — with a `SQLiteError` out of a `run`, which is
    // an unknown at the service boundary rather than a modeled 404.
    //
    // Proof: both existence reads deleted, leaving the constraints as the only
    // guard, and this failed with an uncaught `SQLiteError: FOREIGN KEY
    // constraint failed` out of the insert — the unknown a caller cannot be
    // answered with, where a modeled `not_found` was owed. Watched 2026-08-13.
    expect(await capacity.set('nope', 't-platform', 3, wrote)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await capacity.set('p1', 'nope', 3, wrote)).toEqual({ ok: false, reason: 'not_found' });
    expect(await capacity.listFor('p1')).toEqual([]);
  });

  it('lists in team-id order, so the payload does not reshuffle between reads', async () => {
    await capacity.set('p1', 't-platform', 2, wrote);
    await capacity.set('p1', 't-backend', 4, wrote);

    expect(await capacity.listFor('p1')).toEqual([
      { serviceTeamId: 't-backend', size: 4 },
      { serviceTeamId: 't-platform', size: 2 },
    ]);
  });

  it('goes with the project it belongs to, and with the team it names', async () => {
    // The cascades, asserted by using them rather than by reading the schema —
    // and they are the ones that keep the outgoing release's own `DELETE`s
    // working mid-swap against a table it knows nothing about.
    await capacity.set('p1', 't-platform', 2, wrote);
    await capacity.set('p2', 't-platform', 2, wrote);

    sqlite.run("DELETE FROM project WHERE id = 'p1'");
    expect(await capacity.listFor('p1')).toEqual([]);
    expect(await capacity.listFor('p2')).toEqual([{ serviceTeamId: 't-platform', size: 2 }]);

    sqlite.run("DELETE FROM service_team WHERE id = 't-platform'");
    expect(await capacity.listFor('p2')).toEqual([]);
  });
});
