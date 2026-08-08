# Verification

## The gate

Run on h1claw, 2026-08-08, on `change/keys-notes-and-fit`. Re-run in full after
the round-2 review fixes below; the numbers are that second run.

```
$ bunx nx format:check --all
(no files listed, exit 0)

$ bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache
NX   Successfully ran targets test, lint, typecheck, build for 21 projects

$ bunx nx run-many -t test lint typecheck --projects=fe-01 --skip-nx-cache
NX   Successfully ran targets test, lint, typecheck for project fe-01
      Test Files  25 passed (25)
      Tests       612 passed (612)     (605 before the round-2 fixes, +7)

$ bunx @fission-ai/openspec@1.3.0 validate --all --json
"totals": { "items": 39, "passed": 39, "failed": 0 }
```

The 40 tests this change added before the round-2 fixes: **7** in
`keyboard-cheat-sheet.test.tsx` (the `commandChord` predicate), **5** in
`cell-navigation.test.ts` (`commandMove`), and **28** in `wbs-table.test.tsx`,
which went from 242 declarations to 270. Round 2 adds **7** more, all in
`wbs-table.test.tsx` — two for finding 1 and five for finding 2 — plus two
browser tests in `e2e/keyboard.spec.ts`, which the gate above does not run.

Both baselines were measured rather than subtracted: 605 is
`bunx vitest run` from `apps/fe-01` at the commit the round-2 review read, and
565 is the same command on a worktree at this branch's parent. **A reviewer
quoted 565 as this branch's own total**; it is the figure from before the
change, and the run above is what it is now.

**The test migration was its own task, and it was one helper.** `grep` for
Enter in `wbs-table.test.tsx` found the scaffolding behind everything: a single
`pressEnter(number)` used at **15 call sites across 14 tests**, every one of
them pressing Enter only to _get_ a second row before asserting something else.
It is now `pressNewItem`, firing Ctrl+N, and the one comment that named Enter
as the gesture says Ctrl+N. No test was deleted and none was rewritten to
assert something different. The remaining `{ key: 'Enter' }` sites in that file
are all picker and menu Enters, which this change deliberately does not touch.

`openspec validate` rejected the fifth requirement's first draft —
`ADDED "An open list owns the keyboard" must contain SHALL or MUST` — because
the `SHALL` was on the paragraph's third line. Reworded, not worked around.

## Faults, watched

Every check this change adds was watched failing with the check removed, on
2026-08-08, on this branch. The command is `bunx vitest run <file> -t '<test>'`
from `apps/fe-01`, with the fault applied to the source and reverted after.

