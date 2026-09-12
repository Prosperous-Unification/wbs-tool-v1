# verify — cards-open-diagonally

## Commands

| Command                                                        | Result           |
| -------------------------------------------------------------- | ---------------- |
| `openspec validate --all --json`                               | PENDING          |
| `nx run fe-01:typecheck`                                       | green            |
| `nx run fe-01:lint`                                            | exit 0           |
| `nx format:check --all`                                        | exit 0           |
| jsdom (`vitest --shard=1..3/3`)                                | 889 + 704 + 1023 |
| `playwright test` (whole gate, 4 shards, `E2E_PORT_SHIFT=500`) | PENDING          |

Re-run for the 2026-09-11 slice, on this branch, on a Mac:

| Command                                                   | Result                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `nx format:check --all`                                   | exit 0                                                       |
| `nx run-many -t test lint typecheck build` (26 projects)  | fe-01 green on all four; three local failures, none in fe-01 |
| fe-01's own jsdom, inside that run                        | 102 files, **2617 passed**, + 2/3 in the zoned realm         |
| `openspec validate --all --json`                          | exit 0, 74/74                                                |
| `bun run e2e` (whole browser gate, `E2E_PORT_SHIFT=1900`) | **332 passed**, 1 failed — `header.spec.ts`, below           |

**The three failures are this Mac, not this branch**, and each was re-run alone to say so:

| Task                | Alone                                              | Why                                                                       |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| `solver-py:test`    | `ModuleNotFoundError: No module named 'ortools'`   | the Python deps are installed from `requirements.lock` in CI, not here    |
| `be-01:test`        | **2058 pass, 0 fail**, 2 errors between tests      | `SQLiteError: disk I/O error · SQLITE_IOERR_VNODE` tearing a temp DB down |
| `tool-devsync:test` | 92 pass, 8 fail, every one in `durable dev poller` | the known macOS poller failures (`project_devsync_poller_fails_on_macos`) |

None of the three reads a file this change touches: the diff is `apps/fe-01` and `openspec/`.

The browser gate's one failure is the same kind: `header.spec.ts`'s `grows page links to phone
touch targets only below the card breakpoint`, on `the larger phone targets make the page scroll
sideways · Expected: 0 · Received: 25`. Three things say it is not this change. The screenshot
has **no card on screen** — the test hovers nothing, and every line this change adds is about an
open card, `[role='tooltip']` included. The 25px is the header's own first row: the screenshot
shows `New project`'s label clipped at 390px, which is a text-width fact and therefore a font
fact. And CI is **green on this exact base** (run for `b6d59a95`, `pixels` included), which runs
Linux. A measurement that comes out 0 on Linux and 25 on a Mac is R5's platform lesson, already
written down for `press('End')`.

## Where the cards land now, measured in Chromium

The row ends at y 175 in each case, so every card starts at its row's own bottom edge:

| Card            | box                    | side                                       |
| --------------- | ---------------------- | ------------------------------------------ |
| Start           | `[836, 175, 260, 32]`  | left — that column ends 4px from the frame |
| notes preview   | `[502, 175, 876, 100]` | right, and as wide as the plan allows      |
| folded Dev step | `[884, 175, 420, 105]` | right                                      |

The writing panel is `[508, 150, 770, 131]`: level with the box it explains, past the Name cell,
and 770px of the row's right half.

## Failure proofs

| Check                                  | Injected fault                                | Watched failure                                                              |
| -------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `card-lanes` — the row is clear        | the row offset replaced by `top: 0`           | `Start: the card covers its own row · Expected: >= 174.1875 · Received: 150` |
| `hover-cards` — the reach              | `REACH_FOR_THE_CARD_MS` set to 0              | `the preview did not survive the reach · Expected: 1 · Received: 0`          |
| `external-refs` — the reach, for links | the same                                      | `the card closed on the way over to it`                                      |
| `hover-cards` — the writing panel      | the panel's `focus`/`input` listeners dropped | `waiting for getByLabel('Notes for 010, rendered while writing')`            |

## Every other column, 2026-09-11

Dany: _"implement 'diagonal' pop-up for ALL columns including PRIO, not before, deadline, end,
slack; ALL of them, must have same look and feel"_.

