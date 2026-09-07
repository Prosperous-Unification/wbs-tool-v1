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

## 1. The state machine and the lit rows, in jsdom

- [x] 1.1 `wbs-table.tsx`: table-level
      `depHover: { rowId, pillId | null } | null` beside `depPicker`, read
      through `live`; the deps wrapper's enter sets `{rowId, pillId: null}`
      (guarded on `waitingFor.length > 0` — codex round 3 finding 5's "no
      render spent for nothing"), its leave clears with the same-cell guard;
      each pill's enter sets its id, its leave restores `pillId: null`
      guarded on its own id; every writer bails out (returns `current`) when
      the value is already there. `<tr>` gains `data-row-id` and
      `data-dep-lit`; the lit set derives per render from the hovered row's
      `dependsOn` (all of it at `pillId: null`, the one pill otherwise),
      never from the hovered row's own id — tests (`wbs-table.test.tsx`,
      watched failing first):
      `lights every dependency's row from the cell, and no other row`,
      `narrows to the pill's row, and widens again when the pill is left`;
      negatives: the lit set derived from `depHover.rowId` → the cell test
      watched failing on `expected ['030'] to deeply equal ['010', '020']`;
      the pill leave's restore dropped (returning `current`) → the pill test
      watched failing on `expected ['010'] to deeply equal ['010', '020']`;
      each restored with a `Proof:` comment

- [x] 1.2 The remount landmine, pinned by its own negative: hover must
      re-render and never remount — `columns` keeps `[roles, unfoldedRoles]`
      and `depHover` is read through `live` alone — test:
      `lights rows without remounting the cells under a half-typed name`,
      which asserts the lit rows first (a hover that wrote nothing cannot
      pass it) and then the focus, node identity and half-typed value;
      negative: `depHover` added to the `columns` memo's dependency list →
      watched failing on `expected <textarea …(5)></textarea> to be

<textarea …(5)></textarea>` — the same-labelled box a different node,

      the cell remounted under the typist

- [x] 1.3 The card: `DependsCard` gains `emphasisedId: string | null`, fed
      from this cell's `depHover.pillId` through `live`; the emphasised
      entry renders `background: var(--grid-dep-lit)` — the row tint by
      token, not bold — and the collapsed case keeps the guarantee: a
      dependency with no shown row lights nothing and is still named by the
      card, which is built from the tree (`dependenciesOf` over `flat`) and
      never from the rows on screen — tests:
      `emphasises the pill's entry in the card as a background, not bold`,
      `a collapsed dependency has no row to light, and the card still names
it` (which first proves the probe live on the un-collapsed branch);
      negatives: `emphasisedId` hardcoded to null → watched failing on
      `expected '' to be 'var(--card-dep-lit)'` (re-watched 2026-08-11 for
      the per-surface token, slice 5); the card's list narrowed to
      entries with a rendered `<tr>` → watched failing on `Unable to find an
accessible element with the role "tooltip"` — the hidden dependency
      dropped and the cell left with nothing to say

## 2. The tint, in the stylesheet

