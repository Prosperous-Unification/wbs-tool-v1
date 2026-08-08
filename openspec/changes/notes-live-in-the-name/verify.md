# Verification

## The gate

Run on h1claw, 2026-08-08, on `change/keys-notes-and-fit`. Re-run in full after
the round-1 review fixes below; the numbers are that second run.

```
$ bunx nx format:check --all
(no files listed, exit 0)

$ bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache
NX   Successfully ran targets test, lint, typecheck, build for 21 projects
      fe-01 (vitest)   24 files   549 pass  0 fail   (23 files / 507 before this change, +42)
      be-01 (bun:test) 41 files   384 pass  0 fail   (383 before the round-1 fixes, +1)

$ bunx nx run-many -t test --projects=fe-01 --skip-nx-cache
      Test Files  24 passed (24)
      Tests       549 passed (549)

$ bunx @fission-ai/openspec@1.3.0 validate --all --json
{"totals": {"items": 37, "passed": 37, "failed": 0}}
```

The 42 new fe-01 tests: **19** in the new `name-notes.test.ts`, **16** in
`wbs-table.test.tsx` (13, plus the three the round-1 review asked for), **6** in
`cell-navigation.test.ts` and **1** in `table-frame.test.ts`. The one new be-01
test is in `controller/undo.controller.test.ts`, over real SQLite. Nine existing tests were rewritten rather than deleted —
the walk of a row's fields, the grid's edges, the date cell's neighbours, the
markdown-on-hover pair, the empty-row veto, the popover-clip test, the
column-order test and the cell-chrome loop all lost a Notes cell and gained
whatever now sits where it did. One was replaced: `grows the notes box while it
is being written in, and shrinks after` was about a box that no longer exists,
and `makes room for a note written under the name, focus or no focus` asks the
same question of the box the note is written in now.

**The two Playwright tests in `apps/fe-01/e2e/layout.spec.ts` were not run at
that commit** — there is no browser on this machine. They ran on h2puni on
2026-08-08, during change 3, and the section below has been rewritten from
expectations into observations. One of them **found a real bug on its first
run**, which is recorded there rather than glossed.

## The checks, and the faults that broke them

Every row below was watched failing with the fault in place and passing again
with it removed, one fault at a time, on h1claw on 2026-08-08.

### The commit — who wins when two people are in one row (`wbs-table.test.tsx`)

| Check                                                          | Fault injected                                                                            | What the run reported                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The diff's third point is the focus-time baseline, not the row | `was` re-pointed at the current row props, `splitNameCell(composeNameCell(…))` off `flat` | **2 failed** — `keeps a peer’s note when the name is what was being typed` on `expected 'measure twice' to be 'their note'`, and `keeps a peer’s name when the notes are what was being typed` on `expected 'Strip' to be 'Rewire the shed'` |
| Only the name that changed is sent                             | `now.name === was.name ? {} : …` replaced with `{ name: now.name }`                       | **1 failed** — `sends only the field that changed`, on a patch carrying a name nobody retyped                                                                                                                                                |
| Only the notes that changed are sent                           | the same, for `now.notes`                                                                 | **1 failed** — the same test, on the other half: `expected [['w1', { …(2) }]] to deeply equal [['w1', …(1)]]`                                                                                                                                |
| A note stored with `\r\n` is not rewritten by a click-through  | `normalizeNewlines` dropped from both sides of the diff                                   | **1 failed** — `does not rewrite a note that was stored with Windows line endings`, on `expected [['w1', …(1)]] to deeply equal []`                                                                                                          |
| An empty diff asks be-01 for nothing                           | the `Object.keys(patch).length === 0` return deleted                                      | **1 failed** — the same test, on `expected [['w1', {}]] to deeply equal []`                                                                                                                                                                  |

Both peer tests go through the real render path: a subscription is opened, the
peer's edit is written into the fake's row, `notify()` delivers it as a refetch
while the focus is held in the textarea, the held-back value is asserted on
screen, and only then does the blur happen. Nothing reaches into the component.

### What a refusal survives, and what one gesture costs (round 1)

codex's round-1 findings 1 and 2. A refused patch left the typed text in the
DOM and nowhere else, and the same edit could be sent twice. `CellInput` gained
rules 4 and 5 — a refused draft held against every later refetch, and no second
send of the same text against the same baseline — and `commit` now answers
`landed`, `refused` or `unsent` so the box can tell which happened. All three
faults were watched on the final code on 2026-08-08, each failing its own test
and only its own.

