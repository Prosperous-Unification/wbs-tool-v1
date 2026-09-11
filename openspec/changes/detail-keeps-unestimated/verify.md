# Verify

Implemented 2026-09-12 on `fix/detail-keeps-unestimated`. Measured on this Mac; CI is the gate.

## Commands

| Command                                                    | Result                                                |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `bunx vitest run --root apps/fe-01 gantt-panel.test.tsx`   | 236 pass / 0 fail                                     |
| `bunx vitest run --root apps/fe-01`                        | 2608 pass / 11 fail — **equal to the local baseline** |
| `bunx nx run-many -t lint typecheck -p fe-01`              | pass                                                  |
| `E2E_PORT_SHIFT=1900 … --grep "detail switch hides"`       | 2 passed                                              |
| `E2E_PORT_SHIFT=1900 …` gantt-detail + gantt + hover-cards | **90 passed / 0 failed**                              |
| `openspec validate detail-keeps-unestimated --json`        | `"valid": true`                                       |

The 11 fe-01 failures are `plan-mermaid`, `short-date`, `deadline-copy` and `test-tiers`, the
same four files and same count that fail on `main` on this machine — timezone and tier
bookkeeping, measured on `origin/main` during `arrange-by-schedule`.

## Measured on the real plan

Dany's own project, served by this branch's fe-01 against the running be-01, with `Detail`
off:

|                    | before | after  |
| ------------------ | ------ | ------ |
| `[data-assumed]`   | 0      | **12** |
| `[data-gantt-bar]` | 28     | **40** |

Twelve rows that drew nothing now draw their `?` bars. That is the report, closed.

## Failure proofs

| Check                              | Fault injected                                                                        | Test that observed it                                                     | Result                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drawnBars` draws every placed bar | `detailShown ? placed.bars : placed.bars.filter(({ bar }) => bar.estimated)` put back | e2e `draws an uncosted row with the detail off`                           | `expect(locator).toBeVisible() failed · element(s) not found` for `[data-gantt-bar][data-assumed="true"][aria-label^="020 - "]`, and the second case timing out on `locator.boundingBox` |
| the same, in jsdom                 | the same                                                                              | `draws a slice nobody estimated, with the detail off and with it on`      | the at-rest presence assertions, `7 failed` across the file before the cases were inverted                                                                                               |
| a parent keeps its caret gate      | —                                                                                     | `draws no not-before caret on a parent row until the detail is asked for` | the caret count is 2 with the switch off and 3 with it on; the case's own precondition is that difference                                                                                |
| the surface follows its bar        | —                                                                                     | `takes an open surface away with the bar a narrowing stops drawing`       | re-pointed and passing; see below                                                                                                                                                        |

## Two guards whose demonstrated trigger was the switch

Stated rather than quietly kept, because R5 is explicit that a check whose failure has never
been observed is a claim.

`drawnLinks` and `drawnPoolWaits` drop a line whose endpoint slice is not on the chart. The
**only** trigger ever demonstrated for them was the detail switch removing an uncosted bar —
the recorded proof in their JSDoc names exactly that — and the switch no longer removes any
bar. Their other stated triggers (a row collapsed away, a row narrowed off by a search) are
reachable in principle and **are not covered by a test**. They are kept rather than deleted,
and this is the note that says so.

The neighbouring guard on the open hover surface was in the same position and is now proved
again: its case is re-pointed at a **narrowing** — the same `plan` arriving without the row
and without a new `generation` — and it fails when the surface outlives its bar. That is the
shape a test for the two link filters would take, and it is the follow-up.

## Three browser cases that encoded the old rule

The whole browser gate was started locally and **killed by the OS for memory** partway
through; it had reached 197 of ~375 and had found three failures, all in specs this change
touches. All three assumed the switch removes a bar:

| Case                                                                                | What it assumed                                                       | What it says now                                                                                                       |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `gantt.spec.ts` › `opens with the detail on, and keeps the answer through a reload` | assumed bars fall to 0 across the reload with the arrows and brackets | their count is the same on both sides                                                                                  |
| `gantt.spec.ts` › `draws every mark at rest…`                                       | two bars once the detail is off                                       | four bars; the bracket alone is what the press takes                                                                   |
| `hover-cards.spec.ts` › `points a row that draws no bar at all`                     | an unestimated row is empty end to end                                | the emptiness is a **stretch of line**, and the pointer's x is asserted past the right edge of every bar the row draws |

The third needed more than a number: its subject is that a row's band lights from the row's
line rather than from any mark on it, and that claim survives — only its precondition had to
move from "this row has no bar" to "this point has no bar on it", measured rather than
assumed.

Re-run after the fixes, over the three specs this change touches: **90 passed / 0 failed**.

## Gate

The whole browser gate is CI's (`pixels`, four shards) together with the workspace gate, and
both run on every push. The local full run is not available — see above.
