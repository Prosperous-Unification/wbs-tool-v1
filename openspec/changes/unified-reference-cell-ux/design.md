## Context

`origin/main@06bcd64f` already has `work_item_team`, `teamIds[]` reads and
`effectiveTeamsOf`, while the table/card Teams controls narrow through `.at(0)`
and write `serviceTeamId`. The scheduler deliberately throws on an effective set
larger than one because Dany cancelled multi-team on 2026-08-15. TASK-181's
2026-08-27 approved outcome reverses that call. The complete closed PR #67 is a
behavioral oracle for the multi-pool engine, not a merge candidate without a
current-main port and fresh evidence.

PR #156 is the phone baseline: Teams, Tags and Services already use bottom
sheets and share `CreatablePicker`, but desktop cells have three different outer
shapes and Teams remains scalar. Depends on has the mature chip/search behavior
and full hover card; the card is intentionally pointer-transparent.

## Goals / Non-Goals

**Goals:** one visible interaction grammar; full own-team set writes without
copying inheritance; multi-team scheduling with prior single-team identity;
pointer-reachable dependency overflow; exact DOM/Chromium proof; phone and theme
parity.

**Non-Goals:** a universal data source, table redesign, new migration, explicit
no-inheritance state, dependency creation, or making passive hover-card area
interactive.

## Decisions

### D1 — restore multi-team meaning before exposing the writer

The safe order inside one PR is reader/engine, payload readers, set-valued write,
then UI. Port PR #67's joint-window behavior against current main and retain its
single-pool/corpus differentials. Only after be-01 can schedule the shape may
`teamIds` become writable. This is the earlier R2 reader-before-writer rule.

Every effective team with a stated capacity is a pool; every named team spends
its own days. Width is the minimum stated capacity. Unsized teams label but do
not constrain. The binding `capacityTeamId` comes from the search, not array
order. [ADR 0006](../../../docs/adr/0006-multi-team-work-spends-every-named-team-pool.md)
records the restored meaning.

### D2 — `teamIds` is a full replacement; inheritance is never written

Add `teamIds?: readonly string[]` alongside the one-release legacy
`serviceTeamId?: string | null`. A request naming both is a 400 rather than an
order-dependent write, with the stable controller error
`cannot_send_both_teamIds_and_serviceTeamId`. `MOST_TEAMS_ON_ONE_ITEM = 10`
feeds the existing bounded `asOptionalLabelIds` validation.
`WorkItemRepository.patch` validates and deduplicates the entire set inside its
transaction: sort distinct ids by team id, read them there, and return
`unknown_team` before scalar, join or revision changes if counts differ.
`revertTo(before, patch)` writes `out.teamIds = before.teamIds` whenever
`patch.teamIds` is present, and `fieldsOf(patch)` includes `teamIds`, so the
entire before-set—not `.at(0)`—is journalled as the compensating patch.

The repository MUST destructure `teamIds: wantedTeams` before spreading scalar
`fields` into `tx.update(workItem).set(...)`; `teamIds` is not a `work_item`
column. When `wantedTeams` is defined, the same transaction replaces
`work_item_team` rows and writes the first id of the sorted distinct set (or
`null`) as the stable legacy scalar projection. `[]` means unstated and reveals inheritance. The
UI always derives the next own set from `row.teamIds`, never from
`effectiveTeamsOf`; otherwise removing one own team could copy every inherited
team onto the row.

The legacy scalar column remains a compatibility projection of the canonical
first id until its already-planned retirement; there is no schema change. New UI
is served only after the new backend is the active blue/green color. The gate
replays legacy scalar requests and refuses mixed scalar/set requests.

Structural commands carry the same set. `RestoreSubtree` and `SubtreeCopy`
store optional per-row `teamIds`; new delete/duplicate journals always include
it, duplicate remaps work-item ids but preserves team ids, and
`insertSubtree` inserts every distinct membership in its transaction. An older
journal without `teamIds` remains readable by deriving the singleton from
legacy `serviceTeamId`.

### D3 — share a reference-set editor, not one universal reference model

Create `reference-set-field.tsx` with two presentation units:

- `ReferenceSetStrip`: leading `+`, compact member chips, inherited context and
  the picker anchor; it knows ids/names and interaction, not APIs.
- `ReferenceSetSheet`: the phone surface using the same strip vocabulary,
  selected-member list and `CreatablePicker` adapter.

