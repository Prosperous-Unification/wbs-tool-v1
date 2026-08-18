## 1. Storage

- [x] 1.1 `SavedView`, `savedViewsKey`, `isFilterCriteriaShape`, `isSavedView`, `rememberedSavedViews`, `rememberSavedViews` in `wbs-table.tsx`, beside `rememberedWidthOverrides`. Tests: a hand-edited non-array drops the whole key, one unusable entry among valid ones is dropped on its own and the rest still apply.
- [x] 1.2 `savedViews` state, read straight into the initial state (the same reason `widthOverrides` is), and its own project-swap effect so a project change re-reads rather than carrying one project's views onto another's plan.

## 2. The control

- [x] 2.1 `SavedViews`, beside `FilterFacets`: name box + `Save`, disabled while nothing is filtered. Tests: disabled with nothing typed or ticked, enabled once something is, remembers what was saved under the per-project key.
- [x] 2.2 Applying a view writes `query` and `facets` together in one gesture. Test: a name and a facet saved together, cleared, then the view picked back up restores both — not one alone.
- [x] 2.3 Deleting a view removes it from state and from storage. Test: the entry and its storage row are both gone, the rest of the list is untouched.
- [x] 2.4 A view naming a team since deleted narrows to nothing rather than throwing, and the facet panel still offers a ticked box for it via `optionsFor`'s existing fallback. Test: applying such a view says "No rows match these filters" and shows the ticked, unresolved box — no crash, no fallback to the whole plan.
- [x] 2.5 `filterLabels` factored out once (was duplicated inline in `planOnScreen`'s `Scope` line) so the export's account of a filter and the saved-views panel's tooltip cannot describe one filter two different ways.

## 3. The regression this must not cause

- [x] 3.1 Typing into the Find box or ticking a facet writes nothing to `wbs.views.<projectId>` — only `Save` does. Test: type and tick, assert the key is still `null`.
- [x] 3.2 The ad-hoc filter is still empty on the next load (Q6, unchanged); a saved view survives the same reload. Test: both asserted in one render cycle.

## 4. The record

- [x] 4.1 `proposal.md`, this file, the delta spec, `verify.md`. No `design.md` and no citation table — PoC mode, `notes/delivery-modes.md`.
