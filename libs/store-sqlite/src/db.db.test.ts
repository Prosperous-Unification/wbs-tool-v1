import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { assertPragmas, openDatabase } from './db';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('enables WAL journal mode', () => {
    const db = openDatabase(join(dir, 'test.db'));
    const row = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode;').get();
    expect(row?.journal_mode.toLowerCase()).toBe('wal');
    db.close();
  });

  it('sets a non-zero busy timeout', () => {
    const db = openDatabase(join(dir, 'test.db'));
    const row = db.query<{ timeout: number }, []>('PRAGMA busy_timeout;').get();
    expect(row?.timeout).toBeGreaterThanOrEqual(5000);
    db.close();
  });

  it('assertPragmas passes on a correctly opened database', () => {
    const db = openDatabase(join(dir, 'test.db'));
    expect(() => {
      assertPragmas(db);
    }).not.toThrow();
    db.close();
  });

  // `openDatabase` set the pragmas and `assertPragmas` verified them, but
  // calling the second was left to the caller — and the only caller was
  // repository/migrate.ts. Any future caller that forgot it would get a
  // connection whose pragmas were requested but never confirmed. Asserting
  // inside `openDatabase` makes "set" and "verified" one step.
  //
  // An in-memory database is the concrete case: SQLite silently keeps
  // journal_mode=memory there rather than failing, so `:memory:` used to hand
  // back a connection that looked fine and was not in WAL at all. Tests
  // reaching for `:memory:` are exactly how that would get normalised.
  it('refuses an in-memory database, which cannot honour WAL', () => {
    expect(() => openDatabase(':memory:')).toThrow(/journal_mode/);
  });

  it('assertPragmas throws when WAL is absent', () => {
    const db = openDatabase(join(dir, 'test.db'));
    db.run('PRAGMA journal_mode = DELETE;');
    expect(() => {
      assertPragmas(db);
    }).toThrow(/journal_mode/);
    db.close();
  });

  // The third pragma was set and never verified. It is the one the domain
  // schema leans on: `work_item.project_id` and `estimate.work_item_id` are
  // declared foreign keys, and with enforcement off SQLite parses them and
  // ignores them, so an orphan row inserts cleanly and nothing complains until
  // a read finds a work item whose project does not exist.
  it('assertPragmas throws when foreign keys are not enforced', () => {
    const db = openDatabase(join(dir, 'test.db'));
    db.run('PRAGMA foreign_keys = OFF;');
    expect(() => {
      assertPragmas(db);
    }).toThrow(/foreign_keys/);
    db.close();
  });
});
