import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { openDatabase } from './db';
import { runMigrations } from './migrate';
import { rollbackTo } from './migrate-down';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
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
// One table of its own, referencing `project` and `users`, so it reverses first.
const JOURNAL = '20260807180000_add_command_journal';
// A column on `role`, so like the revisions it appears in the order and nowhere else here.
const ROLE_POSITION = '20260809090000_add_role_position';
// A column on `work_item`, the same shape again: it appears in the order, and
// in the two cases of its own at the bottom of this file.
const PRIORITY = '20260811100000_add_priority';
// The two capacity columns, in application order. Both are columns on existing
// tables, so like the revisions they appear in the order and in their own
// cases at the bottom of this file.
const TEAM_SLOTS = '20260812100000_add_team_slots';
const MAX_PARALLEL = '20260812100001_add_max_parallel';
// A table of its own, referencing `project` and `service_team`, so it reverses
// before the domain and appears in the ordering case as well as in its own.
const PER_PROJECT_CAPACITY = '20260813120000_add_project_team_capacity';
// A table of its own again, referencing `work_item` and `service_team`, so it
// reverses before the domain and before the directory that holds both.
const WORK_ITEM_TEAM = '20260814100000_add_work_item_team';
/**
 * A table of its own and the newest, so it is the first thing any rollback
 * reverses. Renumbered to `110000` on the rebase — `100000` is
 * {@link WORK_ITEM_TEAM}'s stamp on main, and one stamp shared by two folders is
 * one `created_at` shared by two rows, which `migrationsToRollback`'s strict
 * `created_at >` cannot separate. See verify.md.
 */
const PRIORITY_BANDS = '20260814110000_add_priority_band';
/**
 * The newest: a table of its own referencing `project` and `users`, so it
 * reverses ahead of both. Stamped three days past `PRIORITY_BANDS`, checked
 * against every folder on disk first — `readMigrationFolders` now refuses a
 * shared stamp outright, which is what the 2026-08-14 collision cost.
 */
const PLAN_EVENT = '20260817120000_add_plan_event';
/**
 * The newest: a table of its own referencing `work_item` and `role`, so it
 * reverses ahead of the domain that holds both. Stamped an hour past
 * {@link PLAN_EVENT} and checked against every folder on disk before the folder
 * was created — `readMigrationFolders` refuses a shared stamp outright, and this
 * is the first migration written under that guard rather than beside it.
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
 * The newest, and a **column** on `work_item` rather than a table — so it
 * appears in the ordering here, in the two cases of its own at the bottom of
 * this file, and in no table list anywhere.
 *
 * Stamped `20260818090000`, later than all twenty folders that were on disk when
 * it was written. The stamps were listed and checked for a duplicate before the
 * folder existed — verify.md quotes the run — and `refuses a folder set that
 * shares one stamp between two migrations` is the mechanical half of the same
 * check.
 */
const NOT_BEFORE_REASON = '20260818090000_add_not_before_reason';
/**
 * The newest, and **two** tables in one folder — the directory and its join.
 *
 * Stamped `20260819120000`, later than all twenty-one folders that were on disk
 * when it was written. The stamps were listed and checked for a duplicate before
 * the folder existed — verify.md quotes the run — and `refuses a folder set that
 * shares one stamp between two migrations` in `migrate-down.test.ts` is the
 * mechanical half of the same check.
 */
const TAG = '20260819120000_add_tag';
/**
 * The only migration so far that adds **two tables and a column** in one folder —
 * the service directory, the team↔service ownership map, and
 * `work_item.service_id`. So it appears in the ordering here, in the table
 * lists, _and_ in the column cases at the bottom of this file.
 *
 * Stamped `20260821000000`, later than all twenty-two folders that were on disk
 * when it was written. The stamps were listed and checked for a duplicate before
 * the folder existed — verify.md quotes the run — and `refuses a folder set that
 * shares one stamp between two migrations` in `migrate-down.test.ts` is the
 * mechanical half of the same check.
 */
const SERVICE = '20260821000000_add_service';
/**
 * The newest. It widens the service dimension from the column the folder above
 * added to a set, eight hours later — Dany, 2026-08-21, _"can be several
 * services"_ — and it is the **only migration in this repo that seeds a table
 * from data already on the box**, which is why it has cases about rows and not
 * only about shapes.
 *
 * It drops nothing. `work_item.service_id` stays, unread by the release this
 * arrives with and still selected by the one it arrives beside during a
 * blue/green swap.
 *
 * Stamped `20260821080000`, later than all twenty-three folders on disk when it
 * was written. The stamps were listed and checked for a duplicate before the
 * folder existed — verify.md quotes the run — and `refuses a folder set that
 * shares one stamp between two migrations` in `migrate-down.test.ts` is the
 * mechanical half of the same check.
 *
 * The duplicate-stamp one-liner is deliberately **not** quoted here, and that is
 * worth a line: its `sed` script ends in a slash-star-slash sequence that closes
 * a block comment, so pasting it into this JSDoc made the whole file a syntax
 * error — and bun reported that as fifty tests quietly not running rather than
 * as a failure. `migration.sql` quotes it safely, in a `--` comment.
 */
const WORK_ITEM_SERVICE = '20260821080000_add_work_item_service';

const WBS_TABLES = ['project', 'work_item', 'role', 'estimate'] as const;
// Its own migration, reversed with the domain because it references `work_item`.
const DEPENDENCY_TABLES = ['dependency'] as const;
// Also its own, and also reversed with the domain: it references `project`.
const ACCESS_TABLES = ['project_access'] as const;
// Also its own, and reversed with the domain: they reference `work_item`.
const DIRECTORY_TABLES = ['service_team', 'person', 'person_team', 'assignment'] as const;
// Its own migration, reversed with the domain: it references both `project` and
// `service_team`, so it cannot outlive either.
const CAPACITY_TABLES = ['project_team_capacity'] as const;
// Its own migration, reversed with the domain: it references `work_item`.
const TEAM_SET_TABLES = ['work_item_team'] as const;
// Its own migration, reversed with the domain: it references `work_item` and
// `role`, so it cannot outlive either.
const ACTUAL_TABLES = ['actual'] as const;
// Its own migration, reversed with the domain for `ACTUAL_TABLES`' reason: it
// references `work_item` and `role` too.
const ROLE_PROGRESS_TABLES = ['role_progress'] as const;
// Its own migration, and the only one that adds two tables. `work_item_tag`
// references `work_item`, so both reverse with the domain; `tag` itself
// references nothing and reverses with them only because they arrived together.
const TAG_TABLES = ['tag', 'work_item_tag'] as const;
// Its own migration, and the first to add two tables *and* a column.
// `team_service` references `service_team` and `service`, so it reverses with the
// directory; `service` itself is referenced by a `work_item` column, which is why
// the column is dropped before the table it points at.
const SERVICE_TABLES = ['service', 'team_service'] as const;
// Its own migration, reversed with the domain: it references `work_item` and
// `service`, so it cannot outlive either. `TAG_TABLES`' `work_item_tag` half
// with no vocabulary table beside it — the vocabulary arrived one migration
// earlier, when this dimension held one value per row.
const WORK_ITEM_SERVICE_TABLES = ['work_item_service'] as const;

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-migrate-'));
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

describe('the WBS domain migration', () => {
  it('creates the four domain tables', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      for (const t of [
        ...WBS_TABLES,
        ...DEPENDENCY_TABLES,
        ...ACCESS_TABLES,
        ...DIRECTORY_TABLES,
        ...CAPACITY_TABLES,
        ...TEAM_SET_TABLES,
        ...ACTUAL_TABLES,
        ...ROLE_PROGRESS_TABLES,
        ...TAG_TABLES,
        ...SERVICE_TABLES,
        ...WORK_ITEM_SERVICE_TABLES,
      ])
        expect(tables(db.path)).toContain(t);
    } finally {
      db.cleanup();
    }
  });

  it('reverses to the accounts schema without touching it', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);

      const reversed = rollbackTo(db.path, FOLDER, USERS);

      // Newest first. The three capacity migrations reverse in the opposite
      // order to the one they were applied in, which is the whole of the
      // rollback ordering claim: `project_team_capacity` down, then
      // `max_parallel` down, then `size` down. The per-project table reverses
      // ahead of the column it was seeded from, which is the only order in
      // which its foreign keys still have something to point at.
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
      ]);
      for (const t of [
        ...WBS_TABLES,
        ...DEPENDENCY_TABLES,
        ...ACCESS_TABLES,
        ...DIRECTORY_TABLES,
        ...CAPACITY_TABLES,
        ...TEAM_SET_TABLES,
        ...ACTUAL_TABLES,
        ...ROLE_PROGRESS_TABLES,
        ...TAG_TABLES,
        ...SERVICE_TABLES,
        ...WORK_ITEM_SERVICE_TABLES,
      ])
        expect(tables(db.path)).not.toContain(t);
      // Reversing the domain must not take the accounts with it: the two
      // migrations are separately deployable and a failed domain release
      // leaves everyone still able to log in.
      expect(tables(db.path)).toContain('users');
      expect(tables(db.path)).toContain('examples');
    } finally {
      db.cleanup();
    }
  });
});

