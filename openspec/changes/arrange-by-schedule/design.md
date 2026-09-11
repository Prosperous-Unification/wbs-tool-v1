# design — `arrange-by-schedule`

## Context

Row order and tree containment are one thing here. `work_item.position` is an integer
scoped to `(project_id, parent_id)`, spaced by ten (`libs/domain/src/place-sibling.ts`);
`deriveNumbers` turns positions into `010`, `020`, `010.1`; be-01 sorts the read once by
that number (`work-item.service.ts:1893`) and `wbs-table.tsx:514-524` says in so many words
that ordering is not the client's job. There is no sortable column and no client sort, by
design. The only way rows move is `moveWorkItem` — `(parentId, afterId)`, one row, refused
`frozen` when the row carries a `frozenNumber`, and journalled with a `move` inverse.

The schedule the chart draws is `planned = optimized ?? fast` in the plan read
(`work-item.service.ts:1755-1776`): Fast always, displaced by the ready optimized variant
the project displays. Every row gets a **projection** — `earliestStart`, `earliestFinish`,
`float` — a parent's being the span of its leaves. Fast breaks contention ties by the
work item number (`SlicePriority.number`, `schedule.ts:1130`), and positions plus frozen
numbers are part of the canonical schedule input (`canonical-schedule-input.ts:158-159`), so
the order of rows is already an input to the dates, not only a picture of them.

A command batch is one unit of work, one journal entry, one broadcast (ADR 0007, 0015);
fe-01 only ever sends batches of one (`wbs-api.ts:2267`). Journal entries are
`CompensatingCommand` steps (`compensating.ts:55-110`) — `move`, `set_frozen`, `batch`… —
each with `subjectOf`, `touchedBy` and an `apply` arm that re-checks the world.

## Goals / Non-Goals

**Goals:** one press puts every sibling group in the order its bars start; it is one act to
undo; frozen rows are honoured; the order is the chart's, not a client's recomputation.

**Non-Goals:** a view-only sort, sortable headers, re-parenting, moving frozen rows,
re-arranging automatically after edits, a keyboard chord, a per-project setting.

## Decisions

### D1 — A write, not a view

The table's order is the plan's order: what collaborators see, what the export carries,
what the numbers derive from. A client-side sort would be a second ordering implementation
(the one `wbs-table.tsx` refuses), would leave the numbers contradicting the rows, and could
not be undone. Freezing only means anything if the sort moves rows. So the button writes
positions. Rejected: a "view by schedule" toggle — cheaper, but it answers the wrong
question and reopens the two-orderings problem.

### D2 — One command, computed on the server, from the drawn schedule

`{ kind: 'arrangeBySchedule' }` in the plan command union, handled by
`WorkItemService.arrangeBySchedule(projectId, actorId)`. The service reads rows, builds the
canonical input exactly as the read does, and takes **the same** `planned` selection — the
read's `optimized ?? fast` extracted into one method both call, so the command can never
arrange by a schedule the chart is not drawing. Computed inside the write lock: no stale
client read, no `afterId` pointing at a row that moved. Rejected: fe-01 synthesising a batch
of `moveWorkItem`s — capped at 200, all-or-nothing on the first frozen row, ordered from a
read that may be stale, and every `afterId` a second implementation of the arrangement.

ADR 0022 applies unchanged: if the selected engine's adapter is absent the read refuses,
and so does this command, with the same typed refusal. Pending or failed optimized variants
leave Fast drawn, so the arrangement is by Fast — the chart's state at that moment.

### D3 — Every sibling group, by projection start; ties keep their order