- [x] 2.1 `styles.css`: `--grid-dep-lit` beside the other grid surfaces (the
      drop tint's ink at a lower dose), and
      `[data-grid] tbody tr[data-dep-lit] { --cell-bg: var(--grid-dep-lit) }`
      after `tr:hover` — the join that reaches the pinned cells' opaque
      inline backgrounds; jsdom cannot see this rule act, which is what
      slice 3 is for

## 3. The browser measurements — CI's `pixels` job

- [x] 3.1 `e2e/hover-cards.spec.ts`, three tests: (a) cell hover paints both
      dependency rows one shared tint — the pinned Name cell's computed
      background, polled through the 100ms cross-fade, banded and unbanded
      row landing on the same colour, dark again on leaving; (b) pill hover
      paints one row, leaves the other at rest, and the card's emphasised
      line carries the lit row's exact computed colour at weight 400, the
      real pointer move off the pill widening the light back; (c) the
      clipped-chip case — seven chips onto 020, the clipped chip proven to
      answer no hit test at its own centre (real area and real clipping
      asserted first, R5 #16), the cell-level hover point found by hit test,
      and the clipped dependency's row lit all the same. Written here;
      **proven by the PR's `pixels` CI job** — this host has no browser, so
      no local run is claimed (R5)

- [x] 3.2 The browser negative, watched red first in CI: the first PR head
      withholds the `tr[data-dep-lit]` rule from `styles.css` — the
      attribute set, the paint unchanged, jsdom green throughout — and the
      `pixels` job is watched failing all three tests above; the following
      commit restores the rule and the job is watched green. Red half
      observed on PR #38, head `ec1580e` (run 31434033908, 2026-08-10):
      `gate pass 2m35s`, `pixels fail 5m51s`, all three dependency-hover
      tests failing by name on the unmoved paint (`Expected: not
"oklab(0.978225 …)"`, `Timeout 10000ms exceeded while waiting on the
predicate`). One pre-existing test failed in the same run on a seed
      race (`verify.md`, "Not verified"). The green half is recorded in
      `verify.md` when the restore head's run lands

## 4. Gate

- [x] 4.1 `bunx nx format:check --all`, the run-many gate
      (`test lint typecheck build`) and
      `bunx @fission-ai/openspec@1.3.0 validate --all --json` green;
      `verify.md` records the commands, their output, and the failure-proof
      table naming every injected fault above and the test that observed it
- [ ] 4.2 Deploy to dev and Dany looks — hover a crowded cell and see the
      plan answer back: the rows it waits for lit in the grid, the card
      agreeing line for line

## 5. The cross-review fixes (round 1, 2026-08-11)

Both reviewers on the `04a4b9e` head. `tmp/review-codex-dep-hover.txt` and
`tmp/review-agy-dep-hover.txt` are the raw outputs; the numbering below is
this slice's, not theirs.

- [x] 5.1 **The pill hover trusted a remembered id.** `depLit` returned
      `new Set([pillId])` without asking whether the hovered cell still names
      it, and the ✕ _is_ the pill — clicking it unmounts the element, so no
      `mouseleave` arrives and the cut edge's row stayed lit under a pointer
      that had not moved. Both ends fixed: the chip's `onClick` widens the
      hover to the cell (which is where the pointer still is), and `depLit`
      requires `hovered.dependsOn.includes(pillId)`. Test: `widens back to
the remaining dependencies when a pill is deleted under the pointer`;
      negatives — the widen dropped → `expected [] to deeply equal ['020']`,
      the `includes` guard dropped with it → `expected ['010'] to deeply
equal ['020']`, the cut edge still lit. Both watched, 2026-08-11
- [x] 5.2 **The tint inverted between surfaces in the dark palette.** One
      absolute `--grid-dep-lit` mixed against `--background` is lighter than
      the rows (`oklch(0.129 …)`) and darker than the card
      (`oklch(0.208 …)`), so the one emphasis read as a tint in the grid and
      a cutout in the card. Now per-surface: `--card-dep-lit` is the same
      dose of the same ink into `--popover`, so both move the same way —
      darker than both surfaces on a light page, lighter than both on a dark
      one. Test: `the tint moves the same way on both surfaces, in both
palettes`, which reaches the dark palette by the root class and
      compares rasterised luminance rather than colour strings (two
      notations, `oklab(…)` and `rgb(…)`, are what made string equality
      useless). The old exact-colour assertion is gone from the pill test
      and its reason is written where it was: in the default palette
      `--background` and `--popover` are the same white, so that equality
      was satisfied by the very token that inverted in dark
- [x] 5.3 **The three browser checks' watched red predated their own text.**
      Run 31434033908 was recorded on `ec1580e`, before `settledRowBg` and
      the rewritten pill assertion existed, so it proved nothing about the
      checks as they stand. Re-watched on the current text — and on five
      checks, not three, the two added here included. See `verify.md`,
      "Watched in CI"
- [x] 5.4 **The light was pointer-only.** `depFocus` mirrors `depHover` from
      focus and `depLit` reads `depHover ?? depFocus`; the box's focus lights
      the cell's dependencies, a focused pill narrows to its own row.
      Separate state so a blur cannot clear a live hover nor a `mouseleave` a
      live focus. Tests: `lights the rows a cell waits for while its box
holds the focus`, `narrows to a focused pill, and clears when the focus
leaves it`, and in the browser `the keyboard gets the same light, from
the box's focus`; negatives — the box's write dropped → `expected [] to
deeply equal ['010', '020']`, the chip's dropped → `expected [] to
deeply equal ['010']`. Watched, 2026-08-11. **Narrowed, in the spec and
      not silently:** sequential Tab reaches the box and not the chips
      (`deps-single-line` holds a clipped chip out of the tab order), so the
      keyboard gets the cell-level light and the per-pill correspondence only
      where focus can land on a chip. Re-opening the chips' tab order is that
      change's decision, made against a watched fault, and is not reversed
      here
- [x] 5.5 **The card swatch hugged the glyphs.** `borderRadius: 3` with no
      padding cut the rounded corners into the first and last letter. Now
      `padding: '1px 4px'` with `margin: '-1px -4px'` giving the inset
      straight back, so emphasising a line does not move it or reflow the
      card as the pointer walks the pills
- [x] 5.6 **`verify.md` contradicted itself about the green run.** It said
      the green was "recorded here" and also that it would be recorded "when
      it lands". Run 31434962012 (`gate` and `pixels` both success on
      `04a4b9e`) is the one it meant and is now cited as such — and
      superseded by this round's own green, which is the head that ships
- [x] 5.7 **The self-dependency guarantee is documented as upstream.** "The
      hovered row itself is never lit" needs no filter because `be-01`'s
      dependency service refuses any edge closing a cycle
      (`service/dependency.ts:57`, `hasCycle`) and a self-edge is the
      shortest cycle there is. Stated in the spec and beside `depLit`
