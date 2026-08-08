# Design

Three things here are non-trivial: which cell answers a chord, what "flush
first" has to mean when the flush is somebody else's function, and the state
machine that keeps a delete off a single keystroke.

## The routing matrix

Cells in this table do not share one key handler and never have — the Name cell
has Tab and Backspace of its own, the pickers own Enter and Escape, the date
input keeps its arrows. So the chords are wired per cell class and tested per
cell class, and this table is the contract:

| cell class                                     | Ctrl+HJKL | Ctrl+N / Alt+N | Ctrl/⌘+Enter | Ctrl+D ×2   | bare Enter          |
| ---------------------------------------------- | --------- | -------------- | ------------ | ----------- | ------------------- |
| Name textarea                                  | move      | new sibling    | next/create  | arm/confirm | **newline**         |
| estimate boxes (folded cell, and the trio)     | move      | new sibling    | next/create  | arm/confirm | commit draft        |
| date (`not-before`)                            | move      | new sibling    | next/create  | arm/confirm | —                   |
| depends / team / assignee / `@`, **list open** | **inert** | **inert**      | **inert**    | **inert**   | takes the entry     |
| the same pickers, list closed                  | move      | new sibling    | next/create  | arm/confirm | depends: opens list |
| ⋯ menu open                                    | inert     | inert          | inert        | inert       | activates the item  |

One predicate answers "which command is this" — `commandChord` in
`keyboard-bindings.ts`, beside `undoChord`, typed the same way and unit-tested
per chord. One handler acts on the answer: `onCommandKey` in `wbs-table.tsx`.
Every cell class calls that handler from its own `onKeyDown`; the inert rows
are the cells that **do not call it**, which is why "inert" is a condition in
the picker rather than a special case in the handler. The picker knows whether
its list is open; the handler cannot.

**"Inert" means consumed, and round 2 of the review is why that sentence is
here.** The first version read it as "does not call `onCommandKey`", which is
only half a rule: the picker's own handler carried on to a bare
`e.key === 'Enter'` branch that reads no modifiers, so Cmd/Ctrl+Enter chose the
first team, assignee, dependency or mention — or created one out of a
half-typed search. The folded `@` cell had a second way out, because
`onAltMove` sat below the open-list branch and every Alt+arrow reached it: a
row moved or indented while its people picker was open. So each open list now
recognizes the chords at the top of its own handler — `commandChordIn`, and
`altMoveIn` where the cell is wired to `onAltMove` — takes the key with
`preventDefault`, and does nothing whatever with it. Nothing falls through, in
either direction.

Nothing is attached to `window`. The page-level guards — `isTypingInto`, the
undo/redo listener, the `?` listener — are untouched, and a chord that means
something only inside a cell is not something a page-level listener should
have to reconstruct a cell for. The two window listeners this change does add
watch for a `keyup` of D and for the focus, the tab and the window going away;
neither reads a chord.

**`preventDefault` for every chord this claims, including the ones that go
nowhere.** Ctrl+H at the left edge of the table is still Ctrl+H, and Chrome's
answer to it is the browsing history.

### Alt+N, and why on `code`

Ctrl+N is Chrome's New Window on Windows and Linux and never reaches the page
there; Cmd+N is reserved on macOS. So the same action is bound twice, and the
second binding is matched on `KeyboardEvent.code === 'KeyN'` rather than on the
letter: macOS turns Alt+N into a dead key and delivers `key: 'Dead'` with no
letter in the event at all. `KeyPress` gains an optional `code` for this, and
for nothing else.

`metaKey` is rejected outright, which is the opposite of `undoChord`'s
accept-either rule. The difference is real: undo is one action two platforms
spell differently, and these are chords one platform has already taken. On
Linux `Meta` is the Windows key.

## Flush first, and what that costs

Cmd+Enter and Ctrl+N write. Both have to send what is in the cell **before**
they create a row or move the focus — codex #5 — and both have to know whether
be-01 took it, because a refused save must leave the caret in the only copy of
what somebody typed and create nothing.

