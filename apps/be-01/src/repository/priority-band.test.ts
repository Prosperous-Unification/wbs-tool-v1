import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PRIORITY_BANDS, type PriorityBand } from '@wbs/domain';
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import type { Project } from './index';
import { runMigrations } from './migrate';
import { PriorityBandRepository } from './priority-band';
import { ProjectRepository } from './project';
import { UserRepository } from './user';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** A ladder that is nothing like the default one, so "read it back" cannot pass by accident. */
const RECUT: readonly PriorityBand[] = [
  { startsAt: 1, label: 'Blocker', defaultValue: 5 },
  { startsAt: 16, label: 'Urgent', defaultValue: 20 },
  { startsAt: 31, label: 'Normal', defaultValue: 40 },
  { startsAt: 71, label: 'Someday', defaultValue: 75 },
  { startsAt: 200, label: 'Never', defaultValue: 900 },
];

/**
 * What one project calls its priority numbers, against real SQLite.
 *
 * Two things here are the change rather than an implementation detail of it, and
 * both are the read: a project holding **no rows** answers the default ladder,
 * and a project holding rows answers **its own**. Either alone is a passing test
 * for a broken store — an unconditional default passes the first, and a store
 * with no fallback at all passes the second — so each is watched against the
 * other's injection.
 */
describe('a project’s priority ladder', () => {
  let dir: string;
  /** The raw handle, for the two claims that are about rows rather than about the store. */
  let sqlite: Database;
  let bands: PriorityBandRepository;

  const project = (id: string, name: string): Project => ({
    id,
    name,
    ownerId: 'owner',
    restricted: false,
    estimateMethod: 'pert',
    startDate: null,
    revision: 0,
    createdAt: 1,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-priority-band-'));
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const db = openDrizzle(path);
    sqlite = openDatabase(path);
    bands = new PriorityBandRepository(db);
    await new UserRepository(db).create({
      id: 'owner',
      username: 'owner',
      passwordHash: 'x',
      createdAt: 1,
    });
    const projects = new ProjectRepository(db);
    // Created **through the repository**, which is the release under test — so
    // neither project is seeded by the migration and both are in the state every
    // project made after the deploy is in. That is the state the read's default
    // arm exists for, and a fixture that hand-seeded rows would hide it.
    await projects.create(project('p1', 'Rewire the shed'), []);
    await projects.create(project('p2', 'Reroof the barn'), []);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers the default ladder for a project holding no rows of its own', async () => {
    // The state every project created after the migration is in — including one
    // created by the outgoing release during a blue/green swap, which is the
    // window this arm exists to close. `DEFAULT_PRIORITY_BANDS` is a constant in
    // the source and not a number anybody typed, which is why reading it back is
    // not the fallback `capacity-per-project` D1 refuses. design.md D2.
    //
    // Proof: the `rows.length === 0` arm deleted so the query's answer is
    // returned bare, and this failed on `expected [] to have a length of 5` — a
    // plan whose every priority resolves to no label at all.
    expect(await bands.listFor('p1')).toEqual([...DEFAULT_PRIORITY_BANDS]);
    // No rows were written to get that answer: the read is a fallback, not a
    // lazy seeding, so two clients reading the same unconfigured project do not
    // race to insert.
    expect(
      sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project_priority_band').get()?.n,
    ).toBe(0);
  });

  it('answers a project’s own ladder rather than the default one', async () => {
    // Proof: the `length === 0` arm replaced by an unconditional
    // `DEFAULT_PRIORITY_BANDS`, and this failed on
    // `Expected: "Blocker" / Received: "Critical"` — a project that had re-cut
    // its ladder handed back the five it replaced. Watched 2026-08-14.
    expect(await bands.replace('p1', RECUT)).toEqual({ ok: true });

    expect(await bands.listFor('p1')).toEqual([...RECUT]);
    // And the other project is untouched, which is the whole of "per project":
    // one plan's vocabulary is not another's.
    expect(await bands.listFor('p2')).toEqual([...DEFAULT_PRIORITY_BANDS]);
  });

  it('answers in rank order, whatever order the rows come back in', async () => {
    await bands.replace('p1', RECUT);
    // The rows written out of order behind the store's back, which is the one
    // way to tell an `ORDER BY` from a query planner that happens to agree with
    // it. Rank 0 is the most important rung on every face, and a list in
    // insertion order would colour a plan by whichever row SQLite reached first.
    sqlite.run('DELETE FROM project_priority_band WHERE project_id = ?', ['p1']);
    for (const rank of [3, 0, 4, 2, 1]) {
      const band = RECUT.at(rank);
      if (band === undefined) throw new Error(`no band at rank ${String(rank)}`);
      sqlite.run(
        'INSERT INTO project_priority_band (project_id, rank, starts_at, label, default_value) VALUES (?, ?, ?, ?, ?)',
        ['p1', rank, band.startsAt, band.label, band.defaultValue],
      );
    }

    expect((await bands.listFor('p1')).map((band) => band.label)).toEqual([
      'Blocker',
      'Urgent',
      'Normal',
      'Someday',
      'Never',
    ]);
  });

  it('replaces the whole ladder rather than merging into it', async () => {
    // Delete-then-insert, and the delete is load-bearing. Proof: the `tx.delete`
    // struck, and this failed with `UNIQUE constraint failed:
    // project_priority_band.project_id, project_priority_band.rank` — five rows
    // written over five that were never taken away. Watched 2026-08-14.
    await bands.replace('p1', RECUT);
    await bands.replace('p1', DEFAULT_PRIORITY_BANDS);

    expect(await bands.listFor('p1')).toEqual([...DEFAULT_PRIORITY_BANDS]);
    expect(
      sqlite
        .query<
          { n: number },
          []
        >('SELECT COUNT(*) AS n FROM project_priority_band WHERE project_id = ?')
        .get('p1')?.n,
    ).toBe(5);
  });

  it('trims a name on the way in, so two spellings of one word are one', async () => {
    await bands.replace('p1', [{ ...RECUT[0], label: '  Blocker  ' }, ...RECUT.slice(1)]);
    expect((await bands.listFor('p1')).at(0)?.label).toBe('Blocker');
  });

  it('refuses a project that is not there, and writes nothing', async () => {
    // Proof: the existence read deleted from the transaction, leaving the foreign
    // key as the only guard, and this failed with an uncaught `SQLiteError:
    // FOREIGN KEY constraint failed` where a modeled `not_found` was owed — an
    // unknown at the service boundary rather than the 404 a caller can act on.
    // Watched 2026-08-14.
    expect(await bands.replace('nobody-holds-this', RECUT)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(
      sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project_priority_band').get()?.n,
    ).toBe(0);
  });

  it('loses its ladder when the project goes, by the cascade and nothing else', async () => {
    // The cascade is the only mechanism: no application code deletes these rows
    // on the way to deleting a project, and the outgoing release's plain
    // `DELETE FROM project` knows nothing about this table. Proof: with
    // `ON DELETE CASCADE` off the migration, `lets the outgoing release keep
    // writing projects against the migrated schema` in `migrate.test.ts` fails on
    // `FOREIGN KEY constraint failed`. Watched 2026-08-14.
    await bands.replace('p1', RECUT);
    sqlite.run('DELETE FROM project WHERE id = ?', ['p1']);

    expect(
      sqlite
        .query<
          { n: number },
          []
        >('SELECT COUNT(*) AS n FROM project_priority_band WHERE project_id = ?')
        .get('p1')?.n,
    ).toBe(0);
  });
});
