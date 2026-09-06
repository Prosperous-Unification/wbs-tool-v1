# Tasks — Work item deadline

TDD slices for the change described in `proposal.md`, `design.md` and
`specs/scheduler-optimization/spec.md`. Every slice names the test that proves
it; every safety check names the negative test watched failing with the check
removed (R5). Nothing here is implemented yet — this is the plan TASK-240
delivers, and implementation lands as its own queue tasks.

**Order matters, and there is no corrections appendix.** A later review's
disposition is folded into the slice it changes and the superseded text is
deleted, never appended as a new section. Slice 1 is the prod-mode migration and
is isolated for that reason alone. Slices 2–5 are Fast and the domain. Slices
6–8 are the seam this change amends in `dual-optimized-scheduler`. Slice 9 is the
UI. Slice 10 is the gate. **A slice is not done until its remote gate on h2puni
is green — no build or autotest runs on the workspace box.**

**This change must land before TASK-219 (`wbs-optimized-scheduler-coordinator-cache`)
starts.** It changes the canonical input, the cache identity, the solver wire and
the failure state machine — all four of TASK-219's subjects.

**Who executes what, because half of this cannot be executed here.** Verified at
this head with `git ls-tree`: **neither `libs/contracts/solver/` nor the wire
schema exists** — `libs/contracts/` holds only `README.md`, `project.json`,
`src/` and its tsconfigs, and a tree-wide search finds zero `solver*` directories
and zero `solver-wire*` files. There is no cache table and no CP-SAT model
either. TASK-219 creates all of it. (An earlier revision of this paragraph said
the directory existed; that came from reading `libs/contracts/`'s own listing and
attributing it to a child. Corrected here rather than left standing, because
"verified at this head" is the sentence TASK-219 reads first.) So:

| Slices            | Owner                                          | Why                                                                                                                                        |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–6, 9, 10.1–10.3 | **this change's own queue tasks**              | column, converter, fold, `schedule()`'s seventh argument, Fast ordering, API, UI — all against code that exists                            |
| 7, 8              | **TASK-219 absorbs them**                      | they assert cache-key columns (7.4), hash behaviour (7.1, 7.6) and a wire schema (8.1) belonging to artifacts TASK-219 has not created yet |
| 10.4              | **both owners, each at its own terminal gate** | AGENTS.md's cross-provider review binds whoever ships a diff; it is not one task's checkbox                                                |

Consequently **W1, W3 and W4 are watched here; W2, W5 and W6 are watched inside
TASK-219**, and 10.1's "all six recorded failing" spans both tasks rather than
one. Written down because the alternative is a queue that either blocks slice 8
on a file that does not exist or lets two tasks implement it twice.

The pre-219 obligation is therefore this document, not slices 7–8's code:
TASK-219 must start from a plan that already says seven arguments, `infeasible`,
`deadlineUnits` and a seventh `VariantState`. That is what "lands before" means
here.

## 1. Migration and column — PROD MODE, own PR

- [x] 1.1 `work_item.deadline TEXT NULL` in
      `apps/be-01/src/repository/schema.ts`, beside `start_no_earlier_than`,
      with a forward migration under `apps/be-01/drizzle/`. **No reason
      column** — the floor's `start_no_earlier_than_reason` gets no counterpart
      here, and adding one speculatively is out of scope.
- [x] 1.2 **`apps/be-01/drizzle/**` is a prod-mode path**
(`notes/delivery-modes.md`): this slice ships as a reviewed PR and is not
      self-merged, and it carries **nothing else** — no domain code, no API
      field, no UI. That isolation is the same one TASK-218 applied to the cache
      migration, and it is what lets slices 2–9 self-merge.
      Done: PR #218, squashed to b2bb095c on 2026-09-06T11:07:15Z, on the whole
      h2puni gate green at be24dc90 across 22 projects and CI green in both
      jobs. Three review rounds, both seats, round 3 PASS, zero Critical in all
      six verdicts. Its diff is the migration folder, the schema column, the
      nine hand-written registration files and this change's own spec — no
      domain code, no API field, no UI, exactly as written. Keep prose in this
      item free of inline code spans: the item's own first line puts a literal
      double asterisk inside a code span, and prettier reparses the rest of the
      file when more marked-up text follows it.
