import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import { rollbackTo } from './migrate-down';

/**
 * R2-6's non-destructive compatibility stage, watched red.
 *
 * Three legacy elements are named for retirement — `service_team.size`,
 * `work_item.service_id`, and the physical `service_team` name — but none may
 * be dropped, renamed, or re-keyed while an outgoing release still reads them:
 * blue and green share one SQLite file across a swap, so the only safe edits are
 * additive. This file asserts the full migration chain leaves all three standing
 * (and the settled single-team pair — `work_item_team` and the
 * `work_item.service_team_id` scalar — intact), so a premature drop, rename, or
 * re-key fails a test instead of a swap. (The app-level dual-write, where a team
 * patch moves both storage locations, is guarded by work-item.db.test.ts's
 * repo.patch path, not this file.)
 *
 * Watched red, 2026-09-03 on h2puni: inside the first case, immediately after
 * its forward migration, a scratch `ALTER TABLE service_team DROP COLUMN size`
 * removed the column. That case failed at the `toContain('size')` guard with
 * Received `["id", "name", "created_at", "updated_at", "created_by"]`;
 * 4 tests passed / 1 failed / 34 assertions. Restoring the exact head returned
 * the suite to 5/5 / 35 assertions.
 *
 * See openspec/changes/retired-schema-cleanup/design.md for the path inventory
 * and the five-rule version-overlap protocol this file enforces.
 */

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

/** The migration immediately before the service split — the baseline the
 * "down then up" case rolls back to. */
const BEFORE_SERVICE = '20260819120000_add_tag';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-retired-schema-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function columnsOf(dbPath: string, table: string): string[] {
  const sqlite = openDatabase(dbPath);
  try {
    return sqlite
      .query<{ name: string }, [string]>('SELECT name FROM pragma_table_info(?) ORDER BY cid')
      .all(table)
      .map((c) => c.name);
  } finally {
    sqlite.close();
  }
}

function tableNames(dbPath: string): string[] {
  const sqlite = openDatabase(dbPath);
  try {
    return sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
  } finally {
    sqlite.close();
  }
}

/** Row count for a fixed, test-authored table name (never user input). */
function count(dbPath: string, table: string): number {
  const sqlite = openDatabase(dbPath);
  try {
    const row = sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
    if (row === null) throw new Error(`COUNT(*) returned no row for ${table}`);
    return row.n;
  } finally {
    sqlite.close();
  }
}

/** First column of the first row, or null. */
function scalarOf(dbPath: string, sql: string): unknown {
  const sqlite = openDatabase(dbPath);
  try {
    const row = sqlite.query<Record<string, unknown>, []>(sql).get();
    // .get() returns null (not undefined) when no row matches, and its declared
    // return type is `Record<string, unknown> | null`, so a `=== undefined` guard
    // leaves `row` nullable and fails the db-tier typecheck.
    if (row === null) return null;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : null;
  } finally {
    sqlite.close();
  }
}

/** Seed the rows every case here needs: a work item carrying both a team scalar
 * and a service scalar, plus their parents. */
function seed(dbPath: string): void {
  const sqlite = openDatabase(dbPath);
  try {
    sqlite.run(
      "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
    );
    sqlite.run(
      'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
        " VALUES ('p', 'Shed', 'u', 0, 'pert', NULL, 0, 1)",
    );
    sqlite.run("INSERT INTO service_team (id, name) VALUES ('t1', 'Platform')");
    sqlite.run("INSERT INTO service_team (id, name) VALUES ('t2', 'Mobile')");
    sqlite.run("INSERT INTO service (id, name) VALUES ('s1', 'Payments')");
    sqlite.run(
      'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, priority, max_parallel, revision, service_team_id, service_id)' +
        " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 25, 1, 0, 't1', 's1')",
    );
  } finally {
    sqlite.close();
  }
}

