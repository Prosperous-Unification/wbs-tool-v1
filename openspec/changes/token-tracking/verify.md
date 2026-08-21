# verify — `token-tracking`

Branch `change/token-tracking`, cut from `main` @ `d4fe1d0` on 2026-08-21 and
**rebased onto `04d644e`** (the merged `service-split`) the same day. Dany,
2026-08-20 23:23: _"estimate token use and then record fact token use for each
task (even each phase/role) … then how many hours was spent on a task. Also
maybe allow to set agent as assignee."_

Four figures, one table. `role_measure (work_item_id, role_id, metric, value,
recorded_at)` with `metric` a `CHECK`ed closed set — `token_estimate`,
`token_actual`, `hours_actual` — plus `person.kind`. The argument for one table
rather than three is `design.md` D1; the argument for a column rather than a
boolean is D6.

The claim under all of it is an **absence**: a token figure is not evidence
about a date, so no date in any plan may move because one was recorded.
`service/schedule.ts` and `libs/domain/**` carry an empty diff, and that is
checked below rather than asserted.

**Prod mode** (`notes/delivery-modes.md`): this adds `apps/be-01/drizzle/**` and
touches `libs/domain`'s payload later in the change. The PR ends at **review**,
not merged.

**This file is written as the branch lands and says what has been run.** Rows
below carry the head they were run at. Sections marked _not yet run_ are owed,
not quietly skipped.

## The stamps

`20260821140000_add_role_measure` — the table above, `PRIMARY KEY(work_item_id,
role_id, metric)`, `work_item_id` cascading, `role_id` deliberately not, indexed
by `role_id` as `role_measure_by_role`.

`20260821150000_add_person_kind` — _not yet written_ (section 2).

Both stamps were chosen against every folder on disk before either existed:

```
ls apps/be-01/drizzle | sed 's/_.*//' | sort | uniq -d      # silent
```

That check is not ceremony. #60 and #61 both stamped `20260814100000` and
`migrationsToRollback` filters on a strict `created_at >`, so `rollbackTo`
reversed nothing at all, silently, with both tables still standing. The
mechanical half is `duplicateMigrationStamps` in `migrate-down.ts`, which throws
where the folders are read, and `refuses a folder set that shares one stamp
between two migrations` is its case.

**The stamps were chosen against a guess and the guess held.** They were written
while `change/service-split` was still in review, deliberately sorted past the
two folders that branch adds so that a database taking that release first would
not apply this one out of order. That branch merged first (`04d644e`, 14:05Z),
this branch was rebased onto it, and the two folders are now on disk below these
two — the guess is a fact, checked again by the `uniq -d` above at the rebased
head.

### What the rebase cost, and what found it

The rebase brought two migrations onto a branch whose tests enumerate, in about
twenty places, exactly what is newer than a given folder. Fifteen of those were
textual conflicts and were resolved by union. **Three were not conflicts at
all** — `main` wrote them after this branch was cut, so git had nothing to
flag — and every one of them was wrong at the rebased head:

| Where                               | Said                           | Says                                         |
| ----------------------------------- | ------------------------------ | -------------------------------------------- |
| `migrate.test.ts` `atTheColumnOnly` | `[WORK_ITEM_SERVICE]`          | `[ROLE_MEASURE, WORK_ITEM_SERVICE]`          |
| the service migration's round trip  | `[WORK_ITEM_SERVICE, SERVICE]` | `[ROLE_MEASURE, WORK_ITEM_SERVICE, SERVICE]` |
| the work-item-service narrow-back   | `[WORK_ITEM_SERVICE]`          | `[ROLE_MEASURE, WORK_ITEM_SERVICE]`          |

Five cases failed on those three lines, all of them tests this branch never
touched. The gate caught all five; reading the conflict list would have caught
none, because there was no conflict to read. Recorded because the shape recurs:
**after a rebase, an ordering assertion the merge did not flag is the one to
re-run, not the one to trust.**

## The fault table

Each row was injected at the head named, run, and reverted; the revert was
checked with `git status --porcelain` returning empty. A red that does not fire
is a claim about the test that was run, not about the code — so each row names
the case that failed and the message it failed on.