| Check                                                     | Fault injected                                              | What the run reported                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A refused draft is held through the next refetch (rule 4) | the `if (refused.current) return` gate deleted from `sync`  | **1 failed** — `keeps a refused draft on screen when the next refetch arrives`, on `expected 'Rewire the shed\nmeasure twice' to be 'Strip the wiring\nmeasure twice, cut …'`: both typed fields replaced by the server's |
| …and the cell is told so                                  | `refused.current = outcome === 'refused'` deleted           | **1 failed** — the same test, the same assertion: a refusal nothing recorded is a refusal nothing can hold                                                                                                                |
| One gesture is one request (rule 5)                       | the `sent.current` comparison deleted from the blur handler | **1 failed** — `sends one request however often the cell is left before it lands`, on `expected [ [ 'w1', { …(2) } ], …(1) ] to have a length of 1 but got 2`                                                             |
| …and a refusal is still retryable                         | `sent.current = null` deleted from the not-landed branch    | **1 failed** — `sends a refused edit again when the cell is left a second time`, on `expected [] to deeply equal [ [ 'w1', { …(2) } ] ]`: the retry dropped as a duplicate of a request that never landed                 |

The refusal test runs through the same `peerAndMe` harness as the two clobber
tests above — a real subscription, the peer's edit delivered as a refetch — so
what holds the draft back is asserted against the arrival that would erase it.
The one-request test holds the PATCH open (a promise the test resolves) and
focuses and leaves the cell again while it is out, which is the window the
finding named.

### One gesture, one journal entry (round 1)

codex's round-1 finding 3: the fe-01 test proves one HTTP call and stops there.
Whether one call is one entry on the undo stack — and whether one Cmd+Z brings
both fields back together — is be-01's, so it is asked of be-01, through the
route, the service and the real `CommandJournalRepository` over real SQLite in
`controller/undo.controller.test.ts`.

| Check                                            | Fault injected                                                                 | What the run reported                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| A `{name, notes}` patch is **one** journal entry | the same edit sent as two requests, `{ name }` then `{ notes }`                | **1 failed** — a fourth entry on the stack: `Expected - 0 / Received + 1`, the extra `"patch"`                                    |
| …and one undo puts both fields back              | the same split, with the entry-count assertion taken out                       | **1 failed** — `Expected: "Strip" / Received: "Strip the wiring"`: one undo, one field, one Cmd+Z short                           |
| …including the field the inverse has to carry    | `revertTo`'s `if (patch.notes !== undefined) out.notes = before.notes` deleted | **1 failed** — `Expected: "measure twice" / Received: "measure twice, cut once"`: the name back, the note left where nobody asked |

### The answer a dropped resubmission gives (round 2)

codex's round-2 finding 1, and it is the fix for round-1 finding 2 that made
it: rule 5 recognized the resubmission and answered `unsent`. True of what was
_sent_ — nothing was — and false about what was _happening_, because the first
request was still out. The only caller that reads the answer is a chord, and it
read it as permission to act: blur, click back into the unchanged cell,
Cmd+Enter, and a row was created against a patch that might yet be refused.

Rule 5 now records the request's promise beside `{typed, baseline}` and answers
a matching flush with it. Both new tests are on the production path — a real
`WbsTable`, a real chord, the fake's PATCH held open by the test — and both
were watched failing on the final code, 2026-08-08.

| Check                                          | Fault injected                                              | What the run reported                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A flush joins the request already in flight    | `return sent.current.landing` put back as `return unsent()` | **1 failed** — `a chord waits for the blur’s patch that is still out, and a refusal makes nothing`, on `expected [ 'patch', 'create' ] to deeply equal [ 'patch' ]`                       |
| …and waiting is not refusing                   | the same line, same fault                                   | **1 failed** — `…and moves on once that patch lands`, on `expected <textarea …(5)></textarea> to be <textarea …(5)></textarea>`: the focus already in the next row while the save was out |
| The dedup itself still holds (round 1, re-run) | the whole `sent.current` comparison deleted                 | **1 failed** — `sends one request however often the cell is left before it lands`, unchanged                                                                                              |

The record is written **synchronously**, after the promise chain is built and
before anything can await it: the `sent.current = null` that a refusal performs
is a microtask away at the earliest, so a flush arriving in between still finds
the request it belongs to.

### The arrows, and which box owns Up and Down

