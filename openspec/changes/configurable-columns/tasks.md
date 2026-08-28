<!--
Ordered TDD slices. There is no separate plan.md in this schema — this file
absorbed it.

A slice is a coherent unit of behavior with a test that proves it, not a
two-minute keystroke. "Add a failing test for X, then make it pass" is ONE
slice.

Any slice that adds a safety check must also name the negative test proving the
check fails when the guarded thing is broken. See AGENTS.md, "Non-vacuous
checks". A check with no negative test is not done.

Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The default column set in `table-frame.ts`

- [x] 1.1 Replace `CONDITIONAL_COLUMNS` with `DEFAULT_HIDDEN_COLUMNS = ['team', 'service']`; `FIXED_COLUMNS` becomes the default column set; `foldedTableMinWidth(roleIds, state, hidden)` subtracts hidden fixed columns and hidden roles — test: `table-frame.test.ts` `the default column set's folded two-phase width is what the 1280 budget measured` (asserts the exact figure the pre-change function answered, computed once and written as the number); `hiding a role removes exactly its folded column from the folded minimum`; negative: `tag` put back into the hidden defaults, watched failing on the pinned figure.
- [x] 1.2 `hideableColumnIds(roleIds)` — the picker's list, in table order, never `drag`/`number`/`name`/`actions` — test: `table-frame.test.ts` `the hideable columns exclude the row's controls`; negative: `'name'` added to the list, watched failing.

## 2. Remembering hidden columns

- [x] 2.1 `rememberedHiddenColumns(projectId, knownIds)` / `rememberHiddenColumns` / `forgetHiddenColumns` beside the width-override trio, reading storage as a claim: non-string-list wipes the key, unknown ids dropped singly — test: `wbs-table.test.tsx` `hidden columns survive a reload`, `a hidden-columns store that is not a list is cleared and the default set shown`, `an unknown id among known ones is dropped alone`; negative: the shape check deleted, watched failing on `'4'` in storage rendering no Depends-on header.

## 3. The table honours the hidden list

- [x] 3.1 `hiddenColumnIds` state; the `columns` memo filters by it (fixed ids and `${roleId}-*`) and depends on it; `tagsExist`/`servicesExist` deleted — test: `wbs-table.test.tsx` `an empty directory still shows the Tags column and not Teams or Services` (the negative for the deleted conditional rule: it fails on main), `a full directory changes nothing`, `hiding a role removes all its columns and leaves Days and dates alone`, `Right from Name lands on Prio with Depends on hidden`.
- [x] 3.2 `Columns` toolbar control: popover with a checkbox per hideable column and per role; unchecking hides, checking shows, storage written — test: `wbs-table.test.tsx` `the Columns control lists what can be hidden and nothing else`, `unchecking Depends on takes the column off and remembers it`.
- [x] 3.3 `resetLayout` forgets the hidden list; the reset is offered while any hidden column is in force — test: `wbs-table.test.tsx` `reset forgets the hidden columns and disappears`; negative: `forgetHiddenColumns` removed from `resetLayout`, watched failing on the key still present.

## 4. Saved views carry a column set

- [x] 4.1 `SavedView.hiddenColumnIds?`; `isSavedView` drops a present-but-wrong one; save captures, apply sets and writes storage, absent leaves columns alone — test: `wbs-table.test.tsx` `a view remembers its columns`, `an older view leaves the columns alone`, `a view whose column set is not a list is dropped alone`; negative: the `hiddenColumnIds` shape check removed, watched failing on the `3` entry being offered.

## 5. Phases dialog and the browser gate

- [x] 5.1 The Phases dialog quotes `foldedTableMinWidth` over the shown columns — test: `phases-dialog.test.tsx` `the quoted folded minimum drops a hidden column's width`; negative: `hidden` not passed through, watched failing on the figure 110px too wide.
- [x] 5.2 `e2e/layout.spec.ts`: `holds the folded budget at 1280` unchanged and green; new `hiding Tags narrows the frame by the Tags column's width` measuring `scrollWidth` before and after; heading/body no-overlap re-run after a toggle — run on shifted ports (`CI=1`), never the shared dev server.
- [x] 5.3 Existing tests that read a Teams or Services cell seed `wbs.hiddenColumns.<projectId>` to `[]` through one helper; every fe-01 test green; `LLM_README.md` landmine about `columns` deps updated in the same commit.

## 6. The toolbar at a laptop width (D6)

- [x] 6.1 One `Export` menu for the five export actions; Undo/Redo as glyphs with their names on them; Find box `w-32` — test: `wbs-table.test.tsx` `offers all five ways of taking the plan out of the tool, in one Export menu`, `draws Undo and Redo as glyphs that still answer to their names`; negative: the `<details>` replaced by a `<div>`, watched failing on `no Export menu on the toolbar`.
- [x] 6.2 `e2e/header.spec.ts` `gives the table the height the chrome stopped taking` green again at 1280 (633 → ≥ 634); whole browser gate on shifted ports.
