# verify — `reference-cell-escape-and-hover`

Every figure below was read off a run made while writing this. Nothing here is
derived, and what was not run says so.

## Where these numbers were taken

**In a detached worktree, and that is load-bearing rather than tidy.** Another
agent was editing `wbs-table.tsx`, `table-frame.ts`, `wbs-api.ts` and
`project-page.tsx` in the shared checkout throughout, and the browser measures
whatever is on disk: two consecutive runs of the same probe failed on `the
create did not arm a rename on the new project`, against a half-saved app that
had nothing to do with this change. `git worktree add --detach … HEAD` plus a
`cp -Rc node_modules` (APFS clone, instant) gives a checkout only this change
edits. The five files were written in the shared tree, copied across for each
measurement, and diffed byte-for-byte against it at the end.

The same neighbour's `lefthook auto backup` stash swallowed an untracked probe
file mid-session — worth knowing before leaving anything untracked in a
checkout somebody else commits from.

**`E2E_PORT_SHIFT=1800 is unusable on this host and the config cannot know
it.** 4200 + 1800 = **6000**, which is X11's port and one of Chromium's own
blocked ports: every navigation fails on `net::ERR_UNSAFE_PORT`before a single
assertion runs. The pre-flight check in`playwright.config.ts` compares a shift
against the three tier defaults, which is all a config can do; a blocked-port
list is the second thing it cannot know, after "what else this machine
listens on" (the 1700/5900 finding it already records). **Every run below used
1900** — 5000/5100/6100, all three free and none of them blocked.

## Commands

| Command                                                           | Result                                   |
| ----------------------------------------------------------------- | ---------------------------------------- |
| `CI=1 E2E_PORT_SHIFT=1900 playwright test … reference-cell-panel` | **6 passed**                             |
| `CI=1 E2E_PORT_SHIFT=1900 playwright test … types-cell`           | **5 passed**                             |
| `CI=1 E2E_PORT_SHIFT=1900 playwright test` (whole gate, 21 files) | **251 passed**, 0 failed, 1 `test.fixme` |
| `bunx nx run fe-01:test` (worktree, this change alone)            | **1954 passed**, 61 files, 0 failed      |
| `bunx nx run fe-01:typecheck`                                     | **passed**                               |
| `bunx eslint` over the five files                                 | **clean** (exit 0)                       |
| `bunx openspec validate reference-cell-escape-and-hover`          | valid                                    |

**`nx run fe-01:test` in the shared checkout reports 6 failures, and none of
them is this change's.** They are `external-ref-marks.test.ts`,
`steps-panel.test.tsx` (×3) and `wbs-table.test.tsx`'s `the links column` (×2)
— all of them in the neighbouring agent's uncommitted work. The 1954/0 figure
above is the same target run in the worktree, where this change is the only
diff. `fe-01:lint` in the shared checkout likewise reports 9 errors, every one
of them in `external-ref-marks.ts`, `wbs-table.test.tsx` or `wbs-table.tsx`'s
import block; the five files this change touches are clean on their own.

## Failure proofs (R5)

| Check                                            | Fault injected                                                           | Observed failure                                                                         | Watched              |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------- |
| a landed take leaves the focus in the box        | `readOnly` back to `disabled` on the picker's input                      | `Expected: "Tags for 020" / Received: "<none>"`                                          | Chromium, 2026-08-31 |
| …and the panel therefore closes on a click away  | the same, with the line above lifted out of the way                      | `Expected: false / Received: true`                                                       | Chromium, 2026-08-31 |
| a second Escape leaves the box                   | the `e.currentTarget.blur()` branch deleted                              | `Expected: "<none>" / Received: "Tags for 020"`                                          | Chromium, 2026-08-31 |
| the Types list is painted where it is offered    | `'type'` taken back out of `POPOVER_COLUMNS`                             | `Expected: "Add “Bug”" / Received: "Types for 010.1"`                                    | Chromium, 2026-08-31 |
| a pointed cell says its whole set                | the `{carded && <HoverCard …>}` block deleted                            | `expect(locator).toBeVisible() failed … Expected: visible … Error: element(s) not found` | Chromium, 2026-08-31 |
| a carried line names the row it came from        | `referenceSetLines` printing the bare name for a carried member          | `Set { - "↳ Review — from 010 Reference 010", - "↳ Risk — …", + "Review", + "Risk" }`    | Chromium, 2026-08-31 |
| the card stands down for its own editor          | `carded` widened to `pointed && lines.length > 0`                        | `expect(locator).toHaveCount(expected) failed … Expected: 0 / Received: 1`               | Chromium, 2026-08-31 |
| the overriding reading is drawn only when silent | the `own.length === 0 &&` guard dropped                                  | `↳ Core` drawn under a row stating `Platform`                                            | jsdom, 2026-08-31    |
| the Types rest line clips                        | rest `overflow: 'hidden'` → `'visible'` on **both** of the strip's boxes | `Expected: "hidden" / Received: "visible"`                                               | Chromium, 2026-08-31 |
| three types do not grow the row                  | `flex-wrap: wrap` on the strip and both chip groups                      | `three types grew the row past a single line … Expected: 26.1875 / Received: 87.1875`    | Chromium, 2026-08-31 |

## Three checks that were written and not shipped

**A focus handoff on a chip's `✕`.** The removal unmounts the button, an
unmounted focused node hands the focus to `<body>` inside React's commit, and
the `onBlur` is lost there exactly as it is for the disabled box — so the `✕`
was given `input.focus()` before starting its write. Its negative could not be
watched: **the button cannot hold the focus at all.** A press does not give it
one (`preventDefault` on mousedown), and Shift+Tab in the box is the _grid's_
move — measured in Chromium with two chips on an open Tags cell, landing on
`Service or team for 010` and then `Priority for 010`, never on a `Remove …`.
The handoff is deleted and why is written where it was going to be, with the
condition under which it should come back.

**A paint probe on the Types cell.** `elementFromPoint`, four pixels past the
cell's right edge, asserting nothing of this cell is found there. With the rest
clip removed it **passed**: the next `<td>` is later in the DOM and paints its
own background over an overflowing chip, so the hit test finds the neighbour
either way. Deleted; the style rule and the `scrollWidth > clientWidth` beside
it are what answer, and the style rule was watched failing.

**A `spillsOut` assertion ordered after a style assertion.** The first draft of
the clip case read the style first, so the injected fault met that line and the
browser fact behind it was never reached. Recorded rather than quietly
reordered: a check an injected fault does not arrive at is not proved by that
injection, whatever the run says.

## One check that was vacuous before this change and is not now

`types-cell.spec.ts`'s `a row of three types is the same height as a row of
none` is the file's headline, and its named negative had been watched leaving
all five cases green. The recorded explanation — the `<td>` clip hiding a
wrapped strip — was wrong: `type` is exempt from that clip now and the case
still passed with `flex-wrap: wrap` injected. **The real reason is that the row
was measured with the cell still being edited**, and an edited strip is an
absolutely positioned panel that is not in the row's flow at all. One `blur()`
puts it back, and the same injection then failed by 61px. The correction is in
the test, with both explanations.

## What this changes about a decision already made

`work-item-types` deliberately left `type` out of `POPOVER_COLUMNS` — or rather
never considered it, since the set's own comment says in as many words that "a
column that grows a popover and does not join this set is this bug again". It
did, three weeks later, on the column added right after that sentence was
written. The comment now names the measurement instead of the rule, so the next
reader gets the number rather than the maxim.
