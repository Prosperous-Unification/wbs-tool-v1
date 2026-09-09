# verify — links-card-takes-the-pointer

## Commands

| Command                                                      | Result                         |
| ------------------------------------------------------------ | ------------------------------ |
| `nx format:check --all`                                      | clean                          |
| `nx run fe-01:lint`                                          | 0 problems                     |
| `nx run fe-01:typecheck`                                     | green                          |
| `openspec validate --all --json`                             | 65 items, 65 passed            |
| `nx run fe-01:test`                                          | 2598 + 3 passed, exit 0        |
| `playwright test … external-refs -g "walks onto the card"`   | 1 passed                       |
| `playwright test` (whole browser gate, `E2E_PORT_SHIFT=500`) | 320 passed, 37 skipped, exit 0 |

## Failure proofs

| Check                                           | Injected fault          | Watched failure                          |
| ----------------------------------------------- | ----------------------- | ---------------------------------------- |
| `walks onto the card` — the placement assertion | `opensSideways` removed | `the card does not open beside the cell` |
| `walks onto the card` — the crossing            | `takesPointer` removed  | `the card closed on the way over to it`  |

## The guard that was written, proved, and then deleted

A 200ms `CARD_GRACE_MS` held an open card while the pointer crossed the Name column. While the
card opened **under** its cell that guard was load-bearing and its negative was real: with the
timer at 0, `the card closed on a diagonal reach for a link`.

Then the card moved **beside** the cell, its left edge became the cell's right edge, and the gap
stopped existing. Re-measured with the timer **and** its re-arm removed: the walk still passed.
So both went. Nothing here keeps a guard whose removal cannot be seen.

The `takesPointer` negative records the same lesson from the other direction: with the grace
period still in place, that injection got past the crossing and failed at the padding probe one
assertion later. **The guard that is gone was hiding what the remaining one is for.**

## What the previous change's tests could not see

`locator.hover()` puts the pointer on an element's centre. `link-names-and-card` asserted the
card's link was reachable and clickable with `await name.hover()` and passed twice over a card
whose padding was `pointer-events: none`. Every proof here moves the pointer in `steps`, and
each step of the walk down the list is asserted rather than only the last.