- [x] 1.3 Proof, not assertion: the migration runs forward on a copy of a real
      migrated database file and every existing row reads `deadline: null`
      afterwards. Rolling the **application** back with the column present is
      exercised once — the old column list does not name `deadline`, so the
      values sit unread. Rolling the **migration** back over seeded deadline
      data is not exercised because it is not supported; it drops user data.
      (The down script itself is not uncovered — `migrate-down.db.test.ts`
      executes it and covers its syntax and its ordering. The narrower true
      statement, corrected here after round 2 rather than left standing.) **Done — transcript in `verify.md`:**
      a copy of dev's live `wbs.db` (940 work items, 183 projects, 17 columns,
      no `deadline`) migrated through the real `migrate-cli`, after which all
      940 rows read null, the counter-query `IS NOT NULL` reads 0, and a sha256
      over all seventeen untouched columns of all 940 rows is byte-identical
      across the migration. Then `~/wbs-t267` at `f89ebf56` — the commit this
      branch forked from — read, patched and inserted through the outgoing
      release's own `WorkItemRepository` against that file with three rows
      seeded by raw SQL: `findById` returns fourteen fields and no `deadline`,
      the patched row keeps `2026-10-01`, and the row the old release inserted
      reads null. **Round 1 review found the limit of that claim and it is
      binding on a later slice:** the delete journal's inverse is built from
      `WORK_ITEM_COLUMNS`, which does not name `deadline`, and
      `insertSubtree` writes that projection back — so delete-then-undo returns
      the row with `deadline` NULL. Harmless while the column is unwritable,
      which is this release. **Whichever slice first makes `deadline` writable
      must add it to `WORK_ITEM_COLUMNS` and to the delete journal's restored
      row, and must carry a case that deletes a deadlined item and undoes it.**

## 2. `deadlineOffsetOf` and `previousWorkday`

- [x] 2.1 `previousWorkday` exported from `libs/domain/src/workday.ts` beside the
      existing `nextWorkday`.
- [x] 2.2 `deadlineOffsetOf(projectStart, deadline)` returning
      `{ kind: 'offset'; offset: number } | { kind: 'before-project-start' }`,
      rolling **backward** on a non-working date and returning the typed variant
      — never the number `0` — when the rolled date falls before day zero
      (`addWorkdays(projectStart, 0)`, which is `nextWorkday(projectStart)` and
      not `projectStart` itself).
- [x] 2.3 The mirror of the existing `addWorkdays`/`workdaysBetween` property
      test: for every workday `s` and offset `k`,
      `deadlineOffsetOf(s, addWorkdays(s, k))` is `{ kind: 'offset', offset: k }`.
- [x] 2.4 **WATCHED RED W3** — substitute `workdaysBetween` for
      `deadlineOffsetOf`. Two cases must go red together: a Saturday deadline
      must grant two extra calendar days (`nextWorkday` rolls it to Monday), and
      a pre-project-start deadline must silently become offset `0`, the
      strictest possible deadline in place of what the user typed. A test that
      only catches the first is not this red.

## 3. The effective-deadline fold

- [x] 3.1 `effectiveDeadlines(rows, deadlines)` folding each leaf to the
      **minimum** of its own deadline and every ancestor's, `null` where none
      exists. It is a separate walk from the floor's `latest` expansion and is
      **not** collapsed into one direction-parameterised function with it: the
      out-of-range clamps differ (§1.3) and are not shared.
      **Deviation, recorded rather than silent:** it landed under
      `dual-optimized-scheduler` as `leafDeadlinesOf(deadlines, index)` in
      `libs/domain/src/leaf-constraints.ts`, not as `effectiveDeadlines(rows,
deadlines)`. Every substantive clause holds — `Math.min` fold, **absent**
      rather than `null`-valued where no deadline exists, a separate walk sitting
      beside `leafFloorsOf` and deliberately not parameterised by comparator, and
      the file's own table spelling out why the floor, the deadline and
      `priorityByLeaf` are three rules and not one. A second function under
      3.1's literal name would be the second walk this slice exists to prevent.
- [x] 3.2 Both precedence directions asserted, not one: a parent dated earlier
      tightens a later child, **and** a later parent does not loosen an earlier
      child. One test proves nothing about the fold's direction; two do. The
      second direction was the one missing: `keeps each leaf the EARLIEST …`
      already had the loose parent, where `min` is indistinguishable from "the
      leaf's own date wins". `lets an EARLIER parent tighten a later child` is
      the new case, and a fold that simply preferred the leaf's own value passes
      every other case in that describe and fails only this one.
- [x] 3.3 A dated row constrains **exactly the leaves under it** — for a row
      with children that is its descendant leaves and not the row itself, and
      for a childless row, which `indexTree` counts as a leaf under itself, that
      is the row. So deleting a parent's subtree leaves its stored date binding
      the row it was written on, raises no error, and emits nothing for the
      children that are gone.

      **The clause was first written as "a parent with a deadline and no leaves
      emits no constraint", and that sentence names no state this tree can
      reach.** A row with no children _is_ a leaf in `indexTree`, so
      `leavesUnder` is never empty for a row the tree carries. Written that way
      the item could only be closed by a check that cannot fail, which is why
      the rule above replaces it rather than being reconciled with it — recorded
      2026-09-06 against a review finding that read the old sentence and the
      test together and found them opposed. The decision is that the date
      survives: discarding a formerly-parent id as unresolvable would delete
      something the user wrote by deleting rows underneath it, with nothing to
      undo because nothing recorded it. The consequence is deliberate — after
      the delete `P` is an ordinary dated leaf, so Fast orders it by its slack
      and reports its `lateBy` like any other.

      A second revision on the same day narrowed the rule again: it had been
      written "constrains the leaves under it **and never itself**", which is
      true of a row with children and false of the childless one the same
      sentence goes on to describe. "Exactly the leaves under it" is the one
      form that covers both, and `indexTree`'s definition of a leaf is what
      makes it one rule rather than two.

      **All three halves are proved, and they fail differently.** _Not the row
      itself, when it has children_: `carries a deadline written on a parent
      down to every leaf beneath it` compares the whole map,
      `[['L1', 20], ['L2', 20]]`, so a fold that also constrained `P` fails on
      the extra entry. _Keeps its date, when it has none_: the pruned-subtree
      case goes red on a fold that drops such an id. _Emits nothing_: the
      empty-map case goes red on a fold that seeds every leaf.

