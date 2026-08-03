import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { isConventional } from './hooks/conventional';
import { lintMigration } from './hooks/migration-lint';
import { scan } from './hooks/plaintext-secrets';

describe('conventional', () => {
  it('accepts conventional subjects', () => {
    expect(isConventional('feat(gw): add ping')).toBe(true);
    expect(isConventional('fix: bug\n\nbody')).toBe(true);
    expect(isConventional('chore(deps)!: drop node 18')).toBe(true);
  });

  it('rejects non-conventional', () => {
    expect(isConventional('wip')).toBe(false);
    expect(isConventional('Add stuff')).toBe(false);
  });
});

describe('plaintext-secrets.scan', () => {
  it('detects AWS keys and age secrets', async () => {
    const d = await mkdtemp(join(tmpdir(), 'hooks-'));
    const f = join(d, 'leaky.env');
    // Assembled at runtime rather than written as a literal: this hook scans
    // its own repo, so a whole fake key sitting in the source aborts every
    // commit that touches this file. Splitting it keeps the fixture a real
    // match for /AKIA[0-9A-Z]{16}/ at the point scan() sees it.
    const fakeAwsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    await writeFile(f, `AWS_KEY=${fakeAwsKey}\n`, 'utf8');
    const hit = await scan(f);
    expect(hit).not.toBeNull();
    expect(hit?.finding).toMatch(/AWS/);
  });

  it('returns null for clean files', async () => {
    const d = await mkdtemp(join(tmpdir(), 'hooks-'));
    const f = join(d, 'clean.env');
    await writeFile(f, 'PORT=3000\n', 'utf8');
    expect(await scan(f)).toBeNull();
  });
});

describe('migration-lint', () => {
  it('flags DROP TABLE', async () => {
    const d = await mkdtemp(join(tmpdir(), 'mig-'));
    const f = join(d, '0002_bad.sql');
    await writeFile(f, 'DROP TABLE users;', 'utf8');
    const hit = await lintMigration(f);
    expect(hit?.reason).toMatch(/DROP TABLE/);
  });

  it('allows CREATE TABLE', async () => {
    const d = await mkdtemp(join(tmpdir(), 'mig-'));
    const f = join(d, '0003_ok.sql');
    await writeFile(f, 'CREATE TABLE t (id INTEGER);', 'utf8');
    expect(await lintMigration(f)).toBeNull();
  });

  async function lint(name: string, sql: string) {
    const d = await mkdtemp(join(tmpdir(), 'mig-'));
    const f = join(d, name);
    await writeFile(f, sql, 'utf8');
    return lintMigration(f);
  }

  // The rule was written as the literal 'ALTER TABLE ... RENAME COLUMN' and
  // matched by deleting the ellipsis, producing the needle
  // 'ALTER TABLE RENAME COLUMN'. Valid SQL always names the table between
  // those tokens, so that branch could never match any real migration — the
  // rename rule was dead from the day it was written.
  it('flags a real ALTER TABLE ... RENAME COLUMN, table name and all', async () => {
    const hit = await lint('0004_rename.sql', 'ALTER TABLE users RENAME COLUMN a TO b;');
    expect(hit?.reason).toMatch(/RENAME COLUMN/);
  });

  it('flags a rename written over several lines', async () => {
    const hit = await lint('0005_rename.sql', 'ALTER TABLE\n  users\n  RENAME COLUMN a TO b;');
    expect(hit?.reason).toMatch(/RENAME COLUMN/);
  });

  it('flags a quoted table name in a rename', async () => {
    const hit = await lint('0006_rename.sql', 'ALTER TABLE "users" RENAME COLUMN "a" TO "b";');
    expect(hit?.reason).toMatch(/RENAME COLUMN/);
  });

  // Substring matching against the raw text also missed anything whose
  // keywords were split by a newline or doubled spaces, which is exactly how
  // generated SQL tends to be formatted.
  it('flags DROP TABLE split across a newline', async () => {
    const hit = await lint('0007_drop.sql', 'DROP\nTABLE users;');
    expect(hit?.reason).toMatch(/DROP TABLE/);
  });

  it('flags DROP COLUMN with doubled spaces', async () => {
    const hit = await lint('0008_drop.sql', 'ALTER TABLE t DROP  COLUMN c;');
    expect(hit?.reason).toMatch(/DROP COLUMN/);
  });

  it('flags lowercase destructive statements', async () => {
    const hit = await lint('0009_drop.sql', 'drop table users;');
    expect(hit?.reason).toMatch(/DROP TABLE/);
  });

  // Fail closed. An unreadable file used to be read as '' and therefore
  // reported clean, so a migration the hook could not open was indistinguishable
  // from one with nothing wrong in it.
  it('reports an unreadable .sql file as an issue rather than as clean', async () => {
    const d = await mkdtemp(join(tmpdir(), 'mig-'));
    const hit = await lintMigration(join(d, 'does-not-exist.sql'));
    expect(hit?.reason).toMatch(/could not be read/);
  });

  // Guard against over-matching: these must stay clean, or the hook becomes
  // noise everyone disables.
  it('leaves a renamed-in-passing identifier alone', async () => {
    expect(await lint('0010_ok.sql', 'CREATE TABLE rename_column_log (id INTEGER);')).toBeNull();
  });

  it('leaves a create-then-copy migration alone', async () => {
    const sql = 'CREATE TABLE t_new (id INTEGER, b TEXT);\nINSERT INTO t_new SELECT id, a FROM t;';
    expect(await lint('0011_ok.sql', sql)).toBeNull();
  });
});
