import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const STEP_POSITION = '20260809090000_add_role_position';
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
const STEP_PROGRESS = '20260818010000_add_role_progress';
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
/**
 * The newest. A table of its own referencing `work_item` and `role` again, so it
 * reverses ahead of the domain that holds both — `ACTUAL`'s place for `ACTUAL`'s
 * reason.
 *
 * Stamped `20260821140000`, later than every folder on disk when it was written
 * **and** later than the two `change/service-split` added, which it was stamped
 * against while that branch was still in review. It merged first (`04d644e`),
 * this branch was rebased onto it, and the two folders are the two above — so
 * the guess the stamp was written on is now a fact on disk, and a stamp sorting
 * before them would have applied out of order on any database that took that
 * release. The duplicate check is `refuses a folder set that shares one stamp
 * between two migrations`.
 *
 * It was the newest when it was written. `PERSON_KIND` is now above it, so this
 * constant has moved into the *one before the newest* half of `does nothing when
 * the target is already the newest applied` — the half that answers with what is
 * newer than it, and the one a shared stamp would silently empty.
 */
const STEP_MEASURE = '20260821140000_add_role_measure';
/**
 * The newest, and the only migration in this change that alters a table rather
 * than adding one: `person.kind`, by `ALTER TABLE … ADD COLUMN` with a
 * column-level `CHECK`.
 *
 * It reverses by `DROP COLUMN`, which SQLite documents as unavailable while a
 * constraint names the column and which bun's SQLite 3.53.0 performs anyway,
 * taking the `CHECK` with it. That is verified here rather than trusted — the
 * rollback cases assert the original DDL, the rows, the memberships and the
 * `person_name` unique index — so a future SQLite that enforces the documented
 * restriction fails this suite instead of failing a deploy.
 *
 * Stamped `20260821150000`, later than every folder on disk.
 */
const PERSON_KIND = '20260821150000_add_person_kind';
const OIDC_IDENTITY = '20260824010000_add_oidc_identity';
const SOLUTION_REF = '20260824020000_add_solution_ref';
const WORK_ITEM_TYPE = '20260830010000_add_work_item_type';
const EXTERNAL_REF = '20260830020000_add_external_ref';
/**
 * The newest, and a column on `project` alone: `dep_reach`, `NOT NULL DEFAULT
 * 'whole-item'`, added by `dep-reach-whole-item`. Additive forward, dropped by
 * its own `down.sql`, so it appears in the order and in nothing else this file
 * checks.
 *
 * Stamped `20260830120000` on the rebase, past both folders above: it was
 * written as `20260829120000` while they were still on a branch, and a stamp
 * sorting **before** an already-applied migration applies out of order on every
 * database that took that release. Same trap as the 2026-08-14 collision this
 * file's duplicate-stamp check was written for, one direction along.
 */
const DEP_REACH = '20260830120000_add_dep_reach';

/**
 * The estimate weights and the per-step rounding, stamped after the reach
 * above. Additive like it, and its `down.sql` drops the four columns, so it
 * appears in the order and in nothing else this file checks.
 */
const WEIGHTS_AND_ROUNDING = '20260830130000_add_estimate_weights_and_rounding';

/**
 * The only migration on disk that renames rather than adds: `role` -> `step`
 * with the columns and indexes that carry the word. It is the one whose rollback
 * is a **total** inverse — nothing is created, dropped or defaulted — which is
 * why `the step rename rolls back to the schema it found` below compares the
 * whole schema and every row rather than counting tables.
 */
const RENAME_ROLE_TO_STEP = '20260831120000_rename_role_to_step';

/**
 * The newest: the audit columns, on the 26 tables that hold a domain record.
 * Additive forward and dropped whole on the way back, so it heads the folder
 * order and every descending reversal list below.
 */
const SAVED_PLAN = '20260903190000_add_saved_plan';
/**
 * The newest, and the one that separates the two `created_by` questions:
 * `saved_plan.created_by_id`, the account the permission rule reads, beside
 * the display name the record keeps by value (assumption A-8). One nullable
 * column added and dropped whole, so it heads every descending reversal list
 * below and tails the ascending folder order.
 */
