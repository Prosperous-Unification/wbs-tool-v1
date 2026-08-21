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

`20260821150000_add_person_kind` — the column, `NOT NULL DEFAULT 'person'` under
a `CHECK`, written in section 2 at `c7c6fe9`. **This line said _not yet written_
for eleven chunks after it was.** Kept as a correction rather than an edit,
because a record that describes the branch as it lands has to be re-read at the
end and not only appended to; the section below is what re-read it.

Both stamps were chosen against every folder on disk before either existed, and
the check was re-run at `d654ce7` against all **26** folders:

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

### Up and down through the real CLIs, on a copy of the dev database

`migrate.test.ts` drives `runMigrations` and `rollbackTo` against databases the
test builds. That proves the functions; it does not prove the two **CLIs** the
deploy actually invokes, and it does not prove either migration against rows
somebody made. Both were run at `d654ce7` on h2puni (bun 1.3.14) against
`/tmp/tt-snap.db`, a byte copy of `~/wbs-dev/data/wbs.db` — **9 people, 342 work
items**, the dev deployment as it stood. The three CLI sources were `sha1sum`ed
on both boxes before anything ran (`26ec1f8…`, `6c4be02…`, `1065e93…`).

| Step                                                            | Answer                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `migrate-status-cli.ts` before                                  | `20260821080000_add_work_item_service` — the dev database is at `main`                                                   |
| `migrate-cli.ts`                                                | `migrations applied`                                                                                                     |
| after: tables                                                   | `role_measure` present, with **both** its autoindex and `role_measure_by_role`                                           |
| after: `person` columns                                         | `id, name, kind`                                                                                                         |
| after: `select kind, count(*) … group by kind`                  | **`person` × 9** — the backfill, on rows that predate the column, read rather than reasoned about                        |
| after: `role_measure` rows                                      | 0 — additive, and it invents nothing                                                                                     |
| `migrate-status-cli.ts` after                                   | `20260821150000_add_person_kind`                                                                                         |
| `migrate-down-cli.ts --to=20260821080000_add_work_item_service` | `rolled back: 20260821150000_add_person_kind, 20260821140000_add_role_measure` — **the two, newest first, and no third** |
| after down: tables / columns / status                           | `role_measure` gone, `person` back to `id, name`, status back to `…_add_work_item_service`                               |

**The half that matters was run a second time with the figures filled in.** An
empty new table survives a rollback trivially; a column drop is a table rebuild
in SQLite, and the question is what happens to the nine rows that were there
first. So: up again, one person set to `kind = 'agent'`, one `token_estimate` of
120,000 inserted against a real work item and role, then down. **Person count 9
before and 9 after, and the `id:name` digest identical across the rollback**
(`751b1fccfc3c493a` both sides) — the rebuild kept every row and every other
column of the person who had been marked an agent. What it did not keep is that
person's `kind` and that item's estimate, which is the definition of reversing
the migration that added them and is what `down.sql` says in its own comment.

**This is also the check that caught a false entry in this file's own Owed
list** — see the correction there about `role_measure_by_role`.

## The fault table

Each row was injected at the head named, run, and reverted; the revert was
checked with `git status --porcelain` returning empty. A red that does not fire
is a claim about the test that was run, not about the code — so each row names
the case that failed and the message it failed on.

