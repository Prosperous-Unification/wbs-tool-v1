import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
// Its own migration, reversed with the domain: the join tables reference
// `work_item`, and `service` is referenced by one of them.
const RESOURCE_SETS = '20260814090000_add_resource_sets';

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
// `resource-model`'s three: two join tables referencing `work_item`, and the
// global service directory one of them points at. Reversed with the domain for
// the same reason every table above is.
const RESOURCE_TABLES = ['work_item_team', 'service', 'work_item_service'] as const;

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

      // Newest first. `resource-model`'s tables reverse ahead of everything
      // they reference, and the three capacity migrations reverse in the opposite
      // order to the one they were applied in, which is the whole of the
      // rollback ordering claim: `project_team_capacity` down, then
      // `max_parallel` down, then `size` down. The per-project table reverses
      // ahead of the column it was seeded from, which is the only order in
      // which its foreign keys still have something to point at.
      expect(reversed).toEqual([
        RESOURCE_SETS,
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
        ...RESOURCE_TABLES,
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
    // contract guarantees the effect". Four migrations now, reversed newest
    // first, and then the release that comes back must be able to write and read
    // a work item and a team without either column.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);

      const reversed = rollbackTo(db.path, FOLDER, PRIORITY);

      expect(reversed).toEqual([RESOURCE_SETS, PER_PROJECT_CAPACITY, MAX_PARALLEL, TEAM_SLOTS]);
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

/**
 * `resource-model`'s Claim A: the migration writes the right rows, and nothing
 * else.
 *
 * Claim B — that those rows produce the schedule be-01 gave before them — is
 * `service/capacity-migration-identity.test.ts`, replayed against the committed
 * oracle. Neither claim is the promise on its own: this file can only say what
 * is in the tables, and that file holds `resourceSetsOf`'s *output* fixed by
 * construction, so a seeding that wrote the wrong rows would pass it.
 */
describe('the resource sets migration', () => {
  /** The state the outgoing release leaves behind: teams, projects, and labelled work. */
  function beforeTheSets(dbPath: string): void {
    const before = openDatabase(dbPath);
    try {
      before.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
      );
      before.run(
        'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
          " VALUES ('p1', 'Rewire the shed', 'u', 0, 'pert', '2026-09-01', 0, 1)",
      );
      before.run("INSERT INTO service_team (id, name, size) VALUES ('t-platform', 'Platform', 4)");
      before.run("INSERT INTO service_team (id, name, size) VALUES ('t-backend', 'Backend', 1)");
      before.run("INSERT INTO person (id, name) VALUES ('kat', 'Kat')");
      before.run(
        "INSERT INTO person_team (person_id, service_team_id) VALUES ('kat', 't-platform')",
      );
      before.run("INSERT INTO project_team_capacity VALUES ('p1', 't-platform', 4)");
      for (const [id, name, team] of [
        ['w1', 'Strip', "'t-platform'"],
        ['w2', 'Rewire', "'t-backend'"],
        ['w3', 'Make good', "'t-platform'"],
        // The unlabelled row, which must be seeded nowhere: absence is the one
        // spelling of unstated, and a row here with an empty set would be a
        // second.
        ['w4', 'Snagging', 'NULL'],
      ] as const) {
        before.run(
          'INSERT INTO work_item (id, project_id, parent_id, position, name, notes, service_team_id, revision)' +
            ` VALUES ('${id}', 'p1', NULL, 10, '${name}', '', ${team}, 0)`,
        );
      }
    } finally {
      before.close();
    }
  }

  function rowsOf<Row>(dbPath: string, sql: string): Row[] {
    const after = openDatabase(dbPath);
    try {
      return after.query<Row, []>(sql).all();
    } finally {
      after.close();
    }
  }

  it('seeds one team row per work item that carried a label, and none for one that did not', () => {
    // Claim A. Every read path in this release takes a row's teams from
    // `work_item_team`, so this statement is the whole of "no plan moves": get
    // it wrong and sixteen captured plans come back with their pools unspent.
    //
    // Proof: the seeding `INSERT` struck from the migration, and this failed on
    // `expected [] to have a length of 3 but got 0` — with
    // `capacity-migration-identity.test.ts` failing beside it on `p1`'s first
    // capacity-floored slice, `boundBy` back to `roleOrder` and its
    // `earliestStart` moved. Watched 2026-08-14.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      beforeTheSets(db.path);

      runMigrations(db.path, FOLDER);

      expect(
        rowsOf<{ work_item_id: string; team_id: string }>(
          db.path,
          'SELECT work_item_id, team_id FROM work_item_team ORDER BY work_item_id',
        ),
      ).toEqual([
        { work_item_id: 'w1', team_id: 't-platform' },
        { work_item_id: 'w2', team_id: 't-backend' },
        { work_item_id: 'w3', team_id: 't-platform' },
      ]);
    } finally {
      db.cleanup();
    }
  });

  it('leaves the column it mirrors exactly where it was', () => {
    // The dual write's other half, at rest: the outgoing release selects
    // `service_team_id` on every tree read, so a migration that moved the label
    // instead of copying it would blank every row on the colour still serving.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      beforeTheSets(db.path);

      runMigrations(db.path, FOLDER);

      expect(
        rowsOf<{ id: string; service_team_id: string | null }>(
          db.path,
          'SELECT id, service_team_id FROM work_item ORDER BY id',
        ),
      ).toEqual([
        { id: 'w1', service_team_id: 't-platform' },
        { id: 'w2', service_team_id: 't-backend' },
        { id: 'w3', service_team_id: 't-platform' },
        { id: 'w4', service_team_id: null },
      ]);
    } finally {
      db.cleanup();
    }
  });

  it('seeds no service at all, and touches neither capacity nor membership', () => {
    // Three one-line assertions, and they are the cheapest possible proof that
    // Q3's answer was actually implemented: a service has no size, so no
    // capacity row moves; a service is not a thing to be a member of, so no
    // `person_team` row moves; and nothing in the data can say which of today's
    // teams somebody meant as a product area, so nothing is guessed into
    // `service`.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      beforeTheSets(db.path);

      runMigrations(db.path, FOLDER);

      expect(rowsOf(db.path, 'SELECT * FROM service')).toEqual([]);
      expect(rowsOf(db.path, 'SELECT * FROM work_item_service')).toEqual([]);
      expect(
        rowsOf<{ project_id: string; service_team_id: string; size: number }>(
          db.path,
          'SELECT project_id, service_team_id, size FROM project_team_capacity ORDER BY service_team_id',
        ),
      ).toEqual([{ project_id: 'p1', service_team_id: 't-platform', size: 4 }]);
      expect(
        rowsOf<{ person_id: string; service_team_id: string }>(
          db.path,
          'SELECT person_id, service_team_id FROM person_team ORDER BY person_id',
        ),
      ).toEqual([{ person_id: 'kat', service_team_id: 't-platform' }]);
    } finally {
      db.cleanup();
    }
  });

  it('lets the outgoing release keep deleting teams and work items against the migrated schema', () => {
    // The blue/green half. Nothing the outgoing release sends names these
    // tables, so the statements at risk are its `DELETE`s: without the cascades
    // both hit a constraint they cannot see and answer 500 for the length of
    // the swap.
    //
    // Proof: both `ON DELETE CASCADE` clauses removed from `work_item_team` and
    // this failed on the first delete with `SQLiteError: FOREIGN KEY constraint
    // failed`; watched 2026-08-14.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      beforeTheSets(db.path);
      runMigrations(db.path, FOLDER);

      const sqlite = openDatabase(db.path);
      try {
        // Nulling the column first is what the outgoing release does, and it is
        // not politeness: `work_item.service_team_id` carries a plain
        // `REFERENCES service_team(id)` with no `ON DELETE`, so the delete is
        // refused outright while any row still points at it. Measured, not read
        // off `schema.ts`, which does not declare that key — see the column's
        // own JSDoc.
        sqlite.run(
          "UPDATE work_item SET service_team_id = NULL WHERE service_team_id = 't-platform'",
        );
        sqlite.run("DELETE FROM service_team WHERE id = 't-platform'");
        expect(
          sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM work_item_team').get()?.n,
        ).toBe(1);
        sqlite.run("DELETE FROM work_item WHERE id = 'w2'");
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

  it('reverses to the schema before it, leaving every label in the column', () => {
    // What a rollback costs, asserted rather than argued: nothing, while the
    // write paths are capped at one member. The release that comes back reads
    // the column, the column was kept in step by the mirror, and the tables
    // that go were holding a copy of what it holds.
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);
      beforeTheSets(db.path);
      runMigrations(db.path, FOLDER);

      const reversed = rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY);

      expect(reversed).toContain('20260814090000_add_resource_sets');
      expect(tables(db.path)).not.toContain('work_item_team');
      expect(tables(db.path)).not.toContain('service');
      expect(tables(db.path)).not.toContain('work_item_service');
      expect(
        rowsOf<{ id: string; service_team_id: string | null }>(
          db.path,
          'SELECT id, service_team_id FROM work_item ORDER BY id',
        ),
      ).toEqual([
        { id: 'w1', service_team_id: 't-platform' },
        { id: 'w2', service_team_id: 't-backend' },
        { id: 'w3', service_team_id: 't-platform' },
        { id: 'w4', service_team_id: null },
      ]);
    } finally {
      db.cleanup();
    }
  });
});
