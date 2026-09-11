<!-- Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase. -->

Every negative below is watched failing **before** the production line is believed, and its
observed output — never the expected one — goes into the adjacent `Proof:` comment and into
`verify.md`'s table (`AGENTS.md`, "Write the comment from the failure output").

## 0. Words first

- [ ] 0.1 `CONTEXT.md` gains **Arrange by schedule** under `### WBS`, after **Repadding**,
      in the D11 wording once Dany has confirmed the word — test: none; a glossary entry is
      prose. Check the `_Avoid_` list does not collide with **Position**'s or **Step order**'s.
- [ ] 0.2 `docs/adr/0023-arranging-by-schedule-is-one-server-command.md` in the D12 wording,
      `status: proposed` — test: none. Linked from the service method's JSDoc in 3.2.

## 1. The arrangement, pure

- [ ] 1.1 `libs/domain/src/arrange-siblings.ts`: `arrangeBySchedule(rows, startOf)` →
      `{ placements: { id, parentId, position }[], moved: string[] }` over `PlannedRow`s
      (`parentId`, `position`, `frozenNumber`) and a `startOf(id): number` that throws on a
      missing id. Groups siblings by parent, orders unfrozen rows by start with a **stable**
      sort over the read's order, keeps frozen rows at their place, respaces a changed group
      to `10, 20, 30…`, leaves an unchanged group out entirely — test:
      `arrange-siblings.test.ts` › `puts two roots in start order`, `arranges every depth`,
      `a parent sits where its first leaf starts`, `equal starts keep their order and write
nothing`, `an unchanged group has no placements`, `a changed group is respaced from
ten`; negative for the stable sort: the comparator given `(a, b) => startOf(a) -
startOf(b) || a.id.localeCompare(b.id)` — `equal starts keep their order` watched
      failing on the reversed ids. `Proof:` from the output.
- [ ] 1.2 Frozen rows keep their place — test: `a frozen middle row stays in the middle`
      (A day 6, B frozen day 9, C day 0 → C, B, A), `two frozen anchors keep their gap count`,
      `every row frozen writes nothing`; negative: frozen rows sorted with the rest — the
      middle-row case watched failing on B leaving place 1. Then `deriveNumbers` run over the
      output of the anchors case and asserted equal to its run over the input's frozen
      labels — negative: the anchors case with the count between anchors changed by hand
      throws `between`'s error, which is the fault the invariant guards.
- [ ] 1.3 `moved` is exactly the ids whose place changed — test: `moved names the rows
whose place changed, not the respaced ones`; negative: `moved` set to every placement
      id, watched failing on the unchanged row's id present.
- [ ] 1.4 `startOf` throwing on an unknown id propagates — test: `an unscheduled row is an
invariant break`; negative: a `?? Infinity` default put in, watched passing the row to
      the end instead of throwing (R5 "never convert to a default").

## 2. The contract

- [ ] 2.1 `libs/contracts/src/http/plan-command-shapes.ts`: `.or(type({ kind:
"'arrangeBySchedule'" }).describe('Put every sibling group in the order its bars
start; frozen rows keep their place.'))` beside `freezeProject`; `PlanCommand` in
      `apps/be-01/src/service/plan-command.ts` follows — test: the union's existing
      round-trip test accepts `{ kind: 'arrangeBySchedule' }` and refuses
      `{ kind: 'arrangeBySchedule', workItemId: 'x' }` (unknown key → `invalid_body`, which
      is what the shape guards — `AGENTS.md`, keys not values).
- [ ] 2.2 The generated OpenAPI document and every wire fixture under `libs/contracts` that
      enumerates command kinds — test: `bunx nx run contracts:test`, run **by name** first
      (`AGENTS.md`, the CI-only `contracts:test` failure), and `apps/mcp-01/README.md`'s
      tool count re-read: the batch tool is unchanged, so the count is unchanged.

## 3. be-01: the command, the step, the undo

