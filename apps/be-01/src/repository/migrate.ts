import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import { assertPragmas, openDatabase } from './db';

const FOREIGN_KEYS_OFF_MARKER = '-- foreign-keys-off-rebuild';

/** The migrations already recorded in drizzle's ledger, by folder name. */
function appliedMigrationNames(sqlite: ReturnType<typeof openDatabase>): Set<string> {
  const hasLedger =
    sqlite
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
      )
      .get()?.n === 1;
  if (!hasLedger) return new Set<string>();
  return new Set(
    sqlite
      .query<{ name: string | null }, []>('SELECT name FROM __drizzle_migrations')
      .all()
      .flatMap((row) => (row.name === null ? [] : [row.name])),
  );
}

/**
 * The migration folders on disk, oldest first — the order drizzle applies them
 * in, which is the numeric stamp the folder name begins with.
 */
function migrationFoldersInOrder(migrationsFolder: string): string[] {
  return readdirSync(migrationsFolder)
    .filter((name) => existsSync(join(migrationsFolder, name, 'migration.sql')))
    .sort();
}

function asksForForeignKeysOff(migrationsFolder: string, name: string): boolean {
  return readFileSync(join(migrationsFolder, name, 'migration.sql'), 'utf8').includes(
    FOREIGN_KEYS_OFF_MARKER,
  );
}

/**
 * The pending migrations that have to run with foreign keys off: everything up
 * to and including the newest pending one that asks for it.
 *
 * **This split is the fix for a real fault, not tidiness.** `PRAGMA
 * foreign_keys` cannot be changed inside a transaction and drizzle wraps its
 * whole run in one, so the only lever is the pragma's state when `migrate()` is
 * called — and this used to be decided **once for the entire run**: if any
 * pending migration carried {@link FOREIGN_KEYS_OFF_MARKER}, every pending
 * migration ran with foreign keys off.
 *
 * On dev and prod that was invisible, because the one marker migration
 * (`20260824010000_add_oidc_identity`) was applied long ago and nothing pending
 * asks for it. On a **fresh** database — every test, every new install — every
 * migration is pending, so the whole bootstrap ran unenforced. `ALTER TABLE
 * role RENAME TO step` in `20260831120000_rename_role_to_step` is where that
 * became visible: SQLite rewrites other tables' `REFERENCES` clauses on a table
 * rename **only when foreign keys are enabled**, so the same migration produced
 * a correct schema on dev and five dangling `REFERENCES role(id)` clauses on
 * every fresh database. Any insert into `estimate`, `actual`, `assignment`,
 * `step_progress` or `step_measure` then failed with
 * `no such table: main.role`.
 *
 * The returned group runs first, with foreign keys off; `runMigrations` then
 * applies whatever is left with them on. Splitting at the newest marker rather
 * than isolating each one keeps both groups in ledger order, which is the order
 * the migrations were written to be applied in.
 *
 * Proof: `migrate.test.ts` `renames the step table with every reference to it
 * rewritten, on a database built from nothing` — watched failing before this
 * split on `no such table: main.role`, and again with the split reduced to the
 * old whole-run decision. Observed 2026-08-31.
 */
function pendingNeedingForeignKeysOff(
  sqlite: ReturnType<typeof openDatabase>,
  migrationsFolder: string,
): string[] {
  const applied = appliedMigrationNames(sqlite);
  const pending = migrationFoldersInOrder(migrationsFolder).filter((name) => !applied.has(name));
  let lastMarked = -1;
  for (const [at, name] of pending.entries()) {
    if (asksForForeignKeysOff(migrationsFolder, name)) lastMarked = at;
  }
  return pending.slice(0, lastMarked + 1);
}

/**
 * Applies exactly the named migrations, by handing drizzle a folder holding
 * only those.
 *
 * A folder rather than a filter because drizzle's migrator takes a directory
 * and decides what to run from `__drizzle_migrations` by **name**
 * (`getMigrationsToRun`), so a folder it cannot see is a migration it cannot
 * apply. The copies hash identically to the originals — `readMigrationFiles`
 * hashes `migration.sql`'s contents — so the ledger rows this writes are the
 * ones a later `rollbackTo` verifies against the real folder.
 */
function applyOnly(
  sqlite: ReturnType<typeof openDatabase>,
  migrationsFolder: string,
  names: readonly string[],
): void {
  const staged = mkdtempSync(join(tmpdir(), 'wbs-migrate-staged-'));
  try {
    for (const name of names) {
      cpSync(join(migrationsFolder, name), join(staged, name), { recursive: true });
    }
    migrate(drizzle({ client: sqlite }), { migrationsFolder: staged });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
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
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='oidc_identity_downgrade'",
      )
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
      { cause: error },
    );
  }
}

export function runMigrations(dbPath: string, migrationsFolder: string): void {
  const sqlite = openDatabase(dbPath);
  assertPragmas(sqlite);
  try {
    // Two groups rather than one whole-run decision. See
    // {@link pendingNeedingForeignKeysOff} for the fault that makes the
    // difference load-bearing.
    const withForeignKeysOff = pendingNeedingForeignKeysOff(sqlite, migrationsFolder);
    if (withForeignKeysOff.length > 0) {
      sqlite.run('PRAGMA foreign_keys = OFF;');
      try {
        applyOnly(sqlite, migrationsFolder, withForeignKeysOff);
      } finally {
        sqlite.run('PRAGMA foreign_keys = ON;');
        assertPragmas(sqlite);
      }
    }
    // Unconditional rather than guarded on there being anything left: with
    // nothing pending this is the no-op it has always been, and it is what creates
    // `__drizzle_migrations` on a database that has never had a migration —
    // which `rollbackTo` and `migrate-status-cli` both read unguarded.
    migrate(drizzle({ client: sqlite }), { migrationsFolder });
    restoreDowngradedOidcIdentities(sqlite);
  } finally {
    assertPragmas(sqlite);
    sqlite.close();
  }
}