| #    | Fault                                                                                              | Head      | Case that failed                                                                                                                                                                                  | Failure                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| F1   | `ON DELETE CASCADE` struck from `role_measure.work_item_id`                                        | `bdc1bc7` | `lets the outgoing release keep deleting work items against the migrated schema`                                                                                                                  | `SQLiteError: FOREIGN KEY constraint failed` — 60 pass, 1 fail                                 |
| F2   | `ON DELETE CASCADE` **added** to `role_measure.role_id`                                            | `bdc1bc7` | `refuses to let a role go while it still holds a measure, rather than emptying it`                                                                                                                | `Received function did not throw`, both measures silently gone — 60 pass, 1 fail               |
| F3   | `CONSTRAINT role_measure_metric CHECK (…)` struck from the table                                   | `bdc1bc7` | `refuses a fourth metric, because Drizzle's enum is gone by the time a row is written`                                                                                                            | the `'nonsense'` insert succeeds — 60 pass, 1 fail                                             |
| F4   | `CHECK (kind IN (…))` struck from the `ADD COLUMN`                                                 | `b43c188` | `refuses a third kind, because every reader dispatches on the set`                                                                                                                                | the `'robot'` insert succeeds — 5 pass, 1 fail                                                 |
| F5   | the migration rewritten as the table rebuild `tasks.md` 2.2 originally specified                   | `b43c188` | `leaves every membership and every assignment where it found them` **and** `gives the column back on the way down and keeps the directory whole`                                                  | `{people: 2, memberships: 0, assignments: 0}` — 4 pass, **2** fail                             |
| F6   | `if (changed.n === 0) return;` struck from `RoleMeasureRepository.moveAll`                         | `654033e` | `moves every metric to another work item, and moves neither revision when there was nothing to move`                                                                                              | revision 4 where 3 is owed — 10 pass, 1 fail                                                   |
| F6b  | `eq(roleMeasure.metric, metric)` struck from `remove`'s `WHERE`                                    | `654033e` | `removes one work item's role in one metric, touching neither the other metric, the other role, nor the same pair elsewhere`                                                                      | the pair's hours go with its tokens — 10 pass, 1 fail                                          |
| F7   | the `before === null` inverse struck from `setMeasure`, leaving `set_measure … value: before ?? 0` | `4765102` | `undoes a first recording back to absence, not to zero` **and** `undoes a first recording of one metric without touching the pair's others`                                                       | a stored 0 where nobody said anything — 14 pass, **2** fail                                    |
| F8   | `reason === 'unknown_metric'` struck from the controller's `statusFor` 404 list                    | `7df17f8` | `answers 404 for a unit it does not keep, on both verbs, and stores nothing`                                                                                                                      | `[400, 400]` where `[404, 404]` is owed — 57 pass, 1 fail                                      |
| F8b  | `params.metric` replaced by a hard-coded `'token_actual'` in the measures `PUT`                    | `7df17f8` | `records a figure in each unit against one pair, and clears one without touching the others` **and** `answers 404 for a unit it does not keep, on both verbs, and stores nothing`                 | one row overwritten three times, and `story_points` **written** as a 200 — 56 pass, **2** fail |
| F8c  | the `holdsKind` guard struck from `DirectoryService.patchPerson`                                   | `4f104d1` | `refuses a kind outside the set before anything is written` **and** `answers 400 invalid_kind for a kind outside the set, rename included`                                                        | a `kind` of `'robot'` reaches the store — 1024 pass, **2** fail                                |
| F8d  | `...(patch.kind === undefined ? {} : { kind: patch.kind })` struck from the store's one `set`      | `4f104d1` | `writes a name and a kind in one update, and a kind alone in one too`, `marks a person an agent and back, leaving their memberships alone` **and** `marks a person an agent, and marks them back` | the patch answers **200** and stores nothing — 1023 pass, **3** fail                           |
| F10a | `if (held.metric !== metric) continue;` struck from `rollUpMeasures`                               | `8868d6d` | `folds one metric without seeing the others on the same pair` **and** `leaves a role absent per metric rather than reporting it as zero`                                                          | three units summed into one figure — 1034 pass, **2** fail                                     |
| F10b | a **recorded** zero dropped on the way in (`if (held.value !== 0) byRole.set(…)`)                  | `8868d6d` | `keeps a recorded zero, which is not the same as nobody having said`                                                                                                                              | `has('dev')` false where somebody recorded a 0 — 1035 pass, 1 fail                             |
| F11a | `.filter(([, byRole]) => byRole.size > 0)` struck from `tree()`'s `measures`                       | `eee3826` | all seven of `the figures that are not days, read back through the tree` **and** three identity-oracle cases across two files                                                                     | every row carries three empty metrics — 1033 pass, **10** fail                                 |
| F11b | `MEASURE_METRICS` narrowed to `MEASURE_METRICS.slice(0, 1)` in the same fold                       | `eee3826` | `answers a leaf's own figures, metric first and then role` **and** three more of the same block                                                                                                   | two of three units missing from the wire — 1039 pass, **4** fail                               |
| F12a | `measured.length > 0` struck from `RoleRepository.remove`'s `in_use` condition                     | `38c17ec` | `counts the figures that are not days, and refuses an unconfirmed removal of a role that holds only those` **and** `carries the figures that are not days into the refusal it shows a person`     | a role whose only usage is two token figures is removed unconfirmed — 1050 pass, **2** fail    |
| F12b | `tx.delete(roleMeasure)` struck from the same transaction                                          | `38c17ec` | `deletes the figures that are not days with the role it confirmed, moving the work items that lost one`                                                                                           | `SQLITE_CONSTRAINT_FOREIGNKEY` out of the transaction — a **500** — 1051 pass, 1 fail          |
| F12c | `eq(roleMeasure.metric, taken.metric)` struck from `insertSubtree`'s `removedMeasures` delete      | `38c17ec` | `takes off only the metric a restore names, and leaves the pair's other figure`                                                                                                                   | a restore takes the parent's hours away with the tokens — 1051 pass, 1 fail                    |

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

### F10a: the metric parameter is the whole function

`rollUpMeasures` takes a metric and filters on it before it folds, and the
obvious reading of that line is a convenience — the caller could filter instead.
F10a strikes it at `8868d6d` and the answer is **1034 pass / 2 fail**, on
`folds one metric without seeing the others on the same pair` and
`leaves a role absent per metric rather than reporting it as zero`.

What the fault produces is not a wrong total in one unit. It is **one number
made of three units**: the same `(work_item_id, role_id)` pair holding a
`token_estimate` of 1000, a `token_actual` of 1400 and an `hours_actual` of 3
folds to 3 for whichever metric is asked, because the last row written to the
map wins and the parent sums whatever it finds. Nothing throws, nothing is
`NaN`, and every figure in the answer is a real recorded figure — it is a plan
reporting three hours of tokens. The primary key's third column is what stops
that, and it only stops it if the filter reaching the fold is the one the caller
asked for.

The second red case is the one that says the filter runs **before** the fold and
not after: with only a `token_actual` stored, `hours_actual` has to come back
with `dev` _absent_, and a fold that saw all three units answers it as present.

### F10b: a recorded zero is somebody's statement

`rollUpActuals` keeps a recorded zero and this had to as well, so F10b drops it
on the way into the map. **1035 pass / 1 fail**, on `keeps a recorded zero,
which is not the same as nobody having said`. The case asserts `has('dev')`
rather than the value, deliberately: `0` and `undefined` are both falsy, and a
test that read the value would have passed under this fault while the payload
lost the difference between "this role cost nothing" and "nobody has said".

### F11a: the identity oracles are what stop a payload inventing a unit

The one worth the injection in 5.2/5.3, and it is worth it for **where** it went
red rather than for how loudly. Striking the `size > 0` filter makes `measures`
carry `{token_estimate: {}, token_actual: {}, hours_actual: {}}` on every row of
every plan — nothing wrong per role, no number changed, and a screen rendering it
would show three empty columns where a reader is owed none. **1033 pass / 10
fail** at `eee3826`: the seven new cases in `measure.test.ts`, and then **three
cases in `capacity-migration-identity.test.ts` and
`priority-band-identity.test.ts`** that know nothing about this change at all.

That is 5.3's whole argument, and the argument is about the lift rather than the
assertion. Both oracles compare a whole payload against a capture taken before
`role_measure` existed, so the new key has to come **off** every row or sixteen
replayed plans fail on a field nobody moved a date with. A bare lift would have
done that and left the hole: a read path that invented a unit would pass sixteen
plans silently, because the key it invented was being dropped before the
comparison. `expect(measures).toEqual({})` is what closes it, and F11a is the
fault that proves the closing is real rather than decorative — the same shape
`team-sets` established for `teamIds` and `actual-days` for `actuals`.

### F11b: and the fault the oracles cannot see

Recorded because it did **not** redden everything, which is the more useful half.
`MEASURE_METRICS.slice(0, 1)` leaves only `token_estimate` reaching the wire:
every recorded hour and every recorded token-actual in the project vanishes from
the payload with nothing thrown, nothing logged and no figure wrong. **1039 pass
/ 4 fail**, all four in `measure.test.ts` — and **both identity oracles stay
green**, because their sixteen plans have no measures recorded in them, so a read
path that omits two units answers exactly what a read path that has none does.

So the oracles watch **invention** and are blind to **omission**, and the two
faults together say which file is load-bearing for which failure. The corpus can
only ever prove that a change added nothing; only a case that records a figure
and reads it back can prove the payload carries what it was given. Worth knowing
before section 6 leans on the same corpus for the structural moves.

### F12c: the fault chunk 12 could not reach, and the seam that reaches it

Chunk 12 wrote a case for `removedMeasures`' triple key, watched it fail on its
own setup, and deleted it — no path through `WorkItemService` can put a parent
in the state the fault needs. The hand-down empties the parent the moment it
gains a child, `setMeasure` refuses a work item that has children, and recording
on the parent while it is briefly a leaf again makes the undo refuse on the
revision. So at restore time everything the parent holds came from the hand-up,
the pair and the triple delete the same rows, and a case at the service seam is
green whichever `where` the repository was written with.

**The repository takes the command as given**, so it can be handed the state the
service cannot produce: a pair holding a `token_estimate` and an `hours_actual`,
and a `removedMeasures` naming only the first. F12c strikes
`eq(roleMeasure.metric, taken.metric)` and reddens **exactly one case** — the
new one. The failure it describes is a restore taking an hours fact off a parent
that has held it since before the delete, because a token estimate came home.

What this says beyond the one key: **a fault's reachability is a property of the
seam, not of the fault.** Chunk 12's conclusion — "nothing observable would go
red if it were wrong" — was true of every seam it had tried and false of the
repository, and the difference cost one chunk. Where a rule lives in a `where`
clause, the layer that writes the clause is where the rule can be watched.

### F13a, F13c, F13b: the control, and what each of its three claims is worth

`fe-01`, run **directly with `vitest` inside `apps/fe-01`** rather than through
Nx — lane B spent a chunk on injections that reported the cached number of the
correct code, so an injection that goes through a cache is worth nothing.
Baseline for the file: **45 pass / 0 fail**.

**F13a — `value={person.kind}` replaced by a hard-coded `value="person"`.**
**2 fail**: the read case and the round-trip case. This is the injection the
whole section turns on, because "existing people render as `person` without a
request" and "a control that reads nothing" draw the **same screen** for every
row this deployment holds today — nobody has been marked an agent yet. The
fixture that tells them apart is `CLAUDE`, stored `agent`, and without it the
section would have been green under a control wired to nothing.

**F13c — `{ kind }` replaced by `{ kind, name: nameShown(person) }`.** **1
fail**, the round-trip case, and it fails on the payload rather than on the
screen: the kind still arrives, the row still redraws, and what has quietly gone
with it is whatever half-typed name was standing in the box beside the control.
A patch is the set of fields somebody meant to change, and this is the fault
that sends one they did not.

**F13b — `if (kind === person.kind) return` struck.** **1 fail** beyond F13c's,
the no-op case. Worth recording for how that case had to be written: "no request
was made" cannot be waited for, so an assertion the moment after the event holds
whether the guard exists or not. The case fires the no-op, then a **real**
rename behind it, and asserts `patched` is the rename alone — the second write
is what gives the first somewhere to show up.

All three reverted, and the revert proved by `sha1sum` on both boxes
(`4657f3e…`) rather than by `git status`.

### The four cases that went red before any of that, and the query they indict

The `<select>` reddened **four existing membership cases** the moment it was
drawn: `screen.getAllByRole('option')` read `['Person', 'Agent', 'Design']`
where it meant `['Design']`. A `<select>`'s `<option>`s are in the accessibility
tree whether or not it is open, so the page now publishes options from two
places.

Those queries were narrowed to `within(getByRole('listbox', { name: 'Add a team
for Kat' }))`, which is what they had always meant — they were unambiguous only
because nothing else on the page had options. Recorded rather than fixed
quietly, because the other reading is available and wrong: that the control
should have been two buttons, to keep an old query working. A case that
constrains the page to publish exactly one kind of option has outgrown its own
assertion.

## The gate

Run on **h2puni** (`~/wbs-build`, bun 1.3.14), never on `h1claw`, with
`--skip-nx-cache`, and read off the log rather than assumed.

| Head                                        | What                                                    | Result                                                                      |
| ------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `3e8cb79` (rebase + the three stale lists)  | `nx run be-01:test`                                     | **975 pass / 0 fail**, 28,027 expect() calls, 73 files                      |
| `3e8cb79`                                   | `nx run-many -t lint typecheck -p be-01`                | exit 0                                                                      |
| `3e8cb79`                                   | `nx format:check --all`                                 | exit 0                                                                      |
| `bdc1bc7` (1.3, the six cases)              | `nx run be-01:test`                                     | **981 pass / 0 fail**, 28,042 expect() calls, 73 files                      |
| `bdc1bc7`                                   | `nx run-many -t lint typecheck -p be-01`                | exit 0                                                                      |
| `c7c6fe9` (section 2, `person.kind`)        | `nx run be-01:test`                                     | **987 pass / 0 fail**, 28,061 expect() calls, 73 files                      |
| `c7c6fe9`                                   | `nx run-many -t lint typecheck -p be-01`                | exit 0                                                                      |
| `c7c6fe9`                                   | `nx format:check --all`                                 | exit 0                                                                      |
| `654033e` (section 3, the store)            | `nx run be-01:test`                                     | **998 pass / 0 fail**, 28,083 expect() calls, 74 files                      |
| `654033e`                                   | `nx run be-01:lint`, `be-01:typecheck`                  | exit 0                                                                      |
| `654033e`                                   | `nx format:check --all`                                 | exit 0                                                                      |
| `7df17f8` (4.3, the measures routes)        | `nx run be-01:test`                                     | **1020 pass / 0 fail**, 28,145 expect() calls, 75 files                     |
| `4f104d1` (4.4, the person patch's kind)    | `nx run be-01:test`                                     | **1026 pass / 0 fail**, 28,157 expect() calls, 75 files                     |
| `4f104d1`                                   | `nx run-many -t lint typecheck -p be-01`                | exit 0                                                                      |
| `4f104d1`                                   | `nx format:check --all`                                 | exit 0                                                                      |
| `4b071b6` (2.4, the narrowing)              | `nx run be-01:test`                                     | **1028 pass / 0 fail**, 28,164 expect() calls, 75 files                     |
| `4b071b6`                                   | `nx run-many -t lint typecheck -p be-01`                | exit 0                                                                      |
| `4b071b6`                                   | `nx format:check --all`                                 | exit 0                                                                      |
| `8868d6d` (5.1, `rollUpMeasures`)           | `nx run-many -t test lint typecheck`                    | **1036 pass / 0 fail**, 28,179 expect() calls, 75 files                     |
| `8868d6d`                                   | `nx format:check --all`                                 | exit 0, red first (line wrapping)                                           |
| `7015af5` (5.2/5.3, the payload)            | `nx run be-01:test`                                     | **1043 pass / 0 fail**, 28,640 expect() calls, 75 files                     |
| `7015af5`                                   | `nx run-many -t lint typecheck --all`                   | **exit 1** — see below                                                      |
| `eee3826` (the lint fix)                    | `nx run-many -t lint typecheck --all`                   | exit 0, 22 projects                                                         |
| `eee3826`                                   | `nx run be-01:test`                                     | **1043 pass / 0 fail**, 28,641 expect() calls, 75 files                     |
| `eee3826`                                   | `nx format:check --all`                                 | exit 0, first time                                                          |
| `e82b023` (7.1 + 7.2, the first fe-01 work) | `nx run fe-01:test`                                     | **1588 pass / 0 fail**, 53 files                                            |
| `e82b023`                                   | `nx run-many -t lint typecheck -p fe-01`                | exit 0                                                                      |
| `e82b023`                                   | `nx format:check --all`                                 | exit 0, and 0 **first try** — the first head in this task that was          |
| `e82b023`                                   | the `--all` sweep, parallel                             | **killed for memory, not red** — see below                                  |
| `e82b023`                                   | `-t lint typecheck --all --parallel=1`                  | exit 0, 22 projects                                                         |
| `e82b023`                                   | `-t test --all --parallel=1`                            | **exit 1** — `mcp-01`, and it is four chunks old                            |
| `a5ff796` (the drift count + the format)    | `nx format:check --all`                                 | exit 0                                                                      |
| `a5ff796`                                   | `-t lint typecheck --all --parallel=1`                  | exit 0, 22 projects                                                         |
| `a5ff796`                                   | `-t test --all --parallel=1`                            | exit 0, **22 projects**                                                     |
| `a5ff796`                                   | be-01                                                   | **1052 pass / 0 fail**, 75 files, 28,669 expect() — unmoved, and owed to be |
| `a5ff796`                                   | fe-01                                                   | **1588 pass / 0 fail**, 53 files                                            |
| `a5ff796`                                   | mcp-01                                                  | **64 pass / 0 fail**, 230 expect() calls                                    |
| `04d644e` (`origin/main`, section 8)        | `bunx vitest run` in `apps/fe-01`                       | **1584 pass / 0 fail**, 53 files — the baseline, finally read               |
| `d654ce7` (section 8)                       | `bunx @fission-ai/openspec@1.3.0 validate --all --json` | exit 0, **72/72**, `token-tracking` `"valid": true`                         |
| `d654ce7`                                   | the two migration CLIs, dev-db copy                     | up and down, see "Up and down through the real CLIs"                        |

**The `--all` sweep has to be `--parallel=1` on this box.** Run wide it printed
`Killed` on `bunx eslint apps/be-01/src` with four targets in flight; h2puni has
7 GB with about 3 available. That is a memory kill and not a red, and the
difference matters because the serialized re-run is what surfaced the one real
red below.

### CI on #91, and three flakes that had to be told from a regression

`gate` **passed in 3m51s** on the first run — CI's own machine agreeing with
h2puni. `pixels` **failed 3 of 180**: `dark-mode.spec.ts:269`,
`header.spec.ts:377`, `hover-cards.spec.ts:85`. **Rerun: 180 of 180, 9m1s.**
Flakes, and now said so by a run rather than by an argument.

The argument was made first, and is kept because it is how the rerun was worth
starting rather than a guess dressed as one. The first failure never reached an
assertion — a 60s timeout inside `seedPlan`'s `beforeEach` waiting for
`getByLabel('Name of 020')`, with `[WebServer] Error: write EPIPE` and
`read ECONNRESET` running through the whole job either side of it. And the three
**moved**, which is the tell this queue already had a name for: the standing red
that `dark-mode-animations` fixed was one spec failing at the same number twice.
Corroborating rather than deciding: the only `fe-01` change on this branch is a
`<select>` on the directory card, and none of those three specs opens the
directory.

### The drift test that had been red for four chunks

`mcp-01`'s `is 47 tools, so a route that appears must be decided about` failed
**47 vs 49** at `e82b023` — and it had been failing since `2ad567c`, chunk 7,
when 4.3 put the two measure routes into `openapi.json`. Nothing caught it
because chunks 7 through 13 gated `-p be-01`, and chunk 11's widening was
`lint typecheck --all` with the suites left narrow.

The count is now 49 and names its two tools:
`putApiWork-itemsByIdMeasuresByMetricByRoleId` and
`deleteApiWork-itemsByIdMeasuresByMetricByRoleId`. **That is Dany's 2026-08-21
19:06 addendum discharged** — token figures reachable from MCP — and it is
discharged as a _check_ rather than as the assumption it was filed as: neither
path matches an exclusion class, so the tools were free, and this is the line
that observed it.

**The lesson is about the gate, not the count.** A drift test in one project
cannot be watched by another project's gate, and a count that only goes red
somewhere nobody is looking is a count that drifts in silence for four chunks.

`--all` on lint/typecheck rather than `-p be-01`, because 5.2 widens a type
`broadcast.ts` builds and fe-01 reads through the wire. It found the one red of
this chunk, and in a **test** file: `measure.test.ts:406` wrote
`measured.hours_actual ?? {}` inside the zero case, and
`no-unnecessary-condition` is right — the field's type is
`Record<string, Record<string, number>>`, so the left side cannot be nullish and
the fallback was dressing up an assertion as a guard. Rewritten as two
`Object.hasOwn` calls, which is what the case was actually claiming. Worth
noting for the trap chunk 6 recorded: `be-01:typecheck` builds
`tsconfig.lib.json` and **excludes** `.test.ts`, so lint is the only thing
reading these files at all.

The content gated was proved identical to the commit rather than assumed:
`sha1sum` on both boxes before the numbers were read, and again after each
injection was reverted (`1242b10` for `work-item.service.ts`, `342cd3e` for
`measure.test.ts`, `git status --porcelain` empty).

**Read the test count, not only the pass line.** Chunk 2 gated in `~/wbs-build`
against a tracking ref stranded at PR #17 and got a green **57 tests across 14
files** — a suite a sixteenth the size of the real one, passing. `git fetch` +
`bun install` before every gate there, and 975 vs 57 is the tell.

## The absence, checked

```
git diff --stat origin/main -- apps/be-01/src/service/schedule.ts libs/domain
```

Empty at `3e8cb79`, `c7c6fe9`, `654033e` and — the run that decides it, because
it is the diff the PR carries — at `d654ce7`, the branch head, on the gate host,
against `origin/main`. Re-run at each head rather than assumed to hold. D3 says
the scheduler cannot read this table; this is the sentence that checks it rather
than the one that claims it.

The scheduler's own answer is checked in a second place and by a different
means: `service/live-plan-identity.test.ts` replays the identity corpus through
a `WorkItemService` that now has the measures store wired into it
(`inMemoryMeasures`, and again inside `inMemorySubtrees`) — so the corpus runs
against a service that _can_ read figures and produces the same dates anyway. An
empty diff says the code that computes dates did not change; the corpus says the
dates did not change either.

## Owed

- ~~**The `--all` sweep at `e82b023` did not finish.**~~ **Closed in the same
  chunk**: re-run serialized at `a5ff796`, green across 22 projects for
  `test`, `lint`, `typecheck` and `format:check`. Kept because of what the
  re-run found — the `mcp-01` drift red above had been standing for four
  chunks, and it was standing precisely because the sweep that would have shown
  it had been skipped for a narrow one. A gate that is cheaper than the claim it
  is asked to support is not a gate.
- ~~**The `fe-01` baseline was not read.**~~ **Closed in section 8**: `bunx
vitest run` at `origin/main@04d644e` on the gate host answers **1584 pass / 0
  fail across 53 files**, so 1588 at `e82b023` is +4 as a reading rather than as
  arithmetic. Cost about 70 seconds, having been carried as an open claim for a
  chunk. Noted because the first attempt at it was wrong in an instructive way:
  `bun test` in `apps/fe-01` returns **537 pass / 94 fail** — `fe-01:test` is
  `bunx vitest run`, and running "the app's own runner" means the runner the
  target names, not the one the workspace uses everywhere else.
- ~~`bunx openspec validate --strict` has **not** been run.~~ **Closed in
  section 8, and the CLI is `@fission-ai/openspec`.** Bare `bunx openspec`
  resolves an unrelated npm package with no bin, which is exactly why it exited
  1 with "could not determine executable to run" — the tree was never missing a
  dependency, the name was wrong. `ci.yml`'s OpenSpec step pins
  `bunx @fission-ai/openspec@1.3.0 validate --all --json` and says so in a
  comment; run at `d654ce7` on h2puni it exits 0 with **72 items, 72 passed, 0
  failed**, and `token-tracking` is `"valid": true` with an empty `issues`. The
  "71/71" of earlier records was this same gate one change ago.
- ~~The migrations have not been run through the real `migrate` /
  `migrate-down` CLIs against a snapshot of the dev database.~~ **Closed in
  section 8** — the table above under "Up and down through the real CLIs",
  including the round trip with a recorded `agent` and a recorded estimate
  standing in the rows.
- ~~**`removedMeasures`' triple key is unproven, and no reachable path can prove
  it.**~~ **Closed in chunk 13** by the repository-seam case this entry asked
  for: `takes off only the metric a restore names, and leaves the pair's other
figure` hands `insertSubtree` a `removedMeasures` naming one metric of a pair
  that holds two, and **F12c reddens it and nothing else**. The reasoning below
  is why the proof had to live at that seam rather than in `undo.test.ts`, and
  stands as written.
- **The original entry, kept:** **`removedMeasures`' triple key is unproven, and
  no reachable path can prove it.** The `where` in `insertSubtree` names the metric so that a restore takes
  off only the figure the hand-up put on; keyed by the pair it would take the
  parent's own figures with it. The case that would say so fails on its own
  setup: the hand-down empties the parent when it gains a child, `setMeasure`
  refuses a work item that has children, and recording on the parent while it is
  briefly a leaf again makes the undo refuse on the revision — so at restore time
  everything the parent holds came from the hand-up, and both keys delete the
  same set. It was written, watched failing, and deleted with the reasoning left
  in `undo.test.ts` in its place. Pinning it needs a case at the **repository
  seam**: hand `insertSubtree` a `removedMeasures` naming one metric of a pair
  that holds two, and assert the other survives. Chunk 13, item 1.
- **`NumberedWorkItem` under-declares the payload, and it predates this change.**
  `actuals`, `progress` and `state` have been on every row of `tree()` since
  `actual-days` and `role-progress` and are on **no** interface: the object
  literal in `tree()` is built by `rows.map(...)`, whose result is not a literal,
  so excess-property checking never runs on it. 5.2 declares `measures` properly
  and deliberately does **not** widen the other three — each belongs to a merged
  change, and adding three required fields to a type `broadcast.ts` also builds
  is a typecheck-surface change that deserves its own gate rather than a ride on
  this one. Recorded here because the two identity oracles **destructure all
  four** and only pass because `be-01:typecheck` excludes `.test.ts`: the fields
  are checked by nothing at all today.
- ~~**`role_measure` has no by-role index, and two counts now scan it.**~~
  **WITHDRAWN IN SECTION 8 — THE ENTRY WAS FALSE.** The index has existed since
  section 1: `apps/be-01/drizzle/20260821140000_add_role_measure/migration.sql`
  line 112 creates `role_measure_by_role` on `role_measure (role_id)`,
  `down.sql` drops it before the table, and the migrated copy of
  the dev database above lists **both** `sqlite_autoindex_role_measure_1` and
  `role_measure_by_role`. This file's own "The stamps" section had said
  "indexed by `role_id` as `role_measure_by_role`" from the first chunk, twelve
  chunks before the entry claiming the opposite was filed against it.

  Kept rather than deleted, because the way it got here is the finding.
  Chunk 13 was reading `RoleRepository.usageOf` and `RoleRepository.remove`,
  saw the same "what does this role hold" shape that `actual_by_role` and
  `role_progress_by_role` exist to serve, inferred the absence from the two
  neighbours' presence, and wrote it down as a reading. **An index is a fact
  about a schema and `sqlite_master` answers it in one query** — the same query
  this section ran for another reason and got the answer for free. A filed
  non-issue is cheaper than a missed one and still not free: it would have cost
  a future chunk a migration, a gate and the ordering lists in both directions,
  all to add a thing that was already there.

- **Nothing else is owed.** The two entries above this one — `NumberedWorkItem`
  under-declaring the payload, and the `undo.test.ts` reasoning left where a
  case could not go — stand as recorded findings about the tree, not as work
  this change stopped short of.