- [ ] 3.1 Extract the read's `planned = optimized ?? fast` selection (`work-item.service.ts`
      ~1740-1776) into `plannedScheduleOf(project, rows, …)` used by the read and by 3.2 —
      test: the existing read tests stay green; `each project is scheduled by its own reach`
      still fails on the hoisted-reach fault (its recorded negative re-run, since the code
      moved).
- [ ] 3.2 `WorkItemService.arrangeBySchedule(projectId, actorId)`: `not_found` /
      `forbidden` / `cycle` refusals, 3.1's schedule, 1.1's arrangement, repository write
      (3.3), one `announceTree`, one `record` with `set_positions` forward and inverse
      (3.4), `touched = moved`; nothing written, journalled or announced when there are no
      placements. JSDoc links ADR 0023 — test: `work-item.service.test.ts` › `arranges two
roots by their starts`, `arranges by the displayed variant when it is ready` (a
      stubbed optimization read with `pri` ready and reversed), `arranges by Fast while the
variant is pending`, `refuses a cycle`, `writes nothing when already arranged`
      (repository spy: no `setPositions`, no `append`, no broadcast); negative for the
      no-op: the `placements.length === 0` return deleted — watched producing a journal entry
      with an empty forward and a `tree_replaced` for nothing.
- [ ] 3.3 `WorkItemRepository.setPositions(placements, moved, stamp)`: one transaction,
      position on every placement, `revision: bumpedWorkItem` only on `moved` — test:
      `work-item.repository.test.ts` › `bumps the revision of moved rows only`; negative:
      the bump applied to every placement, watched failing on the unmoved row's revision
      changing.
- [ ] 3.4 `compensating.ts`: `{ do: 'set_positions'; placements: Placement[] }` with
      `subjectOf → { workItemId: null, stepId: null }`, `touchedBy → placements' ids`, and
      `applySetPositions`: refuse when an id is gone (`the work item is no longer there.`),
      when one is no longer under the parent the step names (`the work item it sat under
has been deleted since then.` wording reused, or a new sentence for "moved elsewhere"
      — pick from the output), when a **moved** row has been frozen since (`that work item
has been frozen since, so it cannot move.`) — test: `compensating.test.ts` and
      `work-item.service.test.ts` › `undo puts every row back`, `undo is refused once a
moved row was frozen`, `undo is refused once a moved row was deleted`, `redo re-applies
the stored positions`; negatives: each guard deleted in turn, each watched applying
      over the changed world. Plan history: the entry reads as a plan-wide sentence
      (`arranged the plan by schedule`) — test in the history reader's spec.
- [ ] 3.5 `plan-commands.ts` dispatch arm and the controller test through `buildApp`:
      `POST /api/projects/:id/commands` with `[{ kind: 'arrangeBySchedule' }]` → 200, rows
      re-read in start order, `undoable: true`; a cycle → 409 `cycle`; a read-only member →
      403 — test: `work-item.controller.test.ts`; negative: the dispatch arm's `reasonOf`
      dropped, watched answering 200 on the cycle.
- [ ] 3.6 One broadcast, one journal entry, one event per press — test: the existing
      announcement-collector spec pattern, `a press is one tree_replaced`; negative: a
      second `announceTree` added, watched failing on `2`.
- [ ] 3.7 **Fixed point** (D10): a seeded property over the golden-corpus plans in
      `libs/domain` — arrange, reschedule with Fast, arrange again → `placements.length ===
0` — test: `arrange-siblings.property.test.ts` over 400 seeds; a counterexample is
      not fixed in this slice: it is recorded in `verify.md` with the seed and brought to
      Dany. Negative: the arrangement's key changed to `earliestFinish` — some seed watched
      failing, which proves the property can see a wrong key.

## 4. fe-01: the control

