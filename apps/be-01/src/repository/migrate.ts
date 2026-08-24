import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import { assertPragmas, openDatabase } from './db';

const FOREIGN_KEYS_OFF_MARKER = '-- foreign-keys-off-rebuild';

function hasPendingRebuild(
  sqlite: ReturnType<typeof openDatabase>,
  migrationsFolder: string,
): boolean {
  const hasLedger =
    sqlite
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get()?.n === 1;
  const applied = hasLedger
    ? new Set(
        sqlite
          .query<{ name: string | null }, []>('SELECT name FROM __drizzle_migrations')
          .all()
          .flatMap((row) => (row.name === null ? [] : [row.name])),
      )
    : new Set<string>();

  return readdirSync(migrationsFolder).some(
    (name) =>
      !applied.has(name) &&
      existsSync(join(migrationsFolder, name, 'migration.sql')) &&
      readFileSync(join(migrationsFolder, name, 'migration.sql'), 'utf8').includes(
        FOREIGN_KEYS_OFF_MARKER,
      ),
  );
}

export function runMigrations(dbPath: string, migrationsFolder: string): void {
  const sqlite = openDatabase(dbPath);
  assertPragmas(sqlite);
  const rebuild = hasPendingRebuild(sqlite, migrationsFolder);
  try {
    if (rebuild) sqlite.run('PRAGMA foreign_keys = OFF;');
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder });
  } finally {
    if (rebuild) sqlite.run('PRAGMA foreign_keys = ON;');
    assertPragmas(sqlite);
    sqlite.close();
  }
}
