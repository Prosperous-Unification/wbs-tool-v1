# Verify — the work-item read order

Every number below was taken on h2puni. Heads are named because the point of
the exercise is that a later reader can retake them.

## 1. The order, watched red before it existed

- [x] The three tests TASK-219 excised are back verbatim in
      `apps/be-01/src/repository/work-item.db.test.ts`, with the `spanOf` helper
      and the `@wbs/domain` + `slicesOf` imports that went with them.
- [x] Watched red against the unordered select at `84716c40`: **31 pass / 3
      fail** in that file — the same count TASK-219 run 13 measured against its
      green 34 / 0, so the fixture reaches `goesFirst`'s third tie-break rather
      than passing for an unrelated reason.
- [x] Green with `ORDER BY work_item.id` at `d5ef05d1`: **34 pass / 0 fail** in
      the same file.

### 1a. Retaken against the shipped schema, because the negative above does not cover it

The two runs above straddle `84716c40`, which is **before** §2 added the index.
That matters more than it looks. Peer review of PR 215 (`openai/gpt-5.6-sol`,
round 1, Important — `queue/reviews/t260-r1-sol.txt` in the worker repository)
observed that `beforeEach` builds each database through the whole migration set,
so at the shipped schema `work_item_project_id_id` on `(project_id, id)` exists
while the three cases run. With the `ORDER BY` deleted SQLite may then satisfy
`where project_id = ?` by walking that index and hand back ascending id order
anyway — the three cases assert on returned rows, so they would pass over a
query that promises nothing.

Retaken at `8ebb3a72`, the head that carries both the index and the fix:

- [x] Green: **35 pass / 0 fail** in that file.
- [x] Red, with `.orderBy(asc(workItem.id))` deleted and the index in place:
      **34 pass / 1 fail**. The one failure is the new case.
      **All three original order cases passed with the contract deleted.**

The new case is `asks for the order in the statement rather than inheriting it from an index`.

So the finding was right, and the measurement is the reason the new case exists:
it reads the emitted statement through drizzle's `logQuery` hook rather than the
rows, which nothing incidental can satisfy. Without it, deleting the `ORDER BY`
would have gone through the suite unseen at the schema this ships, and a later
planner or statistics change preferring `work_item_siblings` would have restored
the nondeterministic plan with no test going red.

## 2. The index

- [x] `work_item_project_id_id` on `(project_id, id)` in `schema.ts`, and one
      additive migration folder `20260906003000_add_work_item_read_order_index`
      with the `down.sql` that drops it.
- [x] The whole be-01 suite at `867be5eb`: **1514 pass / 0 fail**. That is the
      `origin/main` `0187a818` baseline of **1511 / 0** plus the three restored
      tests, which is what makes the intermediate failures below attributable
      rather than assumed.

| run                                            | head                       | result                        |
| ---------------------------------------------- | -------------------------- | ----------------------------- |
| be-01 suite, baseline                          | `0187a818` (`origin/main`) | **1511 pass / 0 fail**        |
| tests only, no `ORDER BY`                      | `84716c40`                 | 31 / 3 in the file under test |
| with the migration folder, lists not yet moved | `d5ef05d1`                 | 1473 pass / **41 fail**       |
| index split back out                           | `4a0a346a`                 | **1514 pass / 0 fail**        |
| index back in, 29 of 35 list sites moved       | `b4a4d2d5`                 | 1508 pass / **6 fail**        |
| all list sites moved                           | `867be5eb`                 | **1514 pass / 0 fail**        |
| `typecheck` + `lint`, be-01                    | `a4355e5c`                 | Successfully ran              |
| `nx format:check --base=0187a818`              | `a4355e5c`                 | exit 0                        |
| `openspec validate --all --json`               | `1c7a70c9`                 | 38 / 38 pass                  |

The 41 and the 6 were all enumerated migration-folder lists, which a new folder
legitimately moves. One of them was a bug in the assertion rather than in the
list: `optimized-schedule-cache.db.test.ts` asserted `names.at(-1)` was
`PROJECT_SETTINGS` under a test named for the `OPTIMIZER_TABLES` →
`PROJECT_SETTINGS` **adjacency**, so every future migration was a failure of
that file. It now asserts the adjacency.

### 2.3 `EXPLAIN QUERY PLAN`, before and after

Two databases, each migrated by `runMigrations` from a `git archive` of
`apps/be-01/drizzle` at a named commit, so the migration set is the shipped one
rather than a hand-built schema. **Before** is `b403291d^`… `b403291d` itself,
the last head without the folder — 39 folders; **after** is `a4355e5c` — the
same 39 plus `20260906003000_add_work_item_read_order_index`, and `diff` of the
two folder listings shows that one line and nothing else.

Each plan is read in a **separate process** from the one that migrated. That is
not fastidiousness: the earlier attempt took the control by dropping the index
in the migrating process and got `SQLITE_LOCKED`, because `runMigrations` leaves
a connection open on the file. Migrating two databases sidesteps the drop
entirely.

Query, the real one — `listByProject`'s fourteen columns, not a reduction:

```
SELECT id, project_id, parent_id, position, name, notes, frozen_number,
       start_no_earlier_than, start_no_earlier_than_reason, priority,
       service_team_id, service_id, max_parallel, revision
  FROM work_item WHERE project_id = ? ORDER BY id
```

```
before.db  indexes: sqlite_autoindex_work_item_1, work_item_siblings
  SEARCH work_item USING INDEX work_item_siblings (project_id=?)
  USE TEMP B-TREE FOR ORDER BY

after.db   indexes: sqlite_autoindex_work_item_1, work_item_project_id_id, work_item_siblings
  SEARCH work_item USING INDEX work_item_project_id_id (project_id=?)
```