For each parent (roots included), siblings are ordered by `earliestStart` ascending, in the
engine's fractional workdays, compared exactly — never rounded. Equal starts keep the order
they read in today (a stable sort over the read's own `number` order). No second key: two
rows starting the same day are already "next" together, and finish or slack as a tie-break
would move rows for a reason the button's name does not state. A parent's start is the
least of its leaves' (`projectOntoWorkItems`), so a branch sits where its first bar is.

### D4 — A frozen row keeps its place; the others fill in around it

Within a group of _n_, places are `0…n−1`. A frozen row keeps its current place. The
unfrozen rows, in D3 order, take the remaining places in order. `deriveNumbers` fits
unfrozen neighbours between frozen labels with `below`/`between` and throws on an
impossible gap; because frozen rows do not change place and the count of unfrozen rows
between any two frozen anchors is unchanged, a plan that derives today derives afterwards.
Rejected: refusing the whole arrangement on any frozen row (one frozen ticket would disable
the button for the plan); moving frozen rows with their labels (breaks the glossary's
promise that a frozen number blocks the row from moving, and can make `between` throw).

### D5 — The journal step is exact positions

A new `CompensatingCommand` arm, `{ do: 'set_positions', placements: { id, parentId,
position }[] }`. Forward holds the new positions of every row in a changed group; inverse
holds their prior positions. `touched` is the rows whose **place** changed, so a peer's undo
on one of them is refused as `stale_undo` in the existing sentence and this entry's own undo
is refused once such a row has changed. `subjectOf` answers `{ workItemId: null }` like
`set_frozen`: the event is plan-wide. `apply` re-checks: every id still present, still under
the parentId the step names, and none of the moved set frozen since — each refusal in the
`applyMove` wording. Rejected: an inverse of _n_ `move` steps — replays through `placeAfter`
one at a time, respaces mid-way, and its `afterId`s are stale the moment a sibling is added.

### D6 — Changed groups are respaced to `10, 20, 30…`; unchanged groups are not written

A group whose order is already D3's is not touched: no write, no revision bump, no
placement in the step. A group that changes is respaced whole, which also retires any tied
positions in it (ADR 0016). The repository gets `setPositions(placements, moved, stamp)` —
one transaction, positions on every placement, `revision: bumpedWorkItem` only on `moved`,
after `move`'s own split at `work-item.ts:755-764`.

### D7 — Refusals and the no-op

- `scheduleError === 'cycle'` → refused `cycle`: there is no schedule to arrange by.
- Absent engine capability → the read's own typed refusal (D2).
- `not_found` / `forbidden` as every project command.
- **Nothing to arrange** (every group already in order, or fewer than two unfrozen siblings
  anywhere) → lands `ok`, writes nothing, journals nothing, announces nothing — `freeze`'s
  precedent for a write that pinned nothing.

### D8 — The toolbar control

An icon button beside `Collapse all` / `Expand all` — the three controls that act on the
tree's shape — `aria-label="Arrange by schedule"`, glyph drawn (D2 of
`plan-toolbar-controls`: the accessible name is the thing that does not change).
`data-hint="Put every sibling in the order its bar starts"`; when `scheduleError` is
`cycle` the button is disabled and carries `data-fact="The plan has a dependency cycle, so
there is no schedule to arrange by"` instead — the `filtering ? fact : hint` spread at
`plan-toolbar.tsx:758`. `disabled={busy}` plus `busyAffordance(busy)`. On `landed`, one
info toast: `Arranged by schedule.`, or `Arranged by schedule; N frozen rows kept their
place.` when the tree the toolbar already holds has frozen rows. Refusals go through `run`'s
error toast. Inside `toolbarControls`, so the phone sheet gets it for free and a plain button
closes the sheet on click (`plan-toolbar-sheet.tsx:44`).

**Width.** `layout.spec.ts:3651` pins the folded bar at 1600px against a measured 1552.73;
`project-settings.spec.ts:77` holds `[data-toolbar]` to 1265px "with a named margin for
exactly one more control". An icon button is that control. Task 5.1 measures both **before**
the control lands and records the figures; if the 1600 pin fails, it is re-pinned to the
shipped bar's own budget with the number written down, as `plan-toolbar-controls` did —
never to "narrower than before" (`AGENTS.md`, the before-and-after pin).

**Alternative, kept for Dany to choose on sight:** a third item in the `Freeze #` menu.
Zero width, chords already inert while it is open, sheet exemption already in place, and
numbering and order are one subject — but "Arrange by schedule" under a trigger named
`Freeze #` is a wrong sign, and Dany asked for a button. Recorded because he judges these
rendered ([[project-dany-judges-rendered-output]]); the first screenshot decides.

### D9 — What a press does to the dates

Positions are canonical schedule input. Fast reads the number as its last contention
tie-break, and the optimizer's input hash covers positions, so an arrangement on an
optimized plan invalidates the ready result: the chart falls back to Fast and the cue reads
`Optimizing…` until the new solve lands. **This is not new** — every drag does it today —
but a button that "sorts" and visibly moves bars will read as a bug unless said. The toast
does not say it; the cue already does. Recorded here so nobody files it.

### D10 — The arrangement should be a fixed point under Fast, and that is a test

