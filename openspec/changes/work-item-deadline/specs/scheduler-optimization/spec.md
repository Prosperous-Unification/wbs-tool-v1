## ADDED Requirements

### Requirement: A work item carries one nullable date-only deadline under one name

Any work item, leaf or parent, SHALL carry an optional constraint named `deadline`: nullable, date-only `IsoDate` (`YYYY-MM-DD`), with no time-of-day and no timezone. `null` SHALL mean "no deadline" and SHALL be the value of every work item that exists before this change. The name `deadline` SHALL be used in the domain argument, the database column, the API field, the canonical scheduling input, the event payloads and the solver wire; the UI SHALL label it **Work item deadline**. No alias — `finishNoLaterThan`, `dueDate`, `targetDate`, `endBy` — SHALL be introduced anywhere.

The existing start floor SHALL NOT be renamed by this change: its column stays `work_item.start_no_earlier_than` and its domain argument stays `notBefore`, and that two-names-for-one-fact asymmetry is out of scope rather than a prerequisite.

#### Scenario: a parent work item accepts a deadline

- **GIVEN** a parent work item with three leaves beneath it
- **WHEN** a deadline of `2026-10-09` is set on the parent
- **THEN** the value is stored on the parent itself and no leaf row is rewritten

#### Scenario: existing work items are unconstrained

- **GIVEN** a project created before this change
- **WHEN** it is read after the migration
- **THEN** every work item reports `deadline: null` and its schedule is byte-identical to the schedule it produced before

### Requirement: The deadline is inclusive against the displayed End date

A work item with `deadline: D` MAY finish **on** `D`. The normative predicate SHALL be stated against the same arithmetic that produces the End date the product already prints (`endsOn = addWorkdays(project.startDate, lastWorkdayOf(earliestStart, earliestFinish))`):

```
lastWorkdayOf(start, finish) <= deadlineOffset
```

and SHALL NOT be stated as `finish <= deadline`, which is only its informal form. `lastWorkdayOf(start, finish) = max(firstWorkdayOf(start), ceil(snapWorkdays(finish)) − 1)`; the `max` term is load-bearing and SHALL NOT be dropped. Every artifact — Fast, the solver model, the revalidator, the lateness label — SHALL derive from this one predicate rather than restating an equivalent of it.

#### Scenario: finishing on the deadline day is on time

- **GIVEN** a slice whose last workday is offset 12 and an effective deadline offset of 12
- **WHEN** the schedule is evaluated
- **THEN** the slice is on time and carries no lateness label

#### Scenario: the number on screen and the predicate agree

- **GIVEN** any slice reported as late
- **WHEN** its End date column and its lateness label are read
- **THEN** both are computed from `lastWorkdayOf` in the same domain, so a slice can never print an End date on or before its deadline while also being labelled late

### Requirement: deadlineOffsetOf converts a ceiling and rolls backward

`libs/domain/src/workday.ts` SHALL gain a new converter

```
deadlineOffsetOf(projectStart: IsoDate, deadline: IsoDate):
  | { kind: 'offset'; offset: number }
  | { kind: 'before-project-start' }
```

together with a `previousWorkday` export beside the existing `nextWorkday`. A deadline falling on a non-working date SHALL roll **backward** to the previous workday. A deadline resolving before day zero — `addWorkdays(projectStart, 0)`, which is `nextWorkday(projectStart)` and not `projectStart` itself — SHALL return the typed `before-project-start` rather than a number.

`workdaysBetween` SHALL NOT be reused for this conversion. It rolls a non-working date **forward** via `nextWorkday`, which relaxes a ceiling by up to two calendar days, and it clamps a `to` earlier than `from` to `0`, which for a ceiling is the strictest possible deadline silently substituted for the user's input. Both behaviours are safe for the floor they were written for and unsafe in this direction.

The property test that equates `addWorkdays` and `workdaysBetween` SHALL gain its mirror: for every workday `s` and every offset `k`, `deadlineOffsetOf(s, addWorkdays(s, k))` is `{ kind: 'offset', offset: k }`.

#### Scenario: a weekend deadline resolves to the preceding Friday

