# Design

## The term, first

CONTEXT.md's **Plan document** already lists `snapshot` under _Avoid_, so this
change does not introduce a second meaning for the word. The domain term is
**Saved plan** — Dany's own words ("Save plan") — and the tables, routes and
types spell it that way. The queue item stays `wbs-plan-snapshots`; the product
vocabulary does not.

A Saved plan is not a Plan document: a Plan document leaves the tool for a reader
and can be imported back into a **new** project; a Saved plan never leaves the
database, is never imported, and is never applied to any project. CONTEXT.md
gains the term in slice 1.

## The shape of the problem

Three facts on `main` decide everything below.

| Fact                                  | Where                                                       | Consequence                                                        |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `plan_event` is a log of **commands** | `schema.ts:1767`; `command-journal.ts:105` writes it        | Replay would be a second implementation of every command's inverse |
| …and it is pruned at 365 days         | `PLAN_EVENT_RETENTION_DAYS`, `repository/index.ts:1893`     | A saved plan built on it would expire                              |
| Dates are **derived**, never stored   | `schedule()` pure, `libs/domain/src/schedule.ts:1771`       | Re-deriving later restates history                                 |
| No whole-plan version counter exists  | `project.revision` excludes work items, `schema.ts:207-215` | A saved plan cannot be a pointer                                   |