After arranging, the earlier-starting row has the lower number, so in every contention tie
the row that won keeps winning; a second press should move nothing. The argument holds for
first slices and is _not_ obviously true when a later slice of an earlier-starting row
loses a tie to a sibling that starts later — so task 3.7 is a seeded property test
(arrange → reschedule → arrange again → zero placements) over the golden-corpus plans. A
counterexample is recorded in `verify.md` and brought to Dany rather than papered over with
a second pass.

### D11 — Term, for `CONTEXT.md` (task 0.1)

> **Arrange by schedule**:
> The project-wide act of rewriting each sibling group's positions so siblings read in the
> order their projections start, rows starting together keeping their order and frozen rows
> keeping their place. Nothing changes parent.
> _Avoid_: sort, reorder, sort by Gantt, sequence, sync with chart

`sequence`, `order`, `rank` and `sort key` are already banned under **Position** and
**Step order**; this term stays clear of them.

### D12 — ADR 0023, drafted (task 0.2)

> # Arranging by schedule is one server command whose inverse is exact positions
>
> The table is arranged by the schedule the read draws, on the server, inside the write
> lock, as one command with one journal entry — not as a client-built batch of moves.
> A client batch is capped at 200, is refused whole by its first frozen row, orders from a
> read that may be stale, and every `afterId` in it is a second implementation of the
> arrangement. The inverse is the prior positions verbatim rather than _n_ `move` steps,
> because `move` replays through `placeAfter` and its `afterId`s go stale the moment a
> sibling is added. A frozen row keeps its place and the others are arranged around it: a
> frozen number is a promise that the row does not move, and refusing the whole plan for
> one frozen ticket would make the button useless exactly where plans are being tracked.
> Hard to reverse once `set_positions` entries exist in `command_journal`.

## Risks / Trade-offs

- **Two width pins may move.** Accepted; measured first (5.1), re-pinned with the figure.
- **A frozen row can sit "out of order".** The price of a freeze, and the toast says how
  many. Unfreeze is one menu away.
- **A press on an optimized plan re-solves** (D9). Existing behaviour under a new button.
- **Revision bumps on moved rows refuse peers' undos** on those rows. Correct: the row did
  move, which is what "has changed since then" is about.
- **Wire fixtures.** `contracts:test` failed in CI once on a fixture missing new fields
  (`AGENTS.md`); the command union grows, so the OpenAPI document and MCP tool list change.
  Run `contracts`, `mcp-01`, `be-01`, `fe-01`, `domain` by name, then the whole gate.

## Edge cases

| Case                                                               | Behaviour                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Empty project / one root / every group of one                      | lands, writes nothing, no journal entry, no toast beyond `Arranged by schedule.`  |
| Every group already in order                                       | same as above (D7)                                                                |
| All rows frozen                                                    | same; toast counts them                                                           |
| Frozen row in the middle of a group                                | keeps its place; unfrozen fill the other places in start order (D4)               |
| Two frozen anchors with unfrozen rows between                      | count between anchors unchanged, so `between` derives as before                   |
| Ties on start                                                      | current order kept; no second key (D3)                                            |
| Tied _positions_ (ADR 0016) in a changed group                     | retired by the respace; in an unchanged group, left alone                         |
| Unestimated rows                                                   | carry the assumed duration and a start; arranged like any other                   |
| Dependency cycle                                                   | refused `cycle`; button disabled with a fact (D7, D8)                             |
| Optimized displayed and ready                                      | arranged by that variant; the press then re-solves it (D9)                        |
| Optimized displayed, pending or failed                             | arranged by Fast, which is what is drawn                                          |
| Selected engine's adapter absent                                   | refused as the read refuses (ADR 0022)                                            |
| Deep tree                                                          | every group at every depth; no depth limit exists                                 |
| Filter or fold active                                              | whole plan; the hint says "every sibling"                                         |
| Toolbar busy                                                       | control disabled with the busy affordance; the click is dropped visibly           |
| Peer edit racing the press                                         | serialised by the write lock; peer's `tree_replaced` arrives after                |
| Undo after a moved row was edited / deleted / frozen               | refused with the existing sentences; entry discarded                              |
| Redo after a sibling was added to a changed group                  | applies stored positions; the newcomer keeps its own position between them        |
| Row missing from `planned.workItems` while `scheduleError` is null | invariant break — throw, never default (R5)                                       |
| Phone sheet                                                        | button inside `toolbarControls`; click closes the sheet after the write is issued |
