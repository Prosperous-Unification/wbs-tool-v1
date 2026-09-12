import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '@wbs/store-sqlite/db';
import { runMigrations } from '@wbs/store-sqlite/migrate';
import { afterEach, describe, expect, it } from 'bun:test';

const APP_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const MIGRATIONS = join(APP_ROOT, 'drizzle');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runCli(file: string, dbPath: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, 'run', `src/${file}`, ...args], {
    cwd: APP_ROOT,
    env: { ...process.env, DB_PATH: dbPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function schemaAt(dbPath: string): string[] {
  const sqlite = openDatabase(dbPath);
  try {
    return sqlite
      .query<{ sql: string | null }, []>(
        `SELECT sql FROM sqlite_master
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all()
      .flatMap((row) => (row.sql === null ? [] : [row.sql]));
  } finally {
    sqlite.close();
  }
}

describe('migration deploy entrypoints', () => {
  it('import the SQLite source runners without moving their app paths', () => {
    const expectedImports = new Map<string, readonly string[]>([
      ['migrate-cli.ts', ["from '@wbs/store-sqlite/migrate'"]],
      ['migrate-down-cli.ts', ["from '@wbs/store-sqlite/migrate-down'"]],
      [
        'migrate-status-cli.ts',
        ["from '@wbs/store-sqlite/db'", "from '@wbs/store-sqlite/migrate-down'"],
      ],
    ]);
    for (const [file, imports] of expectedImports) {
      const source = readFileSync(join(APP_ROOT, 'src', file), 'utf8');
      for (const expectedImport of imports) expect(source).toContain(expectedImport);
    }
  });

  it('applies, reports, and reverses the newest migration through the stable CLI paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-migration-cli-'));
    roots.push(root);
    const dbPath = join(root, 'plan.db');
    const baselineMigrations = join(root, 'baseline-migrations');
    const names = readdirSync(MIGRATIONS).sort();
    const latest = names.at(-1);
    const baseline = names.at(-2);
    if (latest === undefined || baseline === undefined) {
      throw new Error('migration CLI round trip requires at least two migrations');
    }
    for (const name of names.slice(0, -1)) {
      cpSync(join(MIGRATIONS, name), join(baselineMigrations, name), { recursive: true });
    }
    runMigrations(dbPath, baselineMigrations);
    const priorSchema = schemaAt(dbPath);

    // Proof: importing `@wbs/store-sqlite/migrate-missing` from migrate-cli.ts
    // made this production invocation exit 1 with `Cannot find module
    // '@wbs/store-sqlite/migrate-missing'` instead of applying `latest`.
    // Changing its folder from `./drizzle` to `../drizzle` separately made the
    // same invocation exit 1 with `ENOENT: scandir '../drizzle'`. Observed
    // 2026-09-10.
    const up = await runCli('migrate-cli.ts', dbPath);
    expect(up).toEqual({ exitCode: 0, stdout: 'migrations applied\n', stderr: '' });
    expect((await runCli('migrate-status-cli.ts', dbPath)).stdout.trim()).toBe(latest);

    const down = await runCli('migrate-down-cli.ts', dbPath, `--to=${baseline}`);
    expect(down.exitCode).toBe(0);
    expect(down.stderr).toBe('');
    expect(down.stdout).toContain(`rolled back: ${latest}`);
    expect(schemaAt(dbPath)).toEqual(priorSchema);
    expect((await runCli('migrate-status-cli.ts', dbPath)).stdout.trim()).toBe(baseline);
  }, 60_000);
});
