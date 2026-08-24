import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'bun:test';

import { lintMigration } from './migration-lint';

describe('down script rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-migration-lint-'));

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
