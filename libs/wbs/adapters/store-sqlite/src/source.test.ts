import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { type Connection, openConnection } from './db';
import { runMigrations } from './migrate';
import { openSqliteSource } from './source';

const MIGRATIONS = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;
const dirs: string[] = [];

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-sqlite-source-'));
  dirs.push(dir);
  return join(dir, 'source.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openSqliteSource', () => {
  it('opens without applying migrations', async () => {
    const path = databasePath();
    const source = openSqliteSource({ dbPath: path });

    expect(existsSync(path)).toBe(true);
    expect(await source.health()).toEqual({ ok: false, reason: 'unavailable' });
    const observer = openConnection(path);
    // Proof: an open-time CREATE for this table failed with Received [{ name:
    // "__drizzle_migrations" }] instead of the expected empty list.
    expect(
      observer.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      ),
    ).toEqual([]);
    observer.close();
    await source.close();
  });

  it('uses one process connection for transactional stores and independent history connections', async () => {
    const path = databasePath();
    runMigrations(path, MIGRATIONS);
    let opens = 0;
    const source = openSqliteSource({
      dbPath: path,
      openConnection: (requested): Connection => {
        opens += 1;
        return openConnection(requested);
      },
    });

    await source.stores.projects.findById('absent');
    // Proof: opening another connection for the public stores failed here on
    // Expected 1, Received 2.
    expect(opens).toBe(1);
    await source.history.savedPlans.listOf('absent');
    // Proof: constructing history over the process connection left this at 1.
    expect(opens).toBe(2);
    await source.close();
  });

  it('reports a present schema as healthy', async () => {
    const path = databasePath();
    runMigrations(path, MIGRATIONS);
    const source = openSqliteSource({ dbPath: path });
    expect(await source.health()).toEqual({ ok: true });
    await source.close();
  });

  it('adds context to unexpected health failures', async () => {
    const path = databasePath();
    const real = openConnection(path);
    const source = openSqliteSource({
      dbPath: path,
      openConnection: () => ({
        db: Object.create(real.db, {
          all: {
            value: () => {
              throw new Error('corrupt page');
            },
          },
        }) as Connection['db'],
        close: real.close,
      }),
    });
    // Proof: mapping this thrown query to unavailable failed because the
    // promise resolved instead of rejecting.
    expect(source.health()).rejects.toThrow('failed to probe SQLite source health');
    await source.close();
  });

  it('closes once and surfaces cleanup failure', async () => {
    const path = databasePath();
    const real = openConnection(path);
    let closes = 0;
    const source = openSqliteSource({
      dbPath: path,
      openConnection: () => ({
        db: real.db,
        close: () => {
          closes += 1;
          throw new Error('close failed');
        },
      }),
    });

    // Proof: swallowing the cleanup error resolved this promise instead of rejecting.
    expect(source.close()).rejects.toThrow('close failed');
    // Proof: removing the closed guard threw "close failed" again here.
    await source.close();
    expect(closes).toBe(1);
  });
});
