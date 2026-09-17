import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scratchAsync } from '@tools/test-scratch';
import { describe, expect, it } from 'bun:test';

import { isConventional } from './hooks/conventional';
import { lintMigration } from './hooks/migration-lint';
import { scan, UnscannableFileError } from './hooks/plaintext-secrets';

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
    const d = await scratchAsync('hooks-');
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
    const d = await scratchAsync('hooks-');
    const f = join(d, 'clean.env');
    await writeFile(f, 'PORT=3000\n', 'utf8');
    expect(await scan(f)).toBeNull();
  });

  // The negative test for the read path. scan() used to `.catch(() => '')`, so
  // a file it could not open scanned as clean — "definitely no secret" and "I
  // never looked" were the same answer. These two cases are what separate them.
  it('throws on an unreadable file rather than reporting it clean', async () => {
    const d = await scratchAsync('hooks-');
    const f = join(d, 'locked.env');
    const fakeAwsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    await writeFile(f, `AWS_KEY=${fakeAwsKey}\n`, 'utf8');
    await chmod(f, 0o000);
    try {
      // The file genuinely holds a secret, so a `null` here would be the exact
      // false clean the old code produced.
      expect(scan(f)).rejects.toThrow(UnscannableFileError);
    } finally {
      await chmod(f, 0o600);
    }
  });

  it('returns null for a path that does not exist', async () => {
    // ENOENT is a modeled absence: a commit that deletes a file stages a path
    // that is already gone. Nothing to scan there is the truth.
    const d = await scratchAsync('hooks-');
    expect(await scan(join(d, 'never-existed.env'))).toBeNull();
  });

  it('returns null for a directory and for a symlink to one', async () => {
    // `git ls-files` lists .claude/skills/* — symlinks to directories under
    // .agents/skills/. A directory has no file contents, which is not the same
    // as a file that went unread. The link targets are tracked and scanned on
    // their own, so nothing is skipped by stepping over the link itself.
    const d = await scratchAsync('hooks-');
    const realDir = join(d, 'a-directory');
    await mkdir(realDir);
    const link = join(d, 'link-to-dir');
    await symlink(realDir, link);
    expect(await scan(realDir)).toBeNull();
    expect(await scan(link)).toBeNull();
  });
});

describe('migration-lint', () => {
  async function lint(name: string, sql: string) {
    const root = await scratchAsync('mig-');
    const migrationDir = join(root, 'apps', 'wbs', 'be-01', 'drizzle', name);
    await mkdir(migrationDir, { recursive: true });
    const file = join(migrationDir, 'migration.sql');
    await writeFile(file, sql, 'utf8');
    await writeFile(join(migrationDir, 'down.sql'), 'SELECT 1;', 'utf8');
    return lintMigration(file, root);
  }

  it('flags DROP TABLE', async () => {
    const hit = await lint('0002_bad', 'DROP TABLE users;');
    expect(hit?.reason).toMatch(/DROP TABLE/);
  });

  it('allows CREATE TABLE', async () => {
    expect(await lint('0003_ok', 'CREATE TABLE t (id INTEGER);')).toBeNull();
  });

  // The rule was written as the literal 'ALTER TABLE ... RENAME COLUMN' and
  // matched by deleting the ellipsis, producing the needle
  // 'ALTER TABLE RENAME COLUMN'. Valid SQL always names the table between
  // those tokens, so that branch could never match any real migration — the
  // rename rule was dead from the day it was written.
  it('flags a real ALTER TABLE ... RENAME COLUMN, table name and all', async () => {
    const hit = await lint('0004_rename', 'ALTER TABLE users RENAME COLUMN a TO b;');
    expect(hit?.reason).toMatch(/RENAME COLUMN/);
  });

  it('flags a rename written over several lines', async () => {
    const hit = await lint('0005_rename', 'ALTER TABLE\n  users\n  RENAME COLUMN a TO b;');
    expect(hit?.reason).toMatch(/RENAME COLUMN/);
  });

  it('flags a quoted table name in a rename', async () => {
    const hit = await lint('0006_rename', 'ALTER TABLE "users" RENAME COLUMN "a" TO "b";');
    expect(hit?.reason).toMatch(/RENAME COLUMN/);
  });

  // Substring matching against the raw text also missed anything whose
  // keywords were split by a newline or doubled spaces, which is exactly how
  // generated SQL tends to be formatted.
  it('flags DROP TABLE split across a newline', async () => {
    const hit = await lint('0007_drop', 'DROP\nTABLE users;');
    expect(hit?.reason).toMatch(/DROP TABLE/);
  });

  it('flags DROP COLUMN with doubled spaces', async () => {
    const hit = await lint('0008_drop', 'ALTER TABLE t DROP  COLUMN c;');
    expect(hit?.reason).toMatch(/DROP COLUMN/);
  });

  it('flags lowercase destructive statements', async () => {
    const hit = await lint('0009_drop', 'drop table users;');
    expect(hit?.reason).toMatch(/DROP TABLE/);
  });

  // Fail closed. An unreadable file used to be read as '' and therefore
  // reported clean, so a migration the hook could not open was indistinguishable
  // from one with nothing wrong in it.
  it('reports an unreadable .sql file as an issue rather than as clean', async () => {
    const root = await scratchAsync('mig-');
    const migrationDir = join(root, 'apps', 'wbs', 'be-01', 'drizzle', 'missing');
    await mkdir(migrationDir, { recursive: true });
    await writeFile(join(migrationDir, 'down.sql'), 'SELECT 1;', 'utf8');
    const hit = await lintMigration(join(migrationDir, 'migration.sql'), root);
    expect(hit?.reason).toMatch(/could not be read/);
  });

  // Guard against over-matching: these must stay clean, or the hook becomes
  // noise everyone disables.
  it('leaves a renamed-in-passing identifier alone', async () => {
    expect(await lint('0010_ok', 'CREATE TABLE rename_column_log (id INTEGER);')).toBeNull();
  });

  it('leaves a create-then-copy migration alone', async () => {
    const sql = 'CREATE TABLE t_new (id INTEGER, b TEXT);\nINSERT INTO t_new SELECT id, a FROM t;';
    expect(await lint('0011_ok', sql)).toBeNull();
  });
});