| #   | fault injected                                                              | test that went red                                                             | how it failed                                                                   |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1   | `NO_TEXT_IN_THE_WAY` narrowed to a real mid-text caret                      | `moves from a caret no arrow could leave`, +2                                  | `expected null not to be null` — three of the five commandMove tests            |
| 2   | `commandInFlight` ref removed                                               | `two Cmd+Enters on the last row make exactly one row`                          | `expected [ '010', …, '050' ] to deeply equal [ '010', '020', '030', '040' ]`   |
| 3   | the `await` dropped, outcome hard-coded `landed`, flush fired and forgotten | `waits for the save to land before it creates anything`                        | `expected [ 'patch', 'create' ] to deeply equal [ 'patch' ]`                    |
| 4   | the `refused` return removed from the chord                                 | `a refused save leaves the caret where it was and makes no row`                | `expected [ '010', '020', '030', '040' ] to deeply equal [ '010','020','030' ]` |
| 5   | `event.preventDefault()` removed from `onCommandKey`                        | `a chord at the grid’s edge is consumed rather than leaking to the browser`    | `expected false to be true`                                                     |
| 6   | the deleted Enter branch put back in `onKeyDown`                            | `Enter in a name is a newline, and makes nothing`                              | `expected true to be false`                                                     |
| 7   | `repeat` conjunct removed                                                   | `a repeat after the confirming press does not arm the row that took its place` | `expected '020' to be null`                                                     |
| 8   | `dReleased` conjunct removed                                                | `two presses with no release between them only re-arm`                         | `expected null to be '020'`                                                     |
| 9   | same-row conjunct removed                                                   | `arming 020 and pressing Ctrl+D on 030 arms 030 and deletes neither`           | `expected null to be '030'`                                                     |
| 10  | the frozen refusal removed                                                  | `a frozen row refuses to arm and says how to unfreeze it`                      | `expected [ Array(1) ] to include '020 is frozen — unfreeze it first'`          |
| 11  | `MODIFIER_KEYS` exemption removed, so every keydown disarms                 | `any other keystroke disarms it, and a modifier on its own does not`           | `expected null to be '020'`                                                     |
| 12  | the `focusout`/`blur` disarm listeners removed                              | `leaving the cell disarms it, however the focus went`                          | `expected '020' to be null`                                                     |
| 13  | the id-and-number check replaced by `return armed`                          | `a peer renumbering the armed row disarms it`                                  | `expected '030' to be null`                                                     |
| 14  | `CreatablePicker`'s `!open` guard dropped                                   | `every chord is inert while a team picker’s list is open`                      | `expected '020' to be null`                                                     |
| 15  | the depends `!open` condition forced true                                   | `every chord is inert while the depends list is open`                          | `expected <input …(11)></input> to be <input …(10)></input>`                    |
| 16  | `actions-menu.tsx`'s modifier guard removed                                 | `every chord is inert while a row’s ⋯ menu is open`                            | `to have a length of 3 but got 4` — Duplicate taken by Cmd+Enter                |

### Round 2, and what #14–#16 were not enough to say

codex's round-2 finding 2. Faults #14 and #15 above proved that an open list
does not call `onCommandKey`; they could not see that the same keystroke went
on to be read as the list's own bare Enter three lines further down. The ⋯ menu
was the one surface that had already been caught doing it (#16, and assumption
C4-12) — the pickers had the same hole and nobody looked. The folded `@` cell
had a second one: `onAltMove` sits **below** the open-list branch, so every
Alt+arrow reached it and moved the row while its people picker was open.

Each open list now recognizes the chords at the top of its own handler and
consumes them. Five new tests, each asserting what the surface would actually
have done — an assignment, a team, a dependency, a highlight, a row order —
rather than "no new WBS row". All watched failing on the final code,
2026-08-08.

| #   | fault injected                                                     | test that went red                                                                  | how it failed                                                                                      |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 17  | the `commandChordIn` consume guard removed from `creatable-picker` | `Cmd+Enter in an open team picker takes no entry and creates none`                  | `expected 'team1' to be null` — 020 labelled by a keystroke aimed at the plan                      |
| 18  | the same guard                                                     | `Cmd+Enter in an open assignee picker assigns nobody and adds nobody`               | `expected [ 'assign w2 role-dev person1' ] to deeply equal []`                                     |
| 19  | the consume guard removed from the depends `onKeyDown`             | `Cmd+Enter in the open depends list adds no dependency`                             | `expected <button type="button" …(2)></button> to be null` — the chip for an edge nobody confirmed |
| 20  | the consume guard removed from the folded `@` cell                 | `Cmd+Enter in the folded cell’s open @ list assigns nobody`                         | `expected [ 'assign w2 role-dev person1' ] to deeply equal []`                                     |
| 21  | the same guard                                                     | `Alt+arrows in the folded cell’s open @ list move no row`                           | `expected [ 'Strip', 'Paint', 'Sand' ] to deeply equal [ 'Strip', 'Sand', 'Paint' ]`               |
| 22  | `return sent.current.landing` put back as `return unsent()`        | `a chord waits for the blur’s patch that is still out, and a refusal makes nothing` | `expected [ 'patch', 'create' ] to deeply equal [ 'patch' ]`                                       |
| 23  | the same line                                                      | `…and moves on once that patch lands`                                               | `expected <textarea …(5)></textarea> to be <textarea …(5)></textarea>`                             |
| 24  | `altMoveIn`'s modifier guard narrowed to `!event.altKey`           | `leaves a composing alt arrow, and one with a second modifier, alone`               | `expected false to be true` — re-watched where the line now lives                                  |

