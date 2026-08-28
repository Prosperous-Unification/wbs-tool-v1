# Verification Report

> Produced by `openspec-verify-change` AFTER apply completes. Failed checks go
> back to the artifact that caused them; then re-run verify.

**Change**: `configurable-columns`
**Verified at**: `2026-08-28 20:40`
**Verifier**: Claude (Fable 5), on Dany's Mac; CI on PR #174 is the gate of record

---

## 1. Structural Validation

- [x] `openspec validate --all --json` — all items `"valid": true`

```
items: 77  invalid: 0
```

| Item | Type | Issues |
| ---- | ---- | ------ |
| —    | —    | —      |

---

## 2. Task Completion

- [x] Every `- [ ]` in tasks.md is now `- [x]` — 12 of 12

| Task | Reason incomplete | Blocks archive? |
| ---- | ----------------- | --------------- |
| —    | —                 | —               |

---

## 3. Delta Spec Sync

| Capability   | Sync status | Note                                                              |
| ------------ | ----------- | ----------------------------------------------------------------- |
| `wbs-domain` | ✗ pending   | archive applies it: 4 ADDED, 6 MODIFIED (3 reset/views, 3 export) |

---

## 4. Failure Proofs

> Every row was watched failing on the production call path with the named
> fault injected, then restored and watched green. Messages are verbatim.

| Check (file:line)                                                                | Fault injected                                              | Test that observed the failure                                                          | Result                                                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `table-frame.ts` `DEFAULT_HIDDEN_COLUMNS`                                        | `tag` added to the list                                     | `table-frame.test.ts` › hides Teams and Services by default…                            | `expected 1139 to be 1259`, `expected […] to include 'tag'`                           |
| same                                                                             | `team` struck from the list                                 | same                                                                                    | `expected 1187 to be 1067`                                                            |
| `table-frame.ts` `foldedTableMinWidth` hidden arg                                | hidden list ignored                                         | `table-frame.test.ts` › subtracts what the reader has hidden…                           | `expected 1067 to be 957`                                                             |
| `table-frame.ts` `foldedTableMinWidth` unknown-id throw                          | loop deleted                                                | `table-frame.test.ts` › refuses a hidden id that is neither a column nor a role…        | `expected function to throw an error, but it didn't`                                  |
| `table-frame.ts` `hideableColumnIds`                                             | `name` added / `float` dropped                              | `table-frame.test.ts` › offers every data column and every role to hide…                | `expected [ Array(14) ] to deeply equal [ Array(13) ]` (and the reverse)              |
| `wbs-table.tsx` `rememberedHiddenColumns` shape check                            | check deleted                                               | `wbs-table.test.tsx` › clears a store that is not a list of strings…                    | `TypeError: storedHiddenColumns.filter is not a function`                             |
| same, key removal                                                                | `removeItem` deleted                                        | same                                                                                    | `expected '4' to be null`                                                             |
| `wbs-table.tsx` `columns` filter, role arm                                       | `startsWith` arm removed                                    | `wbs-table.test.tsx` › hides a role whole and leaves Days and the dates alone           | `expected [ 'role-qa-final' ] to deeply equal []`                                     |
| `wbs-table.tsx` `toggleColumn` write                                             | `rememberHiddenColumns` left out                            | `wbs-table.test.tsx` › unchecking a column takes it off the table and remembers it…     | `expected null to be '["team","service","depends"]'`                                  |
| `wbs-table.tsx` `resetLayout`                                                    | `forgetHiddenColumns` removed                               | `wbs-table.test.tsx` › is forgotten by a layout reset…                                  | `expected '["team","service","depends"]' to be null`                                  |
| `wbs-table.tsx` reset predicate                                                  | `columnsDiffer` left out                                    | same                                                                                    | `Unable to find an accessible element with the role "button" and name "Reset layout"` |
| `wbs-table.tsx` `isSavedView` column-set shape                                   | `isAbsentOrStringArray(claimed['hiddenColumnIds'])` dropped | `wbs-table.test.tsx` › drops a view whose column set is not a list of strings…          | `Unable to find an element with the text: Views (1)`                                  |
| `wbs-table.tsx` `onApply`, absent column set                                     | absent treated as `[]`                                      | `wbs-table.test.tsx` › leaves the columns alone when picking a view saved before…       | `expected [ 'drag', 'number', 'name', …(14) ] to not include 'priority'`              |
| `phases-dialog.tsx` `hiddenColumnIds` → `foldedTableMinWidth`                    | prop not passed through                                     | `phases-dialog.test.tsx` › quotes the folded width of the columns actually on screen    | `expected last "foldedTableMinWidth" call to have been called with […]`               |
| `wbs-table.tsx` `hiddenColumnIds` memo sanitisation                              | stored list passed unfiltered                               | `wbs-table.test.tsx` › drops an unknown id on its own… (opens the Phases dialog)        | `UnknownColumnError: No declared width for column "role-nope"`                        |
| `wbs-table.tsx` Export `<details>`                                               | replaced by a `<div>`                                       | `wbs-table.test.tsx` › offers all five ways of taking the plan out…, in one Export menu | `Error: no Export menu on the toolbar`                                                |
| `wbs-table.tsx` `ColumnsControl` tick rows as wrapping labels (phone 44px floor) | the shape before the fix (`div > input + label[for]`)       | `e2e/mobile.spec.ts` › gives every control on the phone’s own surfaces at least 44px    | 14 × `{ name: "INPUT", height: 22 }` on the Plan actions sheet; 0 after               |
| the deleted conditional-column rule                                              | `main` itself                                               | `wbs-table.test.tsx` › shows the Tags column on an empty directory, and not Teams…      | fails on `main` (Tags absent, Teams present)                                          |
| toolbar at 1280 (D6)                                                             | the thirteenth control before the Export menu               | `e2e/header.spec.ts` › gives the table the height the chrome stopped taking             | `expected >= 634, received 633` (toolbar 104px, three rows); 68px/two after           |

