# HANDOVER — configurable-columns (paused 2026-08-28)

Delete this file before the PR leaves draft. It is the state of the work, not an artifact.

## Where things are

- Branch `change/configurable-columns`, draft PR **#174**, commit `ee5eed0` on top of `main@d4b60ad`.
- `tasks.md`: 9/10 slices ticked. Open: **5.2** (browser gate green) and the `verify.md` artifact.
- Unit side is green: fe-01 vitest 1773 pass; the 2 `plan-mermaid.test.ts` failures are the Mac's
  timezone (pass under `TZ=UTC`, pre-existing, untouched). `nx lint/typecheck/build fe-01`,
  `nx format:check --all`, `doc-caps` (LLM_README at 150), `openspec validate --all` (77/77): clean.
- Every safety check has a watched negative; the table is in the PR body. Proof comments cite them.

## Browser gate — 193 pass / 8 fail (shifted ports, local Chromium, 7.4 min)

Run with: `CI=1 bunx playwright test -c apps/fe-01/playwright.scratch.config.ts` from the repo root.
The scratch config (ports 3111/3211/4211, `reuseExistingServer:false`) is **untracked** — recreate
from `playwright.config.ts` if missing (memory `project_worktree_rebase_bun_install.md` has the recipe).
The user's own `bun run dev` holds 3100/3200/4200; never run e2e against it.

New test `takes a hidden column’s width off the table, and the frame stops scrolling` **passes**;
`holds the folded budget at 1280` passes **unchanged**.

Failures, triaged (not yet fixed):

| #   | Test                                                                                       | Cause                                                                                       | Owner                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `keyboard.spec.ts:247` Cmd+Enter in an open team picker                                    | waits for `Service or team for 010` — Teams is hidden by default now                        | **mine** — show Teams first: `page.getByText('Columns',{exact:true}).click(); page.getByRole('checkbox',{name:'Teams'}).check()` (or seed `wbs.hiddenColumns.<projectId>` = `[]`)                                                          |
| 2   | `directory.spec.ts:146` names what a removal would take                                    | same team cell                                                                              | **mine** — same fix                                                                                                                                                                                                                        |
| 3   | `mobile.spec.ts:368` and `:1316` ≥44px controls on the Plan actions sheet                  | the Columns control's tick rows are `min-h-6` inputs (13px) — 54 short controls reported    | **mine** — size like the Filters ticks on the sheet (find what made the facet tick rows 44px after the 2026-08-22 sweep; `TAP = 'min-h-11'` in `plan-cards.tsx`); keep `label[for]` so `wbs-table.test.tsx`'s `offered()` still reads them |
| 4   | `header.spec.ts:264` frame height 633 vs ≥ 634                                             | off by one; the extra toolbar control may change the toolbar's wrap at 1280 — or a subpixel | **probably mine** — measure `[data-toolbar]` rows with/without the control                                                                                                                                                                 |
| 5   | `deps-cell.spec.ts:430` hover paint in both palettes (`Expected 0, Received 12` on a poll) | unclear; Tags column now on by default shifts the deps cell's neighbours — or flaky         | investigate; run alone on `main` via the scratch config to see if it is pre-existing                                                                                                                                                       |
| 6   | `keyboard.spec.ts:454` and `:598` typed day lands as `2026-01-07` for `2026-07-01`         | day/month swapped — the local Chromium's locale, not the code                               | **environment** — set `use.locale: 'en-US'` in the scratch config and re-run these two; CI runs en-US                                                                                                                                      |

## Next steps, in order

1. Fix 1–2 in the two specs (show Teams through the control), fix 3 in `ColumnsControl` (sheet sizing).
2. Re-run the whole gate on shifted ports with `locale: 'en-US'`; decide 4–5 from evidence, not reasoning.
3. `/opsx:verify configurable-columns` → `verify.md` (gate output, failure-proof table — copy from the PR body, add the e2e rows).
4. Tick 5.2, delete this file, undraft #174, squash-merge like #173.

## Design decisions already taken (do not re-open)

Default set = today's fixed columns + Tags − Teams − Services (Dany, 2026-08-28). Hide-list storage.
A role hides whole. Saved views carry `hiddenColumnIds?` (absent = leave columns alone). Number, Name,
drag handle, ⋯ menu never hideable. Cards/exports/Gantt untouched. See `design.md` D1–D5.