- **GIVEN** a project whose working week excludes Saturday and Sunday
- **WHEN** a deadline of Saturday the 10th is converted
- **THEN** the offset is Friday the 9th's offset, and never Monday the 12th's

#### Scenario: a pre-project deadline is typed, not clamped

- **GIVEN** a deadline resolving before day zero
- **WHEN** it is converted
- **THEN** the result is `{ kind: 'before-project-start' }` and is never the number `0`

### Requirement: The effective deadline is the earliest applicable ancestor date

The **effective deadline** of a leaf SHALL be the minimum of its own deadline and every ancestor's, and `null` where neither the leaf nor any ancestor carries one:

```
effective(leaf) = min over { deadline(n) | n = leaf or n is an ancestor of leaf, deadline(n) ≠ null }
```

Earliest applicable SHALL win unconditionally: a parent dated earlier tightens a child dated later, and a child dated earlier is NOT loosened by a later parent. This mirrors the floor's expansion — "each leaf takes the **latest** of its own floor and every ancestor's" — with `latest` replaced by `earliest`; the two folds SHALL NOT be collapsed into one direction-parameterised function, because their out-of-range clamps differ and are not shared.

A parent's deadline constrains the latest finish anywhere in its subtree, and SHALL be realised as the effective deadline applying to **every slice** of every work item in scope rather than to a computed subtree maximum. The two are equivalent because intra-item step order is a precedence chain whose given order is the precedence, so a work item's last slice holds its maximum finish and a subtree's maximum finish is the maximum over its leaves' last slices. The per-slice form is normative because a CP-SAT constraint and a Bun revalidator can both state it without materialising a subtree aggregate; a leaf's own deadline therefore reduces to "constrains its last slice" rather than being a second rule.

#### Scenario: a parent tightens a later child

- **GIVEN** a parent with `deadline: 2026-10-05` and a child with `deadline: 2026-10-20`
- **WHEN** the effective deadline of the child's leaf is folded
- **THEN** it is `2026-10-05`

#### Scenario: a later parent does not loosen an earlier child

- **GIVEN** a parent with `deadline: 2026-10-20` and a child with `deadline: 2026-10-05`
- **WHEN** the effective deadline of the child's leaf is folded
- **THEN** it is `2026-10-05`

#### Scenario: an empty subtree constrains nothing

- **GIVEN** a parent with a deadline and no leaves beneath it
- **WHEN** the fold runs
- **THEN** no constraint is emitted, no infeasibility can arise from that parent, it is not an error, and the row still displays its Work item deadline

#### Scenario: deleting a subtree does not rewrite the parent's input

- **GIVEN** a parent with a deadline whose entire subtree is deleted
- **WHEN** the deletion commits
- **THEN** the parent keeps its stored deadline

### Requirement: Zero-duration work sits inside its own day

A slice with `days: 0`, or an unestimated slice resolved to zero, has `finish === start`. Its last workday SHALL be `max(firstWorkdayOf(start), ceil(snapWorkdays(start)) − 1)`, so a zero-duration slice is on its deadline **iff the day it sits in is at or before the deadline day**. The naive `finish <= deadline` form SHALL NOT be used, because it reports a milestone at the very start of the day after its deadline as on time.

#### Scenario: a milestone at an exact day boundary occupies that day

- **GIVEN** a zero-duration slice starting at exactly offset `3.0`
- **WHEN** its last workday is computed
- **THEN** it is `3` — the `firstWorkdayOf` term — and not `ceil(3) − 1 = 2`

#### Scenario: a milestone one day late is late

- **GIVEN** a zero-duration slice starting at exactly offset `D + 1.0` with effective deadline offset `D`
- **WHEN** the schedule is evaluated
- **THEN** the slice is reported late by 1 workday

### Requirement: A deadline never moves work earlier and never overrides a floor

`schedule()`'s existing floor, priority, reach, capacity and person semantics SHALL be unchanged. A deadline SHALL NOT move work earlier than it would otherwise start and SHALL NOT override a start floor. Where a floor and a deadline contradict, the floor SHALL still win the placement and the plan SHALL be reported late (Fast) or infeasible (PRI/Time). A deadline is a constraint on the outcome, never a scheduling instruction.

#### Scenario: a floor beyond a deadline still places the work