| Check                                                    | Fault injected                                                       | What the run reported                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A multiline box keeps Up and Down until the caret is out | the `if (caret.multiline)` block deleted from `nextCell`             | **1 failed** — `keeps ↑ and ↓ in the name until the caret has run out of text`, on `expected false to be true`: the key taken and the focus gone from a note being read |
| …and only a multiline box does                           | `caretOf`'s `input instanceof HTMLTextAreaElement` hard-coded `true` | **1 failed** — `still walks a column of one-line boxes from any caret position`, on `expected true to be false`                                                         |
| …and every multiline box does                            | the same hard-coded `false`                                          | **1 failed** — `keeps ↑ and ↓ in the name until the caret has run out of text` again, on `expected false to be true`                                                    |

### The empty-row veto, both halves

| Check                               | Fault injected                            | What the run reported                                                                                                     |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A committed note vetoes the removal | the `row.notes === ''` conjunct dropped   | **1 failed** — `a note that has not been deleted yet still vetoes the removal`, on `expected [['w1']] to deeply equal []` |
| A note in the box vetoes it too     | the `input.value === ''` conjunct dropped | **1 failed** — `anything the item holds vetoes the backspace removal`, on `expected [['w3']] to deeply equal []`          |

The second conjunct was already there and is not redundant, which is why it has
a row: emptying the box is not the same as having emptied the work item, and
the blur that would commit the emptying has not happened.

### The column that went, and the cell that took its popover

| Check                                                     | Fault injected                               | What the run reported                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Name cell does not clip the preview that hangs off it | `'name'` dropped from `POPOVER_COLUMNS`      | **2 failed** — `does not clip the cells whose popovers open over the rows` and `gives every cell the chrome its declared width is measured with`, both on `expected 'hidden' to be 'visible'` |
| No width is left behind for a column nobody renders       | `['notes', 260]` put back in `COLUMN_WIDTHS` | **1 failed** — `has no width for a Notes column, because there is no Notes column`, on `expected function to throw an error, but it didn't`                                                   |

### The contract module

The wiring row first, for what it is worth and no more: all 19 tests in
`name-notes.test.ts` were watched failing before the module existed —
`Failed to resolve import "./name-notes"`. That proves the tests import the
production module and nothing else about them, which is codex round 1,
finding 5. The rows below are the semantic faults, one per function, each
watched on 2026-08-08 and each recorded in a `Proof:` comment on the function
it was injected into.

| Check                                                     | Fault injected                                                                           | What the run reported                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `composeNameCell` never invents a trailing newline        | the separator made unconditional, `` `${name}\n${notes}` `` for every row                | **3 failed** — `is the name alone when there are no notes` on `expected 'Strip the old wiring\n' to be 'Strip the old wiring'`, `never invents a trailing newline` on `expected true to be false`, and the stored-name-with-a-newline case on the notes coming back as `'lines\n'`         |
| `splitNameCell` splits at the **first** newline           | `indexOf` made `lastIndexOf`                                                             | **3 failed** — `keeps every newline after the first inside the notes` on `expected { name: 'Strip\n## Risks\n', … } to deeply equal { name: 'Strip', … }`, three lines of notes taken into the name; plus the blank-line case and the round trip                                           |
| …and keeps the notes' own newlines                        | the two `slice`s replaced by `const [name, ...rest] = text.split('\n')`, `rest.join('')` | **3 failed** — `keeps a blank line that has something under it` on `expected { name: 'Strip', notes: '- old' } to deeply equal { name: 'Strip', notes: '\n- old' }`: in markdown, a list that has swallowed its heading                                                                    |
| `normalizeNewlines` is what makes a stored `\r\n` a no-op | the body replaced with `return text`                                                     | **3 failed** here — `turns a pasted CRLF into one newline` on `expected 'Strip\r\nmeasure twice' to be 'Strip\nmeasure twice'` — **and 1 on the production path**: `does not rewrite a note that was stored with Windows line endings` on `expected [ [ 'w1', …(1) ] ] to deeply equal []` |

They pin the semantics the plan's reviewers asked to have chosen rather than
guarded away: delete-line-1 renames, an empty first line commits no name,
`'name\n'` is no notes at all, and a blank line with something under it stays
inside the notes.

### The browser spec — RUN, both faults observed, and one real bug found

**Run on h2puni on 2026-08-08**, inside the official Playwright image against
the real three-tier stack — the branch at `5e0e6bc`, 22 tests, all passing
before and after each fault, one fault at a time. codex's round-1 finding 4
asked for exactly this section.