describe('the role position migration', () => {
  it('gives roles already in the database the order they were written in', () => {
    // The backfill, against rows that existed before the column did — which is
    // every project on the live server and the only situation that `UPDATE` is
    // for. Reached by rolling back to the migration before it, writing roles
    // the way the previous release wrote them, and migrating forward again.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, JOURNAL);
      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        before.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        // Written in the order the seed writes them and deliberately not in the
        // order their names sort: a backfill reading the index rather than the
        // rowid would hand these back the other way round.
        before.run("INSERT INTO role (id, project_id, name) VALUES ('r1', 'p', 'Zebra')");
        before.run("INSERT INTO role (id, project_id, name) VALUES ('r2', 'p', 'Alpha')");
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      const after = openDatabase(db.path);
      try {
        const rows = after
          .query<
            { id: string; position: number },
            []
          >('SELECT id, position FROM role ORDER BY position')
          .all();
        expect(rows.map((row) => row.id)).toEqual(['r1', 'r2']);
        expect(rows[0]?.position).toBeLessThan(rows[1]?.position ?? 0);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep inserting roles against the migrated schema', () => {
    // The half of a swap nothing else covers. be-01 blue and green share one
    // SQLite file, green migrates while blue is still serving, and blue's
    // `INSERT` names the three columns it was compiled against. Without the
    // column's default that statement fails, and adding a role on the old
    // colour answers 500 for the length of the swap.
    //
    // The statement is written out here rather than built through drizzle
    // precisely because drizzle is the *new* release: the point is what the old
    // one sends over the wire.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );

        sqlite.run("INSERT INTO role (id, project_id, name) VALUES ('r1', 'p', 'Design')");

        const written = sqlite
          .query<{ position: number }, []>("SELECT position FROM role WHERE id = 'r1'")
          .get();
        // First rather than last, which is the one thing the default costs: a
        // colour-swap window's worth of wrong order, against a row that would
        // otherwise not exist at all.
        expect(written?.position).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the priority migration', () => {
  it('lets the outgoing release keep inserting work items against the migrated schema', () => {
    // The blue/green half, the same shape the role position migration has:
    // green migrates while blue is still serving and blue's `INSERT` names the
    // columns it was compiled against. Written out rather than built through
    // drizzle, because drizzle is the new release and the point is what the old
    // one sends.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );

        sqlite.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 0)",
        );

        const written = sqlite
          .query<{ priority: number | null }, []>("SELECT priority FROM work_item WHERE id = 'w1'")
          .get();
        expect(written?.priority).toBeNull();
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('leaves work items that existed before the column with no priority', () => {
    // The other half of "nullable, no default", and the half a `DEFAULT 1`
    // would break silently: every plan on the live server was written before
    // this column existed, and a work item with no priority is placed *after*
    // every work item that has one. A default would make every row of every plan
    // the most important work in it and reorder the queues of every plan that
    // has people on it.
    //
    // Reached the way the role backfill case is: roll back to the migration
    // before this one, write a work item the way the previous release wrote
    // one, and migrate forward again.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, ROLE_POSITION);
      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        before.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        before.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 0)",
        );
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      const after = openDatabase(db.path);
      try {
        const row = after
          .query<{ priority: number | null }, []>('SELECT priority FROM work_item')
          .get();
        expect(row?.priority).toBeNull();
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the capacity migrations', () => {
  it('lets the outgoing release keep inserting work items and teams against both', () => {
    // The blue/green half, the same shape the priority and role-position
    // migrations have: green migrates while blue is still serving, and blue's
    // `INSERT` names the columns it was compiled against. Written out rather
    // than built through drizzle, because drizzle is the new release and the
    // point is what the old one sends.
    //
    // Proof: `DEFAULT 1` removed from `max_parallel` and this failed on that
    // exact statement with `NOT NULL constraint failed: work_item.max_parallel`;
    // watched 2026-08-12.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        sqlite.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 0)",
        );
        sqlite.run("INSERT INTO service_team (id, name) VALUES ('t1', 'Platform')");

        const item = sqlite
          .query<{ max_parallel: number }, []>("SELECT max_parallel FROM work_item WHERE id = 'w1'")
          .get();
        // One at a time, which is what the column's default says and what
        // every work item written before it did.
        expect(item?.max_parallel).toBe(1);
        const team = sqlite
          .query<{ size: number | null }, []>("SELECT size FROM service_team WHERE id = 't1'")
          .get();
        expect(team?.size).toBeNull();
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('leaves teams that existed before the column unsized', () => {
    // The other half of "nullable, no default", and the half a `DEFAULT 1`
    // would break silently: every team on the live server was written before
    // this column existed, and an unsized team constrains nothing. A default
    // of 1 would serialize every team's work on every plan that names one, on
    // the day the migration ran and with nobody having edited anything.
    //
    // Reached the way the priority backfill case is: roll back to the
    // migration before this one, write a team the way the previous release
    // wrote one, and migrate forward again.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PRIORITY);
      const before = openDatabase(db.path);
      try {
        before.run("INSERT INTO service_team (id, name) VALUES ('t1', 'Platform')");
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      const after = openDatabase(db.path);
      try {
        const row = after.query<{ size: number | null }, []>('SELECT size FROM service_team').get();
        expect(row?.size).toBeNull();
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('walks back to the prior applied set and lets the outgoing release read the result', () => {
    // The rollback, asserted by **reading the result** rather than by trusting
    // an exit code: `AGENTS.md` — "an exit code is evidence only if the tool's
    // contract guarantees the effect". Two migrations, reversed newest first,
    // and then the release that comes back must be able to write and read a
    // work item and a team without either column.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);

      const reversed = rollbackTo(db.path, FOLDER, PRIORITY);

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
      ]);
      const back = openDatabase(db.path);
      try {
        back.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        back.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        back.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, priority, revision)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 2, 0)",
        );
        back.run("INSERT INTO service_team (id, name) VALUES ('t1', 'Platform')");
        // The columns are gone, and the release that comes back reads what it
        // knows about.
        const row = back
          .query<{ priority: number | null }, []>("SELECT priority FROM work_item WHERE id = 'w1'")
          .get();
        expect(row?.priority).toBe(2);
        expect(() => back.query('SELECT max_parallel FROM work_item').get()).toThrow();
        expect(() => back.query('SELECT size FROM service_team').get()).toThrow();
        expect(() => back.query('SELECT size FROM project_team_capacity').get()).toThrow();
      } finally {
        back.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the per-project capacity migration', () => {
  /**
   * The state the outgoing release leaves behind, written with its own
   * statements: two projects, four teams, three of them globally sized, and one
   * team labelling work in only one of the two projects.
   *
   * `Ops` is the unsized team and `p2` is the project that labels nothing at
   * all, and both are load-bearing — they are the two cases the seeding could
   * get wrong in opposite directions.
   */
  function outgoingRelease(dbPath: string): void {
    const before = openDatabase(dbPath);
    try {
      before.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
      );
      for (const [id, name] of [
        ['p1', 'Rewire the shed'],
        ['p2', 'Reroof the barn'],
      ] as const) {
        before.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            ` VALUES ('${id}', '${name}', 'u', 0, 'pert', '2026-09-01', 0, 1)`,
        );
      }
      // Written through `size` on purpose: this is the global number the
      // migration has to carry forward, and a team written without one is the
      // case it has to leave alone.
      for (const [id, name, size] of [
        ['t-backend', 'Backend', '1'],
        ['t-platform', 'Platform', '4'],
        ['t-design', 'Design', '1000'],
        // The unsized team, written the way the outgoing release writes one: the
        // literal `NULL` rather than a quoted string, because a `'NULL'` would be
        // the text and would seed as a number.
        ['t-ops', 'Ops', 'NULL'],
      ] as const) {
        before.run(
          `INSERT INTO service_team (id, name, size) VALUES ('${id}', '${name}', ${size})`,
        );
      }
      before.run(
        'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, service_team_id, revision)' +
          " VALUES ('w1', 'p1', NULL, 10, 'Strip', '', 't-backend', 0)",
      );
    } finally {
      before.close();
    }
  }

  function capacities(
    dbPath: string,
  ): { project_id: string; service_team_id: string; size: number }[] {
    const after = openDatabase(dbPath);
    try {
      return after
        .query<
          { project_id: string; service_team_id: string; size: number },
          []
        >('SELECT project_id, service_team_id, size FROM project_team_capacity ORDER BY project_id, service_team_id')
        .all();
    } finally {
      after.close();
    }
  }

  it('seeds every project that existed from the global size it retires', () => {
    // Claim A of the identity differential — design.md D7. The numbers every
    // plan on the live server was scheduled under move into the new table, so
    // that the release which stops reading `service_team.size` schedules those
    // plans exactly as the release before it did.
    //
    // The **cartesian** product, not the join over labelled work: `p2` labels
    // nothing today, and under a join it would be seeded nothing — so labelling
    // one row in it with `Platform` the day after this migration would give that
    // plan an unconstrained Platform where the previous release gave it four,
    // with nobody having edited a capacity. design.md D2.
    //
    // Proof: the `CROSS JOIN` narrowed to joins over `work_item` — on
    // `wi.project_id = p.id` and `wi.service_team_id = st.id` — and this failed
    // with five of the six pairs gone from the diff: all three of `p2`, and
    // `t-design` and `t-platform` on `p1`. Exactly the silent re-scheduling
    // above, and the only pair left is the one that happens to be labelled
    // today. Watched 2026-08-13.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, MAX_PARALLEL);
      outgoingRelease(db.path);

      runMigrations(db.path, FOLDER);

      expect(capacities(db.path)).toEqual([
        { project_id: 'p1', service_team_id: 't-backend', size: 1 },
        { project_id: 'p1', service_team_id: 't-design', size: 1000 },
        { project_id: 'p1', service_team_id: 't-platform', size: 4 },
        { project_id: 'p2', service_team_id: 't-backend', size: 1 },
        { project_id: 'p2', service_team_id: 't-design', size: 1000 },
        { project_id: 'p2', service_team_id: 't-platform', size: 4 },
      ]);
    } finally {
      db.cleanup();
    }
  });

  it('seeds nothing at all for a team nobody has sized', () => {
    // The other half, and the half a seeding written with a default would break
    // silently: an unsized team constrained nothing, and seeding it as 1 would
    // serialize its work on every plan the day this ran with nobody having
    // edited anything. C1's own `DEFAULT 1` argument, one table along.
    //
    // Proof: `WHERE st.size IS NOT NULL` struck from the seeding, and the
    // migration itself aborted — `DrizzleError: Failed to run the query`, naming
    // the seeding `INSERT`, which is drizzle's wrapper around SQLite's `NOT NULL
    // constraint failed: project_team_capacity.size`. It takes
    // `seeds every project that existed…` down with it, so **two** tests go red,
    // not one. The column's own shape is what refuses to write _unstated_ as a
    // number, which is why it is `NOT NULL` and unstated is the absence of a row.
    // Watched 2026-08-13; the wrapped message was confirmed by running the bare
    // statement against `bun:sqlite`, because the migrator prints only its
    // wrapper.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, MAX_PARALLEL);
      outgoingRelease(db.path);

      runMigrations(db.path, FOLDER);

      expect(capacities(db.path).some((row) => row.service_team_id === 't-ops')).toBe(false);
      // And the global number it came from is still there, unread: the column is
      // retired rather than dropped, because the outgoing release still selects
      // it while both colours share this file. design.md D4.
      const after = openDatabase(db.path);
      try {
        const kept = after
          .query<
            { id: string; size: number | null },
            []
          >('SELECT id, size FROM service_team ORDER BY id')
          .all();
        expect(kept).toEqual([
          { id: 't-backend', size: 1 },
          { id: 't-design', size: 1000 },
          { id: 't-ops', size: null },
          { id: 't-platform', size: 4 },
        ]);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep writing teams and projects against the migrated schema', () => {
    // The blue/green half, the shape every migration in this file has. This one
    // adds a table rather than a column, so the statements at risk are the
    // outgoing release's `INSERT`s into the two tables it references — nothing
    // it sends names this table, and the cascades are what keep its `DELETE`s
    // working against constraints it cannot see.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        sqlite.run("INSERT INTO service_team (id, name) VALUES ('t1', 'Platform')");
        sqlite.run("INSERT INTO project_team_capacity VALUES ('p', 't1', 3)");
        // The outgoing release's own removal, which knows nothing about this
        // table: without the cascade it answers 500 for the length of the swap.
        sqlite.run("DELETE FROM service_team WHERE id = 't1'");
        const left = sqlite
          .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project_team_capacity')
          .get();
        expect(left?.n).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('refuses a second capacity for one pair, so unstated has one spelling', () => {
    // The primary key on the pair, which is what makes "this project states this
    // about this team" one fact rather than a list. It is also what turns a
    // re-run of the seeding into a failed statement instead of a doubled table.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        sqlite.run("INSERT INTO service_team (id, name) VALUES ('t1', 'Platform')");
        sqlite.run("INSERT INTO project_team_capacity VALUES ('p', 't1', 3)");
        expect(() => {
          sqlite.run("INSERT INTO project_team_capacity VALUES ('p', 't1', 5)");
        }).toThrow();
        // And a null size is refused, because unstated is the absence of a row.
        expect(() => {
          sqlite.run("INSERT INTO project_team_capacity VALUES ('p', 't1', NULL)");
        }).toThrow();
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the work item team migration', () => {
  /**
   * The state the outgoing release leaves behind: two teams, one work item
   * labelled with one of them, and one labelled with nothing.
   *
   * The unlabelled row is load-bearing — it is the case a seeding without its
   * `WHERE` would write as a row pointing at nothing.
   */
  function outgoingRelease(dbPath: string): void {
    const before = openDatabase(dbPath);
    try {
      before.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
      );
      before.run(
        'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
          " VALUES ('p1', 'Rewire the shed', 'u', 0, 'pert', '2026-09-01', 0, 1)",
      );
      before.run("INSERT INTO service_team (id, name, size) VALUES ('t-backend', 'Backend', 2)");
      before.run("INSERT INTO service_team (id, name, size) VALUES ('t-design', 'Design', NULL)");
      // Written the way the release before this one writes it: capacity is a
      // fact about one project since C5, and this is the row this migration
      // must leave exactly where it found it.
      before.run("INSERT INTO project_team_capacity VALUES ('p1', 't-backend', 2)");
      before.run("INSERT INTO person (id, name) VALUES ('per1', 'kat')");
      before.run(
        "INSERT INTO person_team (person_id, service_team_id) VALUES ('per1', 't-backend')",
      );
      before.run(
        'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, service_team_id, revision)' +
          " VALUES ('w1', 'p1', NULL, 10, 'Strip', '', 't-backend', 0)",
      );
      before.run(
        'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, service_team_id, revision)' +
          " VALUES ('w2', 'p1', NULL, 20, 'Rewire', '', NULL, 0)",
      );
    } finally {
      before.close();
    }
  }

  function joined(dbPath: string): { work_item_id: string; team_id: string }[] {
    const after = openDatabase(dbPath);
    try {
      return after
        .query<
          { work_item_id: string; team_id: string },
          []
        >('SELECT work_item_id, team_id FROM work_item_team ORDER BY work_item_id, team_id')
        .all();
    } finally {
      after.close();
    }
  }

  it('carries every label into the join, and nothing else', () => {
    // Claim A — design.md D5. Every label a plan carries today becomes exactly
    // one join row, so every effective set is of one member or empty and the
    // pool search is the single-pool search it already was. The unlabelled row
    // gets nothing, which is what keeps _unstated_ one spelling.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      outgoingRelease(db.path);

      runMigrations(db.path, FOLDER);

      expect(joined(db.path)).toEqual([{ work_item_id: 'w1', team_id: 't-backend' }]);
    } finally {
      db.cleanup();
    }
  });

  it('leaves capacity and membership row for row alone, so a team is still only a team', () => {
    // The cheapest possible proof that R2's reversal was actually implemented:
    // a service is a label with no pool and no members (Dany, 2026-08-13 23:41),
    // so this migration must not have gone near either table. Cheap, and it is
    // the assertion that would fail first if a later change tried to make the
    // set of teams mean something about capacity.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      outgoingRelease(db.path);

      runMigrations(db.path, FOLDER);

      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<
              { project_id: string; service_team_id: string; size: number },
              []
            >('SELECT project_id, service_team_id, size FROM project_team_capacity ORDER BY service_team_id')
            .all(),
        ).toEqual([{ project_id: 'p1', service_team_id: 't-backend', size: 2 }]);
        expect(
          after
            .query<
              { person_id: string; service_team_id: string },
              []
            >('SELECT person_id, service_team_id FROM person_team')
            .all(),
        ).toEqual([{ person_id: 'per1', service_team_id: 't-backend' }]);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep removing teams against the migrated schema', () => {
    // The blue/green half. The outgoing release's `DELETE FROM service_team`
    // names no table this migration added, and the cascade is what keeps it
    // working against a constraint it cannot see — without it the removal
    // answers 500 for the length of the swap. The same statement, and the same
    // argument, as the per-project capacity table's own case above.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        sqlite.run("INSERT INTO service_team (id, name) VALUES ('t1', 'Platform')");
        sqlite.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, service_team_id, revision)' +
            " VALUES ('w', 'p', NULL, 10, 'Strip', '', 't1', 0)",
        );
        sqlite.run("INSERT INTO work_item_team (work_item_id, team_id) VALUES ('w', 't1')");

        // The column is nulled first because that is what `removeTeam` does,
        // and — found here on 2026-08-14 — because the database refuses the
        // delete otherwise. `work_item.service_team_id` was added by
        // `ALTER TABLE … ADD service_team_id text REFERENCES service_team(id)`
        // and therefore **does** carry a foreign key, with no `ON DELETE`
        // action, against four JSDoc claims in this repo that it deliberately
        // carries none. Watched: this same statement without the `UPDATE`
        // fails on `SQLiteError: FOREIGN KEY constraint failed` with no
        // `work_item_team` row in the database at all. The join's own cascade
        // is what the assertion below is about.
        sqlite.run("UPDATE work_item SET service_team_id = NULL WHERE service_team_id = 't1'");
        sqlite.run("DELETE FROM service_team WHERE id = 't1'");

        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM work_item_team').get()?.n,
        ).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('reverses without taking the labels with it', () => {
    // The rollback, and why it is safe **today**: every join row was written
    // beside the column, so the release that comes back reads the column and
    // finds every label where it left it. `down.sql` says where that stops
    // being true.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      outgoingRelease(db.path);
      runMigrations(db.path, FOLDER);

      const reversed = rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);

      // `PRIORITY_BANDS`, `PLAN_EVENT` and `ACTUAL` ride along because each is
      // applied after this one and the baseline is older than all four — not this
      // migration's business, and named rather than filtered out so the list stays
      // the literal answer `rollbackTo` gave.
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
      ]);
      expect(tables(db.path)).not.toContain('work_item_team');
      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<
              { id: string; service_team_id: string | null },
              []
            >('SELECT id, service_team_id FROM work_item ORDER BY id')
            .all(),
        ).toEqual([
          { id: 'w1', service_team_id: 't-backend' },
          { id: 'w2', service_team_id: null },
        ]);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the priority band migration', () => {
  it('seeds every project that existed with the five default bands', () => {
    // **Claim A.** Reached the way the priority backfill case is: roll back to
    // the migration before this one, write projects the way the outgoing release
    // wrote them, and migrate forward again.
    //
    // What it asserts is the *rows*, and deliberately not any behaviour, because
    // the seeding **has no observable behaviour** — `PriorityBandRepository.listFor`
    // answers `DEFAULT_PRIORITY_BANDS` for a project holding none, so a seeded
    // project and an unseeded one read exactly the same ladder. The seeding is a
    // materialisation: it makes the deployment's real projects hold their
    // vocabulary as data somebody can read out of the database, diff and edit one
    // rung of. design.md D2, and it is the reason this file is where the claim
    // lives rather than a service test.
    //
    // Proof: the whole `INSERT … SELECT` deleted from `migration.sql`, and this
    // failed on `expected [] to have a length of 15` — three projects times five
    // rungs, none of them written. Every *behaviour* test in the suite stayed
    // green with it deleted, which is exactly the paragraph above and exactly why
    // the assertion is on the table. Watched 2026-08-14.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        for (const id of ['p1', 'p2', 'p3']) {
          before.run(
            'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
              ` VALUES ('${id}', 'Plan ${id}', 'u', 0, 'pert', NULL, 0, 1)`,
          );
        }
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      const after = openDatabase(db.path);
      try {
        const rows = after
          .query<
            {
              project_id: string;
              rank: number;
              starts_at: number;
              label: string;
              default_value: number;
            },
            []
          >(
            'SELECT project_id, rank, starts_at, label, default_value FROM project_priority_band ORDER BY project_id, rank',
          )
          .all();
        expect(rows).toHaveLength(15);
        // Dany's five, on every project, in rank order — asserted whole rather
        // than by counting, because a seeding that wrote five rows of the wrong
        // numbers would pass a count.
        for (const id of ['p1', 'p2', 'p3']) {
          expect(
            rows
              .filter((row) => row.project_id === id)
              .map((row) => ({
                startsAt: row.starts_at,
                label: row.label,
                defaultValue: row.default_value,
              })),
          ).toEqual([...DEFAULT_PRIORITY_BANDS]);
        }
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep writing projects against the migrated schema', () => {
    // The blue/green half. Green migrates while blue is still serving, and blue
    // knows nothing about this table — so its plain `INSERT INTO project` must
    // still work, and so must its plain `DELETE FROM project`, which is the one
    // that reaches the new foreign key.
    //
    // The project it deletes is one the **migration seeded**, which is what makes
    // this a test of the cascade at all: a project created after the migration
    // holds no bands, so deleting it touches no child row and the same delete
    // passes with the cascade removed. That is exactly what happened when this
    // case was first written against a post-migration project — `16 pass, 0 fail`
    // with `ON DELETE CASCADE` struck. Watched 2026-08-14, and the reason this
    // fixture rolls back first.
    //
    // Proof: `ON DELETE CASCADE` removed from the migration, and this fails on
    // the delete with `FOREIGN KEY constraint failed` — the outgoing release
    // answering 500 for the length of the swap on a statement it has always been
    // able to run.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        before.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('seeded', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        // Five rows to cascade, which is what the delete below has to take with
        // it. Asserted first, because a delete against no child rows is the
        // vacuous version of this test.
        expect(
          sqlite
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM project_priority_band WHERE project_id = 'seeded'")
            .get()?.n,
        ).toBe(5);

        // The outgoing release's own two statements, written out because drizzle
        // is the new release and the point is what the old one sends.
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('fresh', 'Reroof the barn', 'u', 0, 'pert', NULL, 0, 1)",
        );
        // Seeded nowhere: this project was created *after* the migration, which
        // is the state the read's default arm answers for.
        expect(
          sqlite
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM project_priority_band WHERE project_id = 'fresh'")
            .get()?.n,
        ).toBe(0);

        sqlite.run("DELETE FROM project WHERE id = 'seeded'");
        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project_priority_band').get()
            ?.n,
        ).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('takes the bands away on the way back, and leaves every priority where it was', () => {
    // The rollback, asserted by reading the result. What is lost is the naming;
    // what survives is every number — which is the one thing this rollback is
    // free of and every other scheduling rollback in this repo is not, because
    // the ladder was never read by the leveller. `down.sql` says so too.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        before.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        before.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, priority, max_parallel, revision)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 25, 1, 0)",
        );
      } finally {
        before.close();
      }

      // `WORK_ITEM_TEAM`, `PLAN_EVENT` and `ACTUAL` come off in the same walk:
      // all three are applied outside the span between the baseline and this
      // migration, so a rollback to `PER_PROJECT_CAPACITY` reverses four. Named rather than
      // filtered, so the list is the literal answer `rollbackTo` gave and not a
      // subset somebody chose.
      expect(rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY)).toEqual([
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
        ROLE_PROGRESS,
        ACTUAL,
        PLAN_EVENT,
        PRIORITY_BANDS,
        WORK_ITEM_TEAM,
      ]);

      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='project_priority_band'")
            .get()?.n,
        ).toBe(0);
        // The priority is untouched, which is the whole of what a plan loses:
        // its numbers stay and their names go.
        expect(
          after
            .query<
              { priority: number | null },
              []
            >("SELECT priority FROM work_item WHERE id = 'w1'")
            .get()?.priority,
        ).toBe(25);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the plan event migration', () => {
  /**
   * A user, a project and one recorded event, written the way the release that
   * adds this table writes them.
   *
   * The event is written by hand rather than through a service because what is
   * being tested here is the *schema* — what the outgoing release can still do to
   * a database with this table in it, and what a rollback takes away.
   *
   * **No work item, unless `withWorkItem` asks for one.** `work_item.project_id`
   * references `project` with no cascade of its own, so a row there would make
   * `DELETE FROM project` fail on a foreign key that is not this migration's and
   * the two blue/green cases below would be testing the wrong constraint. That
   * the event still names `w1` with no such row is not an oversight: it is the
   * property `keeps an event whose work item has been deleted` exists for.
   */
  function seeded(dbPath: string, withWorkItem = false): void {
    const db = openDatabase(dbPath);
    try {
      db.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
      );
      db.run(
        'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
          " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
      );
      if (withWorkItem) {
        db.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, priority, max_parallel, revision)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 25, 1, 0)",
        );
      }
      db.run(
        'INSERT INTO plan_event (id, project_id, user_id, kind, label, work_item_id, role_id, before, after, created_at)' +
          " VALUES ('e1', 'p', 'u', 'estimate', 'estimate “Strip”', 'w1', 'r1'," +
          ' \'{"do":"clear_estimate"}\', \'{"do":"set_estimate"}\', 1000)',
      );
    } finally {
      db.close();
    }
  }

  it('creates the table with no rows, because a history begins when it begins', () => {
    // There is nowhere to seed this from — nothing in the database records what an
    // estimate was before it was changed, which is the whole reason this table
    // exists. Every plan on the server starts empty, and that reads as "nothing
    // has been recorded yet" rather than as "nothing has changed". Asserted rather
    // than assumed, because a migration that quietly invented history would be
    // worse than one that seeded none.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      expect(tables(db.path)).toContain('plan_event');
      const sqlite = openDatabase(db.path);
      try {
        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM plan_event').get()?.n,
        ).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep deleting projects against the migrated schema', () => {
    // The blue/green half. Green migrates while blue is still serving, and blue
    // knows nothing about this table — so its plain `DELETE FROM project` must
    // still work, and the recorded events must go with the project rather than
    // refusing the delete.
    //
    // Proof: `ON DELETE CASCADE` removed from `project_id` in the migration, and
    // this fails on the delete with `SQLiteError: FOREIGN KEY constraint failed` —
    // the outgoing release answering 500 for the length of the swap on a statement
    // it has always been able to run. 23 pass, 2 fail; watched 2026-08-17.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        // One row to cascade, which is what the delete below has to take with it.
        // Asserted first, because a delete against no child rows is the vacuous
        // version of this test — the mistake `priority-band` made and caught.
        expect(
          sqlite
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM plan_event WHERE project_id = 'p'")
            .get()?.n,
        ).toBe(1);

        sqlite.run("DELETE FROM project WHERE id = 'p'");

        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM plan_event').get()?.n,
        ).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep deleting accounts against the migrated schema', () => {
    // The other foreign key, and the same window. Nothing in the product deletes
    // an account today, which is exactly why this is asserted rather than assumed:
    // the day something does, it will be a release that knows nothing about this
    // table.
    //
    // **The account deleted is a second one, who edited somebody else's plan.**
    // The first version of this case deleted the owner — and had to delete the
    // project first, because `project.owner_id` references `users` too, which
    // cascaded every event away before the `DELETE FROM users` was reached. It
    // passed with `ON DELETE CASCADE` struck from `user_id`: **25 pass, 0 fail**,
    // a check that could not fail, watched 2026-08-17. A stranger's event is the
    // only shape in which this constraint is reachable at all.
    //
    // Proof, after that rewrite: `ON DELETE CASCADE` removed from `user_id` in the
    // migration, and this fails on the delete with `FOREIGN KEY constraint failed`.
    // Watched 2026-08-17.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);
      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('stranger', 'stranger', 'x', 2)",
        );
        // Somebody who edited this plan and owns none of their own, which is what
        // makes their account deletable while the project stands.
        before.run(
          'INSERT INTO plan_event (id, project_id, user_id, kind, label, work_item_id, role_id, before, after, created_at)' +
            " VALUES ('e2', 'p', 'stranger', 'patch', 'rename “Strip”', 'w1', NULL, '{}', '{}', 2000)",
        );
      } finally {
        before.close();
      }

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        // Their one event, which is what the delete below has to take with it.
        // Asserted first, because a delete against no child rows is the vacuous
        // version of this test — and was, once.
        expect(
          sqlite
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM plan_event WHERE user_id = 'stranger'")
            .get()?.n,
        ).toBe(1);

        sqlite.run("DELETE FROM users WHERE id = 'stranger'");

        expect(
          sqlite
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM plan_event WHERE user_id = 'stranger'")
            .get()?.n,
        ).toBe(0);
        // And the owner's own event is untouched: one account leaving does not
        // take the plan's history with it.
        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM plan_event').get()?.n,
        ).toBe(1);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('keeps an event whose work item has been deleted, which is the point of a history', () => {
    // `work_item_id` carries no foreign key, deliberately. A cascade would delete
    // the record of the row somebody is asking about at the moment it is deleted,
    // and a restricting reference would refuse the delete instead. This is the
    // assertion that says which of the three this table chose.
    //
    // Proof: `REFERENCES work_item(id) ON DELETE CASCADE` added to `work_item_id`
    // in the migration, and this fails on `Expected: "w1" / Received: undefined` —
    // one deleted row taking its whole estimate history with it. The two blue/green
    // cases above go red with it, because the seeded event names a work item that
    // does not exist and the reference refuses the insert: an event about a row
    // that has gone becomes unwritable, which is the same fault seen from the
    // other end. 22 pass, 3 fail; watched 2026-08-17.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path, true);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        sqlite.run("DELETE FROM work_item WHERE id = 'w1'");

        const row = sqlite
          .query<
            { work_item_id: string | null; label: string },
            []
          >("SELECT work_item_id, label FROM plan_event WHERE id = 'e1'")
          .get();
        expect(row?.work_item_id).toBe('w1');
        // And the sentence still reads, which is why the label is stored rather
        // than re-derived from a row that is gone.
        expect(row?.label).toBe('estimate “Strip”');
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('takes the history away on the way back, and leaves the plan where it was', () => {
    // The rollback, asserted by reading the result. What is lost is the record of
    // what happened; what survives is the plan — every row, its priority, and the
    // undo stack, which lives in `command_journal` and is not touched.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path, true);
      const before = openDatabase(db.path);
      try {
        before.run(
          'INSERT INTO command_journal (id, project_id, user_id, seq, kind, payload, inverse, preconditions, undone, created_at)' +
            " VALUES ('j1', 'p', 'u', 1, 'estimate', '{}', '{}', '{}', 0, 1000)",
        );
      } finally {
        before.close();
      }

      expect(rollbackTo(db.path, FOLDER, PRIORITY_BANDS)).toEqual([
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
        ROLE_PROGRESS,
        ACTUAL,
        PLAN_EVENT,
      ]);

      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='plan_event'")
            .get()?.n,
        ).toBe(0);
        // The two indexes go with it rather than being left behind pointing at a
        // table that is gone.
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'plan_event%'")
            .get()?.n,
        ).toBe(0);
        // Untouched: the work item, and the undo entry for the very command whose
        // history row has just gone. Nobody loses a key press to this rollback.
        expect(
          after
            .query<
              { priority: number | null },
              []
            >("SELECT priority FROM work_item WHERE id = 'w1'")
            .get()?.priority,
        ).toBe(25);
        expect(
          after.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM command_journal').get()?.n,
        ).toBe(1);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the actual migration', () => {
  /**
   * A plan with one estimate and one recorded actual against it, written the way
   * the release that adds this table writes them.
   *
   * By hand rather than through a service, for the reason the plan-event
   * fixture gives: what is under test is the *schema* — what the outgoing
   * release can still do to a database with this table in it, which foreign key
   * refuses what, and what a rollback takes away.
   */
  function seeded(dbPath: string): void {
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
    } finally {
      db.close();
    }
  }

  it('creates the table with no rows, because nobody has recorded a day yet', () => {
    // There is nowhere to seed this from and nothing that would be true if there
    // were: no plan on the server holds a record of days spent, and inventing
    // one would be the tool asserting a fact about somebody's past week. Empty
    // reads as "nobody has recorded anything", never as "no days were spent" —
    // the absence rule the whole table rests on, asserted rather than assumed.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      expect(tables(db.path)).toContain('actual');
      const sqlite = openDatabase(db.path);
      try {
        expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM actual').get()?.n).toBe(
          0,
        );
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep deleting work items against the migrated schema', () => {
    // The blue/green half. Green migrates while blue is still serving, and blue
    // knows nothing about this table — so its plain `DELETE FROM work_item` must
    // still work, and the recorded days must go with the row rather than
    // refusing the delete.
    //
    // Proof: `ON DELETE CASCADE` struck from `work_item_id` in the migration,
    // and this fails on that exact statement with `SQLiteError: FOREIGN KEY
    // constraint failed` — the outgoing release answering 500 for the length of
    // the swap on a statement it has always been able to run. Watched
    // 2026-08-17; see verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        sqlite.run("DELETE FROM estimate WHERE work_item_id = 'w1'");
        sqlite.run("DELETE FROM work_item WHERE id = 'w1'");

        expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM actual').get()?.n).toBe(
          0,
        );
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('refuses to let a role go while it still holds recorded days, rather than emptying it', () => {
    // `role_id` carries **no** cascade, deliberately and unlike
    // `assignment.role_id`. An actual is somebody's typing about work that has
    // already happened, so a removal must count it before taking it: the missing
    // cascade is what makes a role delete that forgot to say so fail loudly.
    // `RoleRepository.remove` is the caller that deletes them explicitly, and
    // this is the constraint underneath it.
    //
    // Proof: `ON DELETE CASCADE` added to `role_id` in the migration, and this
    // fails on `Received function did not throw` with the actual silently gone —
    // which is the plan quietly losing a week nobody could retype. Watched
    // 2026-08-17; see verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        // The estimate first, which has the same missing cascade — otherwise
        // this case would be watching `estimate`'s foreign key rather than this
        // migration's.
        sqlite.run("DELETE FROM estimate WHERE role_id = 'r1'");
        expect(() => {
          sqlite.run("DELETE FROM role WHERE id = 'r1'");
        }).toThrow(/FOREIGN KEY constraint failed/);
        expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM actual').get()?.n).toBe(
          1,
        );
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('refuses a second recording for one pair, so unstated has exactly one spelling', () => {
    // The composite primary key. Two rows for one (work item, role) would make a
    // reader choose between them, and the choice would decide a figure on
    // screen. A correction replaces; it does not accumulate.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        expect(() => {
          sqlite.run(
            "INSERT INTO actual (work_item_id, role_id, days, recorded_at) VALUES ('w1', 'r1', 3, 2000)",
          );
        }).toThrow(/UNIQUE constraint failed/);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('takes the recorded days away on the way back, and leaves every estimate where it was', () => {
    // The rollback, asserted by reading the result. What is lost is the record
    // of what happened; what survives is the plan the estimates describe — which
    // is the property that makes this rollback survivable at all.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      expect(rollbackTo(db.path, FOLDER, PLAN_EVENT)).toEqual([
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
        ROLE_PROGRESS,
        ACTUAL,
      ]);

      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='actual'")
            .get()?.n,
        ).toBe(0);
        // The index goes with it rather than being left behind pointing at a
        // table that is gone.
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'actual%'")
            .get()?.n,
        ).toBe(0);
        // Untouched: the estimate, the work item and its priority. A plan that
        // loses its actuals still holds every figure it is committed against.
        expect(
          after
            .query<
              { realistic: number },
              []
            >("SELECT realistic FROM estimate WHERE work_item_id = 'w1' AND role_id = 'r1'")
            .get()?.realistic,
        ).toBe(2);
        expect(
          after
            .query<
              { priority: number | null },
              []
            >("SELECT priority FROM work_item WHERE id = 'w1'")
            .get()?.priority,
        ).toBe(25);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the role progress migration', () => {
  /**
   * A plan with one estimate, one recorded actual and one role said to be done,
   * written the way the release that adds this table writes them.
   *
   * By hand rather than through a service, for the reason the actual fixture
   * gives: what is under test is the *schema* — what the outgoing release can
   * still do to a database with this table in it, which constraint refuses what,
   * and what a rollback takes away.
   */
  function seeded(dbPath: string): void {
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
      // A second row with nothing said about it, so the `CHECK` case can insert
      // a fourth state without the primary key refusing it first — a UNIQUE
      // failure would look like a pass and prove nothing about the constraint
      // under test.
      db.run(
        'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, priority, max_parallel, revision)' +
          " VALUES ('w2', 'p', NULL, 20, 'Sand', '', 25, 1, 0)",
      );
    } finally {
      db.close();
    }
  }

  it('creates the table with no rows, because nobody has said where anything has got to', () => {
    // Nothing to seed it from and nothing that would be true if there were: no
    // plan on the server holds a statement about its own progress, and inventing
    // one would be the tool asserting somebody else's. Empty reads as "nobody
    // has said", never as "nothing has been started".
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      expect(tables(db.path)).toContain('role_progress');
      const sqlite = openDatabase(db.path);
      try {
        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM role_progress').get()?.n,
        ).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('refuses a state outside the three the design has', () => {
    // The `CHECK`, which is the closed set the whole design rests on. Three
    // states and no more: `blocked` and `cancelled` are each a question the
    // engine must answer the day it reads this table, and `not_started` is the
    // absence of a row rather than a value.
    //
    // Proof: the constraint widened to include `'blocked'` in the migration, and
    // this fails with the row written instead of rejected — a state stored on a
    // real plan that nothing folds. Watched 2026-08-18; see verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        for (const state of ['not_started', 'blocked', 'cancelled']) {
          expect(() => {
            sqlite.run(
              `INSERT INTO role_progress (work_item_id, role_id, state, stated_at) VALUES ('w2', 'r1', '${state}', 1)`,
            );
          }).toThrow(/CHECK constraint failed/);
        }
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep deleting work items against the migrated schema', () => {
    // The blue/green half, one table over from `actual`'s. Green migrates while
    // blue is still serving, and blue knows nothing about this table — so its
    // plain `DELETE FROM work_item` must still work, and the statement must go
    // with the row rather than refusing the delete.
    //
    // Proof: `ON DELETE CASCADE` struck from `work_item_id` in the migration,
    // and this fails on that exact statement with `SQLiteError: FOREIGN KEY
    // constraint failed` — the outgoing release answering 500 for the length of
    // the swap on a statement it has always been able to run. Watched
    // 2026-08-18; see verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        sqlite.run("DELETE FROM estimate WHERE work_item_id = 'w1'");
        sqlite.run("DELETE FROM work_item WHERE id = 'w1'");

        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM role_progress').get()?.n,
        ).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('keeps a role that has been said to be done undeletable behind the repository that counts them', () => {
    // `role_id` deliberately carries **no** cascade: a statement is somebody's,
    // and a role removal must count it before taking it. The missing cascade is
    // what makes a role delete that forgot to say so fail loudly instead of
    // quietly turning finished work back into work nobody has started.
    //
    // Proof: `ON DELETE CASCADE` **added** to `role_id` in the migration, and
    // this fails with `Received function did not throw` and the statement
    // silently gone. Watched 2026-08-18; see verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        // The estimate and the actual out of the way first, so what refuses the
        // role delete is this migration's foreign key rather than one of theirs.
        sqlite.run("DELETE FROM estimate WHERE role_id = 'r1'");
        sqlite.run("DELETE FROM actual WHERE role_id = 'r1'");
        expect(() => {
          sqlite.run("DELETE FROM role WHERE id = 'r1'");
        }).toThrow(/FOREIGN KEY constraint failed/);
        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM role_progress').get()?.n,
        ).toBe(1);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('refuses a second statement for one pair, so a role has exactly one state', () => {
    // The composite primary key. Two rows for one (work item, role) would make a
    // reader choose between `in_progress` and `done`, and the choice would decide
    // what the row says on screen. A change of state replaces; it does not
    // accumulate.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        expect(() => {
          sqlite.run(
            "INSERT INTO role_progress (work_item_id, role_id, state, stated_at) VALUES ('w1', 'r1', 'in_progress', 3000)",
          );
        }).toThrow(/UNIQUE constraint failed/);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('takes the statements away on the way back, and leaves every figure where it was', () => {
    // The rollback, asserted by reading the result. What is lost is the answer to
    // "which of the two sentences is this?"; what survives is both figures — so
    // after this reversal an actual of 8 against an estimate of 5 is a number
    // nobody can read the tense of again, which is exactly the state the tool was
    // in before this migration.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      expect(rollbackTo(db.path, FOLDER, ACTUAL)).toEqual([
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
        ROLE_PROGRESS,
      ]);

      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='role_progress'")
            .get()?.n,
        ).toBe(0);
        // The index goes with it rather than being left behind pointing at a
        // table that is gone.
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'role_progress%'")
            .get()?.n,
        ).toBe(0);
        // Untouched: the recorded day, the estimate and the work item.
        expect(
          after
            .query<
              { days: number },
              []
            >("SELECT days FROM actual WHERE work_item_id = 'w1' AND role_id = 'r1'")
            .get()?.days,
        ).toBe(8);
        expect(
          after
            .query<
              { realistic: number },
              []
            >("SELECT realistic FROM estimate WHERE work_item_id = 'w1' AND role_id = 'r1'")
            .get()?.realistic,
        ).toBe(2);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the not-before reason migration', () => {
  it('lets the outgoing release keep inserting work items against the migrated schema', () => {
    // The blue/green half, the same shape every column migration on this table
    // has: green migrates while blue is still serving, and blue's `INSERT` names
    // the columns it was compiled against. Written out rather than built through
    // drizzle, because drizzle is the new release and the point is what the old
    // one sends.
    //
    // Proof: `NOT NULL DEFAULT ''` added to the column — **38 pass, 2 fail** in
    // this file — and this failed on `expect(received).toBeNull()` /
    // `Received: ""`, with `leaves work items that existed before the column
    // with no reason` beside it. A default turns every row blue writes, and
    // every row that predates the column, into a work item carrying a blank
    // sentence nobody typed. Watched 2026-08-18.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );

        sqlite.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 0)",
        );

        const written = sqlite
          .query<
            { start_no_earlier_than_reason: string | null },
            []
          >("SELECT start_no_earlier_than_reason FROM work_item WHERE id = 'w1'")
          .get();
        expect(written?.start_no_earlier_than_reason).toBeNull();
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep clearing a not-before date the new one has explained', () => {
    // **This is the case that decided there is no `CHECK` on this column.**
    //
    // The obvious way to hold "a reason needs a date" is a table constraint —
    // `CHECK (start_no_earlier_than_reason IS NULL OR start_no_earlier_than IS
    // NOT NULL)` — and that is exactly what `role_progress_state` does one
    // migration over. It is safe there because blue has never heard of that
    // table and never writes to it. It is not safe here: `work_item` is a table
    // blue `UPDATE`s on every edit, and clearing a not-before is a statement
    // blue runs today. Against a row green has given a reason, that statement
    // would fail a constraint blue cannot see and answer 500 — for the length of
    // the swap window, on a request whose only fault is being served by the old
    // colour.
    //
    // So the pair rule lives at the write boundary (`WorkItemStore.patch`), and
    // this case is what says the database still lets the old colour work. The
    // row it leaves behind — words with no date — is the cost, stated on the
    // migration: it is invisible rather than wrong, because no bar is floored by
    // a date that is not there and no surface prints the words without one.
    //
    // Proof: that `CHECK` added to `migration.sql` and this failed on blue's own
    // `UPDATE` with `CHECK constraint failed: work_item`; watched 2026-08-18.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        // The incoming release's row: a floor, and words about it.
        sqlite.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision,' +
            ' start_no_earlier_than, start_no_earlier_than_reason)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 0, '2026-09-12', 'waiting on client sign-off')",
        );

        // The outgoing release's own statement, which names the columns it was
        // compiled against and knows nothing about the one beside them.
        sqlite.run("UPDATE work_item SET start_no_earlier_than = NULL WHERE id = 'w1'");

        const row = sqlite
          .query<
            { start_no_earlier_than: string | null; start_no_earlier_than_reason: string | null },
            []
          >('SELECT start_no_earlier_than, start_no_earlier_than_reason FROM work_item' + " WHERE id = 'w1'")
          .get();
        expect(row?.start_no_earlier_than).toBeNull();
        // The words survive blue's write, orphaned and invisible, which is the
        // trade this migration takes rather than 500ing the outgoing release.
        expect(row?.start_no_earlier_than_reason).toBe('waiting on client sign-off');
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('leaves work items that existed before the column with no reason', () => {
    // The other half of "nullable, no default". Every plan on the live server
    // was written before this column existed and nobody has explained any of
    // them, so the only honest value for those rows is the absence of one — and
    // a default of `''` would be the tool putting a blank sentence in a
    // planner's mouth on every row of every plan.
    //
    // Reached the way the priority backfill case is: roll back to the migration
    // before this one, write a work item the way the previous release wrote one,
    // and migrate forward again.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, ROLE_PROGRESS);
      const before = openDatabase(db.path);
      try {
        before.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        before.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        before.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision, start_no_earlier_than)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 0, '2026-09-12')",
        );
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      const after = openDatabase(db.path);
      try {
        const row = after
          .query<
            { start_no_earlier_than: string | null; start_no_earlier_than_reason: string | null },
            []
          >('SELECT start_no_earlier_than, start_no_earlier_than_reason FROM work_item')
          .get();
        // The floor it already had, untouched, and no words invented for it.
        expect(row?.start_no_earlier_than).toBe('2026-09-12');
        expect(row?.start_no_earlier_than_reason).toBeNull();
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('takes the words away on the way back, and leaves every date where it was', () => {
    // The rollback, asserted by reading the result rather than by trusting an
    // exit code. What is lost is the explanation; what survives is the floor —
    // so after this reversal a plan reads "held until the 12th" where it read
    // "held until the 12th, waiting on client sign-off", which is the state
    // every plan on the server is in today.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        sqlite.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision,' +
            ' start_no_earlier_than, start_no_earlier_than_reason)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip', '', 0, '2026-09-12', 'waiting on client sign-off')",
        );
      } finally {
        sqlite.close();
      }

      expect(rollbackTo(db.path, FOLDER, ROLE_PROGRESS)).toEqual([
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
        NOT_BEFORE_REASON,
      ]);

      const after = openDatabase(db.path);
      try {
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM pragma_table_info('work_item') WHERE name = 'start_no_earlier_than_reason'")
            .get()?.n,
        ).toBe(0);
        // The date the words were about, still holding the row back.
        expect(
          after
            .query<
              { start_no_earlier_than: string | null },
              []
            >("SELECT start_no_earlier_than FROM work_item WHERE id = 'w1'")
            .get()?.start_no_earlier_than,
        ).toBe('2026-09-12');
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });
});