The commit path is `CellInput`'s own `onLeave`, the one a blur runs. It now
returns the `CommitOutcome` it was already computing, and every mounted cell
registers a thunk for it in a module-level `WeakMap` keyed by its DOM node
(`flushCell`). The chord holds `event.currentTarget` and nothing else, so
reaching the commit through the node is what lets all four cell classes call
one line. A node that is not a `CellInput` — the date cell, the picker inputs —
answers `unsent`: those write on the change or on the pick and hold no draft.

Two consequences worth writing down:

- **The blur that follows does not send it again.** Moving the focus blurs the
  cell, which runs `onLeave` a second time. `CellInput`'s rule 5 already covers
  it: `shown` has not advanced, the submission is recorded, and the second call
  sends nothing. This change did not add a guard for it; it checked that the
  existing one holds.

  What it did **not** check, and round 2 of the review found, is the other
  order: a blur that starts a PATCH, a click back into the unchanged cell, and
  then the chord. The flush was answered with `unsent` — the request is out,
  so nothing new was sent — and the chord read that as "nothing to wait for",
  creating a row or moving the focus while a patch that might yet be refused
  was still in the air. Rule 5 now records the in-flight promise beside
  `{typed, baseline}` and answers a matching flush with **that**, so the chord
  awaits the real outcome: refused means nothing happened, landed means go on.

- **Ordering cannot be asserted on when the calls go out.** Both leave
  synchronously either way. What an unawaited flush loses is the _answer_, so
  the unit test holds the PATCH open and asserts that nothing was created while
  it hung. The browser spec asserts the same thing on the real request log.

### Two chords in one tick

`run()` sets `busy`, which is state, so two chords in the same tick both read
the value from before either ran. A `commandInFlight` ref is the gate — set
before the flush, cleared in a `finally`. Two Cmd+Enters on the last row are
one gesture arriving twice, not two work items.

## Ctrl+D: the arm, and everything that calls it off

The chord is a delete, so the design is almost entirely about not doing it.

**Arm** on Ctrl+D with `repeat === false` in an unfrozen row: hold the row's id
_and its number_, tint the row, and say `Ctrl+D again deletes 020 — its
children move up`.

**Confirm** only when all of it holds: the same row id, `repeat === false`, and
a `keyup` of D seen since the arm. The last two overlap — a held key produces
neither a keyup nor a non-repeat keydown — and that is deliberate rather than
accidental. Each is watched failing on the scenario it uniquely owns: `repeat`
on the repeats that arrive _after_ the confirming press, which must not arm
whatever row slid up into the gap; the keyup rule on two keydowns with no
release between them, which is what a held key looks like on a browser that
does not set `repeat`.

**Disarm** on: any keydown that is not the confirm — except `Control`, `Shift`,
`Alt`, `Meta` and `CapsLock`, because reaching the second press means holding
and often re-taking Control (agy #9); the focus leaving, by key or by pointer,
which is a `focusout` rather than a blur handler on one cell; the window
blurring; the tab being hidden; three seconds; and a refresh in which the armed
row has gone or is no longer under the number the toast named.

That last one is why the arm holds the number as well as the id. "Ctrl+D again
deletes 020" stops being true the moment a peer's create renumbers this row to
030, and an arm whose sentence has stopped being true is disarmed rather than
re-aimed at whatever the row is called now.

**The timeout is a timer and nothing else.** There is no second elapsed check
at the confirm: the timer has already made it unreachable, and a check that
cannot fail is the failure this repository keeps having.

The delete itself is `deleteRow` — the actions menu's path, `strategy:
'promote'`, the same focus rule — so the keyboard and the menu cannot come to
disagree about what deleting a parent does.

## What the browser has to say

Three assertions are outside jsdom and live in `e2e/keyboard.spec.ts`: the
flush/create ordering against a real event loop and a real refetch; the
arm/confirm through a real `keyup`, and a genuinely held key producing the
browser's own auto-repeat; and Enter putting a real newline into the Name cell
and the box growing to hold it — jsdom performs no default action for a
synthetic key, so it is the one place that can see the feature at all.

And one question no test here can answer: whether a chord reaches the page in
the first place. That is the operating system's decision, Playwright dispatches
into the page rather than through it, and `tools/dev/chord-probe.html` is the
only honest answer — a static page, opened in the browser that matters, that
reports arrival and suppression per chord. It ships as a tool and proves
nothing on its own.
