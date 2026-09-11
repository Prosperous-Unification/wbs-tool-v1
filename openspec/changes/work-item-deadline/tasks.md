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
UI. Slice 10 is the gate. **A slice is not done until its remote gate is green —
no build or autotest runs on the workspace box.** That gate was h2puni for every
slice up to 8.9b and has been **CI** since, because h2puni has had zero free
inodes throughout and cannot create a file, let alone run
`bin/h2puni-gate.sh`. **CI is not an equal substitute and 10.2 names what is
lost** — exactly one behavioural check, the `WBS_RUN_SOLVER_ORPHAN_PROC=1`
process-boundary proof, which is host-only and has not run since. The h2puni
requirement is not waived, it is **owed**, and it is owed to **`TASK-319`**,
which exists for no other purpose: run `bin/h2puni-gate.sh` against this
change's merged head and prove the orphan-process boundary actually executed.
`TASK-319` is blocked on `TASK-315`, but `TASK-315` is **not** the debt's
holder — its acceptance criterion is to free inodes and prove _one_ project
target runs, which restores the capability to gate without gating anything.
Peer review r8c was right to call that parking a still-binding requirement on a
task that cannot discharge it, and this is the correction.

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

| Slices            | Owner                                          | Why                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–6, 9, 10.2–10.3 | **this change's own queue tasks**              | column, converter, fold, `schedule()`'s seventh argument, Fast ordering, API, UI — all against code that exists                                                                                               |
| 7, 8              | **TASK-219 absorbs them**                      | they assert cache-key columns (7.4), hash behaviour (7.1, 7.6) and a wire schema (8.1) belonging to artifacts TASK-219 has not created yet                                                                    |
| 10.1, 10.4        | **both owners, each at its own terminal gate** | AGENTS.md's cross-provider review binds whoever ships a diff; it is not one task's checkbox — and 10.1's six reds are watched three here and three inside TASK-219, so it closes only when both have appended |

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

