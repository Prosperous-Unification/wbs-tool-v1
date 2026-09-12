import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import * as schema from './schema';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-schema-indexes-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Every index `schema.ts` declares, by name. */
function declaredIndexes(): string[] {
  const names: string[] = [];
  for (const exported of Object.values(schema)) {
    // Only the table objects have a config. Everything else this module exports
    // is a helper or a constant, and `getTableConfig` throws on those rather
    // than answering an empty one — hence the catch instead of a type guard.
    if (typeof exported !== 'object') continue;
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(exported as Parameters<typeof getTableConfig>[0]);
    } catch {
      continue;
    }
    for (const index of config.indexes) names.push(index.config.name);
  }
  return [...new Set(names)].sort();
}

/** Every index a migrated database holds, excluding the ones SQLite makes. */
function indexesInDatabase(): string[] {
  const db = openDatabase(path);
  try {
    return db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/**
 * `schema.ts` against the database the migrations actually build.
 *
 * These two are edited in different files by different hands, and nothing
 * compared them. On 2026-09-02 three indexes existed only in the database —
 * `actual_by_step`, `step_progress_by_step` and `step_measure_by_step`, created
 * under their new names by `20260831120000_rename_role_to_step` and never
 * written back into the schema. Three reads name them in comments as the reason
 * they are fast, and the next `drizzle-kit generate` would have dropped all
 * three, because generate diffs against this file and this file did not know
 * they were there.
 *
 * The other direction is the worse one: an index declared here and never
 * migrated is a plan somebody is counting on that no database has.
 *
 * Proof: with `index('actual_by_step').on(t.stepId)` taken back out of
 * `schema.ts`, watched failing on `expect(received).toEqual(expected) ·
 * - "actual_by_step"` — the database holding one the schema does not declare
 * (2026-09-02).
 */
describe('schema.ts and the migrated database agree about indexes', () => {
  it('declares every index the database holds, and no others', () => {
    expect(declaredIndexes()).toEqual(indexesInDatabase());
  });

  it('is reading real indexes, not an empty list twice', () => {
    // Both sides could be empty for the same wrong reason — a `getTableConfig`
    // that threw for every export, a query naming a column SQLite does not
    // have — and an empty list equals an empty list.
    expect(declaredIndexes().length).toBeGreaterThan(20);
    expect(declaredIndexes()).toContain('work_item_siblings');
  });
});