- [ ] 3.4 The two impossible kinds are distinguished at their own boundaries:
      `before-project-start` at write time (slice 6) is malformed input;
      unreachable-but-well-formed is legitimate input that Fast reports late
      (slice 5) and PRI/Time report infeasible (slice 8).
      **Two of the three boundaries stand as of 3.4/4.2 and the box stays open
      on the third.** Write time is slice 6's service refusal (422, naming the
      work item and the project's day zero). Read time is
      `deadline-plan-read.test.ts`'s moved-start case: the same resolution, the
      opposite verdict — the request is not rejected, the stored value is not
      rewritten, and Fast reports the row late by the whole span. What is still
      owed is the third clause, `plan-infeasible` from PRI/Time, which is slice
      8 and TASK-219/241's; this item cannot be closed from inside this task.
- [x] 3.5 **WATCHED RED W4** — fold with `max` instead of `min`; a child dated
      earlier than its parent must be loosened to the parent's date. Measured on
      h2puni: 532 pass / **4 fail** — `keeps each leaf the EARLIEST of its own
deadline and every ancestor's` (the clause the red names), `lets an EARLIER
parent tighten a later child`, `takes the tighter ancestor when two of them
bind`, and `keeps a day-zero deadline, which is a real and very tight
constraint`. Restored, md5 `6ad8e4d9` equal on both hosts.

## 4. `schedule()`'s seventh argument and the inclusive predicate

- [x] 4.1 `schedule(rows, edges, slices, notBefore, poolSizes, reach, deadlines)`
      with `deadlines: ReadonlyMap<string, number>` **defaulted to an empty map**,
      so every existing caller compiles unchanged and the no-op proof in 4.3 is
      about behaviour rather than about call sites.
- [ ] 4.2 The predicate, applied per slice against its effective deadline offset,
      written **once** as `lastWorkdayOf(start, finish) <= deadlineOffset` and
      referenced by slices 5, 8 and 9 rather than re-derived in any of them.
      `finish <= deadline` does not appear in the implementation.
      **Deliberately still open at 2026-09-06 even though `on-time.ts` landed in
      run 1.** Its clause names slices 5, 8 **and** 9, and only slice 5
      references it so far — `goesFirst`'s `slack` shares `lastWorkdayOf`, the
      single arithmetic, rather than re-deriving a comparison. Ticking it now
      would claim a referent for two slices that do not exist yet, and 8 is
      TASK-219's. Close it when 9 reads the same number.
      **Still open after 3.4/4.2, and for the same reason rather than by
      oversight.** The plan read now puts `lateBy` — the number
      `workdaysLateBy` produced from this one predicate — on every slice the
      payload carries, so the referent slice 9 needs is on the wire and no
      second comparison was written to get it there. The clause names three
      slices and two of them still do not exist.
- [x] 4.3 **The no-op proof.** Every case in the Fast golden corpus produces a
      **byte-identical** schedule under the seventh argument defaulted to an
      empty map. This is the one test that says the seam did not move; it is
      compared byte-for-byte against the recorded corpus, not field-by-field.
- [x] 4.4 **WATCHED RED W1** — drop the `max` term from `lastWorkdayOf` in the
      predicate (use `ceil(snapWorkdays(finish)) − 1` alone). A zero-duration
      milestone starting at exactly offset `D + 1.0` must be reported **on
      time**. A non-zero-duration fixture cannot produce this red; the test must
      be the milestone.
- [x] 4.5 A deadline changes a placement **only through ready-set order**, and
      never overrides a hard lower bound: a slice's floor, its dependencies and
      its earlier steps decide the earliest day it can start at all, and no date
      written on it moves that — so a leaf whose floor is later than its
      effective deadline still starts at its floor and is reported late. Landed
      as two cases in `schedule-deadline-order.test.ts`, and both stay green
      under 5.1's watched reds — correctly, because the comparator only chooses
      between slices that are already eligible.

      **The clause has been narrowed twice, in one day, by two review findings
      that caught the same habit.** It first read "a deadline never moves work
      earlier", which is false under a minimum-slack queue: winning the ready
      set is precisely moving earlier, and the first case in `minimum slack
      orders the ready set` has `b` starting at 2 with the map empty and at 0
      with it populated. The replacement, "decides an order, never a date", was
      false in the other direction — an order the leveller acts on _is_ a date,
      which is what that same counterexample shows, and it also read as though
      the floor were the only thing between a slice and day zero when a queue
      for a person or a team is another. What is written above is the rule the
      two cases have always proved, and it names what the deadline may move as
      well as what it may not.

