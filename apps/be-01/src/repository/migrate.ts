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

/**
 * Restores identity fields parked by the pre-OIDC downgrade script.
 *
 * Drizzle hashes only `migration.sql`, so repairing the already-applied down
 * script cannot change its forward file. The recovery table bridges that
 * constraint: the old schema ignores it, and this post-migration transaction
 * consumes it only after every saved row exists and compares equal.
 *
 * Proof: `locks OIDC-only accounts during downgrade and restores every identity
 * on re-apply` failed at `users_old.password_hash` before the recovery write and
 * restore existed. Watched on h2puni for TASK-178.
 */
function restoreDowngradedOidcIdentities(sqlite: ReturnType<typeof openDatabase>): void {
  const hasRecovery =
    sqlite
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='oidc_identity_downgrade'")
      .get()?.n === 1;
  if (!hasRecovery) return;

  sqlite.run('BEGIN');
  try {
    sqlite.run(`CREATE TEMP TABLE oidc_identity_restore_guard (
      violations integer CHECK (violations = 0)
    )`);
    sqlite.run(`INSERT INTO oidc_identity_restore_guard
      SELECT COUNT(*)
      FROM oidc_identity_downgrade AS saved
      LEFT JOIN users ON users.id = saved.user_id
      WHERE users.id IS NULL`);
    sqlite.run(`UPDATE users
      SET
        password_hash = CASE
          WHEN (
            SELECT saved.password_was_null
            FROM oidc_identity_downgrade AS saved
            WHERE saved.user_id = users.id
          ) = 1 THEN NULL
          ELSE password_hash
        END,
        email = (
          SELECT saved.email
          FROM oidc_identity_downgrade AS saved
          WHERE saved.user_id = users.id
        ),
        idp_issuer = (
          SELECT saved.idp_issuer
          FROM oidc_identity_downgrade AS saved
          WHERE saved.user_id = users.id
        ),
        idp_sub = (
          SELECT saved.idp_sub
          FROM oidc_identity_downgrade AS saved
          WHERE saved.user_id = users.id
        )
      WHERE id IN (SELECT user_id FROM oidc_identity_downgrade)`);
    sqlite.run(`INSERT INTO oidc_identity_restore_guard
      SELECT COUNT(*)
      FROM oidc_identity_downgrade AS saved
      JOIN users ON users.id = saved.user_id
      WHERE
        (saved.password_was_null = 1 AND users.password_hash IS NOT NULL)
        OR users.email IS NOT saved.email
        OR users.idp_issuer IS NOT saved.idp_issuer
        OR users.idp_sub IS NOT saved.idp_sub`);
    sqlite.run('DELETE FROM oidc_identity_downgrade');
    sqlite.run('COMMIT');
  } catch (error: unknown) {
    sqlite.run('ROLLBACK');
    throw new Error(
      `restoring identities after an OIDC downgrade failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function runMigrations(dbPath: string, migrationsFolder: string): void {
  const sqlite = openDatabase(dbPath);
  assertPragmas(sqlite);
  const rebuild = hasPendingRebuild(sqlite, migrationsFolder);
  try {
    if (rebuild) sqlite.run('PRAGMA foreign_keys = OFF;');
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder });
    restoreDowngradedOidcIdentities(sqlite);
  } finally {
    if (rebuild) sqlite.run('PRAGMA foreign_keys = ON;');
    assertPragmas(sqlite);
    sqlite.close();
  }
}
