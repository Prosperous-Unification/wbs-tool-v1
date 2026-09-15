import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSync } from '@tools/test-scratch';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  assertMigrationFlag,
  assertStopTheWorldNotImplemented,
  hasNewMigrations,
  migrationsAtSha,
} from './migrations';

const repositories: string[] = [];

function git(repository: string, ...args: string[]): string {
  const invocation = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = invocation.stdout.toString('utf8').trim();
  const stderr = invocation.stderr.toString('utf8').trim();
  if (invocation.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout;
}

function repository(): string {
  const root = scratchSync('wbs-migrations-at-sha-');
  repositories.push(root);
  git(root, 'init');
  git(root, 'config', 'user.name', 'Migration Tree Test');
  git(root, 'config', 'user.email', 'migration-tree@example.invalid');
  return root;
}

function writeMigration(root: string, layout: 'legacy' | 'namespaced', id: string): void {
  const appRoot =
    layout === 'legacy' ? join(root, 'apps', 'be-01') : join(root, 'apps', 'wbs', 'be-01');
  const migration = join(appRoot, 'drizzle', id);
  mkdirSync(migration, { recursive: true });
  writeFileSync(join(migration, 'migration.sql'), `-- ${id}\nSELECT 1;\n`);
  writeFileSync(join(migration, 'down.sql'), `-- undo ${id}\nSELECT 1;\n`);
}

function commit(repositoryRoot: string, message: string): string {
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', message);
  return git(repositoryRoot, 'rev-parse', 'HEAD');
}

afterEach(() => {
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
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

describe('migrationsAtSha', () => {
  it('resolves the migration tree in each revision across the namespace rename', () => {
    const root = repository();
    writeMigration(root, 'legacy', '0001_init');
    const legacySha = commit(root, 'legacy layout');

    mkdirSync(join(root, 'apps', 'wbs', 'be-01'), { recursive: true });
    git(root, 'mv', 'apps/be-01/drizzle', 'apps/wbs/be-01/drizzle');
    const renameSha = commit(root, 'namespace rename');

    writeMigration(root, 'namespaced', '0002_add_column');
    const additionSha = commit(root, 'add migration');

    const legacyIds = migrationsAtSha(legacySha, root);
    const renamedIds = migrationsAtSha(renameSha, root);
    const addedIds = migrationsAtSha(additionSha, root);

    expect(legacyIds).toEqual(['0001_init']);
    expect(renamedIds).toEqual(['0001_init']);
    expect(hasNewMigrations(legacyIds, renamedIds)).toBe(false);
    expect(addedIds).toEqual(['0001_init', '0002_add_column']);
    expect(hasNewMigrations(renamedIds, addedIds)).toBe(true);
    expect(() => {
      assertMigrationFlag(hasNewMigrations(renamedIds, addedIds), false);
    }).toThrow('--with-migrations');
  });

  it('refuses a revision with neither supported migration tree', () => {
    const root = repository();
    writeFileSync(join(root, 'README.md'), 'no migrations\n');
    const sha = commit(root, 'no migration tree');

    expect(() => migrationsAtSha(sha, root)).toThrow(
      /no supported migration tree.*apps\/be-01\/drizzle.*apps\/wbs\/be-01\/drizzle/,
    );
  });

  it('refuses a revision with both supported migration trees', () => {
    const root = repository();
    writeMigration(root, 'legacy', '0001_init');
    writeMigration(root, 'namespaced', '0001_init');
    const sha = commit(root, 'ambiguous migration trees');

    expect(() => migrationsAtSha(sha, root)).toThrow(
      /ambiguous migration trees.*apps\/be-01\/drizzle.*apps\/wbs\/be-01\/drizzle/,
    );
  });

  it('refuses a supported migration path that is not a Git tree', () => {
    const root = repository();
    mkdirSync(join(root, 'apps', 'be-01'), { recursive: true });
    writeFileSync(join(root, 'apps', 'be-01', 'drizzle'), 'not a directory\n');
    const sha = commit(root, 'malformed migration root');

    expect(() => migrationsAtSha(sha, root)).toThrow(/apps\/be-01\/drizzle.*blob.*tree/);
  });

  it('names an unreadable revision instead of treating it as an empty tree', () => {
    const root = repository();
    const sha = '0123456789abcdef0123456789abcdef01234567';

    expect(() => migrationsAtSha(sha, root)).toThrow(sha);
  });

  it('refuses malformed Git tree output instead of choosing a layout', () => {
    const root = repository();
    const sha = 'a'.repeat(40);
    const legacyTree = `040000 tree ${'b'.repeat(40)}\tapps/be-01/drizzle\0`;
    for (const malformedOutput of ['not a Git tree record\0', `${legacyTree}${legacyTree}`]) {
      const malformedTreeReader = (
        _repository: string,
        _sha: string,
        _options: readonly string[],
        path: string,
      ): string => (path === 'apps/be-01/drizzle' ? malformedOutput : '');

      expect(() => migrationsAtSha(sha, root, malformedTreeReader)).toThrow(
        /apps\/be-01\/drizzle.*(malformed Git state|expected exactly one)/,
      );
    }
  });

  it('refuses listing output outside the selected migration tree', () => {
    const root = repository();
    const sha = 'a'.repeat(40);
    const outOfTreeReader = (
      _repository: string,
      _sha: string,
      options: readonly string[],
      path: string,
    ): string => {
      if (options.length > 0) return 'outside/0001/migration.sql\0';
      if (path === 'apps/be-01/drizzle') {
        return `040000 tree ${'b'.repeat(40)}\tapps/be-01/drizzle\0`;
      }
      return '';
    };

    expect(() => migrationsAtSha(sha, root, outOfTreeReader)).toThrow(
      /returned an out-of-tree path/,
    );
  });

  it('refuses a file stored directly in the migration tree', () => {
    const root = repository();
    const migrationRoot = join(root, 'apps', 'be-01', 'drizzle');
    mkdirSync(migrationRoot, { recursive: true });
    writeFileSync(join(migrationRoot, 'orphan.sql'), 'SELECT 1;\n');
    const sha = commit(root, 'file outside migration folder');

    expect(() => migrationsAtSha(sha, root)).toThrow(/outside a migration folder.*orphan\.sql/);
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
