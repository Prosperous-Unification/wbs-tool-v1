# Verify — Work item deadline

Evidence for the slices as they land. Slice 1 ships on its own branch and its
own PR (`tasks.md` 1.2), so its section is written here first; slices 2–10 land
on `change/work-item-deadline-field` and **append** to this file rather than
recreating it.

## Slice 1 — the migration and the column

Head **`dbe8d442`**, branch `change/work-item-deadline-column`, forked from
`origin/main` at `f89ebf56`. Everything below ran on **h2puni** over ssh, bun
**1.3.14**; nothing was built or tested on the workspace box.

### 1.3 — forward, on a copy of a real migrated database

The file is dev's live SQLite database, not a fixture: `/home/puni1/wbs-dev/data/wbs.db`,
the bind mount `dev-be-01-blue` serves `/data/wbs.db` from. It was **copied**,
never opened in place — `wbs.db`, `wbs.db-wal` and `wbs.db-shm` together, so the
copy carries the same committed and uncommitted state the running server sees:

```
$ cp /home/puni1/wbs-dev/data/wbs.db{,-wal,-shm} /var/tmp/t267-13/
$ md5sum /var/tmp/t267-13/wbs.db /home/puni1/wbs-dev/data/wbs.db
6f9a686008ee44d16dc56846f398bbc7  /var/tmp/t267-13/wbs.db
6f9a686008ee44d16dc56846f398bbc7  /home/puni1/wbs-dev/data/wbs.db
```

The reading is taken with `bun:sqlite` directly and **not** through the
repository layer, deliberately: a before-picture produced by the same code the
migration changes cannot say what the file held. `PRAGMA table_info`,
`COUNT(*)`, and one digest defined as

```sql
-- one row per work item, every column except `deadline`, in a fixed order
SELECT COALESCE(CAST(`id` AS TEXT), char(0)) || char(31) || … AS h
FROM work_item ORDER BY id
```

sha256'd row by row. That digest is what makes "existing rows are unchanged" a
number rather than a claim: it covers all seventeen pre-migration columns of all
940 rows, and `ALTER TABLE ADD COLUMN` is exactly the statement that could
rewrite them.

**Before** — a real database, mid-history, with the migration immediately
before this one already applied:

```
integrity_check: ok
work_item columns: 17
deadline column: ABSENT
work_item rows: 940
project rows: 183
untouched columns (17): id,project_id,parent_id,position,name,notes,frozen_number,
  start_no_earlier_than,service_team_id,revision,priority,max_parallel,
  start_no_earlier_than_reason,service_id,created_at,updated_at,created_by
untouched-column digest: 3e8e4da4e128ac6e8b8adda744796defcde2b5f1519d984a376e69d7d1804630
newest applied: 20260906003000_add_work_item_read_order_index | 20260904140000_add_project_settings | …
```

Applied through the **real CLIs**, the ones the deploy runs, not through a test
helper:

```
$ cd ~/wbs-t267/apps/be-01
$ DB_PATH=/var/tmp/t267-13/wbs.db bun run src/migrate-cli.ts
migrations applied
$ DB_PATH=/var/tmp/t267-13/wbs.db bun run src/migrate-status-cli.ts
20260906090000_add_work_item_deadline
```

**After**:

```
integrity_check: ok
work_item columns: 18
deadline column: type=TEXT notnull=0 default=null
work_item rows: 940
project rows: 183
deadline IS NULL: 940
deadline IS NOT NULL: 0
untouched-column digest: 3e8e4da4e128ac6e8b8adda744796defcde2b5f1519d984a376e69d7d1804630
newest applied: 20260906090000_add_work_item_deadline | 20260906003000_add_work_item_read_order_index | …
```

Every existing row reads `deadline: null` — 940 of 940, and the counter-query
`IS NOT NULL` reads 0 rather than being left to the first one's absence. The
digest is **byte-identical across the migration**, one column arrived, and the
183 projects and 940 work items are the same 183 and 940.

