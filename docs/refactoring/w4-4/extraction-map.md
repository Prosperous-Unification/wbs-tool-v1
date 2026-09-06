# W4-4 mechanical map

Original source snapshot: `/private/tmp/w4-4-original.tsx`. The reproducible baseline is commit `f89ebf56`'s `apps/fe-01/src/components/wbs/wbs-table.tsx`.

| Original concern / named declarations                                                                                                                                                               | Current owner         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Browser storage keys, validators, readers/writers and SavedView                                                                                                                                     | remembered-layout     |
| ColumnResizeHandle, GanttHeightHandle; width/height/day/label state, layout swaps, linked-scroll/measurement effects and resetLayout                                                                | use-plan-layout       |
| unfoldedSteps, storedHiddenColumns, hiddenColumnIds, offeredColumns, toggleColumn, toggleStep                                                                                                       | use-column-set        |
| WbsTableProps, SubscriptionHandlers, PlanReadScope/readScopeFor; authoritative read state; refresh, stale reread, subscription, run and stepStack; placementsOf, hoveredCellAfterRefresh, sameSteps | use-plan-read         |
| Query/facet/saved-view state; narrowable/search/criteria; facet-option builders                                                                                                                     | use-plan-filter       |
| FilterFacets, ColumnsControl, SavedViews and the toolbarControls JSX                                                                                                                                | plan-toolbar          |
| Whole-plan and on-screen export readers/actions, clipboard/download wording and bytes                                                                                                               | plan-export-actions   |
| Keyboard state, global question/undo/arming effects, cell handlers, readiness walk and goToRow                                                                                                      | use-plan-keyboard     |
| Drag state/effects, add queue, structure writers, name commit/removal, move refusal vocabulary                                                                                                      | use-plan-structure    |
| Draft/mention state, estimate readers/committers, draft keys and folded mention handlers                                                                                                            | use-estimate-drafts   |
| Effective labels/mismatch derivation, reference/assignment writers and assignee readers                                                                                                             | use-reference-sets    |
| Dependency parsing, choosing, committing and picker close on step change                                                                                                                            | use-plan-dependencies |
| Not-before/priority/parallelism writes and earliest-start editor focus                                                                                                                              | use-plan-fields       |
| One original column definition per file (18 families, folded/unfolded steps together); ordered filtered registry                                                                                    | plan-columns/\*       |
| Depends/Start td prop builders, Start sentence, popover policy and geometry constants                                                                                                               | plan-cell-props       |
| Chart row projection/start-floor memo, schedule text readers and not-before offset                                                                                                                  | plan-chart-input      |
| Refusal codes and display sentences                                                                                                                                                                 | plan-refusal          |
| Days/final number printing                                                                                                                                                                          | plan-number-format    |
| MismatchMark and its spoken lists                                                                                                                                                                   | plan-mismatch         |

The extra dependency, field, refusal, number and mismatch modules keep each concept together instead of placing unrelated helpers in a `plan-cell-format` module. That temporary file was removed before the final verification.

## Wiring differences for review

- `liveNow` gains an explicit `PlanLiveValues` annotation. `PlanLive` is the exported mutable ref type.
- The name cell formerly captured stable `focusIntent` and `gridElement` refs from WbsTable. They are now fields on live and the cell reads those same refs through it.
- The Start cell formerly closed over the later-declared `startSentence` function. `readStartSentence(row, live)` now owns its unchanged calculation, reading the original stable `startFloor` ref through live. This avoids evaluating a later declaration while building the factories.
- The columns memo calls `createPlanColumns(steps, unfoldedSteps, hiddenColumnIds, live)`. Its dependency list remains exactly `[steps, unfoldedSteps, hiddenColumnIds]`.
- Custom hooks return the original state setters/refs/callbacks. No wrapper callbacks are placed in the columns memo. State remains instantiated once per WbsTable mount.
- PlanToolbar is a module-level component receiving the original resolved values; both renderers still choose exactly one toolbar placement.
- PlanRow and the pointed store implementations remain unchanged.

## Temporary extraction tooling

`/private/tmp/w4-extract.cjs` reads TypeScript symbols from the source program. `/private/tmp/w4-move.cjs` records original line ranges and captures for the first move; `/private/tmp/w4-move.log` lists every hook input/output. `/private/tmp/w4-relocate.cjs` records helper ownership by symbol. `/private/tmp/w4-deepen.cjs` and `/private/tmp/w4-deepen.log` record the remaining state and callback moves. These are local transformation aids, not repository dependencies.

Hook dependency spelling changes: extracted callbacks/effects now explicitly name their passed-in React setters and stable refs, because the lint rule can no longer infer their stability across a function boundary. These are the same useState setters/useRef objects from the parent mount; no changing reader was added. The columns dependency list is untouched. The existing filter memo's two redundant map dependencies are preserved rather than changing its invalidation behavior in a mechanical move.
