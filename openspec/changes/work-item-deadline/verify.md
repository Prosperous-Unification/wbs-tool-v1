# Verify — Work item deadline

Evidence for the slices as they land. Slice 1 ships on its own branch and its
own PR (`tasks.md` 1.2), so its section is written here first; slices 2–10 land
on `change/work-item-deadline-field` and **append** to this file rather than
recreating it.

## Slice 1 — the migration and the column

Branch `change/work-item-deadline-column`, forked from `origin/main` at
`f89ebf56`. Everything below ran on **h2puni** over ssh, bun **1.3.14**; nothing
was built or tested on the workspace box.

**Which commit is which, because the numbers below are not all from the same
one:**

| commit     | what it is                                        |
| ---------- | ------------------------------------------------- |
| `5f0ede1a` | the column and the migration folder — **this is the commit that turned 39 be-01 cases red**, and none of the 39 were about the column |
| `dbe8d442` | registers `WORK_ITEM_DEADLINE` at the 32 sites that assert the newest migration by hand — **be-01 green again here**, which is what the gate table reports |
| `42964565` | this file: 1.3's transcript, and 1.1/1.3 ticked   |
| `c2f908f2` | Prettier's own formatting of this file            |

So the code gate stands at `dbe8d442` and the two commits after it are
documentation. A round-1 review read the gate table as claiming `dbe8d442`
itself was never red and called it a contradiction; it was ambiguity rather than
contradiction, and this table is the fix.

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
`COUNT(*)`, and one digest — sha256 over one string per row, in `id` order, of
every column except `deadline`. **The whole expression, not an excerpt**, because
a digest whose encoding cannot be read is a digest that cannot be checked:

```sql
SELECT length(quote(`id`)) || ':' || quote(`id`) || '|' ||
       length(quote(`project_id`)) || ':' || quote(`project_id`) || '|' ||
       length(quote(`parent_id`)) || ':' || quote(`parent_id`) || '|' ||
       length(quote(`position`)) || ':' || quote(`position`) || '|' ||
       length(quote(`name`)) || ':' || quote(`name`) || '|' ||
       length(quote(`notes`)) || ':' || quote(`notes`) || '|' ||
       length(quote(`frozen_number`)) || ':' || quote(`frozen_number`) || '|' ||
       length(quote(`start_no_earlier_than`)) || ':' || quote(`start_no_earlier_than`) || '|' ||
       length(quote(`service_team_id`)) || ':' || quote(`service_team_id`) || '|' ||
       length(quote(`revision`)) || ':' || quote(`revision`) || '|' ||
       length(quote(`priority`)) || ':' || quote(`priority`) || '|' ||
       length(quote(`max_parallel`)) || ':' || quote(`max_parallel`) || '|' ||
       length(quote(`start_no_earlier_than_reason`)) || ':' || quote(`start_no_earlier_than_reason`) || '|' ||
       length(quote(`service_id`)) || ':' || quote(`service_id`) || '|' ||
       length(quote(`created_at`)) || ':' || quote(`created_at`) || '|' ||
       length(quote(`updated_at`)) || ':' || quote(`updated_at`) || '|' ||
       length(quote(`created_by`)) || ':' || quote(`created_by`) AS h
FROM work_item ORDER BY id
```

That digest is what makes "existing rows are unchanged" a number rather than a
claim: it covers all seventeen pre-migration columns of all 940 rows, and
`ALTER TABLE ADD COLUMN` is exactly the statement that could rewrite them.

**Round 1's encoding was weaker and was refused, correctly.** It read
`COALESCE(CAST(col AS TEXT), char(0))` joined by `char(31)`, which is neither
injective nor unambiguous: a column changing from `NULL` to a string containing
a NUL byte serialises identically, and a separator byte inside `name` reads as
the boundary between `name` and `notes`, so a value could move between two
adjacent columns without the hash noticing. `quote()` renders `NULL` as the bare
token `NULL`, text as a single-quoted literal with embedded quotes doubled,
blobs as `X'…'` and numbers unquoted, so no value can collide with the null
marker; the `length(...) || ':'` prefix is what makes the field boundaries
unforgeable. Both readings below are from the stronger encoding, taken on a
freshly re-copied file.

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
untouched-column digest: 6a95bece327ca51c20adb499c8d18c7a41810c3f909f6847f7b9f81a43ce28c7
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
untouched-column digest: 6a95bece327ca51c20adb499c8d18c7a41810c3f909f6847f7b9f81a43ce28c7
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
because a rollback over a database where the column is present _and empty_
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
  fourteen fields; `'deadline' in row` is `false`. The value sits unread rather
  than breaking the read. (Unread is not the same as preserved through every
  path — see the section after this list.)
- **Its writes do not clobber.** `patch` on a row that carries `2026-10-01`
  succeeds, and that row still carries `2026-10-01` afterwards. All three seeded
  dates survive.
- **Its inserts leave NULL.** The row the old release inserted reads
  `deadline=NULL` — which is `migration.sql`'s own additive argument, measured:
  the outgoing release's `INSERT INTO work_item (…)` cannot name a column its
  schema does not have.

### The hole in the sentence above, found in review and confirmed at source

"The values sit unread" is true of the three paths measured and **false as a
general claim about the outgoing release's writes.** Round 1's OpenAI seat found
the counter-example; it was confirmed by reading the code rather than taken on
its word:

- `apps/be-01/src/service/work-item.service.ts` builds a delete's inverse as
  `rows: doomed.map((each) => rowOf(rows, each))`, and those `rows` came from
  the repository's projection.
- That projection is `WORK_ITEM_COLUMNS` in
  `apps/be-01/src/repository/work-item.ts`, which names fourteen columns and
  not `deadline`.