- [ ] 4.1 `wbs-api.ts`: `arrangeBySchedule(projectId)` → `command(projectId, { kind:
'arrangeBySchedule' })` — test: the api spec's command round-trip.
- [ ] 4.2 `plan-toolbar.tsx`: icon button after `Expand all`, `aria-label="Arrange by
schedule"`, glyph drawn, `data-hint` / `data-fact` swap on `scheduleError === 'cycle'`,
      `disabled={busy || scheduleError === 'cycle'}` with `busyAffordance(busy)`; on
      `landed` an info toast `Arranged by schedule.` or `…; N frozen rows kept their place.`
      counting `frozenNumber !== null` in the tree the toolbar holds — test:
      `plan-toolbar.test.tsx` › the roll-call `the controls are found by the names they
always had` gains the name; `arranges the plan through the one write path` (fake api
      records the command; toast asserted); `a cycle disables it with a fact`; `never both a
hint and a fact` (the hints sweep); negative: `data-hint` left on in the cycle case,
      watched failing on the both-attributes sweep.
- [ ] 4.3 The phone sheet: the control is inside `toolbarControls` and a click closes the
      sheet **after** the write is issued — test: `plan-cards.test.tsx` › the toolbar-sheet
      describe gains `Arrange by schedule closes the sheet and issues the command`;
      negative: the fault of R5 #15 — close on capture — watched with the command missing
      from the fake's log.
- [ ] 4.4 Undo button label / history words read `arrange by schedule` — test: the undo
      label spec.

## 5. In a browser

- [ ] 5.1 **Measure first.** `layout.spec.ts` `the folded toolbar fits its budget` and
      `project-settings.spec.ts` `the toolbar keeps its 1280 budget` run against the bar
      **with** the control; both figures recorded in `verify.md`. If 1600 fails, the pin
      moves to the shipped bar's own budget with the measured figure, JSDoc updated, and the
      named fault (a labelled control instead of an icon) watched exceeding it — never
      "narrower than before". If 1265 fails, stop and bring D8's alternative to Dany.
- [ ] 5.2 `e2e/arrange-by-schedule.spec.ts`: three roots, the third made to start first by
      a dependency on it from the first; press the control; the third row is first, reads
      `010`, and its Gantt bar's `x` is the least of the three, read from the bar of **its
      own row** (R5 #16, `bars.at(1)`) — negative: the command's `run` prop wired to
      `freezeProject`, watched failing on the row order. Then a frozen row: freeze, press,
      the frozen row's number and place unchanged — negative: the frozen guard in 1.2
      removed, watched moving it.
- [ ] 5.3 `e2e/hints.spec.ts`: the control waits two seconds and rings, like every toolbar
      control; the cycle case shows its fact at once with `expect(await
ring.count()).toBe(0)` at 200ms (`toHaveCount(0)` retries — `AGENTS.md`).
- [ ] 5.4 The optimized plan: with the local solver (`bun run dev:local-solver`) and PRI
      displayed and ready, press; assert the cue reads `Optimizing…` afterwards (D9 is a
      fact to look at, not to hide) and the order is PRI's. Skip with the reason written if
      the solver is unavailable on the gate machine — do not stub the solver for this one.

## 6. Docs

- [ ] 6.1 JSDoc on `arrangeBySchedule` (service and domain), `set_positions`,
      `setPositions`; the toolbar control's own comment beside `Freeze #`'s; `docs/adr/0016`
      gains one line: a changed group's respace retires its ties. `LLM_README.md` unchanged
      unless 5.1 moves a pin — then the landmine list gains the figure.

## 7. Gate

- [ ] 7.1 By name first: `bunx nx run-many -t test lint typecheck -p domain contracts be-01
fe-01 mcp-01`; then the whole gate (`bunx nx format:check --all`, `bunx nx run-many -t
test lint typecheck build`), `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0
validate --all --json`, and `bun run e2e` on shifted ports (1900), the **whole** suite
      — a change that touches the toolbar has no business believing a filtered run.
- [ ] 7.2 `verify.md` filled from the output: commands, both toolbar figures, every
      failure-proof row, the fixed-point result with its seed count.
