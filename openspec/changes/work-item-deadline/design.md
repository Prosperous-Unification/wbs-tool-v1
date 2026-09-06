# WBS Work item deadline — Design (TASK-240)

Task: `backlog/tasks/task-240 - wbs-deadline-design.md`, lane e, item `wbs-deadline`.
Repo: `/home/claw/wd/puni/wbs-tool-v1`, branch `change/work-item-deadline`,
worktree `/home/claw/wd/puni/wt-deadline-design`, based on
`change/dual-optimized-scheduler` @ `f5a16a8d` (TASK-218, done 2026-09-03T20:04:38Z).

This design **amends** the dual-scheduler contract in
`notes/wbs-dual-optimized-scheduler-design.md` and
`openspec/changes/dual-optimized-scheduler/*`. It must land before TASK-219
(`wbs-optimized-scheduler-coordinator-cache`) starts, because it changes the
canonical input, the cache identity, the solver wire and the failure state
machine — all four of TASK-219's subjects. No production code in this task.

## §0 The one name

**`deadline` internally, "Work item deadline" in UI copy.** One name, in the
domain argument, the database column, the API field, the canonical input, the
event payloads, the solver wire and the glossary. `finishNoLaterThan` is **not**
introduced anywhere, and neither is `dueDate`, `targetDate` or `endBy`.

The asymmetry with the existing floor is deliberate and is called out here so a
reader does not "fix" it: the floor's storage column is
`work_item.start_no_earlier_than` (`schema.ts:292`) and its domain argument is
`notBefore` — two names for one fact, which is the mistake this field does not
repeat. Renaming the floor is **out of scope** and is not a prerequisite.

**TASK-221 copy reconciliation.** §2.2 of the dual-scheduler design ships a
comparison indicator whose four strings are `Earlier by N days`, `Later by N
days`, `Same deadline + reordered`, `Same deadline + same order`. That
"deadline" is the **schedule's project finish date** and is now written
**Project deadline**; this task's per-item constraint is always **Work item
deadline**. The two indicator strings become `Same project deadline +
reordered` and `Same project deadline + same order`. Amending them is a
required slice of this change (§6 slice 8), not a follow-up: shipping a
per-item "deadline" beside an unqualified "Same deadline" is the exact
ambiguity the task exists to prevent.

## §1 Domain semantics

### 1.1 The field

Nullable, **date-only**, no time-of-day, no timezone. `IsoDate` (`YYYY-MM-DD`),
the same type the floor already uses. `null` is "no deadline" and is the
default for every work item that exists today.

Set on **any** work item, leaf or parent. It is a constraint on work, not a
label on a row.

### 1.2 Inclusive, against the displayed End date

The chosen date is inclusive: a work item with `deadline: 2026-10-09` may finish
**on** the 9th. The convention is not invented here — it is pinned to the End
date the product already prints, which is

```
endsOn = addWorkdays(project.startDate, lastWorkdayOf(earliestStart, earliestFinish))
```

(`work-item.service.ts:366`), so the normative predicate is

```
lastWorkdayOf(start, finish) <= deadlineOffset
```

and **not** `finish <= deadline`. The brief's `finish <= deadline` is the
informal statement of it; this is its exact form. Everything below derives from
that one line, which is why it is stated once and referenced rather than
re-worded per artifact.

`lastWorkdayOf(start, finish) = max(firstWorkdayOf(start), ceil(snapWorkdays(finish)) − 1)`
(`workday.ts:192`). The `max` term is load-bearing for zero-duration work — see
§1.6 — and dropping it is a watched red (§7).

### 1.3 `deadlineOffsetOf` — a NEW converter, because `workdaysBetween` is wrong for a ceiling

**`workdaysBetween` must not be reused here.** It is the floor's converter and
both of its documented behaviours are unsafe in the opposite direction:

1. **It rolls a non-working date FORWARD.** `workdaysBetween` computes
   `nextWorkday(to)` (`workday.ts:300`). A deadline of Saturday the 10th would
   become Monday the 12th's offset — a ceiling silently **relaxed by two
   calendar days** by a unit conversion. A floor rolled forward is
   conservative; a ceiling rolled forward is a missed deadline reported as met.