- `SubtreeRepository.insertSubtree` writes the journalled objects back with
  `tx.insert(workItem).values({ ...stored, ...auditOnCreate(stamp) })`.

So under the outgoing release: **delete a work item that carries a deadline,
then undo the delete, and the row comes back with `deadline` NULL** — the undo
answers `ok`, the branch looks whole, and a date somebody typed is gone. Neither
a patch nor a fresh insert shows it, which is why the transcript above stayed
green: the round-trip is a *read through a narrow projection followed by a write
of that projection*, and no single-path exercise reaches it.

**Nothing is lost by merging this PR**, and that is a statement about this
release rather than a defence of the claim: at this head no code writes
`deadline`, so no row can carry one to lose. `tasks.md` 1.2 is what makes that
true — the column ships alone.

**It becomes a live data-loss path the moment a later slice makes the column
writable, and the same projection is the reason.** The fix belongs there, not
here: whichever slice puts `deadline` on the API must also put it in
`WORK_ITEM_COLUMNS` and in the delete journal's restored row, and must carry a
case that deletes a deadlined item and undoes it. Recorded here rather than as a
separate task because this change already owns those slices, and recorded at all
because the alternative is a rollback note that reads safer than the code is.

### Rolling the migration back

**Not supported after the column holds data, and the narrower true statement is
what belongs on the record.** `down.sql` drops the column, so reversing it once
planners' dates are in it destroys them. What is *not* true is that the down
script is unexercised: `migrate-down.db.test.ts` rolls back to older baselines
and places `WORK_ITEM_DEADLINE` first in the returned list, so this `down.sql`
does execute there, and the reapply case runs it again. Its **syntax and its
ordering are covered**; what is deliberately never rehearsed is a rollback over
seeded, non-null deadline data. An earlier draft of this section said the
rollback was "not tested" flat out, which reads as an absence of coverage rather
than the deliberate omission it is.

A first attempt at this exercise re-copied `rollback.db` without removing
`rollback.db-wal`, and SQLite replayed the previous run's write-ahead log onto
the fresh file — the patched name arrived carrying two `(rolled back)` suffixes.
The transcript above is from a copy made after removing all three files. Noted
because a stale `-wal` beside a fresh `.db` is a contaminated fixture that still
looks like a clean one.

### Gates

At the committed bytes of `dbe8d442`, on h2puni, worktree clean, `md5sum` equal
on both hosts for `schema.ts` and both `.sql` files:

| target                     | result                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| be-01 unit                 | **1589 pass / 0 fail**, rc 0 (1515 before; the new folder adds cases to the migration walks themselves) |
| `nx run-many -t typecheck` | rc 0, 22 projects                                                                                       |
| be-01 lint                 | rc 0                                                                                                    |
| `prettier --check`         | rc 0                                                                                                    |

The column commit `5f0ede1a` alone turned **39 be-01 cases red, none of them
about the column**: a migration folder name is asserted by hand in eight test files —
seven behind a `READ_ORDER_INDEX` constant heading their rollback lists, and
`project.db.test.ts` as a literal — with fifteen sites in `migrate.db.test.ts`
alone. The second commit registers `WORK_ITEM_DEADLINE` at 32 sites. Three of
those sites are **ascending** applied-order lists where the rest are descending,
classified per site: the wrong direction yields a rollback-order assertion that
passes while stating the wrong order, which is the fault those files exist to
catch.

### Round 1 review

Both seats read the same clean worktree at `c2f908f2` and both returned
**BLOCK**; `apps/be-01/drizzle/**` is prod-mode, so Important blocks here.
Artifacts (byte count + SHA-256 sealed, `review-artifact.mjs verify` clean on
both): `queue/reviews/t267-slice1-r1-sol.txt` (`openai/gpt-5.6-sol`, 4940 bytes)
and `queue/reviews/t267-slice1-r1-agy.txt` (`gemini/antigravity-cli`, 21035
bytes).

**0 Critical from either.** Both confirmed independently that
`ALTER TABLE … ADD COLUMN` is metadata-only for this nullable, no-default,
constraint-free shape; that `down.sql` drops an unreferenced, unindexed column
and reverses before `20260906003000_add_work_item_read_order_index`; that all 32
registrations plus the one literal are on the correct side, with the three
ascending lists at `migrate-down.db.test.ts:532,646,755`; and that the diff
carries no domain, API or UI code.

What changed as a result:

| finding | seat | disposition |
| --- | --- | --- |
| delete-then-undo drops a stored deadline through `WORK_ITEM_COLUMNS` | sol (Important) | **confirmed at source**, claim narrowed above, obligation written into `tasks.md` 1.3 for the slice that makes the column writable |
| the digest's encoding was not injective and was published as an ellipsis | sol (Important) | **re-measured** with `quote()` plus length prefixes, full query committed above, both readings retaken on a fresh copy |
| schema and migration comments describe later slices as current behaviour | both (agy Important, sol Minor) | rewritten to say what this release does — nothing reads the column — and to mark the rest as later slices' |
| `deadline` inserted between the floor and the floor's reason, whose doc says "the one above it" | agy (Important) | column moved below `startNoEarlierThanReason`; the reason for the placement is now in its doc |
| `verify.md`'s head/gate SHAs were ambiguous | agy (Important) | the commit table at the top of this section |
| `down.sql` cited `migrate.test.ts`, which does not exist | agy (Minor) | corrected to `migrate.db.test.ts` and `migrate-down.db.test.ts` |
| "rolling the migration back is not tested" overstated the omission | sol (Minor) | narrowed above: syntax and order are covered, seeded-data rollback is the deliberate omission |