describe('the tag migration', () => {
  /**
   * A plan with one labelled work item: a project, an item, two tags, and the
   * item carrying both. Enough to watch a cascade take rows, and enough to watch
   * a rollback leave the figures alone.
   */
  function seeded(dbPath: string): void {
    const sqlite = openDatabase(dbPath);
    try {
      sqlite.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
      );
      sqlite.run(
        'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
          " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
      );
      sqlite.run(
        'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision)' +
          " VALUES ('w1', 'p', NULL, 10, 'Strip the roof', '', 0)",
      );
      sqlite.run("INSERT INTO tag (id, name) VALUES ('g1', 'regulatory')");
      sqlite.run("INSERT INTO tag (id, name) VALUES ('g2', 'tech-debt')");
      sqlite.run("INSERT INTO work_item_tag (work_item_id, tag_id) VALUES ('w1', 'g1')");
      sqlite.run("INSERT INTO work_item_tag (work_item_id, tag_id) VALUES ('w1', 'g2')");
    } finally {
      sqlite.close();
    }
  }

  function labelCount(dbPath: string): number {
    const sqlite = openDatabase(dbPath);
    try {
      return (
        sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM work_item_tag').get()?.n ?? -1
      );
    } finally {
      sqlite.close();
    }
  }

  it('creates the directory and its join, and the directory carries no size', () => {
    // The defining absence, asserted rather than described: a tag has no pool
    // and no size, so there is no column here for one and no per-project table
    // beside it. If a later change adds capacity to a tag it has to delete this
    // assertion to do it, and deleting it is the conversation.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      for (const t of TAG_TABLES) expect(tables(db.path)).toContain(t);

      const sqlite = openDatabase(db.path);
      try {
        const columns = sqlite
          .query<{ name: string }, []>("SELECT name FROM pragma_table_info('tag')")
          .all()
          .map((c) => c.name);
        expect(columns).toEqual(['id', 'name']);
        // No project column: a tag means the same thing on every plan, which is
        // what makes the directory one screen and the filter one vocabulary.
        expect(columns).not.toContain('project_id');
        expect(columns).not.toContain('size');
        expect(tables(db.path)).not.toContain('project_tag_capacity');
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('refuses a second tag spelled exactly like the first', () => {
    // What the unique index buys: a rename can answer `taken` with the surviving
    // name instead of writing a second row that reads identically. Two tags
    // spelled the same are two answers to one question.
    //
    // Proof: `CREATE UNIQUE INDEX` weakened to `CREATE INDEX` in migration.sql
    // — **44 pass, 1 fail** in this file — and this failed with the second row
    // written instead of rejected: a directory holding two `regulatory` tags,
    // and a filter facet that has to pick one of them. Watched 2026-08-19, see
    // verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("INSERT INTO tag (id, name) VALUES ('g1', 'regulatory')");
        expect(() => sqlite.run("INSERT INTO tag (id, name) VALUES ('g2', 'regulatory')")).toThrow(
          /UNIQUE/i,
        );
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep deleting work items against the migrated schema', () => {
    // The blue/green half. Two be-01 processes share one SQLite file while green
    // migrates, the outgoing release knows nothing about `work_item_tag`, and
    // its plain `DELETE FROM work_item` must not hit a constraint it cannot see.
    //
    // Proof: `ON DELETE CASCADE` struck from `work_item_id` in migration.sql —
    // **44 pass, 1 fail** in this file — and this failed on that exact statement
    // with `SQLiteError: FOREIGN KEY constraint failed`: every delete of a
    // labelled work item answering 500 for the length of a swap. Watched
    // 2026-08-19, see verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);
      expect(labelCount(db.path)).toBe(2);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("DELETE FROM work_item WHERE id = 'w1'");
      } finally {
        sqlite.close();
      }

      expect(labelCount(db.path)).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('takes the labelling with the label, which is where a tag differs from a progress state', () => {
    // `role_progress.role_id` deliberately does not cascade: a state is
    // somebody's statement about their own work, so a role removal must count it
    // before taking it. A tag is a label — deleting the label should take the
    // labelling with it, and there is nothing to count that the label itself was
    // not. `DELETE /api/tags/:id` still counts first and still refuses with 409
    // unless `?cascade=1`; the count is for the person pressing the button.
    //
    // Proof: `ON DELETE CASCADE` struck from `tag_id` in migration.sql —
    // **44 pass, 1 fail** in this file — and this failed on the delete with
    // `SQLiteError: FOREIGN KEY constraint failed`: `DELETE /api/tags/:id`
    // answering 500 for every tag anybody has ever used, `?cascade=1` included.
    // Watched 2026-08-19, see verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("DELETE FROM tag WHERE id = 'g1'");
        // Only the removed label's rows go. The other tag still labels the item,
        // which is the difference between a cascade and a clear.
        expect(
          sqlite
            .query<{ tag_id: string }, []>(
              "SELECT tag_id FROM work_item_tag WHERE work_item_id = 'w1'",
            )
            .all()
            .map((r) => r.tag_id),
        ).toEqual(['g2']);
        // And the work item itself is untouched: the cascade runs one way.
        expect(
          sqlite
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item WHERE id = 'w1'")
            .get()?.n,
        ).toBe(1);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('takes both tables away on the way back, and the plan survives the round trip', () => {
    // The rollback, and then forward again — down, up, and the row that was never
    // this migration's to hold is still there. What is lost is the labelling;
    // what survives is the plan, because the two dimensions share no row.
    //
    // The re-apply is the half that catches the bookkeeping: if `down.sql`
    // dropped the rows and left the tables, or dropped the tables and left the
    // `__drizzle_migrations` entry, this second `runMigrations` would either skip
    // a table it believes is there or fail on `table tag already exists`.
    //
    // Proof: `DROP TABLE IF EXISTS work_item_tag` struck from down.sql —
    // **32 pass, 13 fail** in this file — and this failed on
    // `expect(received).not.toContain(expected)` with the table still standing
    // after a rollback that reported success. The other twelve are the blast
    // radius and worth naming: every rollback case in the file then failed with
    // `rolling back 20260805154500_add_wbs_domain failed: no such table:
    // main.tag`, because an orphan join whose foreign key points at a dropped
    // directory blocks the reversal of every migration under it. Watched
    // 2026-08-19, see verify.md.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      expect(rollbackTo(db.path, FOLDER, NOT_BEFORE_REASON)).toEqual([
        WORK_ITEM_SERVICE,
        SERVICE,
        TAG,
      ]);
      for (const t of TAG_TABLES) expect(tables(db.path)).not.toContain(t);

      const after = openDatabase(db.path);
      try {
        // The indexes go with the tables rather than being left behind pointing
        // at something that is gone.
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND (name LIKE 'tag%' OR name LIKE 'work_item_tag%')")
            .get()?.n,
        ).toBe(0);
        // Untouched, and this is the whole claim of the down script: a plan that
        // loses its labels keeps every work item anybody typed.
        expect(
          after.query<{ name: string }, []>("SELECT name FROM work_item WHERE id = 'w1'").get()
            ?.name,
        ).toBe('Strip the roof');
      } finally {
        after.close();
      }

      runMigrations(db.path, FOLDER);
      for (const t of TAG_TABLES) expect(tables(db.path)).toContain(t);
      // Empty rather than restored: the rollback took the labelling and nothing
      // replays it. The tables come back usable, which is what re-applying means.
      expect(labelCount(db.path)).toBe(0);
      const again = openDatabase(db.path);
      try {
        again.run("INSERT INTO tag (id, name) VALUES ('g3', 'q3-must-have')");
        again.run("INSERT INTO work_item_tag (work_item_id, tag_id) VALUES ('w1', 'g3')");
      } finally {
        again.close();
      }
      expect(labelCount(db.path)).toBe(1);
    } finally {
      db.cleanup();
    }
  });
});

describe('the service migration', () => {
  /**
   * A plan with one work item delivered for a service, and a team that owns that
   * service: a project, an item carrying `service_id`, two services, one team,
   * and one ownership row. Enough to watch a `SET NULL` keep a row that a
   * `CASCADE` would have taken, and enough to watch a rollback leave the plan
   * alone.
   */
  function seeded(dbPath: string): void {
    const sqlite = openDatabase(dbPath);
    try {
      sqlite.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
      );
      sqlite.run(
        'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
          " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
      );
      sqlite.run("INSERT INTO service (id, name) VALUES ('s1', 'Payments')");
      sqlite.run("INSERT INTO service (id, name) VALUES ('s2', 'Search')");
      sqlite.run("INSERT INTO service_team (id, name, size) VALUES ('t1', 'Platform', NULL)");
      sqlite.run("INSERT INTO team_service (team_id, service_id) VALUES ('t1', 's1')");
      sqlite.run(
        'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, service_id, revision)' +
          " VALUES ('w1', 'p', NULL, 10, 'Strip the roof', '', 's1', 0)",
      );
    } finally {
      sqlite.close();
    }
  }

  function serviceOf(dbPath: string, itemId: string): string | null {
    const sqlite = openDatabase(dbPath);
    try {
      return (
        sqlite
          .query<
            { service_id: string | null },
            [string]
          >('SELECT service_id FROM work_item WHERE id = ?')
          .get(itemId)?.service_id ?? null
      );
    } finally {
      sqlite.close();
    }
  }

  function ownershipCount(dbPath: string): number {
    const sqlite = openDatabase(dbPath);
    try {
      return (
        sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM team_service').get()?.n ?? -1
      );
    } finally {
      sqlite.close();
    }
  }

  it('creates the directory and its ownership map, and the directory carries no size', () => {
    // The defining absence, asserted rather than described: a service has no pool
    // and no size, so there is no column here for one and no per-project table
    // beside it. Capacity belongs to the team — `service_team` — because capacity
    // is spent by the people doing the work and not by the thing the work is for.
    // If a later change gives a service a pool it has to delete this assertion to
    // do it, and deleting it is the conversation.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      for (const t of SERVICE_TABLES) expect(tables(db.path)).toContain(t);

      const sqlite = openDatabase(db.path);
      try {
        const columns = sqlite
          .query<{ name: string }, []>("SELECT name FROM pragma_table_info('service')")
          .all()
          .map((c) => c.name);
        expect(columns).toEqual(['id', 'name']);
        // No project column: `Payments` means `Payments` on every plan, which is
        // what makes the directory one screen and an export column comparable
        // across plans.
        expect(columns).not.toContain('project_id');
        expect(columns).not.toContain('size');
        expect(tables(db.path)).not.toContain('project_service_capacity');

        // The item's own service was a column on `work_item` and not a join
        // table — one service per item, stated by the schema rather than by a
        // comment — and this case used to assert `work_item_service` did not
        // exist, saying so. It became many-valued eight hours later, the join
        // table arrived in `20260821080000`, and deleting that assertion is
        // exactly what the comment beside it said the widening would have to do.
        // The column survives, because the outgoing release still selects it.
        expect(
          sqlite
            .query<{ name: string }, []>("SELECT name FROM pragma_table_info('work_item')")
            .all()
            .map((c) => c.name),
        ).toContain('service_id');
        expect(tables(db.path)).toContain('work_item_service');
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('refuses a second service spelled exactly like the first', () => {
    // What the unique index buys: a rename can answer `taken` with the surviving
    // name instead of writing a second row that reads identically. Two services
    // spelled the same are two answers to one question, and the second is
    // unreachable in the directory.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("INSERT INTO service (id, name) VALUES ('s1', 'Payments')");
        expect(() =>
          sqlite.run("INSERT INTO service (id, name) VALUES ('s2', 'Payments')"),
        ).toThrow(/UNIQUE/i);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('keeps the work items when a service is removed, and only nulls their label', () => {
    // `ON DELETE SET NULL` and not `CASCADE`, which is the difference between
    // removing a label and removing somebody's plan. It is also the arm that makes
    // the directory's removal effect `label_nulled` rather than `label_removed`:
    // a column is nulled, a set member is removed, and the two are different
    // sentences on the confirmation screen.
    //
    // Watched red: `ON DELETE SET NULL` changed to `ON DELETE CASCADE` in
    // migration.sql.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);
      expect(serviceOf(db.path, 'w1')).toBe('s1');

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("DELETE FROM service WHERE id = 's1'");
      } finally {
        sqlite.close();
      }

      const after = openDatabase(db.path);
      try {
        // The item is still there. This is the assertion a `CASCADE` fails.
        expect(
          after.query<{ name: string }, []>("SELECT name FROM work_item WHERE id = 'w1'").get()
            ?.name,
        ).toBe('Strip the roof');
      } finally {
        after.close();
      }
      expect(serviceOf(db.path, 'w1')).toBeNull();
      // And the ownership statement goes with the service it was about, which is
      // the other cascade and the one that *should* take rows.
      expect(ownershipCount(db.path)).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep deleting teams against the migrated schema', () => {
    // The blue/green half. Two be-01 processes share one SQLite file while green
    // migrates, the outgoing release knows nothing about `team_service`, and its
    // plain `DELETE FROM service_team` must not hit a constraint it cannot see.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);
      expect(ownershipCount(db.path)).toBe(1);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("DELETE FROM service_team WHERE id = 't1'");
      } finally {
        sqlite.close();
      }

      expect(ownershipCount(db.path)).toBe(0);
      // The service itself survives its owner: a team going away is not a
      // statement about what the service is.
      const after = openDatabase(db.path);
      try {
        expect(
          after.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM service WHERE id = 's1'").get()
            ?.n,
        ).toBe(1);
      } finally {
        after.close();
      }
      // And the item keeps its label, because the label was never the team's.
      expect(serviceOf(db.path, 'w1')).toBe('s1');
    } finally {
      db.cleanup();
    }
  });

  it('seeds nothing: both tables empty and every work item unlabelled', () => {
    // The no-backfill decision implemented rather than intended. Existing
    // `service_team` rows are teams and they start owning nothing; nobody has ever
    // stated a service on this server, so inventing one from a team name would be
    // the tool asserting a fact nobody typed.
    //
    // The `work_item` arm needs a row that predates the column, which is what the
    // rollback-then-forward does: the item is written while `service_id` does not
    // exist, and comes back through the migration the way a real plan would.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run(
          "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
        );
        sqlite.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
        );
        sqlite.run("INSERT INTO service_team (id, name, size) VALUES ('t1', 'Platform', NULL)");
      } finally {
        sqlite.close();
      }

      rollbackTo(db.path, FOLDER, TAG);
      const before = openDatabase(db.path);
      try {
        before.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, revision)' +
            " VALUES ('w1', 'p', NULL, 10, 'Strip the roof', '', 0)",
        );
      } finally {
        before.close();
      }

      runMigrations(db.path, FOLDER);

      const after = openDatabase(db.path);
      try {
        expect(after.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM service').get()?.n).toBe(
          0,
        );
        expect(
          after.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM team_service').get()?.n,
        ).toBe(0);
        expect(
          after
            .query<
              { n: number },
              []
            >('SELECT COUNT(*) AS n FROM work_item WHERE service_id IS NOT NULL')
            .get()?.n,
        ).toBe(0);
      } finally {
        after.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('takes both tables and the column away on the way back, and the plan survives the round trip', () => {
    // The rollback, and then forward again — down, up, and the row that was never
    // this migration's to hold is still there. What is lost is the labelling and
    // the ownership map; what survives is the plan, because the dimensions share
    // no row.
    //
    // The column is the part `add_tag` did not have: `work_item.service_id`
    // references `service`, so it is dropped first, and if that order were wrong
    // the rollback would leave a foreign key pointing at a table that is gone.
    //
    // The re-apply is the half that catches the bookkeeping: if `down.sql` dropped
    // the rows and left the tables, or dropped the tables and left the
    // `__drizzle_migrations` entry, this second `runMigrations` would either skip
    // a table it believes is there or fail on `table service already exists`.
    //
    // Watched red: `DROP TABLE IF EXISTS team_service` struck from down.sql.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seeded(db.path);

      expect(rollbackTo(db.path, FOLDER, TAG)).toEqual([WORK_ITEM_SERVICE, SERVICE]);
      for (const t of SERVICE_TABLES) expect(tables(db.path)).not.toContain(t);

      const after = openDatabase(db.path);
      try {
        // The column goes with the table it points at.
        expect(
          after
            .query<{ name: string }, []>("SELECT name FROM pragma_table_info('work_item')")
            .all()
            .map((c) => c.name),
        ).not.toContain('service_id');
        // The indexes go with their tables rather than being left behind pointing
        // at something that is gone.
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND (name = 'service_name' OR name = 'team_service_by_service')")
            .get()?.n,
        ).toBe(0);
        // Untouched, and this is the whole claim of the down script: a plan that
        // loses its services keeps every work item anybody typed, and the team
        // that owned them is still a team.
        expect(
          after.query<{ name: string }, []>("SELECT name FROM work_item WHERE id = 'w1'").get()
            ?.name,
        ).toBe('Strip the roof');
        expect(
          after.query<{ name: string }, []>("SELECT name FROM service_team WHERE id = 't1'").get()
            ?.name,
        ).toBe('Platform');
      } finally {
        after.close();
      }

      runMigrations(db.path, FOLDER);
      for (const t of SERVICE_TABLES) expect(tables(db.path)).toContain(t);
      // Empty rather than restored: the rollback took the labelling and the map,
      // and nothing replays them. The tables come back usable, which is what
      // re-applying means.
      expect(ownershipCount(db.path)).toBe(0);
      expect(serviceOf(db.path, 'w1')).toBeNull();
      const again = openDatabase(db.path);
      try {
        again.run("INSERT INTO service (id, name) VALUES ('s3', 'Billing')");
        again.run("INSERT INTO team_service (team_id, service_id) VALUES ('t1', 's3')");
        again.run("UPDATE work_item SET service_id = 's3' WHERE id = 'w1'");
      } finally {
        again.close();
      }
      expect(ownershipCount(db.path)).toBe(1);
      expect(serviceOf(db.path, 'w1')).toBe('s3');
    } finally {
      db.cleanup();
    }
  });
});