2. **It clamps a `to` before `from` to 0** (`workday.ts:305`), because "the plan
   cannot start before its own start". For a ceiling, offset 0 is not a clamp,
   it is the *strictest possible* deadline — "finish on day zero" — silently
   substituted for what the user typed.

So `libs/domain/src/workday.ts` gains

```
deadlineOffsetOf(projectStart: IsoDate, deadline: IsoDate):
  | { kind: 'offset'; offset: number }
  | { kind: 'before-project-start' }
```

which rolls **backward** (`previousWorkday`) and returns the typed
`before-project-start` rather than a number when the rolled date falls before
`addWorkdays(projectStart, 0)` — day zero, which is `nextWorkday(projectStart)`,
not `projectStart` itself.

**Backward is the honest reading** and is recorded as an assumption, falsifiable
by Dany: no work happens on Saturday, so "by Saturday the 10th" means the last
day work may happen is Friday the 9th. Rolling forward would let a plan finish
*after* the date the user chose, which is the one thing a deadline may not
permit. **What would falsify it:** Dany saying a weekend deadline means "the
start of the following week".

`previousWorkday` is a new export beside the existing `nextWorkday`, and the
property test that equates `addWorkdays`/`workdaysBetween` gains its mirror:
for every workday `d` and every offset, `deadlineOffsetOf(s, addWorkdays(s, k))`
is `{ kind: 'offset', offset: k }`.

### 1.4 Effective deadline: propagation and precedence

The **effective deadline** of a leaf is the minimum of its own deadline and
every ancestor's, `null` where none exists:

```
effective(leaf) = min over { deadline(n) | n = leaf or n is an ancestor of leaf, deadline(n) ≠ null }
```

Earliest applicable wins, unconditionally — a parent dated the 5th tightens a
child dated the 20th, and a child dated the 5th is *not* loosened by a parent
dated the 20th. This mirrors the floor's expansion (`schedule()`'s `notBefore`
doc: "Each leaf takes the **latest** of its own floor and every ancestor's")
with `latest` replaced by `earliest`, and it is the same tree walk with a
different fold — one function, one direction argument, is the wrong shape here
because the clamp differs (§1.3) and is not shared.

**A parent's deadline constrains the latest finish anywhere in its subtree.**
That is realised as: the effective deadline applies to **every slice** of every
work item in scope, not to a computed subtree maximum. The two are equivalent —
intra-item step order is a precedence chain (`groupByWorkItem` preserves the
given order and that order *is* the precedence), so a work item's last slice has
its maximum finish, and a subtree's maximum finish is the maximum over its
leaves' last slices. The per-slice form is chosen because it is what a CP-SAT
constraint and a Bun revalidator can both state directly without materialising a
subtree aggregate. **A leaf's own deadline therefore reduces to "constrains its
last slice"**, exactly as the brief says, without that being a second rule.

### 1.5 Empty subtrees

A parent with no leaves beneath it constrains nothing and is **not** an error.
The fold produces no leaf, so no constraint is emitted, no infeasibility can
arise from it, and the row still displays its Work item deadline. A parent whose
entire subtree is deleted keeps its deadline; nothing rewrites user input on a
structural edit.

### 1.6 Zero-duration work

A slice with `days: 0` (or an unestimated slice resolved to zero) has
`finish === start`. Under §1.2 its last workday is
`max(firstWorkdayOf(start), ceil(snapWorkdays(start)) − 1)`, and the `max` is
what decides it: a milestone starting at exactly offset `3.0` has
`ceil(3) − 1 = 2` but occupies day 3, so the `firstWorkdayOf` term is the true
one. **A zero-duration slice is on its deadline iff the day it sits in is at or
before the deadline day**, which is the same rule as everything else, and the
naive `finish <= deadline` would have said a milestone at the very start of the
day after its deadline was on time.

In the solver's integer domain this is the reason the constraint is written
`startUnits + max(durationUnits, 1) <= (D + 1) × quantum` rather than
`finishUnits <= (D + 1) × quantum` (§3.2).

### 1.7 Impossible dates

Two kinds, and they are **not** the same thing:

- **`before-project-start`** (§1.3): the deadline resolves before day zero. This
  is a *malformed input*, not an infeasible plan. It is rejected at the write
  boundary (§2.2) with `422`, so it never reaches a scheduler and never becomes
  a cache row. A project whose `startDate` is *later* edited past an existing
  deadline does not retro-reject the stored value — see §2.3.
- **Unreachable but well-formed**: the deadline is at or after day zero and the
  plan simply cannot meet it. This is legitimate input. Fast reports lateness
  (§3.1); PRI/Time report `plan-infeasible` (§3.3). Neither is an error.

### 1.8 What does not change

`schedule()`'s existing floor, priority, reach, capacity and person semantics
are untouched. A deadline never moves work **earlier** and never overrides a
floor: where a floor and a deadline contradict, the plan is late (Fast) or
infeasible (PRI/Time), and the floor still wins the placement. A deadline is a
constraint on the *outcome*, never a scheduling instruction.

## §2 Persistence, API, realtime, undo

### 2.1 Storage

`work_item.deadline TEXT NULL` in `apps/be-01/src/repository/schema.ts`, beside
`start_no_earlier_than`, with a forward migration under `apps/be-01/drizzle/`.

**`apps/be-01/drizzle/**` is a prod-mode path** (`notes/delivery-modes.md`), so
the implementation slice that carries this migration ships as a reviewed PR and
is not self-merged. It is isolated into its own slice (§6 slice 1) for exactly
that reason, the same isolation TASK-218 applied to the cache migration.

No reason column. The floor carries `start_no_earlier_than_reason`
(`schema.ts:326`); a deadline reason is **not** in scope and is not added
speculatively.

### 2.2 API

`deadline` joins the existing work-item PATCH payload as a nullable `IsoDate`.
Validation at the boundary, before any scheduler runs:

- Not an `IsoDate` → `422`, existing malformed-payload path.
- `deadlineOffsetOf(...)` returns `before-project-start` → `422` with the
  offending work item and the project's day zero. This is the **only**
  deadline-specific rejection.
- `null` clears it.

Authorization is the existing work-item write authorization; a deadline is not a
project setting and adds no new authority.

### 2.3 A project start date moved past a stored deadline

Legal, and **not** retro-rejected. The stored date is what the user typed; the
project moving under it does not make their input malformed. The effective
deadline for that item resolves to `before-project-start` **at read time**, which
is treated as *unmeetable*, not as *invalid*: Fast reports it late by the whole
span, PRI/Time report `plan-infeasible` naming it. The row shows its Work item
deadline with the existing "impossible" affordance rather than being silently
dropped. Rejecting it would delete user data on an unrelated edit.

### 2.4 Realtime and undo

`deadline` rides the existing work-item update event and the existing undo
stack — it is an ordinary nullable column on an already-collaborative,
already-undoable row. **No new event type, no new undo verb.** Setting and
clearing are both ordinary field edits, so redo of a clear restores `null` and
redo of a set restores the date, with no special case.

The one consequence worth stating: a deadline edit changes the canonical input
(§3.4), so it invalidates the optimized cache for that project exactly as a
priority or floor edit does, and the coordinator's existing debounce and
generation fence carry it with no new machinery.

## §3 Scheduler contract amendment

### 3.1 Fast — heuristic and best-effort, unchanged in kind

Fast stays immediate, single-pass and **best-effort**. It gains one thing in the
ordering and one thing in the output.

**Ordering.** Among ready slices, order by **minimum slack** — the effective
deadline offset minus the earliest finish the slice could take — then by
**earliest effective deadline**, and only then by the existing priority
tie-breaks, which are otherwise untouched. Slices with no effective deadline sort
after every slice that has one, at their existing priority position relative to
each other. This is a **tie-break refinement, not a new objective**: Fast still
never backtracks and still never moves work earlier than its floor.

**Output.** Each slice whose effective deadline is missed carries
`Late by N workdays`, where

```
N = lastWorkdayOf(start, finish) − deadlineOffset      (N ≥ 1 when late)
```

— whole workdays, computed in the same domain as §1.2 so the number on screen
and the predicate that decided lateness can never disagree. `N` is workdays, not
calendar days, and the copy says so.