#22 and #23 are round-2 finding 1, whose home is `notes-live-in-the-name`; they
are listed here as well because the contract they break is this change's — "a
refused save leaves the caret where it was and makes no row". #24 is not a new
check: `onAltMove`'s modifier rule moved into `altMoveIn` so the open `@` list
could recognize exactly the same keystrokes, and a guard that moved was
re-watched at its new address rather than assumed.

**The guard is only where the box is a cell of the grid.** `CreatablePicker`
consumes a chord only when it was given `gridCell` — a picker rendered outside
a table is not in the routing matrix, none of these keystrokes is a chord
there, and the component's promise to leave such a picker's keyboard alone
still holds.

Three of those did not reproduce on the first attempt, and the tests were the
problem rather than the faults. They are recorded because they are the R5
failure this repository keeps having, caught here rather than shipped:

- **#3.** The first ordering test compared the order the two calls _went out_
  in. Both go out synchronously either way, so dropping the `await` left it
  green. Rewritten to hold the PATCH open and assert that nothing was created
  while it hung.
- **#13.** The first version of that test had a peer _delete_ the armed row and
  asserted the tint was gone. A deleted row renders nothing, so it had no tint
  to find whatever the code did. Rewritten around a peer's create that
  renumbers the armed row — the same expression, on the branch that can be
  seen.
- **#2 and #9** were reported as skips rather than passes: vitest's `-t` is a
  regex, and `Cmd+Enters` and `Ctrl+D` match nothing. Re-run against the part
  of the title with no `+` in it.

## The overlap between the two Ctrl+D guards, stated

`repeat === false` and "a keyup of D since the arm" both exist because the plan
asks for both, and on a real held key they say the same thing — there is
neither a keyup nor a non-repeat keydown. So neither can be watched failing on
the plan's own "held Ctrl+D" scenario: the other guard passes the test.

