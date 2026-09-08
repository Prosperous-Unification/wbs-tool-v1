import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { projectRow } from '../testing/project-fixture';
import type { Connection } from './db';
import { openConnection, refuseToWaitForWriteLock } from './db';
import { OPEN } from './gate';
import type { WriteStamp } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import type { SavedPlanHoldingRow, SavedPlanWrite } from './saved-plan';
import { SavedPlanRepository } from './saved-plan';
import { savedPlan } from './schema';
import { UserRepository } from './user';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

/** A plausible header and one small body. The bytes are not the subject here. */
const record = (id: string): SavedPlanWrite => ({
  id,
  projectId: 'p1',
  name: id,
  createdBy: 'Ada Lovelace',
  createdById: null,
  createdAt: 1_756_000_123,
  input: { schemaVersion: 1, bytes: '{"schemaVersion":1}', sha256: 'a'.repeat(64) },
  schedule: { present: false, absentReason: 'pending' },
});

describe('the quota is read inside the transaction that would write', () => {
  let dir: string;
  let path: string;
  let reader: Connection;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-in-tx-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const seed = openConnection(path);
    await new UserRepository(seed.db, OPEN).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(seed.db, OPEN).create(
      projectRow({ id: 'p1', name: 'Rewire the shed', ownerId: 'owner' }),
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
      wrote,
    );
    seed.close();
    reader = openConnection(path);
  });

  afterEach(() => {
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const plans = (): SavedPlanRepository =>
    new SavedPlanRepository({ openConnection: () => openConnection(path) });

  const headers = () => reader.db.select().from(savedPlan);

  /**
   * A rival save's commit, attempted from a **second** connection.
   *
   * This is the whole test. `Promise.all` over two `save` calls cannot express
   * the race: `bun:sqlite` is synchronous, so the second `BEGIN IMMEDIATE`
   * blocks the only thread that could ever let the first one reach its commit,
   * and the pair deadlocks into a `busy_timeout` rather than interleaving. A
   * rival driven from *inside* the check callback is the same interleaving —
   * "the moment between reading the count and writing the row" — made
   * deterministic and single-threaded.
   *
   * Returns whether SQLite let the rival in.
   */
  const rivalCommits = (id: string): boolean => {
    const rival = openConnection(path);
    try {
      // `busy_timeout` **0**, through the same function the writer itself uses,
      // set after `openConnection`'s assertion rather than instead of it: the
      // refusal under test is the immediate one, and at the connection default
      // of 5 s the wait alone outlives bun's per-test budget. One spelling of
      // the setting, so a rival here fails the way a second save is meant to.
      refuseToWaitForWriteLock(rival.db);
      rival.db
        .insert(savedPlan)
        .values({
          id,
          projectId: 'p1',
          name: id,
          createdBy: 'Rival',
          createdById: null,
          createdAt: 1_756_000_124,
          inputSchemaVersion: 1,
          inputBytes: 19,
          inputSha256: 'b'.repeat(64),
          scheduleSchemaVersion: null,
          scheduleBytes: null,
          scheduleSha256: null,
          scheduleInputSha256: null,
          schedulerAlgorithmId: null,
          scheduleAbsentReason: 'pending',
        })
        .run();
      return true;
    } catch {
      // SQLITE_BUSY: the write lock the save under test is holding. Swallowed
      // rather than rethrown because "the rival could not get in" is the
      // property, and the assertion on the return value is where it is stated.
      return false;
    } finally {
      rival.close();
    }
  };

  it('holds the write lock across the check, so no rival can commit between read and write', async () => {
    // One held, a limit of two: the save under test is the last one that fits,
    // which is the state where a rival slipping in is the difference between
    // holding two and holding three.
    expect(await plans().write(record('sp-held'), () => Promise.resolve(null))).toEqual({
      outcome: 'written',
    });

    // Collected into arrays rather than assigned to nullable locals: an
    // assignment inside a callback stays `null` to TypeScript's narrowing, and
    // the length also says the check ran exactly once.
    const saw: SavedPlanHoldingRow[] = [];
    const rivalGotIn: boolean[] = [];
    const attempt = await plans().write<'over'>(record('sp-last'), (holding) => {
      saw.push(holding);
      // Attempted at exactly the instant the count has been read and the row
      // has not been written yet — the window the bound lives or dies in.
      rivalGotIn.push(rivalCommits('sp-rival'));
      return Promise.resolve(holding.plans + 1 > 2 ? 'over' : null);
    });

    // The count was read once, from inside the transaction, and it saw the held
    // plan.
    expect(saw).toEqual([{ plans: 1, bytes: 19 }]);
    // And SQLite refused the rival, because `BEGIN IMMEDIATE` was already held.
    // This is the SQLite-visible mechanism, not an in-process marker: the rival
    // is a different connection to the same file, which is what blue and green
    // are.
    expect(rivalGotIn).toEqual([false]);
    expect(attempt).toEqual({ outcome: 'written' });

    // Two, not three: the last slot went to the save that held the lock.
    expect((await headers()).map((row) => row.id).sort()).toEqual(['sp-held', 'sp-last']);
  });
});
