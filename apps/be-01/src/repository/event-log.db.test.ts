import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type Drizzle, openDrizzle } from './db';
import { DrizzleEventLogRepo } from './event-log';
import { OPEN } from './gate';
import { runMigrations } from './migrate';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let db: Drizzle;
let repo: DrizzleEventLogRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-event-log-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);
  repo = new DrizzleEventLogRepo(db, OPEN);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DrizzleEventLogRepo.latestSeq', () => {
  it('reports the sequence of the most recent event', async () => {
    await repo.recordEvent('project:a', { n: 1 }, 100);
    await repo.recordEvent('project:a', { n: 2 }, 200);
    await repo.recordEvent('project:a', { n: 3 }, 300);

    expect(await repo.latestSeq('project:a')).toBe(2);
  });

  it('reports -1 for a subscription that has recorded nothing', async () => {
    expect(await repo.latestSeq('project:never-touched')).toBe(-1);
  });

  it('does not read another subscription’s events', async () => {
    await repo.recordEvent('project:a', { n: 1 }, 100);
    await repo.recordEvent('project:b', { n: 1 }, 100);
    await repo.recordEvent('project:b', { n: 2 }, 200);

    expect(await repo.latestSeq('project:a')).toBe(0);
  });

  it('survives retention removing the earlier events', async () => {
    await repo.recordEvent('project:a', { n: 1 }, 100);
    await repo.recordEvent('project:a', { n: 2 }, 200);
    await repo.pruneBeyond(1);

    // The sequence is the stream's position, not a count of what is retained:
    // a client resuming after a prune must still be told where the stream is.
    expect(await repo.latestSeq('project:a')).toBe(1);
    expect(await repo.oldestSeq('project:a')).toBe(1);
  });
});

/**
 * The two claims `EventSequencer`'s own suite made until 2026-09-02, moved
 * here with the class deleted: they were always this repository's, asserted
 * through a pass-through that added a clock read and nothing else.
 */
describe('DrizzleEventLogRepo.recordEvent', () => {
  it('numbers each subscription from its own zero', async () => {
    const a1 = await repo.recordEvent('project:a', { v: 1 }, 1_000);
    const a2 = await repo.recordEvent('project:a', { v: 2 }, 1_000);
    const b1 = await repo.recordEvent('project:b', { v: 1 }, 1_000);

    expect(a1.seq).toBe(0);
    expect(a2.seq).toBe(1);
    expect(b1.seq).toBe(0);
  });

  it('stores the message and the instant it was handed', async () => {
    await repo.recordEvent('project:a', { hello: 'world' }, 5_000);

    expect(await repo.rangeSince('project:a', -1)).toEqual([
      { subscription: 'project:a', seq: 0, message: { hello: 'world' }, createdAt: 5_000 },
    ]);
  });

  it('writes inside the caller transaction, so its rollback removes the event and sequence', async () => {
    expect(() =>
      db.transaction((tx) => {
        repo.recordEventIn(tx, 'project:a', { hello: 'world' }, 5_000);
        throw new Error('injected crash');
      }),
    ).toThrow('injected crash');

    expect(await repo.rangeSince('project:a', -1)).toEqual([]);
    expect(await repo.latestSeq('project:a')).toBe(-1);
  });

  it('uses the transaction it was handed rather than opening one on the repository handle', async () => {
    const callerPath = join(dir, 'caller.db');
    runMigrations(callerPath, FOLDER);
    const callerDb = openDrizzle(callerPath);
    const callerRepo = new DrizzleEventLogRepo(callerDb, OPEN);

    callerDb.transaction((tx) => {
      repo.recordEventIn(tx, 'project:a', { hello: 'caller' }, 6_000);
    });

    // Proof: replacing `tx.run`/`tx.all` in `recordEventIn` with `this.db`
    // writes this event into `repo` instead, reversing both assertions.
    expect(await repo.rangeSince('project:a', -1)).toEqual([]);
    expect(await callerRepo.rangeSince('project:a', -1)).toEqual([
      { subscription: 'project:a', seq: 0, message: { hello: 'caller' }, createdAt: 6_000 },
    ]);
  });
});
