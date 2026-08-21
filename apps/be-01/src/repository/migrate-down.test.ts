import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import {
  type AppliedMigration,
  duplicateMigrationStamps,
  migrationsToRollback,
  readMigrationFolders,
  ROLLBACK_ALL,
  rollbackTo,
} from './migrate-down';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const INIT = '20260426171432_talented_smiling_tiger';
const USERS = '20260804194845_add_users';
const WBS = '20260805154500_add_wbs_domain';
const DEPS = '20260806084828_add_dependencies';
const ACCESS = '20260806160000_add_project_access';
const METHOD = '20260806170000_add_estimate_method';
const CAL = '20260806180000_add_calendar_dates';
const TEAMS = '20260806190000_add_teams_and_assignees';
// Columns on `project` and `work_item` rather than tables of its own, so it
// appears in the order and in nothing else this file checks.
const REVISIONS = '20260807090000_add_revisions';
// One table of its own, so it reverses ahead of the domain it references.
const JOURNAL = '20260807180000_add_command_journal';
// A column on `role`, so like the revisions it appears in the order and in
// nothing else this file checks.
const ROLE_POSITION = '20260809090000_add_role_position';
const PRIORITY = '20260811100000_add_priority';
// Two columns in one release: a nullable `service_team.size` and a
// `NOT NULL DEFAULT 1` `work_item.max_parallel`. They appear here in the order
// they are applied, and reverse in the opposite one — which is the rollback
// ordering `capacity-engine` asserts rather than assumes.
const TEAM_SLOTS = '20260812100000_add_team_slots';
const MAX_PARALLEL = '20260812100001_add_max_parallel';
// A table of its own, and the one whose rollback ordering matters most: its rows
// were seeded from `service_team.size`, so it has to reverse before the migration
// that adds that column.
const PER_PROJECT_CAPACITY = '20260813120000_add_project_team_capacity';
// Newest but one now, and a table of its own: `work_item_team` references
// `work_item` and `service_team`, so it reverses ahead of both.
const WORK_ITEM_TEAM = '20260814100000_add_work_item_team';
// The newest, and a table of its own again. It references `project` alone and is
// seeded from a constant rather than from any column, so unlike the capacity
// table above it has no ordering constraint of its own — its place at the head
// of the reversal is only that it was applied last.
//
// **`110000` and not the `100000` this branch was written with**, which was the
// same stamp `WORK_ITEM_TEAM` carries on main. Two folders sharing one stamp
// share one `created_at`, and `migrationsToRollback` filters on
// `created_at > baseline.created_at` — strictly — so rolling back *to* the
// priority-band migration would have reversed nothing, silently leaving
// `work_item_team` applied. Renumbered on the rebase; see verify.md.
const PRIORITY_BANDS = '20260814110000_add_priority_band';
/**
 * The newest, and a table of its own again. It references `project` and `users`,
 * so it reverses ahead of both — the same place `JOURNAL` sits for the same
 * reason.
 *
 * Stamped three days past `PRIORITY_BANDS` and checked against every folder on
 * disk before it was written; `refuses a folder set that shares one stamp between
 * two migrations` below is the mechanical half of that check, and
 * `does nothing when the target is already the newest applied` is the case the
 * 2026-08-14 collision would have broken.
 */
const PLAN_EVENT = '20260817120000_add_plan_event';
/**
 * The newest. A table of its own referencing `work_item` and `role`, so it
 * reverses ahead of the domain that holds both — `JOURNAL`'s place for
 * `JOURNAL`'s reason.
 *
 * Stamped `130000`, an hour past `PLAN_EVENT` and later than all eighteen
 * folders that were on disk when it was written. The check is
 * `refuses a folder set that shares one stamp between two migrations` below, and
 * `does nothing when the target is already the newest applied` — which now names
 * this* migration — is the case a collision breaks.
 */
