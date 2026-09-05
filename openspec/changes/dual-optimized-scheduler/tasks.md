# Tasks — dual-objective optimized scheduler

TDD slices for the change described in `proposal.md`, `design.md` and
`specs/scheduler-optimization/spec.md`. Every slice names the test that proves
it; every safety check names the negative test watched failing with the check
removed (R5). Nothing here is implemented yet — this is the plan TASK-218
delivers, and implementation lands as its own queue tasks.

**Order matters, and there is no corrections appendix.** A later review's
disposition is folded into the slice it changes and the superseded text is
deleted, never appended as a new section — an appendix leaves the old
instruction standing as an earlier ordered checklist item, which is exactly the
fault Sol r7 Critical 4 and 5 named. Slices 1–3 are the seam. Slices 4–7 are behaviour. Slice 8
is the UI. Slice 9 is the corpus. A slice is not done until its remote gate on
h2puni is green — no build or autotest runs on the workspace box.

## 1. Canonical input and the exact-input hash

**Whose seventh argument this is — settled here so two queue tasks cannot both
build it or both skip it.** The dependency chain is TASK-219 (this change)
→ TASK-220 → **TASK-241** (`wbs-deadline-scheduling-core`), and TASK-241's own
description claims "include deadlines in the canonical hash and versioned solver
wire, revalidate them independently in Bun, and persist/report legitimate
plan-infeasible results". Read naively that is the same work as slices 1, 2 and
4 here, by a task that cannot start until they are done. The split is by
**plumbing versus field**:

- **TASK-219 builds the seventh argument's plumbing and every consumer of it**
  — the canonical entry, the hash, the `deadlineUnits` wire field, the CP-SAT
  constraint, the Bun revalidation clause, the `plan-infeasible` row state and
  its `VariantState` member — against a deadline **source that is legitimately
  empty**, because the `deadline` column and `deadlineOffsetOf` do not exist
  yet. That is not a stub: 1.6's no-op proof _requires_ the seventh argument
  defaulted to an empty map to leave every golden corpus case byte-identical,
  so the empty-source state is the proved state rather than a placeholder.
- **TASK-241 adds the field and populates the source** — the nullable
  date-only `deadline`, its migration, API, realtime, undo, `deadlineOffsetOf`,
  the §1.4 effective-deadline fold and Fast's minimum-slack ordering — and
  turns on every path TASK-219 already built and gated.

Consequence for 1.3: the tie-sensitive deadline mutation case is TASK-241's to
make green, because it needs a real deadline to mutate. TASK-219 lands it as a
**declared-pending** case naming TASK-241, never as a silently skipped or
trivially-passing one — a mutation case with no mutation is exactly the
check-that-cannot-fail failure R5 names.

- [x] 1.1 `canonicalScheduleInput(plan)` builds the canonical JSON string,
      living beside Fast in `libs/domain/src/` so both read one normalizer —
      Fast is `libs/domain/src/schedule.ts`, not `apps/be-01/src/service/`.
      **The canonical form is the exact argument tuple of
      `schedule(rows, edges, slices, notBefore, poolSizes, reach, deadlines)`:**
      (a) every `PlannedRow` sorted by `id` with `id`, `parentId`, `position`,
      `frozenNumber` and its **as-written** `priority` — not the resolved leaf
      priority, so a parent's edit that changes no leaf today still rehashes;
      (b) authored `{ predecessorId, successorId }` edges sorted by the pair,
      with the leaf expansion derived rather than hashed;
      (c) the `slices` array **grouped by work item, groups ordered by
      `workItemId`, each group's own order preserved as given** — only the
      intra-item order is step precedence; the global order is whatever SQL
      returned, because `WorkItemRepo.listByProject` selects with no
      `ORDER BY` and `slicesOf` emits groups in row order, so hashing it made
      one unchanged project hash differently between reads and between blue
      and green — each
      slice carrying `workItemId`, `stepId`, `days` (null distinct from 0),
      `personId`, `width`, and `poolIds` as a **sorted set** (`readonly
string[]`, never a singular `poolId`);
      (d) `notBefore` as `[workItemId, offsetDays]` sorted, already normalized
      against `project.startDate` into whole days from day zero;
      (e) `poolSizes` as `[poolId, size]` sorted;
      (f) `reach` from `project.dep_reach` (`whole-item | anchor-slice`);
      (g) `deadlines` as `[workItemId, deadlineOffset]` sorted by id, offsets
      already resolved by `deadlineOffsetOf` against `project.startDate` into
      whole workdays from day zero exactly as (d) is, and keyed by
      **as-authored** work item ids rather than the leaf expansion — the fold
      is derived, so hashing the expansion would hide a parent's deadline edit
      that binds no leaf today and binds one after a move, the same argument
      (a) makes for as-written `priority`
      (`openspec/changes/work-item-deadline/design.md` §3.4).
      Reuses the existing `sliceKey`/`indexTree`/`expandToLeaves` normalizers.
