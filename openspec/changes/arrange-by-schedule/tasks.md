<!-- Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase. -->

Every negative below is watched failing **before** the production line is believed, and its
observed output — never the expected one — goes into the adjacent `Proof:` comment and into
`verify.md`'s table (`AGENTS.md`, "Write the comment from the failure output"). Group 2 is
the invariant change and lands **before** the command that needs it; each group is its own
PR onto `main`.

## 0. Words first

- [x] 0.1 `CONTEXT.md`: **Arrange by schedule** and **Tree order** added under `### WBS`
      after **Repadding**; **Work item number** and **Frozen number** rewritten, all in the
      D11 wording — test: none; a glossary entry is prose. The `_Avoid_` lists do not collide
      with **Position**'s or **Step order**'s.
- [x] 0.2 `docs/adr/0023-a-frozen-number-is-a-name-not-a-place.md` in the D12 wording,
      `status: accepted` (Dany confirmed 2026-09-10) — test: none. Linked from
      `deriveNumbers`' and the service method's JSDoc.

## 1. The arrangement, pure

- [x] 1.1 `libs/domain/src/arrange-siblings.ts`: `arrangeBySchedule(rows, startOf)` →
      `{ placements: { id, parentId, position }[], moved: string[] }` over
      `WorkItemPlacement`s and a `startOf(id): number` that throws on a missing id. Groups
      siblings by parent, orders them by start with a **stable** sort over tree order,
      respaces a changed group to `10, 20, 30…`, leaves an unchanged group out entirely —
      test: `arrange-siblings.test.ts` › `puts two roots in start order`, `arranges every
depth`, `a parent sits where its first leaf starts`, `equal starts keep their order and
write nothing`, `a frozen row is arranged like any other`, `an unchanged group has no
placements`, `a changed group is respaced from ten`; negative for the stable sort: the
      comparator given `|| a.id.localeCompare(b.id)` — `equal starts keep their order` watched
      failing on the reversed ids. `Proof:` from the output.
- [x] 1.2 `moved` is exactly the ids whose place changed — test: `moved names the rows whose
place changed, not the respaced ones`; negative: `moved` set to every placement id,
      watched failing on the unchanged row's id present.
- [x] 1.3 `startOf` throwing on an unknown id propagates — test: `an unscheduled row is an
invariant break`; negative: a `?? Infinity` default put in, watched passing the row to
      the end instead of throwing (R5 "never convert to a default").

## 2. A frozen number is a name, not a place (D4) — its own PR

- [x] 2.1 `libs/domain/src/tree-order.ts`: `orderByTree(placements): Map<id, index>` —
      depth-first, siblings by position then id; throws on an unreachable row as
      `deriveNumbers` does — test: `tree-order.test.ts` › `walks depth-first by position`,
      `a tied position falls to id`, `an orphan throws`; negative: the id tie-break dropped,
      watched failing on the tied pair's order.
- [x] 2.2 `deriveNumbers`: unfrozen siblings claim the next natural label no frozen sibling
      holds; `below`, `between`, `stepLastDigit` and the ceiling walk deleted — test:
      `derive-numbers.test.ts` rewritten: `an unfrozen row skips the label a frozen sibling
holds`, `two frozen rows out of order keep their labels`, `a frozen label wider than the
group is reported verbatim`, `no two siblings share a label` (property, seeded);
      the existing ascending-anchor cases kept where their answers are unchanged, the fitted
      cases (`0105`) rewritten to the next free natural with the old answer quoted in the
      test as what changed. Negative: the skip removed, watched failing on the collision.
      **Before merging**, `bun apps/be-01/src/…/measure-number-drift-cli.ts` (new, throwaway
      allowed) run against dev's database lists every work item whose number changes under
      the new rule; the list goes into `verify.md` and is announced before the deploy, as ADR
      0016 did for the tie order.
- [x] 2.3 The `frozen` move refusal deleted at every site: `work-item.service.ts:2254`,
      `applyMove`'s `frozen since` guard, `drag-drop.ts:80`, `use-plan-keyboard.ts:452` and
      `:552`, `FROZEN_REFUSAL`; `'frozen'` removed from `WorkItemRefusal`, `refusal-status.ts`,
      `work-item.routes.ts:973`, `plan-refusal.ts:326`, `DropRefusal`, and the wire union in
      `refusal.ts` / `work-item-shapes.ts:521` if nothing else answers it — test: `a frozen
row moves and keeps its number` in `work-item.service.test.ts`, `drag-drop.test.ts`,
      `use-plan-keyboard`'s spec, and `undo replays a move on a row frozen since`; each old
      "refuses a frozen move" case is **inverted**, not deleted, so the suite still names
      the behaviour. Negative: with the be-01 guard left in, the service test watched
      refusing `frozen`.