So a saved plan is a **materialised document**. Not a pointer (nothing to point
at), not a re-derivation (the deriving code is about to change under TASK-219 and
TASK-240), and not an event-log checkpoint (pruned, and replay is wrong the
moment one command's semantics change).

## Two bodies, not one blob

```
saved_plan            id, project_id, name, created_by (by value), created_at,
                      input_schema_version, input_bytes, input_sha256,
                      schedule_schema_version, schedule_bytes, schedule_sha256,
                      schedule_input_sha256, scheduler_algorithm_id,
                      schedule_absent_reason
saved_plan_body       saved_plan_id, kind ('input' | 'schedule'), bytes
```

Two bodies rather than one because they version and fail independently:

- "no schedule was saved" is exactly _the schedule row is absent_, with a reason,
  rather than a sentinel inside a blob;
- `schedule_input_sha256 = input_sha256` is a checkable claim, so a schedule can
  never be rendered against an input it was not computed from;
- the two schemas move on different clocks — a new stored plan field does not
  invalidate every stored schedule.

**No `plan_event` high-water mark.** There is no per-project sequence in that
table, and project-setting writes (`ProjectService.update`) and step writes
(`StepService`) never reach it at all, so no marker in it describes the captured
plan. `Broadcaster.latestSeq` is a refresh cursor and must not be dressed up as a
plan version.

## The capture, and why one read snapshot is the whole difficulty

The live projection reads in **thirteen** separate awaited calls — ten at
`apps/be-01/src/service/work-item.service.ts:1285-1312` (project, work items,
estimates, actuals, progress, measures, dependencies, assignments, people, and
`broadcast.latestSeq`) and three at `:1364-1385` (`stepsOf`, `slotsFor`,
`listFor`). Twelve of them are reads of the plan and ride the snapshot;
`broadcast.latestSeq` is a refresh cursor and is not captured at all, for the
same reason it is not a plan version. A concurrent work-item edit, directory
cascade, step edit or setting change landing between any two of the twelve
produces a document describing a plan that never existed.

**The capture reads MORE than the projection, and every extra read rides the
same snapshot.** The projection renders in a browser that can resolve a label
against the live registry a moment later; a saved plan cannot, so it captures the
rows the projection only references by id — `tag` (`schema.ts:968`),
`work_item_type` (`:1063`), `external_system` (`:1085`), the junctions behind
labelling and ownership (`work_item_tag` `:1020`, the `typeId` reference `:1131`,
`work_item_external_ref` `:1170`, `work_item_team` `:921`, `work_item_service`
`:1343`, `person_team` `:1546`, `team_service` `:1273`) **and the team, service
and person rows those junctions and the capacity map name**. That last class is
one hop further than it looks: `slotsFor` is keyed by team id and needs no
junction row, so a capacity-only team — ordinary in the early planning this
feature targets — is named by no junction at all; and the projection's people
read is filtered to _assigned_ ids, so a person named only by a captured
`person_team` row is captured nowhere. None of these is among the thirteen. The
read set is therefore bounded by `CanonicalPlanInput`, not by
the projection, and a capture-only read left outside the snapshot reproduces the
defect exactly: a tag renamed between the item read and the registry read stores
pre-edit items beside post-edit labels, and every assertion written against the
twelve still passes.

No counter repairs it: work-item edits deliberately do not move
`project.revision` (`schema.ts:207-215`), and priority-band writes move no
revision at all (`priority-band.ts:22-24`).

So the capture runs inside **one SQLite read snapshot** (`BEGIN DEFERRED` on a
read connection under WAL, held across every read of the projection). One
in-flight save per project is _not_ the fix — it excludes another save and
nothing else.

`schedule()` runs **outside** that snapshot, over values already read out of it.
It is pure and needs no database; running it inside would hold the read
transaction open for the length of a scheduling run for no gain.

`created_at` is the instant that read snapshot opened, not the instant the
transaction committed. A slow capture makes them differ, and the honest label on
a comparison is when the plan was looked at.

**Write order: per-body byte checks → `BEGIN IMMEDIATE` → count and total quota
checks → header → input body → schedule body → commit.** The byte checks depend
on nothing in the database and may run first. The count and total must be read
_inside_ the write transaction: outside it, two saves at 99 of 100 both pass and
both commit, and the bound is broken while "refused before any row is written"
stays technically true.

## Fail-fast, not queue — and the concurrency refusal is the same door

A large body is one big write. Under SQLite's single writer, a save that queues
holds every live edit in the project behind it. The named behaviour is
**fail-fast**.

Two properties are wanted from one mechanism, and the difference between them is
a timeout, not a lock:

- A save that cannot take the write lock **at all** — because another save of any
  project holds it — is `snapshot_busy`.
- A save of a project another save is already writing must be refused rather than
  serialised, **across processes**, because blue and green are two processes on
  one file and an in-memory in-flight marker is invisible to the other one.

So a save opens `BEGIN IMMEDIATE` with `busy_timeout` **0** on a connection of its
own: an immediate `SQLITE_BUSY` is the typed `snapshot_busy` refusal, and there is
no window in which a second save waits. The 5-second bound applies to the save's
_total_ attempt including a bounded retry the caller may make, never to a single
blocking acquire.

**The retry and "refused, not serialised" are the same rule, not two.** What the
refusal buys is that no save ever _holds the lock while waiting_ — that is the
behaviour that would queue live edits behind two body writes. `SQLITE_BUSY` under
`busy_timeout` 0 cannot say whether the holder is a rival save or a live edit, so
a caller retry necessarily retries both, and that is correct: a retry that
acquires after the rival committed is a **fresh save over a new read snapshot**,
not the refused one resurrected, and the record it writes describes a plan that
did exist at that later instant. The project then holds two records, which is the
honest outcome, not a broken bound. The forbidden shape is the single blocking
acquire, which produces two records from _one_ contended attempt and holds edits
for the length of it. The spec requirement and its two scenarios are written to
that boundary.

Three connections are in play and none of them may be the same one: the capture's
read snapshot, the save's write connection, and whatever handle live edits use.
The read transaction is committed and released before `BEGIN IMMEDIATE` opens —
promoting a `DEFERRED` read transaction in place can fail `SQLITE_BUSY` under WAL
once another reader has touched the file, and by then the captured values are
already detached, so releasing it early costs nothing.

**The save's write connection is its own**, not the one live edits use. That is
the whole reason live editing keeps working: if a save shared the request
connection's write handle, edits would queue behind the body write regardless of
`busy_timeout`. TASK-231 states the connection topology it found and adds a
dedicated one if it is not already there — the guarantee in spec is about live
edits completing, and a shared handle silently voids it.

### The topology found (TASK-231, 2026-09-03) — one connection, and no pool

Read off the checkout rather than assumed, because the paragraph above turns on
it and the answer is worse than "not already there":

- **be-01 opens exactly one connection for the whole process.** `boot.ts:64`
  calls `openConnection(opts.dbPath)` once and hands the resulting `Drizzle` to
  every store. `repository/db.ts` is the only file permitted to open one — an
  ESLint rule restricts `bun:sqlite` and the drizzle bun adapter to it, because
  two of the three pragmas (`busy_timeout`, `foreign_keys`) are per-connection
  and a second handle opened elsewhere would silently run without them.
- **There is no pool.** `bun:sqlite`'s `Database` is a single handle, and
  drizzle's bun adapter wraps that one handle. So all three connections this
  design requires to be distinct — the capture's read snapshot, the save's write
  connection, and the handle live edits use — are **the same connection today**,
  and stay that way until this change opens dedicated ones.
- **Every store read yields before it queries.** The read methods open with
  `await Promise.resolve()` (`repository/estimate.ts:56`, `:83`, `:110`, `:127`,
  and the same shape across the folder). That is a real microtask suspension, so
  another in-flight request's continuation can resume and issue its own statement
  between two of the capture's reads.

**This inverts the hazard 3.1 was written against.** The danger here is not a
pool handing each read its own snapshot; it is a single connection on which a
held `BEGIN DEFERRED` encloses _everything else the process does_ until it
commits. A concurrent write would land inside the capture's transaction, where
its durability becomes the capture's to grant and a rollback of the capture takes
a stranger's committed-looking edit with it. That is a stronger reason for a
dedicated read connection than the one this document started with, and it is why
`openConnection` — not the process handle — is what 3.1 must call.

**Settled by measurement on 2026-09-03; it was a hypothesis until then.** The
enclosure above followed from the single connection plus the microtask yield, and
nothing had run that watched a foreign write appear inside a capture transaction.
3.2's first negative now has:
`saved-plan-capture.db.test.ts`, _"encloses that same write when the capture is
run on the shared process handle"_. One scenario is run twice, differing only in
the connection the capture is handed. On its own connection, a stranger's
`UPDATE tag SET name = 'renamed'` survives the capture's rollback and a third
connection reads `renamed`. On the process handle, the identical write is inside
the capture's transaction: the capture unwinds and the same third connection
reads the **pre-edit** `urgent`, with nothing in the writing request able to
observe that its committed-looking edit was revoked. Green on h2puni at
`92cad22b`. The "per-read connections" negative this section once named is gone,
not merely demoted: `bun:sqlite` has no pool, so it could only ever have been
staged.

### The three write-path requirements (TASK-231 4.0, 2026-09-03)

The topology above answers the _what_; these are the three obligations 4.1–4.6
inherit from it, stated separately because each is violable on its own.

**(i) The save's write connection is not the live-edit write handle.** Today
there is exactly one process handle, so a save written against `db` would put the
body write inside whatever the request path is doing, and 4.5's guarantee that a
live edit completes during a save would be void whatever `busy_timeout` says.
The save opens its own with `openConnection` and closes it, exactly as the
capture does.

**(ii) The read snapshot and the write are on different connections, and the read
is committed and released before `BEGIN IMMEDIATE` opens.** Not an ordering
preference — **measured on h2puni, 2026-09-03**, `/home/puni1/t231-probe/promote2.ts`,
a scenario per fresh database file:

| Scenario                                                                                   | `busy_timeout=0`                      | `busy_timeout=3000`                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------- |
| `BEGIN DEFERRED`, read, **another connection commits**, then write on the same transaction | `SQLITE_BUSY_SNAPSHOT` after **0 ms** | `SQLITE_BUSY_SNAPSHOT` after **0 ms** |
| the same promotion with no foreign write in between                                        | succeeds                              | succeeds                              |
| release the read with `COMMIT`, then `BEGIN IMMEDIATE` on that same connection             | succeeds in 1 ms                      | succeeds in 1 ms                      |

Three things follow, and only the first was already believed here. A `DEFERRED`
read promoted in place fails once **any** other connection has committed since
the snapshot — the control row shows the promotion itself is fine, so the foreign
commit is the cause. **`busy_timeout` does not rescue it**: the failure is
instant at 3000 ms as well as at 0, so the busy handler is never consulted, and a
retry loop built on `busy_timeout` would be a retry that can never succeed. And
releasing the read first costs nothing measurable — the same connection takes the
write lock in a millisecond immediately afterwards.

**A method note, because the first attempt at this produced a false negative.**
The probe originally reused one database file across all six scenarios and
reported the `busy_timeout=3000` promotion as _succeeding_, which would have read
as "the timeout rescues it". It did not reproduce once each scenario got its own
file. A shared fixture across rounds of a concurrency probe is not a smaller
probe, it is a different one.

**(iii) Releasing the read early is free, because the values are already
detached.** Slice 3 is exactly this: `readPlanInput` returns `PlanInputReads`
and closes, and `schedulePlanInput` runs over those values on no connection at
all (`saved-plan-schedule.ts`, asserted at 3.3). So by the time `BEGIN
IMMEDIATE` opens there is nothing left that the read transaction was holding
open on anyone's behalf.

## Quota

Permanent records on a shared SQLite file that any authenticated account can
write to (`project.service.ts:30-40` — unrestricted projects) need a bound even
without retention. **8 MiB per body, 100 saved plans or 64 MiB per project**,
whichever binds first, as configuration constants. Exceeding any of them is a
typed refusal naming the limit, never a silent prune — pruning would delete the
thing the feature exists to keep.

The guard is a **byte** count. `eventsVisited` (`schedule.ts:264-277`) counts
levelling search work and says nothing about serialized size.

## Comparison

One function, `diffPlans(left, right)`, both directions, over two **sides**. A
side is not a plan input: it is the canonical plan input, **plus** that side's
schedule — the stored schedule body, or the recorded absent reason where there is
none — **plus** the `scheduler_algorithm_id` the schedule was produced under,
which is a header column rather than a field of the schedule body. A signature
taking only the two inputs cannot see a date at all, and spec requires the
schedule side to be reported normatively: two saves with byte-identical inputs
and different dates are exactly what a `schedule()` semantics change produces,
and they must not compare as unchanged.

`current` is the live plan run through the same canonical projection, in memory,
written nowhere — **and it has a schedule like any other side.** It is
`schedule()`'s return over the values 7.3 captured, computed outside the read
snapshot as the save path computes its own, labelled with the _current_
algorithm identity, with a dependency cycle mapping to the same `infeasible`
absent reason a save records. Leaving it undefined is not neutral: spec bounds
schedule coverage by each side's stored schedule and `current` stores nothing,
so an implementer would lawfully pass `unavailable` and every saved-vs-current
comparison — the primary direction of this feature — would answer "no schedule
was saved" about the live side and report nothing about dates.

So snapshot↔snapshot and snapshot↔current are one code path and one test suite;
the API takes two sides and there is no compare-to-live endpoint.

Cross-version diffs **normalise forward only**: an older body is upgraded in
memory to the newest schema for the diff. Stored bytes are never rewritten — that
is the same rule as the immutability requirement, seen from the reader. A body
version the reader does not know fails loudly. (A future schema that _removes_ a
field needs an explicit down-conversion rule written at that change, not now.)

An open comparison does not swap under the reader: the list refreshes on the
existing broadcast, an open comparison offers a refresh affordance instead.

## Deletion and blue/green

`ON DELETE CASCADE` header→project and body→header, for `plan_event`'s stated
reason (`schema.ts:1759-1765`): blue and green share one SQLite file, and an
outgoing release that knows nothing of these tables must not have its
`DELETE FROM project` blocked by a hidden reference.

`created_by` is copied **by value**, so deleting an account cannot orphan or
erase a saved plan.

Migration is additive with a non-empty `down.sql`. Nodes that predate the routes
answer a typed unavailable outcome.

**A rollback destroys every saved plan**, and that cost is stated rather than
discovered: `down.sql` drops both tables, so rolling back past this migration
deletes records the product calls permanent. That is acceptable only while the
feature is new and no user has saved a plan they rely on. Once it is in real use,
a rollback is a data-loss decision, not a routine one, and the release that
retires these tables owes an export first.

## Integrity is checked, not assumed

A hash that nothing recomputes is a comment. Every read recomputes SHA-256 over
the stored bytes and compares it with the header; a mismatch is a typed refusal
(R5 — malformed trusted data throws, never defaults).

The header hashes must themselves be unrewritable, or the comparison
`schedule_input_sha256 = input_sha256` proves nothing: one `UPDATE` satisfies it
for a schedule computed from a different input. So the immutability guard covers
**both** tables — no `UPDATE` on `saved_plan_body` at all, and none on
`saved_plan` except `name`.

`name` is the one exception, and it is deliberate: A-1 saves immediately with the
server timestamp as the default name and lets the user name it afterwards, which
is an `UPDATE` of that column. Renaming is permissioned like delete (creator or
project owner) and touches nothing else.

## People stay named — a recorded limit

Dany chose `keep` on 2026-09-03: people and assignments are captured by value and
never rewritten, so a saved plan stays truthful about who owned what after that
person leaves the live plan.

The consequence is held rather than re-decided: **deleting a person from the live
plan no longer deletes them from stored data.** A person-erasure obligation would
need a purpose-built cross-saved-plan job this release deliberately does not
have. In exchange, no write ever touches an already-written body, so immutability
is "no `UPDATE` ever targets `saved_plan_body`" — a property a test can state in
one line.

## What was rejected

- **Frozen figures only** (the 2026-08-14 `plan_snapshot_figure` scope). Answers
  "did this estimate move" and nothing else: an added item, a reparent, an
  ownership change, a dependency and every date compare as "no change".
- **Event-log checkpoint.** Pruned at 365 days; replay reimplements every
  command's inverse; only what flows through `WorkItemService.record` is
  journaled, so anything written by another path leaves a hole.
- **Dates excluded** (schedule body always null). Not an increment toward storing
  them: bodies saved without dates can never gain them retroactively.

## Assumptions carried in, with what would falsify each

| #   | Assumption                                                                                                                                                                                | Wrong if                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | Name is optional; save writes immediately with the server timestamp as the default name, and naming is an edit afterwards, not a modal                                                    | users routinely rename within a minute of saving                                                                                                                      |
| A-2 | Save is fail-fast at 5 s, never queued or chunked                                                                                                                                         | normal projects miss the 5 s bound routinely, seen as `snapshot_busy` on first attempt                                                                                |
| A-3 | 8 MiB per body, 100 saved plans or 64 MiB per project — **measured, holds** (9.1)                                                                                                         | a normal project exceeds 8 MiB in one body — measure against the largest real plan before the limit ships                                                             |
| A-4 | `current` is projected, never stored, and consumes no quota                                                                                                                               | users expect a comparison they looked at to be retrievable later                                                                                                      |
| A-5 | Cross-version diffs normalise forward only                                                                                                                                                | a future schema removes a field rather than adding one                                                                                                                |
| A-6 | The domain term is **Saved plan**, not "snapshot"                                                                                                                                         | CONTEXT.md's Plan document entry drops `snapshot` from its _Avoid_ list                                                                                               |
| A-8 | "Creator" for permission is a nullable `created_by_id` reference beside `created_by`; a saved plan whose creator's account is gone is renameable and deletable by the project owner alone | owners routinely need to tidy up plans left by departed accounts and find the fallback insufficient, or a deployment wants creator rights to survive account deletion |

Origin and full argument: `notes/wbs-brief-2026-09-03-plan-snapshots.md` §5 in
the ops workspace; A-6 is decided here, A-3 and A-8 below.

### A-3, measured (TASK-232 run 11, 2026-09-04)

The largest real plan body is **50,975 bytes — 0.61% of 8 MiB**, over all 161
projects in the deployed database, measured by running the save path's own
functions rather than an estimate of them (`readPlanInput` → `planInputRowsOf` →
`canonicalisePlanInput` → `serialiseCanonicalPlanInput` → `bodyByteLength`).
That body is 63 work items at 809 bytes each, so 8 MiB is roughly **10,300 work
items in one project**; the whole corpus holds 927 across 161. The limit binds
nothing that exists and is not close to binding. Full table and the caveat about
which file holds the real data: `tasks.md` 9.1.

### A-8, decided here (TASK-231 run 14, 2026-09-04)

Task 6.1 permissions rename and delete as "creator or project owner".
`canEdit(project, actorId)` (`project.service.ts`) is the owner half. **There was
no creator half**: `saved_plan.created_by` is a display name captured at the
instant of the save and deliberately not a `users` reference — that is what makes
"People stay named" above true, and 6.3's property depends on it.

An id cannot be checked against a display name, and checking the actor's
_current_ display name against it is worse than useless: renaming an account
would silently grant or revoke the right, and two accounts sharing a display name
would share it. So the rule as written could not be built.

**Decided:** a nullable `created_by_id` column beside `created_by` — the
reference answers "may this account rename it", the value answers "who made
this", and the two questions stop sharing one column. Account deletion nulls the
reference and leaves the value, so 6.3 is unchanged and now has a second half
worth asserting. `NULL` means the creator's account is gone _or_ the plan predates
the column, which are the same thing for permission purposes: fall back to the
project owner, who exists whenever the project does. The migration is one
nullable column with no backfill.

**Rejected: owner-only.** No migration, and strictly safer than the ordinary
project write rule 6.1 warns about — but it takes from the person who saved a
plan on an unrestricted project the ability to delete their own record, and it
would make 6.2's `creator` column untestable by making it identical to the
third-party one. That is a product decision, and this is not the place to take it
by omission.