- **GIVEN** a leaf whose start floor is later than its effective deadline
- **WHEN** Fast schedules it
- **THEN** the slice starts at its floor and carries a lateness label; it is not pulled earlier

### Requirement: Deadlines are stored, written and revised as an ordinary work-item field

`work_item.deadline TEXT NULL` SHALL be added beside `start_no_earlier_than` with a forward migration under `apps/be-01/drizzle/`. No reason column SHALL be added; the floor's `start_no_earlier_than_reason` has no deadline counterpart in this change.

`deadline` SHALL join the existing work-item PATCH payload as a nullable `IsoDate`, validated at the write boundary before any scheduler runs:

- a value that is not an `IsoDate` SHALL be rejected `422` through the existing malformed-payload path;
- a value for which `deadlineOffsetOf` returns `before-project-start` SHALL be rejected `422` naming the offending work item and the project's day zero, and this SHALL be the only deadline-specific rejection;
- `null` SHALL clear it.

Authorization SHALL be the existing work-item write authorization; a deadline is not a project setting and adds no new authority. `deadline` SHALL ride the existing work-item update event and the existing undo stack, with **no new event type and no new undo verb**: setting and clearing are ordinary field edits, so redo of a clear restores `null` and redo of a set restores the date with no special case.

#### Scenario: a pre-project-start deadline is rejected at the boundary

- **GIVEN** a PATCH setting a deadline that resolves before the project's day zero
- **WHEN** the request is handled
- **THEN** it is rejected `422` naming the work item and day zero, no scheduler runs, and no cache row is written

#### Scenario: undo of a cleared deadline restores the date

- **GIVEN** a work item whose deadline was cleared to `null`
- **WHEN** the edit is undone and redone
- **THEN** the date returns and is cleared again through the ordinary field-edit path, with no deadline-specific undo verb

### Requirement: A project start moved past a stored deadline is unmeetable, not invalid

Moving a project's `startDate` later than a stored deadline SHALL be legal and SHALL NOT retro-reject or rewrite the stored value. The effective deadline for that item SHALL resolve to `before-project-start` **at read time** and SHALL be treated as *unmeetable* rather than *invalid*: Fast SHALL report it late by the whole span and PRI/Time SHALL report `plan-infeasible` naming it. The row SHALL continue to display its Work item deadline with the existing "impossible" affordance and SHALL NOT be silently dropped, because rejecting it would delete user data on an unrelated edit.

#### Scenario: the stored date survives a project move

- **GIVEN** a work item with `deadline: 2026-10-09` and a project start moved to `2026-11-01`
- **WHEN** the project is read
- **THEN** the work item still reports `deadline: 2026-10-09`, the row shows the impossible affordance, and the optimized variants report `plan-infeasible` naming it

### Requirement: Fast orders by slack and reports lateness, and stays best-effort

Fast SHALL remain immediate, single-pass and best-effort. Among ready slices it SHALL order by **minimum slack** — the effective deadline offset minus the earliest finish the slice could take — then by **earliest effective deadline**, and only then by the existing priority tie-breaks, which are otherwise untouched. Slices with no effective deadline SHALL sort after every slice that has one, holding their existing priority position relative to each other. This is a tie-break refinement and NOT a new objective: Fast SHALL still never backtrack and SHALL still never move work earlier than its floor.

Each slice whose effective deadline is missed SHALL carry `Late by N workdays`, where `N = lastWorkdayOf(start, finish) − deadlineOffset` and `N >= 1` when late. `N` SHALL be whole **workdays**, computed in the same domain as the inclusive predicate so the number on screen and the predicate that decided lateness cannot disagree, and the copy SHALL say workdays.

#### Scenario: slack precedes the existing priority tie-breaks

- **GIVEN** two ready slices of equal priority, one with 1 workday of slack and one with 6
- **WHEN** Fast selects the next slice
- **THEN** the 1-workday-slack slice is selected first

#### Scenario: undeadlined work keeps its relative priority order

- **GIVEN** three ready slices with no effective deadline and distinct priorities
- **WHEN** Fast orders them
- **THEN** they appear after every deadlined slice and in their existing priority order relative to each other

#### Scenario: a missed deadline is labelled in workdays