- [x] 3.4 The two impossible kinds are distinguished at their own boundaries:
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
      **The third boundary landed here and the box closes.** The sentence above
      was written from TASK-219, for which slice 8 was someone else's; it is
      TASK-241's, and 8.5b/8.7 are it. Each boundary now has a named referent
      and they are three different verdicts on the same resolution:
      `apps/be-01/src/controller/work-item.controller.test.ts:797` is write time
      — `deadline_before_project_start`, refused, naming the work item and the
      project's day zero;
      `apps/be-01/src/service/deadline-plan-read.test.ts:260` ("reports a
      project start moved past a stored deadline late by the whole span") is
      read time — **not** refused, not rewritten, reported late; and
      `apps/be-01/src/service/optimization-events.db.test.ts:236` is slice 8 —
      a real `status: 'infeasible'` response over a deadlined input stores
      `plan-infeasible` on both variants, emits
      `schedule_optimization_infeasible` for each, and (8.6) is refused a
      Retry. **Where that third referent stops:** its wire response is a
      fixture, so it proves the pipeline's disposition of an infeasible answer
      and not that CP-SAT finds this particular input infeasible — that is
      8.3's hard constraint and W2, which are their own items and are closed.
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
- [x] 4.2 The predicate, applied per slice against its effective deadline offset,
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

- [x] 7.1 `deadlines` becomes the **seventh** canonical-input entry: `[workItemId,
deadlineOffset]` sorted by id, offsets resolved by `deadlineOffsetOf`
      against `project.startDate`, keys **as-authored and not pre-expanded to
      leaves**. The parent-with-no-bound-leaf case is the test that pins the
      as-authored choice: its hash must change even though the fold emits no
      constraint.
- [x] 7.2 Four stale statements amended in the same commit. **Grep for the
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
- [x] 7.2b **Do not amend the review ledger.** The round-1 row of
      `notes/wbs-dual-optimized-scheduler-design.md`'s ledger reads "Canonical
      input rebuilt from `schedule()`'s actual six arguments" and is a record of
      what round 1 found and fixed. Rewriting it to seven makes it a false
      record. Amend normative text; never history. This is the one occurrence
      7.2's grep will surface that must be left alone.
- [x] 7.3 `SCHEDULER_CONTRACT_VERSION` bumped, which re-keys the Fast golden
      corpus in the same commit and evicts every pre-existing cache row. There is
      **no** data migration of cached results.
      The earlier decision to remain at 7 was sound only while no coordinator
      could write a cache row. That premise expired when `39fa03f9` landed the
      coordinator on `main`; an enabled project can persist an outcome under
      `7+0.1.0`, including `failed/internal-error` when the host supervisor is
      absent. `guardRealPublication` then changed its Fast baseline for the same
      deadline-bearing input hash, so the domain half is now 8. The CP-SAT
      milestone deadline predicate also changed for the same request, so the
      Python package half is now 0.1.1. The live composite is `8+0.1.1`; old rows
      remain in SQLite under a disjoint key and read as misses. The Fast corpus
      was regenerated at 8 with every schedule byte unchanged, and the shared
      request corpus was re-keyed to both new halves. The deadline map remains
      part of `inputHash`; the bump covers later same-hash behavior changes, not
      the addition of that input dimension.
- [x] 7.4 `deadline` is **not** a new cache-key dimension. Assert the key columns
      are still `(projectId, inputHash, objective, contractVersion, budgetMs)`.
- [x] 7.5 A **regression test**, not a rule change: run two contract versions
      against one SQLite file and assert both row sets survive a store on each
      side. **Do not add a retention requirement.** An earlier draft called this
      an existing latent defect; it is not — the rule already reads "allocating
      a new generation SHALL delete every cache row of that project **for that
      contract version**" and retains per `(projectId, objective,
contractVersion, inputHash)`. That draft had quoted the requirement's
      unscoped _title_ and ignored its scoped body. Adding a second requirement
      for behaviour a first one already owns is the divergence pattern these
      artifacts keep paying for; the test is worth having, the rule is not.
- [x] 7.6 **WATCHED RED W6** — omit the seventh argument from the hash. Two plans
      differing only in a deadline must collide on one cache row and the second
      must read the first's schedule. Measured at `0e716cba`; see **W6, measured**
      below.

## 8. Wire, `plan-infeasible`, revalidator, TASK-221 copy

- [x] 8.1 `deadlineUnits: integer | null` per slice in
      `libs/contracts/solver/solver-wire.v1.json` — the **effective** deadline,
      already folded and already converted to `(D + 1) × quantum`, so Python
      never sees the tree. `null` is unconstrained. The schema is the single
      normative definition; prose does not restate its field list.
- [x] 8.2 **Every `<!-- wire-fields:slice -->` and `<!-- wire-fields:response -->`
      marker amended in the same commit as the schema.** The repository
      enumeration check compares the tagged lists against the schema's own
      `required` sets and fails on the symmetric difference — a partial edit is a
      red gate by design, so land them together or watch the gate go red.
- [x] 8.3 The CP-SAT constraint `startUnits(s) + max(durationUnits(s), 1) <=
(D + 1) × quantum`, added **before** the objective terms and independent of
      them — not a penalty, not a soft term, not a lexicographic stage.
- [x] 8.4 **WATCHED RED W2** — substitute `finishUnits <= (D + 1) × quantum`. A
      zero-duration milestone one day late must be admitted as feasible. Every
      non-zero-duration fixture stays green under the substitution, so the test
      must be the milestone.
- [x] 8.5 Response `status: infeasible` joins the stage-status matrix as a
      first-class outcome, distinct from `unknown`. `horizonUnits` is
      **unchanged** and is not tightened to the latest deadline.
- [x] 8.5b **`plan-infeasible` is FIRST-stage `INFEASIBLE` only, and the
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
- [x] 8.5c The cache schema's declared integrity admits a third status:
      `CHECK (status IN ('ok','failed'))` appears in `dual-optimized-scheduler`
      `design.md` and `tasks.md`, together with the CHECKs tying `ok` to a
      non-NULL `resultJson` and the inverse for `failed`. `plan-infeasible`
      carries a payload, so both the status CHECK and the payload CHECKs change,
      in both files, in the same commit.
- [x] 8.6 **WATCHED RED W5** — map `infeasible` onto `unknown`. An infeasible
      plan must offer Retry.
      **Measured on CI, because h2puni has no inodes** — see "## W5, measured"
      below. The early measurement was withdrawn on purpose: it reddened the
      classification seam alone, which is not this red's sentence. It now
      reddens the plan's disposition too, and the assertion that says an
      infeasible plan is refused a Retry rides on the rows a real infeasible
      solve produced rather than on a row a fixture inserted.
- [x] 8.7 `plan-infeasible` stored beside `ok` and `failed`: cached under an
      identical key, never auto-respawned, payload naming every offending work
      item with its **effective** deadline plus both the item that **owns** the
      binding date and the item the constraint **fell on**. The
      ancestor-bound-leaf case is the test — a payload showing the leaf's own
      later date sends the user to edit a field that changes nothing.
- [x] 8.7b **`plan-infeasible` is a seventh `VariantState`, and the union is
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
- [x] 8.7c The stored row status and the DTO union are **different layers** and
      both get a value. `plan-infeasible` is a row status beside `ok` and
      `failed`, and is **not** an `ok` row carrying an infeasible payload:
      `corrupt` is defined as an `ok` row whose `resultJson` fails to decode, so
      an `ok` row that is deliberately not a schedule is indistinguishable from
      a decoder fault at the one point they must be told apart. Test both
      resolutions side by side.
- [x] 8.7d Retry refuses it. The endpoint accepts `failed` or `corrupt` and
      returns `409 not-retryable` naming the state for everything else;
      `plan-infeasible` takes that path. The UI hiding the affordance is not
      sufficient — the route is reachable without the UI, which is exactly the
      hole the `corrupt`-promised-a-Retry Critical named.
      **Closed across the two seams it actually has** — see
      "## 8.7d and 9.3, closed" below. The refusal itself shipped with 8.7; what
      was owed was the proof that it survives the wire, and that lives at the
      route, not in the coordinator.
- [x] 8.8 Revalidator clause `lastWorkdayOf(start, finish) <=
effectiveDeadlineOffset`, evaluated on the materialised schedule in the
      **real fractional domain**, not in quantised units. A violation is
      `invalid-output` — a deadline-violating solver result is a broken engine,
      never an infeasible plan. `materialiseOptimized` is unchanged and
      `ScheduleFloor` gains **no** `boundBy: 'deadline'` member.
- [x] 8.9 TASK-221 copy: `Same deadline + reordered` → `Same project deadline +
reordered` and `Same deadline + same order` → `Same project deadline + same
order`, with their tests. A repository assertion that no unqualified
      "deadline" string remains in shipped UI copy outside the exact
      **Deadline** table heading and matching Columns-control label.
      **Closed both halves.** The rename shipped in PR 246 (`9a1f79e7`) and
      8.9b brought the normative text to it; the assertion is
      `apps/fe-01/src/deadline-copy.test.ts`, and closing it needed the five
      remaining unqualified occurrences in `wbs-table.tsx` qualified first —
      see "## 8.9, closed" below.
- [x] 8.9b **The normative text mandating the old strings is amended in the same
      commit**: `dual-optimized-scheduler/specs/scheduler-optimization/spec.md`,
      the comparison-indicator requirement ("SHALL report one of: … Same
      deadline + reordered, or Same deadline + same order"), and
      `dual-optimized-scheduler/design.md`'s restatement of the four strings.
      8.9's repository assertion covers **shipped UI copy**, not spec text, and
      7.2's sweep greps for the argument tuple — neither reaches these two
      lines, so without this item the merge leaves two SHALLs mandating
      different literal strings for one indicator.
      **Done, and the divergence it predicted was already live on `main`.**

## 9. UI

- [x] 9.1 The **Work item deadline** cell on any row, leaf or parent, nullable
      and date-only, using the existing date-cell affordances.
- [x] 9.2 The `Late by N workdays` label per missed slice, reading the number
      computed in 5.2 rather than recomputing it in the view.
- [x] 9.3 `Plan infeasible · N work item deadlines` with the offending items
      listed on demand, Fast still on screen and usable, **no toast and no
      modal**, and **no Retry affordance**.
      **The banner and the disclosure shipped with 8.7b; the two clauses about
      what is _absent_ did not**, and they are the ones this item is for — see
      "## 8.7d and 9.3, closed" below. The rendered string is
      `Work item deadline`, singular-aware, not the item's lower-case
      shorthand: 8.9's scan requires the qualifier and
      `optimization-indicator.test.tsx` pins the exact sentence.
- [x] 9.4 A work item whose deadline resolves `before-project-start` at read time
      shows its Work item deadline with the existing "impossible" affordance and
      is not silently dropped.
      **The affordance this names did not exist, so 9.4 built one.**
      `rg -n impossible apps/fe-01/src` returns 17 hits and every one is a code
      comment about a union or a memo; there was nothing to borrow. The mark is
      `role="img"` with a row-naming accessible name, carries **no**
      `data-cell` (`editableGrid` collects `[data-cell]` descendants, so a mark
      that joined the keyboard grid would put a stop between Due and Start that
      nobody can type into), sits out of flow with `pointerEvents: none` inside
      the width `DEADLINE_MARK_PX` reserves, and is drawn in
      `var(--destructive)`, which `styles.css` defines in both themes. The
      stored date is still printed beside it, which is §2.3's "not silently
      dropped".
      **The predicate is `deadlineOffsetOf` — be-01's own** — and that is not a
      breach of 9.2's rule. `lateBy` is _how late_ and stays be-01's alone;
      _whether a stored date falls before day zero_ is a different question, and
      the cell answers it with the same function `work-item.service.ts` calls
      for its `deadline_before_project_start` refusal. One implementation
      shared, not two opinions computed.
      **The wording names the project's first WORKING day, not its start**, and
      the difference is visible on screen: a project starting Saturday
      2026-08-08 with a deadline of that same Saturday is impossible while the
      two dates a reader sees are equal, and one starting Saturday the 8th with
      a deadline of Sunday the 9th is impossible with the start _earlier_ than
      the deadline. Round 1's OpenAI seat caught the original sentence
      contradicting the cell; a case now asserts the equal-dates reading.

## 10. Gate

- [x] 10.1 All six watched reds (W1–W6) recorded failing before their
      implementation lands, per AGENTS.md R5, each with the exact fault injected
      and the exact assertion that caught it.
      **The ledger is complete. `verify.md` § "10.1 — the watched-red ledger"
      now carries all six**, each with its fault and its exact failing
      assertion. **Five of the six also carry pass/fail counts; W5 does not,
      and that is stated in its own section rather than papered over** — its
      red is a CI run, and what CI reports for a failed gate is the failed
      task names and the failing assertions, not a suite total. Plus the eight
      slice-level reds that are not
      among the six in their own table below it. W1, W3 and W4 were recorded
      first, from this change's slices 2–4; **W2 (8.4), W5 (8.6) and W6 (7.6)
      are slices 7–8 and belong to `dual-optimized-scheduler` (TASK-219/241)**,
      and appended as they landed — W2 on h2puni at `eff07d9f`, W6 on h2puni at
      `0e716cba`, and **W5 on CI**, because by the time 8.6 had a route to be
      refused at, h2puni had zero free inodes. It stayed unticked while the
      ledger was a half ledger, which was the right call and not caution: a
      ledger missing three of six is not the item.
      **The ledger's intro now says per red whether a restoring md5 was taken,
      because for three of the six one was not** — W1/W3/W4 quote a hash
      compared on both hosts, W6 records only a clean tree, and W2 and W5 have
      none, so for those two what is checkable is that the fault is absent at the
      shipped head. A single "every fault was reverted and hashed" sentence
      covering all six would have been false.
- [x] 10.2 Full remote autotest + lint + typecheck gate **at the exact head**,
      for `libs/domain`, `apps/be-01` and `apps/fe-01`. Nothing is built or run
      on the workspace box.
      **Read h2puni, ran on CI, and the substitution is deliberate, measured,
      and WEAKER — the word "downgrade" is the right one and an earlier draft
      of this note denied it.** As written the item named h2puni, and
      h2puni cannot run a gate: it has been at `IFree 0` (`df -i /`:
      `9849520 / 9849520`, re-measured live at 2026-09-07T05:16Z, filed as
      `TASK-315`, whose reclaim still needs a human decision) since before 8.9b,
      which is why every item from 8.9b onward gated on CI instead. **Creating a
      file there fails**, so this is not slowness to wait out.
      **CI covers the four targets this item names, and it is NOT a strict
      superset of the h2puni gate — an earlier draft of this note said it was
      and that was wrong.** The `gate` job's step is
      `bunx nx run-many -t test lint typecheck build` with **no project
      filter** (`.github/workflows/ci.yml`) — the same four targets, across
      every project rather than three. That much is checkable and was checked
      rather than assumed: at the shipped head 24 `project.json` files carry a
      `test` target, and nx reported success for **24 projects** across those
      same four targets, so nothing was filtered out.
      **`libs/solver-py` is one of those 24**, and its target is
      `python3 -m unittest discover -s tests -t tests`, so the Python half of
      slice 8 is gated at this head too and not only at W2's `eff07d9f`.
      **What CI does NOT run, named rather than implied, because peer review
      r8 found the first version of this paragraph had it backwards.**
      `bin/h2puni-gate.sh` invokes the image smoke as
      `WBS_RUN_SOLVER_ORPHAN_PROC=1 bunx nx run be-01:solver-image-smoke`;
      `.github/workflows/ci.yml` invokes the same target **without** that
      variable. The orphan-process proof in
      `optimization-orphan.proc.db.test.ts` is `describe.skip` unless an image
      is supplied, so **CI does not exercise the supervisor-restart /
      orphan-process boundary at all** — it is a host-only check, and it is
      lost for as long as h2puni cannot run. **That is the only behavioural
      check CI loses.**
      **The chain, spelled out, because "outside those four targets" is easy to
      misread as "outside `apps/be-01`" and that would be false.** The file
      lives at `apps/be-01/src/service/optimization-orphan.proc.db.test.ts`, so
      `be-01:test` — `bun test --coverage` over `apps/be-01` — **collects it on
      both paths**, and on both paths its cases report **skipped**, because the
      gate it reads is `WBS_SOLVER_ORPHAN_IMAGE` and nothing in the four targets
      sets that. What sets it is a conditional block inside
      `apps/be-01/scripts/solver-image-smoke.sh`, reached only when
      `WBS_RUN_SOLVER_ORPHAN_PROC=1`: it builds and pushes an orphan fixture
      image, resolves its digest, and runs the file directly as
      `WBS_SOLVER_ORPHAN_IMAGE=<digest> bun test <that file>`. So the executing
      invocation lives in the `be-01:solver-image-smoke` target, which is **not
      one of the four** and which `nx run-many -t test lint typecheck build`
      never runs; h2puni's gate calls it as an explicit fifth step and CI calls
      it without the flag. The precise loss is therefore that fifth step's
      conditional block — not a case that `be-01:test` would otherwise have run. The same script also runs `nx format:check --all` and
      passes `--skip-nx-cache`; the first is **not** lost — CI runs the
      identical format command as its own `Format` step rather than inside the
      script, so saying "CI's gate step does not do it" would mislead — and the
      second changes only whether a cached result may be reused, not what is
      checked.
      **The earlier "one real difference" was also simply false:** the Python
      unittest target runs host `python3` on **both** paths
      (`libs/solver-py/project.json`) and never inside the solver image; the
      image is exercised only by the separate smoke target. That correction is
      recorded rather than quietly deleted, because the wrong version of it was
      the argument for calling the substitution safe.
      **So the honest claim is narrower than the one this item started with:**
      the four targets this item names are green at the exact head on CI, and
      one host-only proof outside those four targets is not being run at all
      until h2puni can run again.
      **That outstanding proof has an owner, and naming the wrong one is what
      peer review r8c called a Critical.** An earlier draft said the debt was
      owed to `TASK-315`. It is not: `TASK-315` frees inodes and proves _one_
      project target runs, which restores the ability to gate without gating
      this change. The debt is owed to **`TASK-319`** — filed for this and
      nothing else, blocked on `TASK-315`, and required to run
      `bin/h2puni-gate.sh` against this change's merged head and to prove the
      orphan-process boundary **executed** rather than skipped, with a negative
      control. This item stays ticked on what its own sentence asks for — the
      three named projects' `test`, `lint` and `typecheck` targets green at the
      exact head — and the missing check, which no one of those targets runs on
      either path, is tracked rather than absorbed.
      **"The exact head" is stated here as a RULE, not as a SHA, and that is
      the fix for a trap this change has already sprung once.** `verify.md`
      records slice 1's version of it: a gate table that named a SHA went stale
      the moment a review fold changed three files under it, twice, and the
      section was rewritten to state the rule instead. The same applies here and
      more sharply, because **this item cannot name its own shipping head** —
      the run id does not exist when the commit that would cite it is written.
      **The rule: this change merges a head only when that head's own CI `gate`
      and `pixels` jobs are green, with the head sha verified equal to the
      green run's immediately before the merge and `origin/main` re-read after.**
      Every one of this change's merges has followed it and each run id is in
      the merge log; the most recent completed one is **34083621444** at
      `82a23a6b`. **A head that only reddened may not be cited by anything
      here**, and `a8462cad` — this branch's first head — is exactly that: it
      failed `Format`, so the gate step never ran on it at all.
- [x] 10.3 `openspec validate --all --json` green at the exact head, parsed from
      JSON rather than from a summary line.
      **This item was unticked through r8 and r8b on purpose, and it is ticked
      here by a `ci.yml` edit rather than by prose.** Peer review r8 was right
      that the earlier tick was a Critical: `--json` made the validator _emit_
      JSON, nothing read it, and what gated was the process exit status — which
      is the inference the item's "rather than from a summary line" clause
      exists to rule out.
      **The `OpenSpec` step now reads a named field.** It keeps the document
      (`tee "$RUNNER_TEMP/openspec-validate.json"`) and asserts
      `jq -e '.summary.totals.failed == 0 and .summary.totals.passed > 0'` under
      `set -euo pipefail`.
      **The field path is measured, not guessed, and the obvious guess is
      wrong.** The note this item carried through r8b proposed
      `jq -e '.failed == 0 and .passed > 0'`. Against the real document — read
      out of the `OpenSpec` step log of green CI **34083621444** at `82a23a6b`,
      whose `summary.totals` is `items 39 / passed 39 / failed 0` — that
      expression evaluates `null == 0` and **exits 1 on a green run**. The
      counts live at `.summary.totals.*`.
      **`passed > 0` is load-bearing.** `failed == 0` alone is also true of a
      run that validated nothing, which is what an empty checkout or an `--all`
      that stopped matching looks like from inside the step.
      **`pipefail` is load-bearing.** Without it a validator that crashes after
      writing a well-formed green document goes green, because `tee` succeeds
      and `jq` reads the good bytes.
      **Rehearsed off-CI, because a workflow every lane depends on gets one
      attempt per push.** The step body was extracted from `ci.yml` by parsing
      the YAML — not retyped — `shellcheck`ed clean, and run five times with
      `bunx` stubbed and the real captured document as input:
      | stub behaviour | required | measured |
      | --- | --- | --- |
      | real green document, exit 0 | pass | exit 0 |
      | `failed` forced to 1, exit 0 | red | exit 1 |
      | `passed` forced to 0, exit 0 | red | exit 1 |
      | real green document, **exit 1** | red | exit 1 |
      | non-JSON on stdout | red | exit 5 |
      The fourth row is the `pipefail` control and the last covers `bunx`
      progress output landing on stdout instead of stderr: it reds rather than
      passing on unparseable bytes. With `pipefail` removed, the fourth row goes
      **green**, which is what makes it a control rather than a decoration.
      The validator half keeps its own control, still written above the step in
      `ci.yml`: with a change's scenarios written `###` instead of `####` it
      exits 1 with `failed: 1`, and restored it exits 0 with `passed: 2`.
      **Measured on CI, not only in rehearsal.** The step's first execution was
      CI **34086090111** at `39718070` — `gate` and `pixels` both green, the
      `OpenSpec` step `success`, and its log shows the assertion running against
      a `summary.totals` of `items 39 / passed 39 / failed 0` with nothing but
      the JSON document reaching the `tee`, which also settles the one thing
      rehearsal could not: `bunx`'s own progress output goes to stderr and does
      not pollute the parsed stream. That head predates this branch's rebase
      onto `fc893d42`, so it proves the step and not this item's shipping head;
      the shipping head is gated under the rule 10.2 states.
