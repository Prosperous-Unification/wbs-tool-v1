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

## 1. The button, in jsdom

- [x] 1.1 `wbs-table.tsx`: a `<button data-dep-add>` as the **first** child
      of the deps strip, `flexShrink: 0`, `aria-label={`Make ${number} wait
      for something`}` (deliberately not the box's name), `title="Add a
dependency"`; `onMouseDown` cancels the press and nothing else,
      `onClick` focuses the cell's box through
      `[data-depends-input="<id>"]` on its own parent — the notes marker's
      reach, scoped by the row's id — and the box's existing `onFocus`
      opens the picker; `tabIndex={-1}` unconditionally — tests
      (`wbs-table.test.tsx`, watched failing first):
      `offers an add button at the head of every rested deps cell`,
      `opens the picker from the add button, on the box the cell already
has`, `keeps the add button out of the tab order, at rest and with the
picker open`, `refuses the press the focus, so the box beside it keeps
what was typed`;
      negatives, each watched 2026-08-11 and each restored with a `Proof:`
      comment: the button removed → all four failed on `Unable to find a
label with the text of: Make 030 wait for something`; the `onClick`
      body dropped → `expected <body><div>…(1)</div></body> to be <input
…(10)></input>`; the chips' condition copied onto `tabIndex`
      (`picker === null ? -1 : undefined`) → `expected +0 to be -1` with
      the picker open; the `preventDefault` dropped → `expected true to be
false`

## 2. The quiet, in the stylesheet

- [x] 2.1 `styles.css`: `[data-grid] td[data-column='depends'] button` and
      its `:hover` gain `:not([data-dep-add])` — a chip's hover goes
      `--destructive` because the ✕ is saying what the click will do, and
      an "add" that turned red would be promising a removal — and the add
      button gets its own pair: no border, no fill, `--muted-foreground`,
      `--accent` on hover, with the chips' exact `line-height: 1.5` and
      `padding: 0 4px` so the strip's line box is unmoved. Nothing fades it
      in on a row hover: always visible is the ask, and jsdom cannot see a
      stylesheet rule act, which is what slice 3 is for

## 3. The browser measurements — CI's `pixels` job

- [x] 3.1 `e2e/deps-cell.spec.ts`, three tests on the existing seven-chip
      fixture: (a) `keeps the add button visible in a cell whose chips are
clipped` — the strip proven to be clipping (`scrollWidth >
clientWidth`) and the last chip proven invisible at its own centre
      first, then the add button laid out with real area, answering a hit
      test at its own centre, and no taller than a chip; (b) `opens the
picker from the add button, with the caret in the box` — a real click
      on 010's button, the listbox visible and the box focused; (c) `keeps
a half-typed search when the add button is pressed` — `03` typed, the
      button pressed, the value, the focus and the open list all still
      there. Written here; **proven by the PR's `pixels` CI job** — this
      host has no browser, so no local run is claimed (R5)
- [x] 3.2 The existing chip query in that file narrowed from
      `td[data-column="depends"] button` to
      `button[aria-label^="Stop "]`: the strip now carries an eighth button
      that is not a chip, and the count of seven is the precondition the
      whole rest-height test hangs off
- [x] 3.3 The browser negatives, watched red in CI before the head that
      ships — both invisible to jsdom, so the `gate` job stays green and
      the observation is the browser's: `order: 1` on the add button (the
      DOM order the jsdom tests assert unchanged, the paint order reversed)
      → (a) red; a focus-stealing `onMouseUp` on it (no jsdom test fires
      `mouseup`) → (c) red. Restored on the following head and the job
      watched green. Recorded in `verify.md`, "Watched in CI"

## 4. Gate

- [x] 4.1 `bunx nx format:check --all`, the run-many gate
      (`test lint typecheck`) and
      `bunx @fission-ai/openspec@1.3.0 validate --all --json` green;
      `verify.md` records the commands, their output, and the failure-proof
      table naming every injected fault above and the test that observed it
- [ ] 4.2 Deploy to dev and Dany looks — a `+` at the head of every Depends
      on cell, quiet enough to ignore and there without asking

## 5. Review fixes, observed in a browser first

The two P2 findings from the cross review were **derived** and not seen, so
both were measured on dev at `2b2affec` in a cloud Chromium before anything
was changed — the numbers are in `verify.md`, "Observed before the fix".
Both held.

- [x] 5.1 An empty cell no longer grows when it is clicked into. The strip
      wraps only where there are chips to wrap, so the box can share the
      line with the affordance instead of claiming one of its own. Observed
      at 26px rest against 44.98px open, the box dropping to a second line
      and the listbox 21px down the page with it. The crowded cell's open
      state is untouched, which is the half `deps-single-line` measured. The
      `+` was **not** hidden while the picker is open to buy the height
      back: always visible is the whole of what it is for
- [x] 5.2 The hover pays attention to the row it lands on — the row's own
      ink at `--grid-hover`'s own dose, mixed into `--cell-bg` rather than
      painted as an absolute colour. `--accent` was `oklch(0.968)` over a
      hovered row's `oklab(0.93903 …)`, lighter than the row, and read as a
      hole punched through it; four thousandths from a dep-lit row's colour,
      where it all but vanished. `--cell-bg` is the join every other row
      state re-points, so every one of them gets the same treatment.
      `--card-dep-lit`'s pattern (#38), one layer further in
- [x] 5.3 The `title` deleted — it disagreed with the accessible name the
      button was deliberately given, putting the control back under the two
      names that name was chosen to avoid
- [x] 5.4 Four checks, each watched red on an injected fault: two in jsdom
      (the chipless strip's one nowrap line, the absent tooltip), watched
      locally; two in Chromium (the empty cell's open height, the hover's
      direction against the row in both palettes), watched in CI. The faults
      and what each said are in `verify.md`
- [x] 5.5 Re-deployed to dev on the fixed head and both findings
      re-measured in a fresh cloud browser session