| Check                                                | Fault injected                                                  | What the run reported                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Name cell does not clip the preview (G)          | `'name'` dropped from `POPOVER_COLUMNS`                         | **1 failed** — `opens the notes preview out past the bottom of the name cell`, on `4px below the name cell is <textarea> in the name column, not the preview`     |
| ↑ in a wrapped name moves the caret, not the row (H) | the `caret.multiline` gate's `caret.atStart` replaced by `true` | **1 failed** — `moves the caret through a wrapped name before it leaves the row`, at `await expect(name).toBeFocused()` — `Expected: focused, Received: inactive` |

Fault H's instruction named `!caret.textBefore.includes('\n')`, and `Caret` has
no such field. For a name that is **one logical line** — which this fixture's
deliberately is — the logical-line rule the plan's v1 proposed evaluates to
`true` at every caret position, so `true` is that rule, injected. The
substitution is recorded in the spec's footer beside the observation.

### The bug this test found before any fault was injected

`opens the notes preview out past the bottom of the name cell` **failed on its
very first browser run with the code exactly as this change shipped it** —
`4px below the name cell is <textarea> in the name column, not the preview`,
the identical sentence fault G produces. `opensAPopover` was already right and
made no difference to it.

The cause is the combination this document called out as unmeasured (assumption
C2-11, "no cell in this table has been both pinned and a popover column
before"). A pinned cell is `position: sticky` **with a z-index**, which makes
it a stacking context — so the preview inside it was trapped there, and the
_next_ row's pinned Name cell painted straight over it however high the
preview's own z-index went. In pixels the preview was invisible; in jsdom every
rule was on the right element.

Fixed in the change-3 commit that carries this run: `table-frame.ts` gains a
`POPOVER_ROW_LAYER` between the pinned body cells and the heading, and the
hovered row's Name cell is lifted to it. `lifts the hovered row above the
pinned cells the preview opens over` in `wbs-table.test.tsx` pins the rule, and
fault G is now distinguishable from the bug that was underneath it.

Fault D's second observation — `4px below the notes cell is <textarea> in the
notes column, not the preview` — was made while a Notes column still existed.
Fault G above is that fault re-run against the Name cell it moved into.

## What is proven, and by what

**Proven by the repo gate, on this machine:** the compose/split/normalize
contract including every destructive edit it makes possible, each function with
a semantic fault of its own watched; that the Name cell
shows both fields and writes back only the changed ones, in one request, diffed
against what the box was showing rather than against the row; that a peer's
edit to either field survives a local edit to the other, delivered through the
real render path; that a refused patch changes neither field, stays on screen through the next
refetch and is sent again by leaving the cell a second time; that one gesture
is one request however often the cell is left while that request is out, and
that one request is one row in `command_journal` and one Cmd+Z that restores
the name and the note together; that ↑ and ↓ stay
in the Name cell until the caret runs out and leave from the extremes, while
one-line cells are untouched; that a note vetoes the empty-row Backspace from
either side; that the Notes column is gone from the header row, the tab walk,
the width table and the clip exemptions, and that the Name cell took the
exemption over. 549 fe-01 tests and 384 be-01 tests, the fault tables above.

**Checked rather than assumed:** the cheat sheet's `PROVEN_BY` map. The arrows
entry gained a sentence about the Name cell and the Backspace entry gained a
clause, so both new arrow tests were added to the map and
`keyboard-cheat-sheet.test.tsx` re-run — 21 passed. No named test left
`wbs-table.test.tsx`; the ones this change rewrote kept their names, which was
checked rather than hoped for.

**Verified in a browser on h2puni, 2026-08-08:** that the preview is really
unclipped in pixels now that it hangs off a _pinned_ column — which took a fix
to become true, see above — and that ↑ in a wrapped name moves the caret rather
than the focus. Both were this document's open items; both now have a run
behind them, and the first of them is the reason running it mattered.

**Deliberately not covered:** typing a newline. Enter is still "new work item"
in this change — the chord that makes it a newline is `command-keys`, section 4
of the plan — so a note is written here by pasting one, by editing one that
exists, or by an API client. Every test in this change writes the two lines as
one `change` event, which is what a paste is.

## One thing the unit tests cannot say

`does not rewrite a note that was stored with Windows line endings` is the only
place `normalizeNewlines` earns its place on the production path, and it gets
there through be-01 rather than through the keyboard: a `<textarea>` normalises
what is assigned to it, so nothing typed or pasted into this box can hold a
`\r`. jsdom implements that normalisation, which is how the test can set up the
disagreement at all — but it means the paste case the plan named as the vector
is one neither jsdom nor a browser can produce. The vector is data from another
client, and that is what the test uses.