**A missed Fast deadline is never presented as an optimized baseline.** The
comparison indicator (§2.2 of the dual-scheduler design) compares an optimized
variant against Fast; when Fast is late on any item and the optimized variant is
feasible, the indicator shows the optimized result and the lateness belongs to
Fast alone. When the optimized variant is `plan-infeasible` (§3.3), the indicator
does **not** fall back to reading Fast's late plan as a satisfied baseline — it
reads `Plan infeasible · N work item deadlines` with Fast still on screen and
still labelled late per item. Fast's lateness is a report, never a verdict of
feasibility.

### 3.2 PRI and Time — a hard constraint, before the objective

Both optimized objectives treat every effective deadline as a **hard
constraint**, added to the model **before** the objective terms and independent
of them. It is not a penalty, not a soft term and not a lexicographic stage:
a plan that violates any effective deadline is not in the feasible set.

The CP-SAT form, per slice `s` with effective deadline offset `D`:

```
startUnits(s) + max(durationUnits(s), 1) <= (D + 1) × quantum
```

`(D + 1) × quantum` is the first instant of the day after the deadline day, so
the constraint is exactly "the work occupies no instant of any later day". The
`max(·, 1)` is §1.6: it is what makes a zero-duration milestone sit *within* day
`D` rather than at the boundary that belongs to `D + 1`. Writing
`finishUnits <= (D + 1) × quantum` instead is a watched red (§7) — it passes
every non-zero-duration fixture and admits a milestone one day late.

### 3.3 `plan-infeasible` is a typed state, not a failure

**A legitimate outcome, at the first stage only.** CP-SAT proving the model
infeasible **at stage 1** means the user's deadlines cannot all be met; the
engine worked correctly.

**The stage qualifier is not decoration, and this note had it wrong.** The rule
being amended says `INFEASIBLE` is `invalid-output` **at any stage**, because
Fast placed the same graph and every later stage's added constraint is satisfied
by the previous incumbent. Deadlines enter *before* the objective terms (§3.2),
so they are present at stage 1 — which is the one case that blanket rule now
over-covers, and the only case that changes. A **later-stage** `INFEASIBLE` is
still impossible on a correct engine, stays `invalid-output`, and could not
populate the payload below in any event: it carries no offending-item
certificate. The "at any stage" clause and the stage-status matrix are amended
in the same commit (§6 slice 8). Merging an unqualified new rule against the
unamended old one leaves two requirements mandating opposite outcomes for one
solver status, and if the new one wins, a later-stage engine failure is cached
as "your deadlines cannot be met", with no Retry, at the moment the solver's own
earlier stage proved a deadline-satisfying schedule exists. It is **not** the
`invalid-output` / `failed` path, and it must not reach the
`Optimization unavailable · Retry` indicator, because retrying is guaranteed to
produce the same answer and Retry would be a lie.

`plan-infeasible` therefore joins the stored variant state machine (§3.2 of the
dual-scheduler design) as its own row state beside `ok` and `failed`, with:

- **Payload** naming every offending work item and its **effective** deadline —
  the effective one, because a leaf whose parent's date is the binding
  constraint must show the date that actually bound it, and pointing at the
  leaf's own later date would send the user to edit a field that changes
  nothing. Each entry carries the work item that *owns* the binding date and the
  work item the constraint *fell on*, which are the same id when it is a leaf's
  own.
- **Cached like `ok`**, keyed identically. It is a deterministic function of the
  input, so re-solving the same input to learn the same answer is waste. It does
  **not** suppress a new hash's generation.
- **No auto-respawn**, the same rule a `failed` row carries, and for a stronger
  reason: the answer is stable.
- **UI:** `Plan infeasible · N work item deadlines`, with the offending items
  listed on demand. Fast stays on screen and stays usable. There is no toast and
  no modal, matching the settled failure UX.

**The distinction that must survive review:** `plan-infeasible` is CP-SAT
returning `INFEASIBLE` on a well-formed model. Malformed or invalid solver
output — an unparseable line, an unknown status, a missing or unknown offset key,
or any offset that fails the Bun revalidation — remains `invalid-output` and an
**engine failure**, exactly as today. A solver that returns a *feasible* schedule
violating a deadline is likewise `invalid-output`, not `plan-infeasible`: the
revalidator (§3.5) catches it and the engine is at fault.