- [x] 2.4 Every reader orders by tree order: `work-item.service.ts:1893`,
      `directory-usage.ts:149`, `fake-project-api.ts:302`, and a sweep for
      `.number <`, `localeCompare(…number`, `sort(…number` across `apps/` and `libs/`
      (`canonical-plan-input.ts:351`'s `sorted` checked for what it sorts by; saved-plan
      bytes must not change) — test: `the read orders by tree order, not by number` with a
      frozen `030` sitting first; negative: the number sort put back, watched failing on the
      frozen row drawn third.
- [x] 2.5 `goesFirst` (`schedule.ts:2475-2483`) compares `orderByTree` indices — test:
      `schedule-priority.test.ts` › `a contention tie follows tree order, not the number
string` (frozen `030` first, unfrozen `010` second, tied on every key); negative: the
      number comparison left in, watched failing on the `010` slice placed first.
- [x] 2.6 **Byte identity.** The corpus and every derive-numbers fixture with ascending
      anchors pass unchanged — **631 pass / 0 fail**, 2026-09-11. The negative this slice
      planned (tree order reversed) was watched **passing** over the whole domain suite and
      is vacuous; its replacement witnesses are 2.5's pair and the recategorised
      `canonicalScheduleInput` case, watched on `629 pass / 2 fail`. Why, in `verify.md`
      § "The corpus cannot see the tie-break".

## 3. The contract

- [x] 3.1 `libs/contracts/src/http/plan-command-shapes.ts`: `.or(type({ kind:
"'arrangeBySchedule'" }).describe('Put every sibling group in the order its bars
start.'))` beside `freezeProject`; `PlanCommand` in `plan-command.ts` follows;
      `schedule_not_ready` added to the refusal unions with a 409 — test: the union's
      round-trip accepts `{ kind: 'arrangeBySchedule' }` and refuses an unknown key as
      `invalid_body` (the shape guards keys, not values — `AGENTS.md`).
- [x] 3.2 The generated OpenAPI document and every wire fixture under `libs/contracts` that
      enumerates command kinds or refusal reasons — test: `bunx nx run contracts:test` by
      name first (`AGENTS.md`, the CI-only `contracts:test` failure); `apps/mcp-01/README.md`
      tool count unchanged, the batch tool's description re-emitted.

## 4. be-01: the command, the step, the undo

- [x] 4.1 Extract the read's engine selection (`work-item.service.ts` ~1755-1776) into
      `selectedScheduleOf(project, rows, optimizationRead)` answering `{ schedule } |
{ refused: 'schedule_not_ready' }`; the read keeps drawing Fast under a pending variant
      exactly as today, so it maps the refusal back to Fast **with the mark it already
      carries** — test: the existing read tests stay green; `each project is scheduled by its
own reach` re-run against its recorded negative, since the code moved.
- [x] 4.2 `WorkItemService.arrangeBySchedule(projectId, actorId)`: `not_found` /
      `forbidden` / `cycle` / `schedule_not_ready`, 4.1's schedule, 1.1's arrangement over
      `orderByTree`, repository write (4.3), one `announceTree`, one `record` with
      `set_positions` forward and inverse (4.4), `touched = moved`; nothing written,
      journalled or announced when there are no placements. JSDoc links ADR 0023 — test:
      `work-item.service.test.ts` › `arranges two roots by their starts`, `arranges a frozen
row with the rest`, `arranges by the displayed variant when it is ready`, `refuses
while the variant is pending`, `refuses a cycle`, `writes nothing when already
arranged` (repository spy: no `setPositions`, no `append`, no broadcast); negatives:
      the `placements.length === 0` return deleted — watched producing a journal entry with an
      empty forward and a `tree_replaced` for nothing; the pending refusal replaced by Fast —
      watched arranging by Fast's order.
- [x] 4.3 `WorkItemRepository.setPositions(placements, moved, stamp)`: one transaction,
      position on every placement, `revision: bumpedWorkItem` only on `moved` — test:
      `work-item.repository.test.ts` › `bumps the revision of moved rows only`; negative: the
      bump applied to every placement, watched failing on the unmoved row's revision.
- [x] 4.4 `compensating.ts`: `{ do: 'set_positions'; placements }` with `subjectOf → {
workItemId: null, stepId: null }`, `touchedBy → placements' ids`, and
      `applySetPositions` refusing a missing id (`the work item is no longer there.`) and a
      row no longer under the parent the step names (sentence taken from the output) — test:
      `undo puts every row back`, `undo is refused once a moved row was deleted`, `undo
applies on a row frozen since` (D4), `redo re-applies the stored positions`; negatives:
      each guard deleted in turn, each watched applying over the changed world. Plan history:
      the entry reads `arranged the plan by schedule`.
- [x] 4.5 `plan-commands.ts` dispatch arm and the controller test through `buildApp`:
      `[{ kind: 'arrangeBySchedule' }]` → 200, rows re-read in start order, `undoable: true`;
      a cycle → 409 `cycle`; pending variant → 409 `schedule_not_ready`; read-only member →
      403 — test: `work-item.controller.test.ts`; negative: the arm's `reasonOf` dropped,
      watched answering 200 on the cycle.
