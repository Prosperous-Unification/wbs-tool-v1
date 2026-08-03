import { Database } from 'bun:sqlite';

const BUSY_TIMEOUT_MS = 5000;

/**
 * The only place a SQLite connection is opened. An ESLint rule enforces that
 * (`bun:sqlite` is restricted everywhere else under `apps/be-01/src`), because
 * two of the three pragmas below are per-*connection* rather than stored in
 * the database file: a second connection opened directly with `new Database()`
 * silently runs with `busy_timeout=0` and `foreign_keys=OFF`.
 *
 * Blue/green runs two be-01 processes against one database file during a swap.
 * Without WAL, a writer takes an EXCLUSIVE lock that blocks readers too, and
 * with the default busy_timeout of 0 the other process fails instantly rather
 * than waiting. Both pragmas are load-bearing for zero-downtime deploys.
 */
export function openDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  // `run` rather than the deprecated `exec`; behavior is identical for these
  // single-statement PRAGMAs.
  db.run('PRAGMA journal_mode = WAL;');
  db.run(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)};`);
  db.run('PRAGMA foreign_keys = ON;');
  // Asserted here, not left to the caller. Setting a PRAGMA is a request, not
  // a guarantee — SQLite reports the mode it actually adopted and does not
  // error when it declines, which is why `:memory:` quietly stays on
  // journal_mode=memory. Verifying at the point of opening also means the
  // check cannot be skipped by forgetting to call it: until now `assertPragmas`
  // had exactly one caller (repository/migrate.ts), so every other connection
  // would have been unverified.
  assertPragmas(db);
  return db;
}

/** Fails loudly if the pragmas were not actually adopted. */
export function assertPragmas(db: Database): void {
  const journal = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode;').get();
  const mode = journal?.journal_mode.toLowerCase();
  if (mode !== 'wal') {
    throw new Error(`expected journal_mode=wal, got ${mode ?? 'unknown'}`);
  }
  const busy = db.query<{ timeout: number }, []>('PRAGMA busy_timeout;').get();
  if (busy === null || busy.timeout < BUSY_TIMEOUT_MS) {
    throw new Error(
      `expected busy_timeout>=${String(BUSY_TIMEOUT_MS)}, got ${String(busy?.timeout)}`,
    );
  }
}