- **GIVEN** a slice whose last workday is offset 15 against an effective deadline offset of 12
- **WHEN** the schedule is published
- **THEN** the slice carries `Late by 3 workdays`

### Requirement: A missed Fast deadline is never presented as a satisfied optimized baseline

The comparison indicator SHALL NOT read Fast's late plan as a feasible baseline. When Fast is late on any item and the selected optimized variant is feasible, the indicator SHALL show the optimized result and the lateness SHALL belong to Fast alone. When the selected optimized variant is `plan-infeasible`, the indicator SHALL read `Plan infeasible · N work item deadlines` while Fast stays on screen and stays labelled late per item; it SHALL NOT fall back to presenting Fast as satisfying the deadlines. Fast's lateness is a report, never a verdict of feasibility.

#### Scenario: an infeasible optimized variant does not promote Fast

- **GIVEN** Fast is late on two items and the selected optimized variant returned `plan-infeasible`
- **WHEN** the comparison indicator renders
- **THEN** it reads `Plan infeasible · 2 work item deadlines` and never `Same project deadline + same order`

### Requirement: PRI and Time treat every effective deadline as a hard constraint

Both optimized objectives SHALL add every effective deadline to the model as a **hard constraint**, before the objective terms and independent of them. It SHALL NOT be a penalty, a soft term or a lexicographic stage: a plan violating any effective deadline is not in the feasible set. Per slice `s` with effective deadline offset `D` the constraint SHALL be

```
startUnits(s) + max(durationUnits(s), 1) <= (D + 1) × quantum
```

where `(D + 1) × quantum` is the first instant of the day after the deadline day, so the constraint reads exactly "the work occupies no instant of any later day". `finishUnits <= (D + 1) × quantum` SHALL NOT be substituted: it passes every non-zero-duration fixture and admits a zero-duration milestone one day late.

#### Scenario: a zero-duration milestone is held inside its deadline day

- **GIVEN** a milestone with `durationUnits = 0` and effective deadline offset `D`
- **WHEN** the model is built
- **THEN** `max(durationUnits, 1)` forces it to start strictly before `(D + 1) × quantum`, so a start on day `D + 1` is infeasible

### Requirement: plan-infeasible is a typed cached state, not an engine failure

CP-SAT returning `INFEASIBLE` **at the first stage** of staged lexicographic optimization SHALL be recorded as `plan-infeasible`, a first-class variant state beside `ok` and `failed` in the stored state machine. It SHALL NOT reach the `Optimization unavailable · Retry` indicator, because retrying is guaranteed to produce the same answer.

**The stage qualifier is load-bearing and SHALL NOT be dropped.** The existing rule this change amends says `INFEASIBLE` SHALL be `invalid-output` **at any stage**, reasoning that Fast found a placement for the same graph and every constraint a later stage adds is satisfied by the previous incumbent. Deadlines enter the model *before* the objective terms, so they are present at stage 1 — which is what makes a first-stage `INFEASIBLE` a genuine statement about the user's deadlines and the one case the old blanket rule now over-covers. A **later-stage** `INFEASIBLE` remains impossible on a correct engine for exactly the original reason — the previous incumbent already satisfies every effective deadline and every bound added since — so it SHALL remain `invalid-output`. It also could not honour the payload contract below: a later-stage `INFEASIBLE` carries no offending-work-item certificate to name.

The existing "at any stage" clause and the stage-status matrix SHALL therefore be amended in the **same commit** that introduces `plan-infeasible`, with the same land-together rigour the wire markers get. An unqualified new rule merged against an unamended old one leaves two requirements mandating opposite outcomes for one solver status, and if the new one wins, a later-stage engine failure is cached as "your deadlines cannot be met", with no Retry, at the moment the solver's own previous stage proved a deadline-satisfying schedule exists.

`plan-infeasible` SHALL:

- carry a payload naming every offending work item and its **effective** deadline — the effective one, so a leaf bound by an ancestor's date shows the date that actually bound it rather than sending the user to edit a field that changes nothing — with each entry carrying both the work item that **owns** the binding date and the work item the constraint **fell on**, which are the same id when it is a leaf's own;
- be cached exactly like `ok` and under an identical key, because it is a deterministic function of the input, while not suppressing a new hash's generation;
- never auto-respawn, the same rule a `failed` row carries;
- render as `Plan infeasible · N work item deadlines` with the offending items listed on demand, Fast still on screen and usable, and no toast and no modal.