const ACTUAL = '20260817130000_add_actual';
/**
 * The newest. A table of its own referencing `work_item` and `role` again, so it
 * reverses ahead of the domain that holds both — `ACTUAL`'s place for `ACTUAL`'s
 * reason, and it comes off before `ACTUAL` only because it was applied after it.
 *
 * Stamped `20260818010000`, later than all nineteen folders that were on disk
 * when it was written. The stamps were listed and checked for a duplicate before
 * the folder existed — verify.md quotes the run — and `refuses a folder set that
 * shares one stamp between two migrations` is the mechanical half of the same
 * check.
 */
const ROLE_PROGRESS = '20260818010000_add_role_progress';
/**
 * The newest, and a column on `work_item` rather than a table of its own: it
 * reverses first because it was applied last, and it takes nothing with it.
 *
 * Stamped `20260818090000`, later than all twenty folders on disk when it was
 * written, checked for a duplicate before the folder existed.
 */
const NOT_BEFORE_REASON = '20260818090000_add_not_before_reason';
/**
 * The newest. Two tables, and they reverse in the order `work_item_tag` then
 * `tag` because the first references the second — the pairing `TEAMS` has for
 * the same reason, inside one folder rather than across two.
 *
 * Stamped `20260819120000`, later than all twenty-one folders on disk when it
 * was written, checked for a duplicate before the folder existed.
 */
const TAG = '20260819120000_add_tag';
/**
 * Two tables **and** a column, which was a first: `work_item.service_id` is
 * dropped before `service`, because a column that references a table cannot
 * outlive it by even one statement.
 *
 * Stamped `20260821000000`, later than all twenty-two folders on disk when it was
 * written, checked for a duplicate before the folder existed.
 */
const SERVICE = '20260821000000_add_service';
/**
 * The newest, and the one that widens the service dimension to a set eight hours
 * after the folder above shipped it as one column. It adds a table and drops
 * nothing: the column it seeds from is still selected by the outgoing release
 * during a blue/green swap, so it survives to a later migration.
 *
 * Stamped `20260821080000`, later than all twenty-three folders on disk when it
 * was written, checked for a duplicate before the folder existed.
 */
