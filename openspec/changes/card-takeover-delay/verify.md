# verify — card-takeover-delay

## Commands

| Command                                                                                         | Result                                                                     |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `openspec validate --all --json`                                                                | 73 items, 73 passed                                                        |
| `nx run fe-01:typecheck`                                                                        | green                                                                      |
| `nx run fe-01:lint`                                                                             | exit 0                                                                     |
| `nx run fe-01:test:unit`                                                                        | 31 files, 528 passed                                                       |
| `nx run fe-01:test`                                                                             | 103 files, 2643 passed, + 2/3 zoned                                        |
| `playwright test` hover-cards, card-lanes, external-refs, deps-cell (`CI=1 E2E_PORT_SHIFT=500`) | 59 planned, 59/59 reached, 59 passed, exit 0 (twice: before and after 1.3) |

## Failure proofs

| Check                                                                                                                         | Injected fault                                                             | Watched failure                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `gives an open card to another trigger only after the pointer has rested there` (+5 cases)                                    | the takeover branch made to land at once                                   | `expected 'a:depends' to be 'a:name'`                                                    |
| `keeps the card the hand reaches, whatever trigger it crossed on the way`                                                     | `arriveOnCard` without `dropTakeover()`                                    | `expected 'a:depends' to be 'a:name'`                                                    |
| `drops a takeover the pointer leaves behind, and the reach still closes the first card`                                       | `leave` without its drop                                                   | `expected 'a:depends' to be 'a:name'`                                                    |
| `drops a takeover when the trigger is left with a hold of its own, and keeps the first card's hold`                           | `holdHovered` without its drop                                             | `expected 'b:name' to be 'a:name'`                                                       |
| the same                                                                                                                      | `holdHovered`'s same-cell guard removed                                    | `expected 'a:name' to be null`                                                           |
| `coming back to its own trigger keeps the card`, and the reach's `keeps the card while the pointer is back on what opened it` | `land` without `stopHolding()`                                             | `expected null to be 'a:name'`                                                           |
| `opens at once when nothing is open` (+8 cases)                                                                               | the `null` branch removed, every arrival waits                             | `expected null to be 'a:name'`                                                           |
| `keeps the preview while the hand crosses a live trigger on its way to it` (Chromium)                                         | `TAKEOVER_MS = 0`                                                          | `the preview was taken over on the way · Expected: 1 · Received: 0`                      |
| `lets a pointer that rests on another trigger take over` (Chromium)                                                           | the timer's `land()` removed                                               | `the rested-on cell opened no card · Expected: 1 · Received: 0`                          |
| `card-lanes.spec.ts` — `the pointer walks down each column and every row answers for itself`, Depends lane                    | the dependency cell's `onPointEntry` cancelling for the "owner" region too | `Depends on: the pointer reached 030 and 030 did not answer · Expected: 1 · Received: 0` |

The second browser case fails on the **card** and not on the preview: with the takeover never
landing, the preview still goes — to the reach the marker's leave started — so the only thing
that fault leaves visible is the card that never opened.

## The figure, judged

`TAKEOVER_MS` shipped at 100 (PR #410) and is **50** since 2026-09-12: Dany watched the 100 in
Chrome and asked for half (_"maybe reduce it to 50ms?"_). Every store case advances relative to the
constant, so nothing was re-timed; the browser crossing (`keeps the preview while the hand crosses
a live trigger on its way to it`) has to land its second leg inside the figure, and was re-run at
50 before the change went up.

## The bridge's boundary, found by the re-timing

The first full run of the four hold-related specs failed the Depends lane of `card-lanes` even
after its read was moved past the takeover. The store was instrumented and the run traced:

```
arriveOn 030::depends   hovered=020   pending=—        ← React's enter for the row below
bridge move owner       y=201.375                      ← the bridge's rectangle test: still 020's cell
arriveOnCard            hovered=020   pending=030      ← "on the card" — dropped 030's takeover
bridge move outside     y=203.557
hold 020 … hold fired   hovered=020                    ← nothing left to open; 020 closed
```

Chromium hands the pointer to the next row a fraction of a pixel before the rectangle test agrees,
which the file's own history already knew ("an enter that landed in the row above's own
rectangle"). Before the takeover this was harmless: the switch was instant and `cancelHold` had
nothing to cancel. The dependency cell now writes the card arrival only for a **line** of the card;
the cell's own `mouseenter` is what says the pointer is back on the cell, through `arriveOn`.

The synthetic reproduction in the running app (dispatched `mouseover` and one `pointermove`) had
passed at 340ms, because it skipped the boundary sample. **A reproduction that skips the pixels a
hand crosses is the teleport again**, in a different tool.

One assertion was re-timed rather than added: the reach describe's `keeps the card the pointer
arrived on, not the one it left` asserted the switch at once, which is the behaviour this change
removes; it now advances `TAKEOVER_MS` first.
