<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The store

- [x] 1.1 `TAKEOVER_MS` and the takeover timer in `createCellCards`: `arriveOn` on another cell
      while a card is open schedules the takeover instead of writing; `arriveOnCard()` (renamed
      from `cancelHold`) drops it with the hold; `leave(cell)` and `holdHovered(cell)` aimed at the
      pending cell drop it; a later `arriveOn` elsewhere restarts it for itself.
      Test: `cell-card-store.test.ts`, the takeover describe.
      Negatives, one per line the store keeps: the takeover branch made to land at once — six cases,
      `gives an open card to another trigger only after the pointer has rested there` on `expected
'a:depends' to be 'a:name'`; `arriveOnCard`, `leave` and `holdHovered` each without their drop — one
      case each; `holdHovered`'s guard removed — `expected 'a:name' to be null`; `land` without
      `stopHolding` — `expected null to be 'a:name'`; the `null` branch removed — nine cases.
- [x] 1.2 The three same-cell clears become `leave(cell)`; the Start cell's focus and blur move to
      `updateFocused`. Test: `plan-table.test.tsx`'s Start-cell cases, unchanged.

- [x] 1.3 **A line of the dependency card, and only a line, is an arrival on the card.** The
      card's pointer bridge reported the pointer on the cell itself as `onPointEntry(null)`, and the
      cell answered both regions with the store's card-arrival write. At a row boundary the bridge's
      rectangle test still says "owner" for a point Chromium has already handed to the row below,
      so the store had just been told `arriveOn(030)` when "on the card" dropped that takeover:
      traced in Chromium as `arriveOn 030 · bridge move owner · arriveOnCard pending=030 · bridge move
outside · hold fired`, and 030 never answered. Found by `card-lanes.spec.ts`'s Depends lane
      after 2.2's re-timing exposed it; the jsdom walk in `plan-cells.test.tsx` (`leaves one card
open when the pointer walks from row to row`) is re-timed to the takeover too, and asserts the
      first card is the one open while it waits.
      Negative: the guard removed — `Depends on: the pointer reached 030 and 030 did not answer ·
Expected: 1 · Received: 0`, in Chromium, 2026-09-11.

## 2. The browser

- [x] 2.1 `e2e/hover-cards.spec.ts`: `keeps the preview while the hand crosses a live trigger on
its way to it` (two legs in steps: into the Depends cell of a row that waits on another, then
      onto the card) and `lets a pointer that rests on another trigger take over`.
      Negatives: `TAKEOVER_MS` set to 0 — the first on `the preview was taken over on the way ·
Expected: 1 · Received: 0`; the timer's `land()` removed — the second on `the rested-on cell opened
no card · Expected: 1 · Received: 0`. Both in Chromium, 2026-09-11.
- [x] 2.2 `e2e/card-lanes.spec.ts`'s two walks that read the next row's card at once now wait past
      the takeover first: a switched card arrives `TAKEOVER_MS` after landing, by design.

## 3. Words

- [x] 3.1 `CONTEXT.md`: **Takeover**; **Hover card** amended from "no delay" to "no delay when
      nothing is open".

## 4. Gate

- [x] 4.1 `fe-01:lint`, `fe-01:typecheck`, `fe-01:test:unit`, `fe-01:test`; the four hold-related
      browser specs on a shifted port; walks that read a switched card at once re-timed.