- [x] 4.6 One broadcast, one journal entry, one event per press — test: `a press is one
tree_replaced`; negative: a second `announceTree` added, watched failing on `2`.
- [x] 4.7 **Fixed point** (D10): seeded property over the golden-corpus plans — arrange,
      reschedule with Fast, arrange again → `placements.length === 0` — test:
      `arrange-siblings.property.test.ts`, 400 seeds; a counterexample is recorded in
      `verify.md` with its seed and brought to Dany, not fixed here. Negative: the key changed
      to `earliestFinish`, some seed watched failing.

## 5. fe-01: the control

- [x] 5.1 `wbs-api.ts`: `arrangeBySchedule(projectId)` → `command(projectId, { kind:
'arrangeBySchedule' })` — test: the api spec's command round-trip.
- [x] 5.2 `plan-toolbar.tsx`: icon button after `Expand all`, `aria-label="Arrange by
schedule"`, glyph drawn, `data-hint` / `data-fact` swap on `scheduleError === 'cycle'`
      and on `optimization.engine === 'optimized' && optimization.displayed === 'fast'`,
      `disabled` in both, `disabled={busy}` with `busyAffordance(busy)` otherwise; on
      `landed` an info toast `Arranged by schedule.` — test: `plan-toolbar.test.tsx` › the
      roll-call `the controls are found by the names they always had` gains the name;
      `arranges the plan through the one write path`; `a cycle disables it with a fact`; `an
unsettled variant disables it with a fact`; the hints sweep `never both`; negative:
      `data-hint` left on in the cycle case, watched failing on the both-attributes sweep.
- [x] 5.3 The phone sheet: the control is inside `toolbarControls` and a click closes the
      sheet **after** the write is issued — test: `plan-cards.test.tsx` › toolbar-sheet
      describe gains `Arrange by schedule closes the sheet and issues the command`; negative:
      R5 #15's fault, close on capture, watched with the command missing from the fake's log.
- [x] 5.4 Undo label and history words read `arrange by schedule` — test: the undo label spec.

## 6. In a browser

- [x] 6.1 **Measure first.** `layout.spec.ts` `the folded toolbar fits its budget` and
      `project-settings.spec.ts` `the toolbar keeps its 1280 budget` run **with** the control;
      both figures recorded in `verify.md`. If 1600 fails, the pin moves to the shipped bar's
      own budget with the measured figure, JSDoc updated, and the named fault (a labelled
      control instead of an icon) watched exceeding it — never "narrower than before". If 1265
      fails, stop and show Dany the bar.
- [x] 6.2 `e2e/arrange-by-schedule.spec.ts`: three roots, the third made to start first by a
      dependency on it from the first; press; the third row is first, reads `010`, and its
      bar's `x` is the least of the three, read from the bar of **its own row** (R5 #16) —
      negative: the `run` prop wired to `freezeProject`, watched failing on the row order.
      Then freeze `020`, make it start first, press: it is drawn first and still reads `020`,
      the row below it reads `010` — negative: 2.4's number sort put back, watched drawing it
      second.
- [ ] 6.3 `e2e/keyboard.spec.ts`: Alt+Up on a frozen row moves it — negative: the keyboard
      refusal left in, watched failing on the toast `That row’s number is frozen…`.
- [ ] 6.4 `e2e/hints.spec.ts`: the control waits two seconds and rings like every toolbar
      control; the cycle case shows its fact at once with `expect(await
ring.count()).toBe(0)` at 200ms (`toHaveCount(0)` retries — `AGENTS.md`).
- [ ] 6.5 The optimized plan: with the local solver (`bun run dev:local-solver`) and PRI
      displayed and ready, press; assert the order is PRI's and the cue then reads
      `Optimizing…` (D9 is a fact to look at, not to hide). Skip with the reason written if
      the solver is unavailable on the gate machine — do not stub the solver for this one.

## 7. Docs

- [x] 7.1 JSDoc on `arrangeBySchedule` (service and domain), `orderByTree`,
      `deriveNumbers`' rewritten header, `set_positions`, `setPositions`; the toolbar
      control's own comment beside `Freeze #`'s; `LLM_README.md`'s product line ("a Cmd+Z
      that refuses out loud when a row has moved") unchanged, its landmine list gaining the
      1600 figure only if 6.1 moved it; `docs/adr/0016` gains one line: a changed group's
      respace retires its ties.

## 8. Gate

- [ ] 8.1 By name first: `bunx nx run-many -t test lint typecheck -p domain contracts be-01
fe-01 mcp-01`; then the whole gate (`bunx nx format:check --all`, `bunx nx run-many -t
test lint typecheck build`), `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0
validate --all --json`, and `bun run e2e` on shifted ports (1900), the **whole** suite
      — a change that edits the toolbar and the number rule has no business believing a
      filtered run.
- [x] 8.2 `verify.md` filled from the output: commands, the number-drift list from 2.2, both
      toolbar figures, every failure-proof row, the fixed-point result with its seed count.