Malformed or invalid solver output SHALL remain `invalid-output` and an **engine failure**: an unparseable line, an unknown status, a missing or unknown offset key, any offset failing Bun revalidation, and — specifically — a *feasible* schedule that violates an effective deadline. A deadline-violating solver result is a broken engine, never an infeasible plan.

#### Scenario: a later-stage INFEASIBLE stays an engine failure

- **GIVEN** a staged solve whose first stage returned a feasible incumbent and whose third stage returns `INFEASIBLE`
- **WHEN** the outcome is classified
- **THEN** it is `invalid-output`, not `plan-infeasible`, because the incumbent already satisfies every effective deadline and every bound added since

#### Scenario: an infeasible plan offers no Retry

- **GIVEN** a variant stored as `plan-infeasible`
- **WHEN** the indicator renders
- **THEN** it reads `Plan infeasible · N work item deadlines` and exposes no Retry affordance

#### Scenario: the payload names the binding ancestor's date

- **GIVEN** a leaf with `deadline: 2026-10-20` beneath a parent with `deadline: 2026-10-05`, infeasible at the parent's date
- **WHEN** the payload is read
- **THEN** the entry reports the effective deadline `2026-10-05`, the parent as the owner of the binding date, and the leaf as the item the constraint fell on

#### Scenario: a deadline-violating solver result is an engine failure

- **GIVEN** a solver returning status `optimal` with a slice finishing after its effective deadline
- **WHEN** the coordinator revalidates it
- **THEN** the result is stored as `invalid-output`, not as `plan-infeasible`

### Requirement: plan-infeasible becomes the seventh VariantState in every artifact that enumerates it

`plan-infeasible` is two things at two layers and SHALL be specified as both, because they are distinct and conflating them is how the previous member was half-added:

- a **stored row status**, beside `ok` and `failed`. It SHALL NOT be an `ok` row carrying an infeasible payload: `corrupt` is already defined as "an `ok` row whose `resultJson` fails to decode", so an `ok` row that is deliberately not a schedule would be indistinguishable from a decoder fault at exactly the point the two must be told apart.
- a **seventh member of the `VariantState` union** returned by the plan read, beside `ready`, `pending`, `retrying`, `failed`, `corrupt` and `idle`.

That union is declared **the one authority** and is enumerated in five places. All five SHALL be amended in the **same commit**:

| # | Location | Form |
|---|---|---|
| 1 | `dual-optimized-scheduler/design.md`, the plan-read DTO bullet | the authoritative `VariantState` list |
| 2 | `dual-optimized-scheduler/specs/scheduler-optimization/spec.md`, the plan-read requirement | the normative "SHALL be one of" |
| 3 | `dual-optimized-scheduler/tasks.md` 7.10 | "one of six", **and** its proof-state list |
| 4 | `dual-optimized-scheduler/tasks.md` 8.3–8.4 | the UI rendered-states list |
| 5 | `notes/wbs-dual-optimized-scheduler-design.md` §3.2 | the event/state table that section declares authoritative — **not** its review-ledger rows, which are protected history |

This is not a caution. Adding `corrupt` updated location 2 and left 1, 3 and 4 at five members, which shipped as a Critical; the two rounds before it found the same divergence in other fields. A partial amendment here repeats it a third time, and the count word "six" occurs in only two of the five — locations 1 and 3 — so a text search for it misses three sites, including two an implementer edits. Search for the member names.

`plan-infeasible` SHALL also be added to the Retry endpoint's refusal path. Retry accepts `failed` or `corrupt`; every other state returns one code, `409 not-retryable`, naming the state. `plan-infeasible` SHALL take that path rather than being accepted, because re-solving an unchanged input is guaranteed to return the same proof — the UI showing no Retry affordance is not sufficient, since the route is reachable without the UI.

#### Scenario: the union is amended everywhere or the change is incomplete

- **GIVEN** `plan-infeasible` added to the plan-read requirement alone
- **WHEN** the artifacts are compared
- **THEN** the four remaining enumerations still list six members and the change is incomplete, exactly as the five-member divergence was