### 3.4 Canonical input and cache identity

§2.2 of the dual-scheduler design defines the canonical input as **the exact
argument tuple of `schedule()`**. `deadline` is a seventh argument:

```
schedule(rows, edges, slices, notBefore, poolSizes, reach, deadlines)
```

`deadlines: ReadonlyMap<string, number>` — `[workItemId, deadlineOffset]`
entries **sorted by id**, offsets already resolved by `deadlineOffsetOf` against
`project.startDate` into whole workdays from day zero, exactly as `notBefore`
entries are. Keys are as-authored work item ids, **not** pre-expanded to leaves:
the fold (§1.4) is derived, and hashing the expansion would hide a parent's
deadline edit that binds no leaf today and binds one after a move — the same
argument §2.2 already makes for hashing `priority` as written.

Consequences that must be written into the dual-scheduler artifacts, not left
implied:

- The canonical input list grows from six entries to seven, which makes four
  existing statements false on merge. **Do not grep for "six".** Verified
  2026-09-03 against the artifacts themselves: the word appears in exactly one
  of the four, and the other three state the tuple literally with no numeral, so
  a count-word grep passes green while three normative artifacts still say the
  hash covers six arguments. **Grep for the literal string
  `schedule(rows, edges, slices, notBefore, poolSizes, reach)`**, which is what
  actually occurs in all four:

  | File | Where | What is stale |
  |---|---|---|
  | `openspec/changes/dual-optimized-scheduler/specs/scheduler-optimization/spec.md` | §"The canonical input is the exact argument tuple of the Fast pass" | the normative tuple and its enumeration |
  | `openspec/changes/dual-optimized-scheduler/design.md` | the **Canonical input** bullet | the tuple and its hashed-fields list |
  | `openspec/changes/dual-optimized-scheduler/tasks.md` | slice 1.1 | the tuple the implementer builds from |
  | `notes/wbs-dual-optimized-scheduler-design.md` §2.2 | "carries all six arguments and nothing else" + the numbered list | the count word **and** the list |

  `openspec/changes/dual-optimized-scheduler/tasks.md` was missing from the
  first version of this list and is the one an implementer actually follows.
  **`notes/wbs-dual-optimized-scheduler-design.md` is a workspace file, not a
  wbs one** — a grep run inside the wbs checkout will never see it.

  **One occurrence must NOT be amended:** the round-1 row of that note's review
  ledger ("Canonical input rebuilt from `schedule()`'s actual six arguments"). A
  ledger records what a past round found and fixed; rewriting it to say seven
  would make it a false record of round 1. Amend normative text, never history.
- `SCHEDULER_CONTRACT_VERSION` **must be bumped**. The canonical input, the wire
  and the materialiser all change, so every pre-existing cache row is describing
  a different function. The bump is what evicts them; there is no data migration
  of cached results.
- The Fast golden corpus is keyed on `SCHEDULER_CONTRACT_VERSION`, so the bump
  re-keys it in the same commit — and every existing corpus case must produce a
  **byte-identical** schedule under the seventh argument defaulted to an empty
  map. That is the no-op proof (§7).
- `deadline` is **not** a new cache-key dimension. It is inside the hash, like
  every other input. Objective, contract version and budget remain the only
  key dimensions beside `(projectId, inputHash)`.

### 3.5 Solver wire

The wire schema `libs/contracts/solver/solver-wire.v1.json` is the single
normative definition and this note does not restate it — the same rule TASK-218
settled after its prose request twice disagreed with the schema. Two additions:

- **Per slice: `deadlineUnits`** — `integer | null`, in the same units as
  `notBeforeUnits`, `horizonUnits` and every returned offset. It is the
  **effective** deadline for that slice, already folded (§1.4) and already
  converted to `(D + 1) × quantum`, so Python applies §3.2 without seeing the
  tree, exactly as it already never sees `reach`. `null` is "unconstrained".
- **Response `status`: `infeasible`** joins the stage-status matrix as a
  first-class outcome. It is distinct from `unknown` (budget exhausted with no
  proof) and must not be mapped onto it: `unknown` may become feasible with more
  budget, `infeasible` never will.