| #      | Fault                                                                                              | Head      | Case that failed                                                                                                                                                                                  | Failure                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| F1     | `ON DELETE CASCADE` struck from `role_measure.work_item_id`                                        | `bdc1bc7` | `lets the outgoing release keep deleting work items against the migrated schema`                                                                                                                  | `SQLiteError: FOREIGN KEY constraint failed` — 60 pass, 1 fail                                 |
| F2     | `ON DELETE CASCADE` **added** to `role_measure.role_id`                                            | `bdc1bc7` | `refuses to let a role go while it still holds a measure, rather than emptying it`                                                                                                                | `Received function did not throw`, both measures silently gone — 60 pass, 1 fail               |
| F3     | `CONSTRAINT role_measure_metric CHECK (…)` struck from the table                                   | `bdc1bc7` | `refuses a fourth metric, because Drizzle's enum is gone by the time a row is written`                                                                                                            | the `'nonsense'` insert succeeds — 60 pass, 1 fail                                             |
| F4     | `CHECK (kind IN (…))` struck from the `ADD COLUMN`                                                 | `b43c188` | `refuses a third kind, because every reader dispatches on the set`                                                                                                                                | the `'robot'` insert succeeds — 5 pass, 1 fail                                                 |
| F5     | the migration rewritten as the table rebuild `tasks.md` 2.2 originally specified                   | `b43c188` | `leaves every membership and every assignment where it found them` **and** `gives the column back on the way down and keeps the directory whole`                                                  | `{people: 2, memberships: 0, assignments: 0}` — 4 pass, **2** fail                             |
| F6     | `if (changed.n === 0) return;` struck from `RoleMeasureRepository.moveAll`                         | `654033e` | `moves every metric to another work item, and moves neither revision when there was nothing to move`                                                                                              | revision 4 where 3 is owed — 10 pass, 1 fail                                                   |
| F6b    | `eq(roleMeasure.metric, metric)` struck from `remove`'s `WHERE`                                    | `654033e` | `removes one work item's role in one metric, touching neither the other metric, the other role, nor the same pair elsewhere`                                                                      | the pair's hours go with its tokens — 10 pass, 1 fail                                          |
| F7     | the `before === null` inverse struck from `setMeasure`, leaving `set_measure … value: before ?? 0` | `4765102` | `undoes a first recording back to absence, not to zero` **and** `undoes a first recording of one metric without touching the pair's others`                                                       | a stored 0 where nobody said anything — 14 pass, **2** fail                                    |
| F8     | `reason === 'unknown_metric'` struck from the controller's `statusFor` 404 list                    | `7df17f8` | `answers 404 for a unit it does not keep, on both verbs, and stores nothing`                                                                                                                      | `[400, 400]` where `[404, 404]` is owed — 57 pass, 1 fail                                      |
| F8b    | `params.metric` replaced by a hard-coded `'token_actual'` in the measures `PUT`                    | `7df17f8` | `records a figure in each unit against one pair, and clears one without touching the others` **and** `answers 404 for a unit it does not keep, on both verbs, and stores nothing`                 | one row overwritten three times, and `story_points` **written** as a 200 — 56 pass, **2** fail |
| F8c    | the `holdsKind` guard struck from `DirectoryService.patchPerson`                                   | `4f104d1` | `refuses a kind outside the set before anything is written` **and** `answers 400 invalid_kind for a kind outside the set, rename included`                                                        | a `kind` of `'robot'` reaches the store — 1024 pass, **2** fail                                |
| F8d    | `...(patch.kind === undefined ? {} : { kind: patch.kind })` struck from the store's one `set`      | `4f104d1` | `writes a name and a kind in one update, and a kind alone in one too`, `marks a person an agent and back, leaving their memberships alone` **and** `marks a person an agent, and marks them back` | the patch answers **200** and stores nothing — 1023 pass, **3** fail                           |
| F9–F11 | the roll-up and the structure                                                                      | —         | —                                                                                                                                                                                                 | _not yet run_ (sections 5–6)                                                                   |

### F8b: the fault that says the path segment is load-bearing

