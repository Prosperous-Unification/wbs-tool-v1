import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSync } from '@wbs/tool-test-scratch';
import { afterAll, describe, expect, it } from 'bun:test';

import { lintMigration } from './migration-lint';

describe('down script rules', () => {
  const dir = scratchSync('wbs-migration-lint-');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function migration(name: string, up: string, down?: string): string {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    const upPath = join(folder, 'migration.sql');
    writeFileSync(upPath, up);
    if (down !== undefined) writeFileSync(join(folder, 'down.sql'), down);
    return upPath;
  }

  it('fails a migration with no down.sql', async () => {
    const file = migration('20260101000000_no_down', 'CREATE TABLE t (id text);');
    const issue = await lintMigration(file);
    expect(issue?.reason).toMatch(/no down\.sql/);
  });

  it('passes a migration that ships one', async () => {
    const file = migration(
      '20260101000001_with_down',
      'CREATE TABLE t (id text);',
      'DROP TABLE IF EXISTS t;',
    );
    expect(await lintMigration(file)).toBeNull();
  });

  // The forward migration must stay additive so blue and green can share one
  // database mid-swap. The down script is destructive by definition, and is
  // the file that quarantines that.
  it('allows DROP TABLE in a down script', async () => {
    migration('20260101000002_drops', 'CREATE TABLE t (id text);', 'DROP TABLE t;');
    const down = join(dir, '20260101000002_drops', 'down.sql');
    expect(await lintMigration(down)).toBeNull();
  });

  it('still rejects DROP TABLE in a forward migration', async () => {
    const file = migration('20260101000003_bad', 'DROP TABLE users;', 'SELECT 1;');
    const issue = await lintMigration(file);
    expect(issue?.reason).toMatch(/DROP TABLE/);
  });

  // The statement that looks additive and is not. SQLite refuses `ADD COLUMN
  // ... NOT NULL` with no default against a table that already holds rows, and
  // it refuses it on the deploy that runs it rather than here — which is why the
  // lint has to be the thing that says no. Every table in this schema holds rows
  // in dev and prod.
  it('rejects a NOT NULL column added with no default', async () => {
    const file = migration(
      '20260101000010_not_null_add',
      'ALTER TABLE `tag` ADD `created_by` text NOT NULL;',
      'ALTER TABLE `tag` DROP COLUMN `created_by`;',
    );
    const issue = await lintMigration(file);
    expect(issue?.reason).toMatch(/NOT NULL/);
  });

  // With a default the statement is genuinely additive: SQLite can fill the rows
  // that are already there. This is the case `add_estimate_weights_and_rounding`
  // ships four of, so a pattern that refused it would fail the tree it is in.
  it('allows a NOT NULL column that carries a default', async () => {
    const file = migration(
      '20260101000011_not_null_default',
      "ALTER TABLE `project` ADD `estimate_rounding` text DEFAULT 'ceil' NOT NULL;",
      'ALTER TABLE `project` DROP COLUMN `estimate_rounding`;',
    );
    expect(await lintMigration(file)).toBeNull();
  });

  // And the audit columns this rule was written for: nullable, no default, so a
  // row older than the migration keeps a null author rather than a made-up one.
  it('allows the nullable audit columns', async () => {
    const file = migration(
      '20260101000012_audit_columns',
      'ALTER TABLE `tag` ADD `created_at` integer;--> statement-breakpoint\n' +
        'ALTER TABLE `tag` ADD `created_by` text REFERENCES `users`(`id`);',
      'ALTER TABLE `tag` DROP COLUMN `created_by`;',
    );
    expect(await lintMigration(file)).toBeNull();
  });

  it('allows an explicitly guarded same-name compatibility rebuild', async () => {
    const unguarded = migration(
      '20260101000004_unguarded',
      '-- migration-lint: compatible-table-rebuild\nDROP TABLE users;',
      'SELECT 1;',
    );
    expect((await lintMigration(unguarded))?.reason).toMatch(/DROP TABLE/);

    const file = migration(
      '20260101000005_rebuild',
      `-- migration-lint: compatible-table-rebuild
       -- foreign-keys-off-rebuild
       CREATE TABLE users_new (id text PRIMARY KEY);
       DROP TABLE users;
       ALTER TABLE users_new RENAME TO users;
       CREATE TEMP TABLE fk_guard (violations integer CHECK (violations = 0));
       INSERT INTO fk_guard SELECT COUNT(*) FROM pragma_foreign_key_check;`,
      'SELECT 1;',
    );
    expect(await lintMigration(file)).toBeNull();
  });
});

/**
 * The waiver that lets `20260831120000_rename_role_to_step` carry a
 * `RENAME COLUMN`, and the condition it is waived on.
 *
 * The folders here are built at the real depth —
 * `<root>/apps/be-01/drizzle/<folder>/migration.sql` — because that is what
 * the lint resolves `bin/assert-no-prod-release.sh` against. A shallower
 * fixture would test a path the hook never walks.
 */
describe('the role -> step rename waiver', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const RENAME = '20260831120000_rename_role_to_step';
  const RENAME_SQL = 'ALTER TABLE `estimate` RENAME COLUMN `role_id` TO `step_id`;';

  /** A checkout-shaped tree, with the gate script present only when asked for. */
  function checkout(folder: string, up: string, opts: { gate: boolean }): string {
    const root = scratchSync('wbs-rename-waiver-');
    roots.push(root);
    const migrationDir = join(root, 'apps', 'be-01', 'drizzle', folder);
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(join(migrationDir, 'migration.sql'), up);
    writeFileSync(join(migrationDir, 'down.sql'), 'SELECT 1;');
    if (opts.gate) {
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(join(root, 'bin', 'assert-no-prod-release.sh'), '#!/usr/bin/env bash\n');
    }
    return join(migrationDir, 'migration.sql');
  }

  it('lets the rename migration through while its gate script is in the tree', async () => {
    const file = checkout(RENAME, RENAME_SQL, { gate: true });
    expect(await lintMigration(file)).toBeNull();
  });

  // Proof: the `existsSync(gateScriptPath(...))` requirement removed from
  // `lintMigration`, watched failing here on
  // `Received value must be a string: undefined` — the lint returned no issue
  // at all for a rename migration with no gate script beside it.
  // Observed 2026-08-31.
  it('refuses the rename migration when its gate script is absent', async () => {
    const file = checkout(RENAME, RENAME_SQL, { gate: false });
    const issue = await lintMigration(file);
    expect(issue?.reason).toMatch(/assert-no-prod-release\.sh/);
    expect(issue?.reason).toMatch(/rests on nothing/);
  });

  // The waiver lifts one label and no others. A rename migration that also
  // dropped a table would be a different change with a different argument.
  it('still refuses a DROP TABLE inside the waived migration', async () => {
    const file = checkout(RENAME, `${RENAME_SQL}\nDROP TABLE role;`, { gate: true });
    const issue = await lintMigration(file);
    expect(issue?.reason).toMatch(/DROP TABLE/);
  });

  // Proof that the waiver is keyed on the folder and not on the statement:
  // any other migration writing the same SQL is refused, gate script or not.
  it('refuses the same RENAME COLUMN in any other migration', async () => {
    const file = checkout('20260901000000_some_other_change', RENAME_SQL, { gate: true });
    const issue = await lintMigration(file);
    expect(issue?.reason).toMatch(/RENAME COLUMN/);
  });
});