`horizonUnits` is **unchanged**. It stays
`max(0, ...notBeforeUnits) + Σ durationUnits` — a serial upper bound that every
feasible schedule fits inside. Tightening it to the latest deadline would be
wrong twice: it would make an infeasible plan indistinguishable from a
horizon-overflow, and it would remove the serial fallback that makes the bound
provably safe.

Because tasks.md 2.1 carries a repository check comparing every tagged
enumeration in the planning files against the schema's own `required` sets and
failing on the symmetric difference, **every `<!-- wire-fields:slice -->` and
`<!-- wire-fields:response -->` marker must be amended in the same commit** as
the schema. A partial edit is a red gate, by design.

### 3.6 Bun-side revalidation

The coordinator's independent revalidation (§3.3 of the dual-scheduler design)
gains one clause, stated in the **real fractional domain** on the materialised
schedule and not in quantised units:

> for every slice, `lastWorkdayOf(start, finish) <= effectiveDeadlineOffset`

Checking it in units would re-implement §1.2's rounding a second time and could
disagree with what the End date column prints — the same argument §2.2 already
makes for `sameOrder` being compared in the real domain. A violation is
`invalid-output` (§3.3), because a solver that returns a deadline-violating
schedule is a broken engine, not an infeasible plan.

`materialiseOptimized` needs **no** change: it pins the optimized starts and
replays Fast's annotation pass, and a deadline changes no annotation. The
`ScheduleFloor` union is **not** extended — a deadline never *causes* a start, so
nothing is ever `boundBy: 'deadline'`. Adding a member there would be a category
error and is a watched red (§7).

## §4 Migration and rollback

**Forward.** One additive nullable column and one
`SCHEDULER_CONTRACT_VERSION` bump. Every existing row reads `null`, every
existing plan schedules identically, every existing cache row is evicted by the
bump rather than being read under a contract it does not satisfy.

**Rollback boundary.** Rolling back the *application* while the column exists is
safe: the old code selects a column list that does not name `deadline`, the
values sit unread, and the old `SCHEDULER_CONTRACT_VERSION` keys a disjoint set
of cache rows. Rolling back the *migration* drops user data and is not a
supported operation. The blue/green swap therefore runs the migration first and
the application second, which is the existing order.

