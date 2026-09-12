# Verify

Implementation landed 2026-09-13 on `change/status-at-a-glance`, stacked on
`change/work-item-status-and-facts` (PR #423). Commands and measurements below are this
machine's (macOS, UTC+3, Chromium via Playwright, run between 01:00 and 03:00 local so the
browser's UTC day and the host's day differed); CI is the gate — `bin/h2puni-gate.sh` exits
127 on macOS.

## Assumptions, stated

- **Date only.** The prompt takes a calendar day and no time of day: ADR 0024 stands, and
  `fact_end` is a date-only column. Dany's ask said "date and time"; the time is not stored.
- **Status stays hidden by default.** The strip and the tint are the default face; the 28px
  glyph column would overrun the 1280 folded budget's 17px of slack if shown by default.
- **A change to a held fact end is two journal entries** (`setStatus`, then `patch`), never a
  fill-and-overwrite variant of `setStatus`.
- **Only the Status cell's act clears the fact end.** A per-step statement that drops a row
  from done to in progress leaves the facts alone; only a done row draws its fact end.
- **The word is the cell's `title`, not part of its accessible name.** `jsx-a11y` refuses
  `aria-description` on a combobox, and `Status of 010` is the handle every walk, hint and
  browser proof finds the cell by.
- **A deleted row under an open prompt** is the `refsEditing` pattern (`?? null` → no
  surface) and is not separately tested.

## Commands

| Command                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bunx nx run core:test` (`progress.test.ts` + suite)                                                     | pass — 421                                                                                                                                                                                                                                                                                                                                                                                       |
| `bunx nx run contracts:test`                                                                             | pass — 378                                                                                                                                                                                                                                                                                                                                                                                       |
| `bunx nx run be-01:test`                                                                                 | 1045 pass, 0 fail, exit non-zero: two `Unhandled error between tests` after `saved-plan-list.db.test.ts` — `DrizzleQueryError` on `solver_slot` / `solver_queue` reads inside a transaction beside a `database is locked` health probe. Local, pre-existing on this host (see memory: devsync poller on macOS); untouched by this change, which writes no solver table. CI `gate` is the oracle. |
| `bunx nx run-many -t lint typecheck -p core fe-01`                                                       | pass                                                                                                                                                                                                                                                                                                                                                                                             |
| `bunx nx format:check --all`                                                                             | exit 0                                                                                                                                                                                                                                                                                                                                                                                           |
| `OPENSPEC_TELEMETRY=0 bunx openspec validate --all --json`                                               | 81 passed, 0 failed                                                                                                                                                                                                                                                                                                                                                                              |
| `bunx vitest run` (fe-01, whole suite)                                                                   | 2686 pass, 2 fail — `plan-mermaid.test.ts` M5 ×2, the pre-existing UTC+3 cases the previous change recorded                                                                                                                                                                                                                                                                                      |
| `E2E_PORT_SHIFT=1900 bunx playwright test … status.spec.ts layout.spec.ts -g "asks for the day\|pinned"` | **8 passed** (34 s): the prompt, Escape's focus return, the strip, the tint on a pinned and an unpinned cell, the fact end, the done bar; five pins with Status shown                                                                                                                                                                                                                            |

## Failure proofs

| Check                                | Fault injected                                                   | Test that observed it                                                                            | Observed                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown` clears only what read done | the `wasDone.get(…) !== 'done'` guard removed                    | core › `unknown on a row that was not done leaves its typed fact end`                            | `Expected: "2026-09-10" / Received: null` (and the parent case red beside it)                                                                                                 |
| the row says its status              | `data-row-status` dropped from `PlanRow`'s `<tr>`                | plan-cells › `every row says its status, and a done row still says done`                         | `expected null to be 'unknown'`                                                                                                                                               |
| pinned cells paint the tint layer    | the gradient dropped from `ROW_BACKGROUND`                       | table-frame › `paints a pinned body cell with the tint layer …`; e2e status spec                 | unit: `expected 'var(--cell-bg, var(--background))' to be 'linear-gradient(…'`; Chromium: `Expected pattern: /linear-gradient\(rgba\(0, 0, 0, 0\)/ · Received string: "none"` |
| Status is the third pin              | `status` taken out of `PINNED_COLUMN_IDS`                        | table-frame › `holds Status as the third pin when it is shown …`                                 | `expected undefined to deeply equal { left: 121, width: 28 }`                                                                                                                 |
| Done is asked before it is written   | the `status === 'done'` branch collapsed to a direct `setStatus` | plan-cells › `choosing Done opens the completion prompt and sends nothing until it is confirmed` | `Unable to find an accessible element with the role "dialog" and name "Mark 010 done"`                                                                                        |
| `Mark done` held back on a non-date  | the `if (!valid) return` and the button's `disabled` removed     | completion-prompt › `holds Mark done back while the day is not a date`                           | `expected false to be true`                                                                                                                                                   |
| focus returns to the Status cell     | found, not injected: Radix's default return target               | e2e status › `toBeFocused()` on the Status cell                                                  | `Expected: focused · Received: inactive` before `onClosed`; green after                                                                                                       |

Every fault was restored and the named suite watched green again before the next.