F8 is the ordinary half — a refusal on the wrong status line. **F8b is the one
worth the second injection.** With the metric hard-coded, a `PUT` to
`/measures/story_points/:roleId` answers **200** and stores a `token_actual`:
the route accepts a unit this release does not keep and silently files it under
one it does, with nothing in the response saying so. It reddens the three-unit
case as well — three writes collapse into one row overwritten twice — which is
the same defect seen from the write side.

The pair is also why the metric is **not** re-checked in the controller: the
closed set lives beside the write, in `holdsMetric`, and a second copy at the
route would be two lists that must agree. F8b is what watches the segment
actually travelling from the path to that check.

### F6c: a fault that did **not** redden, and the assertion it leaves unwatched

`roleMeasure.metric` struck from `listByProject`'s `orderBy` — leaving
`(work_item_id, role.position, role_id)` — and the read-order case **still
passed, 11 of 11**. Not a flaky watch: the order it asserts is not coming from
the `ORDER BY` at all. `EXPLAIN QUERY PLAN` on the statement, run against bun's
SQLite:

```
SEARCH rm USING INDEX sqlite_autoindex_rm_1 (work_item_id=?)
SEARCH role USING INDEX sqlite_autoindex_role_1 (id=?)
USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY
```

The scan walks the primary key's own index, which **is**
`(work_item_id, role_id, metric)`, so rows arrive in metric order before any
sort runs, and the temp b-tree that orders the last two terms is stable — so
striking the tie-break changes nothing. No arrangement of rows can redden it
while that plan holds, because the plan is what produces the order.

**The term stays and the case is recorded as half-watched rather than deleted or
claimed.** A query plan is not a contract: an index added for the roll-up, a
`WHERE` rewritten in section 5, or a different SQLite build can each stop
supplying that order, and then the `ORDER BY` is the only thing between a reader
and two reads of an unchanged pair disagreeing on screen. What is asserted here
is real; what is unproven is that the assertion would notice. The watch that
would be worth having is at the payload layer, once 5.2 keys measures by metric.

Each fault fails **exactly one** case and the rest pass — with **F5 the stated
exception**, and the exception is the finding rather than a loose end. F5 is not
a constraint struck out of a working migration; it is the whole migration
written the other way, the way this change's own `tasks.md` specified before the
probe. It reddens two cases because it breaks two things: it empties
`person_team` and `assignment`, and it leaves a `person` whose stored DDL is a
renamed `person_new` rather than the original, so the rollback no longer restores
the table byte for byte. Both reds are real consequences of the procedure. The
one that matters is the first: the counts.

That is the control: a fault that reddens the file wholesale proves the suite
runs, not that the case under it is aimed at the constraint it names.

### F8d: a 200 for a write that did not happen

F8c is the ordinary half — the guard gone, so `'robot'` walks past the service
and reaches a column whose `CHECK` refuses it. **F8d is the one worth having.**
The store keeps `name` and `kind` in one `set`, and dropping `kind` from it
leaves a `PATCH` that answers **200** with a body a caller reads as
confirmation: `{ person: { …, kind: 'person' } }` for a request that said
`agent`. Nothing throws, nothing is logged, and the only way to notice is to
read the `kind` in the response — which is what the three cases do.

It reddens at all three layers, and that is why it was worth running rather than
reasoned about: the store case says the column was not written, the service case
says the outcome carried the stale value, and the route case says the 200 body
did too. A fault that reddened only the store would leave open whether either
layer above it asserts on this at all.

### F9a and F9b: the two halves of a required `kind`

The narrowing (2.4) is a type change, and a type change is exactly the sort of
edit that can be gated green by a compiler while nothing behavioural is asserted
at all. So both directions were injected at `4b071b6`, watched on h2puni, and
reverted with `git status --porcelain` empty.

- **F9a — the insert stops carrying the kind.** `tx.insert(person).values(toAdd)`
  becomes `values({ id, name })`, so the column falls back to its `DEFAULT`.
  **1027 pass / 1 fail**, exactly `adds an agent when the insert names one, and a
  person when it names nothing`. One case is the right number: nothing else in
  the suite creates an agent through the store, because nothing else can — the
  API makes agents by patching (4.4).