Each is therefore proven on the scenario it uniquely owns (#7 and #8 above):
`repeat` on the repeats that arrive _after_ the confirming press, which must
not arm the row that slid up into the gap, and the keyup rule on two keydowns
with no release between them — what a held key looks like on a browser that
does not set `repeat`, and what two keyboards produce. The plan's held-key test
(`a held Ctrl+D never deletes, however long it is held`) is kept as the
scenario-level assertion it is, and it is not claimed as either guard's proof.

## What only a browser can say — h2puni

`apps/fe-01/e2e/keyboard.spec.ts`, **eight** tests since round 2, run on h2puni
through `/home/puni1/wbs-e2e-work/run-e2e.sh` (the Playwright docker image;
h1claw has no browser and does not build). The run below is at `7bb87ce`, with
the round-2 fixes in.

```
$ ssh h2puni 'cd /home/puni1/wbs-e2e-work && ./run-e2e.sh'
  ✓  1 keyboard.spec.ts  types a note under a name with Enter, and the box grows to hold it
  ✓  2 keyboard.spec.ts  Cmd+Enter saves the cell before it creates the row it lands in
  ✓  3 keyboard.spec.ts  a chord after a blur whose save is still out waits for that save
  ✓  4 keyboard.spec.ts  Cmd+Enter in an open team picker takes no entry and creates none
  ✓  5 keyboard.spec.ts  Ctrl+D arms on the first press and deletes on the second
  ✓  6 keyboard.spec.ts  a key still held when the row goes does not arm the row after it
  ✓  7 keyboard.spec.ts  arming one row and pressing Ctrl+D in another arms the second, …
  ✓  8 keyboard.spec.ts  a held Ctrl+D arms once and never deletes
  ✓  9–30 layout.spec.ts (unchanged, all green)
  30 passed (51.4s)
```

### The two round-2 browser tests, and their faults

Both were watched failing on h2puni with the fix removed, one at a time,
restored and re-run green after each.

| fault injected                                                     | test that went red                                                 | how it failed                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `return sent.current.landing` put back as `return unsent()`        | `a chord after a blur whose save is still out waits for that save` | `expect(received).toHaveLength(expected)` on the POST filter — a create inside the two seconds the PATCH was held open                      |
| the `commandChordIn` consume guard removed from `creatable-picker` | `Cmd+Enter in an open team picker takes no entry and creates none` | `expect(received).toEqual(expected)`, `+ Received + 4` — four writes where the test expects none: the team created and 010 labelled with it |

**One finding from the first run, and it was the test’s fault.** The closing
assertion used `getByLabel('Service or team for 010')`, which in a browser
resolves to **two** elements — the combobox and the listbox it opens carry the
same accessible name — and Playwright refuses in strict mode. Every assertion
the test exists for had already passed. It asks by role now.

### The browser faults, watched

| fault injected                 | test that went red                                                 | how it failed                                                                                |
| ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `repeat` guard removed         | `a key still held when the row goes does not arm the row after it` | `expect(received).toBe(expected)` on the armed-row count                                     |
| `await` dropped from the flush | `Cmd+Enter saves the cell before it creates the row it lands in`   | `expect(received).toHaveLength(expected)` — a POST inside the window the PATCH was held open |

Restored and re-run green after each. Three findings from those runs, all of
which made a test weaker than it read:

- **The first "held key" tests held nothing.** They pressed `keyboard.down('d')`
  once and waited 800ms: Playwright does not auto-repeat a key, so the test
  that claimed to hold Ctrl+D delivered exactly one keydown. Verified against a
  throwaway spec that logged what arrived — `["Control:false", "d:false",
"d:true", "d:true", "d:true"]` — and rewritten to repeat `down('d')`, which
  is what sets `repeat: true`.
- **A retrying assertion waited out the arm timer.**
  `expect(locator).toHaveCount(0)` retries for ten seconds; an arm expires after
  three. With the `repeat` guard removed the row really was armed, and the
  assertion sat there until the timer took it off, then passed. Watched doing
  it, with the arm traced press by press. Both of those assertions are now a
  one-shot `count()`.
- **The same-row conjunct cannot be proven in a browser at all**, and the e2e
  test says so rather than pretending. Reaching another row means moving the
  focus, and the focus rule disarms before the second press arrives — so with
  the conjunct removed, all six browser tests stay green. It is proven in
  `wbs-table.test.tsx`, where a key can be aimed at a row without the focus
  following it. Two guards, one outcome; the browser can only see the outer
  one.

## One consequence of the matrix, stated because Dany will meet it

The Depends-on box opens its list **on focus** — with nothing typed, every
other work item is on offer — so the chords are inert there from the moment the
focus arrives, and Escape is what gives them back. That is the routing matrix
applied exactly as written ("the open list owns the keyboard; Escape first"),
and `the same chords work in that box once the list is closed` is the test that
pins it. It is also the one cell where the rule will be felt as friction: Ctrl+J
out of a dependency box needs an Escape first. Recorded rather than quietly
special-cased, because the alternative — letting the chords through a list with
a highlighted entry in it — is the collision the rule exists to prevent.

## What nothing here can say — the acceptance probe

Whether a chord reaches page JavaScript at all is the operating system's
decision. jsdom delivers whatever a test constructs; Playwright dispatches into
the page rather than through the OS. **No check in this repository can answer
it**, and none of the above is offered as if it could.

`tools/dev/chord-probe.html` is the answer: a static page, no framework, no
build, opened in the browser the chords have to work in. It reports, per chord,
whether a `keydown` arrived and whether `preventDefault()` suppressed the
default. `arrived: no` on Ctrl+N is the expected result on Windows and Linux
Chrome and is exactly why Alt+N is bound to the same action. This is assumption
A8 in `tmp/assumptions-keys-fit.md`: the probe ships as a tool and the ten
minutes are Dany's, before merge.