**The one real hazard, and it is NOT a new defect.** During a swap, blue and
green run different `SCHEDULER_CONTRACT_VERSION` values against one SQLite file.
That is already handled, and further than an earlier draft of this section
claimed: the version is part of the cache key, so the two generations read and
write disjoint rows, **and retention is already scoped to it** — the existing
rule reads "allocating a new generation SHALL delete every cache row of that
project *for that contract version*", retaining per `(projectId, objective,
contractVersion, inputHash)`.

This section previously called that an existing latent defect that this change
makes reachable, and §6 carried a slice to fix it. Both were wrong: the draft
quoted the retention requirement's unscoped **title** and ignored its scoped
body. What survives is a regression test that runs two contract versions against
one file and asserts both row sets survive (§6 slice 7) — worth having, and not
a rule change. Adding a second requirement for behaviour a first one already
owns is the divergence pattern these artifacts have paid for repeatedly.

## §5 Assumptions (numbered, with what falsifies each)

1. **A non-working deadline date rolls backward** to the previous workday
   (§1.3). Falsified by Dany saying a Saturday deadline means the following
   Monday.
2. **No reason column** (§2.1). Falsified by a request to explain a deadline the
   way `start_no_earlier_than_reason` explains a floor.
3. **Slack is `deadlineOffset − earliestFinish` in whole workdays** and ties fall
   through to the existing priority order (§3.1). Falsified by a request for
   slack to weight priority rather than precede it.
4. **`plan-infeasible` is cached and never auto-respawned** (§3.3). Falsified by
   a request for a "try again with a longer budget" affordance, which would be a
   new user-initiated action rather than an automatic retry.
5. **A project start date moved past a stored deadline is unmeetable, not
   invalid** (§2.3). Falsified by a request to clear or clamp such deadlines on
   the project edit.

## §6 Implementation slices (ordered, TDD)

1. **Migration + column** — `work_item.deadline`, forward migration.
   **PROD MODE**: reviewed PR, not self-merged. Nothing else in this slice.
2. **`deadlineOffsetOf` + `previousWorkday`** in `libs/domain/src/workday.ts`,
   with the mirror property test of §1.3.
3. **Effective-deadline fold** — the ancestor min of §1.4, with §1.5's empty
   subtree and §1.7's two impossible kinds.
4. **`schedule()`'s seventh argument** — the predicate of §1.2 applied per slice,
   `Late by N workdays` per §3.1, and the byte-identical no-op proof over the
   whole Fast golden corpus with an empty map.
5. **Fast ordering** — minimum slack then earliest effective deadline before the
   existing priority tie-breaks (§3.1).
6. **API + realtime + undo** — §2.2's `422` boundary, the existing event, the
   existing undo stack (§2.4).
7. **Canonical input and contract-version bump** — §3.4. Plus a two-version
   retention *regression test* (§4) — not a rule fix; the scoping already
   exists.
8. **Wire + `plan-infeasible` + TASK-221 copy** — §3.5's two schema additions
   with every tagged marker amended in the same commit, §3.3's state and
   payload, §3.6's revalidator clause, and the `Same project deadline …`
   rename with its tests.
9. **UI** — the Work item deadline cell, the `Late by N workdays` label, the
   `Plan infeasible · N work item deadlines` indicator.
10. **Gate** — corpus, cross-provider review, remote autotests.

## §7 Watched-red tests (the fault to inject is named)

Six, one per claim that a green suite would otherwise not defend:

1. **`lastWorkdayOf`'s `max` term dropped** in the deadline predicate (use
   `ceil(snapWorkdays(finish)) − 1` alone) → a zero-duration milestone starting
   at exactly offset `D + 1.0` must be reported **on time**, which is wrong.
2. **`finishUnits <= (D + 1) × quantum`** substituted for
   `startUnits + max(durationUnits, 1) <= (D + 1) × quantum` in the solver model
   (§3.2) → the same milestone one day late must be admitted as feasible.
3. **`workdaysBetween` substituted for `deadlineOffsetOf`** (§1.3) → a Saturday
   deadline must grant two extra calendar days, and a pre-start deadline must
   silently become day zero.
4. **The ancestor fold folded with `max` instead of `min`** (§1.4) → a child
   dated earlier than its parent must be loosened to the parent's date.
5. **`infeasible` mapped onto `unknown`** in the status matrix (§3.5) → an
   infeasible plan must offer Retry.
6. **The seventh canonical-input argument omitted from the hash** (§3.4) → two
   plans differing only in a deadline must collide on one cache row, and the
   second must read the first's schedule.

Each is watched failing before the implementation lands, per AGENTS.md R5.

## §8 Review ledger (AC #5)

| Round | Head | Seat | Verdict | Artifact |
|---|---|---|---|---|
| Sol attempt | `80d7081f` | `openai/gpt-5.6-sol` | **refused** — 465 ms, "Codex agent harness cannot enforce this conversation's tool policy". 14th consecutive refusal on this box. | none |
| Gemini r1 | `80d7081f` | `bin/gemini-review.sh` (agy) | **failed** — exit 1 after 2 s, "Agent execution terminated due to error", zero verdict bytes | stderr only |
| Gemini r2 | `80d7081f` | `bin/gemini-review.sh` (agy) | **failed** — exit 1 after 3 s, identical | stderr only |
| 1 | `80d7081f` | `anthropic/claude-fable-5` (AGENTS.md fallback) | **REQUEST CHANGES** — 2 Critical / 3 Important / 1 Minor | `queue/reviews/t240-planning-peer-r1.txt`, verified, 13259 bytes, sha256 `bc5bf80a` |
| 2 | `b1858308` | `anthropic/claude-fable-5` | **APPROVE WITH CHANGES** — 0 Critical / 2 Important / 1 Minor; every round-1 Critical confirmed closed against source | `queue/reviews/t240-planning-peer-r2.txt`, verified, 8942 bytes, sha256 `ffedb755` |
| 3 | `bb6cca3f` | `anthropic/claude-fable-5` | **APPROVE WITH CHANGES** — 0 Critical / 1 Important / 2 Minor, all three closed at `6d4a` below | `queue/reviews/t240-planning-peer-r3.txt`, verified, 7724 bytes, sha256 `9b29c15c` |

**Rounds 2–3 dispositions.** r2 found two Importants, both true: (I1) the r1
disposition of I3 "corrected" a true statement into a false one — `git ls-tree`
shows no `libs/contracts/solver/` subtree at all, and the claim came from
reading `libs/contracts/`'s own listing and attributing it to a child; (I2)
8.7b's site 5 pointed at a DTO paragraph the workspace note does not contain,
sending an implementer at the review-ledger rows that 7.2b in the same document
forbids amending — re-pointed at note §3.2's self-declared authoritative
event/state table. r3 confirmed both closed and found one more: the sentence
rewritten to close I2(b) shipped its own false count ("both misses" where there
are three, dropping site 5 — the very site the item exists to protect), leaving
`tasks.md` and the spec delta numerically contradicting each other. Corrected.

**Four false counting claims in four rounds** — r1-M1, r2-I2(b), r2-I1's
directory listing, r3's "both". Every one was a claim *about* these artifacts
rather than a claim *in* them, and every one was found by re-reading source
rather than by re-reading the text. That pattern is the finding: in this
document, a sentence counting or locating something is the sentence most likely
to be wrong, and it does not announce itself.


**Round-1 dispositions.** Every finding was verified at the cited source before
being acted on, never on the seat's word.

| # | Finding | Verified | Closed at |
|---|---|---|---|
| C1 | Retention is *already* scoped to contract version; this note's "existing latent defect" is false and its added requirement duplicates one that exists | **true** — the rule reads "delete every cache row of that project *for that contract version*" and retains per `(projectId, objective, contractVersion, inputHash)`; the draft had quoted the requirement's unscoped **title** | `b1858308` — claim and requirement deleted, two-version survival kept as a regression test |
| C2 | Unqualified "INFEASIBLE → `plan-infeasible`" contradicts the standing "`invalid-output` at **any** stage" rule and would cache a later-stage engine failure as an unretryable "your deadlines cannot be met" | **true** — deadlines enter at stage 1, so only the first-stage case changes; a later-stage `INFEASIBLE` is still impossible on a correct engine and carries no offending-item certificate to name | `b1858308` — first-stage only, standing clause + stage-status matrix added to the same-commit amendment list |
| I1 | The two normative lines mandating `Same deadline + …` are not scheduled for amendment; 8.9 covers shipped UI copy, not spec text | **true** | `b1858308` — `tasks.md` 8.9b |
| I2 | `plan-infeasible`'s integration surface: (a) the `status` CHECK constraints, (b) the Retry endpoint's answer, (c) the seventh `VariantState` member | **true**; (b) and (c) were already closed at `01c2b534`, one commit before the review published | (a) `b1858308` 8.5c; (b)(c) `01c2b534` 8.7b–8.7d |
| I3 | Slices 7–8 assert a cache and a wire that do not exist at this head, so W2/W5/W6 have no owner | **true, and the seat's evidence was right**: `git ls-tree` shows no `libs/contracts/solver/` subtree at all. My r1 disposition "corrected" this by reading `libs/contracts/`'s own listing and attributing it to a child — a false verified-at-source claim, caught by r2 | `b1858308` owner table; evidence corrected in r2 |
| M1 | The six-argument sweep greps for a phrase three of the four artifacts do not contain | **true**, found independently by this run | `cd919082` — four-location table + 7.2b protecting the ledger row |

Two of the six (M1, and I2's (b) and (c)) were found and closed by this run
before the seat reported them; the seat found four this run had not, two of them
Critical, and C1 is a claim this design asserted about source that the source
contradicts.

Required: one-shot Sol (`openai/gpt-5.6-sol`) with explicit
`anthropic/claude-fable-5` fallback, plus the Gemini seat
(`bin/gemini-review.sh`, arg 4 = the reviewed worktree). Both publish through
`bin/review-artifact.mjs`; a returned summary is not a verdict. **The Gemini
seat failed twice at 2–3 s with zero output — the same failure lanes c and f
both recorded on 2026-09-03, so it is down box-wide rather than mis-called. It
is recorded as missing, never bought with a metered model.**