- [x] Every check in this change has a row
- [x] Each negative test reaches the production call path, not a copy of it
- [x] Where code distinguishes storage state, both a non-list and a bad entry were tested (absence = default, by design)
- [x] No row relies on an exit code

---

## 5. Gate Output

- [x] `bunx nx format:check --all` — exit 0, clean
- [x] `bunx nx run-many -t test lint typecheck build --parallel=2` — see below

```
 NX   Running targets test, lint, typecheck, build for 23 projects failed
Failed tasks:
- tool-dagger:test        ✗ with-heavy-lock ×2 — `Executable not found in $PATH: "flock"` (macOS has no flock)
- tool-devsync:test       ✗ dev MCP preflight ×2 — GNU `stat -c` / Linux host shape
- tool-bootstrap:test     ✗ configure.sh Caddyfile merge ×7 — needs a Linux host with caddy/systemd
- fe-01:test              ✗ plan-mermaid.test.ts ×2 — timezone; `TZ=UTC bunx vitest run plan-mermaid.test.ts` → 49 passed
fe-01: Test Files 1 failed | 54 passed (55); Tests 2 failed | 1774 passed (1776)
every other project's test/lint/typecheck/build: green; lint carries 1 pre-existing warning (wbs-table.tsx:4041 exhaustive-deps)
```

No file under `tools/` changed on this branch (`git diff --stat main..HEAD -- tools/` is empty);
the three tool suites need a Linux host and CI (Linux, UTC) is where they, and the two
mermaid cases, are proven. **CI on PR #174 is the gate of record for this section.**

**Browser gate** (`CI=1 bunx playwright test -c apps/fe-01/playwright.scratch.config.ts`,
shifted ports 3111/3211/4211 beside the live dev server, local Chromium, `locale: en-US`):

```
198 passed, 3 failed (5.4m)
✘ deps-cell.spec.ts:430  picks the add button up off the row it is hovered on   — animation poll never settles (Expected 0, Received 12)
✘ keyboard.spec.ts:466   Escape leaves the stored day alone                     — typed 07/01 lands as 2026-01-07
✘ keyboard.spec.ts:610   saves only the year that was typed                     — typed 05/20 lands as 2026-02-05
```

All three fail **identically on `main`** with the same config on this machine (worktree run,
2026-08-28: 3 failed / 1 passed of the four then-open tests; `header.spec.ts:264` passed on `main`,
which is what made the toolbar regression mine and led to D6). Passing and load-bearing here:
`holds the folded budget at 1280` (unchanged), `takes a hidden column’s width off the table…` (new),
`gives the table the height the chrome stopped taking` (two rows again), both phone 44px sweeps,
the two Teams-cell specs.

---

## 6. Implementation Signal

- [x] No unstaged files in the worktree (the untracked `apps/fe-01/playwright.scratch.config.ts` is local tooling, never committed)
- [x] Relevant commits pushed

**Commit range**: `d4b60ad..HEAD` on `change/configurable-columns` (`ee5eed0`, `6289acc`, `77bcf28`, this)

---

## Decision

- [ ] ✅ PASS — proceed to finishing-a-development-branch and archive
- [x] ⚠️ PASS WITH WARNINGS — four test suites red on this Mac for host reasons (flock, Linux host shape, timezone) and three browser tests that fail identically on `main`; none touched by this change. CI on #174 decides.
- [ ] ❌ FAIL

**Next step**:

Undraft #174; when CI's `gate` and `pixels` are green, squash-merge and archive the change.