const CREATED_BY_ID = '20260904020000_add_saved_plan_created_by_id';
/**
 * The newest: `calendar_marker`, one table and one index added whole, so it
 * heads every descending reversal list below and tails the ascending folder
 * order. Its own rollback and cascade cases live in
 * `calendar-marker-migration.db.test.ts`; this file only fixes its place in the
 * order.
 */
const CALENDAR_MARKER = '20260905090000_add_calendar_marker';

const LOOKUP_INDEXES = '20260902120000_add_lookup_indexes';

/**
 * The newest, and the optimizer's own: four tables plus one nullable column on
 * `project`. Additive forward and dropped whole by its own `down.sql`, so it
 * appears in the order and in nothing else this file checks — except that it
 * now **heads** every descending reversal list below, because the newest
 * migration is the first thing any rollback reverses.
 */
const OPTIMIZER_TABLES = '20260904100000_add_optimizer_tables';
/**
 * The newest: the three project settings the optimizer is steered by, on
 * `project`. Additive forward and dropped column by named column on the way
 * back, so it now **heads** every descending reversal list below and tails
 * every ascending one — the newest migration is the first thing any rollback
 * reverses.
 */
const PROJECT_SETTINGS = '20260904140000_add_project_settings';
const AUDIT_COLUMNS = '20260901120000_add_audit_columns';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-migrate-down-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Every schema object this database holds, as one comparable list: type, name
 * and the exact `CREATE` text SQLite stored for it.
 *
 * The `sql` text is the load-bearing half and the reason {@link tables} is not
 * enough here. A rename that was reversed for the table and not for one of its
 * columns leaves the same table list, the same row counts and the same values —
 * only this string moves (design D3). `__drizzle_migrations` is excluded
 * because its rows are bookkeeping about the rollback itself;
 * {@link appliedNames} asserts those separately.
 *
 * **Quote characters are normalised, and nothing else is.** SQLite rewrites the
 * stored `CREATE` text on an `ALTER TABLE ... RENAME`, and it re-quotes the
 * identifiers it touched with `"` where drizzle wrote them in backticks — so a
 * table that has been renamed and renamed back comes out as
 * `CREATE TABLE "role_progress" ( work_item_id text NOT NULL, "role_id" text
 * ...`, semantically the schema it started as and textually not. Observed
 * 2026-08-31 as a 23-line diff in this test, every line of it a quote
 * character. Collapsing both quote styles to one keeps every **name** in the
 * comparison, which is what the fault this test exists for moves; comparing raw
 * text instead would fail on every correct rollback and pass on none.
 */
