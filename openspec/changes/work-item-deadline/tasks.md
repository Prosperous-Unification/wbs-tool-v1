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

| Slices | Owner | Why |
|---|---|---|
| 1–6, 9, 10.1–10.3 | **this change's own queue tasks** | column, converter, fold, `schedule()`'s seventh argument, Fast ordering, API, UI — all against code that exists |
| 7, 8 | **TASK-219 absorbs them** | they assert cache-key columns (7.4), hash behaviour (7.1, 7.6) and a wire schema (8.1) belonging to artifacts TASK-219 has not created yet |
| 10.4 | **both owners, each at its own terminal gate** | AGENTS.md's cross-provider review binds whoever ships a diff; it is not one task's checkbox |

Consequently **W1, W3 and W4 are watched here; W2, W5 and W6 are watched inside
TASK-219**, and 10.1's "all six recorded failing" spans both tasks rather than
one. Written down because the alternative is a queue that either blocks slice 8
on a file that does not exist or lets two tasks implement it twice.

The pre-219 obligation is therefore this document, not slices 7–8's code:
TASK-219 must start from a plan that already says seven arguments, `infeasible`,
`deadlineUnits` and a seventh `VariantState`. That is what "lands before" means
here.

## 1. Migration and column — PROD MODE, own PR

- [ ] 1.1 `work_item.deadline TEXT NULL` in
      `apps/be-01/src/repository/schema.ts`, beside `start_no_earlier_than`,
      with a forward migration under `apps/be-01/drizzle/`. **No reason
      column** — the floor's `start_no_earlier_than_reason` gets no counterpart
      here, and adding one speculatively is out of scope.
- [ ] 1.2 **`apps/be-01/drizzle/**` is a prod-mode path**
      (`notes/delivery-modes.md`): this slice ships as a reviewed PR and is not
      self-merged, and it carries **nothing else** — no domain code, no API
      field, no UI. That isolation is the same one TASK-218 applied to the cache
      migration, and it is what lets slices 2–9 self-merge.
- [ ] 1.3 Proof, not assertion: the migration runs forward on a copy of a real
      migrated database file and every existing row reads `deadline: null`
      afterwards. Rolling the **application** back with the column present is
      exercised once — the old column list does not name `deadline`, so the
      values sit unread. Rolling the **migration** back is not tested because it
      is not supported; it drops user data.

## 2. `deadlineOffsetOf` and `previousWorkday`

- [ ] 2.1 `previousWorkday` exported from `libs/domain/src/workday.ts` beside the
      existing `nextWorkday`.
- [ ] 2.2 `deadlineOffsetOf(projectStart, deadline)` returning
      `{ kind: 'offset'; offset: number } | { kind: 'before-project-start' }`,
      rolling **backward** on a non-working date and returning the typed variant
      — never the number `0` — when the rolled date falls before day zero
      (`addWorkdays(projectStart, 0)`, which is `nextWorkday(projectStart)` and
      not `projectStart` itself).
- [ ] 2.3 The mirror of the existing `addWorkdays`/`workdaysBetween` property
      test: for every workday `s` and offset `k`,
      `deadlineOffsetOf(s, addWorkdays(s, k))` is `{ kind: 'offset', offset: k }`.
- [ ] 2.4 **WATCHED RED W3** — substitute `workdaysBetween` for
      `deadlineOffsetOf`. Two cases must go red together: a Saturday deadline
      must grant two extra calendar days (`nextWorkday` rolls it to Monday), and
      a pre-project-start deadline must silently become offset `0`, the
      strictest possible deadline in place of what the user typed. A test that
      only catches the first is not this red.

## 3. The effective-deadline fold

- [ ] 3.1 `effectiveDeadlines(rows, deadlines)` folding each leaf to the
      **minimum** of its own deadline and every ancestor's, `null` where none
      exists. It is a separate walk from the floor's `latest` expansion and is
      **not** collapsed into one direction-parameterised function with it: the
      out-of-range clamps differ (§1.3) and are not shared.
- [ ] 3.2 Both precedence directions asserted, not one: a parent dated earlier
      tightens a later child, **and** a later parent does not loosen an earlier
      child. One test proves nothing about the fold's direction; two do.
- [ ] 3.3 Empty subtree — a parent with a deadline and no leaves emits no
      constraint, raises no error, and keeps its stored date when its subtree is
      deleted.
