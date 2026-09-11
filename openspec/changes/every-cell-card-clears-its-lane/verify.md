# verify — every-cell-card-clears-its-lane

## Commands

| Command                                                        | Result                  |
| -------------------------------------------------------------- | ----------------------- |
| `openspec validate --all --json`                               | 68 items, 68 passed     |
| `nx run fe-01:typecheck`                                       | green                   |
| `nx run fe-01:lint`                                            | exit 0                  |
| `nx format:check --all`                                        | exit 0                  |
| `nx run fe-01:test`                                            | 2608 + 3 passed, exit 0 |
| `playwright test card-lanes` (`E2E_PORT_SHIFT=500`)            | 2 passed                |
| `playwright test` (whole gate, 4 shards, `E2E_PORT_SHIFT=500`) | 324 passed, 36 skipped  |

**Sharded, and that is not a detail.** The gate ran as `--shard=1/4 … 4/4`: one run of all 324
was killed twice by this machine's memory watchdog, at test 37 and again at 2. Four runs of about
a hundred each finish in 7.4, 6.4, 2.5 and 2.3 minutes and none was killed.

## What was measured, column by column

A throwaway probe walked all seven card-bearing columns in Chromium before anything was
changed, three rows deep, with the four reference columns on screen. `covers` is whether the
open card's box contains the next row's trigger; `hit` is what `elementFromPoint` answers
there; `walk` is whether that row's own card opened after the pointer moved to it.

| Column          | covers | hit                             | walk |
| --------------- | ------ | ------------------------------- | ---- |
| Start           | yes    | `SPAN` (through the card)       | ✓    |
| Name (preview)  | yes    | `H1` **inside the card**        | ✗    |
| Depends on      | yes    | `DIV` **inside the card**       | ✗    |
| Types           | yes    | `BUTTON[Remove Build from 020]` | ✓    |
| Tags            | yes    | `SPAN`                          | ✓    |
| folded Dev step | yes    | `INPUT[Dev estimate for 020]`   | ✓    |
| Links           | no     | `SPAN`                          | ✓    |

Every card covers the next row's trigger; the four that pass do it by being transparent. So the
fix was needed exactly where a card takes the pointer, and the probe is what said which those
were rather than a reading of the code.

## Failure proofs

| Check                                       | Injected fault                                        | Watched failure                                                                               |
| ------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `card-lanes` — the notes preview's geometry | `clearsMarkerLane` back to `left: -24px` + cap        | `the notes preview: the open card is over 020's own trigger · Received: "the open card (H1)"` |
| `card-lanes` — Depends on's geometry        | `opensSideways` removed                               | `Depends on: … Received: "the open card (DIV)"`                                               |
| `card-lanes` — the walk                     | `entersThroughDependsCard` widened to `!== 'outside'` | `Depends on: the pointer reached 030 and 030 did not answer · Expected: 1 · Received: 0`      |
| `depends-card.test.tsx` — the corridor      | the bounding-box corridor put back                    | `expected { kind: 'corridor' } to deeply equal { kind: 'outside' }`                           |
| `hover-card.test.tsx` — the declaration     | `clearsMarkerLane` off `HoverPreview`                 | `expected '' to be '24px'`                                                                    |

| `hover-cards.spec.ts` — the passive space | `takesPointer` added to the dependency card | `the card's empty space is over nothing clickable · Received string: "What 010 waits for"` |
| `hover-cards.spec.ts` — the wide lane | `clearsMarkerLane` off `HoverPreview` | `the preview covers the marker lane · Expected: <= 486.40625 · Received: 502` |

The corridor's browser negative is deliberately **not** claimed: with the enter fix in place,
both corridor shapes walk, because the enter that crosses a row boundary lands in the owner's
own rectangle and is let through either way. The unit is its proof, and the leak it removes —
a bounding box that fills the whole area below the cell — is why the shape was changed rather
than left to luck.

## The checks that could not fail, and how they were found

Two, both in this file's own first cuts, both about **where a walk is taken**.

The Depends on lane was first walked at `box.x + 2`, the passive strip `hover-cards.spec.ts`
uses to open that card without landing on a chip. The card under its cell starts at the `<td>`'s
padding, so those two pixels are the one lane in the column it never covers: the negative was
watched **passing**. Moved to the column's middle, it passed **again** — `mouse.move(…, { steps:
12 })` samples the row boundary, the enter fires there, the next row's card opens, and the
pointer's arrival on a card line is never the state the assertion reads.

So the file now makes two claims per column: `elementFromPoint` at the point the reader aims
for, which is the geometry, and the walk, which is the end-to-end fact. The first sees a card in
the way; the second sees a guard that swallows the arrival. Neither sees the other's fault.

## A guard deleted, and a defect found

**`entersThroughDependsCard` is gone**, both call sites with it. It held a `mouseenter` that
landed inside the open card's passive padding — over the Depends on cell, or a chip, of the row
**beneath** — so that the row beneath could not take the card over. Beside its cell, no Depends
on cell but the card's own is ever under it. Measured before deleting: with the guard removed,
the only failures anywhere were its own two proofs, both already red from the placement change.
That is `CARD_GRACE_MS` this morning wearing a second hat — a guard made vacuous by the fix
that follows it.

**And a defect this change reported that was never there.** `paints over the pinned cell of the
row below it` was re-aimed at the folded step card once the dependency card stopped standing over
a pinned cell, and its screenshot oracle was watched **passing** with `zIndex: 20` deleted — the
two shots differ because moving the pointer away also unlights the row, so the pair was never
about the card. It was replaced with `elementFromPoint` at the middle of the overlap, that
answered the pinned `<textarea>` **with the z-index in place**, and this file recorded a defect on
the strength of it. Wrong: a card is `pointer-events: none`, so the hit test answers what is
beneath it however the paint came out. Corrected on 2026-09-10 in
`fix/an-unpinned-cards-lift`, which restores the test with a third oracle — the card's
`pointer-events` set to `auto` for the length of one `elementFromPoint` — watched answering `the
card` with the z-index in place and `TEXTAREA` without it. (A painted-pixel comparison was tried
in between and failed on CI: both surfaces are white.) R5 #27.