`ReferenceSetAdapter` supplies `kind`, entries, own ids, inherited label,
`replace(ids): Promise<CommitOutcome>` and
`create(name, current): Promise<CommitOutcome>`, importing `CommitOutcome` from
`live-editing.ts`. Teams, Tags and Services each build one adapter over their
existing directory and writer. Depends on reuses the
strip's visual/add/chip tokens but retains `dep-picker.ts`, refusal reasons,
bulk-number input and add/remove dependency endpoints.

`ReferenceSetStrip` owns the single leading `+`. Its embedded
`CreatablePicker` omits `addButtonLabel`, so the picker does not render a second
add button.

Rejected alternatives: cloning Depends-on four times would preserve data
boundaries but preserve drift; a universal registry that makes a dependency
look directory-backed would erase cycle refusals, bulk numbers and the fact that
dependencies cannot be created. The adapter boundary shares mechanics only.

### D4 — one state transition table governs desktop and phone

For directory sets: add/create appends an absent id to the own set; chip removal
filters one id; duplicates are not offered; a landed desktop selection may keep
the picker open for repeated entry. Every table/card writer returns
`Promise<CommitOutcome>` by returning `run(...)`, not discarding it. Phone
choose/create awaits the result, closes only on `landed`, retains sheet and
typed value on `refused`/`unsent`, and disables the acted-on control while
pending. Removal always keeps the sheet open, retains the chip on refusal, and
disables only that chip while pending. Escape closes without writing; Tab leaves the
desktop cell through existing grid routing; arrows and Enter stay inside
`CreatablePicker`. The leading `+` remains `tabIndex=-1` because the adjacent
combobox is the keyboard's identical path.

For dependencies: the same leading `+` focuses the existing combobox; stored
chips remove one edge; no create line exists. The phone sheet continues its
single-row add semantics and fixed search position from PR #147.

### D5 — dependency card rows alone regain pointer events

`HoverCard` keeps `pointerEvents:'none'` on its surface. `DependsCard` renders
each dependency line with `pointerEvents:'auto'`, no `tabIndex`, and entry
enter/leave callbacks. DOM ancestry alone is insufficient: the card's passive
padding hit-tests the table beneath it and can fire owner `mouseleave` before a
row is reached.

While a dependency card is open, a passive document `pointermove` bridge owns
dismissal. It reads the owner and live row rectangles after placement. A point
inside the owner writes `{rowId,pillId:null}`; a row target writes its pill id;
a point in the straight corridor between the nearest owner edge and the union
of row target rectangles keeps the card mounted without changing hit-testing;
anything else clears. Owner `mouseleave` therefore requests bridge evaluation
instead of unmounting synchronously. Row enter/leave and `relatedTarget` guards
may update eagerly, but a late leave cannot clear a newer target. The bridge is
removed on clear, unmount, scroll/resize reposition, and pointer cancellation.
It is state-only: it adds no hit box, capture, delay timer, or click handler, so
passive padding continues to target the page beneath it.

This deliberately does not use `HoverCardProps.scrolls`, whose whole surface
takes the pointer. The dependency list is bounded by placement/overflow and its
rows are the only interactive hit regions. Empty padding continues to target the
page beneath it.

### D6 — geometry, hit-testing and paint are separate proofs

DOM tests assert outer `pointer-events:none`, row `pointer-events:auto`, no
redundant tab stops, bridge cleanup, state transitions, full accessible
descriptions and exact set patches. A pure rectangle-helper test covers owner,
corridor, target and outside decisions without claiming browser hit-testing.
Chromium proves pointer travel across passive padding, `elementFromPoint`
click-through, third-row reachability, actual clipping, phone sheet geometry,
reload, and tint direction in light/dark. A watched-red fault is required for
each new guard; a jsdom style assertion never substitutes for browser
hit-testing.

## Risks / Trade-offs

- Porting the stale PR #67 engine may conflict with two weeks of schedule work;
  its behavior and fault corpus are reused, not its old head assumed current.
- Ordinary set PATCH is explicitly last-writer-wins, matching today's API;
  revisions guard undo/redo only. A two-client case proves the later whole
  replacement wins, while stale undo remains refused.
- Interactive child rows inside a passive parent are subtle across pointer
  transitions; the Chromium owner→third-row→owner→outside sequence is the gate.
- TASK-182 remains dev mode. Its measured whole-task Flash trial explicitly
  requires full h2puni/CI, exact-head Sol/Gemini and main-session review before
  merge; those gates do not change its delivery mode.