- [x] 10.4 Cross-provider review of the shipped diff on the exact head, per
      AGENTS.md, **with the Gemini seat best-effort**. Slice 1's prod-mode PR
      gets its own review before merge.
      **The Gemini clause was re-worded, under authority, and the re-wording is
      the point of this note.** As written the item required the Gemini seat;
      `notes/decisions.md` § "Review gates reduced — 2026-09-06" changed that
      for dev-mode paths — _"Gemini is best-effort exactly as the peer already
      was. Attempt once, record the exact failure, continue. Green CI is now the
      only hard gate."_ That entry deliberately did **not** cut the gate on
      prod-mode or publicly-reachable paths, so **slice 1's clause below is
      untouched and was satisfied before the reduction**: its prod-mode PR
      carries its own Round 1 and Round 2 reviews, recorded in `verify.md`.
      **The cross-provider half is fully met and is not best-effort here.** Every
      PR in slices 7–10 was implemented by an Anthropic seat and reviewed by
      `openai/gpt-5.6-sol` at its exact head, each verdict published through
      `bin/review-artifact.mjs` with a byte-length and sha256 footer and
      verified before it was acted on. The rounds were not a formality: r4 found
      a Critical in shipped code, r7 found three and r7b one, and all five were
      real and were folded.
      **The Gemini half is recorded as skipped, with the exact reason rather
      than a shrug.** `bin/gemini-review.sh` has returned exit 1 on every
      attempt since 2026-09-07T03:22Z, each time with the same message — the
      seat's own `Individual quota reached` refusal, telling the caller to
      upgrade the subscription — most recently measured at 04:22:58Z as
      resetting in 87h17m13s, i.e. ≈**2026-09-10T19:40Z**. Two
      independent measurements taken an hour apart agree on that reset instant.
      One earlier attempt also died on a caller error worth not repeating, and
      the note about it was itself wrong until peer review r8 corrected it. The
      wrapper's signature is
      `gemini-review.sh <prompt-file> <out-file> <timeout> <review-tree>`, so
      the Go duration string (`15m`, never `900`) is the **third** argument;
      the fourth is the required review tree. Passing `900` third is what
      raises `timeout must be a Go duration string` — passing it fourth would
      instead be read as a review-tree path.
      **One r8 Critical was checked and closed rather than folded, and the
      citation is the reason.** r8 held that the reduction cannot reach slices
      2–5 and 7 because `libs/domain/**` is one of "the four prod-mode paths",
      citing `notes/delivery-modes.md`. That file says the opposite one
      sentence on: _"The 2026-08-14 rule (`drizzle/**`, `service/schedule.ts`,
      `libs/domain/**`, auth ⇒ full prod mode per-PR) is **retired as a per-PR
      trigger**"_ — its force now lives in the axis-1 data-safety obligations
      and in the release-time prod-mode review across the whole delta, not in a
      per-PR gate. This task's `working_mode` is `dev`; slice 1, the migration,
      was the prod-mode PR and took the full gate before the reduction. So the
      reduction applies to slices 2–10, and the boundary the 2026-09-06 entry
      protects is not crossed.