#### Scenario: Retry refuses an infeasible variant

- **GIVEN** a variant stored `plan-infeasible`
- **WHEN** `POST /api/projects/:projectId/optimization/retry` is called for it directly
- **THEN** it returns `409 not-retryable` naming the state, and no solver process starts

#### Scenario: an infeasible row is not a corrupt row

- **GIVEN** a variant stored `plan-infeasible` and a variant stored as an `ok` row whose `resultJson` fails to decode
- **WHEN** the plan read resolves both
- **THEN** the first is `plan-infeasible` and the second is `corrupt`, and neither is reported as the other

### Requirement: The canonical scheduling input gains a seventh argument and bumps the contract version

The canonical input is the exact argument tuple of `schedule()`, which SHALL become

```
schedule(rows, edges, slices, notBefore, poolSizes, reach, deadlines)
```

`deadlines: ReadonlyMap<string, number>` SHALL hold `[workItemId, deadlineOffset]` entries **sorted by id**, with offsets already resolved by `deadlineOffsetOf` against `project.startDate` into whole workdays from day zero, exactly as `notBefore` entries are. Keys SHALL be **as-authored work item ids and SHALL NOT be pre-expanded to leaves**: the ancestor fold is derived, and hashing the expansion would hide a parent's deadline edit that binds no leaf today and binds one after a move — the same argument the contract already makes for hashing `priority` as written.

`SCHEDULER_CONTRACT_VERSION` SHALL be bumped in the same change, because the canonical input, the wire and the materialiser all change and every pre-existing cache row describes a different function. The bump SHALL be the eviction mechanism; there SHALL be no data migration of cached results. Every "six arguments" and "all six" phrasing in the dual-scheduler design note, its OpenSpec design and its spec delta SHALL be amended in the same commit. The Fast golden corpus, being keyed on `SCHEDULER_CONTRACT_VERSION`, SHALL be re-keyed in that commit, and every existing corpus case SHALL produce a **byte-identical** schedule under the seventh argument defaulted to an empty map.

`deadline` SHALL NOT become a new cache-key dimension: it lives inside the input hash like every other input, and objective, contract version and budget remain the only key dimensions beside `(projectId, inputHash)`.

#### Scenario: two plans differing only in a deadline do not share a cache row

- **GIVEN** two otherwise identical plans, one with a deadline on a work item and one without
- **WHEN** both are hashed
- **THEN** the hashes differ and neither reads the other's cached schedule

#### Scenario: a parent deadline binding no leaf today still rehashes

- **GIVEN** a parent with no leaves beneath it that is given a deadline
- **WHEN** the canonical input is built
- **THEN** the as-authored entry is present and the hash changes, even though the fold emits no constraint

#### Scenario: the Fast corpus is unchanged under an empty deadline map

- **GIVEN** every case in the Fast golden corpus
- **WHEN** each is scheduled with the seventh argument defaulted to an empty map
- **THEN** each produces a byte-identical schedule to the one recorded before this change

### Requirement: The solver wire gains a per-slice deadline and an infeasible status

`libs/contracts/solver/solver-wire.v1.json` SHALL remain the single normative definition of the wire, and prose SHALL NOT restate its field lists. Two additions:

- per slice, **`deadlineUnits`**: `integer | null`, in the same units as `notBeforeUnits`, `horizonUnits` and every returned offset. It SHALL be the **effective** deadline for that slice, already folded and already converted to `(D + 1) × quantum`, so Python applies the constraint without seeing the tree — exactly as it already never sees `reach`. `null` SHALL mean unconstrained.
- response **`status: infeasible`** SHALL join the stage-status matrix as a first-class outcome, distinct from `unknown` and SHALL NOT be mapped onto it: `unknown` is budget exhausted with no proof and may become feasible with more budget, `infeasible` never will.

`horizonUnits` SHALL be unchanged, remaining `max(0, ...notBeforeUnits) + Σ durationUnits`. It SHALL NOT be tightened to the latest deadline, which would make an infeasible plan indistinguishable from a horizon overflow and would remove the serial fallback that makes the bound provably safe.