- [x] 1.2 `scheduleInputHash(plan)` = SHA-256 of 1.1.
- [x] 1.3 **Proven by** `schedule-input-hash.test.ts`, one **tie-sensitive**
      mutation case per canonical fact — each fixture is built so the mutated
      fact actually moves a placement, otherwise a hash that ignores it still
      passes. The cases are one per canonical fact. Estimate; edge; as-written
      priority on a parent; `width`; a `notBefore` floor; `personId`; pool size;
      **`depReach` flipped**; **two
      slices of one work item swapped**, **`poolIds` widened from one pool to
      two**, **a work-item `deadline` set on a parent that binds no leaf until
      a later move** (tie-sensitive because Fast's ready-slice ordering gains a
      minimum-slack then earliest-effective-deadline tie-break —
      `openspec/changes/work-item-deadline/design.md` §3.1 — so the mutation
      moves a real placement rather than only a solver constraint), and
      `position`/`frozenNumber` changed. Unchanged-hash cases:
      Engine, Objective, the toggle, the display variant, the clock, the acting
      user, and a plan-row reordering that yields the same tree. `budgetMs` and
      `contractVersion` are **not** hash inputs but **are** cache-key columns,
      proven in 4.2 rather than here.
      **Run 12 landed 1.1, 1.2 and 1.4 and the first half of this
      (`canonical-schedule-input.{ts,test.ts}`, 13 cases, domain 393/0 across 31
      files).** Every mutation case asserts **two** things — that the hash moved
      and what `schedule()` did about the same edit — because a string-only
      comparison can be wrong in either direction and only one of those
      directions produces a red. That second assertion earned itself
      immediately: the first fixture had `a -> b` as its only shape, so
      `notBefore` and pool size were both invisible behind the edge and the two
      cases came back with an identical schedule (391/2). A third leaf `c`,
      unblocked and on the same one-slot pool, is what gives them somewhere to
      show.
      **Three kinds, stated per case.** _Moves a placement:_ intra-item slice
      swap, `days` null vs 0, `depReach`, the `notBefore` floor above the
      predecessor, the pool grown to two slots. _Deliberately stricter than
      today's engine_ - hash moves, schedule identical: a parent's as-written
      priority that binds no leaf (every leaf carries its own, so
      `priorityByLeaf` never reaches it), and a `deadlines` entry, which
      `schedule()` has no parameter for yet. _Must not move the hash:_ the
      global slice order across work items, the `rows` array reordered into the
      same tree, `poolIds` reordered and de-duplicated.
      **The deadline case is declared-pending for TASK-241, not skipped.** It
      asserts what is true today - present in the string, inert in the engine -
      so when TASK-241 lands the field and the earliest-effective-deadline
      tie-break, its `toEqual` is the line that fails first and moves the case
      up to the mutation set.
      **Chunk 3 added four more, all proved:** `personId` (one person put on
      two slices on opposite sides of the plan's only edge), an estimate
      change, an authored edge added, and `position` — the last on a second
      base `TIED`, because `position` reaches a placement only through the
      number tie-break and every leaf in the main fixture carries its own
      priority. `TIED` is the corpus case `inverted-numbering-tie` in
      miniature. Domain **397 pass / 0 fail across 31 files**.
      **`width` and `frozenNumber` were written, run, and came back with a
      byte-identical schedule from their own `not.toEqual` (399 tests, 2 fail).
      Neither was checked in green; each was answered.**
      **`frozenNumber` landed in chunk 4, and it takes TWO anchors — a fact
      about `deriveNumbers`, probed directly rather than reasoned.** One anchor
      cannot reorder siblings at all: freeze `x` (position 20) at `005` and
      `deriveNumbers` **repairs the group around it** — `claimLabel` must place
      the earlier-positioned `y` below the anchor, `below('005')` gives `0045`,
      and the pair reads `y=0045, x=005`, the same relative order as the
      unfrozen `y=010, x=020`. A single frozen number renames siblings without
      reordering them. Two anchors that contradict `position` cannot be
      repaired, because neither may be rebuilt: `x`@20 frozen `005` and `y`@10
      frozen `010` come back verbatim and `x` now sorts first. Domain **398 pass
      / 0 fail across 31 files**.
      **`width` landed in chunk 5, on a third base `CHAINED` with NO pools at
      all** — that is what makes it a one-mutation-per-fact case. Against the
      main fixture it asked a one-slot pool for two slots and moved nothing;
      pool-free it reaches the schedule through `durationOf`'s `days / width`
      arm, so 4 days across a width of 2 is two and the successor starts at 2
      rather than 4. Domain **399 pass / 0 fail across 31 files**.
      **`poolIds` widened from one pool to two landed in run 13 chunk 1 and
      closes this item; its fourth base is `PARALLEL`.** It needs its own base for
      the same reason `width` did: every slice in `BASE` sits on the single pool
      `team`, so the only pool a second entry could name is one no slice holds,
      and a pool nobody queues for delays nothing — giving it an occupant would
      mean editing `poolSizes` and the slice list as well, three mutations in the
      case that exists to carry one. `PARALLEL` is two leaves, no edge, on
      **disjoint** one-slot pools `alpha` and `beta`, simultaneous in the base;
      widening `y` to hold `alpha` too puts both in one queue of one.
      **Measured, not reasoned** (`bun` probe against the gate checkout at
      `af03678e`): base `x` and `y` are both `0 → 2`,
      `waitingForCapacity: 0`; widened, `y` is `2 → 4` with
      `boundBy: "capacity"`, `capacityTeamId: "alpha"`,
      `capacityPredecessorIds: ["x\0"]` and `waitingForCapacity: 1`. Domain
      **400 pass / 0 fail across 31 files**. The remaining
      unchanged-hash cases - Engine, Objective, the toggle, the display variant,
      the clock, the acting user - are **structurally** excluded rather than
      untested: none of them is a member of `ScheduleInput`, so there is nothing
      to mutate. Recorded here so nobody reads their absence as an omission.
- [x] 1.4 **Negative check, watched red** — delete `reach` from the canonical
      string and watch 1.3's `depReach` case fail; repeat with the slice-array
      order flattened to a sorted set and watch the swap case fail. `Proof:`
      comment names each removed field. A hash that ignores a scheduling fact
      serves a stale schedule as current.
- [ ] 1.5 `SCHEDULER_CONTRACT_VERSION` exported from `libs/domain`, and
      `contractVersion = "<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"` built
      where the cache key is built. Documented as bumped by any change to Fast
      semantics, `ASSUMED_SLICE_WORKDAYS`, `snapWorkdays`, reach or numbering
      semantics, resource tie-breaks, the canonicalizer, or the duration rule.
      **This slice performs one such bump**, because the seventh canonical
      argument, the `deadlineUnits` wire field and the materialiser all change
      together: every pre-existing cache row describes a different function, and
      the bump is what evicts them — there is no data migration of cached
      results (`openspec/changes/work-item-deadline/design.md` §3.4).
      **Three of the four clauses are already satisfied, verified in run 13
      chunk 5 rather than assumed, and the fourth cannot be satisfied in this
      slice.** Done: the constant is exported from the barrel
      (`libs/domain/src/index.ts:8`, `export * from './contract-version'`); the
      bump list in `contract-version.ts` names every item this task asks for
      including **the canonicalizer** and the duration rule; and the bump itself
      was performed — `7`, pinned from the other side by
      `libs/contracts/solver/src/wire-contract-version.test.ts`, which asserts
      both golden requests start with `"7+"`, so a change here without a change
      there is a red test rather than a cache that quietly keeps its rows.
      **Not done, and it is not this slice's to do:**
      `contractVersion = "<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"` is built
      at `build-solver-request.ts:214`, which is where the **request** is built.
      There is no cache table yet — `budgetMs` and `contractVersion` become
      cache-key _columns_ in **task 4.2**, which is where "built where the cache
      key is built" acquires a place to be true.
      **THE REASON HAS CHANGED, run 45 chunk 4. 4.2 IS TICKED**, so the columns
      exist and that sentence is stale. What is left is smaller and sharper:
      the composite was written as a template literal at the request builder,
      while `publishedScheduleReaderOf` receives the same string as a
      caller-supplied `PublishedScheduleOptions.contractVersion`. Two writes of
      one format, separated by a library boundary, fail **silently**: a
      character of difference makes every cache read miss forever, nothing
      throws, and no test fails — the plan simply never gets a cached answer and
      looks slow rather than broken.
      **So the composer now exists and there is only one:**
      `contractVersionOf(solverVersion)` in `libs/domain/src/contract-version.ts`,
      with `build-solver-request.ts` calling it instead of retyping the literal,
      and `contract-version.test.ts` proving both halves and that no
      `solverVersion` is ever invented (mutations: a defaulted version **1/1**,
      the constant dropped from the composite **0/2**).
      **The remaining half is slice 6's and is a one-line obligation:** the
      composition root that constructs `publishedScheduleReaderOf` must pass
      `contractVersionOf(solverVersion)` and not a string of its own. Tick 1.5
      when it does.
- [x] 1.6 **Proven by** keying the existing Fast golden corpus on
      `SCHEDULER_CONTRACT_VERSION`. **Negative check, watched red** — change
      `ASSUMED_SLICE_WORKDAYS` without bumping the constant and watch the
      corpus fail. This is the guard that makes the cache key honest: without
      it a domain change leaves stale rows matching their key forever.
      **Same commit, no-op proof:** with the seventh argument defaulted to an
      empty map, every existing corpus case SHALL produce a **byte-identical**
      schedule — the re-key must not be able to hide a placement change smuggled
      in with it (`openspec/changes/work-item-deadline/design.md` §3.4, §7).
      **THE PREMISE IS FALSE AND THE SLICE IS BIGGER THAN IT READS (run 11,
      measured at `09e9ccd7`).** "The existing Fast golden corpus" does not
      exist as bytes. `find` over the repo returns no `.snap`, no
      `__snapshots__`, and no serialized-schedule fixture anywhere in
      `libs/domain`; what the phrase refers to is
      `libs/domain/src/schedule-identity.test.ts`, which is a **differential**
      corpus — a seeded `generatePlan` feeds both today's `schedule()` and a
      copy of the `role-crud` engine kept in the same file, and asserts they
      agree. A differential corpus compares two implementations _inside one
      commit_. It has nothing to key on a version, and it cannot be given one:
      there are no stored numbers for a key to protect.
      **Worse, it is structurally blind to this slice's own watched red.** Its
      oracle consumes the live constant — `schedule-identity.test.ts:4` imports
      `ASSUMED_SLICE_WORKDAYS` from `./index` and line 331 spends it as
      `each.days ?? ASSUMED_SLICE_WORKDAYS` while building the oracle's
      durations — so moving the constant moves BOTH sides and the differential
      stays green by construction.
      **Measured, not reasoned.** `ASSUMED_SLICE_WORKDAYS` 2 → 3 with
      `SCHEDULER_CONTRACT_VERSION` left at 7, whole suites on h2puni at
      `09e9ccd7`: domain **356 pass / 19 fail across 6 files**
      (`schedule.test.ts`, `schedule-shapes.test.ts`,
      `schedule-priority.test.ts`, `schedule-benchmark.test.ts`,
      `solver-quantum.test.ts`, `workday.test.ts`) — and
      `schedule-identity.test.ts` contributes **zero** of them, exactly as the
      mechanism above predicts. Contracts: **167 pass / 0 fail**, so
      `wire-contract-version.test.ts`, which pins the constant to the request
      fixtures' `7+0.1.0` prefix, does not notice that Fast's semantics moved
      underneath it.
      **So the guard 1.6 is about does not exist today, and the 19 failures are
      not it.** Every one is a hand-written date assertion — precisely the set a
      developer _expects_ to update when deliberately changing the constant.
      After updating them the suite is green again and nothing anywhere says
      "now bump 7 to 8", which is the stale-row-matching-its-key-forever
      failure this task names.
      **What it actually needs**, and the reason it is a slice rather than a
      re-key: (a) a corpus of Fast schedules serialized to **checked-in bytes**,
      since only stored output can be keyed; (b) that file carrying
      `SCHEDULER_CONTRACT_VERSION` so a mismatch is the failure, which means the
      generator must be reachable from outside a `.test.ts` — `generatePlan`
      and `durationsFrom` are file-local today and copying them would put the
      third copy of the engine's input rules in the repo; and (c) the no-op
      proof above, which only becomes meaningful once (a) exists. Sequence (a)
      before anything else; the watched red is free once the bytes are there.
      **Correction to (c), same run, one paragraph later — `schedule()` has SIX
      parameters, not seven.** `libs/domain/src/schedule.ts:1717` takes
      `rows, edges, slices, notBefore = new Map(), poolSizes = new Map(),
reach = 'whole-item'` and stops. The seventh canonical argument exists as
      `SolverRequestPlan.deadlines` in `libs/contracts` and as the `deadlines`
      parameter of `leaf-constraints.ts:109`; it has not reached the engine's
      own signature. So "with the seventh argument defaulted to an empty map"
      cannot be run today — there is nothing to default. (c) is therefore
      blocked on the signature change 4.9 brings, not merely on (a), and the
      sequence is (a) bytes → watched red → **signature** → (c). Recorded rather
      than repaired because widening `schedule()` is not this task's slice.
      **A serialization note for whoever builds (a):** `Schedule`
      (`schedule.ts:247`) holds `Map`s — `slices` and `workItems` — so the
      corpus needs a deterministic canonicaliser before it has bytes at all.
      `JSON.stringify` on a `Map` yields `{}` and would check in a corpus that
      passes against every possible engine.
      **(a) AND THE WATCHED RED ARE LANDED (run 11, chunk 3, `bcf86887`).**
      `libs/domain/src/fast-golden-corpus.ts` holds four hand-written plans —
      `chain-of-three`, `unestimated-middle`, `pool-of-one`,
      `floor-and-person` — plus `serializeSchedule`, which sorts both `Map`s
      into entry arrays so the output has bytes at all.
      `libs/domain/fixtures/fast-golden-corpus.json` is those schedules and the
      version they were produced under, and `fast-golden-corpus.test.ts` refuses
      a mismatch in **either** direction. Inputs are hand-written on purpose: a
      generator would be the third copy of the engine's input rules, and the
      corpus's own inputs must not be able to drift from the plans it claims to
      describe.
      **Both halves of the ratchet measured on h2puni at `112aa297`**, not
      argued: `ASSUMED_SLICE_WORKDAYS` 2 → 3 with the version left at 7 →
      **360 pass / 20 fail**, of which 19 are the pre-existing date assertions
      and the twentieth is `reproduces every stored schedule byte for byte`, the
      only failure in the suite that is about the key; `SCHEDULER_CONTRACT_VERSION`
      7 → 8 with the fixture left alone → **379 pass / 1 fail**, and that one is
      `was produced under the version this tree declares`. Gate at `bcf86887`:
      domain lint 0, typecheck 0, **380 pass / 0 fail across 30 files**
      (375/29 before), contracts **167/0**, 0 emitted `.js`.
      **Still open: (b) is answered differently than planned, and (c) is
      blocked.** (b) asked for the generator to be reachable outside a
      `.test.ts`; the corpus does not use a generator at all, so that
      requirement is void rather than met — `schedule-identity.test.ts` keeps its
      own generator and its differential role, unchanged. (c) waits on 4.9's
      signature change, per the correction above.
      **Two cases added the same run (`c3d6a1d3`) against
      `contract-version.ts`'s own bump list**, which is the right coverage
      question for this corpus: not "is a plan represented" but "can each named
      semantic be seen". `anchor-slice-reach` closes `reach`, which four
      one-slice-per-item cases structurally cannot see — both arms agree until a
      work item has two steps, and stored under `anchor-slice` the successor's
      first step starts at 2 (its predecessor's _anchor_) rather than at 5 (the
      whole item). `fractional-duration` closes the `days / width` arm of
      `durationOf` and the snapping after it: 5 days across width 2 stores
      `duration: 2.5` and a finish at 3.5, which a corpus of whole numbers
      cannot tell apart from a rule that rounds. **Watched red for the new
      case:** flip that case to `whole-item` → **379 pass / 1 fail**, the one
      being the byte comparison.
      **A seventh case, `diamond-float-thirds`, closes `snapWorkdays`
      (`81625301`).** It is the one call in `schedule.ts` (line 1612,
      `slack = snapWorkdays(latestStart - earliestStart)`), so the case is a
      diamond whose short branch carries real slack and whose widths are 3, to
      make every duration a repeating third. **Watched red:** drop the
      `snapWorkdays` from that line → **371 pass / 9 fail**, and the corpus's
      byte comparison is among them. Unlike the `ASSUMED_SLICE_WORKDAYS` red,
      the corpus is _not_ the only check that notices this one — four existing
      float and drift tests catch it too — which is worth stating rather than
      overselling the corpus.
      **An eighth case, `inverted-numbering-tie`, closes numbering semantics
      (`9a8e4a98`), and run 11's open question is answered NO.** Run 11 left
      this reachable-but-unmeasured: `deriveNumbers(rows)` is spent at
      `schedule.ts:1890` and read at `:1902` as the third of four leveling
      tie-breaks, and `pool-of-one` looked like the shape that would turn on it.
      **Measured: it does not.** With the number comparison deleted from
      `goesFirst` (`schedule.ts:1940`) the corpus was regenerated and compared
      case by case against the stored bytes — **`pool-of-one` and all six other
      prior cases are byte-identical; only `inverted-numbering-tie` moves.**
      The reason is in the inputs rather than the engine: every earlier case
      declares its rows in position order, so `deriveNumbers`' order and the
      `rows` **array** order (`index.leafIds`, `schedule.ts:326`) agree and the
      number can only confirm what the last tie-break would have chosen anyway.
      The new case pulls them apart — `b` at position 10, `a` at 20, declared
      `a`-first, one pool slot — and since `node.at` is the index **within** a
      work item (`schedule.ts:1813`) both nodes carry `at: 0`, which leaves the
      number as the only line in `goesFirst` that separates them. Stored bytes:
      `b` 0 → 2, `a` 2 → 4 `boundBy: 'capacity'`; the plan's own order would
      have given `a` the slot. **Watched red:** delete that line → **371 pass /
      9 fail**, the byte comparison among them. **Honest qualifier, same as
      `snapWorkdays`:** the corpus is not the only check that notices — the
      other eight failures include `breaks a remaining tie on the work item
number, then on step order`, a test written directly for this rule. The
      case adds the version key to a rule that already had coverage.
      **Still uncovered, named rather than claimed:** `SOLVER_QUANTUM` is not a
      `schedule()` input at all, so this corpus cannot reach it. Every other
      name on `contract-version.ts`'s bump list now has a case built for it.
      **(c) IS CLOSED, run 47, and it does not have the shape the plan asked
      for — that is the finding, not a shortcut.** Run 11 recorded (c) as
      blocked because `schedule()` had six parameters and the seventh canonical
      argument, `deadlines`, had not reached its signature. A seventh parameter
      has since arrived with **4.9**, and it is `pinnedStarts`, not `deadlines`.
      **An empty map is NOT a no-op for it and cannot be made one:**
      `schedule.ts:2303` reads `pinnedStarts === undefined` as "this is Fast"
      and anything else as "a solver answered", then demands a start for every
      node — so `new Map()` means "the solver returned no start for any slice"
      and is refused with `ScheduleInvalidOptimizedStartError`. The plan's
      wording therefore cannot be executed literally; it would assert the
      opposite of the design.
      **So (c) landed as two halves in `fast-golden-corpus.test.ts`**: the
      no-op the plan wanted, proven by passing the seventh parameter explicitly
      as `undefined` and reproducing all eight stored cases byte for byte; and
      the refusal, asserted on **every** case, which is what stops the corpus
      being re-keyed through the optimized path by accident.
      **Watched red, MEASURED on h2puni at `17c52e89`** rather than argued —
      the exact silent bug the second half exists to forbid: widen line 2303 to
      `pinnedStarts === undefined || pinnedStarts.size === 0`, making an empty
      map a quiet no-op, and the file goes **6 pass / 1 fail**, the one failure
      being `refuses an empty map on every case rather than treating it as
      Fast`. Green at the same head: **7 pass / 0 fail, 24 expect() calls**.
      The mutation was reverted and the gate checkout re-verified `dirty=0`.
- [x] 1.7 **WITHDRAWN FROM THIS CHANGE on the PR 203 review — moved whole to
      TASK-260, along with 1.8 and its third assertion.** The code below landed,
      was measured exactly as recorded, and was then taken back out at
      `change/dual-optimized-scheduler`. The reason is not that it was wrong: it
      is that it is not inert. Sol's I1 probed the real database and found that
      `work_item_siblings` is a plain index, so two siblings may share a
      `position`; `deriveNumbers` sorts stably; and therefore imposing an order
      here **moves an existing project's dates on the deploy that ships it**,
      whether or not that project ever enables the optimizer. This change's
      subject is the solver core and a Fast-parity refactor, and a behaviour
      change for live plans has no business riding inside it unannounced. It
      wants its own change, which states the response-order contract, decides
      what to do about sibling-position uniqueness, adds the `(project_id, id)`
      index the ordered read implies, and carries pre/post fixtures over the
      population it can touch. The optimized cache key never read this order —
      `canonical-schedule-input` groups slices by work item — so nothing else in
      this change rests on it. Recorded verbatim below as the evidence TASK-260
      starts from.

      `WorkItemRepo.listByProject` acquires `ORDER BY work_item.id` on its
      work-item select. An argument tuple that varies between reads of an
      unchanged project is a Fast defect before it is a cache one.
      **Landed in run 13 chunk 4** — `.orderBy(asc(workItem.id))` on the
      work-item select alone; the four label joins already ordered by their own
      label id (design.md D6) and are untouched. The repository-boundary half of
      the proof landed with it in `work-item.db.test.ts`: two rows **written in
      the opposite order to their ids**, read twice, asserting the ids come back
      ascending and that the second read equals the first. The ids are written
      literals rather than `crypto.randomUUID`, because the whole assertion is
      about their order and a random pair agrees with insert order half the time
      — the watched red would otherwise be a coin toss. **Watched red:** the
      `orderBy` deleted from the production path → **31 pass / 1 fail**, and the
      one failure is that test (green baseline 32 / 0; file restored, `dirty=0`).
      be-01 **1131 pass / 0 fail across 87 files** at `76a4864f`.

- [x] 1.8 **WITHDRAWN FROM THIS CHANGE with 1.7 — moved whole to TASK-260.**
      Same reason, and this item is the one that measured it: its third
      assertion is the tied-sibling fixture that shows the two spans exchanging,
      which is exactly the production behaviour change 1.7's withdrawal note
      describes. All three tests were lifted out of `work-item.db.test.ts` and
      travel to TASK-260 intact. Recorded verbatim below.

      The `ORDER BY` proof asserts the **raw argument tuple**, not the hash
      (Sol r7 Important 11). The earlier plan reversed the stub driver's rows
      and expected two different hashes through
      `listByProject` → `slicesOf` → `canonicalScheduleInput`; that fault is
      normalised away by design, because 1.1(c) reorders groups by
      `workItemId` and sorts rows by `id`, and the spec separately _requires_
      the hash to be equal when only underlying row order differs. A hash
      assertion here can never fail, which is the check-that-cannot-fail
      failure AGENTS.md R5 names. The proof instead runs the same reversed
      driver through `listByProject` → `slicesOf` and asserts the
      `schedule(...)` argument tuple — the `rows` and `slices` arrays as Fast
      receives them — is identical between reads, with a second assertion on
      Fast's own order-sensitive output for that fixture. **Watched red:** drop
      the `ORDER BY` from 1.7 and both assertions must fail while the hash
      assertion in 1.3 stays green.
      **The tuple half landed in run 13 chunk 6 and the Fast-output half in run
      14 chunk 1, on a second fixture; this item is closed.** The seam decision went
      the way `poolsFor` already set: `slicesOf` is now exported "for the tests
      alone", with a JSDoc naming this task, rather than the tuple being
      reassembled through the whole service plan read.
      The test lives beside 1.7's in `work-item.db.test.ts` and drives the real
      repository — two rows **written in the opposite order to their ids**, then
      `listByProject` → `slicesOf`, asserting **both** arrays Fast receives come
      back in `work_item.id` order. No estimate is written, deliberately:
      `slicesOf` emits one slice per leaf per project step whether or not
      anybody estimated it, so an estimate would be a second moving part in an
      assertion about order.
      **Watched red, measured:** the `orderBy` deleted from the production path
      → **31 pass / 2 fail** on that file against a green **33 / 0**, and the two
      failures are exactly 1.7's assertion and this one — "both assertions must
      fail", as written. The hash assertion in 1.3 stays green because it lives
      in `libs/domain` and cannot see a be-01 repository at all, which is the
      structural version of why it could never have been the proof here.
      **The Fast-output assertion needs its OWN fixture, and the reason is
      measured rather than argued.** On the tuple fixture it cannot fail — two
      unblocked leaves, no edge, no pool and no estimate all start at day 0
      whatever order they arrive in — so adding it there would have been the
      check-that-cannot-fail this item was rewritten to avoid. Run 14 first
      established _why_ by probing `deriveNumbers` and `goesFirst` directly at
      `705f1bc5`, and the answer is narrower than "an `inverted-numbering-tie`
      shape": the number is the third of `goesFirst`'s four tie-breaks
      (`schedule.ts:1940`) and `deriveNumbers` sorts each sibling group by
      `position` (`derive-numbers.ts:117`), so with **distinct** positions the
      labels are a function of `position` alone and the array order reaches
      nothing. Probed both ways on two leaves over a one-slot pool: positions
      `20`/`10` give `00000000… 2 → 4`, `ffffffff… 0 → 2` under **both** row
      orders, byte-identical. So no fixture with distinct sibling positions can
      carry this assertion, whatever else is tied.
      **Tied positions are what make the row order a date**, because
      `Array#sort` is stable: the group order — and therefore the labels — falls
      back to the array order. Same probe, both positions `10`: id order gives
      `00000000… = 010` taking the slot `0 → 2` with `ffffffff… 2 → 4`; insert
      order gives `ffffffff… = 010` and the two placements **exchange**.
      That is a legal database state and a reachable one, which is why it is a
      fair fixture rather than a contrived one: `work_item_siblings`
      (`schema.ts:475`) is a plain index with no uniqueness, and `placeAfter`
      appends at `last + POSITION_STEP` from a group it read outside any lock
      (`place-sibling.ts:53`), so two appends racing on one parent both compute
      the same number.
      **Landed at `ad2fa720`** beside the other two, driving the same real
      repository: two leaves written in the opposite order to their ids at one
      position, both joined to a team sized at one slot, through
      `listByProject` → `slicesOf` → `schedule(...)`, asserting
      `00000000… 0 → 2` and `ffffffff… 2 → 4`. No estimate is written here
      either — `ASSUMED_SLICE_WORKDAYS` gives both blocks two days, so the
      queue is the only thing separating them.
      **Watched red, measured:** the `orderBy` deleted from the production path
      → **31 pass / 3 fail** on that file against a green **34 / 0**, and the
      three are exactly 1.7's assertion, 1.8's tuple assertion and this one. The
      failure is the exchange itself — `earlier` came back
      `{ start: 2, finish: 4 }` against an expected `{ start: 0, finish: 2 }`,
      while `waitingForCapacity` stayed `1` in both directions, which is the point
      stated as an assertion: the queue is unchanged and only _who waits_
      moved, so an unordered select is a plan that schedules two ways rather
      than a plan that schedules worse.

- [x] 1.9 Extend 1.3's one-mutation-per-fact set with the two it was missing:
      a `parentId` reparenting that keeps every other field identical (it
      changes leaf expansion, inherited priority and floors), and a `stepId`
      identity swap between two slices of one work item. Extend 1.4's
      watched-red removals to **every** field named in 1.1, not only `reach`
      and slice order — each removal must be observed failing on the
      production path before the field is trusted.
      **Both mutation cases landed in run 13 chunk 2; only the removals are
      left.** Domain **402 pass / 0 fail across 31 files**.
      **`parentId` needed a fifth base, `NESTED`**, because it is the one field
      in 1.1 (a) that no placement reads: it decides **which leaves an authored
      edge expands to**. The edge is authored on the parent `P` and under
      `whole-item` reach lands on every leaf `P` owns, so moving `s` into `P`
      hands it a predecessor it never named. The base carries no priorities and
      no pools on purpose — an inherited priority or a shared queue would give
      the reparenting a second route to the same placement and the case would
      stop being about leaf expansion. Measured at `0046924b`: base `s` is
      `0 → 2` `boundBy: "projectStart"`, reparented `s` is `2 → 4`
      `boundBy: "predecessor"`, with `q` (`2 → 4`) and `r` (`0 → 2`) untouched.
      **The `stepId` identity swap is a different fact from the intra-item
      order swap already in 1.3, and the measurement is what separates them.**
      The order swap reorders the durations: `[build 3d, design 2d]` gives
      `build 0 → 3`, `design 3 → 5`. The identity swap keeps the array order and
      both durations and exchanges only the labels, so the two blocks stay put
      and every step the caller can name moves across them: base
      `design 0 → 2`/`build 2 → 5`, swapped `build 0 → 2`/`design 2 → 5`, with
      `b` (`7 → 9`) and `c` (`5 → 7`) unmoved because the work item's own
      footprint is unchanged. A schedule is keyed by `sliceKey`
      (`workItemId` NUL `stepId`), so a canonical form that dropped `stepId`
      would hand one cache key to two plans that disagree about which step is
      where.
      **The removals landed in run 13 chunk 3, and the sweep paid for itself
      twice.** Seventeen removals, each made on `canonical-schedule-input.ts`
      itself and run against the real suite, then restored (`dirty=0` after every
      pass). The table is in the file's `Proof` block. Two findings:
      **(1) `edges[].predecessorId` and `edges[].successorId` were both
      unobserved** — 22 pass / 0 fail each. `an authored edge added` was the only
      edge case, and an added edge lengthens the array, so the hash moved on the
      array's _length_ whichever half of the pair was missing: the case could not
      see which end of the edge it proved. Two **redirections** fixed it — the
      edge count stays at one and a single end moves, so each removal collides
      the base with its own mutation, and each now gives 23 / 1.
      **(2) `rows[].id` and `slices[].workItemId` have no isolated red and are
      mutually redundant**, provably rather than accidentally: the rows entry is
      sorted by `id`; `schedule()` refuses a leaf with no slice at all (`no slice
for work item z`, probed directly), so the slice-bearing items are exactly
      the leaves under the same sort; and every non-leaf id appears as some
      child's `parentId`. Either field reconstructs the other, so no
      one-mutation case can separate them, and inventing one that quietly moved a
      second field would have been worse than saying so. What they carry
      **jointly** is a work item's identity, and `a work item renamed` now pins
      it — measured at `05b78008`: `rows[].id` alone **25 / 0**,
      `slices[].workItemId` alone **25 / 0**, both together **24 / 1** and it is
      that case. Domain **405 pass / 0 fail across 31 files**.

## 2. Solver contract types, request builder, and the Bun re-validator

- [x] 2.0 **Publish the priority resolver before anything imports it.** Add
      `export` to `function priorityByLeaf` in `libs/domain/src/schedule.ts`
      and re-export it from `libs/domain/src/index.ts`. Nothing else moves: it
      keeps its signature `(rows: readonly PlannedRow[], index: TreeIndex) =>
Map<string, number>` and Fast keeps calling the same function, so the
      existing golden corpus is the proof that publishing it changed nothing.
      This slice exists because 2.2's named seam is an import of a symbol
      `libs/domain` does not currently publish, and an ordered plan that
      reaches 2.2 first cannot proceed (deepseek r9 Important 1).
      **Landed** at `6863752d`. The re-export needed no edit — `index.ts`
      already carries `export * from './schedule'`, so the missing half was
      always the `export` keyword alone, and the code diff across 2.0 and 2.8
      together is exactly two of them (`priorityByLeaf`, `durationOf`); every
      doc line beside them is comment. **The seam is now asserted from the
      BARREL** in `solver-seams.test.ts`, not from `schedule.ts`, and the
      watched red is why that distinction is the whole slice: with `export`
      removed from `priorityByLeaf` again — the exact pre-2.0 state — the entire
      pre-existing 327-test domain suite passes and only the barrel test fails,
      335/1. The defect is invisible from inside the module, because the symbol
      is right there and its own tests pass; it is only visible from where the
      consumer stands.
      **Which `tsc` says so depends on the config, and the first write of this
      paragraph named the wrong one (re-measured 2026-09-04, run 8 chunk 5).**
      It said `tsc --build --force` exits 0 with a zero-byte log, full stop.
      That is true of `libs/domain/tsconfig.lib.json`, whose `exclude` is
      `["src/**/*.spec.ts", "src/**/*.test.ts"]` — the library build cannot see
      a barrel test and never will. It is **false** of the gate: the
      `typecheck` target runs `tsc --build --force libs/domain/tsconfig.json`,
      which does include the tests, and it exits **1** with
      `solver-seams.test.ts(24,26): error TS2339: Property 'priorityByLeaf'
does not exist on type 'typeof import(".../index")'`. So the barrel test
      is doing two jobs, not one: it fails as a test, **and** it is the only
      reason the typecheck target sees the missing export at all — delete the
      file and the same mutation is silent again under both configs. Measured
      the same way for `export * from './slice-edges'` deleted: lib config 0,
      typecheck target 1, suite 373/1, and `libs/contracts`'s own typecheck 1
      on `TS2305` because a real consumer now imports it. Second red: the barrel's `export * from
'./solver-quantum'` commented out, 335/1 on the quantum case alone.
- [x] 2.1 `libs/contracts/solver/solver-wire.v1.json` is the **single
      normative definition** of the request and the response — prose in this
      file, in design.md and in the long-form note is descriptive only (Sol r6
      Critical 1, Sol r7 Critical 5).
      **The four request members that reached this slice with a meaning and
      no shape are settled, and the schema is where to read them rather than
      this paragraph.** `edges` was answered by `libs/domain/src/schedule.ts`
      in run 1. Run 2 settled the other three the same way, and each carries
      in its own `$comment` the source it was read from: `PoolSizes =
ReadonlyMap<string, number>` (`schedule.ts:95`) and
      `project_team_capacity.size`'s floor of 1 for `pools`; the response's
      normative "that offsets **map**" and `MOVEMENT`'s subscript access for
      `baselineOffsets` and `fastHint`. The one result there that is not a
      shape: those two carry the **same value** — design.md's quantisation
      decision 2 says both _are_ the quantised Fast baseline and 2.11 produces
      both from one re-run — so two fields hold one value, and their equality
      is an enforced builder invariant rather than a coincidence.
      `stageBudgetSplit` was never in that list: `STAGE_BUDGET_SPLIT =
[0.60, 0.25, 0.15]` fixes it as a three-element array of fractions.
      **What JSON Schema cannot say is written into the request's own
      `$comment` as eight numbered invariants**, each with the watched red that
      proves it, and each checked by the builder before spawn and again by the
      Python entrypoint: hint equals baseline; the key set of `baselineOffsets`
      equals that of `fastHint` and both equal the set of slice keys; every
      offset lies within `horizonUnits`; every pool a slice names has an entry
      — `schedule.ts:718`'s `no size for pool ${poolId}` throw promoted to the
      wire, where a default would be a capacity constraint silently not
      applied; every edge endpoint is a known key; the split sums to 1; no
      duplicate object key, **which no schema anywhere can reject**, because
      `JSON.parse` and `json.loads` both silently keep the last — so both
      consumers compare the parsed key count against the raw member count; and
      the `bigint` overflow preflight.
      **The encoding hazard is in the key itself, and it reached the schema as
      an absence.** `sliceKey(workItemId, stepId)` joins the two ids with a
      literal **U+0000** and renders a null `stepId` as the empty string
      (`schedule.ts:105`; read the separator there rather than transcribing it
      — pasting it into a document writes a real NUL byte, after which every
      `grep` over that file reports binary and prints nothing, which is how
      this paragraph found its own hazard, and run 2 reproduced it in a probe
      script). So the key definition is a non-empty string and **nothing
      else**: a printable-character `pattern` would reject every valid request.
      Proven rather than asserted — a two-slice request with real U+0000 keys
      validates against the schema and round-trips through `json.dumps` and
      `json.loads` with the NUL intact. The golden corpus must carry such a key
      **verbatim** rather than a sanitised stand-in, and any logging of a
      request must not be the place this is discovered.
      **The FIFTH member — the response's `status` — is now settled too, and
      by the same method: candidate (a) was refused by an artifact rather than
      by preference.** It is a **run-outcome** enum of exactly
      `feasible | unknown | infeasible`, a different question from the
      per-term `status`: that one reports a stage's proof strength, this one
      reports whether a schedule is being returned at all and, if not, which
      of the two reasons applies. `infeasible` is pinned verbatim by spec.md's
      "SHALL admit `infeasible` as a first-class outcome"; `unknown` is pinned
      by the same sentence's "SHALL NOT be mapped onto `unknown`", which is
      only meaningful if `unknown` is itself a response status; `feasible` is
      the only other outcome any matrix row produces. **`optimal` is excluded
      by design.md's own words** — the per-stage `'optimal'` "never claims the
      published schedule is optimal, which the design has said from the start
      it is not" — so reusing the stage vocabulary would have written a claim
      the design denies, and that is what closed candidate (a).
      **The `status`-to-payload conditional came out of the matrix's `n/a`
      column, not out of the enum:** `feasible` carries `offsets` and
      `objectiveValues`; the other two run outcomes carry **neither**, because
      `value` is defined only on a published schedule. `offsets` is _absent_
      rather than `{}`, since an empty map passes the schema and then fails the
      key-set invariant one layer later, reporting a vocabulary decision as a
      corrupt payload. So `required` on the response names only `wireVersion`
      and `status`, and spec.md's "SHALL carry only …" is read as the closed
      maximum it is rather than as a floor.
      **A later-stage INFEASIBLE has no wire encoding, deliberately.** The
      matrix's own `k > 1` argument is that the previous incumbent already
      satisfies every added constraint, so the solver holds a counterexample to
      its own answer; it exits non-zero **without** emitting a response rather
      than emit a proof it can refute, and the coordinator records the run as
      `invalid-output` exactly as that row says. Falsifier: an artifact that
      requires the coordinator to tell "the solver crashed" from "the solver
      contradicted itself" _from the response_ would need a fourth status.
      Five golden fixtures carry the decision as watched reds: the two
      payload-free valid responses, a response-level `optimal` that must be
      refused, and the conditional in both directions.
      It carries `wireVersion` as a required
      literal, states the unit of every numeric field, and includes every field
      staged solving needs — on the request `fastHint`, `baselineOffsets`,
      `stageBudgetSplit`, `quantum` and `horizonUnits`; on the response, the
      per-term `objectiveValues` shape. **Split deliberately (found run 2):**
      as one run those six were an untagged enumeration mixing the request and
      response vocabularies, which is exactly what rule (b) below rejects, so
      2.1's own prose failed 2.1's own check.
      Every integer objective field in both directions has an inclusive
      `Number.MAX_SAFE_INTEGER` maximum; this is the Bun/JSON exactness bound,
      not merely CP-SAT's wider signed-64-bit range.
      Exactly four consumers read that one file: the Bun request builder and
      `parseSolverResponse` in `libs/contracts/solver/src/`, the `wbs-solver`
      entrypoint (validating against the copy installed beside it with the
      pinned `jsonschema` dependency), and a shared golden corpus under
      `libs/contracts/solver/fixtures/` that both suites run. **Watched red:**
      a consumer that accepts a message the schema rejects, or rejects one it
      accepts, fails the contract test; and a TypeScript type that drifts from
      the schema fails it too. **A repository check enforces the "descriptive
      only" claim (Sol r8 Critical 4, restated Sol r9 Critical 1):** three
      rounds running, an obsolete prose schema in one of the four **descriptive
      artifacts** was an implementation instruction contradicting the real one.
      **Those four are named here because "those four files" read as the four
      consumers of the sentence before it, which are code and carry no prose
      (found run 2):** this file, design.md,
      `specs/scheduler-optimization/spec.md`, and the long-form note.
      **The note is not in this repository** — it lives in the Claire workspace
      as `notes/wbs-dual-optimized-scheduler-design.md`, 1609 lines, and no
      copy of it exists under `openspec/`, `docs/` or `notes/` here (grepped
      run 2 for every form of `solver`, `CP-SAT` and `solver-wire`;
      `dual-optimized-scheduler` is also the only `openspec/changes/*` entry
      that mentions the solver at all). So a **repository** check in
      wbs-tool-v1 can cover three of the four and not the fourth, and it must
      say which it covered rather than reporting a three-file pass as a
      four-file one. **DECIDED (run 3, 2026-09-03): the note is NOT copied in;
      it is out of the check's scope, and the check SHALL name it as uncovered
      in its own output** — a line naming the file and the repository it lives
      in, printed on a pass as well as a failure, so "3 of 4" is never read as
      "4 of 4". Three reasons, and the first is the decisive one: the note's §6
      is a **review ledger**, and this change's standing rule is to amend
      normative text and never history, so a second copy would have to be
      either synced — two sources of truth for a ledger — or frozen, after
      which the check would enforce against a stale artifact. Second, the
      note's content is _already_ required to be descriptive-only against a
      normative schema, so its drift can mislead a reader but cannot instruct a
      consumer; the exposure a copy would close is smaller than the exposure it
      would open. Third, the obligation the copy was meant to create already
      exists and has been met three runs running: whoever amends the wire
      amends the note in the same chunk. **Falsifier:** hand this change to an
      implementer who does not have the Claire workspace and the "descriptive
      only" claim over four becomes unverifiable at exactly the moment it
      matters — then copy the note in and freeze it deliberately. The check is
      **set equality, not a ban on prose**, because a planning artifact that
      may not name a field cannot say what the schema must contain, and the
      earlier "no field list outside the schema" wording rejected design.md,
      spec.md and this file on the round it was written. Definitions: an
      **enumeration** is a maximal run of three or more backticked
      identifiers joined only by commas, `and` or `/`; a **vocabulary** is one
      named tuple this change defines. The check knows fifteen vocabularies —
      seven parsed from `solver-wire.v1.json`: the four `required`
      sets `request`, `response`, `slice` and `objective-term`, plus
      `objectiveValues` and the two status enums, the response's and the
      per-term one. Then the four table tuples — the cache
      composite key, the plan-read optimization block, the
      `optimization_generation` row and the `solver_queue` row. And four
      **neighbour** tuples this change names outside the wire and outside a
      table: the **domain** slice (`schedule.ts:31`), the hashed `PlannedRow`
      facts (`canonical-schedule-input.ts:184`), the spawn fencing triple, and
      the objective **term names**, which are the mathematical names and
      deliberately not the lowercase wire keys — because a
      check that does not name its vocabularies misattributes every table
      tuple to the wire and is unrunnable. **Every one is read out of the
      artifact that defines it rather than out of a sentence that mentions
      it** (run 23): a vocabulary asserted from memory is the failure rule (b)
      exists to catch, in a new place. Then: (a) an enumeration inside a
      `<!-- wire-fields:<set> -->` span (the span runs from the tag to the end
      of its sentence or to the next tag) SHALL equal that set exactly,
      failing with file, line and symmetric difference; (b) an untagged
      enumeration is attributed to the vocabulary it overlaps most and, when
      that overlap is two or more, SHALL be a **subset** of it — a partial
      mention is legal, a run mixing two vocabularies or naming a
      non-member is not; (c) `OptimizedResult` and `StoredObjectiveValue` are
      the stored shapes, have their own authority in the codec requirement,
      and are excluded by name. **Watched red:** the superseded sentence
      <!-- wire-fields:fixture -->"Each slice SHALL carry its `sliceKey`, an integer `durationUnits`,
      `width`, `personId`, set-valued `poolIds`, a resolved `priorityWeight`,
      and a resolved `notBeforeUnits`." is kept as a negative fixture; the
      check SHALL reject it naming `sliceKey`, and a check that passes it is
      not implementing rule (b). A quoted counterexample is the artifact being
      **correct**, so `wire-fields:fixture` is a reserved set name meaning
      "this span is quoted in order to be rejected" — without it this paragraph
      fails the check it specifies. That sentence was live in spec.md until Sol
      r9 Critical 1, against design.md's and 2.2's `key` — set comparison is
      what catches it, and the banned-prose wording would have deleted the
      evidence instead. **Rule (a) is the shipped gate** at every head, over
      the three covered artifacts, in
      `libs/contracts/solver/src/wire-vocabulary.ts` (run 22; the `af05ead1`
      prototype was a statement about that head alone).
      **Rule (b) gates too, under the union reading, and 2.1 is closed (run
      24).** The history is worth keeping because each step was a different
      kind of error. It began as seventeen divergences, none of them drift,
      blamed on six unnamed tuples. Run 23 added seven vocabularies read from
      their defining artifacts and the count fell to twelve, so five were
      attribution failures. The twelve that remained were one finding that no
      further naming could move: each was a run spanning two vocabularies both
      of which were named, and attribution picks a single winner by overlap, so
      every member of the other tuple was reported as unexpected whatever set
      it belonged to.
      **DECIDED (run 23): the union reading** — rule (b)'s subset test taken
      against the union of the vocabularies a run overlaps, admitting a name
      only through a vocabulary that contributes `MIN_OVERLAP` names _besides_
      it. Three grounds. It accepts strictly less. It keeps the property rule
      (b) was written for, because a name in no named tuple still fails — the
      watched red is the proof, not the argument. And its one hole is closed
      and mutation-proved: the first form admitted a response enumeration
      carrying a cache column, because that tuple cleared a bare two-name
      overlap on the strength of the drifting name itself.
      **Recorded as an assumption, with what would falsify it:** a real drift
      whose stale name is a legitimate member of some other named tuple that
      also contributes two further names to the same run. That run is admitted
      and no bar on overlap count fixes it, because the second tuple is
      genuinely present. If one is ever found, the answer is the other branch:
      rewrite the sentences and keep the single-winner reading, which cannot be
      fooled that way.
      **The first ground was true of the sentence count and false of the names
      until run 24, and no count could have shown it.** As shipped, admission
      ran only through the overlap bar and never granted the **attributed**
      vocabulary standing of its own, so a run whose winner overlapped by
      exactly two had both of those names reported — names the single-winner
      reading admits by definition. Measured at `a7446cd2`: four sentences grew
      that way, among them this task's own response conditional. The union was
      weaker on **sentences** and stricter on **names**, which is not the
      reading this task adopted. Admission now starts from the attributed
      vocabulary and the overlap bar only adds to it. Both counts were
      unchanged by the repair, which is why the property is asserted **per
      sentence** — a name accepted under `'best'` is never rejected under
      `'union'` — with a unit half naming the cause. Mutation-proved: restoring
      the shipped predicate turns 206/0 into 204/2, and the two reds are that
      guard and its unit half, every count assertion green straight through.
      **Then the nine survivors were rewritten, and run 23's list of them named
      eight.** The ninth was this task's own status-to-payload conditional,
      where the three run-outcome values stood beside the response field names
      — the fifth time 2.1's prose failed 2.1's check, and the only one of the
      five that sat inside the measured count while the written list omitted
      it. Every repair was a **sentence break** rather than a new vocabulary,
      and the measurement after each says what it cost: rule (b) under the
      union went 9 → 4 → 1 → **0**, and under the single-winner reading 12 → 3.
      Both counts are asserted, so either moves only deliberately.
      **The gate now runs `['a', 'b']` under `'union'` over the three covered
      artifacts**, which is what closes this task: an amended field list in
      prose, and a run mixing two tuples, are both red at every head.
      **ONE TUPLE IS STILL UNNAMED AND IS NOW UNGUARDED, which is the honest
      cost of the last repair.** spec.md's per-table `CHECK` list mixed the
      cache columns, the `project` row's own two settings columns and the
      slot/queue columns in one run. Splitting it per table drops the settings
      pair below rule (b)'s attribution floor — three names overlapping no
      vocabulary are not attributed at all — so the check no longer reports it
      and also cannot catch drift in it. It is not named because **there is no
      artifact to read it from yet, which is checked and not assumed**: the
      `project` table is declared at `apps/be-01/src/repository/schema.ts:129`
      and carries none of the three settings columns, and nothing under
      `apps/be-01/drizzle/` mentions them either, so 3b.1 has genuinely not
      landed them. Reading a vocabulary out of the sentence that mentions it is
      the exact failure rule (b) exists to catch. **Follow-up, owned by 3b.1:** when the
      migration lands, add the settings tuple as a vocabulary sourced from
      `apps/be-01/src/repository/schema.ts` and re-measure.
      **A line-number list inside the file it describes is a moving target**,
      and run 24 hit it twice in one chunk — amending this paragraph shifted a
      cited sentence, and writing the corrected number shifted it again. Closed
      with a same-length substitution and a re-measurement. Cite content, not
      line numbers, in any list that lives in its own subject.
- [x] 2.2 `buildSolverRequest(plan, objective, baseline)` in
      `libs/contracts/solver/src/` beside the schema it validates against —
      **Bun owns duration and graph derivation, Python owns placement only.**
      <!-- wire-fields:slice -->A slice is `{ key, durationUnits, width, personId, poolIds, priorityWeight, notBeforeUnits, deadlineUnits }`.
      The derivation of each follows, and is deliberately **outside** that span:
      a tagged span is checked for set equality, so a paragraph that names
      `days`, `snapWorkdays` and `priorityByLeaf` while deriving a member cannot
      also be the enumeration of the members.
      Each slice carries `key` (`sliceKey()`'s result), an **integer** `durationUnits` (2.8)
      computed exactly as Fast computes it — `ASSUMED_SLICE_WORKDAYS` for a
      null `days` **without** dividing by `width`, `days / width` otherwise
      **without** `snapWorkdays`, then `× SOLVER_QUANTUM` and rounded **up**
      only when the estimate does not divide (2.8) — `width`, `personId`,
      `poolIds`, `priorityWeight`
      (the **dense rank** `(R + 1) − rank(p(s))` over the `R` distinct
      priorities present in this canonical input, resolved by **importing
      `priorityByLeaf` from `libs/domain` rather than reimplementing it** —
      which **2.0 must publish first**, because `schedule.ts` declares it
      `function priorityByLeaf`, unexported, and `libs/domain/src/index.ts`
      re-exports only what `schedule.ts` exports, so the seam this plan names
      does not exist yet (deepseek r9 Important 1; Sol r8 Critical 7) — it is a nearest/most-specific **override**, taking the
      first non-null value walking leaf-upward, not a floor or a minimum
      across ancestors, so leaf 5 under parent 1 resolves to 5 — `0` when no
      priority reaches the leaf — the absolute priority is never a weight, because
      `asOptionalPriority` accepts any safe integer and `P_max + 1` loses
      precision at `Number.MAX_SAFE_INTEGER`; the builder also computes the
      exact worst case `Σ w(s) × horizonUnits` and fails pre-spawn with
      `objective-overflow` above `Number.MAX_SAFE_INTEGER`, so every integer
      remains exact through Bun and JSON; the preflight accumulator uses
      `bigint` and converts only after comparing with
      `BigInt(Number.MAX_SAFE_INTEGER)`), and
      `notBeforeUnits` (the latest of the leaf's own floor and every
      ancestor's), and `deadlineUnits` (`integer | null` — the **effective**
      deadline for that slice, folded over the tree by the same leaf-upward
      walk and already converted to `(D + 1) × quantum` so Python applies it
      without seeing the tree, `null` meaning unconstrained).
      `edges` are already leaf-expanded with `reach` applied and
      already include the intra-item step-order edges, so Python never receives
      the tree, `parentId`, or `dep_reach`. `horizonUnits` is the **serial
      bound** `max(0, ...notBeforeUnits) + Σ durationUnits`, seeded with zero so a
      plan with no manual floors at all (the common case) has a defined value
      — not the Fast makespan
      plus remaining effort, which is not an upper bound once the optimizer may
      idle a slice — checked against `2^31 − 1` before spawn (2.10). The
      request also carries `wireVersion` and `fastHint`; every field and unit
      comes from 2.1's schema rather than from this sentence.
      **Partly landed (2026-09-03):** the dense-rank `priorityWeight` is in
      `libs/domain/src/priority-weight.ts` — `priorityWeights(leafPriorities)`
      over `priorityByLeaf`'s output, plus `priorityWeightOf` for the absent
      leaf, which is most leaves on most plans. It went to `libs/domain` rather
      than beside the builder for two reasons: a dense rank over a plan's
      distinct priorities needs no wire type at all, and `libs/contracts` has
      **no** `@wbs/domain` import today, so opening that edge is a boundary
      decision of its own rather than a side effect — the more so because
      `@nx/enforce-module-boundaries` is SKIPPED in the gate (`No cached
ProjectGraph is available`) and would not have caught a bad one. The tag
      constraints do permit it: both libraries are `scope:shared` +
      `runtime:isomorphic`. The rest of 2.2 is unstarted.
      **Its `libs/domain` seams are all published now** — `sliceKey` (already
      was), `durationUnits` and `SOLVER_QUANTUM` (2.8), `priorityByLeaf` (2.0)
      and `priorityWeights`. **Its other two slice fields are not domain
      imports at all**, and this is worth knowing before starting rather than
      halfway through: `notBeforeUnits` converts the `notBefore:
ReadonlyMap<string, number>` that `schedule()` already takes as an
      ARGUMENT — resolved by the caller, exactly as `personId`, `width` and
      `poolIds` on a `Slice` are — so there is no resolver in `libs/domain` to
      import and none is missing. `deadlineUnits` is the effective deadline
      already folded, which is TASK-241's contract and a stated boundary of this
      change, not a gap. Checked by search, not assumed: `libs/domain` holds no
      deadline resolver, and `not-before.ts` holds only
      `isOrphanedNotBeforeReason`, which is a validation predicate rather than a
      floor walk.
      **The two folds are now published (2026-09-03), and the floor half was
      NOT a new function:** `libs/domain/src/leaf-constraints.ts` exports
      `leafFloorsOf` and `leafDeadlinesOf`, and `schedule()` now _calls_
      `leafFloorsOf` where it used to fold `notBefore` inline. That direction
      matters — the builder must carry the very same numbers as
      `notBeforeUnits`, and this exact fold was already wrong once for a month
      (2026-08-10: a floor written on a parent was accepted, stored, echoed back
      and constrained nothing), so a second copy in `libs/contracts` is the
      copy that would get it backwards. `leafDeadlinesOf` is new and is the
      fold's **mirror, not its twin**: `Math.min`, because the tighter of a
      leaf's own date and any ancestor's is the one that binds, and with **no
      zero seed**, because a floor's identity is day zero and a deadline has
      none — an unconstrained leaf is absent from the map and the wire spells
      that `deadlineUnits: null`. Both reds watched on h2puni at `f5053b1d`:
      `min` → `max` fails 3 of the 12 new tests, and `own ?? 0` in place of the
      `undefined` check fails 3 (a different 3 — a day-zero deadline is a real
      and very tight constraint, and the seed silently wins every later
      comparison). Neither the `(D + 1) × quantum` conversion nor
      `deadlineOffsetOf` is here: that is TASK-241's boundary, and
      `deadlineOffsetOf` exists nowhere in the repository today — checked by
      search, not assumed. What remains of 2.2 is the builder itself.
      **The two unit conversions landed with the `@wbs/domain` edge
      (2026-09-03):** `libs/contracts/solver/src/solver-units.ts` exports
      `notBeforeUnitsOf` and `deadlineUnitsOf`. They are separate from the folds
      because the folds are Fast's own rules and shared with the placement,
      while the conversions exist only because CP-SAT places integers. **The
      asymmetry is the content:** a floor bounds a START, so day `N` is
      `N × quantum` and there is no `+ 1`; a deadline names an inclusive
      FINISH DAY, so it is `(D + 1) × quantum` — an exclusive instant, because
      the last instant of day `D` is the first instant of day `D + 1`. Dropping
      the `+ 1` requires finishing by the start of the due day, loses a workday
      on every deadline in the plan, and makes a one-day task due the day it
      starts infeasible; watched red on h2puni at `9264f0dc`, 3 fail.
      **The boundary decision this paragraph flagged is now MADE, not deferred:**
      `libs/contracts` imports `@wbs/domain` as of this file. Argued rather than
      lint-approved — `@nx/enforce-module-boundaries` is still skipped in the
      gate — so `solver-units.test.ts` carries an explicit edge test that
      resolves the alias under the contracts target's own `cwd`
      (`libs/contracts`), which is a different question from whether `tsc`
      accepts it and is the assertion that fails first if the alias is dropped.
      Contracts gates at `9264f0dc`, dirty=0: lint 0, typecheck 0, **77 pass /
      0 fail across 6 files**.
      **`buildSolverSlices` landed (2026-09-03)** in
      `libs/contracts/solver/src/build-solver-slices.ts`: the whole slice
      projection, one wire slice per canonical slice in the order given, taking
      the three folded maps (`floors`, `deadlines`, `weights`) rather than the
      tree. Every field is copied or read from a published seam; the function's
      own content is the assembly and two refusals. **One deliberate divergence
      from `schedule()`, argued rather than inherited:** the floor is carried on
      EVERY slice of a leaf, where `schedule()` puts it on the first alone and
      lets the intra-item chain carry it. Same feasible region — the request's
      `edges` already carry that chain — but the schema's field is per-slice and
      defines itself as the _fold_, so a zero on a later slice would be that
      slice claiming to be unfloored, and a position-dependent projection would
      need a second grouping rule beside `groupByWorkItem`'s. The deadline is on
      every slice for the simpler reason that an item due on day `D` has no
      slice that may finish after it. **Two refusals, both watched red:** a
      duplicated `(workItemId, stepId)` (three wire maps are keyed by
      `sliceKey`'s result, so a duplicate is one row silently overwriting
      another in all three and the re-validator would report the key-set
      mismatch as a _solver_ fault), and a **fractional** width — `width: 0` is
      already refused twice upstream, but `1.5` yields a perfectly finite
      duration and would reach the schema's `type: integer` as a malformed
      request the builder itself wrote. Contracts at `42b23ab5`, dirty=0: lint
      0, typecheck 0, **87 pass / 0 fail across 7 files**; domain unchanged at
      356/0.
      **`buildSolverPools` landed (2026-09-03)** in
      `build-solver-pools.ts`, with `poolIdsNamedBy` beside it because the
      request builder needs that same set for its own key-set checks. It emits
      **only the pools the request names**, not every size the project holds: a
      size for a team no slice is labelled with constrains nothing, and the
      request is hashed as a cache key, so shipping it would invalidate a cached
      result on an edit to a team this plan does not use. It enforces the
      schema's **cross-field invariant (4)** pre-spawn — `schedule.ts`'s
      `no size for pool ${poolId}` throw promoted to the wire — and refuses a
      size below 1 or fractional rather than clamping, because a pool of 0 slots
      is a plan of `Infinity` dates and clamping invents a slot nobody has. All
      three refusals watched red at `e61124c6`, 3 fail. Contracts at `e61124c6`,
      dirty=0: lint 0, typecheck 0, **94 pass / 0 fail across 8 files**.
      **`horizonUnits` and both pre-spawn overflow refusals landed
      (2026-09-03)** in `solver-preflight.ts` as
      `preflightSolverRequest(slices)`, returning `parseSolverResponse`'s
      discriminated shape rather than throwing — the failure token is what the
      cached row records. The horizon is the SERIAL bound
      `max(0, ...notBeforeUnits) + Sum durationUnits`, zero-seeded; the
      objective worst case is `Sum w(s) x horizonUnits`. **Both accumulate in
      `bigint` and convert only after comparing**, and that is not decoration:
      with a `number` accumulator the horizon check passes by having already
      lost precision above its own bound — the check failing OPEN. Watched red
      at `d665bef5`, 1 fail. The horizon is checked **first** on purpose: when
      both bounds break, the horizon is the cause and the objective failure its
      consequence, and naming the consequence sends a user to their priorities
      when the plan is simply too long. **MOVEMENT's own worst case
      `Sum |offset - baseline|` is NOT checked yet** and is owed — it needs
      `baselineOffsets`, which is 2.11's. Contracts at `d665bef5`, dirty=0: lint
      0, typecheck 0, **103 pass / 0 fail across 9 files**.
      **`STAGE_BUDGET_SPLIT` and its invariant landed (2026-09-03)** in
      `stage-budget.ts`: the constant `[0.60, 0.25, 0.15]` plus
      `isValidStageBudgetSplit`, a predicate rather than a one-off assertion
      because the builder must check whatever it is handed. It enforces the
      schema's stated builder invariant — that the three sum to 1 — which JSON
      Schema cannot express. **The tolerance's justification was WRONG on the
      first write and the gate caught it:** `0.6 + 0.25 + 0.15` is exactly `1`
      in doubles, not `0.9999999999999999`. The real case is order dependence —
      `0.7 + 0.2 + 0.1` is not `1` while `0.1 + 0.2 + 0.7` is — so an exact
      comparison would accept or refuse one authored split according to the
      order its shares were written in. Both the comment and the test now say
      the measured thing. Contracts at `de7cb086`, dirty=0: lint 0, typecheck 0,
      **113 pass / 0 fail across 10 files**.
      **`edges` landed (2026-09-04), the seam first.** `libs/domain/src/slice-edges.ts`
      now owns both rules and `schedule()` **calls** it, the direction
      `leafFloorsOf` went: the intra-item step chain (an inline `for` loop in
      the node loop) and the join (inline after it). `reachedSliceOf` moved with
      them, verbatim, retyped against a structural `EstimatedSlice` so the two
      modules do not cycle; it is exported from there and re-exported by the
      barrel, and no other file in the repository imported it — fe-01's
      `gantt-geometry.ts` has its own documented copy, untouched. **An edge's
      ends are named by POSITION (`{ leafId, at }`), never by `sliceKey`:** a
      plan may hand two slices of one leaf the same `stepId`, `groupByWorkItem`
      accepts that and the placement tells them apart by index, so a key-based
      edge list would merge them silently _before_ `buildSolverSlices` could
      refuse the duplicate. `schedule()` converts a position with
      `firstNodeOf(leafId) + at`; `buildSolverEdges` in
      `libs/contracts/solver/src/` converts it with `sliceKey`, which is the
      whole of what the contracts side does — the schema's `$defs/edge` comment
      calls that conversion "real work rather than a rename" and it is now the
      only work left in it. Its own guard is a BOUNDS check, not a
      `=== undefined` narrowing: indexing is typed as total here so the
      narrowing form is dead code eslint deletes, and `own.at(-1)` would have
      wrapped round to the last slice and keyed it silently.
      **Two measurements that changed what is written here.** (1) The emission
      order (every chain, then every external) is PRESERVED, not proven to
      matter: with the two loops swapped the whole 356-test pre-existing domain
      suite stays green and only the new order case fails, so the placement is
      order-insensitive on that corpus and the doc says so instead of claiming a
      contract. (2) The reach applied to the successor side inside the NEW file
      gives 348/17 across `schedule*`, which is what proves the refactor is
      wired rather than dead code. Gates on h2puni with `NX_DAEMON=false`:
      domain lint 0, typecheck 0, **365 pass / 0 fail across 28 files** at
      `74fa84a5`; contracts lint 0, typecheck 0, **118 pass / 0 fail across 11
      files** at `59ee41bf`; dirty=0, 0 emitted `.js`.
      **The grouping is published too (2026-09-04)**, and it was the last
      prerequisite the assembly had: `libs/domain/src/slice-groups.ts` exports
      `groupSlicesByLeaf`, moved out of `groupByWorkItem` with both refusals —
      a slice for a non-leaf, and a width that is not a whole number of people —
      and `groupByWorkItem` now calls it and keeps only the `offsets` half,
      which is `durationOf`'s calendar arithmetic and has no place on the wire.
      It is generic over the slice type so `schedule()` and the request builder
      share one grouping over two shapes. This is the same argument as the edge
      seam and it is not decorative: an edge names its ends by leaf and
      **position**, so two groupings would disagree about which slice a position
      is — silently, inside a request Bun itself wrote. Watched red: the width
      refusal disabled in the moved file gives 367 pass / 3 fail, of which
      exactly one is the new file's own case (it adds five, 365 → 370), so two
      are the pre-existing `schedule` cases and the pass genuinely consumes the
      moved refusal.
      **The assembly landed (2026-09-04) and 2.2 is done**, in
      `build-solver-request.ts`. Almost nothing in it is its own, which is the
      measure of the slices above: every one of the thirteen required members
      comes from a seam that owns its rule. Its own content is the **order** and
      **one refusal**. The order is content — `groupSlicesByLeaf` runs before
      any projection, so a slice belonging to a parent is refused naming the
      _plan_ rather than being keyed first and refused later by a message about
      positions in a group, and so the edge builder reads the identical
      grouping. The refusal is the direction nothing guarded anywhere:
      `preflightSolverRequest` throws on a slice with no baseline entry, which
      is `slices ⊆ baselineOffsets`, and a baseline key **no slice names** had
      no reader at all — `revalidate-solver-result.ts` indexes
      `request.baselineOffsets[key]` by the request's slices, so it walks the
      same subset direction. Watched red: the check disabled gives 145 pass / 1
      fail and the one failure is the new case; nothing else in 146 tests
      notices.
      **Its third argument is a record, not `baseline`, and that is argued
      rather than drifted:** `contractVersion` is
      `"<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"`, and neither
      `solverVersion` nor `budgetMs` is a fact about the plan — three of the
      thirteen members are facts about the process about to start.
      `baselineOffsets` stays **passed in** rather than computed inside, which
      is the substance of the original name: PRI and Time are two calls over one
      plan, MOVEMENT is measured against the baseline in both, and computing it
      twice is two chances to score the two runs against different schedules.
      `baselineOffsets` and `fastHint` are deliberately the same map — two
      questions with one answer today, kept apart on the wire so a later warm
      start cannot silently move the objective's origin.
- [x] 2.3 `parseSolverResponse(raw: string)` — **the named framing seam.**
      Rejects anything that is not exactly one well-formed JSON line: two
      lines, trailing text after a valid line, empty stdout, an unknown
      `status`, an unknown key, a missing key. Lands in
      `libs/contracts/solver/src/`, which the same commit made a **compiled and
      linted** directory: `libs/contracts` included `src/**` only, so a module
      here would have been exercised by the suite (its target runs with `cwd:
libs/contracts` and bun scans recursively) and never typechecked or
      linted — measured, with both includes at their old values a real type
      error in `solver/src` gives `tsc` exit 0 and zero errors.
      It returns a **result**, never a throw: every rejection is the
      coordinator's `invalid-output`, which is a value it records, and four
      refusal codes distinguish the four distinct repairs — `empty-output`,
      `not-one-line`, `malformed-json`, `schema-violation`. Text after a valid
      line on the SAME line is `malformed-json` rather than `not-one-line`,
      deliberately: one is a framing fault and the other is a serialiser fault.
      The structural half is written against the constants `wire-types.ts`
      exports and `wire-types.test.ts` pins to the schema, and **the golden
      corpus is its oracle** — every response fixture is enumerated out of the
      manifest and run through the parser, which fails if it accepts one the
      schema rejects or rejects one it accepts. That is the manifest's own
      stated contract, so no second copy of the schema's rules exists to fall
      out of step, and this is why 2.3 needs no JSON Schema validator
      dependency. **Note for 2.1:** the response corpus has no unknown-key
      fixture (only `request/invalid-unknown-key.json`), so that case is
      covered by 2.5's raw-string cases and not by the corpus.
- [x] 2.4 `revalidateSolverResult(request, response)` — every offset present and
      non-negative, every edge respected, every `notBeforeUnits` floor
      respected, no pool over capacity at any instant (checked against **all**
      of a slice's `poolIds`, since the whole width is spent in each), no
      assignee double-booked, **every effective deadline respected**, and
      `objectiveValues[T].value` recomputed from
      the final offsets and matched. The deadline clause is stated on the
      **materialised** schedule in the real fractional domain —
      `lastWorkdayOf(start, finish) <= effectiveDeadlineOffset` for every slice
      — and **not** in quantised units, because checking it in units would
      re-implement the inclusive-ceiling rounding a second time and could
      disagree with the End date the column prints, the same argument
      `sameOrder` already makes. A violation is `invalid-output`, never
      `plan-infeasible`: a solver that returns a feasible schedule breaking a
      deadline is a broken engine, not an infeasible plan
      (`openspec/changes/work-item-deadline/design.md` §3.6). Every objective `value`, `stageValue` and
      `bound` **on the wire response**, and every recomputed `PRIORITY`,
      `MAKESPAN` and `MOVEMENT` in quantised solver units, must be a
      non-negative safe integer; an unsafe value is `invalid-output`. This is
      the wire rule and runs before the publication guard; the _stored_
      numeric domain follows `publication` and is 4.12b's rule, not this one
      (Sol r12 Critical 1).
      **`value` is the only recomputed field**
      (Sol r7 Critical 1): `stageValue`, `bound` and `status` are statements
      about a stage, not about the published schedule, and a later stage may
      legitimately improve an earlier term below its own incumbent, so
      recomputing against `stageValue` would reject valid answers. The one
      cross-field relation that must hold **is** checked: `value <= stageValue`
      whenever both are present, because every later stage adds an inequality
      at `stageValue` and a published value worse than it is a real contract
      violation. **Watched red:** a response whose `value` disagrees with the
      offsets is rejected; a response whose `value` is strictly better than
      `stageValue` is **accepted**; a response whose `value` is worse than
      `stageValue` is rejected.
      **Two of three halves landed** in
      `libs/contracts/solver/src/revalidate-solver-result.ts`: the placement
      rules (offset key-set equality, the 2.9 domain, floors, edges, pool
      capacity against **all** of a slice's `poolIds`, assignee non-overlap)
      and the objective arithmetic (the safe-integer wire rule, `value <=
stageValue`, and all three terms recomputed with a `bigint` accumulator
      so the check cannot round the overflow it exists to find). **The deadline
      clause is NOT implemented** and is the only part left: it is stated on
      the materialised schedule in the fractional domain, so it waits on 4.9's
      `materialiseOptimized`. It is named in the module header rather than
      stubbed. A fifth kind of refusal appeared that this slice did not
      predict — `malformed-request`, for a request that cannot support a
      verdict at all (duplicate slice key, an edge naming no slice, a pool
      membership with no capacity, a slice with no baseline offset). Blaming
      the solver for those sends the repair to the wrong side of the seam.
      **THE DEADLINE CLAUSE LANDED, run 47, and it is a SECOND ENTRY POINT —
      that is a finding about the seam rather than a convenience.**
      `revalidateOptimizedDeadlines(request, placed)` sits at the foot of
      `revalidate-solver-result.ts`. It cannot live inside
      `revalidateSolverResult` because that function is signed
      `(request, response)` and the clause is stated on the MATERIALISED
      schedule: `materialiseOptimized` is signed on the DOMAIN plan — six
      positional arguments of planned rows, dependency edges, slices,
      not-before dates, pool sizes and dependency reach — while the wire
      request carries only quantised slices. (Those names are deliberately
      prose here rather than a run of code spans: they are one function's
      parameter list, and as an identifier enumeration rule (b) attributes them
      to the wire `request` tuple they partly overlap and reports a divergence
      that is not one. The signature itself is the source, at
      `materialise-optimized.ts:75`.) Folding it in would mean either
      widening that signature or re-deriving the domain plan from the wire, and
      re-deriving it would be a second copy of the canonicaliser. So the
      composition is the caller's, in this order: re-validate the wire pair,
      materialise, then check deadlines.
      The arithmetic is `lastWorkdayOf(start, finish) <= deadlineUnits /
      SOLVER_QUANTUM - 1`, in the real fractional domain. The `- 1` is
      `deadlineUnitsOf`'s `(D + 1) x quantum` read backwards: the wire bound is
      EXCLUSIVE on the finish, so the due day is one less than the day that
      bound names. A missing placement is `malformed-request`, not
      `deadline-violated` — the key sets are equal by construction once
      `materialiseOptimized` has returned, so a gap is our bug.
      **`deadline-violated` was added to `SOLVER_REVALIDATION_FAILURES` and to
      `REVALIDATION_DISPOSITIONS`** (`invalid-output`); the per-seam `Record`
      made the second one a compile error until it was decided, exactly as 2.5
      designed it to.
- [x] 2.5 **Proven by** `solver-contract.test.ts`: a valid response passes;
      each violation in 2.4 is rejected as invalid-output, one case each; and
      each of 2.3's six framing cases is fed to `parseSolverResponse` **as a raw
      string**, not through a child process — a process cannot reliably produce
      the two-line and trailing-text cases on demand.
      **Framing half landed** in
      `libs/contracts/solver/src/parse-solver-response.test.ts` — all six cases
      as raw strings, plus the corpus agreement suite. The file name differs
      from the one this slice guessed on purpose: the tests live beside the
      unit they prove, and 2.4's re-validator will bring
      `revalidate-solver-result.test.ts` with it. What remains here is 2.4's
      violation cases, which cannot be written until 2.4 exists.
      **Violation half landed** in `revalidate-solver-result.test.ts` — one
      case per placement and objective rule, each paired with its nearest legal
      neighbour. **And the clause that half could not reach: "rejected as
      _invalid-output_".** Until run 11 the disposition was prose in three
      module headers and a value nowhere, so no test could assert it and the
      coordinator writing `failureReason` had fifteen diagnosis tokens across
      three seams and a paragraph to re-derive.
      `solver-failure-disposition.ts` publishes it: `SOLVER_FAILURE_REASONS`
      (checked against `design.md`'s own CHECK constraint by regex, so the
      constant cannot drift from the column that stores it — the golden
      corpus's non-circularity argument applied to a second artefact), plus one
      `Record` per seam so a code added to any of the three failure lists is a
      compile error until somebody decides what it means.
      **The mapping is not a pass-through, and the trap is a real one:**
      `objective-overflow` is a member of BOTH `SOLVER_PREFLIGHT_FAILURES` and
      `SOLVER_REVALIDATION_FAILURES`, and it means opposite things — before the
      spawn it is the recorded reason verbatim, after it the reason is
      `invalid-output`. A mapping written by matching the token to the column's
      vocabulary, which the token does match, is right in one direction and
      wrong in the other while looking right in both. **Watched red, measured:**
      pass it through in the re-validation table and the suite goes 164/3, not
      the 164/1 the comment first predicted — the two enumerating cases fire
      too, because each states the rule over the whole list. Comment corrected
      to the measurement. Nothing outside the file notices, which is the half
      of the prediction that held.
      `malformed-request` maps to `internal-error`, not `invalid-output`
      (**assumption 1, run 11**, recorded in the module with its falsifier): it
      fires only on a request `buildSolverRequest` produced, so blaming the
      response would send the repair to the wrong side of the seam.
      **The one reason 2.5 was untickable is gone (run 47): 2.4's deadline
      clause exists and has its cases.** Eight of them in
      `revalidate-solver-result.test.ts`, each violation paired with its
      nearest legal neighbour in the house style: work running to the end of
      its own due day is ACCEPTED and one day past it is rejected; a
      fractional finish at 1.5 days spills into day 1 and breaks a day-0
      deadline while a finish at exactly 1.0 does not; a `null` deadline is
      unconstrained at 900 days; a missing placement and a fractional
      `deadlineUnits` are both `malformed-request`; and the loop is proved to
      read past its first slice.
      **TWO WATCHED REDS, MEASURED on h2puni at `4e78ae45`**, each aimed at a
      different half of the arithmetic, against the 31-test file:
      compare `Math.floor(earliestFinish)` instead of `lastWorkdayOf` -> **29
      pass / 2 fail**, and both failures are the exactly-met neighbours, which
      is what "the check has been aimed" looks like; drop the `- 1` from
      `deadlineUnits / SOLVER_QUANTUM` -> **29 pass / 2 fail**, and this time
      both failures are the violation cases, including the fractional one. The
      file was byte-restored with `cmp` between the two and again after, and
      the gate checkout re-verified `dirty=0`.
      **One repair on the way past:** the count test was named
      `covers all fifteen tokens across the three seams` while the
      vocabulary held seventeen, and `deadline-violated` made it eighteen. Both sides of its
      assertion derive the number, so the count in the name was decoration that
      could only go stale; it now names no number.
- [x] 2.6 **Proven by** `solver-request.test.ts`: a null-`days` slice becomes
      `ASSUMED_SLICE_WORKDAYS`; a width-3 slice of 6 days' effort becomes 2
      days; a `whole-item` and an `anchor-slice` plan produce different edge
      sets from identical rows; an unprioritised leaf gets `priorityWeight` 0.
      **Priority resolution is proved in both numeric directions (Sol r8
      Critical 7)**, because the unprioritised-leaf case alone passes under a
      minimum-across-ancestors rule too: leaf 5 under parent 1 resolves to 5,
      leaf 1 under parent 5 resolves to 1, and a null leaf under parent 7
      under grandparent 3 resolves to 7. **Watched red:** replace the import
      with a minimum-across-ancestors resolver and the first and third cases
      must fail. **The third fixture is deliberately 7-under-3 and not
      3-under-7 (Fable r18 Minor 2):** under the minimum rule
      `min({3,7}) = 3`, which is the same answer the nearest-ancestor override
      gives, so a 3-under-7 fixture stays green under the injected fault and
      an implementer sees one failure where two are promised. With 7 nearer,
      override gives 7 and minimum gives 3, so the case distinguishes the
      fault and still proves nearer-over-farther.
      **All four cases and the watched red are landed in
      `build-solver-request.test.ts`, and run 14 chunk 3 re-ran the red at
      `21161156` rather than trusting the comment: 156 pass / 1 fail**, the one
      being `resolves priority as a nearest-ancestor override, in both numeric
directions`.
      **"The first and third cases must fail" is corrected to one failure, and
      the reason bounds what the red can prove.** What is observable in the
      request is the `priorityWeight`, not the resolved priority. Under the
      minimum rule the three leaves resolve to 1, 1 and 3 instead of 5, 1 and 7,
      which collapses the distinct set from `{1,5,7}` to `{1,3}` — so the dense
      rank every leaf gets is recomputed and no single entry of the vector can
      be read as one leaf's resolution. The promise was written against a
      decomposition where each leaf had its own assertion; through the rank it
      is one failure of the whole vector. The resolver's directional proof is
      `libs/domain`'s; what this file asserts is that the builder **imports**
      it.
- [x] 2.7 **Negative check, watched red** — remove the dependency check from 2.4
      and watch the "edge violated" case pass when it must fail; then send
      the pre-quantisation `days / width` from 2.2 and watch 2.6's width case fail.
      `Proof:` comment names each removed check. Re-validation is the only thing
      standing between a wrong solver and a published schedule; a check that
      cannot fail is exactly the failure mode AGENTS.md R5 names.
      **First half landed:** the `Proof:` block at the top of
      `revalidate-solver-result.ts` names twelve removed checks and the single
      case each one turns red, all run on h2puni. It records one check that was
      measured dead (an `Object.hasOwn` guard whose removal changed nothing) and
      deleted rather than documented.
      **The `days / width` half landed and closes this item.** Its `Proof:`
      block sits at the top of `build-solver-slices.ts`, watched on h2puni at
      `6160aebe`: `durationUnits(slice)` replaced by the pre-quantisation
      `days / width` — with `ASSUMED_SLICE_WORKDAYS` for a null estimate,
      undivided — gave **146 pass / 10 fail across 16 files**, and the spread is
      the finding. The fault is caught in **five** files, not one: 2.6's width
      case as the plan promised, both `buildSolverSlices` cases, the golden
      request corpus in two places, all three baseline-feasibility cases and the
      projection pairing in `quantised-baseline.test.ts`. A duration is not one
      field's business — it is the horizon, the offsets, the objective and the
      bytes — so an unquantised one is refused by the arithmetic, by the fixture
      and by the re-validator independently. The one that would have caught it
      _alone_ is the golden corpus, because every other assertion derives from
      these same seams.
      **Re-run at `21161156` in run 14 chunk 3 rather than trusted: 145 pass /
      12 fail.** The two extra failures over `6160aebe` are the live-constraint
      feasibility cases added that run, which is the expected direction — a
      sixth reader of the same duration.
- [x] 2.8 `SOLVER_QUANTUM = 48` exported from `libs/domain`, and
      `durationUnits(slice)` = `Math.ceil(durationOf(slice) * SOLVER_QUANTUM)`
      with an exact-multiple assertion within `DRIFT` before the ceiling
      applies. **Fast's real arithmetic, restated because the plan had it
      wrong:** `durationOf` returns `ASSUMED_SLICE_WORKDAYS` for `days === null`
      **without** dividing by `width`, and `days / width` otherwise **without**
      calling `snapWorkdays`; `snapWorkdays` only removes drift near an integer
      and preserves genuine fractions. **Watched red:** a `days: 1, width: 2`
      fixture must read 0.5 workdays end to end; a `days: null, width: 3`
      fixture must read `ASSUMED_SLICE_WORKDAYS`, not a third of it.
      **Landed** in `libs/domain/src/solver-quantum.ts`, with `durationOf`
      **exported** from `schedule.ts` rather than restated — the plan restating
      it is how both arms came to be wrong in the first place. The snap is
      `snapWorkdays` itself, applied to the product rather than to the duration:
      `durationOf`'s result is a genuine fraction that must not be snapped (0.2
      is not drift) and only the product is supposed to be a whole unit, so the
      domain keeps ONE 1e-9 window. `workday.ts`'s "applied at the discrete
      calendar boundaries and nowhere else" is corrected to name this fourth
      site and to carry the reason the window survives the change of unit: a
      sixth of a day is eight solver units, so `DRIFT` is still nine orders
      below the smallest real fraction an estimate can quantise to.
      `durationRoundedUp(slice)` ships beside it because 2.2 records the
      per-slice rounding, and the alternative was 2.2 multiplying and comparing
      against its own copy of the drift window.
      **Three watched reds, each on the h2puni gate at `b1b6201c`:** the snap
      dropped for a bare ceiling → 332/1, failing the overshoot case ALONE
      (`65/6` workdays over width 5 is exactly 104 units and the double is
      `104.00000000000001`, which a bare ceiling reads as 105); the ceiling
      dropped → 331/2, the rounding case plus the integrality invariant across
      all 96 widths; the assumption divided by `width` in `durationOf` → 332/1.
      **That third count is the finding:** breaking Fast's own assumed arm fails
      NO pre-existing test in the 327-test domain suite. Nothing held that arm
      until this slice did, which is exactly why the plan could restate it wrong
      and go unnoticed.
      **A defect this slice CREATED and closed in the same run:** publishing
      `durationOf` put a caller outside `groupByWorkItem`, which refuses
      `width < 1` precisely because `durationOf` divides by it — a width of 0 is
      `Infinity` days for a slice with effort and `NaN` for one without. Since
      `Math.ceil(Infinity)` is `Infinity`, an unrefused width would have reached
      the wire as a _duration_ and been diagnosed there as the builder's own
      request violating its own schema. `quantise` now throws, which is
      `groupByWorkItem`'s own choice on the same input: malformed input, not a
      missing default. A null estimate never divides, so it stays finite at
      every width and stays an answer. Watched red: guard deleted -> 343/1.
- [x] 2.9 The re-validator rejects any offset that is not a non-negative
      integer unit within `horizonUnits`. **Watched red:** feed it a
      fractional offset and a negative one.
      **Landed** in `revalidate-solver-result.ts`; the watched red disables the
      domain guard and fails that case alone, 69/1. `horizonUnits` bounds the
      OFFSET and not the finish, because it is the CP-SAT variable domain; a
      finish past the horizon is 2.4's makespan arithmetic.
- [ ] 2.10 `horizonUnits > 2**31 - 1` fails before spawn with
      `horizon-overflow`, and the `Σ w(s) × horizonUnits` worst case past
      `Number.MAX_SAFE_INTEGER` fails before spawn with `objective-overflow`;
      the same safe-integer ceiling applies to the worst-case `MOVEMENT` sum
      and every request/response objective integer. Bound calculation uses a
      `bigint` accumulator so the preflight cannot itself round an overflow.
      Both are **first-class members of the one failure state
      machine** (7.1), not a bare return from request construction: it writes
      the same `status='failed'` marker row and emits the same
      `schedule_optimization_failed` event as any other reason, so a client
      already showing `Optimizing…` reaches Retry rather than waiting on a
      child that was never spawned. **Watched red:** a synthetic plan past each
      bound must not reach a process, and both a connected client and a freshly
      loaded one must reach `Optimization unavailable · Retry`. A dense-rank
      fixture whose exact sum is `Number.MAX_SAFE_INTEGER` round-trips, while
      the same fixture at one greater never spawns; a response altered by one
      at the boundary is rejected rather than rounded to the same value.
      **MOVEMENT's half landed** with 2.11's baseline:
      `preflightSolverRequest(slices, baselineOffsets)` maximises
      `Σ |offset − baseline|` term by term as `max(b, horizonUnits − b)`, since
      an offset lives in `[0, horizonUnits]` and reaches one end of the axis or
      the other, never both. **Its overflow arm has no fixture, and that is a
      finding rather than an omission:** the check runs only after the horizon
      check passed, so every term is at most `2**31 − 1` and the sum needs about
      **4.2 million slices** to reach `MAX_SAFE_INTEGER`. The guard is against a
      future horizon bound, not a reachable plan, and the test asserts that term
      count rather than claiming coverage it does not have. PRIORITY's arm keeps
      its one-slice fixture because a weight is unbounded above. A slice with no
      baseline entry **throws** — the three key sets are equal by construction,
      so a gap is Bun's own bug and not a sentence to show a user; watched red,
      the guard removed still throws but as `TypeError: Cannot convert undefined
to a BigInt`, naming nothing.
- [x] 2.11 The **quantised Fast baseline**: re-run Fast's placement over the
      rounded durations to produce `fastHint` and `baselineOffsets` in integer
      units, and take stage 1's upper bound from **that**, never from real
      Fast. **Watched red** — the fixture that proves the earlier plan was
      wrong: three serial slices with `days=1, width=5` (real Fast finishes at
      28.8 units, the rounded model needs 30). Assert the hint is feasible,
      `MOVEMENT` is defined against it, and — via **task 4.11b, the real-domain
      publication guard**, which is where that comparison actually lives — the
      stored variant's primary term measured in the real domain is not worse
      than the real Baseline schedule's, falling back to Fast's own
      materialised schedule tagged `'quantisation-floor'` when quantisation
      costs more than the search won. Also assert the **request** carries the
      quantised offsets: on this fixture `baselineOffsets` and `fastHint` must
      be the 30-unit integer values, never real Fast's 28.8-unit ones, checked
      against the golden request fixture and `solver-wire.v1.json`.
      **Half landed** in `quantised-baseline.ts` (`quantisedFastBaseline`) and
      `fixtures/request/valid-quantised-baseline.json`. The baseline is Fast's
      own placement re-run through `schedule()` on a **rescaled input** — one
      unit becomes one "day", each slice handed over with
      `days = durationUnits(slice) × width` and its width untouched, so
      `durationOf`'s `days / width` returns `(u × w) / w`, which is exactly `u`
      wherever that product is a safe integer. Widths are people and pool sizes
      are slots, so neither scales; floors do, and the fold stays inside
      `schedule()` because `max(k·a, k·b) === k·max(a, b)` for `k > 0`.
      **Watched red:** `durationUnits` swapped for the real duration → 4 of 8
      tests fail, all at the safe-integer _product_ guard
      (`9.600000000000001 units across 5 people`), because a fraction times a
      width is not a safe integer either — so the whole-unit _offset_ check is a
      second net over the placement rather than what makes the rescale exact.
      The real-Fast contrast is asserted with the literals the arithmetic
      actually produces, `0 / 9.600000000000001 / 19.200000000000003`, not the
      clean 9.6/19.2 quoted above: the prefix sum of 0.2 drifts, so a converted
      baseline would carry a number that is neither integral nor the one anybody
      wrote down. **Still open here, corrected 2026-09-04 by reading the two
      tasks rather than remembering them:** taking stage 1's upper bound from
      the baseline is **5.9's**, not the assembly's — the wire has no bound
      field, all thirteen request members are listed in 2.1, and 5.9 spells the
      obligation out ("supplied as both a CP-SAT solution hint and an upper
      bound on stage 1's term"). The assembly discharges its half by carrying
      `baselineOffsets` and `fastHint`, which it now does and which
      `golden-request.test.ts` compares with the checked-in fixture. The
      real-domain comparison is 4.11b's.
      **The feasibility assertion landed at `e097a116` in
      `baseline-feasibility.test.ts`, and the sentence above it that said "has
      no test" was stale when run 14 read it.** It feeds the baseline back
      through `revalidateSolverResult` as a `feasible` response, asserts
      `{ ok: true, published: true }`, adds a not-vacuous case and an
      objective-mismatch case, and does not reimplement the checker. Run 14
      chunk 2 wrote a second copy of that claim in `quantised-baseline.test.ts`
      before finding it; chunk 3 deleted the duplicate.
      **What survived the deduplication is the part that was genuinely missing,
      and it is measured rather than argued** (`21161156`). 2.11's own plan has
      no edge, no pool, no person and no floor, so those three cases exercise
      one of the pass's five placement rules — the intra-item step chain. With
      `poolSizes` replaced by an empty map inside `quantisedFastBaseline`, a
      baseline that ignores capacity entirely, the contracts suite goes
      **147 pass / 10 fail** and **not one of them is in that describe**: there
      is no pool on that plan for a pool-blind baseline to violate.
      `the quantised baseline on a plan whose every constraint is live` now
      sits beside it in the same file — a floor written on a **parent** so the
      fold is `leafFloorsOf`'s walk, an authored edge across two leaves, a
      two-step leaf, a shared pool of two, a person queue — and it fails under
      that red. It asserts `request.fastHint` equals the baseline **first**, so
      a builder that stopped copying one into the other could not pass by
      validating the other map, and **MOVEMENT is exactly 0** because the
      offsets _are_ the `baselineOffsets`. Its objective terms are computed
      from the request's own `durationUnits` and `priorityWeight` rather than
      hand-worked as 2.11's plan allows, because a floor fold, a dense rank and
      two widths decide them here.
      **Second watched red, same head:** `scaleFloors` dropped from
      `quantisedFastBaseline` — unscaled floors on the unit axis — →
      **154 pass / 3 fail** against a green 157 / 0 across 15 files.
      **Deadlines are deliberately not applied to the
      baseline** — they constrain the solver, not Fast — so "the hint is always
      feasible" is a claim about edges, floors, pools and queues, and a plan
      whose baseline misses a deadline is 3.1's `plan-infeasible`.
      **Measured gap worth knowing before trusting a manifest entry:** the
      **request** branch of the golden corpus has no TypeScript consumer —
      `parse-solver-response.test.ts` filters to `branch === 'response'` and
      nothing filters to `'request'`. Those fixtures exist for the Python
      entrypoint's `jsonschema` pass, which does not exist yet, so adding an
      entry does not mean the schema validates the file today. The fixture is
      instead pinned structurally against `SOLVER_REQUEST_KEYS` and
      `SOLVER_SLICE_KEYS`, which catches shape drift and not value-range drift.

## 3. Cache, slot and queue tables (PROD MODE — reviewed PR, no self-merge)

- [x] 3.1 `optimized_schedule_cache` in `apps/be-01/src/repository/schema.ts`:
      composite PK `(projectId, inputHash, objective, contractVersion,
budgetMs)` → `generation`, `status`
      (`'ok' | 'failed' | 'plan-infeasible'`), `resultJson`
      (NULL iff failed), `failureReason` (NULL unless failed), `createdAt`.
      Integrity is declared, not assumed: `projectId` FK to `project(id)`
      `ON DELETE CASCADE`; `CHECK (status IN ('ok','failed','plan-infeasible'))`;
      `CHECK ((status='ok' AND resultJson IS NOT NULL AND failureReason IS
NULL) OR (status='failed' AND resultJson IS NULL AND failureReason IS
NOT NULL) OR (status='plan-infeasible' AND resultJson IS NOT NULL AND
failureReason IS NULL))`; `CHECK (objective IN ('pri','time'))`.
      **Assumption A1 (TASK-219, dev mode): the `plan-infeasible` payload
      reuses `resultJson`**, holding a versioned `PlanInfeasibleResult` —
      `{ dtoVersion, items: [{ ownerWorkItemId, boundWorkItemId,
effectiveDeadlineOffset }] }`, `ownerWorkItemId === boundWorkItemId` when
      a leaf's own date binds — discriminated by the row's own `status` rather
      than by a fourth nullable column. Rationale: `resultJson` is already the
      row's versioned payload with a decoder whose failure is already defined
      as `corrupt`, and a fourth column would add a fourth CHECK arm and a
      second decode seam for one state. **Consequence that must be stated, not
      implied:** a `plan-infeasible` row whose `resultJson` fails to decode
      reads as `corrupt` on exactly the same rule as an `ok` row does, and is
      therefore retryable, while a decodable one is not. **Falsified if** the
      offending-item list ever needs to be queried by SQL rather than read
      whole, at which point it becomes its own table and this assumption is
      wrong rather than merely superseded.
- [x] 3.2 `optimization_generation`: PK `(projectId, contractVersion)` →
      `generation` (integer not null), `inputHash` (text nullable),
      `cancelEpoch` (integer not null default 0), `admissionState`
      (`'open' | 'draining'`, not null default `'open'`), `updatedAt`. This is the sole
      home of the generation identity; it is deliberately **not** on `project`,
      because `SCHEDULER_CONTRACT_VERSION` is bumped while blue and green run
      against one file and a single project-row pair would let the release
      computing H1 and the release computing H2 alternately increment one
      counter and delete each other's rows for ever.
      `solver_slot`: PK
      `(projectId, contractVersion, generation, objective, budgetMs)` →
      `ownerId`, `attemptToken`, `lifecycle` (`'starting' | 'running'`, with
      `CHECK (lifecycle IN ('starting','running'))`) and
      `CHECK (objective IN ('pri','time'))` on the key's own `objective`
      column (Fable r18 Important 1 — the blanket stored-enum rule covers it
      and every instantiating list omitted it), nullable `pid` (NULL
      while `starting`, since the process does not exist at reservation time
      — Sol r12 Critical 2), `startedAt`, `heartbeatAt`,
      `cancelRequestedAt`, `admittedDeadlineAt`. **`budgetMs` is in the key and
      the deadline is a stored absolute instant (Sol r8 Critical 2, kimi r8
      Important 3)**: `budgetMs` is a cache-key column, so without it a 60 s
      and a 120 s solve for one objective collapse into one row, the
      liveness lookup behind `pending`/`retrying` and Retry's `already-running`
      cannot be evaluated against the full key at all, and a coordinator
      configured at the smaller budget reclaims a larger-budget child that is
      still inside its own deadline. `solver_queue`: PK
      `(projectId, contractVersion, objective, budgetMs)` — **not** keyed by generation,
      so a project holds at most one queued entry per objective **per budget**
      per contract version (the PK's own bound; an entry that did not name its
      budget could not tell the dequeue which budget to launch, which is why
      `budgetMs` is in the key) and a new generation replaces rather than
      accumulates — with
      columns `generation`, `admittedCancelEpoch`, `budgetMs`, `enqueuedAt`,
      `CHECK (objective IN ('pri','time'))` on the key's own `objective`
      column (Fable r18 Important 1), and
      an index on
      `(enqueuedAt, projectId, contractVersion, objective, budgetMs)`. The
      dequeue order is
      `ORDER BY enqueuedAt, projectId, contractVersion, objective, budgetMs`,
      which is total (Sol r7 Minor 15): `objective` breaks the tie between a project's
      PRI and Time entries enqueued in the same millisecond, and
      `contractVersion` breaks the tie between blue and green enqueuing the
      same project and objective in that same millisecond. All three companion
      tables carry `projectId` FK to `project(id)` `ON DELETE CASCADE`, so
      deleting a project cannot leave rows consuming the global 16-slot budget.
      Retirement: an `optimization_generation` row untouched for
      `GENERATION_RETENTION_DAYS = 30`, or whose contract version is retired at
      deploy, first enters `admissionState='draining'` and is deleted only by
      the drain protocol in 3.9b.
- [x] 3.1b `project.optimization_delete_pending_at`, internal nullable
      timestamp, in **this** slice's additive migration (Sol r12
      Important 5). It is the durable cross-process fence 3.9b's drain and
      its process test read, not a user setting and not a read-payload
      field, so it must exist before any drain code lands; slices 3 and 3b
      ship as separate reviewed PRs, so leaving it in 3b made this slice
      unimplementable against its own declared schema. Repository mapping is
      internal-only; the read payload is unchanged. Covered by 3.7's
      `down.sql` and its rollback-then-re-apply proof.
- [x] 3.3 Forward migration under `apps/be-01/drizzle/` — additive only. Blue
      and green share one SQLite file during a swap, so the outgoing release
      must keep running against the migrated file untouched.
- [ ] 3.4 **Proven by** `optimized-schedule-cache.db.test.ts`: forward migration
      creates the four tables; it is idempotent on an already-migrated file; a
      rollback and re-apply leave every pre-existing table intact; the outgoing
      release's queries still run after the migration; each CHECK rejects its
      malformed row (an `ok` row with a NULL `resultJson`; a `failed` row
      with one; an unknown `objective`); and deleting a project cascades its
      cache rows away only through `finishOptimizationDrain` after the real
      slot count reaches zero.
- [x] 3.5 **Negative check, watched red** — drop the status/nullability CHECK
      and watch 3.4's "an `ok` row with a NULL `resultJson` is rejected" case
      fail. `Proof:` comment names the removed constraint. SQLite text columns
      otherwise hold any combination a past bug wrote.
- [ ] 3.6 This slice touches `apps/be-01/drizzle/**`, a prod-mode path: PR with
      green CI and a real review, `status: review`, no self-merge.
- [x] 3.7 `down.sql` beside `migration.sql` — AGENTS.md mandates it, migration
      lint and `readMigrationFolders` refuse without it, and an aborted
      blue/green deploy cannot return to the applied set. Proved by
      apply → rollback → re-apply against the applied set, not by inspection.
      The rollback assertion **enumerates** what this slice added — the
      **four** tables `optimized_schedule_cache` (3.1),
      `optimization_generation`, `solver_slot` and `solver_queue` (3.2), plus
      `project.optimization_delete_pending_at` (3.1b) — rather than counting
      them. **The count is four, not three (Fable r14 Important 1):** "three
      companion tables" beside the cache is the phrase this enumeration was
      written from, and an implementer building `down.sql` from a
      three-item list ships a rollback that strands one table — the aborted
      blue/green failure this task exists to prevent.
- [x] 3.8 `CHECK (failure_reason IS NULL OR failure_reason IN
('timeout','invalid-output','no-solution','internal-error','oom',
'horizon-overflow','objective-overflow'))` — any non-null text was
      previously accepted. `optimization_generation.admission_state` also has
      `CHECK (admission_state IN ('open','draining'))` plus an explicit read
      validator; it is a scalar enum, not an enum hidden in `resultJson`.
      **`solver_slot.lifecycle` is the third one and was missing its validator
      (Fable r14 Important 2):** 3.2 declares its `CHECK` inline, but a
      `CHECK` alone is not the stored-enum rule — it gets an explicit read-time
      validator beside `admission_state`'s, throwing and naming the column and
      the stored value, and the negative test below injects an unknown
      lifecycle exactly as it does for the other scalar enums.
      **`solver_slot.objective` and `solver_queue.objective` are the fourth and
      fifth, and were missing everything (Fable r18 Important 1):** both are
      `'pri' | 'time'` in their own scalar column and in their table's PK, both
      now carry the inline `CHECK` declared at 3.2, and both read paths get the
      **existing** `isObjective` validator — the validator list does not grow,
      only the column list does, because these are the same stored enum the
      cache's `objective` column already validates. The dequeue is why this is
      not cosmetic: it reads `solver_queue.objective` into the typed spawn
      identity (6.3), so a row corrupted by a past bug would launch a
      garbage-objective solve whose failed-marker write then violates the
      cache's own `CHECK (objective IN ('pri','time'))` — no marker and no
      `schedule_optimization_failed` event could ever be written for that key,
      which is the unnotified wedge rounds 7-12 spent closing, reached through
      the one column the sweeps never audited.
      **Negative injection, watched red:** write `'prio'` directly into
      `solver_slot.objective` and into `solver_queue.objective` with the
      `CHECK`s dropped, and each read path must throw naming the column and the
      stored value; remove either validator and the corrupted row must reach
      the spawn identity instead.
      **Landed** in `repository/optimizer-rows.ts` — one guard per enum, five
      guards over seven validated columns, and one row decoder per table, which
      is the read boundary every repository read of these four tables goes
      through. Proved by `optimizer-rows.db.test.ts`, 16 cases: each corrupt
      value is first shown REFUSED on write by its own `CHECK`, then stored
      under `PRAGMA ignore_check_constraints = ON` and shown to throw on read
      naming the column and the value. Mutation-proved three ways — dropping
      `toSolverQueueRow`'s guard reds that one case and no other, dropping
      `toSolverSlotRow`'s lifecycle guard the same, and dropping the pragma
      reds all seven injections at once, which is what proves the rows are
      landing past live constraints rather than past absent ones. **The last
      clause's own wording lands at 6.3**, which is where a spawn identity
      first exists; the obligation is written into 6.3 rather than left here.
- [ ] 3.9 **Proven by** `optimization-generation.db.test.ts`, run through the
      production repositories: a blue/green pair with two distinct
      `contractVersion` values neither reallocates nor deletes the other's
      rows, while a real plan edit still fences both; and a retired contract
      version's rows are removed with everything keyed to them, **after the
      drain below**. **Watched red:** move the generation back onto `project`
      and the blue/green case must fail.
- [ ] 3.9b **Deletion and retirement are two-phase cancel-and-drain, proven by
      a real two-coordinator process test** (Sol r10 Critical 2).
      `optimization-drain.proc.test.ts` samples the **real OS process count**
      throughout, not a mocked spawner. Name and implement two repository/service
      seams: `beginOptimizationDrain(projectId, contractVersion?)` and
      `finishOptimizationDrain(projectId, contractVersion?)`. Begin is one
      transaction: for contract retirement it sets the targeted generation's
      `admissionState='draining'`; for project deletion it first sets the durable
      `project.optimization_delete_pending_at` marker and then sets every one of
      that project's generation rows to `draining`; it also advances
      `cancelEpoch`, stamps `cancel_requested_at` on the affected `solver_slot`
      rows, and deletes the affected `solver_queue` rows. Both admission and
      dequeue transactions reject a generation unless `admissionState='open'`
      and reject any project carrying `optimization_delete_pending_at`. The
      project is hidden from ordinary reads and writes as soon as that marker
      commits, but its physical row remains to keep slot rows and their capacity
      accounting alive. The system then drains, leaving those slot rows
      **counted and undeleted** until each is released by its owner or passes
      its stored `admittedDeadlineAt`. Finish runs in a transaction, observes
      zero affected slot rows while the same durable closed state still holds,
      and only then deletes the generation or project row and lets the
      `ON DELETE CASCADE` take the remainder. The
      cascade remains declared as the orphan backstop, not the mechanism.
      **Finish is not the initiator's job (Sol r12 Critical 3).** A crash
      between `begin` and `finish` previously left the project hidden with
      admission closed for ever, and admission is exactly what a draining
      project rejects, so no later read could sweep it. Two further paths
      call the same transactional `finish`: (a) **opportunistic** — every
      slot release and every reclaim sweep re-reads the durable marker in the
      same transaction that removes the last affected row and finishes when
      zero remain; (b) **reconciliation** — `reconcileOptimizationDrains()`
      on coordinator startup and every `DRAIN_RECONCILE_INTERVAL_MS = 60000`,
      scanning `draining` generations and delete-pending projects, reclaiming
      affected slots past their stored `admittedDeadlineAt`, and finishing
      those with none left. Both are idempotent, no-ops on an absent target,
      and safe to race: the precondition is the lock, and the loser observes
      the row already gone. Neither path reopens admission.
      **Third watched red:** crash immediately after `begin`, restart a
      _different_ coordinator, advance past slot expiry, and require physical
      project deletion, optimization-row cleanup and terminal contract
      retirement with admission still closed throughout; remove the
      reconciler and the project must stay wedged and undeletable. Two
      reconcilers run concurrently must produce the same end state and no
      error.
      **Watched red:** restore the immediate slot cascade — delete the project
      row while its child still runs — and the sampled process count must
      exceed 16 as a second project admits into the freed capacity. A second
      red uses two coordinators: one begins a drain while the other attempts
      both admission and dequeue; removing either closed-state predicate must
      let work start after the zero-slot observation and before final deletion.

## 3b. Project settings columns and API (PROD MODE — reviewed PR, no self-merge)

**This slice was on 4.1's critical path, not beside it (run 32); 3b.1 cleared
it in run 33 and 4.1 closed in run 34.** The conditional insert could not be
written until `optimization_enabled` existed, so slice 4's write half was
blocked here rather than on effort. What remains in this slice is the mapper,
the read payload and the write API — none of which slice 4 waits on.

- [x] 3b.1 Additive migration on `project`: `optimization_enabled` boolean not
      null default **false**, `schedule_engine` text not null default `'fast'`,
      and `schedule_objective` text not null default `'pri'` — **three
      columns, all user-facing settings**. `optimization_delete_pending_at`
      is **not** here: slice 3's drain code and its process test read that
      column, and the two slices ship as separately reviewed PRs, so a marker
      created only in 3b left slice 3 unimplementable against its own
      declared schema (Sol r12 Important 5). It moves to 3.1b. The defaults are
      what make OFF-by-default true for every existing row; no backfill can
      guarantee that retroactively. The generation counter, the input hash and
      the cancel epoch are **not** added here (Sol r7 Critical 4): they are per
      contract version and live in the `optimization_generation` table slice 3
      creates.
      **Closed run 33 chunk 1** (`e3848d09`, 1247 green).
      `20260904140000_add_project_settings` adds the three columns with the
      defaults written into the `ADD COLUMN`, so no existing row is ever ON for
      an instant. `optimization_delete_pending_at` stays where 3.1b put it.
- [x] 3b.2 Repository mapping in `apps/be-01/src/repository/project.ts`; the
      three settings in the project read payload; a PATCH contract in
      `project.controller.ts`/`project.service.ts` under the **existing
      project-write authorization** — these are project settings, so a reader
      may not change them.
      **Read half closed run 35 chunk 1** (`37bd608d`, 1260 green); the PATCH
      contract is what remains. `Project` declares the three, `toProject`
      destructures and validates the two text ones, `listFor` selects them, and
      `withholds the optimizer settings until the read payload declares them`
      is **deleted** rather than left to pass — replaced by `publishes the
three project settings in the read payload`, which asserts the inverse by
      name and still refuses `optimizationDeletePendingAt`.
      **The write shape split off from the read shape.** `create` now takes a
      `NewProject` — `Project` without the three settings, each optional — and
      fills them from `DEFAULT_PROJECT_SETTINGS` before the INSERT, answering
      the completed row rather than its own input. Requiring them on the create
      path instead would have made twenty call sites and fixtures each restate
      `false`/`fast`/`pri`, any one of which could drift from the migration
      without a test noticing; `a project created without settings agrees with
the columns own defaults` inserts a second row in raw SQL naming neither
      settings column and compares the two reads, so the constant and the
      `ADD COLUMN` defaults are proved equal rather than assumed.
      **Repository patch half closed run 35 chunk 2** (`fa28a041`, 1262 green).
      `ProjectPatch` carries the three, each moving on its own so a project
      switched off keeps the engine and objective it was on. `update`'s
      empty-patch guard stopped being one `=== undefined` line per key and
      became `Object.values(patch).every(...)`: the list would have grown by
      three here, and a key added without its line is a patch that silently
      reads instead of writing.
      **HTTP contract closed run 36** (`4eebaa44`). The three are optional
      members of `projectPatch` on the **existing** `PATCH /api/projects/:id`
      rather than a settings route of their own, so they inherit
      `ProjectService.update`'s authorization unchanged — the item's "a reader
      may not change them" is then a property of where the fields were put, not
      a second rule that could drift from the first. `scheduleEngine` and
      `scheduleObjective` are unions built from `SCHEDULE_ENGINES` and
      `SOLVER_OBJECTIVES`, the same arrays 3b.1's `CHECK`s enumerate, imported
      as values from `repository/schema.ts` because `repository/index.ts` is
      type-only on purpose (`directory.service.ts` takes that path for
      `PERSON_KINDS`). Without the union an unknown engine is a 500 from the
      database on write, or a throw from `toProject` on every later read; with
      it, one 422.
      The route change moved `apps/be-01/openapi.json`, whose committed copy is
      gated against the live app — regenerated with
      `bun apps/be-01/src/openapi/emit-openapi-cli.ts` on h2puni, +51 lines.
- [x] 3b.3 A `project_settings_changed` variant on `ProjectEvent`, emitted by
      `ProjectService.update` when any of the three change, carrying the new
      values. `schedule_optimized` stays reserved for stored solver results.
      **Closed run 36.** The event carries all three values whatever moved,
      unlike `capacity_changed`/`priority_bands_changed` which carry nothing:
      those say "read again" about a list fetched beside the tree anyway, and a
      reader handed one fresh field beside two stale ones cannot tell which it
      has. `schedule_optimized` is deliberately **not** declared — a settings
      change announced as a result would tell a client a schedule had been
      recomputed when nothing ran.
      **"When any of the three change" is read off the stored rows**, before
      and after, not off which keys the patch named. A settings panel with three
      controls re-sends all three every time one is touched; keyed on the patch
      that would wake every open client to repaint what it is already showing.
      **The broadcaster became a REQUIRED `ProjectServiceOptions` member**, and
      sixteen construction sites paid for it. Optional-with-a-no-op default was
      the cheaper edit and fails where it matters: a service built without one
      answers `200` to every settings PATCH while no client is ever told, and
      only a test looking specifically for the event can see it. This is **not**
      the `NewProject` trade in 3b.2 — there the call sites would each have
      restated a _value_ that could drift from the migration, here they pass a
      collaborator that cannot drift from anything. Test sites take a fresh
      `recordingBroadcaster()` rather than the suite's shared one, so setup
      through `ProjectService` cannot pollute a suite that counts published
      events.
- [x] 3b.4 **Proven by** `project-settings.db.test.ts` and
      `project.controller.test.ts`: an unmigrated row reads
      `false`/`fast`/`pri`; a PATCH of each setting survives a reload; a
      read-only collaborator's PATCH is refused and emits nothing; a successful
      PATCH emits exactly one `project_settings_changed` and no
      `schedule_optimized`.
- [x] 3b.5 **Negative check, watched red** — make `optimization_enabled`
      default true and watch 3b.4's unmigrated-row case fail. `Proof:` comment
      names the changed default. A toggle that defaults ON silently starts
      solvers for every existing project on deploy.
      **Closed run 33 chunk 1.** Watched on h2puni at `e3848d09`: with the
      migration's default flipped to `1`, `leaves a project written before it
switched off, on the fast engine` fails (2 pass / 2 fail against 4 pass /
      0 fail). The `Proof:` comment on that case names the changed default.
- [ ] 3b.6 This slice touches `apps/be-01/drizzle/**`, the **second** prod-mode
      path in this change: PR with green CI and a real review, `status:
review`, no self-merge.
- [x] 3b.7 `down.sql` plus rollback-then-re-apply coverage that names and
      removes **each of the three** columns this slice adds
      (`optimization_enabled`, `schedule_engine`, `schedule_objective`); the
      assertion enumerates them rather than counting, so a column left behind
      is schema drift the test catches. `optimization_delete_pending_at`
      belongs to slice 3's own `down.sql` (3.1b, 3.7).
      **Closed run 33 chunk 1.** `down.sql` names all three and no more; the
      test enumerates rather than counts, and re-applies onto the rolled-back
      file comparing the whole stored `CREATE TABLE`, so a dropped `CHECK` is a
      diff. Watched: deleting the `schedule_engine` drop line reddens three of
      the four cases.
- [x] 3b.8 `CHECK (optimization_enabled IN (0,1))`, `CHECK (schedule_engine IN
('fast','optimized'))`, `CHECK (schedule_objective IN ('pri','time'))`,
      and explicit read-time validators `isScheduleEngine` /
      `isScheduleObjective` in the project mapper that throw naming column and
      value — the shape `toProject` already uses for `estimateMethod`,
      `depReach` and `estimateRounding`. **Watched red:** write an unknown
      value for each of the three and the boolean directly and read through
      the production path.

## 4. Cache read/write, generations, validity and the failed marker

      **DDL half closed run 33 chunk 1**, validator half open. All three
      `CHECK`s are in the migration and proved by `refuses a value outside each
      column vocabulary`, which drives each one through a direct `UPDATE` and
      keeps an accepted control beside the three refusals; removing the
      `schedule_objective` `CHECK` reddens it. They are **not** declared as
      table-level `check()`s in `schema.ts`, because `project` already exists
      and each is a column constraint on an `ALTER TABLE … ADD COLUMN` — a
      table extra would describe a `CREATE TABLE` no migration writes.
      `isScheduleEngine` / `isScheduleObjective` wait on 3b.2's mapper.

      **Validator half closed run 35 chunk 1** (`37bd608d`). `isScheduleEngine`
      lives in `optimizer-rows.ts` beside the other stored-enum validators and
      over a new `SCHEDULE_ENGINES` in `schema.ts`; both refusals go through
      that file's `unknownStoredValue`, so `project.schedule_engine` reads the
      same sentence as every optimizer column. **There is no
      `isScheduleObjective`**, and the name in this item is superseded:
      `project.schedule_objective` stores the vocabulary `isSolverObjective`
      already checks, so it is a fourth validated **column** rather than a
      second validator over the same two strings — the growth
      `optimizer-rows.ts`'s own header forbids after Fable r18 Important 1.
      `optimization_enabled` gets no validator either: drizzle reads it through
      `{ mode: 'boolean' }` and can only produce `true` or `false`, so its
      `CHECK` is the whole guard and 3b.5 already watched it.
      **Watched red** on h2puni at `37bd608d`, `bun test project.db.test.ts`,
      baseline 28 pass / 0 fail: the guard removed and the value cast →
      27 / 1 for `schedule_engine`, and 27 / 1 again for `schedule_objective`,
      each reddening only its own case.

- [x] 4.1 Repository functions: read the pair for the full key; write an `ok`
      row; write a `failed` row; allocate the next generation in the
      `optimization_generation` row for `(projectId, contractVersion)` **and**
      delete that contract version's older-generation cache and queue rows in
      one transaction — **slot rows are not deleted**, because freeing the
      count before the children are proved dead is what let six real children
      run while SQLite counted two. Neither write is a blind `upsert`: each is
      a conditional insert whose transaction first asserts the writer's own
      live `solver_slot` row still carries its `attemptToken`, and whose
      `WHERE` also requires the generation still current for that contract
      version, the cancel epoch unchanged, and `optimization_enabled` still 1.
      A superseded run therefore cannot store, evict, overwrite an `ok` with a
      `failed`, or emit a second outcome record for one key.
      **Closed in run 34, in the order run 32 measured.** `readOptimizedPair`,
      `writerStillHolds` (the slot and its `attemptToken`) and
      `admissionStillCurrent` (the generation and the cancel epoch, read as one
      row so a concurrent allocation cannot land between two lookups) landed
      first and are separately proved. `optimizationStillEnabled` is the fourth
      predicate; it reads `project.optimization_enabled`, the column **3b.1**
      added, which is why 3b.1 was a hard prerequisite of this item rather than
      a parallel settings nicety. `storeOptimizedOutcome` composes all four
      inside one transaction and inserts conditionally
      (`onConflictDoNothing`) rather than upserting, returning `stored`,
      `superseded` or `already-recorded` — three distinguishable facts,
      because "I was overtaken" and "this key already has an outcome" are not
      the same event to a coordinator. The primary key omits `generation`, so
      two generations of one key collide by construction and the legitimate
      replacement path stays `allocateGeneration`'s delete rather than an
      overwrite. **Composing three of four was forbidden and did not happen**:
      the write and the fourth predicate landed in the same chunk.
      `Proof:` `optimized-cache.db.test.ts`, eight cases and four mutations —
      dropping the enabled predicate reds 2, the slot token 1, the
      generation/cancel-epoch pair 2, and making the insert unconditional 1.
      **Still open under 4.1b:** the `MAX_LIVE_BUDGETS` retention bound, which
      is a rule about which other rows survive a commit.
- [x] 4.1b Retention, both rules. (1) Allocation deletes that contract
      version's older-generation cache rows. (2) A committing outcome keeps the
      `MAX_LIVE_BUDGETS = 2` most recently written budgets for
      `(projectId, objective, contractVersion, inputHash)` and deletes the
      rest. **Rule 2 is a bound, not an exclusion** (Sol r7 Important 9): the
      earlier "delete every other row whose `(inputHash, budgetMs)` differs"
      made a budget change a livelock, because a config change is not a code
      change, so blue and green can read 60000 and 120000 under one
      `contractVersion` and each deleted the other's row on every store —
      alternating solves for ever on an unchanged plan and holding the 4/16
      ceilings busy. The per-contract generation table cannot fix that; only
      the bound can. The bound every artifact states is **`MAX_LIVE_BUDGETS`
      (2) rows per project per objective per live contract version, so at most
      4 outcome rows per project per live contract version** — never "two rows
      total", and never "superseded rows are deleted when their replacement
      commits", which is the exclusive rule this task struck (Sol r8 Important
      8). **Proven by** (a) raising `budgetMs` three times and
      bumping `contractVersion` with no plan edit, asserting at most two rows
      per project per objective per live contract version; and (b) a two-release
      fixture reading different budgets against one file — each stores once,
      each then hits its own row, and the injected spawner sees exactly two
      solves across ten alternating reads. **Watched red:** restore the
      exclusive rule and (b)'s spawn count must rise with every read.
      **State, run 34: both rules are implemented and (a) is proved; (b) is
      not, and cannot be here.** Rule 1 is `allocateGeneration`'s existing
      delete; rule 2 is `MAX_LIVE_BUDGETS` in
      `optimized-schedule-cache.ts`, enforced inside 4.1's write transaction
      only on the path where an insert actually landed, ordered by `createdAt`
      then `budgetMs` (both descending — two rows written in one millisecond
      would otherwise evict whichever SQLite happened to return first) and
      deleted by full primary key. `Proof:` `optimized-cache.db.test.ts`,
      proof (a) — three raised budgets plus a `contractVersion` bump with no
      plan edit leaves 90k and 120k under blue and 60k under green — plus the
      state the exclusive rule made impossible: two budgets under ONE contract
      version both surviving and both servable. **(b) needs the injected
      spawner, which is 4.2's and does not exist**, so its spawn count and the
      watched red under it stay open; the row-level half of the same claim is
      what landed. Three mutations red their own case: raising the bound to 3,
      dropping `contractVersion` from the bound's scope (in the count _and_
      the delete — dropping it from the count alone changes nothing, because
      the delete's own `contractVersion` predicate masks it, so that predicate
      is defence in depth rather than the load-bearing one), and ordering
      ascending so the newest is evicted.

      **(b) closed run 37 chunk 4, once 4.2's spawner existed.** Two releases
      read one file at 60 s and 120 s, alternating, ten times; each asks for a
      solve on its own first read and never again, so the spawner sees exactly
      two calls in ten reads and both releases end on a hit. The loop stores the
      outcome whenever a read asks for one, which is what a coordinator does, so
      the spawn count IS the solve count.
      **The rows are `ok` and not `failed`, and that is the whole difference
      between a proof and a vacuous case:** a `failed` row suppresses an
      auto-spawn all by itself (4.4), so with the failed rows the existing
      row-level case uses, the count would be two whether the rows survived or
      not. **Watched red:** the exclusive rule restored — the bound replaced by
      "delete every row whose `budgetMs` differs from the one committing" —
      reddens this case on its own `asked` assertion plus both row-level cases,
      49 / 0 down to 46 / 3 on h2puni at `68dd999d`. Lowering the bound to 1
      reddens the same three, which is the same claim from the other side.

- [x] 4.2 **Proven by** `optimized-cache.db.test.ts`: same input → hit with
      **zero calls on the injected spawner** (asserted on the spawner, not on
      elapsed time); a changed effort, edge or pool → miss; a `contractVersion`
      bump → miss; a **raised `budgetMs` → miss** (the old smaller-budget row is
      not served); a `status='failed'` row never satisfies a read and is
      overwritten by the next run for that key; a new generation deletes every
      prior row for that project including its `failed` ones; an undo to a
      previous hash misses; and a row whose `resultJson` fails to decode is
      **left in place** and reads as `corrupt` (4.8), never deleted and never
      treated as a miss.

      **The spawner exists, run 37 chunk 1.** It is a repository-level
      injection and not the coordinator's: `readOptimizedPairAndSpawn` reads the
      pair and then calls an injected `Spawner` once per objective that has no
      answer, so the count is assertable in this file without admission, slots
      or a queue. The policy is the pure exported `objectivesToAutoSpawn`, which
      spawns on `miss` and on nothing else — `ok` is the answer, `failed` and
      `plan-infeasible` are answers about the solve and the plan, and `corrupt`
      is a defect whose row 4.8 keeps. It iterates `SOLVER_OBJECTIVES` rather
      than naming the two, so the request order is the stored vocabulary's.
      Each request carries the key the read ran against rather than a rebuilt
      one, because `budgetMs` is a key column: a spawner given the project and
      the objective alone could not tell which of 4.1b's two live budgets asked.
      `Proof:` five cases — a full hit spawns nothing, a cold key asks for both
      in order, one committed objective asks for exactly the other, a raised
      budget asks again rather than serving the 60 s row, and a failed row
      beside a corrupt one asks for nothing while both rows survive.
      **The eviction half closed in run 37 chunk 2**, three more cases, and it
      settles what "a failed row is overwritten by the next run for that key"
      means: **nothing UPDATEs it.** The primary key omits `generation` and
      4.1's insert is `onConflictDoNothing`, so the only replacement path is
      `allocateGeneration`'s delete, which is scoped by project and contract
      version and says nothing about status — a Retry allocates, the prior rows
      go, `failed` ones included, and the next read asks for both objectives
      again. An undo to a previous hash misses for the same reason: the edit's
      own allocation cleared the answer computed for it, and the intermediate
      hash's answer belongs to a key nobody is asking about. The third case is
      the delete's scope, proved through the spawner: green allocating must not
      clear blue's rows, or the two releases evict each other on every deploy —
      4.1b's livelock reached through rule 1 instead of rule 2.
      **That third case was vacuous on its first draft and its own mutation
      caught it.** Generations are per contract version, so green's FIRST
      allocation is number 1 and its delete of everything below 1 reaches
      nothing whatever the predicate says; the case passed identically with
      `contractVersion` dropped from the delete. It now allocates twice — a
      deploy and then an edit — which is the only sequence that discriminates
      the scope.

- [x] 4.3 **Negative check, watched red** — let a `status='failed'` row satisfy
      a read and watch the "never satisfies a read" case fail. `Proof:` comment
      names the relaxed predicate. Serving a failure marker as a schedule would
      publish an empty plan as an optimized one.
      **Closed run 36 chunk 2.** The relaxed predicate is `outcomeOf`'s
      `status === 'failed'` branch in `optimized-schedule-cache.ts`, rewritten
      to answer `{ kind: 'ok', result: <empty plan> }`. Watched on h2puni at
      `4eebaa44`: **32 pass / 4 fail** against a 36 / 0 baseline for
      `optimized-cache.db.test.ts`. The named case is one of the four; the other
      three all store a failure and read it back, so the relaxation cannot be
      made to look local.
      The `Proof:` comment sits on that case and names the branch, the rewrite
      and both counts.
      **This item did not need 4.2's spawner**, which is why it closed ahead of
      the item it is numbered under: it is a property of the read's own dispatch
      on `status`, and the read landed in run 35.
- [x] 4.4 A `failed` row suppresses an automatic re-spawn for its exact key and
      blocks neither an explicit Retry nor a new hash's generation.
      **Proven by** a case in `optimized-cache.db.test.ts`: ten reads by three
      collaborators against a failed key spawn nothing; **a same-hash edit
      spawns nothing**; a Retry on the same key spawns exactly one; a new hash
      spawns the normal pair.

      **Closed run 37 chunk 3, four cases.** The ten reads each get their own
      spawner, so a total of zero is zero per collaborator rather than a total
      that cancels out; the same-hash edit is the eleventh of those reads, since
      an edit that leaves the canonical input alone produces the same key and is
      therefore not a new event at all.
      **A Retry is a second entry point, `retryOptimizedPair`, and not a flag on
      the read.** That is the whole of why 4.5 is hard to reintroduce: the
      suppression is a property of which function the caller reached for, where
      a boolean with a default is exactly the shape that lets `failed` rejoin
      the automatic set while every call site still compiles. Its policy is the
      mirror of the automatic one — everything that is not `ok`, because `ok` is
      the only state with an answer to serve, so `failed`, `corrupt` and
      `plan-infeasible` are all states a person looking at "Optimization
      unavailable · Retry" is asking about. A Retry that answered a
      `plan-infeasible` row with nothing would be a button that does nothing on
      the row the user is looking at; it will very likely answer the same way
      again, and that is the user's minute to spend.
      The last arm goes through `allocateGeneration`: a new hash allocates, the
      allocation clears the failed row with everything else, and the read for
      the new plan asks for the normal pair.

- [x] 4.5 **Negative check, watched red** — put `failed` back into the
      auto-spawn set and watch 4.4's "ten reads spawn nothing" case fail.
      `Proof:` comment names the restored branch. Every read becoming a re-solve
      is the timer retry Dany explicitly rejected, wearing a different hat.
      **Closed run 37 chunk 3.** The restored branch is `objectivesToAutoSpawn`
      in `optimized-schedule-cache.ts`, its predicate widened from
      `kind === 'miss'` back to `kind !== 'ok'`. Watched on h2puni at
      `f1ed862c`: **44 pass / 4 fail** against a 48 / 0 baseline for
      `optimized-cache.db.test.ts`, script `/home/puni1/mut44-r37.sh`. The named
      case is one of the four; the other three each read a settled non-`ok` row
      and count its spawns, so the widening cannot be made to look local.
      Note the shape of the failure it prevents: a re-solve **once per open
      tab** is worse than the timer that was rejected, not merely equal to it.
- [x] 4.6 **ABA fence, proven by** `optimization-generation.test.ts`: run hash
      A, edit to B (cancelling A), undo to A, then let the original A child
      return a valid result. Its write is rejected, no rows are deleted, no
      `ok` row becomes `failed`, and no event is emitted.

      **Closed run 37 chunk 5, two cases**, and they live in
      `optimized-cache.db.test.ts` rather than in the file this item names.
      **Assumption, with what would falsify it:** the fence is a property of
      `storeOptimizedOutcome`'s admission predicate, and that write and its
      scaffolding — an admitted seat, a claim with an overridable generation —
      are all in the cache test; the generation file tests the allocator, which
      is the other half of the pair and not the half being fenced. Falsified if
      the fence ever needs to observe allocator-internal state the cache test
      cannot reach, at which point the case moves rather than being duplicated.
      **The two cases split the two predicates deliberately.** The ABA case does
      **not** bump the cancel epoch: both predicates would refuse that write,
      and a case that trips two fences proves neither — 4.7's watched red
      removes the generation predicate and must see this fail, which it cannot
      if the epoch is also refusing. The second case is the epoch's own arm with
      the generation unmoved. Each is reddened by exactly the predicate it is
      about.
      **The one part not asserted, and why:** "no event is emitted" holds
      because nothing at this layer emits one. Events are slice 7's, and the
      assertion that a refused write publishes nothing belongs with them.

- [x] 4.7 **Negative check, watched red** — drop the generation predicate from
      4.1's conditional write and watch 4.6 fail. `Proof:` comment names the
      removed predicate. `inputHash` alone cannot tell a resurrected run from a
      current one, which is the whole reason the generation exists.
      **Closed run 37 chunk 5.** The removed predicate is
      `current.generation === claim.generation` in `admissionStillCurrent`.
      Watched on h2puni at `d91717f4`: **48 pass / 3 fail** against a 51 / 0
      baseline, script `/home/puni1/mut46-r37.sh`. The other two that redden are
      the predicate's own unit case and 4.1's superseded-writer case. Dropping
      the cancel-epoch comparison instead reddens a disjoint three, which is
      what makes the split above worth having.
- [x] 4.8 `isOptimizedStatus` / `isObjective` / `isFailureReason` validators on
      the cache read path, throwing rather than casting or defaulting.
      **Watched red:** an unknown value for each, injected as a stored row.
      A row whose `resultJson` fails to decode is **left in place**, not
      deleted (Sol r7 Important 13): the earlier "delete it and treat it as a
      miss" contradicted the decoder throwing, contradicted AGENTS.md R5, and
      silently turned corruption into a read-triggered solve — the timer retry
      Dany rejected, arriving through the cache instead of the clock. The
      variant reads as the sixth state `corrupt`, carrying the decoder's
      message; it never satisfies a read and never auto-spawns, exactly like
      `failed`, and Retry overwrites it through the ordinary admission path.
      **Watched red:** write a truncated and a wrong-`dtoVersion` `resultJson`
      directly, read through the production path — the row survives, the
      payload reads `corrupt` with the reason, ten reads spawn nothing, one
      Retry produces exactly one child; then restore the delete-and-miss
      behaviour and the spawn-count case must fail.

      **Closed run 37 chunk 6.** All three validators were already wired into
      `toOptimizedScheduleCacheRow` and only `objective` had a case; `status`
      and `failure_reason` now have their own, each injected past the column
      `CHECK` with `PRAGMA ignore_check_constraints = ON` — the constraint is
      the first fence and the validator is the second, and this item is a claim
      about the second. Removing each guard in turn reddens exactly its own
      case, 53 / 0 down to 52 / 1 three times.
      The corrupt half's spawn-count case landed too: ten reads of a
      wrong-`dtoVersion` row ask for nothing and leave both rows in place, and
      one Retry asks for exactly that objective.
      **Second watched red:** `corrupt()` rewritten to return `MISS` — the
      delete-and-miss behaviour this replaced — takes 54 / 0 to **47 / 7**,
      the ten-read case among them. Seven is the honest number and not a
      failure of scoping: every case that reads a payload the decoder refuses
      is a case about this function, and there are six of them besides the
      spawn count.

- [x] 4.9 `materialiseOptimized(canonicalInput, offsets)` in `libs/domain`
      is what produces the `schedule` member of `resultJson`; the offsets map
      is never persisted or
      returned as a schedule. Fast has **no** annotation-only pass to call, so
      **this task begins** by splitting `placeSlices` into
      `chooseStarts(canonicalInput)` and `annotate(canonicalInput, starts)`,
      proved behaviour-preserving by the existing Fast golden corpus **before**
      anything optimized is built on it; `materialiseOptimized` is then
      `annotate` over the dequantised
      offsets. `annotate` replays the person and pool ledgers in ascending
      start with ties broken by the canonical slice order, calling the
      **existing** `jointWindowFor(poolIds, …)` and `reserve(poolIds, …)`
      unchanged — the whole width in **every** named pool, which is what
      `Slice.poolIds` and Dany's 2026-08-13 decision 3 say and what Fast does
      (Sol r7 Critical 3). "First pool in sorted `poolIds` with free capacity"
      is struck: it was a different resource model that could accept a
      materialised schedule overbooking a second team, and a different
      resource-successor graph, float and wait count. **The floor is
      resolved by Fast's own loop, not by comparing the joint window to the
      pinned start (Sol r8 Critical 1, kimi r8 Critical 1):** build
      `[predecessor, stepOrder, notBefore, person, capacity=w.start]` in that
      order and take a candidate only when it is **strictly** later than the
      running answer, so a tie keeps the floor named first and `capacity`,
      last, loses every tie — `schedule.ts` 1234–1252 verbatim. Only then
      compare `pinnedStart` to the resolved start: equal keeps the resolved
      `boundBy`; strictly later is `optimizer`, asserting
      `jointWindowFor(…, pinnedStart).start === pinnedStart`; strictly earlier
      is `invalid-output`. The struck three-way split reported `capacity` for
      the common unmoved slice — where `jointWindowFor` returns `binding: []`
      by construction, so `capacityTeamId` had no rule and
      `capacityPredecessorIds` was empty beside `boundBy: 'capacity'`,
      violating the render invariant — and reported `optimizer` for a slice
      merely pinned at its predecessor floor. `capacityPredecessorIds` is
      `jointWindowFor`'s accumulated blocking set across rounds and pools
      **filtered by `finishesByStart` (`placed[b].finish <= start`)**, which is what
      `placeSlices` does at 1271–1308: the scan is conservative and records
      reservations that may legally continue alongside the slice, and
      promoting one into the backward graph gives it a late finish before its
      early finish and negative public float. The same filter applies to each
      binding pool's candidate set before `capacityTeamId` is chosen — the
      pool whose **valid** blockers hold the latest finisher, ties by pool id —
      and to the resource-successor edges. `annotate` derives from those
      ledgers the resource-successor edges `lateTimes` consumes — so `duration`, `estimated`, earliest/latest, `float`,
      `critical`, `boundBy`, `resourcePredecessorId`, `capacityPredecessorIds`,
      `capacityTeamId`, `width`, `effort`, the work-item projections and both
      wait counters come out of the one code path that produces them today,
      with resource edges and late times derived from the **optimized**
      placement rather than copied from Fast.
      **FOUR SEAMS EXIST NOW (run 38), so `annotate` is a composition rather
      than a fifth transcription.** `placeSlices` no longer decides any
      per-slice fact inline: `resolveFloor(candidates)` is the floor rule
      verbatim — the whole point of it being one function is that the struck
      three-way split cannot come back through a second copy;
      `annotateCapacity(key, boundBy, start, window, finishOf, placedAtOf)`
      returns `capacityPredecessors`, `capacityTeamId` and the referent, with
      both invariants and the `finish <= start` filter, and reaches the ledgers
      through accessors precisely so a caller holding different arrays can use
      it; `tileFinish(anchor, start, at, offsets)` is the anchor and the exact
      `held.start + (offsets[at + 1] - offsets[held.at])` finish, which a
      materialiser accumulating `start + days` would get wrong in the last bits
      with nothing watching (seed 260); and
      `resourcePredecessorOf(boundBy, busy, referent)` is the bar's one named
      resource. Each is mutation-proved in the run-38 log.
      **DO NOT BUILD THE SPLIT AS A PRODUCTION COMPOSITION.** `placeSlices`
      stays ONE pass and `annotate` is a separate replay the materialiser
      calls. Running `annotate(input, chooseStarts(input))` inside
      `placeSlices` doubles Fast's placement loop, and the 600-slice benchmark's
      20ms budget is modelled at a 3.81ms geometric mean with p99.99 13.3ms, so
      doubling puts the extrapolated p99.99 past it. (That benchmark
      plan names no pools, so what doubles is the loop, not the joint-window
      search; the conclusion is an extrapolation of the recorded model, not a
      measured two-pass run.) The behaviour-preservation proof 4.9 asks for is
      therefore a **test** asserting `annotate(input, chooseStarts(input))`
      equals `placeSlices(input)` over the Fast golden corpus.
      **BUILT AND PROVED (run 39), except its name.** `placeSlices` takes an
      optional `pinnedStarts: readonly number[]` and `schedule()` an optional
      `pinnedStarts: ReadonlyMap<string, number>` keyed by slice key; the loop
      stays one loop and the four seams above run unchanged and once. The fifth
      seam, `pinFloor(key, resolved, pinned, windowFrom)`, holds the whole
      three-way comparison — equal keeps the resolved `boundBy`, strictly later
      is `'optimizer'` after `jointWindowFor(…, pinned)` answers `pinned`, and
      strictly earlier is `ScheduleInvalidOptimizedStartError`. **Both of those
      comparisons are `withinDrift`, not `===`** (run 40 chunk 2 for the floor,
      run 41 chunk 1 for the pool re-ask), and the accepted start on each equal
      branch is the PLAN's own double — the floor's, and the pool release's —
      never the pin's, so the schedule stays on one axis. The re-ask on the
      later branch also **replaces** the window with the one asked from that
      accepted instant, whose `binding` is empty because the search is then its
      own fixpoint, which is what keeps `annotateCapacity`'s render invariant
      true under a non-`capacity` floor.
      The behaviour-preservation test is green over all eight corpus cases,
      comparing `slices`, `workItems` and both wait counters rather than the
      dates. **The entry point closed in run 40:**
      `materialiseOptimized` exists by that name in
      `libs/contracts/solver/src/materialise-optimized.ts` — **not** in
      `libs/domain`, deliberately: `schedule()` already owns the one placement
      pass and the quantum is a fact about CP-SAT the domain is kept clear of.
      It takes Fast's own six arguments plus the wire `offsets`, which are keyed
      by `sliceKey` already, so there is no node-id resolution step and the
      whole conversion is one division plus two refusals. Details and both
      refusals: 4.11.
- [x] 4.10 The floor precedence is the complete ordered list `projectStart |
predecessor | stepOrder | notBefore | person | capacity | optimizer`; the
      earlier list stopped at `notBefore` and would have labelled a
      person-bound or capacity-bound optimized slice `optimizer`, erasing its
      resource predecessor, its team and both wait counts.
      `ScheduleFloor` gains the additive member `'optimizer'`, used exactly
      when a start is strictly later than every floor of its slice — an
      optimizer may deliberately idle a low-priority slice and that start has
      no value in today's union. `floorWordsOf` gains its case. The render
      invariant holds: under `'optimizer'`, `resourcePredecessorId` is null,
      `capacityPredecessorIds` is empty and `capacityTeamId` is null, so
      "set exactly when `boundBy === 'capacity'`" is still true.
      **DONE (run 39).** `ScheduleFloor` and fe's `BindingFloor` both carry the
      member, `FLOOR_SENTENCE.optimizer` is `Placed here by the optimizer` — the
      one sentence naming no cause, because an optimizer's objective is a whole
      plan's trade-off and no per-slice reason survives it — and `floorWordsOf`
      answers it from the arm that needs nothing from the caller. The render
      invariant is asserted rather than argued: the idled-slice case checks
      `resourcePredecessorId` null, `capacityPredecessorIds` empty,
      `capacityTeamId` null and `waitingForCapacity` 0. Removing the switch arm
      reddens `says in words what a start is held by` alone (1 of 130).
- [x] 4.10b **Two orders, not one** (Sol r7 Important 7). Ledger replay is
      chronological (ascending start, canonical tie-break); the order handed to
      `lateTimes` is a **topological** order of the augmented graph — plan
      edges, step-order edges and the reconstructed resource-successor edges —
      computed by Kahn with the ready set drained in ascending
      `(start, canonical slice order)`, so it stays fully determined by the
      hashed input. Chronological order is not topological on legal data:
      `durationOf` preserves an explicit `days: 0`, `windowFor` treats a zero
      duration as legal no-work, so a zero-duration predecessor and its
      successor can share a start and the id tie-break can order them
      backwards — after which `lateTimes`, which walks its `order` backwards
      and immediately reads `late[next].latestStart`, reaches the predecessor
      before the successor has a `Late`. Fast is audited for the same hazard in
      this slice and fixed the same way if `placeSlices`' placement order can
      produce it.
      **Half of this is answered by run 39's design and half is still open.**
      The materialiser drains the **eligible set** in ascending
      `(start, canonical slice order)`, and because that set is Kahn's ready set
      — a node is admitted only once its plan predecessors are placed — the one
      order it produces is chronological _and_ topological, so the hazard cannot
      arise on this path rather than being detected on it. That is measured, not
      argued: forcing the drain back to Fast's priority comparator makes a legal
      optimized schedule (a person's two slices swapped against their
      priorities) **throw** `invalid optimized start`, because the second slice
      is then below a person floor its own replay created. What is NOT yet
      written is this task's own watched red — the zero-duration predecessor
      whose id sorts after its successor — and Fast's audit for the same
      hazard. **Watched red:** a two-slice fixture with a zero-duration
      predecessor whose id sorts **after** its successor, sharing one start —
      passing chronological order to `lateTimes` must throw or produce a wrong
      `latestStart`, and the topological order must not.
      **DONE (run 40 chunk 4).** Fast's arm and the audit landed in runs 38 and
      39 in `schedule-placement-order.test.ts`; the optimized arm is now beside
      them. It earns its own case because the pinned comparator is
      `(pinned start, canonical order)`, and on this fixture — both slices
      pinned at 0, `a`'s key sorting before `z`'s — that comparator READ ON ITS
      OWN gives the wrong order. Kahn overrules it: the eligible set admits `z`
      first and `a` only once `z` is placed, so the two are never in the set
      together and the comparator never gets to invert them. Every backward-pass
      number is asserted equal to Fast's at the same starts.
      **Proved from both sides.** M8 — replacing the drain with a chronological
      `(start, key)` sort before `lateTimes` — reddens 3 of 433, both arms of
      this fixture among them, which is the watched red above. M9, the control,
      inverts the pinned comparator's tie-break and reddens **nothing** (433
      pass / 0 fail), which is what proves the case is about Kahn rather than
      about the comparator sitting in front of it.
- [x] 4.11 Materialiser proofs run **through the real plan-read payload**
      (`work-item.service.ts`), not against the domain type. **Watched red:**
      (a) return Fast's own annotations against optimized dates — the float
      and `boundBy` assertions must fail; (b) report a deliberately idled
      slice as `projectStart` instead of `'optimizer'`; (c) set
      `capacityTeamId` on an `'optimizer'` slice — the render invariant test
      must fail; (d) **the contended two-pool case, on the production path**
      (Sol r7 Critical 3): one slice naming two pools that each have room only
      after different reservations end, so the joint window is later than
      either pool's own earliest fit. Reserve into only the first pool and the
      second pool's capacity assertion must fail; take `capacityPredecessorIds`
      from the releases at exactly the pinned start and the accumulated-set
      assertion must fail; take `capacityTeamId` as the first sorted pool and
      the latest-finisher assertion must fail; (e) **the long-plus-short
      capacity-2 case** (Sol r8 Critical 1): pool size 2, long width-1 A on
      0–10, short width-1 B on 0–5, an optimized width-1 X pinned at 5 — drop
      the `finish <= start` filter and X must report A as a capacity
      predecessor, adding an A→X edge that gives A a late finish before its
      early finish and exposes negative public float; (f) **the unmoved slice
      at its predecessor floor with pool room** (kimi r8 Critical 1): restore
      the three-way `w.start === pinnedStart` split and the slice must report
      `boundBy: 'capacity'` with an empty `capacityPredecessorIds` and a null
      `capacityTeamId`, failing the render invariant.
      **THE WIRING IS BUILT (run 40); the six proofs above are not.**
      `materialiseOptimized` takes Fast's own six arguments plus the offsets and
      lives in `libs/contracts/solver/src/materialise-optimized.ts`,
      beside `quantisedFastBaseline` and as its exact inverse — the baseline
      multiplies Fast's workday axis up to whole units for the wire, this
      divides the units the solver answers in back down and hands them to
      `schedule()` as `pinnedStarts`. It is NOT a second `libs/domain` entry
      point on purpose: `schedule()` already owns the one placement pass, and
      the quantum is a fact about CP-SAT that the domain is deliberately kept
      clear of. There is no node-id resolution step to build — the wire's
      `offsets` are keyed by `sliceKey` already, so the whole conversion is the
      division plus two refusals.
      **Two refusals are this boundary's own and `schedule()` cannot make
      either.** An offset that is not a whole non-negative unit divides to a
      start half a unit off the axis every other start sits on, and where that
      start is above its floor the plan accepts it — measured, not argued: with
      the fractional offset on the SECOND slice `schedule()` refused it for its
      own reason and the case stayed green with the guard deleted (M2), so the
      case now pins it on the first slice against a `projectStart` floor of 0.
      And an offset key naming no slice in the plan is invisible to
      `schedule()`, which reads `pinnedStarts` through its node list and so can
      only refuse the converse; the surplus check therefore runs AFTER the
      placement, against `placed.slices`, because that map IS the node set and a
      key set derived here would be a second copy of the leaf grouping.
      **THE ULP HAZARD WAS REAL AND IS NOW CLOSED (run 40 chunk 2).** Chunk 1
      named it as open; chunk 2 measured it and it was not a corner case. Over
      every width 1–1000 and every offset 1–480 whose real duration is an exact
      unit multiple, **106,142 of 480,000 pairs drift**: 53,451 put the
      dequantised pin strictly BELOW Fast's floor, where `pinFloor`'s `<` threw,
      and 52,691 strictly above, where its `===` missed and the slice sitting on
      its own floor was labelled `'optimizer'`. The sharpest form is that
      **`schedule()` refused the plan's own quantised baseline** — reproduced
      before the fix on `days: 5/12, width: 5`, exactly 4 solver units:
      `0.08333333333333333 is before its stepOrder floor at 0.08333333333333334`.
      Fixed by comparing within the domain's existing drift window rather than
      with `===`: `withinDrift(a, b)` joins `snapWorkdays` in `workday.ts`,
      sharing the one `DRIFT`, because that function snaps towards a WHOLE day
      and two values can be a ulp apart at 0.083 with no whole number near them.
      The equal branch keeps the FLOOR's double, not the pin's, so the schedule
      stays on one axis. The window cannot hide a real violation: the solver
      places integers, so a genuinely early start is early by at least
      `1 / SOLVER_QUANTUM` = 0.0208 of a day against a 1e-9 window — asserted,
      not argued, by a case that fails if `DRIFT` is widened past a unit.
      **AND THE SAME ULP WAS REACHABLE IN THE POOL RE-ASK, one branch below the
      floor — closed in run 41 chunk 1.** Run 40 named it open and unproved; it
      needs no exotic fixture. A slice of `1 / 48` of a day pinned at solver
      unit 7 releases its pool at `7/48 + 1/48`, one ulp ABOVE unit 8, so a
      block the solver abutted there — the commonest thing an optimizer does —
      came back refused: no room in its pools at `0.16666666666666666`, the
      earliest being `0.16666666666666669`. `window.start !== pinned` is now
      `withinDrift(window.start, pinned)`, and **the accepted start is the
      POOL's double**, by the floor branch's own rule one line up: the pin would
      otherwise sit one ulp inside a live reservation, which over-allocates the
      profile. The window is re-asked from that instant so it is the search's
      own fixpoint — `binding: []`, which is what keeps `annotateCapacity`'s
      render invariant true, since a non-empty `binding` under `'optimizer'`
      names a team on a slice no pool held up. Three mutations, each reddening
      exactly one case (`schedule-annotate.test.ts`): drop the re-ask, return
      the pin's double, or widen the comparison to 0.5.
      **THE SIX PROOFS ARE BLOCKED ON A SEAM THAT DOES NOT EXIST, and this is
      verified rather than suspected (run 41 chunk 3).** Every one of them says
      "on the production path" or "through the real plan-read payload", and that
      payload cannot serve an optimized schedule today:
      `apps/be-01/src/service/work-item.service.ts:1456` calls
      `schedule(rows, edges, slices, notBefore, slotsOf, project.depReach)` —
      six arguments, no seventh — so `pinnedStarts` is always `undefined` and
      the pass it drives is always Fast. The file imports nothing from
      `repository/optimized-schedule-cache.ts`, and **`readOptimizedPair` and
      `readOptimizedPairAndSpawn` have no production caller anywhere in
      `apps/be-01`** — grepped over the whole app excluding tests and their own
      module. 4.1's read half is a repository function with its own tests and
      nothing above it.
      So the next run's first move is the seam, not the fixtures: the plan read
      must take the cache key it already has the inputs for, read the pair,
      dequantise through `materialiseOptimized`, and hand the result to
      `schedule()` as the seventh argument — falling back to Fast on a miss, a
      `failed` row, a stale generation or a `corrupt` decode, each of which 4.1
      through 4.8 already decide. Only then can (a)–(f) assert on a payload
      rather than on the domain type, which is the whole point of this item.
      **Do not write them one layer down as a substitute:** an assertion against
      `schedule()` directly is 4.9's proof again under a new name, and 4.9 is
      already closed.
      **THE SEAM IS BUILT (run 42), AND IT DOES NOT MATERIALISE.** The paragraph
      above says the plan read should "dequantise through `materialiseOptimized`
      and hand the result to `schedule()` as the seventh argument". That was
      written before 4.12b changed what a row holds, and it is now wrong by one
      layer: `OptimizedResult.schedule` is an already-materialised `Schedule`
      (`optimized-result-dto.ts`), and 4.11b's guard runs "after 4.9's
      materialisation and before any cache write" — so `materialiseOptimized`
      belongs on the WRITE path, and the read path decodes a whole schedule.
      A read that re-materialised would need offsets no row stores.
      What landed instead: `OptimizedScheduleReader`, a port in
      `apps/be-01/src/service/optimized-schedule-reader.ts` taking the plan's
      own `ScheduleInput` plus the project id and objective, answering
      `Schedule | null`. `WorkItemService` takes one as an OPTIONAL collaborator
      and asks it before the pass, and the pass became
      `optimized ?? schedule(...)`. Three refusals, each its own line and each
      its own case: no reader wired in, `optimization_enabled` false,
      `schedule_engine` not `optimized`. The four states the cache distinguishes
      all arrive as `null` and all fall through to Fast, so 4.1–4.8's rules stay
      in one place. `canonical-schedule-input` is reached from outside
      `libs/domain` by the explicit Node subpath
      `@wbs/domain/canonical-schedule-input` (`tsconfig.base.json`), the plan
      read being its first such caller. **It is deliberately NOT in the domain
      barrel** — it was, and the PR 203 review took it out (M1), because that
      barrel is reachable from `apps/fe-01` and a root re-export puts
      `node:crypto` one `export *` away from a browser bundle. Restoring the
      export reopens that path; add a subpath, never a barrel line.
      `deadlines` is passed as a module-level empty map naming TASK-241.
      **Proven by** `apps/be-01/src/service/optimized-plan-read.test.ts`, six
      cases, and three mutations each reddening exactly one of them: serve Fast
      unconditionally; delete the enabled refusal; delete the engine refusal.
      The ask is asserted field by field — objective, rows, slice keys, and the
      empty deadline map — because a key built from anything but the pass's own
      arguments names a different plan than the one about to be scheduled.
      **What (a)–(f) still need is a fixture that publishes an annotated
      optimized schedule through this port**, which is now a test-side stub
      away rather than blocked on production wiring. To drive them through the
      real materialiser rather than a moved schedule, `materialise-optimized.ts`
      needs a `tsconfig.base.json` path alias — only `optimized-result-dto.ts`
      has one under `@wbs/contracts/solver/`, so `apps/be-01` cannot import it
      today.
      **THE ADAPTER LANDED IN THE SAME RUN (42, chunk 3).**
      `publishedScheduleReaderOf` in `optimized-schedule-cache.ts` is
      `readOptimizedPair`'s first caller above the repository. It is
      constructed with the three key columns the plan read must not name —
      `budgetMs`, and the contract version, which is the COMPOSITE
      `"<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"` that
      `build-solver-request.ts:213` writes, not the bare `7` — and closes over
      the database. So `solverVersion` is a third reader-owned key column and
      not a blocker: it is a deployment fact, exactly like the budget, and the
      coordinator that spawns with it is the thing that will construct this.
      Its body is `scheduleInputHash(ask.input)`, `readOptimizedPair`, then
      `pair[ask.objective].kind === 'ok' ? outcome.result.schedule : null` —
      the four non-`ok` kinds are the one `null` the port documents. It is typed
      structurally rather than importing the service's port type, because the
      service depends on the repository and not the reverse; the composition
      root is where the shapes meet and where TypeScript checks them.
      **Proven by** three cases in `optimized-cache.db.test.ts` against real
      SQLite, with two reds: a fixed `inputHash` reddens the serving case, and
      `pair.pri` for the asked objective reddens the published-objective case.
      The third case records a **measured negative**: replacing the `kind`
      test with `outcome.result?.schedule ?? null` leaves all 57 green, because
      no non-`ok` outcome carries a `result`. The `kind` test is kept for saying
      the rule out loud, not because it is the only form that works.
      **Still unwired.** Nothing constructs this yet — the composition root
      passes no `optimized` reader, so every deployment is still Fast. Wiring it
      needs the `budgetMs` and `solverVersion` a release runs, which is slice 6's
      to supply.
      **FOUR OF THE SIX ARE PROVED THROUGH THE PAYLOAD (run 43).**
      `apps/be-01/src/service/optimized-plan-read-annotations.test.ts` drives
      the REAL `materialiseOptimized` over the plan read's own `ScheduleInput`,
      via the `@wbs/contracts/solver/{materialise-optimized,quantised-baseline}`
      aliases this run added. State: **(a)**, **(b)**, **(e)** and **(f)** each
      have a case and a watched red — (a) `timing` taken from a fresh Fast pass,
      reddens (a) alone; (b) `pinFloor` returning the floor's own label under the
      optimizer's date, reddens all three cases that read the label; (e)
      `annotateCapacity`'s `finishesByStart` filter dropped, reddens (e) alone;
      (f) `pinFloor`'s `withinDrift` early return dropped, reddens (f) alone.
      **(c) is a STATEMENT, not a pinned proof, and that is now a decision
      rather than an omission:** above its floor `pinFloor` re-asks the window
      from its own answer, so the binding is empty by construction and
      `annotateCapacity`'s `boundBy === 'capacity'` gate has nothing to gate on
      an `'optimizer'` slice — the gate's red lives in
      `schedule-annotate.test.ts` and in (e). What the payload case adds is that
      the invariant survives the DTO.
      **(d) IS NOW WRITTEN AND PROVED (run 44), and run 43's reason for
      reverting it was itself a mis-measurement.** Run 43 recorded that "a slice
      naming two pools takes ONE slot from whichever pool has room, so its floor
      is the min, not the joint max", which contradicts
      `schedule-joint-capacity.test.ts` and is not what the engine does. Probed
      on h2puni: that fixture's contended leaf reached the engine with
      **`poolIds: []`** — no pools at all — so the floor it measured was never a
      joint window. `WorkItemStore.insert` takes a `WorkItem`, which carries the
      singular `serviceTeamId` and no set; the SQLite repository's private
      `joinRowsFor` happens to read a `teamIds` property off the row it is
      handed, but that shape is not on the port and the in-memory twin's
      `joinFor` does not read it, so the label was dropped silently. **The
      supported write path for a team SET is `patch`**, which both the store and
      its twin implement and which validates the teams against the directory —
      so they must exist first. Recorded because the failure mode is the one the
      harness's own doc comment warns about: the graph constructs, the suite
      runs, and the label is simply never there to assert on.
      The case as landed: Alpha and Beta both size 1; an Alpha tenant of 2 days
      and a Beta tenant of 4 days, each of which also spends its unestimated QA
      slice (`ASSUMED_SLICE_WORKDAYS`) in the same pool, so Alpha frees at 4 and
      Beta at 6; and a contended 2-day leaf on both pools pinned at 6, its own
      floor. It comes back `earliestStart: 6`, `boundBy: 'capacity'`,
      `capacityTeamId: 'team-beta'` and all FOUR tenant slices in
      `capacityPredecessorIds` — the union across the search's rounds, not the
      two live at the accepted instant.
      **The tenants carry an explicit `priority`**, which is the fixture's other
      lesson: every leaf in this file shares a position and starts on day 0, so
      without it the leveller's tie falls to float and the contended slice can
      take both slots first, which reads as a floor of 4 for a reason that has
      nothing to do with the item.
      **Three watched reds, each reddening (d) alone:** `jointWindowFor`'s
      multi-pool loop asking `poolIds.slice(0, 1)`; that loop's
      `window.start > best` flipped to `<` (the "either pool will do" reading);
      and `annotateCapacity`'s `finishesByStart` narrowed from `<= start` to
      `=== start`.
      **Two of the item's own three claims are measured negatives here**, and
      both are recorded in the case rather than smoothed over. "Reserve into
      only the first pool" leaves all six green — every tenant in this fixture
      names ONE pool, so the per-pool WRITE has no second pool to lose, and that
      half of decision 3 is `schedule-joint-capacity.test.ts`'s. And
      "`capacityTeamId` as the first sorted pool" leaves all six green for a
      structural reason rather than a fixture gap: **a pool that had room at the
      accepted start is not a binding pool**, so `window.binding` is
      `['team-beta']` alone and every reading of a one-element set agrees. Two
      pools bind only when both released at the accepted instant, where their
      latest valid finishers TIE at that instant and the pool-id tie-break is
      the rule — so "latest finisher, not first by id" is distinguishable only
      in the tied-pool case that file already carries, and not in a joint
      window. `team-alpha` still earns its name: it is what makes
      `capacityTeamId: 'team-beta'` a claim about which pool ran out.
      **THE ITEM IS CLOSED.** All six proofs have a disposition through the real
      payload: (a), (b), (d), (e) and (f) each have a case and at least one
      watched red, and (c) is the recorded decision one paragraph up. The
      adapter's remaining "still unwired" note is slice 6's `budgetMs` and
      `solverVersion`, not this item's.
      **A fixture rule the file learned the hard way:** a case may state only
      the offsets it MOVES. A solver answers for every slice, so `servedBy`
      fills the rest from `quantisedFastBaseline`, and moving a slice moves its
      own successor's floor with it.
- [x] 4.11b **The real-domain publication guard** (Sol r10 Critical 3). No
      numbered slice implemented this at all; 2.11 pointed at a "6.x
      publication guard" that does not exist, so the guarantee had no owner.
      It runs **after 4.9's materialisation and before any cache write**, in
      `libs/domain`, on the materialised schedule: (a) compute the **Baseline
      schedule** — _real_ Fast, fractional `days / width` intact, over the same
      canonical input; (b) recompute the variant's **primary** term
      (`MAKESPAN` for Time, `PRIORITY` for PRI) on both the materialised
      optimized schedule and the Baseline schedule, **in the real domain**;
      (c) if the optimized primary is **strictly worse** than the Baseline's,
      substitute the Baseline's own materialised schedule and store it with
      `publication: 'quantisation-floor'`, every `value` recomputed in the real
      domain, null `stageValue`/`bound` and `status: 'unknown'` (4.12b);
      otherwise store the solver's schedule with `publication: 'solver'`.
      The predicate is **worse**, never "not strictly better": an _equal_
      primary may carry a strictly better secondary term, and discarding that
      result would throw away a real improvement the user asked for.
      **Proven by** two fixtures, both on the production write path: (i) the
      width-5 case — three serial `days=1, width=5` slices, real Fast at 28.8
      units against a quantised model that needs 30 — where the solver's
      quantisation-optimal answer is _worse_ in the real domain and the stored
      row must be Fast's schedule tagged `'quantisation-floor'`; (ii) an
      **equal-primary, better-secondary** fixture where the optimized primary
      ties the Baseline's and its secondary is strictly better — the stored row
      must be the **solver's**, tagged `'solver'`.
      **Watched red:** weaken the predicate to "not strictly better" and (ii)
      must fail by substituting Fast; score in the **quantised** domain instead
      of the real one and (i) must fail by publishing the worse schedule as
      `'solver'`; move the guard after the cache write and (i) must fail with a
      `'solver'` row already durable.
      **STEP (b)'s SCORER LANDED RUN 41 CHUNK 4.** `scoreReal` in
      `libs/domain/src/score-real.ts` is the real-domain half of this item: the
      three terms as plain `number`s, accumulated over the SORTED key list so
      the guard's two sides share one summation order — `Schedule.slices` is
      written in placement order and the two schedules do not share it, so an
      epsilon-free `>` over two differently-ordered float sums could substitute
      Fast for an answer that was not worse. Three mutations, each reddening
      exactly one case: iterate the `Map`, weight the START instead of the
      finish, drop the `Math.abs`.
      **THE ITEM IS CLOSED (run 45).** Steps (a) and (c) are
      `libs/domain/src/publication-guard.ts`; the mapping onto `publication` is
      `publishOptimizedResult` in `optimized-result-dto.ts`; the fixtures and
      the three watched reds are `publication-guard.test.ts` (4 cases) and the
      `4.11b` block inside `optimized-cache.db.test.ts`'s 4.1 write describe
      (3 cases).
      **ONE SENTENCE ABOVE IS NOT TRUE OF THE CODE, and the code is right.**
      "(c) … substitute the Baseline's own materialised schedule and store it
      with `publication: 'quantisation-floor'`" reads as though the guard
      writes that string. It does not: the guard is in `libs/domain` and
      answers `chosen: 'optimized' | 'baseline'`, because
      `OPTIMIZED_PUBLICATIONS` is `libs/contracts/solver`'s vocabulary and a
      second copy of those two literals in the engine is the copy that
      disagrees after an edit — the same direction the quantum and the wire
      units are already kept out of that library in.
      `publishOptimizedResult` is the one-line boundary that maps
      `'optimized' → 'solver'` and `'baseline' → 'quantisation-floor'`, and it
      is production code rather than a line each caller writes because the two
      arms are **not symmetric**: a solver row keeps the run's own quantised
      integers, a floor row keeps none of them.
      **Step (a) is computed inside the guard, from the run's own
      `ScheduleInput`, not handed in.** A `baseline: Schedule` parameter would
      have been shorter and would have let a caller satisfy the type while
      comparing against another plan's answer — a version of the exact failure
      the guard exists to catch. "Over the same canonical input" is structural.
      **WHERE THE SECOND FIXTURE ACTUALLY LIVES.** The equal-primary /
      better-secondary case needs `makespan` as the primary, and the write
      path's seat is hard-coded to `'pri'` (`reserve`'s `solver_slot` insert),
      so every db case is a PRI variant. It is proved at the decision seam
      instead, with the `>` → `>=` mutation reddening it **alone**; the write
      path proves the _tie_ arm. Recorded rather than papered over: the
      paragraph above says "both on the production write path", and one of
      them is not.
      **The measured mutations, all on h2puni.** Domain (4/0 unmutated):
      predicate `>` → `>=` **3/1**, the optimized side scored as the baseline
      **1/3**, the substitution dropped **3/1**. Write path (60/0 unmutated):
      the floor arm keeping the solver report **59/1**, the arm test inverted
      **58/2**.
- [x] 4.12b The cached row stores an **`OptimizedResult`, not a bare schedule**
      (Sol r7 Critical 6). `objectiveValues` is what records how far a
      partially staged run got, and the publication guard must persist
      `'quantisation-floor'`, but `Schedule` carries neither and the cache had
      only `scheduleJson`, so both were discarded at storage. The column
      becomes `resultJson` holding
      `{ dtoVersion, publication: 'solver' | 'quantisation-floor',
objectiveValues: Record<'makespan'|'priority'|'movement', ObjectiveValue>,
schedule: <encodeSchedule(schedule)> }`, with `StoredObjectiveValue =
{ value: number, stageValue: number | null, bound: number | null,
status: 'optimal' | 'feasible' | 'unknown' }` and
      `encodeOptimizedResult` / `decodeOptimizedResult` as the seam.
      **`quantisation-floor` lives only in `publication` (Sol r8 Critical 5,
      kimi r8 Important 2)**: the matrix fixes the status enum at three values
      and generates the wire schema and the 4.8 validator from it, so a fourth
      value there left the codec rejecting the row the guard must store.
      **No column `CHECK` is generated for it**: `publication` and per-term
      `status` live inside `resultJson`, so 4.8's `decodeOptimizedResult` is
      their only validator (Sol r10 Important 11). The stored shape is
      **identical to the wire shape** — `stageValue` and `bound` are already
      nullable on the wire (matrix row `UNKNOWN, no incumbent, k > 1`), so
      storage widens nothing. For a `quantisation-floor` row every `value`
      is recomputed **in the real domain on the stored Fast schedule**,
      `stageValue` and `bound` are null, `status` is `unknown`, and 2.4's
      `value <= stageValue` relation is not applied — it is a within-stage
      relation with no meaning across the quantised and real domains.
      **The numeric domain is per-`publication`, not blanket (Sol r12
      Critical 1).** `decodeOptimizedResult` requires a non-negative **safe
      integer** for every non-null number of a `'solver'` row (quantised
      solver units, the wire's own rule) and a **finite non-negative number
      that need not be an integer** for each `value` of a
      `'quantisation-floor'` row (real domain, fractional workdays, the same
      unit as the stored offsets), rejecting `NaN`, infinities and negatives
      in both. A blanket safe-integer rule is unsatisfiable: `durationOf`
      keeps `days / width` fractional (`libs/domain/src/schedule.ts:539-541`),
      so the mandated width-5 floor row's real makespan is 0.6 workdays /
      28.8 units and the decoder would reject the row the guard must store.
      **Watched red:** a width-5 floor row must round-trip through SQLite and
      the real plan read with the stored schedule equal to Fast's, null
      `stageValue`/`bound` and `publication: 'quantisation-floor'`; put
      `'quantisation-floor'` back into `status` and the read-time enum
      validator must reject it.
      **Second watched red, the fractional one (Sol r12 Critical 1):** that
      same floor row's reloaded `value` must be **bit-equal** to `scoreReal`
      re-run on the reloaded Fast schedule — asserted against the scorer, not
      against the literal `0.6`, because `0.2 + 0.2 + 0.2 !== 0.6` in
      IEEE-754 — and the row must decode with `Number.isSafeInteger(value)`
      false; apply the safe-integer rule to floor rows and this case must
      fail, while a `'solver'` row carrying that same non-integer value must
      still be rejected.
      **Two further negatives, both valid JSON** (Sol r10 Important 11, which
      is where the JSON-held enums are actually enforced): (a) a syntactically
      valid `resultJson` whose `publication` is `'fast'` — `decodeOptimizedResult`
      throws naming `publication` and the unknown value, and the row reads as
      `corrupt`; (b) a syntactically valid `resultJson` whose last term carries
      `status: 'proved'` — the same seam throws naming the term and the value.
      Neither may be caught by a database constraint: assert directly that the
      migration adds **no** `CHECK` over `resultJson`, so a _malformed_ payload
      (a truncated string, already covered above) still inserts and still
      surfaces as `corrupt` rather than failing the write.
      `publication` is stored rather than inferred, because a
      `quantisation-floor` row **is** Fast's schedule and the comparison
      indicator must not present it as a solver win. **Watched red:** a
      partially staged row (`status: 'unknown'` on the last term) and a
      `quantisation-floor` row each reload through SQLite and the real plan
      read with every field intact; a `resultJson` holding a bare
      `encodeSchedule` output makes `decodeOptimizedResult` throw naming the
      missing `dtoVersion`; and storing through the old
      `scheduleJson`-shaped write makes the metadata assertions fail.
      **OPEN AT ONE HALF, and only one (run 38 audit).** The codec, the
      per-`publication` numeric domain, both JSON-held enum negatives, the
      no-`CHECK`-over-contents assertion and the fractional bit-equality
      through the column are all landed and proved
      (`optimized-result-dto.ts`, `optimized-schedule-cache.db.test.ts` 478,
      504, 538, 583). What is not asserted is the **scorer** half: the floor
      row's reloaded `value` bit-equal to `scoreReal` re-run on the reloaded
      Fast schedule, and the stored schedule equal to Fast's for a width-5
      row. **`scoreReal` now exists** — `libs/domain/src/score-real.ts`, landed
      run 41 chunk 4 — so the blocker this paragraph named is gone and only the
      case is owed. Its shape:
      `scoreReal(produced, weightOf, baselineStartOf)` returns
      `{ makespan, priority, movement }` as plain `number`s, with the weight and
      the baseline arriving as callbacks because a weight is a dense rank over
      LEAVES while these keys name SLICES. It accumulates over
      `[...produced.slices.keys()].sort()` and **not** over the `Map`, whose
      order is the placement order: the optimized replay and real Fast place the
      same slices in different orders by construction, IEEE-754 addition is not
      associative, and 4.11b's predicate is an epsilon-free `>` that one ulp of
      iteration order would decide.
      **THE CASE RAN AGAINST IT, run 45 chunk 2, and the item is closed.** The
      width-5 floor row is stored through `storeOptimizedOutcome` and read back
      through `readOptimizedPair` in `optimized-cache.db.test.ts`'s `4.11b`
      block: the reloaded `schedule` is asserted **equal to real Fast's**, and
      each reloaded `value` is asserted `toBe` — `Object.is`, so bit-equal —
      against `scoreReal` **re-run on the reloaded schedule**, never against a
      literal. `Number.isSafeInteger(priority.value)` is asserted **false** on
      that row, which is the per-`publication` numeric domain doing its job:
      the blanket safe-integer rule would have rejected the row the guard must
      store.
- [x] 4.11c **The capacity arrow's referent is the chosen pool, and it is
      tested** (Sol r13 Minor 5 renumbered this from a duplicate `4.11b`;
      `4.11b` is the real-domain publication guard and is referenced as such
      by 2.x and 6.x, so a tracker could have closed one while skipping the
      other). (Sol r12 Minor 6). For a `capacity` floor,
      `resourcePredecessorId` is taken from the filtered blockers of the pool
      `capacityTeamId` names, ties broken by placement order **within that
      pool** — never from the union across binding pools, whose tie-break can
      point the arrow at a slice from a different pool and split it from the
      team sentence that explains it (Fast selects from
      `capacityTeamBlockers` for this reason,
      `libs/domain/src/schedule.ts:1283-1288 for the rule, 1311-1334 for the selection loop it constrains`). 4.9's and 4.11's existing
      cases prove pool filtering and team selection but not the referent, so
      an implementation selecting from the union passes all of them.
      **Watched red:** a fixture with two eligible binding pools whose latest
      valid finishers finish at the same instant — select from the union and
      the emitted `resourcePredecessorId` must belong to a pool other than
      `capacityTeamId`, failing the case.
      **CLOSED RUN 41 CHUNK 2 — AND THE FIXTURE ALREADY EXISTED.** The premise
      above ("4.9's and 4.11's existing cases prove pool filtering and team
      selection but not the referent, so an implementation selecting from the
      union passes all of them") is **false as written**, measured rather than
      argued. The case at `schedule-joint-capacity.test.ts:225` — "chooses a
      tied pool and referent only from blockers that finish by the accepted
      start" — IS this
      fixture: `alpha-hold` and `beta-short` both finish at day 4, both pools
      bind, `capacityTeamId` falls to the pool-id tie-break and names
      `team-alpha`, and `beta-short` is placed FIRST — so the union's own
      tie-break points at the pool the sentence does not name. **M5**, the exact
      mutation this item specifies (`capacityTeamBlockers` replaced by
      `window.blocking.filter(finishesByStart)` in the referent loop, the
      `finishesByStart` filter left intact so only the pool constraint is
      removed), reddens it at line 253: `Received: "beta-short step-dev"` beside
      `capacityTeamId: 'team-alpha'`. 434 pass / 1 fail with that case alone.
      A second fixture was written in this chunk and then **deleted rather than
      kept**, for run 39's reason: it asserted the same rule and its own
      mutation reddened two cases where it should have reddened one. What it
      separated that :225 does not — a union rule broken by NODE INDEX rather
      than placement order — is already dead by
      `names the blocker placed first, not the one whose key sorts first`.
- [x] 4.12 `CACHE_DTO_VERSION`, `encodeSchedule`, `decodeSchedule`
      in `libs/domain`: both `Map`s become arrays of entries sorted by key, and
      `waitingForPerson`, `waitingForCapacity` and `eventsVisited` are stored,
      because `JSON.stringify` renders a `Map` as `{}` and an implementation
      could pass every type-level test and store a row that reloads empty.
      `decodeSchedule` throws naming the defect on an unknown `dtoVersion`, a
      duplicate key, a key disagreeing with its entry's own slice key, or a
      missing projection. **Watched red:** a non-empty round trip through
      SQLite and the real plan read, plus those three negatives.

## 5. The `wbs-solver` Python package

- [x] 5.1 New versioned package with a lock file, OR-Tools CP-SAT declared, one
      `solve` entrypoint over stdin/stdout. No import surface, no daemon, no
      port. Version readable by the coordinator for `contractVersion`. The
      entrypoint calls `prctl(PR_SET_PDEATHSIG, SIGKILL)` before reading stdin.
      It remains defence in depth for the direct-spawn package smoke only;
      production runs behind Docker and does not rely on this relationship.
      The host supervisor's disconnect kill and persistent deadline timer own
      production orphan handling (`supervisor-amendment.md`).

      **Landed** at `libs/solver-py/`, distribution `wbs-solver`, import
      package `wbs_solver`. Three things this item left open had to be decided,
      because nothing in these artifacts names them, and they are recorded in
      the task log with what would falsify each: the **location** (`libs/`, with
      no `project.json` yet — 5.11 owns the Nx target, and a half-wired target
      that runs nothing is worse than an absent one); the **runtime**, CPython
      3.14 exactly, since design.md's packaging paragraph says the image
      installs "the pinned Python runtime" and h2puni runs 3.14.4 with ortools
      9.15.6755 publishing cp314 wheels; and the **lock format**, pip
      `--require-hashes` rather than `uv.lock`, because `uv` is absent from the
      gate host and `pip install --dry-run --report` already emits the exact
      resolution with hashes.

      **The version was not a choice.** `0.1.0` is what the golden request
      corpus was checked in spending, before this package existed
      (`solverVersion: "0.1.0"`, `contractVersion: "7+0.1.0"`).
      `wire-contract-version.test.ts` deliberately asserts only the
      `contractVersion` **prefix** because the suffix belongs to this package;
      `tests/test_version.py` is the other half of that pin and reads the same
      two fixtures from Python.

      **`--version` is the coordinator's read.** Bare, newline-terminated,
      nothing else on stdout, and it does not touch stdin — proved against a
      pipe nobody writes to, since a `--version` that read stdin would block a
      probe rather than answer it.

      **The lock is installed, not merely resolved:**
      `pip install --require-hashes -r requirements.lock` exits 0 and
      `ortools 9.15.6755` imports from that environment.

      **Watched reds, all measured:** `set_parent_death_signal()` moved to after
      `read_request` fails both ordering cases; `__version__` bumped fails both
      corpus fixtures; a deleted `--hash=` line fails the lock check. The real
      `prctl` call is exercised against the real libc in a fourth case, so the
      ordering pair cannot pass over a function that does nothing.

      **`solve.solve_request` raises and is 5.2's.** A stub that answered would
      make 5.2 green against nothing; the entrypoint exits 70 with the message
      on stderr and **nothing** on stdout, which is the rule
      `solver-wire.v1.json`'s response `$comment` states for every outcome the
      schema cannot encode.

- [x] 5.2 Objectives, stated as executable mathematics rather than prose:
      `MAKESPAN = max finish`; `PRIORITY = Σ priorityWeight(s) · finish(s)`;
      `MOVEMENT = Σ |start(s) − baselineOffsets[s]|`. PRI minimizes
      `(PRIORITY, MAKESPAN, MOVEMENT)`, Time minimizes
      `(MAKESPAN, PRIORITY, MOVEMENT)`, each by **staged optimization** —
      optimize a term, then constrain it for the later stages **exactly as
      the design's stage-status matrix says and never otherwise**: an equality
      only when the stage proved OPTIMAL, `term <= incumbent` for FEASIBLE and
      for UNKNOWN-with-incumbent, stop-and-publish-the-previous-incumbent for
      UNKNOWN-without at a later stage, `no-solution` for UNKNOWN-without at
      the first stage, `plan-infeasible` for INFEASIBLE at the first stage, and
      `invalid-output` for INFEASIBLE at any later one. That
      matrix is the single authority; this task restates none of it. Never a
      weighted sum, which overflows on realistic horizons. Neither is a total order; ties
      exist and are not broken reproducibly in production.

      **Landed** as `libs/solver-py/src/wbs_solver/model.py` (the constraint
      system and the three terms) and `solve.py` (the staging). The split is not
      tidiness: the matrix _constrains_ a term after a stage has proved
      something about it, so the terms have to be addressable objects before any
      staging code can exist.

      **The constraint set is read off `revalidate-solver-result.ts`, not
      invented.** A rule the model is missing is a solve thrown away as
      `invalid-output`; a rule it adds is a plan reported infeasible that Bun
      would have accepted. Six clauses in that file's own order, each naming the
      clause it mirrors, plus the one it does not carry —
      `finish <= deadlineUnits`, whose own header assigns it to 2.4, and which is
      what makes the matrix's `INFEASIBLE, k = 1` row a property of the plan.

      **Three decisions this item did not name**, recorded in the task log with
      what would falsify each: zero-duration slices get no interval at all
      (matching the re-validator's sweep, which drops zero-length placements
      before counting); the three terms are `IntVar`s pinned by equalities
      rather than `LinearExpr`s, because an equality against a relaxation is not
      an equality and `MOVEMENT` needs `AddAbsEquality` for the same reason; and
      `num_search_workers`/`random_seed` are a `SolverConfig` constructor
      argument rather than a wire field, since `solver-wire.v1.json` is closed
      and its own `$comment` already treats process-level settings —
      `childDeadlineAt`, `attemptToken` — as arguments rather than message
      members. Reading that config at the process boundary is 5.4b's.

      **`stage_disposition(status, stage, has_incumbent)` is pure**, because
      four of the six rows are unreachable through a real solve of an instance
      small enough to be an oracle: a budget that reliably exhausts is the flake
      5.6 exists to avoid, and a later-stage INFEASIBLE cannot be produced
      without a wrong model. Every row is asserted as an argument; the reachable
      rows are also driven end to end.

      **`UNKNOWN` with an incumbent is honoured and never occurs here.** CP-SAT
      answers `FEASIBLE` whenever the search found a solution and stopped early,
      and `UNKNOWN` only when it found none. The two rows prescribe the
      identical constraint and the identical per-term status, so the collapse is
      a property of this solver rather than of the table.

- [x] 5.3 **Proven by** the Python suite (CI only) — unit: each of the three
      cost terms computed on a hand-built instance, both stagings, request
      parse round-trip, response serialization.

      **All four clauses have a home, and the last one to get it was the parse
      round-trip** — `tests/test_validate.py::TheParseIsLossless`. The other
      three were already standing: the cost terms in
      `test_solve.py::TermArithmeticAgreesWithTheModel` (each term recomputed
      from the published offsets and compared against the model's own value),
      both stagings in `test_solve.py::BothStagings`, and response
      serialization in `test_solve.py::TheResponse`.

      **The round trip is a different kind of check from everything else in
      that file, and that is the reason it needed writing.** The four
      cross-field checks are about *refusing* a bad request; this one is about
      not quietly altering a good one. That failure has no symptom at the wire —
      it surfaces much later as a wrong plan or a `TypeError` inside CP-SAT — so
      nothing else in the suite was positioned to see it.

      **Its oracle is plain `json.loads`, deliberately without
      `parse_request`'s `object_pairs_hook`.** Comparing the hook's output
      against itself would prove nothing; comparing it against the stdlib's own
      reading of the same bytes is what makes a sanitising hook visible.

      **Four cases, and the number-kind one is not redundant with the equality
      one.** `10 == 10.0` in Python, so a `parse_int=float` parse round-trips
      *equal* and is still wrong — the model builds `IntVar` domains from
      `durationUnits`. The leaf-type walk is what catches it, and the measured
      reds below are the proof that the equality case alone would have missed
      it. The opposite direction is asserted too: `stageBudgetSplit` is
      fractions of a budget, and truncating those to `int` is a stage with no
      time.

      **Three watched reds, each measured on the gate host and reverted**
      (`validate.py`, suite of 110):

      | mutation | new-class reds | total |
      |---|---|---|
      | keys sanitised to `wi-1::step-a` | all 4 | 8 fail / 3 error |
      | `parse_int=float` | `test_the_number_kinds_survive` only | 3 fail / 1 error |
      | `None` values dropped from the hook | all 4 | 9 fail / 4 error |

      The first mutation also stops `negative-printable-key.json` being refused
      by `KeySetEquality`, which is the shape of the defect this fixture was
      checked in for: one mutation, a red in the round trip *and* a red in the
      check that exists to catch it.

      **The fixture list is read from the corpus manifest, not written out
      here**, so a request fixture added to `manifest.json` is round-tripped
      without anyone remembering to add it twice.

- [x] 5.4 **Proven by** the oracle cases: 2–6 slice hand-verified instances with
      known optimal offsets per objective, including one where PRI and Time
      disagree, one exercising `notBeforeUnits`, one exercising a two-pool
      slice, and one exercising an intra-item step-order edge. The solver
      reproduces each exactly.

      **Landed** as `libs/solver-py/tests/test_oracles.py`, three cases, plus
      the disagreement case which stays in `test_solve.py`. Splitting it that
      way is deliberate: `1,1,1,3` exists to separate the two **stagings**, and
      it is tested beside the staging loop. The three here are pinned by a
      **constraint** instead, which is why each is solved under *both*
      objectives and asserted to give the same answer — agreement is the claim.

      | case | constraint | offsets | PRI / MAKE / MOVE |
      |---|---|---|---|
      | `NotBeforeUnits` | release time | `early:0, late:5` | 10 / 8 / 5 |
      | `TwoPoolSlice` | tighter of two pools | `both:0, only1:0, only2:2` | 10 / 4 / 2 |
      | `IntraItemStepOrder` | one edge | `step-a:0, step-b:2` | 7 / 5 / 2 |

      **Every number was worked out by hand in the case's docstring before the
      solver was run on it**, and each instance is small enough that the optimum
      is _unique_, so the offsets are asserted whole rather than by their
      objective values. Two of the three needed a weight to make it unique, and
      the docstring shows the runner-up placement the weight excludes — in
      `TwoPoolSlice` the two orders are symmetric at `PRIORITY 8` until `both`
      weighs 2, which separates them 10 against 12.

      **Each case carries its own relaxation**, because an instance that
      satisfies a constraint by accident proves nothing about it: the same
      instance with the second pool membership dropped, the edge removed, or
      `notBeforeUnits` back to 0, each with its own hand-computed optimum
      (8/2/0, 5/3/0, 7/5/2). A model ignoring the constraint returns the relaxed
      answer for both, and `TheInstancesAreNotAccidentallyIdentical` asserts the
      pair differs in exactly one request field — `horizonUnits` is derived from
      `notBeforeUnits` by the builder, so `NotBeforeUnits` pins it rather than
      letting the contrast change two things.

      **`notBeforeUnits` is stated twice in `build_model`, and that is why the
      first mutation of it was green.** The start variable's lower bound is
      `floor` and the end variable's is `floor + duration`; with
      `end == start + duration` posted between them, either one alone implies
      the release time. Deleting **one** site leaves all 119 tests green in both
      directions — a genuine equivalence, not a gap. Only the two-site deletion
      is a removal, and it takes `NotBeforeUnits` red under both objectives
      along with six older cases. Watched reds, measured on the gate host and
      reverted (`/home/puni1/mut2-t219-r17.py`, `mut3-t219-r17.py`;
      `model.py` byte-compared afterwards):

      | mutation | result |
      |---|---|
      | start bound `floor` → `0` | **green**, 119/0 — equivalent |
      | end bound `floor + duration` → `duration` | **green**, 119/0 — equivalent |
      | both bounds together | 8 fail, incl. `NotBeforeUnits` × 2 |
      | pool members = first `poolIds` entry only | 3 fail, incl. `TwoPoolSlice` × 2 |
      | edge constraint deleted | 6 fail, incl. `IntraItemStepOrder` × 2 |

- [ ] 5.4b **Bounded CPU and memory per child, with values.** Implement the
      host-owned boundary in `supervisor-amendment.md`: production requests 2
      CP-SAT search workers and 512 MiB, the supervisor refuses values above
      its own 2-worker/512-MiB/128-PID caps and 16-container global cap, and
      Docker enforces per-container memory plus equal memory-swap. `RLIMIT_AS`
      remains a loose backstop only. `OOMKilled=true` in the terminal frame is
      the only generic native-failure evidence for `oom`; a deadline-timer kill
      is `timeout`; another non-zero exit is `internal-error`.
      **Proven by** `solver-resource-limits.proc.test.ts` on h2puni: a real
      native allocation crosses the Docker limit, the terminal evidence stores
      exactly one `oom` marker, the coordinator survives, and the slot releases;
      a generic crash stores `internal-error`. Reject an above-cap request
      before `docker create`. **Watched red:** remove Docker memory, worker-count
      propagation, or the host-owned request caps and the corresponding case
      alone fails. Record the worst case: 32 search workers and ~8 GiB solver
      RSS at the full 16.
- [x] 5.5 **Proven by** the determinism case under the pinned config only —
      `num_search_workers=1`, fixed `random_seed`, and CP-SAT's
      **deterministic** time limit, never a wall-clock assertion. Production is
      multi-worker wall-clock and explicitly not reproducible; the case asserts
      the pinned config alone.

      **Landed** as `libs/solver-py/tests/test_determinism.py`. The mechanism
      already existed — `SolverConfig.deterministic_time_per_stage` selects
      `max_deterministic_time` in `_configure`, added with 5.2 — so this item
      was only ever the case, and the case is where the interesting parts are.

      **The instance has to be tied or the whole file is vacuous.** `tied()` is
      two interchangeable slices in a capacity-1 pool: both orders carry
      `PRIORITY 6 / MAKESPAN 4 / MOVEMENT 2`, so the placement is a free choice
      the search makes rather than something the arithmetic forces. On an
      instance with a unique optimum, "the same answer twice" would hold under
      any configuration at all, including the ones 5.5 says are not
      reproducible.

      **Three claims, and the third is the one 5.5 words carefully:** repeated
      pinned solves return the identical _whole response_ (bounds and per-term
      statuses too, not only offsets); the objective _values_ are seed- and
      worker-independent, because an optimum is a number and that is what
      production still promises when the placement does not; and the limit in
      force is read off `solver.parameters`, never measured. There is no
      `time.monotonic()` in the file — a determinism test that timed something
      would be the first place 5.6's flake appeared.

      **`test_no_case_here_requires_two_production_solves_to_place_alike` is
      deliberately not an assertion about two production solves agreeing _or_
      differing.** Asserting nondeterminism would fail exactly when the solver
      got more stable. It asserts only that a production solve is still a valid
      answer.

      **An unset CP-SAT limit is `inf`, not `0`, and the first version of this
      file went red proving it.** `0` there means "stop immediately", while
      `_configure`'s own comment records that a zero-length _budget_ would read
      as no limit — the opposite convention one layer away. So "in force" means
      **finite**, and `assertTrue(math.isinf(...))` is the assertion that the
      other limit does not bind.

      **Watched reds** (`/home/puni1/mut4-t219-r17.py`, `solve.py` restored and
      byte-compared), against the 127-test suite:

      | mutation | result |
      |---|---|
      | `num_search_workers` never set | 2 fail — both parameter cases |
      | deterministic branch never taken | 1 fail — the pinned parameter case |
      | `num_search_workers` forced to 8 | 2 fail — parameter cases **only** |

      **That last row is the honest limit of this case.** Forcing eight search
      workers does _not_ red `ThePinnedConfigurationRepeats`: a two-slice model
      is too small for CP-SAT's parallel search to diverge on, so the pin is
      proved by the parameters it sets and not by an observed divergence. An
      instance large enough to diverge would be an instance whose runtime is a
      measurement, which is the trade 5.5 and 5.6 both refuse. Recorded rather
      than papered over.

- [x] 5.6 **Proven by** the budget case, built to be flake-free: a deterministic
      limit small enough that the instance is provably unsolved at it (an
      instance whose search tree is measured, not guessed) returns `feasible`,
      never `optimal`, and never crashes. A wall-clock "too small" budget is not
      a guarantee and is not used.

      **Landed** as `libs/solver-py/tests/test_budget.py`, nine cases, no
      `time.monotonic()` anywhere in it.

      **The instance was measured, one candidate at a time.** Eleven slices of
      coprime durations sharing a capacity-2 pool, so stage 1 is a
      weighted-completion-time problem. Probed on the gate host through the same
      `build_model` + `minimize` + `solve` stage 1 makes, one worker, seed 0,
      ortools `9.15.6755`:

      | deterministic limit | stage-1 `priority` outcome |
      | --- | --- |
      | unbounded | `OPTIMAL` at **4.1573** deterministic units, 1.97s wall |
      | 8.0 (`GENEROUS`) | `optimal`, value 1221 |
      | 0.5 / 0.25 | `feasible` |
      | **0.1 (`BUDGET`)** | **`feasible`**, bound 681 against incumbent 1234 |
      | 0.05 / 0.02 / 0.01 / 0.005 / 0.001 | `feasible` |

      **The band matters in both directions, and the lower one is the flake.**
      `BUDGET` is 41× below the measured proof and 100× above the smallest limit
      probed. A budget that is too small does not produce `optimal` — it
      produces `UNKNOWN` with no incumbent, which stage 1 reports as
      `no-solution` and which would leave this file asserting on an empty
      response. Every limit from 0.001 upward returned a stage-1 incumbent, so
      that side of the band is four orders of magnitude wide.

      **Twelve slices did not prove within 20 deterministic units**, and run
      17's 10-to-20-slice candidates printed nothing in 500 wall seconds.
      Eleven is where the proof is expensive relative to the budget and the
      whole file still costs ~6s.

      **`test_the_generous_limit_proves_the_same_instance` is not decoration.**
      Without it, `feasible` at a small limit is equally consistent with an
      instance nothing can prove, and the case would assert nothing about the
      limit at all. With it, the only difference between `feasible` and
      `optimal` is the number in `deterministic_time_per_stage`.

      Only two numbers are asserted: `PROVEN_OPTIMUM` (arithmetic, not a search
      outcome) and the two inequalities true of any correct truncated
      minimisation — the incumbent is no better than the optimum, the dual bound
      no worse. The 1229/681 the probe saw are recorded above and deliberately
      not asserted; pinning one ortools build's search order would make a
      dependency bump a meaningless red.

      Watched reds (`/home/puni1/mut-t219-r18-solve.py.orig`, `solve.py`
      byte-compared after each):

      | mutation | result |
      | --- | --- |
      | `deterministic_time_per_stage` never applied | 4 fail — 3 here + `test_determinism`'s parameter case; suite 12s → **45s** |
      | every found stage claims a proof (`ROW_EQUALITY` always) | 8 fail — 2 here + 6 in `test_solve`'s matrix |

      The first mutation's runtime is itself the evidence that the deterministic
      limit, not the instance, is what keeps this case cheap. `test_the_gap_is_
      open_which_is_what_unproved_means` stays green under the second — the
      status lies there while the bound is still honest, which is the right
      split.

- [x] 5.7 **Negative check, watched red** — let the solver read the wall clock
      instead of `baselineOffsets` and watch 5.4's oracle case fail; separately
      collapse the staged optimization into a weighted sum and watch the
      PRI/Time-disagree oracle fail. `Proof:` comment names each fault. Any
      input the hash does not cover breaks cache identity, and a weighted sum
      silently reorders the terms.

      **Both faults injected and measured; both `Proof:` comments landed. Each
      half of the clause's own prediction was wrong, and that is the result.**

      **Fault one — `build_model`'s `baseline` read from `time.time()` instead
      of `request["baselineOffsets"]`.** Reds **3** cases, all in
      `test_model.CostTerms`, and **not one case in `test_oracles.py`**.
      `MOVEMENT` is the last tie-breaker under both stagings and every 5.4
      oracle instance has a unique optimum on an earlier term, so a corrupted
      baseline never reaches their placements. `CostTerms` is the whole of the
      suite's defence against an input the request hash does not cover; the
      `Proof:` comment says so there.

      **Fault two — the staged loop collapsed into one weighted sum.** The
      weights decide whether the fault exists at all:

      | mutation | result |
      | --- | --- |
      | `1000·T₁ + 100·T₂ + T₃` | 2 fail, both in `test_budget` — `BothStagings` **green** |
      | `T₁ + T₂ + T₃` | 3 fail, incl. `BothStagings` ×2 — the predicted red |

      Every term on the four-slice disagreement oracle is far below 100, so the
      dominating sum **is** the lexicographic order and is not a reordering at
      all. Only the naive equal-weight sum reorders the terms, and only it reds
      the PRI/Time-disagree oracle. A watched red on "a weighted sum" that does
      not name its weights proves nothing.

      **A by-product worth keeping:** the dominating sum was caught only by
      `test_budget`, and the equal-weight sum's third failure is also
      `test_budget`'s generous-limit case. 5.6's file is currently the suite's
      only check on staging that survives a weight choice designed to look
      harmless.

- [x] 5.8 Staged optimization implements the exact anytime rule:
      `STAGE_BUDGET_SPLIT = [0.60, 0.25, 0.15]` with early remainder donated
      forward; OPTIMAL fixes an equality; FEASIBLE or UNKNOWN-with-incumbent
      adds `term <= incumbent` (**never** an equality — fixing an unproven
      incumbent is not lexicographic minimisation). **Every remaining outcome
      defers literally to design.md's stage-status matrix, which is the single
      authority** (Sol r7 Critical 2); this task states no rule of its own,
      because the two that were stated here contradicted it. In particular:
      UNKNOWN with no incumbent reports `no-solution` **only at stage 1** and at
      `k > 1` publishes the previous stage's incumbent, and INFEASIBLE reports
      the typed state `plan-infeasible` **at stage 1 only** — effective
      deadlines enter before the objective terms, so stage 1 is the one stage
      whose infeasibility can be the user's plan — and `invalid-output` at
      every later stage, since stage 1 already produced a deadline-satisfying
      incumbent and every later stage only adds inequalities to a
      feasible model. The published result is the last stage's incumbent,
      feasible by construction. <!-- wire-fields:objective-term -->`objectiveValues` reports the
      **four**-field per-term shape `{ value, stageValue, bound, status }` exactly as
      `solver-wire.v1.json` and design.md's matrix define it; `value` is the
      term on the published offsets (2.4), `stageValue`/`bound`/`status`
      describe the stage **and are null where the stage produced none** — the
      matrix's `k > 1` UNKNOWN-without-incumbent row writes
      `{ value: <recomputed>, stageValue: null, bound: null, status: 'unknown' }`
      for `Tₖ` and every later term, so "describe the stage" is never a
      requirement that they be populated. **This task previously wrote a three-field shape and
      deferred `value` to a nonexistent 5.8b (Sol r8 Critical 4)** — an
      implementation instruction that contradicted 2.4 and the schema on both
      the field list and, in the long-form note, on the accepted outcome set.
      No task, design paragraph or note prose spells an alternate request or
      response field list; 2.1 is the single normative definition and every
      other mention points at it.

      **Verified clause by clause against what already exists, and one gap
      closed.** Almost all of 5.8 was implemented across runs 3–14; this run
      checked each clause against a named test rather than re-deriving the
      loop.

      | clause | where it lives | what proves it |
      | --- | --- | --- |
      | `STAGE_BUDGET_SPLIT = [0.60, 0.25, 0.15]`, exported | `libs/contracts/solver/src/stage-budget.ts` | `stage-budget.test.ts`; defaulted at `build-solver-request.ts:194` |
      | early remainder donated forward | `donated_budget_ms` + `solve_request`'s `carry_ms` | `test_solve.TheBudgetSplit` ×4 |
      | OPTIMAL fixes an equality | `stage_disposition` → `ROW_EQUALITY` | `test_optimal_installs_an_equality_at_every_stage` |
      | FEASIBLE / UNKNOWN-with-incumbent adds `<=`, never `=` | → `ROW_BOUND` | `test_feasible_installs_a_bound_at_every_stage`, `test_unknown_with_an_incumbent_installs_the_same_bound` |
      | UNKNOWN, no incumbent: `no-solution` at stage 1 only | → `ROW_STOP_NO_SOLUTION` / `ROW_STOP_PUBLISH` | the two `unknown_without_an_incumbent` cases |
      | INFEASIBLE: `plan-infeasible` at stage 1 only | → `ROW_STOP_PLAN_INFEASIBLE` / `ROW_STOP_INVALID` | the two `infeasible` cases |
      | four-field `{ value, stageValue, bound, status }` | `_term_row` | `test_all_three_terms_are_always_present`, `test_every_response_validates_against_the_wire_schema` |
      | `value` recomputed on the published offsets | `evaluate_terms` | `test_value_is_recomputed_on_the_published_offsets` |

      **THE GAP WAS THE NULL SHAPE ITSELF.** Every matrix row above is asserted
      against `stage_disposition`, which is a pure function over a status, and
      the *populated* side is asserted end to end by
      `test_a_fully_staged_run_reports_a_stage_for_every_term`. Nothing asserted
      that a term the matrix leaves unproved is actually **emitted** as
      `{ stageValue: null, bound: null, status: 'unknown' }` beside a non-null
      recomputed `value`. Closed by
      `test_budget.TheBudgetedSolve.test_an_unknown_term_carries_nulls_and_
      still_carries_a_value`, which is phrased over whichever terms come out
      unknown rather than naming one — which later stage exhausts its budget
      first shifts with the limit, and the matrix's rule does not depend on
      which it is.

      Watched red: `_term_row(values[term_name], None, None, TERM_UNKNOWN)`
      changed to pass `values[term_name], 0` reds **exactly that one case** and
      nothing else in 137. It carries the clause alone, which is why it exists.

- [x] 5.9 The **quantised** Fast baseline is supplied as both a CP-SAT solution
      hint and an upper bound on stage 1's term. That bound holds **only in the
      quantised model** (Sol r10 Critical 3): it guarantees the solver never
      returns a quantised primary worse than quantised Fast's, and it says
      nothing about the real domain, because rounding `days / width` up can
      itself cost more than the search wins. The real no-worse-than-Fast
      guarantee is made by **task 4.11b's publication guard**, not here.
      **Watched red:** remove the bound and run a fixture where the search's
      first incumbent is worse than quantised Fast on that term.

      **Closed run 19 chunk 1** (`b0453bb5`, 151 green). Hint half was already
      in `model.py`; this added `baseline_bound` in `solve.py`, installed on
      stage 1's term before the staging loop.

      **The watched red above is UNREACHABLE, and 5.9's own hint half is why.**
      Measured on the gate host, bound removed, one worker, seed 0, against a
      baseline worth 1221: stage 1's incumbent is 1221 at every deterministic
      limit from 0.001 to 0.5. The hint delivers the baseline as the first
      incumbent, so "the search's first incumbent is worse than quantised Fast"
      does not occur. Confirmed from the other side: against a mediocre serial
      baseline worth 4045 the unbounded search returns 1875 at 0.001 and 1273 at
      0.1 — it improves on the hint immediately. Building the fixture anyway
      would mean emitting a request the request `$comment`'s invariant 1 forbids
      (`fastHint` == `baselineOffsets`, enforced by `check_cross_field`).
      Recorded as unreachable, not faked — run 17's `num_search_workers`
      disposition.

      **Asserted instead, at the model rather than at the search:** no placement
      worse than the baseline on stage 1's term is a *solution*, which is
      design.md's guarantee stated as a property of the solution set and is
      decidable with no search and no clock. `test_bound.admits()` pins every
      start to a feasible-but-worse placement and asks whether the model takes
      it — no with the bound, yes without.

      **THE BOUND IS UNSOUND ON A REQUEST THIS PACKAGE ACCEPTS.** design.md has
      the baseline feasible "by construction", but that is a **builder**
      invariant and the wire does not carry it: the request `$comment`'s eight
      cross-field invariants say nothing about whether the baseline can be
      placed. The all-zero baseline `a_request` defaults to is infeasible over
      eleven slices sharing a capacity-2 pool, with a `priority` of **678
      against a true optimum of 1221** — so an unguarded bound excludes every
      solution and stage 1 reports `INFEASIBLE, k = 1`, which the matrix hands
      to the coordinator as a property of the *user's plan*. `baseline_bound`
      therefore returns `None` unless `baseline_is_feasible` proves the
      placement is admitted; that probe is `build_model` with every start
      pinned, deliberately the model itself rather than a second implementation
      of the six clauses. Measured at 1.1–1.6 ms.

      **Guard's watched red:** `if not baseline_is_feasible(request):` → `if
      False:` reds **41 cases** across `test_determinism`, `test_oracles`,
      `test_model` and `test_bound`. It protects most of the corpus, not one
      case.

- [x] 5.10 Replace 5.7's weighted-sum mutation, which could stay green: on a
      bounded 2-6 slice fixture, sufficiently large coefficients encode the
      same lexicographic order exactly, so PRI/Time disagreement proves
      nothing about staged versus weighted. The mutation instead substitutes
      the implementation's **own** coefficient constants into a fixture built
      so the second term's swing exceeds the first term's coefficient gap —
      an answer that necessarily changes — plus a separate integer-overflow
      guard test for the weighted form's bound.

      **Mutation half closed run 19 chunk 2** (`e6c2256a`, 160 green);
      **the integer-overflow guard is NOT done and is what keeps this
      unticked.**

      `test_lexicographic.py`. Under `pri` the coefficients under test are
      `1000 / 100 / 1`, so one unit of PRIORITY is worth ten of MAKESPAN and the
      instance must make one unit of PRIORITY cost **more than ten**. `W` (d=15,
      w=1) and `S` (d=1, w=0) share a person so they serialise; `S` heads a
      twenty-link chain, so delaying `S` delays the whole tail by `W`'s fifteen
      units. `W` is the only weighted slice, so PRIORITY is its own finish.
      Every number below is hand-computed and every solve proved OPTIMAL
      (ortools 9.15.6755, one worker, seed 0):

      | placement | PRIORITY | MAKESPAN |
      | --- | --- | --- |
      | `W` first (`W`@0, `S`@15) | 15 | 36 |
      | `S` first (`S`@0, `W`@1) | 16 | 21 |

      | objective minimised | answer |
      | --- | --- |
      | the shipped staged loop | `W`@0 — PRIORITY 15, MAKESPAN 36 |
      | `1000·T₁ + 100·T₂ + T₃` | **`S`@0 — PRIORITY 16, MAKESPAN 21** |
      | `1·T₁ + 1·T₂ + 1·T₃` | `S`@0 — on MOVEMENT, see below |
      | `10⁶·T₁ + 10³·T₂ + T₃` | `W`@0 |

      **The dominating sum is the finding.** On 5.7's oracle `1000/100/1` stayed
      green; here it is red, and a sum a thousand times larger is green again. So
      "the coefficients are big" is not the rule — only whether the coefficient
      gap exceeds the term's swing is. A mutation whose coefficients are not
      named, and whose fixture is not built against them, is a coin flip.

      **5.9's bound made this file blind, and chunk 3 measured it.** Chunk 2
      baselined on `w_first`, the lexicographic answer, so the bound was
      `PRIORITY ≤ 15` and excluded the `S`-first placement (PRIORITY 16)
      outright — correctly, but it meant the collapse could not move
      `solve_request`'s answer. Injecting that collapse (stage 1 minimising
      `1000·T₁ + 100·T₂ + T₃`, stages 2–3 unchanged) reddened `test_budget` ×2
      and `test_solve.BothStagings` ×2 and left `test_lexicographic` **green** —
      the file built to catch a weighted collapse did not catch one. The baseline
      is now `s_first` (PRIORITY 16): the bound admits both placements, is
      present without being decisive, and the same mutation reds
      `TheStagedLoopIsLexicographic` as well — 5 reds, not 4.

      **Third finding, forced by that change and measured rather than
      predicted:** the equal-weight row flipped. `1/1/1` answers `S`@0 against
      `s_first` and answered `W`@0 against `w_first`, because **MOVEMENT is the
      only term defined relative to the baseline** — it scores W-first at
      15 + 36 + 316 and S-first at 16 + 21 + 0 and decides on the movement alone.
      A weighted form therefore has a failure mode no fixture designs away: two
      of its terms are properties of the schedule and the third is a property of
      the *question*. The staged loop is immune, because MOVEMENT is last under
      both objectives and only ever breaks ties the first two terms left open.

      **Overflow guard closed run 20 chunk 1** (`be3bfa29`, 171 green), and
      **5.10 is now ticked.** Eleven cases in the same file, on one slice at the
      wire's own ceilings: `horizonUnits` 2³¹ − 1 (the schema's stated maximum)
      and weight 2²² − 1, the largest that keeps invariant 8's PRIORITY worst
      case under MAX_SAFE_INTEGER. The request is proved wire-legal against the
      schema and the cross-field checks, and each term's own domain ceiling is
      inside MAX_SAFE_INTEGER — so the staged loop, which minimises one term at
      a time and whose objective is therefore a single variable, is exactly what
      invariant 8 already protects. `CpModel.validate()` accepts it and the
      solve proves OPTIMAL.

      **THE FINDING, and run 20 predicted it wrong: fitting in int64 is not the
      same as being solvable.** `LARGER` (10⁶/10³/1) has a worst case of
      9007197109406975131647 and is past int64 outright, as expected. But
      `DOMINATING` (1000/100/1) has a worst case of **9007197324153192447**,
      comfortably *inside* int64 — and CP-SAT refuses it too, with "Possible
      integer overflow in objective". Its check is over the model's declared
      domains and is more conservative than the exact arithmetic. The
      prediction and the measurement are both asserted, because the arithmetic
      bound is what a reader would otherwise trust.

      **The general statement, asserted rather than illustrated:** a weighted
      form is faithful only while one unit of the first term outweighs the whole
      range of the rest, so the smallest faithful `c₁` at `c₂ = c₃ = 1` is
      `ub(MAKESPAN) + ub(MOVEMENT) + 1` = 4294967296 — and that times PRIORITY's
      own ceiling lands four orders of magnitude past int64. At the wire's
      ceilings, faithfulness and representability are not both available. This
      is why the staged loop is not merely one implementation of the weighted
      one.

      **TOOLING, resolved.** Run 19's `IntVar.proto.domain[-1]` reading 0 was
      not a wrong field: `.proto.domain` is a protobuf repeated-scalar *view*,
      and a **negative index into it returns 0** instead of the last element
      (ortools 9.15.6755, measured on a variable whose domain is `[0, 140]`:
      `[-1]` → 0, `list(...)[-1]` → 140). Use `list(var.proto.domain)[-1]` or
      `var.domain.max()`; a case asserts the two agree, so reaching for `[-1]`
      again is a red rather than a zero.

      **A DEFECT FOUND WHILE BUILDING THE GUARD — since fixed, in both arms.**
      The old invariant 8 bounded `Σ w × horizonUnits`; the model bounds
      PRIORITY by `Σ w × (horizonUnits + durationUnits)`, because the horizon
      bounds the *start* and the term is over *finishes*. The difference,
      `Σ w × durationUnits`, the old bound did not mention. At weight 2²² the
      request satisfied it (9007199250546688 ≤ MAX_SAFE_INTEGER) and a placement
      at the horizon — **proved OPTIMAL, not a domain ceiling** — publishes
      `priority.value` = 9007199254740992, exactly one past the response
      schema's own `safeInteger`; Bun would refuse the response it asked for.
      Filed as TASK-254, then closed inline: run 20 landed the finish-based
      bound in `preflightSolverRequest`, and run 21 landed the Python arm
      (`check_cross_field` re-derives it from the `horizonUnits` on the wire,
      raising `objective-overflow`) plus the corrected wire text in both schema
      copies. `Invariant8DoesNotBoundThePublishedPriority` became
      `Invariant8BoundsThePublishedPriority` and split in two: the request is
      refused, and — deliberately unchanged — CP-SAT still proves that placement
      OPTIMAL at `MAX_SAFE_INTEGER + 1` when handed the request directly, which
      is what makes the guard load-bearing rather than decorative. Nothing in
      `model.py` was widened or clamped.

- [ ] 5.11 Packaging into the deployed artifact: the Dagger/image path installs
      the pinned Python runtime and the locked OR-Tools environment, copies
      the package and **both** its console scripts — the solve entrypoint
      `wbs-solver` and the lifecycle launcher `wbs-solver-launcher` (6.2b) —
      into the be-01 runtime, and exposes the installed version to the
      coordinator as the `solverVersion` half of `contractVersion`. An Nx
      target runs the Python suite in the gate. **Both scripts are proved from
      the built image (Fable r14 Important 3):** the existing direct spawn of
      the solve entrypoint stays as the package smoke test, and a second proof
      drives `wbs-solver-launcher` through the host supervisor, its real Docker
      container, and a successful bind. Deploy tooling installs the lingering
      restart-always supervisor service, its runtime directory, host-owned
      image mapping, and the directory-only backend mount. Without this a green
      gate coexists with an image whose launcher
      is absent, which fails every production solve at bind time — the exact
      packaging failure this task exists to close.
      **Watched red (two):** build the image without the package; the spawn proof
      must fail with `internal-error` rather than silently falling back. Then
      build it with the solve entrypoint but **without** the launcher: the
      smoke test still passes and the launcher-path proof must fail. A missing
      supervisor, stale prod mapping, incompatible dev mapping, or socket-file
      mount instead of directory mount must fail deployment before swap.

## 6. OptimizationCoordinator — admission, spawn, cancel, restart

- [ ] 6.1 Coordinator in `apps/be-01/src/service/`: with the toggle ON, publish
      Fast, consult the cache, and request admission for variants **absent at
      the current full key** — on a debounced edit _and on a read_. A read
      admits an absent variant, which is how an enabled project recovers after
      a restart, a contract-version bump or a cache eviction without waiting
      for someone to type; it **never** auto-admits a variant holding a
      `failed` or a `corrupt` row for that exact key, and a same-hash edit is
      suppressed for those two terminal rows only. **This replaces the earlier
      "never on a read" wording (Sol r8 Important 9)**, which contradicted 6.6,
      the spec's two-concurrent-first-reads scenario and the design's selection
      rule, and would have left a cold enabled project on Fast for ever. Child
      killed at `solverBudgetMs + 5000`; a result is written only under the
      generation predicate of 4.1.
- [ ] 6.2 **Admission in SQLite, not memory**: one transaction that reclaims
      slots whose stored `admittedDeadlineAt` has passed, refuses at 4 rows for
      the project and 16 rows globally counting **every** unreleased row
      including those already asked to cancel, rejects unless the matching
      generation has `admissionState='open'` and the project has no
      `optimization_delete_pending_at`, then inserts the
      `(projectId, contractVersion, generation, objective, budgetMs)` slot with
      `ON CONFLICT DO NOTHING` so concurrent cold reads coalesce to one spawn,
      stamping a fresh 128-bit `attemptToken` and
      `admittedDeadlineAt = startedAt + budgetMs + 5000 +
SLOT_RECLAIM_MARGIN_MS` **from the admitting coordinator's own budget**.
      **The insert is `lifecycle='starting'` with a NULL `pid` (Sol r12
      Critical 2)** — the PID does not exist at reservation time, and the
      reservation is what the ceiling counts, so a `starting` row counts
      against 4 and 16 identically to a `running` one and expires by the same
      `admittedDeadlineAt`.
      Expiry is read from that column and never recomputed from the observing
      coordinator's config. `ownerId` is a UUID minted at coordinator boot;
      `heartbeatAt` is refreshed every 5 s for live slots and the row is
      deleted when the child exits. **This is the whole admission protocol
      (Sol r8 Critical 3).** The earlier text here named the three-column key
      `(projectId, generation, objective)` and a `budgetMs + 30s` reclaim, both
      superseded by 3.2 and 6.10–6.11; an implementer following it would have
      lost the blue/green, cancellation and old-owner fences the design calls
      mandatory. No alternate key shape or reclaim rule is restated anywhere in
      this plan.
- [ ] 6.3 `solver_queue` FIFO ordered by `enqueuedAt`, then `projectId`, then
      `contractVersion`, then `objective`, then `budgetMs` — the trailing terms
      are what make the order total, because a project's PRI and Time entries
      can share a timestamp and blue and green can enqueue the same project and
      objective in that same millisecond (Sol r7 Minor 15) — one entry per
      `(projectId, contractVersion, objective, budgetMs)`, the row carrying
      `budgetMs` because the dequeue cannot otherwise say which budget to
      launch (Sol r8 Critical 2). Enqueue **persists the cancel
      epoch it was admitted under** as `admittedCancelEpoch`; without a stored
      epoch the dequeue re-check has nothing to compare against (Sol r7
      Important 8). Dequeue re-reads the `optimization_generation` row and
      discards the entry without launching if its generation is no longer
      current, `admissionState != 'open'`, `cancelEpoch != admittedCancelEpoch`,
      the project's toggle is no longer ON, or
      `optimization_delete_pending_at` is non-null. **Watched red:** enqueue PRI and Time at the identical
      timestamp and assert a single deterministic dequeue order; enqueue the
      same project and objective from two contract versions at that same
      timestamp and assert the same; toggle OFF while an entry is queued and
      assert it is discarded without a spawn; drop `admittedCancelEpoch` and
      the OFF-while-queued case must fail. **The dequeue reads its row through
      `toSolverQueueRow`** (3.8) rather than off the raw select, so a corrupted
      `objective` throws here instead of reaching the spawn identity — that is
      3.8's last clause, which had no spawn identity to name when it was
      written. **Watched red:** inject `'prio'` into a queued row with the
      `CHECK` dropped and the dequeue must refuse it by name; remove the
      decoder from the dequeue and the corrupted objective must reach the
      spawn identity instead.
- [ ] 6.4 Cancellation, and the two paths are **not** the same operation. A
      newer edit changes the hash and therefore allocates the next generation.
      An **OFF toggle does not**: the toggle is excluded from the hash, so
      allocation is required to reuse the generation for an unchanged hash and
      "OFF allocates the next generation" was unimplementable. OFF is one
      transaction that clears `optimization_enabled`, increments `cancelEpoch`
      for every contract version of the project, sets `cancel_requested_at` on
      all of that project's `solver_slot` rows and deletes its queue rows.
      Owners observe the durable signal on their heartbeat round trip and kill
      their child, so a child owned by the _other_ backend is cancelled too — a
      local process handle cannot reach it and `PR_SET_PDEATHSIG` is irrelevant
      while that coordinator is alive. Both paths reject with a typed
      `cancelled` outcome and write no row. Idempotent and project-scoped.
- [ ] 6.4b **Proven by** `optimization-cancel.two-coordinator.test.ts`: blue
      owns a live PRI child and a live Time child, green serves the settings
      PATCH turning optimization OFF. **Watched red** with the epoch condition
      removed: both real children exit within one heartbeat interval, and
      neither can store a result, write a failure marker, or emit any event.
- [ ] 6.2b **Spawn handshake: reserve, spawn, bind, fence** (Sol r12
      Critical 2; Sol r13 Critical 1; Fable r14 Important 3). **The launcher's seam, which no
      task named until now:** it is created by this task as a second console
      script `wbs-solver-launcher` in the **same** `wbs-solver` distribution —
      not a be-01 file and not a separate package — because it must be present
      wherever `wbs-solver` is, must version-lock to it (both sides of the bind
      protocol change together), and the image build already installs exactly
      that one distribution. It imports no CP-SAT. `wbs-solver` remains the
      only _solve_ entrypoint; spec.md's "exactly one entrypoint" is scoped to
      the solve contract accordingly, and 5.11 installs and proves both scripts.
      _Assumption, falsifiable:_ if the launcher ever needs a dependency the
      solver distribution must not carry, split it into its own version-pinned
      package and give 5.11 a second install proof. After 6.2's `starting`
      insert, the coordinator opens one connection to the host supervisor and
      sends the bounded `start` frame from `supervisor-amendment.md`. The
      supervisor authenticates the caller with `SO_PEERCRED`, selects the
      host-owned image mapping, applies its caps, creates and starts the
      non-networked Docker container, and returns the container init PID. The
      launcher receives `--attempt-token` and `--child-deadline-epoch-ms` as
      argv, never request fields, and blocks before reading the request. The
      coordinator binds with
      `UPDATE solver_slot SET pid=:pid, lifecycle='running' WHERE <key> AND
attempt_token=:token AND lifecycle='starting'` (with `:pid` the
      container init); one row means `bound`, after which the supervisor sends
      the verdict plus exact request and the launcher `exec`s `wbs-solver`;
      zero rows means `abort` plus the ordered kill/wait/inspect/remove path.
      The launcher exits without `exec`ing on `abort`, closed stdin,
      `BIND_TIMEOUT_MS = 5000`, or a spent child deadline.
      **Proven by** `optimization-spawn-handshake.proc.test.ts`, a real
      two-coordinator process test that pauses the owner between the
      `starting` insert and the bind while time advances past the row's
      stored `admittedDeadlineAt` (not merely past the reclaim margin), lets
      the peer reclaim and admit a replacement whose launcher binds and
      `exec`s `wbs-solver`, and samples Docker plus SQLite throughout: the
      delayed bind matches zero rows and exits without a solve; live managed
      containers never exceed unreleased `starting` plus `running` rows, and
      solve-start state never exceeds `running` rows, at most 4/16.
      **Watched red:** let the launcher `exec` `wbs-solver` without waiting
      for the bind verdict — or drop the `lifecycle='starting'` predicate
      from the CAS — and the paused-owner case must show two live
      `wbs-solver` processes against one reclaimed slot.
      **Second case, the verdict that never arrives:** the test above proves
      only the _zero-row_ path, where a live coordinator writes `abort`. Add a
      case whose coordinator neither binds nor aborts but keeps the connection
      open: assert the launcher exits on its own
      after `BIND_TIMEOUT_MS = 5000` with stdin still open, that no
      `wbs-solver` process is created for that token, and that the `starting`
      row is reclaimed by `admittedDeadlineAt` and not by a live holder.
      **Watched red:** remove the timeout and let the launcher block on read —
      the launcher must still be alive when the assertion runs.
      **Fourth trigger, the bind into a spent budget:** reclamation is
      `now > admittedDeadlineAt` and runs only inside sweeps, so an owner
      paused between `childDeadlineAt` and `admittedDeadlineAt` — a
      `SLOT_RECLAIM_MARGIN_MS`-wide window against an unswept row — still
      binds with its token intact and its budget already spent. The launcher
      SHALL treat a `bound` verdict with `now >= childDeadlineAt` as abort and
      exit without `exec`ing, because a non-positive duration is undefined at
      both arming mechanisms. Add the case to this proc test: pause the owner
      into that window, let the bind succeed, assert no `wbs-solver` process is
      created and the slot is released. **Watched red:** arm the child anyway
      with the non-positive remainder — the test must show either a
      `wbs-solver` process or an unbounded one.
- [ ] 6.5 Restart: nothing resumed, no queue rebuilt. Orphan handling is not a
      PID search. Coordinator socket EOF makes the supervisor kill that exact
      managed container; its persistent per-attempt systemd timer retains the
      child-deadline kill across a supervisor-process restart. The
      restart-always supervisor kills and inspects every managed orphan before
      listening. A coordinator seeing EOF without a terminal frame keeps the
      slot counted until the deadline margin. Startup **does** run 3.9b's
      `reconcileOptimizationDrains()` once before serving and then on its
      interval; that is the only startup sweep, and it resumes no solve
      (Sol r12 Critical 3).
- [ ] 6.6 **Proven by** `optimization-coordinator.test.ts`, asserting on an
      injected spawner rather than timing: a cold input spawns exactly two; a
      full hit spawns none; **two concurrent first reads spawn exactly one per
      objective**; a second edit mid-solve kills the old pair (asserting the
      child process actually exited, not that a flag was set) and writes no
      stale row; the per-project count never exceeds 4 during termination
      overlap; the queue discards a stale-generation entry at dequeue; the
      queue discards a still-current-hash entry whose project toggled OFF while
      queued.
- [ ] 6.7 **Proven by** `optimization-admission.db.test.ts`: **two coordinator
      instances against one SQLite file** — the blue/green case — admit 16
      children between them, not 32, and 4 for one project, not 8; and a
      coordinator killed without cleanup has its slots reclaimed once
      `now > admittedDeadlineAt` — never by a missed heartbeat — rather than
      leaking capacity forever.
- [ ] 6.8 **Proven by** `optimization-orphan.proc.test.ts`, a **real
      process-boundary test**, not a mocked restart: start an inert managed
      container, kill the coordinator, and observe (a) socket EOF makes the
      supervisor kill/wait/inspect/remove that exact container and (b) the slot
      remains counted until termination is proven. Separately restart the
      supervisor mid-attempt and prove its systemd timer still kills at
      `childDeadlineAt` and its pre-listen sweep clears the orphan.
- [ ] 6.9 **Negative checks, watched red** — remove the dequeue generation
      re-check and watch 6.6's stale-entry case fail; remove the toggle
      re-check and watch the toggled-OFF case fail; move admission back into an
      in-memory counter and watch 6.7's two-instance case fail; drop the
      supervisor's disconnect kill and watch 6.8 fail. Four faults, four `Proof:`
      comments, because one check passing does not prove the others exist.
- [ ] 6.8b **Restart semantics, one implementable rule** (Sol r10 Important 7).
      `optimization-restart.db.test.ts`: (a) an in-flight child is never
      adopted or resumed by the restarted coordinator; (b) a durable
      `solver_queue` entry whose generation is current, whose
      `admittedCancelEpoch` matches and whose project is still ON **survives
      the restart and launches** — it is not discarded, and the earlier
      "entries left by a dead process are discarded by the generation
      re-check" claim was unimplementable; (c) an entry failing any one of
      those three predicates is discarded without a spawn; (d) a restart with
      an unchanged plan **reuses** the generation rather than allocating a new
      one, matching 6.10's allocation rule; (e) an absent variant is
      re-admitted in that same generation only once any orphan `solver_slot`
      row for its key is released or passes its stored `admittedDeadlineAt`.
      **Watched red:** drop (e)'s orphan wait and the restarted coordinator
      must spawn a duplicate beside a still-live child, breaking the sampled
      per-project ceiling; separately, make the restart allocate a fresh
      generation and (d) must fail against 6.10.
- [ ] 6.9c **Four eviction authorities, four separate reds** (Sol r10
      Important 9). The four-part `(generation, cancelEpoch, enabled,
attemptToken)` predicate governs **worker-owned outcome writes only**;
      three other paths evict under their own authority and have no child
      token to present. Each gets its own test and its own watched red, so
      weakening one cannot silently weaken another: (a) _worker outcome_ —
      drop the `attemptToken` term and a reclaimed-then-superseded owner's
      late store must succeed where it should have matched zero rows;
      (b) _allocation eviction_ — require a token in the allocation
      transaction and the cold-start hash change must fail outright, since no
      child exists yet; (c) _OFF cleanup_ — require a token in the
      `optimization_enabled = 0` transaction and the queue rows must survive
      the toggle; (d) _deletion/retirement eviction_ — require a token in the
      drain protocol and 3.9b's phase 2 must fail. Assert in (b), (c) and (d)
      that the eviction is authorized by the CAS, the epoch increment and the
      drain phase respectively — not by a token.
- [ ] 6.9b **The empty project bypasses both solvers** (Sol r7 Important 12).
      A project with no slices is legal — `schedule` handles it explicitly with
      `projectFinish = Math.max(0, ...placedFinishes)` and empty maps — but
      `MAKESPAN = max finish` has no empty-set identity, so it was undefined on
      a plan the product allows. `horizonUnits` is **not** a second reason: its
      `notBeforeUnits` max is seeded with zero (task 2.2; its overflow check is
      2.10 — task 2.3 is `parseSolverResponse` and never built the horizon,
      Sol r13 Minor 5), so it is defined for
      every plan, including one with slices and no manual floors — the common
      case (kimi r10 Minor 4). The coordinator short-circuits: a
      canonical input with zero slices, or one whose durations are all zero,
      allocates no slot, spawns nothing, writes no cache row and emits no
      event; the plan read returns Fast with every variant `idle`. **Watched
      red:** a cold read with optimization ON and zero work items — no call on
      the injected spawner, no row, no event, and a renderable payload; then
      add and delete the only work item and assert the same, since that
      transition is what would otherwise leave a stale row. Remove the
      short-circuit and the spawner assertion must fail.
- [ ] 6.10 Generation allocation is one transaction against the
      `optimization_generation` row for `(projectId, contractVersion)`, and
      there is exactly one allocation algorithm in this plan — 4.1's (Sol r7
      Critical 4). Equal `inputHash` reuses the generation; a different or NULL
      hash sets the hash and increments under
      `WHERE project_id = :p AND contract_version = :c AND generation = :seen`,
      deleting that contract version's previous-generation **cache and queue**
      rows in the same transaction and marking its `solver_slot` rows
      `cancel_requested_at` **without deleting them**, so the row count stays
      an upper bound on live children. A first enable, or the first appearance
      of a new `contractVersion`, has no row to compare against: allocation
      therefore begins with an `INSERT … ON CONFLICT DO NOTHING` of
      `(generation = 1, inputHash = :H, cancelEpoch = 0)` and re-reads, so two
      concurrent first writers coalesce onto one generation rather than one
      failing (Sol r7 Important 8).
      **Watched red:** two concurrent allocators for one hash must produce one
      generation and one child per objective; two concurrent _first_ allocators
      for a project that has never optimized must produce one row and one
      child per objective; an allocator for a different hash must not coalesce
      onto the current slot; a restart on an unchanged hash must allocate
      nothing; and deleting the slot rows at allocation must make 6.7's
      two-instance ceiling case fail.
- [ ] 6.11 Slot fencing: admission mints an unforgeable 128-bit
      `attemptToken`; heartbeat, release, the outcome write and the event write
      all carry it, and 6.2b's bind CAS is the first statement that presents
      it. The two deadlines are deliberately different:
      `childDeadlineAt = startedAt + budgetMs + 5000`, armed for that earlier
      instant **twice — inside the child and outside it (self-found, round
      10)**: the wrapper passes `childDeadlineAt − now` as CP-SAT's
      `max_time_in_seconds` so a progressing solve stops itself and returns a
      publishable partial, and the host supervisor creates a transient systemd
      user timer that runs `docker kill <exact-id>` at `childDeadlineAt` even
      if the supervisor process restarts. **A Python `SIGALRM`
      alone is not sufficient and must not be written as the mechanism:**
      `wbs-solver` is a Python package, the handler runs only when the
      interpreter regains the GIL, and `CpSolver.Solve()` is one long native
      C++ call — the same reason 5.4b moved the memory bound outside the solve.
      SQLite alone stores and observes
      `admittedDeadlineAt = childDeadlineAt + SLOT_RECLAIM_MARGIN_MS` (15 s).
      Reclamation mints a new token and is exactly `now > admittedDeadlineAt`,
      using the absolute value stamped once at admission from that row's own
      `budgetMs` (6.2), so the **external** kill lands a full margin before the
      row can release capacity — the exit half of 6.2b's ceiling, which would
      otherwise rest on a wedged process honouring its own bound.
      **Watched red:** arm the deadline only in-process, run a fixture whose
      native solve ignores it past `admittedDeadlineAt`, and assert a live
      managed container exists without an unreleased row. **`SLOT_HEARTBEAT_TTL_MS` is struck (Sol r9
      Critical 4):** a TTL derived from the observing coordinator's current
      `solverBudgetMs`, or added to a refreshed `heartbeatAt`, is not the admitted
      child's absolute deadline, and across a 60 s/120 s blue-green overlap it
      either reclaims a live child or holds a dead slot past the promised bound —
      either way the claim that SQLite rows upper-bound live processes fails.
      `heartbeatAt` survives for cancellation observation and diagnostics only.
      **Watched red:** change the observing coordinator's configured budget and
      assert neither row's expiry moves.
      Coordinator loss is the supervisor's socket-EOF kill path; supervisor
      loss is covered by the persistent deadline timer and pre-listen orphan
      sweep. **Watched red:** the managed container is gone before a sweep at
      `admittedDeadlineAt` deletes its slot and admits a replacement; arming the
      timer at `admittedDeadlineAt` must fail. An old owner's late heartbeat,
      release and write each match zero rows; live managed containers never
      exceed all unreleased rows or 4/16 across two coordinators.

## 7. Failure path and events

- [ ] 7.1 Non-zero exit, timeout, OS kill, OOM and failed re-validation each
      write exactly one `status='failed'` row with a typed `failureReason`
      (`timeout | invalid-output | no-solution | internal-error | oom | horizon-overflow | objective-overflow`), keep
      Fast visible, and never retry — not on a timer, not on a read, and not on
      a same-hash edit. A **cancelled** run writes no row at all. Failure is
      variant-specific. **"Publish nothing" is struck** (Sol r7 Important 14):
      in this codebase `GatewayBroadcaster.publish` _is_ the event operation, so
      the phrase read as a prohibition on the failure event that 7.4 and 7.6
      require. The rule is exact — a failure publishes **no**
      `schedule_optimized` and stores no schedule, and it **does** publish
      exactly one `schedule_optimization_failed` in the same transaction as its
      marker row, including for a pre-spawn `horizon-overflow` or
      `objective-overflow`.
- [ ] 7.2 `schedule_optimized` added to `ProjectEvent` in
      `apps/be-01/src/service/broadcast.ts`, carrying `(projectId, generation,
inputHash, objective, contractVersion, budgetMs)` (7.7). **The cache row
      and the `event_log` record are written in one SQLite transaction** and the
      broadcaster pushes from the committed record, so the guarantee is one
      durable replay record per newly stored outcome plus one best-effort
      post-commit push (7.9), idempotent for receivers. Never emitted on a
      cache hit.
      Toggle/Engine/Objective changes emit `project_settings_changed` (3b.3)
      instead.
- [ ] 7.3 Retry is a route, not an unnamed "action": its contract, statuses
      and authorization are 7.11. It re-reads the current `inputHash`, refuses
      a moved plan with the current hash in the body, then launches only the
      `failed` or `corrupt` variant for the unchanged key — an **absent** variant is `idle`, admitted by the cold read (6.1) rather than by Retry, which answers `409 not-retryable` naming it (Sol r9 Critical 3). Its `failed` row is
      **overwritten by the replacement outcome, never deleted first**, so
      concurrent reads see `retrying` rather than `failed` or a cold miss that
      would auto-spawn.
- [ ] 7.4 **Proven by** `optimization-failure.test.ts` and
      `optimization-events.test.ts`: each of the seven failure kinds — including the two pre-spawn ones, `horizon-overflow` and `objective-overflow`, which write the marker and emit the failure event although no process ever started — keeps Fast
      and writes exactly one failed row; a **cancelled** run writes none; PRI
      failing leaves Time selectable; a stored result writes exactly one
      `event_log` row with the right payload; **a crash injected between the
      cache write and the event write leaves neither** (asserted on the
      `event_log` row, not on a broadcaster spy); a cache hit emits nothing; an
      Objective switch emits `project_settings_changed` and no
      `schedule_optimized`; Retry after a hash change starts a fresh generation
      rather than the stale variant.
- [ ] 7.5 **Negative checks, watched red** — emit `schedule_optimized` on a
      cache hit and watch the "cache hit emits nothing" case fail; then split
      the cache write and the event write into two transactions and watch the
      crash-injection case fail. Two `Proof:` comments. A broadcast per read
      would make every collaborator refetch unchanged data; a split write is a
      result nobody is told about.
- [ ] 7.6 A newly written failure marker emits `schedule_optimization_failed`
      in the same transaction as the row, carrying `(projectId, generation,
inputHash, objective, contractVersion, budgetMs, failureReason)` and no
      schedule. Without it the read returns Fast, success emits
      `schedule_optimized`, and failure emitted nothing — so a client on
      screen sat at `Optimizing…` for ever and manual-only Retry was
      unreachable. A cache **hit** still emits nothing; a hit is not a new
      outcome. **Watched red:** both variants fail with no other event; the
      client must reach `Optimization unavailable · Retry` with no refresh.
- [ ] 7.7 `budgetMs` joins both event identities. It is a cache-key column and
      changes neither hash nor generation, so without it a larger-budget
      result announced itself under the smaller-budget identity and a client
      holding that identity ignored the only notice that should move it.
      **Watched red:** raise the budget, store, assert the client refetches.
- [ ] 7.8 Name the seam rather than assume it: `EventLogRepo.recordEventIn(tx,
subscription, message, createdAt)` writes inside the caller's
      transaction, and `GatewayBroadcaster.pushRecorded(subscription,
recorded, event)` buffers and pushes an already-recorded sequence
      without recording it twice; today `recordEvent` opens its own
      transaction and `publish` does both. `publish` becomes those two calls.
- [ ] 7.9 The guarantee is narrowed in every artifact to **one durable replay
      record plus one best-effort post-commit push** — `event_log` is a replay
      buffer consulted on resume, not a dispatched-and-acknowledged outbox,
      and a process can die after commit and before the push, so "delivered
      at least once" over a live socket was false. **Watched red:** kill
      between commit and push; the record must exist and a client resuming
      from its last sequence must receive it.
- [ ] 7.10 The plan-read DTO: `tree()` returns an `optimization`
      block — `enabled`, `engine`, `objective`, `inputHash`, `generation`,
      `contractVersion`, `budgetMs`, `displayed`, `variants: { pri, time }`,
      `comparison` present iff `displayed !== 'fast'`. A variant is one of seven:
      `ready`, `pending`, `retrying`, `failed` with reason, `corrupt` with the
      decoder's message, `plan-infeasible` with every offending work item and its
      **effective** deadline, or `idle`, distinguished by the cache row **together
      with** a live slot or queue entry matched on the **full** key including
      `budgetMs` — which is
      what lets a retry in flight read as `retrying` while its marker row
      survives, instead of forcing either a permanent "unavailable" or a
      delete that would make the next read auto-spawn. Arrays hold Fast unless
      the selected variant is `ready`. `corrupt` renders the same
      `Optimization unavailable · Retry` control as `failed`; the round-7
      disposition added it to spec.md and left this union, the design's
      `VariantState` list and 8.3–8.4 at five members (Sol r8 Critical 6).
      `plan-infeasible` renders `Plan infeasible · N work item deadlines` and
      **no** Retry control, and Retry answers `409 not-retryable` for it — the
      same divergence trap, so this union, the design's `VariantState` list,
      spec.md and 8.3–8.4 move to seven together or the gate is red.
      **Proven through the real controller payload** in the cold, queued,
      retrying, failed, **corrupt**, **plan-infeasible**, partial-success and
      full-hit states.
- [ ] 7.11 `POST /api/projects/:projectId/optimization/retry`, body
      `{ objective, inputHash }`, under the same project-write authorization as
      the settings PATCH, running the ordinary admission transaction so two
      concurrent retries produce one child. `202` with the new state,
      generation and hash; `409 stale-input-hash` carrying the current hash;
      `409 already-running` evaluated against the **full** cache key including
      `budgetMs`; and a single `409 not-retryable` naming the current state for
      everything else. **Retry accepts a `failed` row or a `corrupt` one (Sol
      r8 Critical 6)** — a corrupt row is a `status='ok'` row, so the earlier
      `not-failed` guard forbade the only recovery path 4.8 and the codec
      requirement offer it. The marker or corrupt row is never deleted before
      its replacement outcome commits, and is then overwritten exactly once.
      **Watched red:** two concurrent Retries on one corrupt row must produce
      one child with both responses `retrying` and the bad row intact until the
      replacement commits; a Retry against a `ready` variant must return
      `not-retryable` naming `ready`; restore the `not-failed` guard and the
      corrupt-row Retry case must fail. A Retry against a `plan-infeasible`
      variant must likewise return `not-retryable` naming `plan-infeasible`:
      admitting it would spend a slot re-proving the same certificate and put a
      Retry affordance on an answer that cannot change.

## 8. UI — toggle, selectors, indicator

- [ ] 8.1 Project Settings hidden toggle bound to `optimization_enabled` (3b),
      OFF by default, project-scoped and persisted through the PATCH contract —
      **not** component-local state.
- [ ] 8.2 Engine (Fast / Optimized) and Objective (Priority-first /
      Finish-first) selectors bound to `schedule_engine` and
      `schedule_objective`, project-scoped and persisted. Switching to an
      already-cached output starts no solve. Both react to an incoming
      `project_settings_changed` event so collaborators converge.
- [ ] 8.3 The one compact indicator: Earlier by N days / Later by N days / Same
      deadline + reordered / Same deadline + same order, plus
      `Optimization unavailable · Retry` on **both** the `failed` and the
      `corrupt` variant states (Sol r8 Critical 6 — the round-7 disposition
      added `corrupt` to spec.md and left this list at five states),
      `Plan infeasible · N work item deadlines` on the `plan-infeasible` state
      with **no** Retry control and the offending items listed on demand, and
      `Optimizing…` while the selected variant is admitted but not stored — with Fast on screen
      throughout, never a blank plan or a spinner over it. No toast, no modal,
      no timer retry, no second indicator. On `plan-infeasible` the indicator
      SHALL NOT fall back to reading Fast's late plan as a satisfied baseline:
      Fast stays on screen, stays usable, and stays labelled `Late by N
workdays` per missed item — Fast's lateness is a report, never a verdict
      of feasibility (`openspec/changes/work-item-deadline/design.md` §3.1).
- [ ] 8.4 **Proven by** `optimization-indicator.test.tsx` and
      `optimization-settings.test.tsx`: each of the four comparison outcomes
      renders its exact wording with the right day count; a `failed` variant
      renders Retry; a `corrupt` variant renders the **same** Retry control; a
      `plan-infeasible` variant renders the count wording, lists its offending
      items on demand, and renders **no** Retry control while Fast stays on
      screen with its per-item `Late by N workdays` labels intact; a
      pending variant renders `Optimizing…` over Fast offsets;
      no toast or modal role appears in the tree in any of those states; a
      toggle change issues the PATCH and **survives a remount** (proving it is
      persisted, not local); and an incoming `project_settings_changed` moves
      the selector without a local click.
- [ ] 8.5 **Negative check, watched red** — hold the three settings in
      component state instead of the project row and watch 8.4's remount and
      incoming-event cases fail. `Proof:` comment names the reverted binding.
      Local-only controls are exactly the failure the persistence slice exists
      to prevent.
- [ ] 8.6 A user-facing feature: file one lane-q Browser Use Cloud QA task after
      deploy.
- [ ] 8.7 `sameOrder(a, b)` is the exact relation, computed server-side on the
      **materialised** schedules and shipped as one boolean beside the
      day-count delta: it holds iff for every pair of slices present in both,
      `sign(startA(s) - startA(t)) === sign(startB(s) - startB(t))` compared in
      the **real fractional-workday domain**, never in quantised units (Sol r7
      Important 10) — real Fast's starts need not lie on the 1/48 grid, so two
      distinct Fast starts can collapse to one unit and rounding can reverse a
      tie, and the quantised rule would then label the same pair differently
      from design.md and the spec. It is blind to a uniform shift and to
      iteration order, and it treats ties as first-class — a tie broken and a
      tie created are both reordered. **Watched red / scenarios:** uniform
      two-day shift (same order, later deadline); a tie broken (reordered); a
      tie created (reordered); a zero-duration slice moved across another's
      start (reordered); and a **fractional fixture whose verdict differs
      between the two domains** — two slices 1/96 of a workday apart, same
      order in the real domain and tied after quantisation — which is the only
      case that proves the domain choice, since the whole-day and tie cases
      pass under either rule. Client-side computation is forbidden, so client
      and server cannot label the same pair differently.
- [ ] 8.8 The failure indicator is driven by `schedule_optimization_failed`
      rather than by a refetch, and shows per variant.
- [ ] 8.9 The FE mirror in the same slice as the union change:
      `ScheduleFloor` in `apps/fe-01/src/lib/wbs-api.ts` and the exhaustive
      `floorWordsOf` switch in
      `apps/fe-01/src/components/wbs/gantt-geometry.ts` gain `'optimizer'`.
      **Watched red:** three optimized fixtures whose starts are respectively
      equal to a person floor, equal to a capacity floor, and strictly later
      than both — asserting predecessor edges, late times, both wait counters,
      the API union and the hover words, so a resource-bound optimized slice
      keeps its explanation instead of being labelled `optimizer`.

## 9. Corpus and regression safety

- [ ] 9.1 Extend the generated corpus to >=1,000 seeds covering
      scheduler → API → Gantt for both objectives and both engines, including
      the people, capacity, priority, **dependency-reach and manual-floor**
      facts the current generator omits.
- [ ] 9.2 The existing Fast corpus (schedule-shapes / identity / capacity /
      leveling / priority / benchmark) keeps passing unchanged, and is **keyed
      by `SCHEDULER_CONTRACT_VERSION`** (1.5) so a Fast change without a bump
      fails it. Fast is the preview and fallback, never the optimality claim.
- [ ] 9.3 The known capacity/floor hand-off audit finding (backward-graph
      hand-off dropped → false float) stays open and documented. The optimizer's
      re-validation must not mask it: a corpus case reproducing it is asserted
      to still reproduce.

## 10. Gate and close

- [ ] 10.1 Remote gate on h2puni: **`bin/h2puni-gate.sh`** (it takes the
      host-wide lock; `AGENTS.md` 466–473 forbids the raw full Nx gate there),
      **`bunx @fission-ai/openspec@1.3.0 validate --all --json`**, the Python suite, and the
      **positive/negative built-image spawn proof** — this change's packaging
      claim is a Python-enabled built image, so a gate without `build` cannot
      observe it. The actual CI run (`.github/workflows/ci.yml`) is retained as
      the merge gate; its job runs `bunx nx format:check --all` and
      `bunx nx run-many -t test lint typecheck build`, so **format and build are
      part of the real gate** (Sol r9 Important 5). `openspec/config.yaml`'s
      "There is no CI" line was stale and is corrected in this slice so later
      plans do not inherit an under-scoped gate. Record the actual output in `verify.md` with the failure-proof
      table (fault injected, the case that observed it failing, result) for
      every watched-red check in slices 1–9.
- [ ] 10.2 Terminal review of the exact head: the Anthropic↔OpenAI peer plus
      Gemini; every Critical/Important finding dispositioned.
- [ ] 10.3 Slices 3 and 3b each ship as a reviewed PR (`status: review`, no
      self-merge) — both touch `apps/be-01/drizzle/**`. The remaining slices
      are dev-mode and follow the normal PR + green CI + merge path.
      **Slice order is a correctness constraint, not a preference (Sol r12
      Important 5):** every column a slice's own code and tests read is
      created by that slice's own migration, so slice 3 carries
      `optimization_delete_pending_at` (3.1b) and slice 3b carries only the
      three user-facing settings. Verify before starting either PR that no
      task in a slice references a column another slice creates.
