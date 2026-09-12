# design — `arrange-by-schedule`

## Context

Row order and tree containment are one thing here. `work_item.position` is an integer
scoped to `(project_id, parent_id)`, spaced by ten (`libs/domain/src/place-sibling.ts`);
`deriveNumbers` turns positions into `010`, `020`, `010.1`; be-01 sorts the read once by
that number **string** (`work-item.service.ts:1893`) — which is tree order only because the
numbers are built so that byte order equals position order — and `wbs-table.tsx:514-524`
says in so many words that ordering is not the client's job. The only way rows move is
`moveWorkItem`, one row, refused `frozen` when the row carries a `frozenNumber`, at three
layers (`work-item.service.ts:2254`, `drag-drop.ts:80`, `use-plan-keyboard.ts:452`) and once
more at undo replay (`:3868`).

Frozen labels are **anchors** in `deriveNumbers`: an unfrozen sibling claims the next natural
label below the next anchor, or `below(ceiling)` / `between(previous, ceiling)` when no
natural label fits — `0105` between `010` and `011` — and `between` throws when nothing
digit-shaped sorts between two anchors. That whole mechanism assumes anchors ascend along
position, which the move refusal is what guarantees.

The schedule the chart draws is `planned = optimized ?? fast` in the plan read
(`work-item.service.ts:1755-1776`). Every row gets a **projection** — `earliestStart`,
`earliestFinish`, `float` — a parent's being the span of its leaves. Fast breaks contention
ties by the number string (`goesFirst`, `schedule.ts:2475-2483`, "the tie goes to the row
that reads first"), and positions plus frozen numbers are part of the canonical schedule
input (`canonical-schedule-input.ts:158-159`).

A command batch is one unit of work, one journal entry, one broadcast (ADR 0007, 0015).
Journal entries are `CompensatingCommand` steps (`compensating.ts:55-110`) — `move`,
`set_frozen`, `batch`… — each with `subjectOf`, `touchedBy` and an `apply` arm that
re-checks the world.

Dany, 2026-09-10, on being told a frozen row could not move: _"we can freeze the number and
still move the item; just need to figure out how unfrozen numbers will behave"_. The rule
below is that answer, and he confirmed it the same day.

## Goals / Non-Goals

**Goals:** one press puts every sibling group in the order its bars start, frozen rows
included; it is one act to undo; the order is the selected engine's schedule, not a client's
recomputation; a frozen number stays exactly the label that left the tool.

**Non-Goals:** a view-only sort, sortable headers, re-parenting, re-arranging automatically
after edits, a keyboard chord, a per-project setting, any change to what `Freeze` writes.

## Decisions

### D1 — A write, not a view

The table's order is the plan's order: what collaborators see, what the export carries,
what the numbers derive from. A client-side sort would be a second ordering implementation
(the one `wbs-table.tsx` refuses), would leave the numbers contradicting the rows, and could
not be undone. So the button writes positions. Rejected: a "view by schedule" toggle —
cheaper, but it answers the wrong question and reopens the two-orderings problem.

### D2 — One command, computed on the server, from the selected engine's schedule

`{ kind: 'arrangeBySchedule' }` in the plan command union, handled by
`WorkItemService.arrangeBySchedule(projectId, actorId)`. Inside the write lock the service
reads rows, builds the canonical input exactly as the read does, and takes the schedule of
the **engine the project has selected**: Fast when the engine is `fast` or optimization is
off; the displayed variant when the engine is `optimized` and that variant is `ready`. When
the engine is `optimized` and the variant is pending or failed the command is **refused**,
`schedule_not_ready` — never a silent fall back to Fast, which would arrange the table by a
schedule the reader did not pick (ADR 0022's own reasoning: dates from an engine that never
ran carry no mark). The read's selection is extracted into one method both call, so the
command cannot arrange by a schedule the chart is not drawing.

Rejected: fe-01 synthesising a batch of `moveWorkItem`s — capped at 200, ordered from a read
that may be stale, and every `afterId` a second implementation of the arrangement.

### D3 — Every sibling group, by projection start; ties keep their order

For each parent (roots included), siblings are ordered by `earliestStart` ascending, in the
engine's fractional workdays, compared exactly — never rounded. Equal starts keep the order
they read in today (a stable sort over the read's own order). No second key: two rows
starting the same day are already "next" together, and finish or slack as a tie-break would
move rows for a reason the button's name does not state. A parent's start is the least of
its leaves' (`projectOntoWorkItems`), so a branch sits where its first bar is. A frozen row
is ordered like any other (D4).

### D4 — A frozen number is a name, not a place

Confirmed by Dany 2026-09-10. Four consequences, one rule:

1. **The read orders by tree position, not by number.** `orderByTree(placements)` in
   `libs/domain` — depth-first, siblings by position then id (ADR 0016) — is the one order
   every reader uses: the plan read (`:1893`), `directory-usage.ts:149`, the fe-01 fake
   (`fake-project-api.ts:302`), and anything the sweep in task 2.4 finds. On every plan that
   exists today this is a no-op, because numbers were built to agree with it; the golden
   corpus proves the no-op byte for byte.
2. **A frozen row moves like any row.** The `frozen` refusal is deleted from `move`, from
   `drag-drop.ts`, from the keyboard's Alt+Up/Down, from `applyMove`'s replay, and from the
   `WorkItemRefusal` / wire refusal unions where nothing else answers it. A frozen row's
   `frozenNumber` is reported verbatim wherever it lands.
3. **Unfrozen siblings take the natural labels, skipping frozen ones.** In position order,
   each unfrozen sibling claims the next label from `labelsFor(group.length)` that no frozen
   sibling in the group holds as its last segment. No fitting between anchors: `below` and
   `between` are deleted with their tests. Two rows in one group can never share a label,
   which is the fault the anchor code existed to prevent — and the only one this keeps.
4. **Fast's contention tie-break is tree order.** `goesFirst` compares the rows' indices in
   `orderByTree` instead of their number strings. Byte-identical on every plan without a
   moved frozen row (golden corpus), and the comment's meaning made literal on the rest.

**The cost, stated:** once a frozen row has moved, numbers in its group stop reading as
order — a frozen `010` may sit third while the unfrozen row above it reads `020`. Ordinal
numbers and movable frozen rows cannot both hold, and Dany chose the rows. Hover on the
number already explains a frozen label; nothing new is drawn.

Rejected: frozen rows keeping their place with the rest arranged around them (the first
draft; a plan with one frozen ticket could never be arranged where it mattered), refusing
the arrangement on any frozen row, and a two-regime numbering that fits between anchors
while they ascend and skips them once they do not.

### D5 — The journal step is exact positions

A new `CompensatingCommand` arm, `{ do: 'set_positions', placements: { id, parentId,
position }[] }`. Forward holds the new positions of every row in a changed group; inverse
holds their prior positions. `touched` is the rows whose **place** changed, so a peer's undo
on one of them is refused as `stale_undo` in the existing sentence and this entry's own undo
is refused once such a row has changed. `subjectOf` answers `{ workItemId: null }` like
`set_frozen`: the event is plan-wide. `apply` re-checks that every id is still present and
still under the parentId the step names, in `applyMove`'s wording; there is no frozen check
to make (D4). Rejected: an inverse of _n_ `move` steps — replays through `placeAfter` one at
a time and its `afterId`s go stale the moment a sibling is added.

### D6 — Changed groups are respaced to `10, 20, 30…`; unchanged groups are not written

A group whose order is already D3's is not touched: no write, no revision bump, no
placement in the step. A group that changes is respaced whole, which also retires any tied
positions in it (ADR 0016). The repository gets `setPositions(placements, moved, stamp)` —
one transaction, positions on every placement, `revision: bumpedWorkItem` only on `moved`,
after `move`'s own split at `work-item.ts:755-764`.

### D7 — Refusals and the no-op

- `scheduleError === 'cycle'` → refused `cycle`: there is no schedule to arrange by.
- Optimized engine selected, variant not ready → refused `schedule_not_ready` (D2).
- Absent engine capability → the read's own typed refusal (ADR 0022).
- `not_found` / `forbidden` as every project command.
- **Nothing to arrange** (every group already in order, or no group with two rows) → lands
  `ok`, writes nothing, journals nothing, announces nothing — `freeze`'s precedent for a
  write that pinned nothing.

### D8 — The toolbar control: a narrow icon

Dany: _"an icon"_, and _"a small column for now"_ — read as the narrowest control the bar
can carry. An icon button after `Expand all` — the three controls that act on the tree's
shape — `aria-label="Arrange by schedule"`, glyph drawn (`plan-toolbar-controls` D1: the
accessible name is the thing that does not change). `data-hint="Put every sibling in the
order its bar starts"`. Two states swap the hint for a `data-fact` and disable the control:
a cycle (`The plan has a dependency cycle, so there is no schedule to arrange by`) and a
selected variant not yet ready (`Optimizing… arrange once the schedule settles`) — the
`filtering ? fact : hint` spread at `plan-toolbar.tsx:758`, and `MenuControlWords`' rule that
a mark never carries both. `disabled={busy}` plus `busyAffordance(busy)`. On `landed`, one
info toast: `Arranged by schedule.` Refusals go through `run`'s error toast. Inside
`toolbarControls`, so the phone sheet gets it for free and a plain button closes the sheet
on click (`plan-toolbar-sheet.tsx:44`).

**Width.** `layout.spec.ts:3651` pins the folded bar at 1600px against a measured 1552.73;
`project-settings.spec.ts:77` holds `[data-toolbar]` to 1265px "with a named margin for
exactly one more control". An icon is that control. Task 6.1 measures both **before** the
control lands and records the figures; if the 1600 pin fails, it is re-pinned to the
shipped bar's own budget with the number written down, as `plan-toolbar-controls` did —
never to "narrower than before" (`AGENTS.md`, the before-and-after pin). If 1265 fails, stop
and show Dany the bar.

### D9 — What a press does to the dates

Positions are canonical schedule input, and Fast's last tie-break follows tree order (D4.4),
so an arrangement changes the input hash and invalidates a ready optimized result: the
chart falls back to Fast and the cue reads `Optimizing…` until the new solve lands. **This
is not new** — every drag does it today — but a button that "arranges" and then visibly
moves bars will read as a bug unless said. The cue already says it. Recorded here so nobody
files it.

### D10 — The arrangement should be a fixed point under Fast, and that is a test

After arranging, the earlier-starting row reads first, so in every contention tie the row
that won keeps winning; a second press should move nothing. The argument holds for first
slices and is _not_ obviously true when a later slice of an earlier-starting row loses a
tie to a sibling that starts later — so task 4.7 is a seeded property test (arrange →
reschedule → arrange again → zero placements) over the golden-corpus plans. A counterexample
is recorded in `verify.md` and brought to Dany rather than papered over with a second pass.

### D11 — Terms, for `CONTEXT.md` (task 0.1)

New:

> **Arrange by schedule**:
> The project-wide act of rewriting each sibling group's positions so siblings read in the
> order their projections start in the selected engine's schedule, rows starting together
> keeping their order. Frozen rows move with the rest; nothing changes parent.
> _Avoid_: sort, reorder, sort by Gantt, sequence, sync with chart

> **Tree order**:
> The one order every reader draws a project in — depth-first, siblings by position, a tied
> position by id. Numbers used to be the only spelling of it; since frozen rows may move,
> they are not.
> _Avoid_: number order, sort order, display order

Modified:

> **Work item number**:
> The label a work item is known by outside the tool, formed `010`, `020`, `010.1`,
> `010.01`. Derived from position unless frozen, and reading as tree order until a frozen
> row has moved — after that a number is a name and the row's place says where it is.
> _Avoid_: id, index, wbs code

> **Frozen number**:
> A work item number that a freeze wrote down. It survives insertions, deletions,
> repadding and its own row moving; unfrozen siblings skip the label it holds.
> _Avoid_: fixed number, locked number

`sequence`, `order`, `rank` and `sort key` stay banned under **Position** and **Step
order**.

### D12 — ADR 0023, drafted (task 0.2)

> # A frozen number is a name, not a place
>
> A frozen work item moves like any other and keeps the label that left the tool; the
> table is ordered by tree position, never by the number string; unfrozen siblings take
> the natural labels for their group skipping any a frozen sibling holds; Fast breaks
> contention ties by tree order. Until 2026-09-10 the number string _was_ the order and a
> frozen row could not move, which is why `deriveNumbers` fitted unfrozen labels between
> frozen anchors — a mechanism that throws the moment anchors are out of order. Dany chose
> movable rows over ordinal numbers: a plan being arranged by its schedule is exactly the
> plan whose numbers have gone out to tickets, and a button that refused there would be
> useless where it was asked for. The cost is that a number in a group with a moved frozen
> row no longer tells the reader where the row is.
>
> Arranging is one server command, `arrangeBySchedule`, computed inside the write lock from
> the selected engine's schedule, journalled as one `set_positions` step whose inverse is the
> prior positions verbatim — not a client-built batch of `move`s, which is capped at 200,
> orders from a read that may be stale, and replays through `placeAfter` with `afterId`s that
> go stale when a sibling is added. Hard to reverse once `set_positions` entries exist in
> `command_journal` and once any plan holds a moved frozen row.

## Risks / Trade-offs

- **Numbers stop being ordinal in groups with a moved frozen row** (D4). Chosen.
- **The refusal deletion touches four sites and their tests**; each deletion is watched
  turning a refusal into a landing before it is believed (task 2.3).
- **Two width pins may move.** Measured first (6.1), re-pinned with the figure.
- **A press on an optimized plan re-solves** (D9). Existing behaviour under a new button.
- **Revision bumps on moved rows refuse peers' undos** on those rows. Correct: the row did
  move, which is what "has changed since then" is about.
- **Wire fixtures and refusal unions.** The command union grows and the `frozen` refusal may
  leave the wire union; `contracts:test` failed in CI once on a fixture missing new fields
  (`AGENTS.md`). Run `contracts`, `mcp-01`, `be-01`, `fe-01`, `domain` by name, then the
  whole gate.

## Edge cases

| Case                                                                    | Behaviour                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty project / one root / every group of one                           | lands, writes nothing, no journal entry; toast `Arranged by schedule.`                                                                                                                                                                                                                                      |
| Every group already in order                                            | same (D7)                                                                                                                                                                                                                                                                                                   |
| Frozen row starts first                                                 | moves to the top with its label; the unfrozen row below it reads the next free natural label (D4.3)                                                                                                                                                                                                         |
| Two frozen rows swap order                                              | both keep their labels; the numbers in that group no longer read as order                                                                                                                                                                                                                                   |
| Frozen `010`, `020` and one unfrozen row inserted at the top            | the unfrozen row reads `030`: natural labels for three, skipping the two held                                                                                                                                                                                                                               |
| Frozen label wider than the group's natural width (`0100` beside `010`) | reported verbatim; no `between` to throw any more                                                                                                                                                                                                                                                           |
| Ties on start                                                           | current order kept; no second key (D3)                                                                                                                                                                                                                                                                      |
| Tied _positions_ (ADR 0016) in a changed group                          | retired by the respace; in an unchanged group, left alone                                                                                                                                                                                                                                                   |
| Unestimated rows                                                        | carry the assumed duration and a start; arranged like any other                                                                                                                                                                                                                                             |
| Dependency cycle                                                        | refused `cycle`; control disabled with a fact (D7, D8)                                                                                                                                                                                                                                                      |
| Engine `fast`, or optimization off                                      | arranged by Fast                                                                                                                                                                                                                                                                                            |
| Engine `optimized`, variant ready                                       | arranged by that variant; the press then re-solves it (D9)                                                                                                                                                                                                                                                  |
| Engine `optimized`, variant pending or failed                           | refused `schedule_not_ready`; control disabled with the `Optimizing…` fact                                                                                                                                                                                                                                  |
| Selected engine's adapter absent                                        | refused as the read refuses (ADR 0022)                                                                                                                                                                                                                                                                      |
| Deep tree                                                               | every group at every depth; no depth limit exists                                                                                                                                                                                                                                                           |
| Filter or fold active                                                   | whole plan; the hint says "every sibling"                                                                                                                                                                                                                                                                   |
| Toolbar busy                                                            | control disabled with the busy affordance; the click is dropped visibly                                                                                                                                                                                                                                     |
| Peer edit racing the press                                              | serialised by the write lock; peer's `tree_replaced` arrives after                                                                                                                                                                                                                                          |
| Undo after a moved row was edited or deleted                            | refused with the existing sentences; entry discarded                                                                                                                                                                                                                                                        |
| Undo after a moved row was frozen                                       | applies — freezing no longer pins a row (D4)                                                                                                                                                                                                                                                                |
| Redo after a sibling was added to a changed group                       | applies stored positions; the newcomer keeps its own position between them                                                                                                                                                                                                                                  |
| Row missing from `planned.workItems` while `scheduleError` is null      | invariant break — throw, never default (R5)                                                                                                                                                                                                                                                                 |
| A plan with frozen rows that has never been arranged                    | numbers unchanged: the natural-skipping rule yields the anchors' old answers wherever anchors ascend and no label was fitted between them; where a fitted label (`0105`) exists today it becomes the next free natural — task 2.2 measures this over the live population before the deploy, as ADR 0016 did |
| Phone sheet                                                             | control inside `toolbarControls`; click closes the sheet after the write is issued                                                                                                                                                                                                                          |
