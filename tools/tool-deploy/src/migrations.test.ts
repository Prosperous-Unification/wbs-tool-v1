import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSync } from '@wbs/tool-test-scratch';
import { afterAll, describe, expect, it } from 'bun:test';

import {
  assertMigrationFlag,
  assertStopTheWorldNotImplemented,
  hasNewMigrations,
  migrationsAtSha,
} from './migrations';

function git(repository: string, ...args: string[]): string {
  const process = Bun.spawnSync(['git', '-C', repository, ...args]);
  if (process.exitCode !== 0) {
    throw new Error(process.stderr.toString('utf8'));
  }
  return process.stdout.toString('utf8').trim();
}

describe('migrationsAtSha across the namespace transition', () => {
  const repository = scratchSync('wbs-migration-revisions-');

  afterAll(() => {
    rmSync(repository, { recursive: true, force: true });
  });

  git(repository, 'init', '--quiet');
  git(repository, 'config', 'user.email', 'test@example.invalid');
  git(repository, 'config', 'user.name', 'Test');
  mkdirSync(join(repository, 'apps/be-01/drizzle/0001_init'), { recursive: true });
  writeFileSync(join(repository, 'apps/be-01/drizzle/0001_init/migration.sql'), 'SELECT 1;\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '--quiet', '-m', 'old layout');
  const oldSha = git(repository, 'rev-parse', 'HEAD');

  mkdirSync(join(repository, 'apps/wbs'), { recursive: true });
  git(repository, 'mv', 'apps/be-01', 'apps/wbs/be-01');
  git(repository, 'commit', '--quiet', '-m', 'namespace migration root');
  const renamedSha = git(repository, 'rev-parse', 'HEAD');

  mkdirSync(join(repository, 'apps/wbs/be-01/drizzle/0002_add_column'));
  writeFileSync(
    join(repository, 'apps/wbs/be-01/drizzle/0002_add_column/migration.sql'),
    'SELECT 2;\n',
  );
  git(repository, 'add', '.');
  git(repository, 'commit', '--quiet', '-m', 'new migration');
  const addedSha = git(repository, 'rev-parse', 'HEAD');

  it('treats the directory rename as no new migration ids', () => {
    // Proof: forcing the production reader to list only apps/wbs/be-01/drizzle
    // made this old-SHA/new-SHA comparison fail with expected [], received
    // ["0001_init"]. Observed 2026-09-13 and restored.
    const deployed = migrationsAtSha(oldSha, repository);
    const renamed = migrationsAtSha(renamedSha, repository);
    expect(renamed).toEqual(deployed);
    expect(hasNewMigrations(deployed, renamed)).toBe(false);
  });

  it('still requires acknowledgement for a migration added after the rename', () => {
    const renamed = migrationsAtSha(renamedSha, repository);
    const added = migrationsAtSha(addedSha, repository);
    expect(hasNewMigrations(renamed, added)).toBe(true);
    expect(() => {
      assertMigrationFlag(hasNewMigrations(renamed, added), false);
    }).toThrow(/--with-migrations/);
  });

  it('refuses a revision with neither supported migration root', () => {
    writeFileSync(join(repository, 'README.md'), 'no migrations here\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '--quiet', '-m', 'remove migrations');
    git(repository, 'rm', '--quiet', '-r', 'apps/wbs/be-01/drizzle');
    git(repository, 'commit', '--quiet', '-m', 'absent migration root');
    const absentSha = git(repository, 'rev-parse', 'HEAD');
    expect(() => migrationsAtSha(absentSha, repository)).toThrow(/apps\/be-01\/drizzle/);
    expect(() => migrationsAtSha(absentSha, repository)).toThrow(/apps\/wbs\/be-01\/drizzle/);
  });

  it('refuses a revision with both supported migration roots', () => {
    git(repository, 'checkout', '--quiet', addedSha);
    mkdirSync(join(repository, 'apps/be-01/drizzle/legacy'), { recursive: true });
    writeFileSync(join(repository, 'apps/be-01/drizzle/legacy/migration.sql'), 'SELECT 0;\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '--quiet', '-m', 'ambiguous roots');
    const ambiguousSha = git(repository, 'rev-parse', 'HEAD');
    expect(() => migrationsAtSha(ambiguousSha, repository)).toThrow(
      /both supported migration roots/,
    );
  });

  it('refuses an unreadable revision before interpreting it as an empty tree', () => {
    expect(() => migrationsAtSha('f'.repeat(40), repository)).toThrow(/git revision/);
  });
});

describe('hasNewMigrations', () => {
  it('is true when the head tree has a migration the deployed sha lacks', () => {
    expect(hasNewMigrations(['0001_init'], ['0001_init', '0002_add_col'])).toBe(true);
  });

  it('is false when the migration sets match', () => {
    expect(hasNewMigrations(['0001_init'], ['0001_init'])).toBe(false);
  });

  it('is false on a first-ever deploy with no baseline', () => {
    expect(hasNewMigrations(null, ['0001_init'])).toBe(false);
  });
});

describe('assertMigrationFlag', () => {
  it('passes when there are no new migrations', () => {
    expect(() => {
      assertMigrationFlag(false, false);
    }).not.toThrow();
  });

  it('throws when migrations exist and the flag is not given', () => {
    expect(() => {
      assertMigrationFlag(true, false);
    }).toThrow(/--with-migrations/);
  });

  it('does not suggest --stop-the-world as a remedy', () => {
    try {
      assertMigrationFlag(true, false);
      throw new Error('expected assertMigrationFlag to throw');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).not.toMatch(/--stop-the-world for a/);
    }
  });

  it('passes when --with-migrations is given', () => {
    expect(() => {
      assertMigrationFlag(true, true);
    }).not.toThrow();
  });
});

describe('assertStopTheWorldNotImplemented', () => {
  it('passes when the flag is not given', () => {
    expect(() => {
      assertStopTheWorldNotImplemented(false);
    }).not.toThrow();
  });

  it('throws when the flag is given, naming what to do instead', () => {
    let message = '';
    try {
      assertStopTheWorldNotImplemented(true);
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/not implemented/);
    expect(message).toMatch(/--with-migrations/);
    expect(message).toMatch(/manually/);
  });
});
