// Prints the newest migration currently applied, or `none`. Run by the swap
// executor immediately BEFORE the migrate step, so an abort afterwards knows
// exactly how far to roll back:
//
//   docker exec be-01-<color> bun run src/migrate-status-cli.ts
//
// One line on stdout and nothing else, because the caller parses it. A tier
// that cannot answer must fail the deploy rather than print something the
// abort path would read as "roll back everything".
import { openDatabase } from './repository/db';
import { type AppliedMigration, ROLLBACK_ALL } from './repository/migrate-down';

const dbPath = process.env['DB_PATH'];
if (dbPath === undefined || dbPath === '') throw new Error('DB_PATH must be set');

const db = openDatabase(dbPath);
try {
  // The table does not exist until the first migration runs; that is a real
  // "nothing applied" answer rather than an error.
  const exists = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
    )
    .get();
  if (exists === null) {
    console.log(ROLLBACK_ALL);
  } else {
    const rows = db
      .query<AppliedMigration, []>(
        'SELECT id, hash, created_at, name FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1',
      )
      .all();
    // `rows[0]` is typed non-nullish here (noUncheckedIndexedAccess is off in
    // this repo), so the length check is what actually guards the read.
    console.log(rows.length === 0 ? ROLLBACK_ALL : (rows[0].name ?? ROLLBACK_ALL));
  }
} finally {
  db.close();
}