**The prediction in `tasks.md` 2.3 was half wrong and the measurement corrects
it.** Before is not a `SCAN`: `work_item_siblings` leads on `project_id`, so the
`WHERE` was already index-served. What was not served was the sort, and the
temp B-tree is what disappears. The index earns its place by removing a sort of
every row in the project, which is the claim the migration comment now makes.

For the `SELECT id` shape the after plan is additionally covering —
`SEARCH work_item USING COVERING INDEX work_item_project_id_id (project_id=?)` —
and the before plan is the same `SEARCH` + temp B-tree as above.

## 3. The movement, over the population it can touch

A project can only move if it holds a sibling group with a duplicated
`(parent_id, position)`. With distinct positions `deriveNumbers` decides the
labels off `position` alone, both read orders produce a byte-identical schedule,
and the row order is not observable in the plan at all.

### 3.1 The probe, and what it found

Read-only over each live database — `new Database(path, { readonly: true })`,
no write and no WAL checkpoint:

```
SELECT project_id, parent_id, position, COUNT(*) AS n
  FROM work_item
 GROUP BY project_id, parent_id, position
HAVING COUNT(*) > 1
```

SQLite groups `NULL`s together, so root-level siblings — `parent_id IS NULL` —
are one group per project rather than one per row, which is the grouping
`work_item_siblings` and `placeAfter` both use.

Taken 2026-09-06, against the two databases a deploy of this change would reach:

| database                          | container              | migrations | projects | work items | tied groups              |
| --------------------------------- | ---------------------- | ---------- | -------- | ---------- | ------------------------ |
| `/home/puni1/wbs/data/wbs.db`     | `be-01-green` (prod)   | 1          | —        | —          | **no `work_item` table** |
| `/home/puni1/wbs-dev/data/wbs.db` | `dev-be-01-blue` (dev) | 39         | 183      | 940        | **0**                    |

**Prod holds no population to move.** Its schema is one migration deep —
`__drizzle_migrations`, `event_log`, `event_sequencer`, `examples`,
`sqlite_sequence` — and predates `work_item` entirely. That is a fact about the
release prod is running, not an empty table.

**Dev holds a real population and none of it is tied**: 940 work items across
183 projects, zero duplicated `(parent_id, position)`.

**So the answer to the reviewer's item 4 is zero, measured.** No existing
project's dates move on the deploy that ships this.

### The negative control, because a zero has to be shown capable of being non-zero

A probe that reports nothing proves nothing until it is watched reporting
something. Against a **copy** of the dev database — never the live file:

1. Probe the copy: `tiedGroups: []`, the same clean answer.
2. Tie exactly one pair: take the first sibling group of two or more (project
   `01dd0e69-8aca-46f0-92e0-5ce9a71f00ba`, `parent_id NULL`, 34 siblings) and
   `UPDATE work_item SET position = 10` on the row that sat at 20.
3. Probe the copy again: one group, `(project_id 01dd0e69…, parent_id null,
position 10, n 2)`, and `affectedProjects` names that one project.

The copy reads 181 projects / 939 items / 37 migrations against the live 183 /
940 / 39, because `cp` takes the main file without the `-wal` and dev is being
written to. The live figures in the table are the ones taken through a readonly
open, which reads the WAL; the copy's drift is why the control is a control and
not the count.

### 3.2 Pre/post fixtures

Zero affected projects, so there is no project-specific pre/post pair to build.
The behaviour that the fixtures would have demonstrated is asserted instead by
the third restored test in `work-item.db.test.ts`, which is a pre/post pair over
the one shape that moves: two unestimated leaves **tied on position** in a
one-slot pool, where id order places `00000000…` at 0 → 2 and `ffffffff…` at
2 → 4, and the insert order exchanges them. Its two siblings are the other two
restored tests, whose positions are **distinct** and whose schedules are
byte-identical under either read order — which is why no Fast assertion could be
added to them.

### 3.3 The announcement

> **No existing project's dates move.** This change makes
> `WorkItemRepository.listByProject` answer in `work_item.id` order. That order
> is only observable in a plan where two siblings share a `position`; measured
> on 2026-09-06 there is no such pair in either live database — prod's schema
> predates `work_item`, and dev holds 940 work items across 183 projects with
> zero duplicated `(parent_id, position)`. Every project is therefore named
> unaffected, none by omission.
>
> The tie remains legal and reachable — `work_item_siblings` is a plain index
> and `placeAfter` appends outside a lock, so two racing appends still compute
> the same number (ADR 0016). A tie created between this probe and the deploy
> would schedule under the new rule rather than the old one; that is the whole
> point of the change, and the probe above is re-runnable immediately before the
> swap if anyone wants the zero restated at deploy time.

## 4. The gate

At `0a15ebc3`, `dirty=0`, on h2puni:

- [x] `bunx nx run-many -t test lint typecheck build` — rc 0,
      `Successfully ran targets test, lint, typecheck, build for 22 projects`.
- [x] `bunx nx format:check --all` — rc 0.
- [x] `bunx @fission-ai/openspec@1.3.0 validate --all --json` — 38 items, 38
      passed, 0 failed.

The be-01 count in §2 is quoted at `bede02ab` because that is where it was
taken; `0a15ebc3` is that commit plus prettier whitespace inside this file and
nothing else, and the run-many above re-ran the same suite at the tip.