Because the repository check compares every tagged enumeration in the planning files against the schema's own `required` sets and fails on the symmetric difference, every `<!-- wire-fields:slice -->` and `<!-- wire-fields:response -->` marker SHALL be amended in the **same commit** as the schema; a partial edit is a red gate by design.

#### Scenario: infeasible is not degraded to unknown

- **GIVEN** a solver response with `status: infeasible`
- **WHEN** the stage-status matrix maps it
- **THEN** it becomes the stored `plan-infeasible` state and never the `unknown` budget-exhausted path

#### Scenario: a schema edit without its markers fails the gate

- **GIVEN** `deadlineUnits` added to the wire schema with the `wire-fields:slice` markers left unamended
- **WHEN** the repository enumeration check runs
- **THEN** it fails on the symmetric difference

### Requirement: Bun-side revalidation checks the deadline in the real domain

The coordinator's independent revalidation SHALL gain one clause, stated on the materialised schedule in the **real fractional domain** and not in quantised units:

> for every slice, `lastWorkdayOf(start, finish) <= effectiveDeadlineOffset`

Checking it in units would re-implement the rounding a second time and could disagree with what the End date column prints — the same argument the contract already makes for comparing `sameOrder` in the real domain. A violation SHALL be `invalid-output`.

`materialiseOptimized` SHALL NOT change: it pins the optimized starts and replays Fast's annotation pass, and a deadline changes no annotation. The `ScheduleFloor` union SHALL NOT be extended — a deadline never *causes* a start, so nothing is ever `boundBy: 'deadline'`, and adding such a member would be a category error.

#### Scenario: the revalidator disagrees with the solver

- **GIVEN** a solver result that satisfies its own quantised constraint but whose materialised slice has `lastWorkdayOf(start, finish)` one greater than its effective deadline offset
- **WHEN** the coordinator revalidates
- **THEN** the result is rejected as `invalid-output` and is not stored as `ok`

### Requirement: The deadline migration is additive and its rollback boundary is the application, not the schema

The forward migration SHALL be one additive nullable column plus the contract-version bump: every existing row reads `null`, every existing plan schedules identically, and every existing cache row is evicted by the bump rather than read under a contract it does not satisfy. Rolling back the **application** while the column exists SHALL be safe — the old code selects a column list that does not name `deadline`, the values sit unread, and the old contract version keys a disjoint set of cache rows. Rolling back the **migration** drops user data and SHALL NOT be a supported operation; the blue/green swap therefore runs the migration first and the application second, which is the existing order.

This change SHALL NOT restate or re-own cache retention. Retention is already scoped to the writing contract version by the existing rule — "allocating a new generation SHALL delete every cache row of that project **for that contract version**", retaining per `(projectId, objective, contractVersion, inputHash)` — so a blue/green swap's two versions already read and write disjoint rows and neither evicts the other's. An earlier draft of this change called that an existing latent defect and added a second retention requirement; both were wrong, and a second requirement owning one behaviour is the cross-artifact divergence these artifacts have paid for repeatedly. What survives is a **regression test**, not a rule.

#### Scenario: a swap does not evict the peer's cache rows

- **GIVEN** blue at contract version `4+v1` and green at `5+v1` against one SQLite file
- **WHEN** each writes a validated result for the same project generation
- **THEN** each retains its own contract version's rows and neither evicts the other's, under the retention rule as it already stands

### Requirement: Project deadline and Work item deadline are distinguished in copy

The schedule comparison indicator's project-finish strings SHALL be renamed from `Same deadline + reordered` and `Same deadline + same order` to `Same project deadline + reordered` and `Same project deadline + same order`. The per-item constraint SHALL always be written **Work item deadline**. Shipping an unqualified "Same deadline" beside a per-item deadline is the ambiguity this rename exists to prevent, so the rename SHALL land with this change rather than as a follow-up.

#### Scenario: the comparison indicator names the project finish date

- **GIVEN** an optimized variant finishing on the same date as Fast with a different order
- **WHEN** the indicator renders
- **THEN** it reads `Same project deadline + reordered`

#### Scenario: no unqualified deadline copy remains

- **GIVEN** the shipped UI strings
- **WHEN** they are searched for the word "deadline"
- **THEN** every occurrence is qualified as either **Project deadline** or **Work item deadline**