- [ ] 3.4 The two impossible kinds are distinguished at their own boundaries:
      `before-project-start` at write time (slice 6) is malformed input;
      unreachable-but-well-formed is legitimate input that Fast reports late
      (slice 5) and PRI/Time report infeasible (slice 8).
- [ ] 3.5 **WATCHED RED W4** — fold with `max` instead of `min`; a child dated
      earlier than its parent must be loosened to the parent's date.

## 4. `schedule()`'s seventh argument and the inclusive predicate

- [ ] 4.1 `schedule(rows, edges, slices, notBefore, poolSizes, reach, deadlines)`
      with `deadlines: ReadonlyMap<string, number>` **defaulted to an empty map**,
      so every existing caller compiles unchanged and the no-op proof in 4.3 is
      about behaviour rather than about call sites.
- [ ] 4.2 The predicate, applied per slice against its effective deadline offset,
      written **once** as `lastWorkdayOf(start, finish) <= deadlineOffset` and
      referenced by slices 5, 8 and 9 rather than re-derived in any of them.
      `finish <= deadline` does not appear in the implementation.
- [ ] 4.3 **The no-op proof.** Every case in the Fast golden corpus produces a
      **byte-identical** schedule under the seventh argument defaulted to an
      empty map. This is the one test that says the seam did not move; it is
      compared byte-for-byte against the recorded corpus, not field-by-field.
- [ ] 4.4 **WATCHED RED W1** — drop the `max` term from `lastWorkdayOf` in the
      predicate (use `ceil(snapWorkdays(finish)) − 1` alone). A zero-duration
      milestone starting at exactly offset `D + 1.0` must be reported **on
      time**. A non-zero-duration fixture cannot produce this red; the test must
      be the milestone.
- [ ] 4.5 A deadline never moves work earlier and never overrides a floor: a leaf
      whose floor is later than its effective deadline still starts at its floor
      and is reported late.

## 5. Fast ordering and `Late by N workdays`

- [ ] 5.1 Ready-slice order becomes minimum slack (`deadlineOffset −
      earliestFinish`, whole workdays), then earliest effective deadline, then
      the **existing, untouched** priority tie-breaks. Slices with no effective
      deadline sort after every deadlined slice, holding their existing relative
      priority order.
- [ ] 5.2 `Late by N workdays` per missed slice, with
      `N = lastWorkdayOf(start, finish) − deadlineOffset`, `N >= 1`, computed
      from 4.2's single predicate so the label and the lateness verdict cannot
      disagree. The copy says **workdays**.
- [ ] 5.3 Fast still never backtracks and never moves work earlier than its
      floor: the existing invariant tests run unchanged against a corpus that now
      carries deadlines.
- [ ] 5.4 A project start moved past a stored deadline resolves
      `before-project-start` **at read time** and is reported late by the whole
      span — the stored value is not rewritten and the request is not rejected.

## 6. API, realtime, undo

- [ ] 6.1 `deadline` joins the work-item PATCH payload as a nullable `IsoDate`.
      Non-`IsoDate` → `422` through the **existing** malformed-payload path;
      `deadlineOffsetOf` returning `before-project-start` → `422` naming the
      offending work item and the project's day zero, which is the **only**
      deadline-specific rejection; `null` clears it.
- [ ] 6.2 Authorization is the existing work-item write authorization —
      asserted by a test that a caller who may edit a work item may set its
      deadline, so no new authority is silently introduced.
- [ ] 6.3 No new event type and no new undo verb: `deadline` rides the existing
      work-item update event and the existing undo stack. Redo of a clear
      restores `null`; redo of a set restores the date. Both through the ordinary
      field-edit path.
- [ ] 6.4 A deadline edit invalidates the optimized cache for that project
      exactly as a priority or floor edit does, through the existing debounce and
      generation fence, with no new machinery.

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
- [ ] 7.4 `deadline` is **not** a new cache-key dimension. Assert the key columns
      are still `(projectId, inputHash, objective, contractVersion, budgetMs)`.
- [ ] 7.5 A **regression test**, not a rule change: run two contract versions
      against one SQLite file and assert both row sets survive a store on each
      side. **Do not add a retention requirement.** An earlier draft called this
      an existing latent defect; it is not — the rule already reads "allocating
      a new generation SHALL delete every cache row of that project **for that
      contract version**" and retains per `(projectId, objective,
      contractVersion, inputHash)`. That draft had quoted the requirement's
      unscoped *title* and ignored its scoped body. Adding a second requirement
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