## 5. Fast ordering and `Late by N workdays`

- [x] 5.1 Ready-slice order becomes minimum slack (`deadlineOffset −
earliestFinish`, whole workdays), then earliest effective deadline, then
      the **existing, untouched** priority tie-breaks. Slices with no effective
      deadline sort after every deadlined slice, holding their existing relative
      priority order. Landed as two comparisons in front of `goesFirst`'s four,
      with `slack` and `deadline` on `SlicePriority`. `earliestFinish` is read
      as `lastWorkdayOf(start, finish)` over the **deadline-free** placement —
      the same pass `start` and `float` already read, because slack against the
      leveled placement would be circular. Absence is `Infinity` for both, by
      the arithmetic that already gives `priority` its `Infinity`, so the
      undeadlined ordering is the old one unchanged rather than a special case.
- [x] 5.2 `Late by N workdays` per missed slice, with
      `N = lastWorkdayOf(start, finish) − deadlineOffset`, `N >= 1`, computed
      from 4.2's single predicate so the label and the lateness verdict cannot
      disagree. The copy says **workdays**. Landed as `lateBy: number | null` on
      `ScheduledSlice`, from `workdaysLateBy` over the **leveled** placement and
      the **folded** deadline — the two choices the watched reds below are
      about. `N >= 1` is expressed in the type rather than trusted to readers:
      `null` is "not late" and covers both the undeadlined slice and the one
      that met its date, so no label layer can print `Late by 0 workdays`.
      `schedule-deadline-order.test.ts`'s 4.5 case stopped calling
      `workdaysLateBy` with a deadline offset it supplied itself and reads
      `only.lateBy` instead — the earlier form would have passed with the field
      absent.
      **WATCHED RED W-5.2a** — the wrong question, `finish > deadlineOffset`
      in place of the shared predicate: **5 fail** of 8, including the
      zero-duration milestone and the inclusive boundary.
      **WATCHED RED W-5.2b** — the authored map (`deadlines`) in place of the
      folded one (`leafDeadlines`): **2 fail**, exactly the two ancestor cases,
      so neither red subsumes the other and each names its own choice.
      **`SCHEDULE_ALGORITHM_ID` bumped `slice-leveling-v1` → `v2` and the
      behaviour digest re-pinned `5f5d507bdf199577` → `18b55455829f4eb1` in the
      same commit**, which is that constant's own stated rule and names this
      change: "TASK-240's deadline" qualifies by the doc on the constant. The
      corpus that digest runs over passes no deadlines, so 5.1's reordering
      moved nothing in it — the digest moved on this slice's field alone.
- [x] 5.3 Fast still never backtracks and never moves work earlier than its
      floor: the existing invariant tests run unchanged against a corpus that now
      carries deadlines. `deadline` is the **sixth generated fact** in
      `schedule-resource-corpus.test.ts`, drawn last so no earlier draw moved,
      and all three invariants — nobody in two places, no pool oversubscribed,
      no manual floor undercut — pass unedited over a thousand deadlined plans.
      The strip-differential moves 446 of the 1,000 seeds, so the fact is read
      rather than merely written down. **Priority's own count fell 461 → 130 in
      the same measurement**, which is the ordering change visible in a number:
      deadlines are asked first, so on most contended plans the priority
      comparison is never reached. Recorded in the file, with the stale
      "tightest is dependency-reach" note amended to priority.