## W6, measured

7.6's watched red, run on h2puni at `0e716cba` with `NX_DAEMON=false`. Deleting
`deadlines: sortedPairs(input.deadlines)` from `canonical-schedule-input.ts`
takes `canonical-schedule-input.test.ts` from a green **26 pass / 0 fail** to
**23 pass / 3 fail**, and the three reds are exactly the ones 7.6 names.

| red case                                                             | what it catches                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a deadline the engine now reads`                                    | W6 itself: two plans differing only in `b`'s deadline hash equal, while `schedule()` places `b` and `c` in the opposite order — so the second plan reads the first's schedule off one cache row |
| `a deadline authored on the parent rather than on its only leaf`     | 7.1's as-authored key collapses with the entry                                                                                                                                                  |
| `puts every one of the seven arguments in the string, maps included` | the structural guard, catching the same hole a second way                                                                                                                                       |

This is the same removal the 1.9 sweep recorded as `22 / 2` at `05b78008`. The
third red is new because 7.1 added a case, and the first now reds on **both** of
its assertions rather than on the hash alone, because the engine has read the
field since TASK-267 slice 5. Tree restored clean after the probe.

## 8.5 / 8.5b / 8.5c, measured

**8.5 and 8.5b were already true on the wire and in Python; the sentence that
had no implementation was the disposition.** The response schema admits
`infeasible` as a first-class status distinct from `unknown`, `horizonUnits` is
untouched by any deadline, `design.md` carries both `INFEASIBLE` rows, and
`stage_disposition` returns `ROW_STOP_PLAN_INFEASIBLE` at stage 1 and
`ROW_STOP_INVALID` after it — both stages asserted in `test_solve.py`, with the
empty-stdout rule in `test_cli.py::UnencodableOutcomes`. What no code honoured
was `spec.md`'s "the coordinator SHALL record that run as `invalid-output`",
which `design.md`'s `INFEASIBLE, k > 1` row and the wire schema's response
`$comment` each repeat: `processOutcome` mapped **every** non-zero exit onto
`internal-error`. `dispositionOfExitCode` now splits `cli.py`'s two refusals —
`70` (ran, could not answer) is `invalid-output`, `64` (request refused before
solving) stays `internal-error` — and `cli.py`'s EXIT CODES docstring, which
stated the old blanket rule twelve lines above a handler stating the new one,
is amended in the same commit.

**TASK-310 later split `70` itself, and the sentence above is why it had to.**
"ran, could not answer" described two outcomes, not one: `cli.main` returned
`70` for every `SolveFailed`, and `solve_request` raised that for a CP-SAT
`MODEL_INVALID` at any stage as well as for the later-stage `INFEASIBLE` the
three artifacts actually govern. `MODEL_INVALID` now exits `71` and is
`internal-error`; `stage_disposition` gives it `ROW_STOP_MODEL_INVALID` and
`solve.py` raises `ModelInvalid`, a `SolveFailed` subclass so that callers
which only care that nothing is publishable are unaffected. The decision and
its falsifier are in `dual-optimized-scheduler/design.md`, beside the matrix
that does not have a row for it.

Measured at `1bf4f1c2`: targeted 32/0, `libs/contracts` 261/0, `apps/be-01`
1840/0. Three controls, each reverted after measuring — reverting the
coordinator call gives 15/1, exactly the terminal-evidence case; returning
`internal-error` unconditionally gives 30/2, exactly the two new assertions;
moving `cli.py`'s `EXIT_INTERNAL` from 70 to 71 gives 15/1, exactly the
non-circularity case that reads the codes out of the entrypoint. (That third
control was measured before `71` existed. Since TASK-310 the same edit collides
`EXIT_INTERNAL` with `EXIT_MODEL_INVALID`, which `test_cli.py`'s new pair also
refuses — the injection still reddens, for one more reason than it did here.)

**8.5c was a live divergence in one direction only.** `tasks.md` 3.1 and the
shipped table both carried `plan-infeasible` in the status CHECK and as a third
payload disjunct; `design.md`'s Cache identity bullet still declared `status`
(`'ok' | 'failed'`) and `CHECK (status IN ('ok','failed'))`. Nothing failed,
because no assertion read that bullet — the identical guard for
`failure_reason` lives in `solver-failure-disposition.test.ts` and is why that
vocabulary never drifted. The bullet is amended and
`optimizer-rows.db.test.ts` now parses it, so the status vocabulary and the
payload rule cannot drift from `OPTIMIZED_SCHEDULE_STATUSES` again.

**Left for 8.7, found here:** the same bullet says "a row satisfies a read iff
`status='ok'`", which a `plan-infeasible` row also has to satisfy or it would
auto-respawn. It is qualified to "a read for a schedule" here rather than
rewritten, because the read rule is 8.7's to state. **Now stated and proved
below** — the bullet's "never auto-respawn" clause had no case reading it.

## 8.7, measured

**Every part of 8.7 but two had already landed across runs 1–3, and what was
missing was not code.** The row status, the payload column and both CHECKs
(8.5c), the codec, `evaluateSolverOutcome`'s refusal of an empty certificate,
`storeOptimizedOutcomeAndRecord` writing the row and deliberately emitting no
event, the reader's seventh variant and `objectivesToAutoSpawn` filtering on
`kind === 'miss'` alone are all shipped. The two holes were both **assertions
for sentences 8.7 states in its own words**, and each is the kind that ships
silently because the surrounding code is already right.

**Hole 1 — the ancestor-bound leaf, which is the case 8.7 names as _the_
test.** `planInfeasibleResultOf`'s existing case gave the parent day 8 and leaf
`b` day 5, so the tighter date was always the leaf's own: the fold could have
been "prefer the leaf" and passed. The new fixture puts the two owners in
conflict in both directions at once — leaf `late` carries day 12 under a parent
saying 5, leaf `own` carries day 3 under the same parent — so an implementation
that always names the ancestor fails the second row and one that always names
the leaf fails the first. The second new case asserts the offsets are
`leafDeadlinesOf`'s own answer rather than a second opinion: that function is
what `buildSolverRequest` hands CP-SAT and what `schedule()` measures `lateBy`
against, and `planInfeasibleResultOf` re-folds the tree to carry the owner
along, which is exactly the shape `schedule.ts` warns produces two answers.

**Hole 2 — "never auto-respawned" had no case.** 4.5's ten-reads guard covers
`failed` and `corrupt`; `plan-infeasible` is a different argument for the same
rule and the stronger one. `failed` and `corrupt` are engine faults a later
release might legitimately retry; `plan-infeasible` is a **correct answer about
the user's own dates**, so re-solving cannot change it until a deadline is
edited — and editing one moves the input hash and therefore the key. The new
case reads the row ten times, asserts the certificate on every read so it
cannot pass by degrading to `corrupt`, and counts zero spawns.

Measured at `b4da37cf` on h2puni: `libs/contracts` **263/0** (261 before),
`apps/be-01` **1844/0**, and `nx typecheck` green for both projects — it caught
`toBe(folded.get(id))` narrowing `number | undefined` against `number`, the
same TS2769 class as PR 262's, fixed by putting the fold on the left, which is
also the right direction because the fold is the source and the certificate is
the copy.

Three controls, each reverted after measuring:

| control | mutation                                               | result   |
| ------- | ------------------------------------------------------ | -------- |
| A       | the fold's `<` flipped to `>`                          | 260 / 3  |
| B       | the fold's `<` weakened to `!==`, i.e. last write wins | 261 / 2  |
| C       | `plan-infeasible` rejoins `objectivesToAutoSpawn`      | 1843 / 1 |

**B and C are the exclusive ones.** A reddens the pre-existing fold case too,
so it proves the direction matters but not that the new fixture adds anything.
B leaves the old case green — with `deadlines` iterated in insertion order its
expected rows survive last-write-wins — and reddens exactly the two new
contracts cases. C reddens exactly the one new be-01 case and leaves 4.5's
`failed` and `corrupt` guards untouched, because it widens the predicate by the
single member 8.7 adds rather than back to `kind !== 'ok'`.

**Stale prose corrected in the same commit.** `decodePayload` and its test's
`describe` both still said `decodePlanInfeasible` "does not exist yet" and that
the row was decoded to its envelope only, while the code called the codec and a
third case already asserted a malformed item list reading `corrupt`. The
comments recorded the falsification the split predicted; the code had met it.

## 8.7b, measured

**Site 5 was the gap, exactly as 8.7b predicted, and the other four already
carried `plan-infeasible` in whatever form each is written in.** Sites 1–3 are
member enumerations and each lists seven. Sites 4 and 5 are **not** member
lists and never were: 8.3–8.4 enumerate _indicator renderings_ (a comparison
for `ready`, `Optimizing…` for `pending` and `retrying`, the Retry control for
`failed` and `corrupt`, the count wording for `plan-infeasible`, nothing on
screen for `idle`), and §3.2 enumerates _events_, keyed by what happened rather
than by which state resulted. Saying those two were "at seven" would be a
category error — Sol's r4 review of PR 266 read the earlier wording that way
and called it, correctly. What each is checked for is whether the member this
task adds has a rendering and a row, and it now does in both. Verified by the member-name search this item mandates — the
lines naming `corrupt` together with `idle`, across both changes and the
workspace note — rather than by the count word:

| site | artifact                                                         | state found                                                      |
| ---- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | `dual-optimized-scheduler/design.md` plan-read DTO bullet        | seven, with `plan-infeasible` carrying owner and bound ids       |
| 2    | `.../specs/scheduler-optimization/spec.md` plan-read requirement | seven, in the normative "SHALL be one of"                        |
| 3    | `.../tasks.md` 7.10                                              | "one of seven", and `plan-infeasible` in the proof-state list    |
| 4    | `.../tasks.md` 8.3–8.4                                           | a rendering for every member, this one's included, in both items |
| 5    | `notes/wbs-dual-optimized-scheduler-design.md` §3.2              | **five rows missing** — amended here                             |

Site 5's table now carries the first-stage `INFEASIBLE` row (a
`plan-infeasible` row plus certificate in one transaction, with **which event it
emits recorded as OPEN and owned by `TASK-313`**, the shipped coordinator
emitting none), the later-stage row that stays `failed` + `invalid-output`, the
two settled-read rows that spawn nothing, and the explicit Retry refusal. Its
review-ledger rows are untouched, per 7.2b.

**That row first landed asserting no event at all, and this paragraph went on
describing it that way after the note itself had stopped.** Sol's Critical 2
below withdrew the claim and the note was amended with it (`3560e9e1` wrote the
row, `8ef0f2ab` replaced its event cell with the open question), while this
measured section — which describes what was written rather than re-reading it —
kept the sentence the amendment had already replaced. It is the divergence trap
one more time, inside the item whose whole subject is that trap, and the lesson
is narrower than "check five sites": **a measured section is itself a site**,
because it restates a claim in prose that no member-name search will find.

**The search found a sixth site 8.7b does not name, and it was wrong in two
places rather than one.** `design.md`'s Retry evaluation order, step (2),
listed the states a `not-retryable` covers as "`ready`, `pending` and `idle`"
while `spec.md`'s own ordering already read "`ready`, `pending`, `idle` and
`plan-infeasible`" — and **the gate sentence later in the same bullet carried
the same short list**, which the first pass missed while amending the order
four clauses above it. Sol's r4 review found it; both are amended now. One
bullet enumerating the same set twice is the divergence trap operating inside a
single paragraph. Two normative artifacts, one instantiating list short by
the member this task adds — the same shape as the `solver_slot.lifecycle`
omission `design.md` records at the stored-enum boundary, where the blanket
rule covered the column and the instantiating list did not. Amended in the same
commit. **8.7b's list of five is therefore a floor, not a ceiling:** the member
names find sites the item's own enumeration missed, which is the second time
that has been true of this union.

No test changes, so no gate counts: this chunk is two documents. The union it
describes is asserted by 8.7's own cases and by
`work-item.controller.test.ts`'s variant fixtures, both green at `cc9da8f8`.

## 8.7c, measured

**The two resolutions are now read side by side, off one database, in one
pair.** Both rows carry the **same bytes** in `result_json` — a well-formed
certificate — and both satisfy the table's payload `CHECK`, which asks only
that an `ok` row and a `plan-infeasible` row each have a non-NULL payload and
no `failureReason`. So neither the database nor the JSON can tell them apart.
`status` can, and does: `pri` is an `ok` row whose payload is not a schedule,
which is precisely the definition of `corrupt`, and `time` is the same payload
under the status that claims it, which reads as a certificate.

Measured at `d9fcbb4d` on h2puni: `apps/be-01` **1845/0**. One control, reverted
after measuring — **1844 / 1, exactly the new case.** The mutation is the
modelling 8.7c forbids, written out rather than approximated: the `ok` branch of
`decodePayload`, on a schedule decode failure, tries `decodePlanInfeasible`
before giving up, so an `ok` row carrying an infeasible payload resolves to
`plan-infeasible`. Every other `corrupt` case stays green under it, because
their payloads are truncated JSON or a schedule with a wrong `dtoVersion` and
fail the certificate codec too — which is the point: the defect is invisible
except on the one row where both codecs could plausibly apply, and that row is
this case.

## Sol's r4 review of PR 266, and the Critical it found in shipped code

Verified artifact `queue/reviews/t241-r4-c23-sol.md`, seat `openai/gpt-5.6-sol`,
**REQUEST-CHANGES 2C / 1I / 1M** at exact head `e0d52cac`.

- **Critical 1 — the measured section's wording, fixed above.** It said "four of
  the five sites were already at seven", which is a category error for sites 4
  and 5: one enumerates indicator renderings and the other enumerates events,
  and neither is a member list. Corrected rather than defended.
- **Important 1 — a second short list in the same `design.md` bullet, fixed
  above.** The first pass amended the Retry evaluation order and left the gate
  sentence four clauses later still reading "`ready`, `pending` or `idle`".
- **Minor 1 — agreed and already recorded.** `objectivesToRetry` is permissive
  and safe today only because nothing calls it; the refusal belongs in 7.11's
  route, after the stale-hash and state checks and before liveness admission.
  That is now this task's recorded position on 8.7d's layering question.
- **Critical 2 is real, is in shipped code rather than in this diff, and is
  filed as `TASK-313` (lane e, p1).** `spec.md`'s realtime requirement says the
  guarantee is "one durable replay record **per newly stored outcome**". A
  `plan-infeasible` row is a newly stored outcome, and
  `optimization-coordinator.ts:107` returns before writing any `event_log` row
  for it. A client already on screen therefore sits on `Optimizing…`
  indefinitely, because the failure indicator is event-driven (8.8) and no
  event ever arrives; only a refetch moves it. The row itself is correct and a
  cold load renders the state correctly — this is the live-client half alone.
  **`plan-infeasible` needs an event, and which one is a real design question:**
  `schedule_optimization_failed` carries a `failureReason` it has none of, and
  `schedule_optimized` promises a schedule. The §3.2 table's "no event" claim is
  withdrawn pending that decision rather than left standing as intent.

### Why this PR merges while `TASK-313` is still open

Critical 2 held PR 266 back for a run, and the hold was right at the time: an
artifact change that writes a defect down as intent is not separable from the
defect. It is separable now, and the difference is one sentence, not a
judgement call.

- **The defect is not in this diff and is already on `main`.** 266 is three
  files — one `optimized-cache.db.test.ts` case, one line of
  `dual-optimized-scheduler/design.md` adding this member to the two
  `not-retryable` enumerations inside that bullet, and this document. Every
  line Critical 2 names is in `optimization-coordinator.ts`, which 266 does not
  open. Holding 266 removes nothing: a `plan-infeasible` row leaves a live
  client on `Optimizing…` at `350ee08c` with 266 merged and without it alike.
- **The only coupling was ratification, and it is gone.** The one place this
  task's artifacts asserted the missing event as design was the §3.2 table row
  in the workspace note and this document's description of that row; the note
  was amended at `8ef0f2ab` and the description is corrected in this commit. A
  member-name search across `openspec/` for `plan-infeasible` beside
  `event` or `emit` now returns nothing that claims the outcome emits none.
- **Blocking further would invert what the block is for.** 8.7b's own subject is
  that a stale enumeration ships silently; keeping the corrected enumeration out
  of `main` while the stale one stays in it is the failure mode this item was
  written to catch.

`TASK-313` stays `p1` and queued in lane e, unticked and unmerged with this PR:
it owns choosing the event, amending the realtime contract, the FE subscriber
and `readScopeFor`, and proving it against 7.9's crash case. Nothing here
discharges any of that.

## 8.9 / 8.9b, measured

**The copy half of 8.9 shipped in a different change, and no normative artifact
followed it.** `optimization-indicator.tsx` renders `Same project deadline +
same order`, `Same project deadline + reordered`, `Earlier project deadline by N
days` and `Later project deadline by N days`; it has since PR **246**
(`9a1f79e7`, "add shared optimizer schedule selector"), which is neither this
task nor TASK-221. So the state of `main` before this commit was a `SHALL`
reading "the indicator SHALL report one of: Earlier by N days, …" against a
component that renders none of those four literals. 8.9b was written to stop
exactly that and arrived after the fact.

**The two sites 8.9b names are eight, across seven artifacts, and three of them
are this task's own.** The search was for the string family rather than the
count, the discipline 8.7b's sixth site established. An earlier revision of this
table said six and bundled two artifacts into one row (Sol r5 Important 1);
corrected, with each artifact given its own line:

| site | artifact                                                                | state found                                                               |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | `dual-optimized-scheduler/.../spec.md` comparison-indicator requirement | all four old strings — the `SHALL` 8.9b names                             |
| 2    | `dual-optimized-scheduler/.../spec.md` its "finishes earlier" scenario  | `"Earlier by N days"` in the **THEN**, which 8.9b does not name           |
| 3    | `dual-optimized-scheduler/design.md` §2.2 restatement                   | the two `Same …` strings quoted, the earlier/later pair only by reference |
| 4    | `dual-optimized-scheduler/proposal.md`                                  | the indicator's To-state list                                             |
| 5    | `dual-optimized-scheduler/tasks.md` 8.3                                 | an **unticked** item still specifying the old four                        |
| 6    | `work-item-deadline/specs/.../spec.md` §rename                          | **renamed only two of the four**                                          |
| 7    | `work-item-deadline/design.md` §TASK-221                                | **renamed only two of the four**                                          |
| 8    | `work-item-deadline/proposal.md`                                        | the change summary, `Same deadline …` only                                |

Sites 6 and 7 are the ones worth keeping. This task's own `SHALL` renamed only the two
"Same …" strings and said nothing about the earlier/later pair, so a component
that qualified all four was **exceeding** its requirement, and a future reader
reconciling the two could have narrowed the code back to the half-rename. Half a
rename is the same ambiguity in a different sentence: "Earlier by 2 days" beside
a **Work item deadline** column does not say which deadline moved. Both were
widened to all four, with the reason recorded, rather than the code narrowed to
them.

Sites 2, 5 and 8 are the enumeration lesson again — a scenario's **THEN** and
another change's open task item are both places a literal string lives, and
neither is a requirement sentence. `design.md`'s review-ledger row I1 is left
untouched, per 7.2b.

No test changes and no gate counts, and the size of the chunk is the table
above rather than a smaller number beside it: the rename lands in **all seven
artifacts**, across the **eight sites** the table lists, and this file is the
**eighth changed document**, carrying the record. `git diff --numstat` against
the merge base names those eight and nothing else. An earlier revision of this
paragraph said "five documents plus one scenario line" (Sol r6 Critical 1) —
the same undercount the paragraph above it withdraws, one paragraph later, and
a reader reconstructing the normative blast radius from it would have missed
two artifacts. The strings the rename aligns to are already asserted by
`optimization-indicator.test.tsx`, green on `main`.

**8.9 stays open on its second half, and an earlier revision of this paragraph
put a count on it that was wrong. The count is withdrawn (Sol r5 Critical 1).**
It said "thirteen literals" in shipped `apps/fe-01/src`, then enumerated
fourteen; it was built by extracting **distinct literal values** with one regex
over `.tsx` alone, and then described as an inventory of occurrences. Comments
were counted in the same list as runtime strings, template literals outside the
indicator were missed, and JSX text and accessibility attributes were never
scanned at all. Nothing downstream may rest on it.

Sol's own inventory at `ec15361e`, offered here as the starting point for the
re-measurement rather than as a settled number: **16** `'deadline'` identifier
literals across `column-hints.ts`, `table-frame.ts` and `wbs-table.tsx`, and
**12** shipped copy occurrences — the indicator's four project-comparison forms,
three already-qualified Work-item forms at `optimization-indicator.tsx:69,79`
and `wbs-table.tsx:2562`, and **five unqualified** cell and accessibility forms
at `wbs-table.tsx:2021,10271,10330,10336,10415`. Three strings the withdrawn
list called identifiers occur only inside JSDoc. Whoever writes 8.9 re-measures
in **one declared unit** and includes JSX text and `aria-label`.

**Two corrections that survive the withdrawn count, and they change the item.**

- The withdrawn measurement claimed that the two cell sentences were
  unqualified-but-unambiguous "because the **Work item deadline** label is above
  them". That was **false at its measured head**: the visible heading then read
  `Due`, while `Work item deadline` was a separate Columns-control label. The
  referent those sentences were said to inherit was not on screen beside them.
  The later normative amendment now makes that compact heading one of the two
  exact **Deadline** contract labels; the historical correction does not
  describe the current tree.
- **The original standing SHALL allowed no exception.** Closing 8.9 therefore
  required both changes that now ship: qualify the reader-facing copy, then
  amend the scenario to name exactly two product-contract exceptions — the
  table heading and matching Columns-control label. The repository oracle
  enforces both sides: no other bare occurrence and exactly one label at each
  named source site.

## 8.9, closed

Both closures above now ship. The formerly bare reader-facing occurrences
are qualified, and the later normative amendment defines the only two exact
**Deadline** labels: the table heading and its matching Columns-control entry.
The scanner recognizes those labels by AST shape rather than by a permissive
file list, and a real-tree assertion requires exactly one at each source site.

| was                                                                      | is                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `wbs-table.tsx:2021` `This deadline falls before …; move the deadline …` | _work item deadline_, **both times** — one run, two occurrences |
| `:10271` `Deadline for {n}` (editing cell)                               | `Work item deadline for {n}`                                    |
| `:10330` `Deadline for {n}` (resting cell)                               | `Work item deadline for {n}`                                    |
| `:10336` `… no dates to hold a deadline against.`                        | `… to hold a work item deadline against.`                       |
| `:10415` `Deadline for {n} falls before …` (impossible mark)             | `Work item deadline for {n} falls before …`                     |

Eighteen assertions in `plan-cells.test.tsx` and `plan-keyboard.test.tsx`
follow the label; nothing asserted the two sentence strings.
`optimization-indicator.tsx`'s six were already qualified and are untouched.

**The assertion, and the unit it is measured in.**
`apps/fe-01/src/deadline-copy.test.ts` declares the unit in the file rather
than in prose about the file: **one occurrence of the word inside one run of
user-visible text**, where a run is what the TypeScript parser calls a string
literal, a template literal's fixed text, or JSX text. Taking runs from the
parser and not from a regex over the source is the point — identifiers
(`setDeadline`), member reads (`row.original.deadline`), keys and comments are
not runs, so they are not occurrences and no exclusion list has to name them —
and it reaches the two kinds of copy the withdrawn measurement never scanned,
JSX text and `aria-label`. The narrow heuristic exempts only a lower-case
identifier token in a position a reader is not shown; one-word displayed copy
remains in scope.

**The controls run every time, without pinning their number.** Focused source
fixtures cover bare and qualified attributes and JSX, repeated occurrences,
identifiers, comments, quoted keys, module specifiers, shallow syntax trees and
template holes. Real-tree checks prevent vacuity: they require both copy-bearing
components, require exactly the two AST-shaped contract labels at their named
sites, and retain the formerly bare occurrences by text rather than movable
line numbers. A watched red would prove one mutation once; these controls keep
the relevant boundaries executable on every run.

**The peer found the hole in the first draft of that scan, and it was the
whitespace rule.** Sol r6b (`queue/reviews/t241-r6b-sol.md`, 9173 bytes, sha256
`8f17de33…`, REQUEST-CHANGES 1C / 1I / 1M at `c04abf5d`, all three folded).
The draft skipped every run with no whitespace in it, on the argument that a
bare word cannot be a sentence — and `<button>Deadline</button>`,
`aria-label="Deadline"` and `'Move the ' + 'deadline'` all went through it
green while showing a reader a bare "deadline". One-word copy is still copy.
The exemption is now a lower-case identifier token _and_ a position a reader is
not shown, so `cellKey(id, 'deadline')` and `['deadline', 84]` stay out while
all three of those are checked. Important 1 was the mirror: `runsIn` collected
every `StringLiteral` including a **quoted property name**, so an internal key
`{ 'release deadline': 1 }` would have reddened the suite over copy no reader
can reach — a false positive is what teaches a later author to weaken a guard.
Quoted names are now excluded by position. Minor 1 corrected the cwd note: the
`apps/fe-01` cwd comes from `project.json`'s targets, **not** from either
config, and `test-tiers.test.ts` overstates that too.

**Measured before pushing, not after.** A standalone parser scan over the
committed tree found the shipped deadline-copy runs and **0 unqualified**. The
control expectations were checked against the same predicates before the suite
was pushed; their behaviours, rather than a brittle case or occurrence count,
are the durable contract.

**No h2puni gate ran, and the reason is a host, not a decision.** h2puni is at
**100% inodes** — `df -i /` reports `9849520 / 9849520`, `IFree 0` — so `scp`
of a branch bundle fails and `git fetch` inside the gate checkout dies on
`unable to create temporary file: No space left on device`. CI is the remote
gate here, as it is for every item from 8.9b onward; 10.2 says what that costs
and `TASK-319` owns the difference. (This paragraph read "No remote gate ran"
until peer review r8c pointed out that it then called CI the gate two sentences
later — CI _is_ a remote gate, and the sentence was describing h2puni.)

**A formatter trap that cost one CI cycle, and it is not `lefthook` this
time.** A fresh worktree has no `node_modules`, so
`prettier --check <worktree path>` run from the main checkout resolves
`.prettierrc.json` beside the file and then cannot resolve
`prettier-plugin-tailwindcss` from there — it **silently formats without the
plugin** and reports clean, while `bunx nx format:check --all` in CI has the
plugin and fails. It also reordered `select-none` in four `className` strings
this change never touched. Symlink `node_modules` into the worktree before
formatting; that also brings `lefthook` back onto `PATH`.

## 8.7d and 9.3, closed

Both items describe things that must **not** happen — a Retry that is refused,
an affordance that is absent — and both had shipped the behaviour already. What
was missing in each case was the assertion, and in each case it was missing at
a different layer than the one the behaviour lives in. That is the whole
content of this pair.

**8.7d had a coordinator proof and no route proof.**
`optimization-coordinator.db.test.ts`'s `names an unlaunchable $state variant
not-retryable` already drives a real `plan-infeasible` row through
`coordinator.retry` and asserts the first half of the scenario's THEN: the
decision is `{ kind: 'not-retryable', state: 'plan-infeasible' }`.

**Its second half was not sound and is fixed here (Sol r7 Critical 1).** That
case asserted an empty `solver_slot` table and the closure draft read that as
"no process starts" — but `spawn` runs **before** `bindSolverSlot`, so a
regression that starts a child and then fails to bind leaves the table empty
and the process real. The case now passes the spawn recorder it was
discarding with `coordinator(db, [])` and asserts `calls` is empty as well.
Two assertions because there are two facts: the recorder is about the process,
the table is about the reservation. But the scenario says
`POST /api/projects/:projectId/optimization/retry` **is called for it
directly**, and the route is where a state name can be lost: `project.routes.ts`
maps `not-retryable` to `409 { code, state: outcome.state }`, and until now the
only `not-retryable` case in `project.controller.test.ts` was `ready`. A route
that collapsed every refusal onto one state, or onto `idle`'s hardcoded
no-optimizer answer directly above it, passed that suite. It now carries the
`plan-infeasible` case, and `asks` is 5 rather than 4 — the route still asks
the coordinator for this state rather than short-circuiting it.

The two halves join at the type, not at a shared fixture: the stub's decision
is an `OptimizationRetryResult`, whose `not-retryable` member types `state` as
`OptimizationVariantState['state']`, so the case compiles only while
`plan-infeasible` is a member of the union 8.7b enumerates in five places. A
sixth site would not silently drop out of the route.

**9.3's absences were asserted by a string, which is not the same thing.**
The plan-infeasible case already asserted
`queryByText(/Optimization unavailable/)` is null — but that string is the
_entire_ failed banner, so a Retry offered under any other wording (a bare
button, a link, a second sentence) passed it. The negative is now on the
affordance: `queryByText(/retry/i)` and
`queryByRole('button', { name: /retry/i })`, both after the `<details>` is
opened, because a closed disclosure hides its subtree from the accessibility
tree and would have made a Retry inside it invisible to both queries. This is
the UI mirror of 8.7d: re-solving an unchanged input returns the same proof, so
a control here would promise a recovery the route answers `409` to.

**"Fast still on screen and usable" cannot be proved where the banner is
tested.** `optimization-indicator.test.tsx` renders the indicator alone; there
is nothing else on screen to lose, so the clause is vacuously true there. It is
asserted instead in `optimization-integration.test.tsx`, which renders the
whole `WbsTable` over `fakeProjectApi` with a seeded row, a project start date
and an infeasible `pri` variant.

**Both of that case's halves were first written too weak, and it took two Sol
rounds to get each one honest.** _On screen_ was the row list, which an
infeasible plan would keep even if Fast vanished. The first fix — the
`Gantt chart` region — was no better and r7b said so: that `aria-label` sits on
the section **unconditionally**, and the "nothing can be drawn" branch carries
it too, so finding the region proves a shell. The assertion is a drawn
**`[data-gantt-bar]`**, which is a Fast placement. It needs both a project
start date and a cost on the row: no day zero is no coordinate system, and the
chart filters every unestimated slice out at rest, so either omission would
have put the clause back against an empty chart. Opening the chart through its
own control is kept, so an affordance that stopped working fails here too.

_Usable_ read the name input's own value back after a `change` — but
`CellInput` is uncontrolled through `defaultValue`, so that asserts jsdom and
not the table; the write starts on **blur** and lands in `api.patchWorkItem`.
The case blurs and waits for `patchWorkItem(row.id, { name: 'Launch v2' })`.
**It does not assert a reread, and the first draft's claim that it did was
wrong** (r7b): the spy records the call as `run` enters `await action()`, while
the refresh happens after, so a `waitFor` on the spy can pass before any reread
lands — and the cell would read `Launch v2` either way, because
`fireEvent.change` put it there. What is asserted instead is the fake's own
row: the model behind the API says the write landed.

`dialog`, `alert` and any Retry button are absent from the **document** rather
than from one component's markup. The no-toast negative is
`[data-toast]`, **not** `queryByRole('alert')` (Sol r7 Critical 3):
`ToastStack` gives the alert role to error toasts only, deliberately, so an
info toast is a toast an alert query cannot see and 9.3's clause is absolute.
The alert query stays anyway, doing separate double duty — it is also the
stale-tree banner, so its absence says the rows on screen are the current ones
and not a copy the reader was warned about.

**Neither ran on h2puni.** The host is still at 100% inodes (`df -i /`:
`9849520 / 9849520`, `IFree 0`), so CI is the gate, with
`prettier --check`, `eslint` and `tsc --noEmit` run from inside the worktree —
`node_modules` symlinked first, per the formatter trap recorded above — as the
pre-push check. The pre-existing `tsc -p apps/be-01/tsconfig.spec.json`
failures in `saved-plan-integrity.test.ts`, `solver-launcher-process.ts` and
`solver-supervisor-client.ts` are a local `@types/node`/`bun-types`
`ArrayBufferLike` mismatch in this checkout, are untouched by this change, and
are not reproduced by CI's own typecheck target.

## W5, measured

**Where.** CI, not h2puni: the host is at 100% inodes (`df -i /`: `9849520 /
9849520`, `IFree 0`, filed as `TASK-315`), so no gate can run there. CI fires on
`pull_request` and `push: [main]` and not on a bare branch push, so the fault
went up as a **draft PR that was closed and its branch deleted the moment the
red was read** — PR 274, `red/t241-w5`, head `754eff8d`.

**The fault.** In `apps/be-01/src/service/solver-exit-outcome.ts`, inside
`if (response.status !== 'feasible')`, `infeasible` folded onto `unknown` before
the `unknown` early return, exactly as the item words it:

```ts
const status = response.status === 'infeasible' ? ('unknown' as const) : response.status;
if (status === 'unknown') return { kind: 'failed', reason: 'no-solution' };
```

**The red.** Gate run **34079393999**, failed tasks `be-01:test` and
`be-01:lint`, two assertion failures:

| where                                | expected                                       | received                                                                         |
| ------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `solver-exit-outcome.test.ts:116`    | `{ kind: 'failed', reason: 'invalid-output' }` | `reason: 'no-solution'`                                                          |
| `optimization-events.db.test.ts:278` | two `schedule_optimization_infeasible` events  | two `schedule_optimization_failed`, each carrying `failureReason: 'no-solution'` |

The second is the one the early measurement could not reach, and it is the
sentence: those two events are the disposition of a **real** `status:
'infeasible'` wire response over a deadlined input, and under the fault both
variants become `failed` rows. `failed` is exactly what
`optimization-coordinator.ts`'s retry admits — so an infeasible plan starts
offering a Retry that re-solves an unchanged input for the same proof.

**What the red does not show, stated rather than implied.** The refusal
assertion added for this item sits _after_ that event assertion in the same
case, so the case aborts before reaching it and the failure list names line 278
rather than the refusal. The refusal's own proof is the green side: gate run
**34079387465** on `change/deadline-w5-retry` at `2796ca13`, where
`instance.retry(...)` answers `{ kind: 'not-retryable', state:
'plan-infeasible' }` for both `pri` and `time` on those same two rows. The red
proves the rows stop being `plan-infeasible`; the green proves that while they
are, Retry refuses them.

**The early measurement, and why it was not enough.** Substituting the same
mapping at `4538b811` gave 1840 pass / 1 fail, the single failure being
`evaluateSolverOutcome > keeps classified process failures and distinguishes
solver no-answer states`. That proves the classification seam distinguishes the
two statuses. It says nothing about Retry, because at that head the refusal had
no route to be refused at — 8.7d did not exist — and
`optimization-coordinator.db.test.ts`'s `generationWith` writes its
`plan-infeasible` row **directly**, so no substitution inside
`solver-exit-outcome.ts` can reach it.
