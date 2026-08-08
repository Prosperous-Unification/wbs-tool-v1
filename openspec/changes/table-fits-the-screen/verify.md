# Verification

## The gate

Run on h1claw, 2026-08-08, on `change/keys-notes-and-fit`.

```
$ bunx nx format:check --all
(no files listed, exit 0)

$ bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache
NX   Successfully ran targets test, lint, typecheck, build for 21 projects

$ bunx nx run-many -t test lint typecheck --projects=fe-01 --skip-nx-cache
NX   Successfully ran targets test, lint, typecheck for project fe-01
      Test Files  25 passed (25)
      Tests       565 passed (565)

$ bunx @fission-ai/openspec@1.3.0 validate --all --json
{"items": 38, "passed": 38, "failed": 0}
```

565 fe-01 tests, up from 507 before this branch and 543 before this change:
**5** in the new `mention.test.ts`, **12** in `wbs-table.test.tsx` (the
accordion, the fold copy, six `@` tests, the folded assignee display, and the
hovered row's layer — which a browser asked for), **5** in
`table-frame.test.ts` (the flexible column, the compaction, the equation), and
the rest are existing tests re-pointed at the new widths and headings. None was
deleted.

**The browser matrix in `apps/fe-01/e2e/layout.spec.ts` ran on h2puni**, and
its section is below. It moved two numbers in the width table and found five
things nothing on this machine could have.

## The checks, and the faults that broke them

Every row below was watched failing with the fault in place and passing again
with it removed, one fault at a time, on h1claw on 2026-08-08.

### The width table (`table-frame.test.ts`)

| Check                                         | Fault injected                                                            | What the run reported                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name has no declared width and is flexible    | `['name', 360]` back in `COLUMN_WIDTHS`, `name` out of `FLEXIBLE_COLUMNS` | **1 failed** — `leaves the Name column to the layout, and asks nobody for its width`, on `expected false to be true`                                                        |
| Every fixed column is the compacted figure    | the pre-compaction widths (drag 28, number 168)                           | **1 failed** — `compacts every fixed column to the figure it actually holds`, on `expected { drag: 28, number: 168, …(8) } to deeply equal { drag: 24, number: 100, …(8) }` |
| The equation budgets the floor, not a width   | the `FLEXIBLE_COLUMNS` branch replaced by `widthFor(id)`                  | **1 failed** — `adds a table up from its columns…`, on `UnknownColumnError: No declared width for column "name"`                                                            |
| …and not zero either                          | the same branch replaced by `0`                                           | **1 failed** — same test, on `expected +0 to be 200`                                                                                                                        |
| Only the last pinned column may be flexible   | `PINNED_COLUMNS` reordered to `['name', 'number', 'drag']`                | **the module threw while loading** — `name has no declared width, so number cannot be pinned after it`; the file reported `Tests no tests`                                  |
| The pin declares no width for a flexible cell | `pinnedCellStyle` back to `width: pinned.width ?? 360`                    | **1 failed** — `gives a pinned cell an opaque background and a layer to paint in`, on `expected 360 to be undefined`                                                        |
| The indent leaves the number the larger half  | `INDENT_STEP` back to 16                                                  | **1 failed** — `stops growing, so the Number column cannot outgrow its declared width`, on `expected 64 to be less than 50`                                                 |

### The table (`wbs-table.test.tsx`)

| Check                                                     | Fault injected                                                                           | What the run reported                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The colgroup declares nothing for a flexible column       | the colgroup made to emit `360` for it                                                   | **1 failed** — `declares every rendered column once, in the order they are rendered`, on `expected ['24px','100px','360px'] to deeply equal ['24px','100px','']`                              |
| The table is the frame's width with the equation under it | `width: tableMinWidth(leafColumnIds)` and no `minWidth`                                  | **1 failed** — `is as wide as the frame, and never narrower than its own equation`, on `expected '1382px' to be '100%'`                                                                       |
| The pinned Name cell carries no width                     | `pinnedCellStyle` back to `width: pinned.width ?? 360`                                   | **1 failed** — `pins the handle, the number and the name, and nothing past them`, on `expected '360px' to be ''`                                                                              |
| A folded role's cell does not clip its `@` list           | the `-final` suffix dropped from `opensAPopover`                                         | **2 failed** — `does not clip the cells whose popovers open over the rows` and `gives every cell the chrome its declared width is measured with`, both on `expected 'hidden' to be 'visible'` |
| One role unfolds at a time                                | `toggleRole` back to `[...current, roleId]`                                              | **1 failed** — `unfolds one role at a time, so the table still fits the window`, on `expected <input …(5)></input> to be null`                                                                |
| The fold button no longer claims to hide the assignee     | the old copy restored                                                                    | **1 failed** — `says what the fold button does…`, on `expected 'Dev — show the three-point estimate a…' to contain 'show the three points behind the figu…'`                                  |
| The mention never reaches the estimate parser             | the `splitMention` call in `commitCombinedEstimate` replaced by `const estimate = typed` | **1 failed** — `never lets the @ half read as an estimate, half-typed or abandoned`, on `expected '@ka' to be '4'` — the mention committed as shorthand                                       |

### What is proven by the gate on this machine

The width table's literals and the three states of the equation; that
`widthFor` still throws for `name` exactly as for a typo; that the `<colgroup>`
declares nothing for it and the `<table>` carries `width: 100%` with the
state's own minimum; that the pinned offsets are 0 / 24 / 124 and the Name cell
declares no width but does declare its floor; that unfolding one role folds the
other and the declared minimum follows; the shortened headings and the `title`s
that took over what they used to say; `splitMention`'s five cases; and the six
behaviours of the `@` picker — filter, one-gesture assign, add, remove-first-on-
a-bare-`@`, the assumed name in grey, and nothing at all where neither holds.

## The browser matrix, on h2puni

Run inside `mcr.microsoft.com/playwright:v1.62.1-noble` against the real
three-tier stack (be-01, gw-01, Vite), one worker, no retries, on 2026-08-08.

```
$ ./run-e2e.sh
Running 22 tests using 1 worker
  22 passed (35.9s)
```

Five runs were needed to get there and the four that failed are the point of
having run it. What the browser said, in order:

**1. Four tests written on a machine with no browser could not have passed.**
Every one of them was written over changes 1 and 2 and type-checked cleanly.

- `keeps every control inside the cell it belongs to` — `Expected: > 12,
Received: 12`. It wanted more than a dozen boxes from a plan that has held
  exactly twelve since the Notes column moved into the Name cell.
- `opens a row's actions menu out past the bottom of its own cell` — `no
[role="menu"] is open in tbody tr:first-child td[data-column="actions"]`. It
  opened the LAST row's menu and probed the FIRST row's cell; it could only
  ever have thrown.
- `moves the caret through a wrapped name before it leaves the row` —
  `Expected: > 2, Received: NaN`. Chromium answers `normal` for a `line-height`
  nothing set, and `parseFloat('normal')` is `NaN`, so the precondition that
  says "this name really wraps" could not fail.
- `opens the dependency list wider than the column it drops from` — `waiting
for getByRole('listbox')`. It clicked the box on the one row whose list has
  nothing left to offer: 020 already depends on 010 in the seeded plan.

**2. A real bug, with no fault injected.** `opens the notes preview out past
the bottom of the name cell` failed on `4px below the name cell is <textarea>
in the name column, not the preview`. A pinned cell is `position: sticky`
**with a z-index**, so it is a stacking context: the preview was trapped inside
it and the next row's pinned Name cell painted over it. `opensAPopover` was
already correct. Fixed with `POPOVER_ROW_LAYER` in `table-frame.ts` and the
hovered row lifted to it; `notes-live-in-the-name/verify.md` carries the full
account, since the preview is that change's.

**3. The toolbar, not the table, was what scrolled the page.** At 900px and at
125% zoom the document scrolled sideways while the table behaved perfectly:
about 1245px of buttons in a `display: flex` row that could not wrap. One
`flexWrap: 'wrap'` fixed it, and both assertions then held.

**4. The date column's width was decided by the browser, not by the plan.** The
first version of that assertion — `input.scrollWidth <= input.clientWidth` —
**could not fail**: with `not-before` deliberately at 60px every test passed,
because Chromium lays the element out at whatever width it is given and clips
its own internals inside it. What replaced it measures an unconstrained
`input[type=date]` in the table's own font: this Chromium asks for **138px**,
so the column is 146 (138 plus `CELL`'s padding) rather than the planned 108.
Every conclusion survives the extra 38px — the fixed columns come to 752
instead of 714, and 1144 / 1240 / 1420 replace 1106 / 1202 / 1382.

**5. The plan's numbering guesses were wrong twice**, in the deep fixture: Tab
indents a row under its **previous sibling**, so each level takes one more
press; and indenting a root **renumbers the roots after it**, so `050` is
called `040` by the time the next press lands. Both are written out in the
fixture now.

### The faults, injected one at a time against the real stack

Each was applied to the h2puni checkout, run, and reverted; the suite was green
before and after each one. The instructions are in the footer of
`apps/fe-01/e2e/layout.spec.ts` beside the observations.

| #   | Fault injected                                                            | What the run reported                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I   | `['name', 360]` back in `COLUMN_WIDTHS`, `name` out of `FLEXIBLE_COLUMNS` | **3 failed** — `1280×800: the folded equation should fit this viewport, Expected: <= 1200, Received: 1304`; `gives the name column everything the other columns did not take`, `Expected: 256, Received: 360`; and the deep fixture on `the frame scrolls sideways with 1304px of table in 1200px of frame` |
| J   | `'name'` dropped from `PINNED_COLUMNS`                                    | **3 failed** — all on `declaredLeft`'s own refusal, `Error: name is not a pinned column`, including `scrolls the frame below the table's minimum, with the name still pinned`                                                                                                                               |
| K   | `['not-before', 146]` → 60                                                | **2 failed** — `the earliest-start field is 52px where this browser wants 138px, so its value is cut off. Expected: >= 137, Received: 52`                                                                                                                                                                   |
| L   | the `-final` suffix dropped from `opensAPopover`                          | **1 failed** — `opens the folded role's @ picker out past the bottom of a 96px cell`, on `4px below the folded QA cell is <div> in the no column, not the open list`                                                                                                                                        |

Faults E to H — the two changes before this one, whose browser faults had never
been observed — were injected in the same session and are recorded in
`openspec/changes/actions-menu/verify.md` and
`openspec/changes/notes-live-in-the-name/verify.md`.

**The Tab prediction, settled.** `actions-menu/verify.md` named Tab out of an
open menu as the assertion most likely to be wrong, and said that landing on
the still-open menu item would be a real focus trap rather than a test to
relax. It lands on `Name of 020`, on the first run and every run since. No bug,
nothing changed.

### What only a browser could say — and one thing nothing here can

Measured, at 1280×800 and 1512×982, with the roles folded, with each role
unfolded in turn, and with the deep fixture — a name four levels down with no
space in it to wrap at, and a row carrying seven dependency chips: the page
never scrolls sideways; the frame does not either while the equation fits it;
every leaf column's rectangle is inside the frame; Name is at or above its
200px floor and is exactly the frame minus the other columns; the date field is
at least as wide as this browser asks for. At 900px the frame scrolls, the page
does not, and the pinned Name sits at exactly 124. At 125% zoom the frame
absorbs the overflow and the page still does not scroll. The depends list opens
at 260px, wider than the 110px column it drops from. The actions menu and the
folded `@` picker are both hit-test visible below their own cells on the last
row at 1280px, the menu wholly inside the window.

**The three-role fixture in the plan's matrix cannot be built at all**, and
that is a gap rather than a postponement. be-01 creates a project with exactly
`Dev` and `QA` (`STARTING_ROLES`, `project.service.ts`) and neither the API nor
the UI offers a way to add a third, so no browser can be shown one. The third
role's cost is asserted as arithmetic instead — `tableMinWidth` for three
folded roles is 1202, in `table-frame.test.ts` — and that is all it is:
arithmetic, not a measurement. Recorded as assumption C3-4.

### Deliberately not covered

A keyboard route to `Remove <name>` other than a bare `@` and Enter; a highlight
in the `@` list (it takes the first entry, exactly as the team and assignee
boxes do); persistence of which role is unfolded; and the parked option of
hiding Start/End/Slack while a role is open, which the plan records and does not
build.