- [x] 5.4 A project start moved past a stored deadline resolves
      `before-project-start` **at read time** and is reported late by the whole
      span — the stored value is not rewritten and the request is not rejected.
      **The domain half is landed and the box stays open on the storage half.**
      `deadlineOffsetsOf(projectStart, deadlines)` in
      `libs/domain/src/deadline-offsets.ts` is the read-time resolution: every
      entry decided by `deadlineOffsetOf`, keys carried through **as authored**
      so the fold inside `schedule()` stays the only expansion, and
      `before-project-start` read as `UNMEETABLE_DEADLINE_OFFSET = -1`.
      **`-1` is a recorded assumption, not a number the design supplies** — the
      design says "late by the whole span" in prose and settles no offset. It is
      the encoding that makes that sentence true under 5.2's arithmetic:
      `lastWorkdayOf` is at least `0` for every slice, so the row is late by
      every workday it stands on plus the one it owed, and it sorts first under
      5.1 with no special case. What falsifies it: a decision that such a row
      reads a fixed label rather than a count — which changes the label and not
      this offset, because the row is still late and still first.
      **WATCHED RED W-5.4a** — drop the entry instead of resolving it: **4 fail
      of 7**, and the two lateness cases read `null`, which is the row reported
      **on time**. **WATCHED RED W-5.4b** — clamp to `0` instead: the same four,
      and the difference is the symptom rather than the set. Under the clamp the
      three-day case reads `2` for `3`, and `is late on day zero itself` reads
      **on time** — the only fixture whose failure is a met date rather than a
      wrong number, because a one-day item finishing on day zero meets every
      offset a clamp can produce. Recorded this way rather than as two separable
      reds, which is what a first reading of them claimed.
      **The storage half landed at 3.4/4.2 and closes this box.**
      `work-item.service.ts`'s plan read builds the as-authored
      `Map<workItemId, IsoDate>` off the rows it already has and hands it to
      `deadlineOffsetsOf`, under the same rule the floors beside it take: a
      project with no `startDate` has no day zero to count from and applies
      none, which is the one branch `NO_DEADLINES` still names. The two claims
      this item makes about the write are asserted by the moved-start case in
      `deadline-plan-read.test.ts` — the one named for reporting a moved project
      start late by the whole span — which moves the project under a
      legally-written date and then reads both the plan and the row: `lateBy`
      **2** for a two-day slice standing on workday 1 — `-1` subtracted, the
      whole span — and the stored `2026-03-04` still on the work item. The
      project update that moved it was not rejected, and that half is asserted
      at the layer that could reject it: the case drives the move through
      `ProjectService.update` — where `bad_start_date` and `bad_pert_weights`
      live — and asserts `ok`. Through `ProjectStore.update` it would have been
      the check that cannot fail, since a repository can only report a vanished
      row; found by the round-1 Sol seat and closed by moving the call, not by
      narrowing the claim. That service is asked nothing about deadlines, which
      is what makes this read-time rather than write-time. Its two reds are the ones recorded above, restated as this
      case sees them: drop the entry and it reads `null` (on time), clamp to `0`
      and it reads `1`.
      **The seam's own red, watched rather than argued:** the read reverted to
      `NO_DEADLINES` — both the ask and the `schedule()` call — leaves **5 of
      the 7 cases in `deadline-plan-read.test.ts` red** on h2puni at `9d4542f5`.
      The two that survive are the file's declared negative controls, and they
      survive for the reason that makes them controls: an unwired read also
      reports a met deadline as `null`, and the no-start-date case is the
      `NO_DEADLINES` branch itself, which the revert makes universal. Each says
      so where it stands rather than being left to look like coverage.

## 6. API, realtime, undo

- [x] 6.1 `deadline` joins the work-item PATCH payload as a nullable `IsoDate`.
      Non-`IsoDate` → refused through the **existing** malformed-payload path;
      `deadlineOffsetOf` returning `before-project-start` → `422` naming the
      offending work item and the project's day zero, which is the **only**
      deadline-specific rejection; `null` clears it.
      Done: `parsePatch` reads it with `asOptionalDate`, the floor's own reader,
      so a non-date is `deadline_must_be_a_date` through the path that already
      existed. **That path answers 400, not the 422 this item first said**, and
      the sentence is corrected here rather than the code bent to it: the
      requirement is the existing path, asOptionalDate throws BadRequest, and
      the batch route's default for a malformed body is 400 — the same status
      every other malformed field on this payload gets. Making the deadline
      alone 422 would be a new path, which is what this item forbids. The case
      that asserts it is the one named "refuses a deadline that is not a date,
      the way every other malformed field is refused" in
      work-item.controller.test.ts. Found by the round-1 Gemini seat, which read
      refusalFor rather than the claim. The day-zero refusal is the
      **service's**, not the controller's — it is the first layer holding the
      project as well as the payload — and it
      answers 422 over the batch route's own 400 default through a new
      `UNPROCESSABLE` arm in `refusal-status.ts`, carrying `workItemId` and
      `projectDayZero` out through the batch runner's existing `detailOf`.
      A project with **no start date** is asked nothing: there is no day zero
      for a date to fall before, which is the plan read's own rule for floors.
- [x] 6.2 Authorization is the existing work-item write authorization —
      asserted by a test that a caller who may edit a work item may set its
      deadline, so no new authority is silently introduced.
      Done: both directions in one case on a restricted project — the owner's
      set lands, the stranger's is `forbidden` 403 and the stored date is
      unchanged. The owner's 200 alone would pass against a route checking
      nothing.
- [x] 6.3 No new event type and no new undo verb: `deadline` rides the existing
      work-item update event and the existing undo stack. Redo of a clear
      restores `null`; redo of a set restores the date. Both through the ordinary
      field-edit path.
      Done: one line in `fieldsOf` and one in `revertTo`, which is the whole of
      it — no verb, no event, no branch. Two cases against real SQLite: a set
      then a clear, undone twice, and a deleted branch's deadline restored by
      `restore_subtree`. The second is 1.3's obligation and is why
      `WORK_ITEM_COLUMNS` had to name the column in the same slice that made it
      writable — `remove` journals whole rows off that projection.