- **F9b — the read stops carrying it.** `listPeople` maps `kind` back off every
  row. **1020 pass / 8 fail**, across the repository, the service and the
  controller: three `DirectoryService.patchPerson` cases, four
  `PATCH /api/people/:id` cases, and the new
  `answers a kind for a person nobody has patched`. Eight is the answer to
  "would anything notice if a person came back kindless" — the read is asserted
  in three layers and both directions of the patch, not just where it was added.

The asymmetry between the two is the point of `PersonInsert` in one number: one
case guards the write's optional `kind`, eight guard the read's required one.

## The gate

Run on **h2puni** (`~/wbs-build`, bun 1.3.14), never on `h1claw`, with
`--skip-nx-cache`, and read off the log rather than assumed.

| Head                                       | What                                     | Result                                                  |
| ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------- |
| `3e8cb79` (rebase + the three stale lists) | `nx run be-01:test`                      | **975 pass / 0 fail**, 28,027 expect() calls, 73 files  |
| `3e8cb79`                                  | `nx run-many -t lint typecheck -p be-01` | exit 0                                                  |
| `3e8cb79`                                  | `nx format:check --all`                  | exit 0                                                  |
| `bdc1bc7` (1.3, the six cases)             | `nx run be-01:test`                      | **981 pass / 0 fail**, 28,042 expect() calls, 73 files  |
| `bdc1bc7`                                  | `nx run-many -t lint typecheck -p be-01` | exit 0                                                  |
| `c7c6fe9` (section 2, `person.kind`)       | `nx run be-01:test`                      | **987 pass / 0 fail**, 28,061 expect() calls, 73 files  |
| `c7c6fe9`                                  | `nx run-many -t lint typecheck -p be-01` | exit 0                                                  |
| `c7c6fe9`                                  | `nx format:check --all`                  | exit 0                                                  |
| `654033e` (section 3, the store)           | `nx run be-01:test`                      | **998 pass / 0 fail**, 28,083 expect() calls, 74 files  |
| `654033e`                                  | `nx run be-01:lint`, `be-01:typecheck`   | exit 0                                                  |
| `654033e`                                  | `nx format:check --all`                  | exit 0                                                  |
| `7df17f8` (4.3, the measures routes)       | `nx run be-01:test`                      | **1020 pass / 0 fail**, 28,145 expect() calls, 75 files |
| `4f104d1` (4.4, the person patch's kind)   | `nx run be-01:test`                      | **1026 pass / 0 fail**, 28,157 expect() calls, 75 files |
| `4f104d1`                                  | `nx run-many -t lint typecheck -p be-01` | exit 0                                                  |
| `4f104d1`                                  | `nx format:check --all`                  | exit 0                                                  |
| `4b071b6` (2.4, the narrowing)             | `nx run be-01:test`                      | **1028 pass / 0 fail**, 28,164 expect() calls, 75 files |
| `4b071b6`                                  | `nx run-many -t lint typecheck -p be-01` | exit 0                                                  |
| `4b071b6`                                  | `nx format:check --all`                  | exit 0                                                  |

**Read the test count, not only the pass line.** Chunk 2 gated in `~/wbs-build`
against a tracking ref stranded at PR #17 and got a green **57 tests across 14
files** — a suite a sixteenth the size of the real one, passing. `git fetch` +
`bun install` before every gate there, and 975 vs 57 is the tell.

## The absence, checked

```
git diff --stat origin/main -- apps/be-01/src/service/schedule.ts libs/domain
```

Empty at `3e8cb79`, `c7c6fe9` and `654033e` — re-run at each head rather than
assumed to hold. D3 says the scheduler cannot read this table; this is the
sentence that checks it rather than the one that claims it.

## Owed

- `bunx openspec validate --strict` has **not** been run. `openspec` is not a
  dependency of this repo (`node_modules/.bin/openspec` absent, `bunx openspec`
  on h2puni exits 1 with "could not determine executable to run"), so the CLI
  behind the "71/71" figure in earlier records lives outside the tree. Where it
  comes from gets resolved and stated here rather than quoted from memory.
- The migrations have not been run through the real `migrate` / `migrate-down`
  CLIs against a snapshot of the dev database. Section 8.2.
- Sections 2–7.