### 1.3 — the application rolled back with the column present

The migrated copy was copied again, and `~/wbs-t267` checked out at
**`f89ebf56`** — the commit this branch forked from, which is the release a
rollback goes back to. At that commit `work_item` has no `deadline`: the four
occurrences of the word in `schema.ts` are three prose lines and
`admittedDeadlineAt` on the optimizer's own table.

The exercise imports the **outgoing release's own** `WorkItemRepository` and
`openDrizzle`, so the SQL under test is the SQL that release emits, and its
`WORK_ITEM_COLUMNS` names fourteen columns with `deadline` not among them.
Three real rows are first given deadlines through raw SQL — the way the incoming
release would have written them, through code the old checkout does not have —
because a rollback over a database where the column is present *and empty*
proves nothing about values sitting unread.

```
column present in the file: yes
seeded deadlines: 2026-10-01, 2026-11-15, 2026-12-31
listByProject(98de264d-…) rows: 15
findById fields: frozenNumber,id,maxParallel,name,notes,parentId,position,priority,
  projectId,revision,serviceId,serviceTeamId,startNoEarlierThan,startNoEarlierThanReason
findById names a deadline: false
patch outcome: ok
inserted: a56e8e0b-3664-4d7d-9836-0b05c05418aa
deadlines after the old release wrote: 2026-10-01, 2026-11-15, 2026-12-31
the row it inserted: deadline=NULL
the row it patched: name="Collapse chain 020 (rolled back)" deadline=2026-10-01
```

Three claims, each with its own line above:

- **It reads.** `listByProject` returns the whole project and `findById` returns
  fourteen fields; `'deadline' in row` is `false`. The values sit unread rather
  than breaking the read.
- **Its writes do not clobber.** `patch` on a row that carries `2026-10-01`
  succeeds, and that row still carries `2026-10-01` afterwards. All three seeded
  dates survive.
- **Its inserts leave NULL.** The row the old release inserted reads
  `deadline=NULL` — which is `migration.sql`'s own additive argument, measured:
  the outgoing release's `INSERT INTO work_item (…)` cannot name a column its
  schema does not have.

**Rolling the migration back is not exercised and not supported**: `down.sql`
drops the column, and the column may hold planners' dates by then. `tasks.md`
1.3 says so; the drop exists because `migrate-down.db.test.ts` pairs every
migration on disk with a down script, and that pairing is a structural rule
rather than a promise this migration can be reversed after use.

A first attempt at this exercise re-copied `rollback.db` without removing
`rollback.db-wal`, and SQLite replayed the previous run's write-ahead log onto
the fresh file — the patched name arrived carrying two `(rolled back)` suffixes.
The transcript above is from a copy made after removing all three files. Noted
because a stale `-wal` beside a fresh `.db` is a contaminated fixture that still
looks like a clean one.

### Gates

At the committed bytes of `dbe8d442`, on h2puni, worktree clean, `md5sum` equal
on both hosts for `schema.ts` and both `.sql` files:

| target                                     | result                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| be-01 unit                                 | **1589 pass / 0 fail**, rc 0 (1515 before; the new folder adds cases to the migration walks themselves) |
| `nx run-many -t typecheck`                 | rc 0, 22 projects                                             |
| be-01 lint                                 | rc 0                                                          |
| `prettier --check`                         | rc 0                                                          |

The column commit alone turned **39 be-01 cases red, none of them about the
column**: a migration folder name is asserted by hand in eight test files —
seven behind a `READ_ORDER_INDEX` constant heading their rollback lists, and
`project.db.test.ts` as a literal — with fifteen sites in `migrate.db.test.ts`
alone. The second commit registers `WORK_ITEM_DEADLINE` at 32 sites. Three of
those sites are **ascending** applied-order lists where the rest are descending,
classified per site: the wrong direction yields a rollback-order assertion that
passes while stating the wrong order, which is the fault those files exist to
catch.