- [x] 6.4 A deadline edit invalidates the optimized cache for that project
      exactly as a priority or floor edit does, through the existing debounce and
      generation fence, with no new machinery.
      **Closed by 3.4/4.2 with no machinery added, which is what this item
      asks.** The cache key is the whole `ScheduleInput` the plan read hands
      `schedule()` (`publishedOptimized`), so an edit invalidates the cache
      exactly when it moves that input — and as of the plan read a deadline is
      in it. The cache-key case in `deadline-plan-read.test.ts` — the one named
      for putting the resolved offsets in the input the cache is keyed on —
      reads the ask itself: `[]` before
      the edit and `[[id, 2]]` after, off the same `OptimizedScheduleAsk` the
      hash is computed from. Asserted on the ask rather than on a stored row on
      purpose — whether the cache then misses is 4.1–4.8's, proved against real
      SQLite in `optimized-schedule-cache.db.test.ts`, and re-proving it here
      would prove nothing about this edit.
      The key holds the resolved **offset** and not the calendar date, so the
      hash does not depend on the project's start twice
      (`canonical-schedule-input.ts` (d) and (g)).

## 7. Canonical input, contract-version bump, retention scoping

- [ ] 7.1 `deadlines` becomes the **seventh** canonical-input entry: `[workItemId,
deadlineOffset]` sorted by id, offsets resolved by `deadlineOffsetOf`
      against `project.startDate`, keys **as-authored and not pre-expanded to
      leaves**. The parent-with-no-bound-leaf case is the test that pins the
      as-authored choice: its hash must change even though the fold emits no
      constraint.
- [ ] 7.2 Four stale statements amended in the same commit. **Grep for the
      literal `schedule(rows, edges, slices, notBefore, poolSizes, reach)`, not
      for "six"** — verified 2026-09-03, only one of the four uses the count
      word and the other three state the tuple literally, so a count-word grep
      passes green while three normative artifacts still say the hash covers six
      arguments:
      (a) `openspec/changes/dual-optimized-scheduler/specs/scheduler-optimization/spec.md`,
      the "exact argument tuple of the Fast pass" requirement — normative, and
      the one an implementer would resolve a disagreement against;
      (b) `openspec/changes/dual-optimized-scheduler/design.md`, the **Canonical
      input** bullet;
      (c) `openspec/changes/dual-optimized-scheduler/tasks.md` slice 1.1, the
      tuple the implementer builds from;
      (d) `notes/wbs-dual-optimized-scheduler-design.md` §2.2, both the "all six
      arguments" sentence and its numbered list — **a workspace file, not a wbs
      one**, so a grep inside the wbs checkout will not see it.
      A stale tuple is a false statement about the hash, not a typo.
- [ ] 7.2b **Do not amend the review ledger.** The round-1 row of
      `notes/wbs-dual-optimized-scheduler-design.md`'s ledger reads "Canonical
      input rebuilt from `schedule()`'s actual six arguments" and is a record of
      what round 1 found and fixed. Rewriting it to seven makes it a false
      record. Amend normative text; never history. This is the one occurrence
      7.2's grep will surface that must be left alone.
- [ ] 7.3 `SCHEDULER_CONTRACT_VERSION` bumped, which re-keys the Fast golden
      corpus in the same commit and evicts every pre-existing cache row. There is
      **no** data migration of cached results.
      **Still 7, deliberately, and the corpus was regenerated under it by 5.2.**
      Recorded here because the next reader will find moved corpus bytes and no
      bump and must not read that as the omission this slice exists to catch.
      `fast-golden-corpus.test.ts` asserts in two directions — the stored bytes
      reproduce, and the stored `contractVersion` equals the constant — and
      regenerating at 7 satisfies both, so the guard is not being worked around.
      What makes 7 still true is measurable rather than argued, and the
      measurement has now moved twice. It first read "no work item can carry a
      deadline yet", true until slice 1 landed the column at `b2bb095c`. It then
      read "nothing reads or writes it", true until slice 6 landed the write path
      — `WORK_ITEM_COLUMNS` names `deadline` as of that slice and a work item can
      carry one. It then read "the plan read still passes `NO_DEADLINES`", true
      until 3.4/4.2 threaded the stored dates through.
      **That third reason has now expired, and this item was re-examined rather
      than inherited — the answer is still 7, and the reason is now the input
      hash.** `deadlines` is the seventh canonical-input entry, so a plan that
      states one hashes differently from the same plan that states none: a
      cached row written before this slice was necessarily computed under `[]`,
      and the only inputs that still key to it are the ones that canonicalize to
      `[]` today. For those, 4.3's byte-identical no-op proof says Fast's answer
      did not move, so the row is still the right answer. A plan carrying a
      deadline misses instead and is recomputed, which is 6.4. A version bump
      keys a cache; the thing that changed here is already in the key, so
      bumping would evict every correct row to no end.
      **The solver side, corrected here rather than left standing.** An earlier
      revision of this paragraph said the solver does not read `deadlines` at
      this head and that the hard finish constraint was TASK-241's. Both are
      false and the round-1 Sol seat read the source: `build-solver-request.ts`
      folds `plan.deadlines` through `leafDeadlinesOf` into `deadlineUnits` per
      slice, and `wbs_solver/model.py` clause 6 enforces
      `end <= deadlineUnits`. TASK-219 built that path against a legitimately
      empty deadline source, which is exactly this task's own boundary note. It
      does not change the answer above: an optimized row is keyed by the same
      `inputHash`, so a row computed under `[]` is not served to a plan that now
      states a date — it misses and is recomputed, this time through a solver
      that has always been able to read the dates and until now never got any.
      The bump's blast radius is also this
      slice's own: seven `libs/contracts/solver` request fixtures pinned by
      `wire-contract-version.test.ts`, `revalidate-solver-result.test.ts` and
      `libs/solver-py`, all of them slice 7/8 artifacts TASK-219 owns. Splitting
      that across two tasks is how a half-bump lands.
      **What did move is `SCHEDULE_ALGORITHM_ID` (5.2), and the two are not
      substitutes**: that constant answers "did the engine that computed this
      stored plan behave like the one running now", which this change does
      alter; this one keys a cache of results that cannot exist yet.