describe('the work-item-service migration', () => {
  /**
   * A plan whose one work item states a service, written **while the join table
   * does not exist** — the shape of every plan on the live server the moment
   * before this migration runs.
   *
   * It is seeded through the older column deliberately: the seed's whole claim is
   * that it carries rows nobody wrote for it, and a fixture that inserted into
   * `work_item_service` directly would be proving the table accepts a pair.
   */
  function seededOnTheColumn(dbPath: string): void {
    const sqlite = openDatabase(dbPath);
    try {
      sqlite.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
      );
      sqlite.run(
        'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
          " VALUES ('p', 'Rewire the shed', 'u', 0, 'pert', NULL, 0, 1)",
      );
      sqlite.run("INSERT INTO service (id, name) VALUES ('s1', 'Payments')");
      sqlite.run("INSERT INTO service (id, name) VALUES ('s2', 'Search')");
      sqlite.run(
        'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, service_id, revision)' +
          " VALUES ('w1', 'p', NULL, 10, 'Strip the roof', '', 's1', 0)",
      );
      // The row that states nothing and inherits. It is the reason the seed
      // filters on `IS NOT NULL`, and the reason that filter has a case.
      sqlite.run(
        'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, service_id, revision)' +
          " VALUES ('w2', 'p', NULL, 20, 'Sand the beams', '', NULL, 0)",
      );
    } finally {
      sqlite.close();
    }
  }

  function labelsOf(dbPath: string, itemId: string): string[] {
    const sqlite = openDatabase(dbPath);
    try {
      return sqlite
        .query<{ service_id: string }, [string]>(
          'SELECT service_id FROM work_item_service WHERE work_item_id = ? ORDER BY service_id',
        )
        .all(itemId)
        .map((r) => r.service_id);
    } finally {
      sqlite.close();
    }
  }

  /**
   * Up to the migration before this one, so rows can be written the way the
   * running release writes them, and then forward across it. `runMigrations`
   * applies what is unapplied, so the second call runs this folder and nothing
   * else.
   */
  function atTheColumnOnly(dbPath: string): void {
    runMigrations(dbPath, FOLDER);
    expect(rollbackTo(dbPath, FOLDER, SERVICE)).toEqual([WORK_ITEM_SERVICE]);
  }

  it('carries every stated service across, and gives the inheriting row nothing', () => {
    // The seed, against rows that existed before the table did — which is every
    // plan on the live server and the only situation the `INSERT … SELECT`
    // exists for. A table created empty would have unlabelled all of them in the
    // name of a wider type, and nothing downstream would have reported it: an
    // item with no rows here **inherits**, so the plans would have gone quiet
    // rather than gone wrong.
    //
    // Watched red: the `INSERT … SELECT` struck from migration.sql.
    const db = tempDb();
    try {
      atTheColumnOnly(db.path);
      seededOnTheColumn(db.path);

      runMigrations(db.path, FOLDER);

      expect(labelsOf(db.path, 'w1')).toEqual(['s1']);
      // Absence stays absence. Seeding `w2` with anything would be the migration
      // inventing a label nobody stated, and blank means inherit.
      expect(labelsOf(db.path, 'w2')).toEqual([]);
    } finally {
      db.cleanup();
    }
  });

  it('leaves the column standing and still writable, for the release that is still reading it', () => {
    // The blue/green rule, from the side that would break: two be-01 processes
    // share one SQLite file while green migrates, and the outgoing release
    // selects and writes `work_item.service_id` on every tree read and every
    // patch. This migration is additive to the letter — it adds a table, seeds
    // it, and touches nothing the running release names.
    //
    // Dropping the column is a later migration, once no running release names
    // it. Whoever writes it deletes this case, and deleting it is the
    // conversation.
    const db = tempDb();
    try {
      atTheColumnOnly(db.path);
      seededOnTheColumn(db.path);
      runMigrations(db.path, FOLDER);

      const sqlite = openDatabase(db.path);
      try {
        expect(
          sqlite
            .query<{ name: string }, []>("SELECT name FROM pragma_table_info('work_item')")
            .all()
            .map((c) => c.name),
        ).toContain('service_id');
        // Still writable, not merely still declared: the outgoing release's
        // patch has to keep succeeding for the length of the swap.
        sqlite.run("UPDATE work_item SET service_id = 's2' WHERE id = 'w2'");
        expect(
          sqlite
            .query<
              { service_id: string | null },
              []
            >("SELECT service_id FROM work_item WHERE id = 'w2'")
            .get()?.service_id,
        ).toBe('s2');
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('takes a set member with the service, and the work item with neither', () => {
    // Both cascades, and they answer different questions. `service_id` cascading
    // is what `DELETE /api/services/:id?cascade=1` relies on to unlabel — the
    // route counts first and refuses with 409 for the person pressing the
    // button, not for the integrity of anything. `work_item_id` cascading is the
    // blue/green rule again: the outgoing release's plain `DELETE FROM
    // work_item` must not hit a constraint it cannot see.
    const db = tempDb();
    try {
      atTheColumnOnly(db.path);
      seededOnTheColumn(db.path);
      runMigrations(db.path, FOLDER);

      const sqlite = openDatabase(db.path);
      try {
        sqlite.run('PRAGMA foreign_keys = ON');
        sqlite.run("INSERT INTO work_item_service (work_item_id, service_id) VALUES ('w1', 's2')");
        expect(labelsOf(db.path, 'w1')).toEqual(['s1', 's2']);

        // One service goes and takes one member of the set. The other stays,
        // which is the half a single-valued store could not express at all.
        sqlite.run("DELETE FROM service WHERE id = 's2'");
        expect(labelsOf(db.path, 'w1')).toEqual(['s1']);
        // And the work item is still there. Deleting a service must never delete
        // somebody's plan — `ON DELETE SET NULL`'s claim on the column, and this
        // table's cascade must not quietly widen it into a row delete.
        expect(
          sqlite.query<{ name: string }, []>("SELECT name FROM work_item WHERE id = 'w1'").get()
            ?.name,
        ).toBe('Strip the roof');

        sqlite.run("DELETE FROM work_item WHERE id = 'w1'");
        expect(labelsOf(db.path, 'w1')).toEqual([]);
      } finally {
        sqlite.close();
      }
    } finally {
      db.cleanup();
    }
  });

  it('narrows back to the column on the way back, and forward again is a usable empty table', () => {
    // The rollback round trip. What comes back is the **cardinality** rather
    // than nothing: the column was never dropped, so a row that stated one
    // service still states it after the reversal, out of the column it was
    // seeded from. What does not survive is a row's second and later services,
    // and nothing copies one of them back into a column that holds one id —
    // choosing which would be the migration inventing somebody's answer.
    //
    // The re-apply is the half that catches the bookkeeping: if `down.sql`
    // dropped the rows and left the table, or dropped the table and left the
    // `__drizzle_migrations` entry, this second `runMigrations` would either skip
    // a table it believes is there or fail on `table work_item_service already
    // exists`.
    //
    // Watched red: `DROP TABLE IF EXISTS work_item_service` struck from down.sql.
    const db = tempDb();
    try {
      atTheColumnOnly(db.path);
      seededOnTheColumn(db.path);
      runMigrations(db.path, FOLDER);
      const sqlite = openDatabase(db.path);
      try {
        sqlite.run("INSERT INTO work_item_service (work_item_id, service_id) VALUES ('w1', 's2')");
      } finally {
        sqlite.close();
      }

      expect(rollbackTo(db.path, FOLDER, SERVICE)).toEqual([WORK_ITEM_SERVICE]);
      for (const t of WORK_ITEM_SERVICE_TABLES) expect(tables(db.path)).not.toContain(t);

      const after = openDatabase(db.path);
      try {
        // The index goes with the table it is on, rather than being left behind
        // pointing at something that is gone.
        expect(
          after
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name = 'work_item_service_by_service'")
            .get()?.n,
        ).toBe(0);
        // The narrowing, stated as an assertion rather than as a warning in the
        // down script: `Payments` survives in the column, `Search` does not
        // survive anywhere.
        expect(
          after
            .query<
              { service_id: string | null },
              []
            >("SELECT service_id FROM work_item WHERE id = 'w1'")
            .get()?.service_id,
        ).toBe('s1');
        expect(
          after.query<{ name: string }, []>("SELECT name FROM work_item WHERE id = 'w1'").get()
            ?.name,
        ).toBe('Strip the roof');
      } finally {
        after.close();
      }

      runMigrations(db.path, FOLDER);
      for (const t of WORK_ITEM_SERVICE_TABLES) expect(tables(db.path)).toContain(t);
      // Re-seeded rather than restored, and the difference is the point: the
      // forward migration reads the column every time it runs, so what comes
      // back is what the column still says — one service — and not the two the
      // rollback narrowed away.
      expect(labelsOf(db.path, 'w1')).toEqual(['s1']);
    } finally {
      db.cleanup();
    }
  });
});