function schemaObjects(dbPath: string): { type: string; name: string; sql: string }[] {
  const db = openDatabase(dbPath);
  try {
    return db
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY type, name",
      )
      .all()
      .map((r) => ({
        type: r.type,
        name: r.name,
        sql: (r.sql ?? '(implicit)').replace(/[`"]/g, "'"),
      }));
  } finally {
    db.close();
  }
}

/**
 * Every user table's rows, keyed by table name, each row an object keyed by
 * column name.
 *
 * Keyed by column name deliberately: a `SELECT *` of positional tuples would
 * compare equal across a column that came back under the wrong name, which is
 * exactly the fault this snapshot exists to catch. Ordered by `rowid` so the
 * comparison is about contents rather than about SQLite's scan order.
 */
function tableRows(dbPath: string): Record<string, unknown[]> {
  const db = openDatabase(dbPath);
  try {
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    const rows: Record<string, unknown[]> = {};
    for (const name of names) {
      rows[name] = db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all();
    }
    return rows;
  } finally {
    db.close();
  }
}

/**
 * A row in every table the role -> step rename touches, written under the
 * **pre-rename** names because that is the schema it is written against.
 *
 * `role`, `role_id`, `role_progress`, `role_measure` here are deliberate and
 * must not be swept to `step_*` with the rest of the file: this function runs
 * against the migration folder with `20260831120000_rename_role_to_step`
 * pruned out, so those are the only names that exist when it runs.
 *
 * A round trip over an empty database would compare two empty schemas and pass
 * with any `down.sql` that happened to restore the table names — so the seed is
 * part of the check, not scenery.
 */
function seedEveryRenamedTable(dbPath: string): void {
  const db = openDatabase(dbPath);
  try {
    db.run(
      "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
    );
    db.run(
      'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
        " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
    );
    db.run("INSERT INTO role (id, project_id, name, position) VALUES ('r1', 'p', 'Dev', 10)");
    db.run("INSERT INTO role (id, project_id, name, position) VALUES ('r2', 'p', 'QA', 20)");
    db.run(
      'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, priority, max_parallel, revision)' +
        " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 25, 1, 0)",
    );
    db.run(
      'INSERT INTO estimate (work_item_id, role_id, optimistic, realistic, pessimistic)' +
        " VALUES ('w1', 'r1', 1, 2, 3)",
    );
    db.run(
      "INSERT INTO actual (work_item_id, role_id, days, recorded_at) VALUES ('w1', 'r1', 8, 1000)",
    );
    db.run(
      "INSERT INTO role_progress (work_item_id, role_id, state, stated_at) VALUES ('w1', 'r1', 'done', 2000)",
    );
    db.run(
      'INSERT INTO role_measure (work_item_id, role_id, metric, value, recorded_at)' +
        " VALUES ('w1', 'r1', 'token_actual', 4000000, 2000)",
    );
    db.run("INSERT INTO person (id, name) VALUES ('pe1', 'Ada')");
    db.run("INSERT INTO assignment (work_item_id, role_id, person_id) VALUES ('w1', 'r1', 'pe1')");
    db.run(
      'INSERT INTO plan_event (id, project_id, user_id, kind, label, work_item_id, role_id, before, after, created_at)' +
        " VALUES ('e1', 'p', 'u', 'estimate', 'estimate Strip', 'w1', 'r1'," +
        ' \'{"do":"clear_estimate"}\', \'{"do":"set_estimate"}\', 1000)',
    );
  } finally {
    db.close();
  }
}

/**
 * The migration folder as it stood **before** one migration — that folder and
 * every folder older than it, and nothing newer.
 *
 * This used to prune the named migration alone, which was the same thing only
 * while the named one was the newest on disk. `20260901120000_add_audit_columns`
 * ended that: it says `ALTER TABLE step ADD …`, so it cannot run against a
 * database where `20260831120000_rename_role_to_step` never renamed `role` —
 * `DrizzleError: Failed to run the query 'ALTER TABLE step ADD created_at
 * integer;'`, watched 2026-09-01. A migration is entitled to depend on every
 * migration older than it, so "all except one" is not a schema that ever
 * existed; "everything up to one" is.
 */
function folderBefore(oldest: string): { path: string; cleanup: () => void } {
  const copy = mkdtempSync(join(tmpdir(), 'wbs-pre-rename-'));
  cpSync(FOLDER, copy, { recursive: true });
  for (const folder of readdirSync(copy)) {
    if (folder >= oldest) rmSync(join(copy, folder), { recursive: true, force: true });
  }
  return {
    path: copy,
    cleanup: () => {
      rmSync(copy, { recursive: true, force: true });
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

/** The `project` table's column names, in declaration order. */
function projectColumns(dbPath: string): string[] {
  const db = openDatabase(dbPath);
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('project')")
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
      STEP_POSITION,
      PRIORITY,
      TEAM_SLOTS,
      MAX_PARALLEL,
      PER_PROJECT_CAPACITY,
      WORK_ITEM_TEAM,
      PRIORITY_BANDS,
      PLAN_EVENT,
      ACTUAL,
      STEP_PROGRESS,
      NOT_BEFORE_REASON,
      TAG,
      SERVICE,
      WORK_ITEM_SERVICE,
      STEP_MEASURE,
      PERSON_KIND,
      OIDC_IDENTITY,
      SOLUTION_REF,
      WORK_ITEM_TYPE,
      EXTERNAL_REF,
      DEP_REACH,
      WEIGHTS_AND_ROUNDING,
      RENAME_ROLE_TO_STEP,
      AUDIT_COLUMNS,
      LOOKUP_INDEXES,
      SAVED_PLAN,
      CREATED_BY_ID,
      OPTIMIZER_TABLES,
      PROJECT_SETTINGS,
      CALENDAR_MARKER,
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
        STEP_POSITION,
        PRIORITY,
        TEAM_SLOTS,
        MAX_PARALLEL,
        PER_PROJECT_CAPACITY,
        WORK_ITEM_TEAM,
        PRIORITY_BANDS,
        PLAN_EVENT,
        ACTUAL,
        STEP_PROGRESS,
        NOT_BEFORE_REASON,
        TAG,
        SERVICE,
        WORK_ITEM_SERVICE,
        STEP_MEASURE,
        PERSON_KIND,
        OIDC_IDENTITY,
        SOLUTION_REF,
        WORK_ITEM_TYPE,
        EXTERNAL_REF,
        DEP_REACH,
        WEIGHTS_AND_ROUNDING,
        RENAME_ROLE_TO_STEP,
        AUDIT_COLUMNS,
        LOOKUP_INDEXES,
        SAVED_PLAN,
        CREATED_BY_ID,
        OPTIMIZER_TABLES,
        PROJECT_SETTINGS,
        CALENDAR_MARKER,
      ]);

      const reversed = rollbackTo(db.path, FOLDER, INIT);

      expect(reversed).toEqual([
        CALENDAR_MARKER,
        PROJECT_SETTINGS,
        OPTIMIZER_TABLES,
        CREATED_BY_ID,
        SAVED_PLAN,
        LOOKUP_INDEXES,
        AUDIT_COLUMNS,
        RENAME_ROLE_TO_STEP,
        WEIGHTS_AND_ROUNDING,
        DEP_REACH,
        EXTERNAL_REF,
        WORK_ITEM_TYPE,
        SOLUTION_REF,
        OIDC_IDENTITY,
        PERSON_KIND,
        STEP_MEASURE,
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
        STEP_PROGRESS,
        ACTUAL,
        PLAN_EVENT,
        PRIORITY_BANDS,
        WORK_ITEM_TEAM,
        PER_PROJECT_CAPACITY,
        MAX_PARALLEL,
        TEAM_SLOTS,
        PRIORITY,
        STEP_POSITION,
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
        STEP_POSITION,
        PRIORITY,
        TEAM_SLOTS,
        MAX_PARALLEL,
        PER_PROJECT_CAPACITY,
        WORK_ITEM_TEAM,
        PRIORITY_BANDS,
        PLAN_EVENT,
        ACTUAL,
        STEP_PROGRESS,
        NOT_BEFORE_REASON,
        TAG,
        SERVICE,
        WORK_ITEM_SERVICE,
        STEP_MEASURE,
        PERSON_KIND,
        OIDC_IDENTITY,
        SOLUTION_REF,
        WORK_ITEM_TYPE,
        EXTERNAL_REF,
        DEP_REACH,
        WEIGHTS_AND_ROUNDING,
        RENAME_ROLE_TO_STEP,
        AUDIT_COLUMNS,
        LOOKUP_INDEXES,
        SAVED_PLAN,
        CREATED_BY_ID,
        OPTIMIZER_TABLES,
        PROJECT_SETTINGS,
        CALENDAR_MARKER,
      ]);
    } finally {
      db.cleanup();
    }
  });

  it('puts every project already on disk onto the whole-item reach, and takes the column away again', () => {
    // `dep-reach-whole-item`'s headline, at the layer that actually decides it:
    // the column's default is what carries an **existing** row onto the new
    // rule. So the row is written while the column does not exist yet — rolled
    // back to `SOLUTION_REF` first — and read after the forward migration.
    //
    // The rollback half is asserted too, because a `down.sql` that left the
    // column standing would make the next forward run fail on a duplicate
    // column name rather than here.
    //
    // Proof: the migration's `DEFAULT 'whole-item'` changed to
    // `DEFAULT 'anchor-slice'` and this failed on `{"dep_reach": "whole-item"}`
    // against a received `{"dep_reach": "anchor-slice"}` — an existing row left
    // on the August rule, which is the one thing the column default is for.
    //
    // Proof: `down.sql` replaced by a valid statement that does not drop the
    // column (`UPDATE project SET dep_reach = 'whole-item';`) and this failed on
    // `Expected to not contain: "dep_reach"`. Both watched 2026-08-29.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, SOLUTION_REF);
      expect(projectColumns(db.path)).not.toContain('dep_reach');

      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1', 'owner', 'x', 1)",
        );
        before.run(
          "INSERT INTO project (id, name, owner_id, created_at) VALUES ('p1', 'Rewire the shed', 'u1', 1)",
        );
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      expect(projectColumns(db.path)).toContain('dep_reach');
      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<{ dep_reach: string }, []>("SELECT dep_reach FROM project WHERE id = 'p1'")
            .get(),
        ).toEqual({ dep_reach: 'whole-item' });
      } finally {
        after.close();
      }

      rollbackTo(db.path, FOLDER, SOLUTION_REF);
      expect(projectColumns(db.path)).not.toContain('dep_reach');
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
        CALENDAR_MARKER,
        PROJECT_SETTINGS,
        OPTIMIZER_TABLES,
        CREATED_BY_ID,
        SAVED_PLAN,
        LOOKUP_INDEXES,
        AUDIT_COLUMNS,
        RENAME_ROLE_TO_STEP,
        WEIGHTS_AND_ROUNDING,
        DEP_REACH,
        EXTERNAL_REF,
        WORK_ITEM_TYPE,
        SOLUTION_REF,
        OIDC_IDENTITY,
        PERSON_KIND,
        STEP_MEASURE,
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
        STEP_PROGRESS,
        ACTUAL,
        PLAN_EVENT,
        PRIORITY_BANDS,
        WORK_ITEM_TEAM,
        PER_PROJECT_CAPACITY,
        MAX_PARALLEL,
        TEAM_SLOTS,
        PRIORITY,
        STEP_POSITION,
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
        // `step` since 20260831120000_rename_role_to_step; a rollback all the
        // way to INIT reverses that rename first, so by the time the WBS
        // migration is reversed the table is `role` again and neither name
        // survives. Both are asserted absent for that reason.
        'role',
        'step',
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
      // Rolling back *to* the newest applied reverses nothing. Each step down
      // names everything newer than its target, newest first — which is the half
      // a shared stamp would silently empty.
      //
      // The newest is read off disk rather than named: this line asserted
      // `AUDIT_COLUMNS` and before that the role → step rename, and each new
      // migration broke it in a way that says nothing about rollback.
      const newest = readMigrationFolders(FOLDER).at(-1)?.name;
      expect(newest).toBeDefined();
      expect(rollbackTo(db.path, FOLDER, newest ?? '')).toEqual([]);
      expect(rollbackTo(db.path, FOLDER, AUDIT_COLUMNS)).toEqual([
        CALENDAR_MARKER,
        PROJECT_SETTINGS,
        OPTIMIZER_TABLES,
        CREATED_BY_ID,
        SAVED_PLAN,
        LOOKUP_INDEXES,
      ]);
      expect(rollbackTo(db.path, FOLDER, RENAME_ROLE_TO_STEP)).toEqual([AUDIT_COLUMNS]);
      expect(rollbackTo(db.path, FOLDER, WEIGHTS_AND_ROUNDING)).toEqual([RENAME_ROLE_TO_STEP]);
      expect(rollbackTo(db.path, FOLDER, DEP_REACH)).toEqual([WEIGHTS_AND_ROUNDING]);
      expect(rollbackTo(db.path, FOLDER, EXTERNAL_REF)).toEqual([DEP_REACH]);
      // Only the reach, because the line above already reversed it —
      // `rollbackTo` performs the rollback rather than describing it, so each
      // step here starts from what the previous one left.
      expect(rollbackTo(db.path, FOLDER, WORK_ITEM_TYPE)).toEqual([EXTERNAL_REF]);
      expect(rollbackTo(db.path, FOLDER, SOLUTION_REF)).toEqual([WORK_ITEM_TYPE]);
      expect(rollbackTo(db.path, FOLDER, OIDC_IDENTITY)).toEqual([SOLUTION_REF]);
      expect(tables(db.path)).toContain('users');
    } finally {
      db.cleanup();
    }
  });

  /**
   * The round trip design D3 asks for: apply the rename, reverse it, and assert
   * the database is byte-for-byte the one it found — schema text included.
   *
   * The "before" is taken against the migration folder with the rename pruned
   * out, so it is the real pre-rename schema rather than a description of one.
   * The mid-flight assertions are there so the comparison cannot pass by the
   * rename never having happened.
   *
   * Proof: `ALTER TABLE estimate RENAME COLUMN step_id TO step_id;` deleted from
   * the migration's `down.sql`, watched failing here on the SCHEMA comparison —
   * `expect(received).toEqual(expected)` with the diff being exactly
   * `- 'step_id' text NOT NULL / + 'step_id' text NOT NULL` and the same
   * substitution in `estimate_pk` and the FK clause.
   *
   * And D3's claim about *why* the schema text is compared was checked rather
   * than assumed: with that same fault still in `down.sql`, this test reduced to
   * the row-count loop alone — the schema and keyed-row comparisons removed —
   * **passed**. A column that came back under the wrong name holds every value
   * it held before, so counting rows cannot see it. Both observed 2026-08-31.
   */
  it('the step rename rolls back to the schema it found', () => {
    const db = tempDb();
    const preRename = folderBefore(RENAME_ROLE_TO_STEP);
    try {
      runMigrations(db.path, preRename.path);
      seedEveryRenamedTable(db.path);
      const schemaBefore = schemaObjects(db.path);
      const rowsBefore = tableRows(db.path);
      // The seed is the check's substance; an empty database would compare two
      // empty snapshots and pass on any down.sql that restored the names.
      expect(rowsBefore['role']).toHaveLength(2);
      expect(rowsBefore['estimate']).toHaveLength(1);
      expect(schemaBefore.map((o) => o.name)).toContain('role_project_name');

      runMigrations(db.path, FOLDER);

      // The rename really happened, or everything below is a comparison of two
      // identical databases.
      expect(tables(db.path)).toContain('step');
      expect(tables(db.path)).not.toContain('role');
      expect(appliedNames(db.path)).toContain(RENAME_ROLE_TO_STEP);
      expect(schemaObjects(db.path).map((o) => o.name)).toContain('step_project_name');

      // Descending — newest reversed first — so the audit columns come off
      // before the rename they were written against.
      expect(rollbackTo(db.path, FOLDER, WEIGHTS_AND_ROUNDING)).toEqual([
        CALENDAR_MARKER,
        PROJECT_SETTINGS,
        OPTIMIZER_TABLES,
        CREATED_BY_ID,
        SAVED_PLAN,
        LOOKUP_INDEXES,
        AUDIT_COLUMNS,
        RENAME_ROLE_TO_STEP,
      ]);

      // Schema first: this is the assertion the missing-rename fault moves, and
      // the two below it are the ones that cannot see it.
      expect(schemaObjects(db.path)).toEqual(schemaBefore);
      const rowsAfter = tableRows(db.path);
      expect(Object.keys(rowsAfter)).toEqual(Object.keys(rowsBefore));
      for (const [table, before] of Object.entries(rowsBefore)) {
        expect(rowsAfter[table]).toHaveLength(before.length);
      }
      expect(rowsAfter).toEqual(rowsBefore);
      expect(appliedNames(db.path)).not.toContain(RENAME_ROLE_TO_STEP);
    } finally {
      preRename.cleanup();
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