None of those columns has a card of its own. The **hint layer** is their pop-up — one card for
ninety-odd marks — and it had been given yesterday's placement: beside the mark, tops aligned.
So the same two promises, arithmetic this time rather than CSS, because that card is portalled
and has no cell to be a child of: `diagonalPlacement` is handed the **cross** to clear (the
mark's `<td>` horizontally, its `<tr>` vertically) and the frame to stay inside.

**The cell and the row, not the mark.** Slack's mark is the word `critical` in a 56px column and
End's is a date in an 80px one; placed against the mark, a card stands in the middle of the lane
it was meant to leave alone — 12px of it, measured.

### Failure proofs

| Check                                      | Injected fault                                 | Watched failure                                                                                          |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `hover-card` — the side                    | the side fixed at right                        | `expected { left: 740, top: 226 } to deeply equal { left: 600, top: 226 }`                               |
| `hover-card` — the edge                    | `underneath` fixed at true                     | `expected { left: 240, top: 740 } to deeply equal { left: 240, top: 710 }`                               |
| `hover-card` — clamped into the frame      | both clamps taken back to the window           | `expected { left: 160, top: 90 } to deeply equal { left: 300, top: 100 }`                                |
| `hover-card` — clamped rather than refused | a refusal in front of the clamp                | `expected null to deeply equal { left: +0, top: 40 }`                                                    |
| `hints` — every column clears its row      | the aside placement back (`top` = `clear.top`) | `Reorder: the card covers its own row · Expected: >= -0.5 · Received: -26.1875`                          |
| `hints` — every column clears its column   | `{ anchor }` for an in-frame mark              | `Reorder: the card stands over its own column · Expected: >= -0.5 · Received: -12`                       |
| `hints` — one type for every card          | `[role='tooltip']` deleted from `styles.css`   | `the portalled card's type · Expected: "sans-serif / 13px / 18.2px" · Received: "Times / 16px / normal"` |

### Where each column's card lands now, measured in Chromium

Row `020` at `[16, 175.19, 1368, 26.19]`, so its bottom edge is **201.38** — and every card's top
is 201, on the roomier side of its own cell, abutting both:

| Column         | card                  | its cell's column | side  |
| -------------- | --------------------- | ----------------- | ----- |
| Reorder        | `[32, 201, 148, 32]`  | 16–32             | right |
| Prio           | `[556, 201, 420, 50]` | 508–556           | right |
| People at once | `[708, 201, 420, 50]` | 676–708           | right |
| Not before     | `[532, 201, 420, 50]` | 952–1008          | left  |
| Deadline       | `[588, 201, 420, 87]` | 1008–1092         | left  |
| End            | `[991, 201, 199, 32]` | 1190–1288         | left  |
| Slack          | `[889, 201, 399, 32]` | 1288–1344         | left  |

The four columns at the right of a 1400px plan answer to their **left**, which is what measuring
the side is for: a card standing right of Slack would run 363px past the frame.

### The look, which no placement could see

`same look and feel` turned out to be two claims, and the second was found by taking a screenshot
and looking at it (R5's own lesson, 2026-09-01). Measured in Chromium: the Slack cell's fact came
out **`Times / 16px / normal`** beside the notes preview's **`sans-serif / 13px / 18.2px`**. A
portalled card is a child of `<body>`, which is outside the `font-sans` on `<main>` and outside
`[data-grid]` both — so every hint card in the app, every Gantt card and the project picker's
card have been drawn in the user agent's serif at the size of a paragraph since each was written.
`[role='tooltip']` in `styles.css` now carries `@apply font-sans` and the grid's own 13px over
1.4, and the browser case asserts each card against **its own cell's** computed type, with the
card's parent asserted first so the claim is about the card it names.

`--font-sans` cannot be read at runtime — `@theme inline` inlines it into utilities rather than
emitting a custom property, measured as `""` at `document.body` — so `var(--font-sans)` there
would have been a reference that resolves to nothing and a fallback that looks load-bearing.
`@apply` is what keeps one place choosing the face.

## The teleport, a third time

The reach's first browser proof moved the pointer to the card in **one** `mouse.move`, and it
passed with the reach set to 0. It had to: the card is a DOM child of the cell's wrapper, so a
jump straight onto it fires no `mouseleave` anywhere — there was never a moment for the card to
close in. The card only dies on a **stepped** move, where the samples in between land on other
cells. R5 #23's lesson (`locator.hover()` teleports) with a third set of clothes: `mouse.move`
without `steps` teleports too, and a placement whose whole difficulty is the space between two
boxes cannot be tested by skipping that space.

## When each card goes, and the two faults on the way there

Dany, twice, while this was being built: _"i need it to go away when i move my mouse away from
the preview icon and not directly into the preview — rn preview just does not go away"_, and
_"same goes for other cells - make sure that it goes away at the right time"_.

The rule the cards ended on:

| gesture                        | what happens                          |
| ------------------------------ | ------------------------------------- |
| off the trigger, anywhere else | held 300ms, then gone                 |
| off the trigger, onto the card | kept — the card says it was reached   |
| off the card                   | the cell's own leave holds, then gone |
| onto another cardable cell     | gone at once, replaced                |

The hold was 300ms first and is **180ms**: Dany asked for it shorter (_"ok, can you remove it
just a bit faster"_), and 180 still clears the 130ms a 260px flick takes. The negative was
re-watched at the new figure — the reach set to 0, `the preview did not survive the reach ·
Expected: 1 · Received: 0`.

Two cuts were wrong before this one. The **first** put the timer in each cell, and a cell that
re-opened its own card could not cancel a hold another cell had started — the dependency card
died to it, 120 seconds of `waiting for locator('[role="tooltip"]')`. The **second** cancelled
the hold on entering anywhere in the cell, and the Name cell is the widest column in the table:
moving off the `≡` glyph onto the title beside it kept the card up with nothing left to close it,
which is exactly what Dany reported. The hold lives in the store, every write cancels it, and the
only cancel that is not a write is the card's own arrival.

`onPointerGone` — the card reporting that the pointer had left it — was written and **deleted**:
the cell's own `mouseleave` already fires when the pointer leaves the card for anywhere outside
the cell, so nothing could be seen to break with it gone.

## The departure that kept the card, 2026-09-11

Dany, the morning after the slice above merged: _"notes md preview pop-up does not go away if i
move cursor away, but then move it up or down to other table elements"_ — and the rule he wants:
_"this must be a simple rule - cursor away from notes icon & the preview pop-up for N ms => remove
the preview"_.

The table above was right and the sentence under it was the fault: _"every write cancels it"_.
Reproduced first in the running app with dispatched `mouseout`/`mouseover` pairs: marker → Depends
cell → away, 40ms apart, left the preview open (`1`) and five more rows of Depends cells left it
open still; marker → Depends cell and **resting** there closed it (`0`). The Depends cell of a row
with no dependencies opens no card and still writes `updateHovered((current) => current ===
dependsCell ? null : current)` on its `mouseleave` — the same-cell guard every leave carries — and
`updateHovered` began with `stopHolding()`. A write that changed nothing cancelled the hold the
marker's leave had started, and with `hovered` still the Name cell nothing was left to close it.

The marker is the Name cell's **right edge**, so "away" is through that cell more often than not.
Both browser checks for the rule walked elsewhere: `goes when the pointer leaves the marker for
anywhere but the card` walks 120px **left**, into the name box, and `is still there after a flick`
ends at `(2, 2)`. Neither crosses a cell that writes, so neither could see this. R5's "assert in
the window the fault lives in", with the window a direction.

The fix names the two kinds of write: `arriveOn(cell)` cancels the hold and is what every enter and
focus handler calls; `updateHovered` revises the reading and leaves the hold alone. The negative is
`stopHolding()` put back at the top of `updateHovered`, watched three ways: `cell-card-store.test.ts`
on `expected 'a:name' to be null` and `expected "vi.fn()" to be called 1 times, but got 0 times`, and
the new `goes when the hand leaves the marker through the cell beside it` in Chromium on `the preview
stayed after the hand left · Expected: 0 · Received: 1` — at the first read, before the walk down.

## The state that had to move down a level

`WrittenNotesPanel` first held its text in the Name **cell**. Two suites caught it:
`plan-row-render-cost.test.tsx` on `expected 1 to be +0` — the cell re-rendering for a keystroke
it should not have noticed — and `a chord waits for the blur's patch that is still out` on
`expected "Paint" · received "Paint the trim"`, a re-render inside the blur putting the old text
back into an uncontrolled box. The panel holds its own state and listens to the box's own events
now, so nothing above it hears a keystroke.
