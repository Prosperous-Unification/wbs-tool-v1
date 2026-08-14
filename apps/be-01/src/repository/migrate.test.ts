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
/** A table of its own and the newest, so it is the first thing any rollback reverses. */
const PRIORITY_BANDS = '20260814100000_add_priority_band';

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

      // Newest first. The three capacity migrations reverse in the opposite
      // order to the one they were applied in, which is the whole of the
      // rollback ordering claim: `project_team_capacity` down, then
      // `max_parallel` down, then `size` down. The per-project table reverses
      // ahead of the column it was seeded from, which is the only order in
      // which its foreign keys still have something to point at.
      expect(reversed).toEqual([
        PRIORITY_BANDS,
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

      expect(reversed).toEqual([PRIORITY_BANDS, PER_PROJECT_CAPACITY, MAX_PARALLEL, TEAM_SLOTS]);
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

      expect(rollbackTo(db.path, FOLDER, PER_PROJECT_CAPACITY)).toEqual([PRIORITY_BANDS]);

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