const WORK_ITEM_SERVICE = '20260821080000_add_work_item_service';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-migrate-down-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function tables(dbPath: string): string[] {
  const db = openDatabase(dbPath);
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

function appliedNames(dbPath: string): string[] {
  const db = openDatabase(dbPath);
  try {
    return db
      .query<AppliedMigration, []>(
        'SELECT id, hash, created_at, name FROM __drizzle_migrations ORDER BY created_at',
      )
      .all()
      .map((r) => r.name ?? '(unnamed)');
  } finally {
    db.close();
  }
}

const row = (name: string, created_at: number): AppliedMigration => ({
  id: created_at,
  hash: `hash-${name}`,
  created_at,
  name,
});

describe('migrationsToRollback', () => {
  const applied = [row('a', 100), row('b', 200), row('c', 300)];

  it('returns everything after the target, newest first', () => {
    expect(migrationsToRollback(applied, 'a').map((m) => m.name)).toEqual(['c', 'b']);
  });

  it('returns nothing when the target is already the newest', () => {
    expect(migrationsToRollback(applied, 'c')).toEqual([]);
  });

  it('returns everything, newest first, for an empty baseline', () => {
    expect(migrationsToRollback(applied, ROLLBACK_ALL).map((m) => m.name)).toEqual(['c', 'b', 'a']);
  });

  it('refuses a target that is not recorded as applied', () => {
    // The two other readings — roll back nothing, roll back everything —
    // differ by the entire database, so guessing is not available.
    expect(() => migrationsToRollback(applied, 'nope')).toThrow(/not recorded as applied/);
  });
});

describe('readMigrationFolders', () => {
  it('pairs every migration on disk with a down script', () => {
    const folders = readMigrationFolders(FOLDER);
    expect(folders.map((f) => f.name)).toEqual([
      INIT,
      USERS,
      WBS,
      DEPS,
      ACCESS,
      METHOD,
      CAL,
      TEAMS,
      REVISIONS,
      JOURNAL,
      ROLE_POSITION,
      PRIORITY,
      TEAM_SLOTS,
      MAX_PARALLEL,
      PER_PROJECT_CAPACITY,
      WORK_ITEM_TEAM,
      PRIORITY_BANDS,
      PLAN_EVENT,
      ACTUAL,
      ROLE_PROGRESS,
      NOT_BEFORE_REASON,
      TAG,
      SERVICE,
      WORK_ITEM_SERVICE,
    ]);
    for (const f of folders) expect(f.downSql.trim()).not.toBe('');
  });

  it('refuses a migration with no down script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbs-nodown-'));
    try {
      const mig = join(dir, '20260101000000_orphan');
      mkdirSync(mig);
      writeFileSync(join(mig, 'migration.sql'), 'CREATE TABLE t (id text);');
      expect(() => readMigrationFolders(dir)).toThrow(/no down\.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a folder set that shares one stamp between two migrations', () => {
    // The fault that shipped on 2026-08-14 and was found by hand: two folders
    // stamped `20260814100000`. Drizzle records that prefix as the migration's
    // `created_at`, `migrationsToRollback` filters on `created_at >` strictly,
    // and so a rollback whose baseline is either of them reverses **nothing** and
    // reports success — with both tables still standing and both bookkeeping rows
    // still claiming to be applied.
    //
    // Written against a folder set rather than against `FOLDER`, because the
    // healthy assertion is the one above and a test cannot inject a collision into
    // a directory the repository ships.
    //
    // Proof: with the `duplicateMigrationStamps` check removed from
    // `readMigrationFolders`, this fails on `expected function to throw` — and the
    // two `rollbackTo` calls below it come back `[]` against a database holding
    // both tables, which is the silent half of the same fault. Watched 2026-08-17.
    const dir = mkdtempSync(join(tmpdir(), 'wbs-shared-stamp-'));
    try {
      for (const name of ['20260814100000_first', '20260814100000_second']) {
        const mig = join(dir, name);
        mkdirSync(mig);
        writeFileSync(join(mig, 'migration.sql'), `CREATE TABLE ${name.slice(15)} (id text);`);
        writeFileSync(join(mig, 'down.sql'), `DROP TABLE ${name.slice(15)};`);
      }
      expect(() => readMigrationFolders(dir)).toThrow(/stamps are shared/);
      // And the rollback that would have run against them refuses too, rather
      // than reporting a reversal it did not perform.
      const db = tempDb();
      try {
        expect(() => rollbackTo(db.path, dir, ROLLBACK_ALL)).toThrow(/stamps are shared/);
      } finally {
        db.cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names every stamp shared by more than one folder, and nothing else', () => {
    expect(duplicateMigrationStamps(['20260101000000_a', '20260102000000_b'])).toEqual([]);
    expect(
      duplicateMigrationStamps(['20260101000000_a', '20260101000000_b', '20260102000000_c']),
    ).toEqual([20260101000000]);
    // A folder whose prefix is not a number would be recorded with
    // `created_at = NaN`, every comparison against it would be false, and the
    // rollback would order it before everything. Refused rather than sorted.
    expect(() => duplicateMigrationStamps(['not-a-stamp_a'])).toThrow(/numeric stamp/);
  });
});

describe('rollbackTo, against a real database', () => {
  it('reverses the newest migration and leaves the earlier one applied', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      expect(tables(db.path)).toContain('users');
      expect(appliedNames(db.path)).toEqual([
        INIT,
        USERS,
        WBS,
        DEPS,
        ACCESS,
        METHOD,
        CAL,
        TEAMS,
        REVISIONS,
        JOURNAL,
        ROLE_POSITION,
        PRIORITY,
        TEAM_SLOTS,
        MAX_PARALLEL,
        PER_PROJECT_CAPACITY,
        WORK_ITEM_TEAM,
        PRIORITY_BANDS,
        PLAN_EVENT,
        ACTUAL,
        ROLE_PROGRESS,
        NOT_BEFORE_REASON,
        TAG,
        SERVICE,
        WORK_ITEM_SERVICE,
      ]);

      const reversed = rollbackTo(db.path, FOLDER, INIT);

      expect(reversed).toEqual([
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
        ROLE_PROGRESS,
        ACTUAL,
        PLAN_EVENT,
        PRIORITY_BANDS,
        WORK_ITEM_TEAM,
        PER_PROJECT_CAPACITY,
        MAX_PARALLEL,
        TEAM_SLOTS,
        PRIORITY,
        ROLE_POSITION,
        JOURNAL,
        REVISIONS,
        TEAMS,
        CAL,
        METHOD,
        ACCESS,
        DEPS,
        WBS,
        USERS,
      ]);
      expect(tables(db.path)).not.toContain('users');
      // The earlier migration's tables are untouched, which is the difference
      // between a rollback and a reset.
      expect(tables(db.path)).toContain('examples');
      expect(appliedNames(db.path)).toEqual([INIT]);
    } finally {
      db.cleanup();
    }
  });

  it('re-applies cleanly after a rollback', () => {
    // The bookkeeping row and the schema must come off together. If the row
    // survived, this second migrate would skip the migration and leave the
    // database missing the table it believes is there.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, INIT);
      runMigrations(db.path, FOLDER);

      expect(tables(db.path)).toContain('users');
      expect(appliedNames(db.path)).toEqual([
        INIT,
        USERS,
        WBS,
        DEPS,
        ACCESS,
        METHOD,
        CAL,
        TEAMS,
        REVISIONS,
        JOURNAL,
        ROLE_POSITION,
        PRIORITY,
        TEAM_SLOTS,
        MAX_PARALLEL,
        PER_PROJECT_CAPACITY,
        WORK_ITEM_TEAM,
        PRIORITY_BANDS,
        PLAN_EVENT,
        ACTUAL,
        ROLE_PROGRESS,
        NOT_BEFORE_REASON,
        TAG,
        SERVICE,
        WORK_ITEM_SERVICE,
      ]);
    } finally {
      db.cleanup();
    }
  });

  it('unwinds every migration when there was no baseline', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const reversed = rollbackTo(db.path, FOLDER, ROLLBACK_ALL);

      expect(reversed).toEqual([
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
        ROLE_PROGRESS,
        ACTUAL,
        PLAN_EVENT,
        PRIORITY_BANDS,
        WORK_ITEM_TEAM,
        PER_PROJECT_CAPACITY,
        MAX_PARALLEL,
        TEAM_SLOTS,
        PRIORITY,
        ROLE_POSITION,
        JOURNAL,
        REVISIONS,
        TEAMS,
        CAL,
        METHOD,
        ACCESS,
        DEPS,
        WBS,
        USERS,
        INIT,
      ]);
      for (const t of [
        'users',
        'examples',
        'event_log',
        'event_sequencer',
        'project',
        'work_item',
        'role',
        'estimate',
      ]) {
        expect(tables(db.path)).not.toContain(t);
      }
      expect(appliedNames(db.path)).toEqual([]);
    } finally {
      db.cleanup();
    }
  });

  it('does nothing when the target is already the newest applied', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      // The newest applied migration, which is what makes this the case a shared
      // stamp breaks: `migrationsToRollback` filters on `created_at >` strictly,
      // so a baseline that shares its stamp with another folder answers `[]` here
      // *and* answers `[]` when there is genuinely something to reverse. Reading
      // `[]` as correct is only safe while every stamp is unique, which
      // `readMigrationFolders` now enforces.
      expect(rollbackTo(db.path, FOLDER, WORK_ITEM_SERVICE)).toEqual([]);
      expect(tables(db.path)).toContain('users');
    } finally {
      db.cleanup();
    }
  });

  it('refuses when the applied migration no longer matches the file on disk', () => {
    // A forward migration edited after it was applied means its down.sql
    // describes a different change than the one in the database.
    const db = tempDb();
    const copy = mkdtempSync(join(tmpdir(), 'wbs-drift-'));
    try {
      runMigrations(db.path, FOLDER);
      cpSync(FOLDER, copy, { recursive: true });
      appendFileSync(join(copy, USERS, 'migration.sql'), '\n-- edited after the fact\n');

      expect(() => rollbackTo(db.path, copy, INIT)).toThrow(/hash differs/);
      expect(tables(db.path)).toContain('users');
    } finally {
      db.cleanup();
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