- [ ] 7.4 `deadline` is **not** a new cache-key dimension. Assert the key columns
      are still `(projectId, inputHash, objective, contractVersion, budgetMs)`.
- [ ] 7.5 A **regression test**, not a rule change: run two contract versions
      against one SQLite file and assert both row sets survive a store on each
      side. **Do not add a retention requirement.** An earlier draft called this
      an existing latent defect; it is not — the rule already reads "allocating
      a new generation SHALL delete every cache row of that project **for that
      contract version**" and retains per `(projectId, objective,
contractVersion, inputHash)`. That draft had quoted the requirement's
      unscoped _title_ and ignored its scoped body. Adding a second requirement
      for behaviour a first one already owns is the divergence pattern these
      artifacts keep paying for; the test is worth having, the rule is not.
- [ ] 7.6 **WATCHED RED W6** — omit the seventh argument from the hash. Two plans
      differing only in a deadline must collide on one cache row and the second
      must read the first's schedule.

## 8. Wire, `plan-infeasible`, revalidator, TASK-221 copy

- [ ] 8.1 `deadlineUnits: integer | null` per slice in
      `libs/contracts/solver/solver-wire.v1.json` — the **effective** deadline,
      already folded and already converted to `(D + 1) × quantum`, so Python
      never sees the tree. `null` is unconstrained. The schema is the single
      normative definition; prose does not restate its field list.
- [ ] 8.2 **Every `<!-- wire-fields:slice -->` and `<!-- wire-fields:response -->`
      marker amended in the same commit as the schema.** The repository
      enumeration check compares the tagged lists against the schema's own
      `required` sets and fails on the symmetric difference — a partial edit is a
      red gate by design, so land them together or watch the gate go red.
- [ ] 8.3 The CP-SAT constraint `startUnits(s) + max(durationUnits(s), 1) <=
(D + 1) × quantum`, added **before** the objective terms and independent of
      them — not a penalty, not a soft term, not a lexicographic stage.
- [ ] 8.4 **WATCHED RED W2** — substitute `finishUnits <= (D + 1) × quantum`. A
      zero-duration milestone one day late must be admitted as feasible. Every
      non-zero-duration fixture stays green under the substitution, so the test
      must be the milestone.
- [ ] 8.5 Response `status: infeasible` joins the stage-status matrix as a
      first-class outcome, distinct from `unknown`. `horizonUnits` is
      **unchanged** and is not tightened to the latest deadline.
- [ ] 8.5b **`plan-infeasible` is FIRST-stage `INFEASIBLE` only, and the
      standing "at any stage" rule must be amended in the same commit.** The
      dual-scheduler spec says `INFEASIBLE` SHALL be `invalid-output` **at any
      stage**, because Fast placed the same graph and every later stage's added
      constraint is satisfied by the previous incumbent. Deadlines enter at
      stage 1 (8.3), so a first-stage `INFEASIBLE` is now a real statement about
      the user's deadlines — the one case that rule over-covers. A later-stage
      `INFEASIBLE` is still impossible on a correct engine and stays
      `invalid-output`; it also carries no offending-item certificate, so it
      could not populate 8.7's payload. Amend that clause **and** the
      stage-status matrix alongside 8.1, with the same land-together rigour as
      8.2. Merging the new rule against the unamended old one leaves two
      requirements mandating opposite outcomes for one solver status, and if the
      new one wins, a later-stage engine failure is cached as "your deadlines
      cannot be met" with no Retry — at the moment the solver's own earlier
      stage proved a deadline-satisfying schedule exists. Test both stages.
- [ ] 8.5c The cache schema's declared integrity admits a third status:
      `CHECK (status IN ('ok','failed'))` appears in `dual-optimized-scheduler`
      `design.md` and `tasks.md`, together with the CHECKs tying `ok` to a
      non-NULL `resultJson` and the inverse for `failed`. `plan-infeasible`
      carries a payload, so both the status CHECK and the payload CHECKs change,
      in both files, in the same commit.
- [ ] 8.6 **WATCHED RED W5** — map `infeasible` onto `unknown`. An infeasible
      plan must offer Retry.
- [ ] 8.7 `plan-infeasible` stored beside `ok` and `failed`: cached under an
      identical key, never auto-respawned, payload naming every offending work
      item with its **effective** deadline plus both the item that **owns** the
      binding date and the item the constraint **fell on**. The
      ancestor-bound-leaf case is the test — a payload showing the leaf's own
      later date sends the user to edit a field that changes nothing.
- [ ] 8.7b **`plan-infeasible` is a seventh `VariantState`, and the union is
      enumerated in FIVE places.** Amend all five in the same commit:
      (1) `dual-optimized-scheduler/design.md`'s plan-read DTO bullet — the list
      that artifact calls "the one authority";
      (2) `.../specs/scheduler-optimization/spec.md`'s plan-read requirement,
      the normative "SHALL be one of";
      (3) `.../tasks.md` 7.10 — both the words "one of six" **and** its
      proof-state list;
      (4) `.../tasks.md` 8.3–8.4, the UI rendered-states list;
      (5) `notes/wbs-dual-optimized-scheduler-design.md` **§3.2's
      event/state table** — the section that declares itself authoritative — which
      enumerates outcomes by row and needs `plan-infeasible` rows. It is a
      workspace file, not in the wbs checkout. **Do not amend that note's review
      ledger rows**, which are protected history under 7.2b.
      **This has already gone wrong twice.** Adding `corrupt` updated (2) and
      left (1), (3) and (4) at five members, which shipped as a Critical, and
      the two rounds before it found the same divergence in other fields.
      **Search for the member names, not for "six":** the count word appears in
      (1) ("a tagged union of **six** members") and (3) only, so it finds two
      sites of five and misses three — including site 5, the note's
      authoritative table, whose omission is the exact failure this item exists
      to prevent.
- [ ] 8.7c The stored row status and the DTO union are **different layers** and
      both get a value. `plan-infeasible` is a row status beside `ok` and
      `failed`, and is **not** an `ok` row carrying an infeasible payload:
      `corrupt` is defined as an `ok` row whose `resultJson` fails to decode, so
      an `ok` row that is deliberately not a schedule is indistinguishable from
      a decoder fault at the one point they must be told apart. Test both
      resolutions side by side.
- [ ] 8.7d Retry refuses it. The endpoint accepts `failed` or `corrupt` and
      returns `409 not-retryable` naming the state for everything else;
      `plan-infeasible` takes that path. The UI hiding the affordance is not
      sufficient — the route is reachable without the UI, which is exactly the
      hole the `corrupt`-promised-a-Retry Critical named.
- [ ] 8.8 Revalidator clause `lastWorkdayOf(start, finish) <=
effectiveDeadlineOffset`, evaluated on the materialised schedule in the
      **real fractional domain**, not in quantised units. A violation is
      `invalid-output` — a deadline-violating solver result is a broken engine,
      never an infeasible plan. `materialiseOptimized` is unchanged and
      `ScheduleFloor` gains **no** `boundBy: 'deadline'` member.
- [ ] 8.9 TASK-221 copy: `Same deadline + reordered` → `Same project deadline +
reordered` and `Same deadline + same order` → `Same project deadline + same
order`, with their tests. A repository assertion that no unqualified
      "deadline" string remains in shipped UI copy.
- [ ] 8.9b **The normative text mandating the old strings is amended in the same
      commit**: `dual-optimized-scheduler/specs/scheduler-optimization/spec.md`,
      the comparison-indicator requirement ("SHALL report one of: … Same
      deadline + reordered, or Same deadline + same order"), and
      `dual-optimized-scheduler/design.md`'s restatement of the four strings.
      8.9's repository assertion covers **shipped UI copy**, not spec text, and
      7.2's sweep greps for the argument tuple — neither reaches these two
      lines, so without this item the merge leaves two SHALLs mandating
      different literal strings for one indicator.

## 9. UI

- [ ] 9.1 The **Work item deadline** cell on any row, leaf or parent, nullable
      and date-only, using the existing date-cell affordances.
- [ ] 9.2 The `Late by N workdays` label per missed slice, reading the number
      computed in 5.2 rather than recomputing it in the view.
- [ ] 9.3 `Plan infeasible · N work item deadlines` with the offending items
      listed on demand, Fast still on screen and usable, **no toast and no
      modal**, and **no Retry affordance**.
- [ ] 9.4 A work item whose deadline resolves `before-project-start` at read time
      shows its Work item deadline with the existing "impossible" affordance and
      is not silently dropped.

## 10. Gate

- [ ] 10.1 All six watched reds (W1–W6) recorded failing before their
      implementation lands, per AGENTS.md R5, each with the exact fault injected
      and the exact assertion that caught it.
- [ ] 10.2 Full remote autotest + lint + typecheck gate on h2puni at the exact
      head, for `libs/domain`, `apps/be-01` and `apps/fe-01`. Nothing is built or
      run on the workspace box.
- [ ] 10.3 `openspec validate --all --json` green at the exact head, parsed from
      JSON rather than from a summary line.
- [ ] 10.4 Cross-provider review of the shipped diff on the exact head, plus the
      Gemini seat, per AGENTS.md. Slice 1's prod-mode PR gets its own review
      before merge.
