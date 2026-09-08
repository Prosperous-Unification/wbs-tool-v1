import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { rowsChanged } from './changes';
import { openDrizzle } from './db';
import { runMigrations } from './migrate';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let db: ReturnType<typeof openDrizzle>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-changes-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Rows to delete, written past the repositories: this is about `changes()`. */
function seedEvents(howMany: number): void {
  for (let at = 0; at < howMany; at += 1) {
    db.run(
      `INSERT INTO event_log (subscription, seq, message, created_at)
       VALUES ('project:a', ${String(at)}, '{}', ${String(100 + at)})`,
    );
  }
}

/**
 * `changes()` belongs to a **connection**, not to a statement — which is the
 * whole reason the two retention sweeps wrap their delete and their count in one
 * transaction.
 *
 * `PlanEventRepository.pruneOlderThan` and `DrizzleEventLogStore.pruneBeyond`
 * both `await` between the delete and the count until 2026-09-02, and neither
 * holds the write lock (they are the retention timer's, not a request's). A plan
 * command landing in that window hands its own row count to the sweep's log
 * line: not a corrupt database, but a number in an operator's log that is about
 * a different statement.
 *
 * The race itself cannot be injected here, and that is worth saying plainly
 * rather than leaving a reader to assume it was tried: it needs a second writer
 * on **one** connection, and be-01 holds exactly one and drives it
 * synchronously. What is asserted instead is the mechanism the race exploits —
 * a second write really does replace the answer — which is what makes the
 * transaction load-bearing rather than decorative.
 */
describe('how many rows the last statement changed', () => {
  it('answers the write that ran most recently, not the one a caller means', () => {
    seedEvents(5);

    db.run(`DELETE FROM event_log WHERE seq < 3`);
    db.run(`INSERT INTO event_log (subscription, seq, message, created_at)
            VALUES ('project:b', 0, '{}', 200)`);

    // Three rows went and one arrived, and `changes()` says **one**: it is not
    // the delete's count any more.
    expect(rowsChanged(db, 'a probe')).toBe(1);
  });

  it('answers a delete inside one transaction, whatever ran before it', () => {
    seedEvents(5);
    db.run(`INSERT INTO event_log (subscription, seq, message, created_at)
            VALUES ('project:b', 0, '{}', 200)`);

    const deleted = db.transaction((tx) => {
      tx.run(`DELETE FROM event_log WHERE subscription = 'project:a'`);
      return rowsChanged(tx, 'deleting from event_log');
    });

    expect(deleted).toBe(5);
  });

  it('names the write in its message, so a throw says which sweep it was', () => {
    // The message is the only thing a reader gets: `SELECT changes()` cannot
    // answer no row, so this branch is unreachable and the wording is what
    // makes it worth having.
    expect(() => rowsChanged({ all: () => [] }, 'pruning event_log')).toThrow(
      /answered no row after pruning event_log/,
    );
  });
});