describe('the retired schema, across the full migration chain', () => {
  it('keeps the service_team table, its retired size column, and its name', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);

      const tables = tableNames(db.path);
      expect(tables).toContain('service_team');
      // Not renamed: the R2-6 rename to `team` is a later change, not this one.
      expect(tables).not.toContain('team');

      // The retired global number is read by nothing and dropped by nothing.
      expect(columnsOf(db.path, 'service_team')).toContain('size');
      // The dual-write scalar is still a column the outgoing release can see.
      expect(columnsOf(db.path, 'work_item')).toContain('service_team_id');
    } finally {
      db.cleanup();
    }
  });

  it('keeps work_item.service_id as a column that nulls, not cascades, on a service delete', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seed(db.path);

      expect(columnsOf(db.path, 'work_item')).toContain('service_id');

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("DELETE FROM service WHERE id = 's1'");
      } finally {
        sqlite.close();
      }

      // ON DELETE SET NULL, never CASCADE: deleting a service must not delete
      // work items, it only nulls the label.
      expect(scalarOf(db.path, "SELECT name FROM work_item WHERE id = 'w1'")).toBe('Strip');
      expect(scalarOf(db.path, "SELECT service_id FROM work_item WHERE id = 'w1'")).toBeNull();
    } finally {
      db.cleanup();
    }
  });

  it('keeps work_item_team and work_item_service with cascading foreign keys', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seed(db.path);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("INSERT INTO work_item_team (work_item_id, team_id) VALUES ('w1', 't1')");
        sqlite.run("INSERT INTO work_item_service (work_item_id, service_id) VALUES ('w1', 's1')");
      } finally {
        sqlite.close();
      }

      expect(count(db.path, 'work_item_team')).toBe(1);
      expect(count(db.path, 'work_item_service')).toBe(1);

      // Deleting the work item cascades both the team set and the service set.
      const c1 = openDatabase(db.path);
      try {
        c1.run("DELETE FROM work_item WHERE id = 'w1'");
      } finally {
        c1.close();
      }
      expect(count(db.path, 'work_item_team')).toBe(0);
      expect(count(db.path, 'work_item_service')).toBe(0);

      // Re-insert the work item without service_team_id (to avoid the FK when
      // we delete the team below), and with service_id for the service cascade.
      const c2 = openDatabase(db.path);
      try {
        c2.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, priority, max_parallel, revision, service_id)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 25, 1, 0, 's1')",
        );
        c2.run("INSERT INTO work_item_team (work_item_id, team_id) VALUES ('w1', 't1')");
        c2.run("INSERT INTO work_item_service (work_item_id, service_id) VALUES ('w1', 's1')");
      } finally {
        c2.close();
      }

      const c3 = openDatabase(db.path);
      try {
        c3.run("DELETE FROM service_team WHERE id = 't1'");
      } finally {
        c3.close();
      }
      expect(count(db.path, 'work_item_team')).toBe(0);
      expect(count(db.path, 'work_item')).toBe(1);

      const c4 = openDatabase(db.path);
      try {
        c4.run("DELETE FROM service WHERE id = 's1'");
      } finally {
        c4.close();
      }
      expect(count(db.path, 'work_item_service')).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('round-trips a team change through the dual-write scalar and the team set', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seed(db.path);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("INSERT INTO work_item_team (work_item_id, team_id) VALUES ('w1', 't1')");
      } finally {
        sqlite.close();
      }

      const scalar = (): unknown =>
        scalarOf(db.path, "SELECT service_team_id FROM work_item WHERE id = 'w1'");
      const teamSet = (): string[] => {
        const sqlite = openDatabase(db.path);
        try {
          return sqlite
            .query<{ team_id: string }, []>(
              "SELECT team_id FROM work_item_team WHERE work_item_id = 'w1' ORDER BY team_id",
            )
            .all()
            .map((r) => r.team_id);
        } finally {
          sqlite.close();
        }
      };

      // Pre-change: both storage locations agree on t1.
      expect(scalar()).toBe('t1');
      expect(teamSet()).toEqual(['t1']);
      expect(count(db.path, 'work_item')).toBe(1);
      expect(count(db.path, 'work_item_team')).toBe(1);

      // Round-trip both storage locations directly so the scalar and the set member stay in agreement.
      const write = openDatabase(db.path);
      try {
        write.run("UPDATE work_item SET service_team_id = 't2' WHERE id = 'w1'");
        write.run("UPDATE work_item_team SET team_id = 't2' WHERE work_item_id = 'w1'");
      } finally {
        write.close();
      }

      // Post-change: both still agree, now on t2.
      expect(scalar()).toBe('t2');
      expect(teamSet()).toEqual(['t2']);
      expect(count(db.path, 'work_item')).toBe(1);
      expect(count(db.path, 'work_item_team')).toBe(1);
    } finally {
      db.cleanup();
    }
  });

  it('survives rollback and restart with the legacy elements intact', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seed(db.path);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("INSERT INTO work_item_team (work_item_id, team_id) VALUES ('w1', 't1')");
      } finally {
        sqlite.close();
      }

      // Down: roll back the service split and everything after it. The team
      // elements predate the split and must survive the down untouched.
      const reversed = rollbackTo(db.path, FOLDER, BEFORE_SERVICE);
      expect(reversed.length).toBeGreaterThan(0);
      expect(tableNames(db.path)).toContain('service_team');
      expect(columnsOf(db.path, 'service_team')).toContain('size');
      expect(columnsOf(db.path, 'work_item')).toContain('service_team_id');

      // Up again: the full chain re-applies and the legacy elements return.
      runMigrations(db.path, FOLDER);
      expect(columnsOf(db.path, 'work_item')).toContain('service_id');
      expect(tableNames(db.path)).toContain('work_item_service');

      // A row round-trips: the team set member written before the down is still
      // present after the up.
      expect(count(db.path, 'work_item_team')).toBe(1);
      expect(count(db.path, 'work_item')).toBe(1);
      expect(count(db.path, 'work_item_service')).toBe(0);
      // The service rollback is deliberately lossy: the down drops service_id,
      // and the later up recreates the column without the old scalar value.
      expect(scalarOf(db.path, "SELECT service_id FROM work_item WHERE id = 'w1'")).toBeNull();

      // Restart: re-running on a migrated file is a no-op (idempotent).
      expect(() => {
        runMigrations(db.path, FOLDER);
      }).not.toThrow();
      expect(columnsOf(db.path, 'service_team')).toContain('size');
      expect(columnsOf(db.path, 'work_item')).toContain('service_id');
    } finally {
      db.cleanup();
    }
  });
});
