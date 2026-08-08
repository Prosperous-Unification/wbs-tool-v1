# Design

Three things here are not obvious from the specs: which text is compared
against which when the cell is left, why the caret rule is written the way it
is, and what happens to a `\r`.

## The baseline, and why it is not the row

`CellInput` already holds the value this box was last showing (`shown`), and
already refuses to overwrite the box with a newer one while somebody is typing
in it — rule 2, the fix that closed "a cell input's React `key` holds its
value" on 2026-08-06. That hold-back is exactly what makes a two-field cell
dangerous: while it is in force, **the row this cell renders from and the text
in the box disagree about a field nobody here has touched.**

So the diff is three-way, and the third point is `shown` handed out as the
`commit` callback's second argument. `commitNameCell` splits both texts and
compares field by field:

|       | baseline (`shown`) | typed              | sent       |
| ----- | ------------------ | ------------------ | ---------- |
| name  | `Strip`            | `Strip the wiring` | `{ name }` |
| notes | `measure twice`    | `measure twice`    | —          |

A peer's `notes` edit that arrived mid-word never enters that table, so it
cannot be sent back as `''`. Diffing against the row's current props instead
produces exactly the clobber both reviewers found, from opposite ends — and
that is the fault the two symmetric peer tests were watched failing on.

The alternative considered and rejected: snapshot `{name, notes}` in the cell's
own `onFocus`. It needs a second piece of state, kept in step with the one
`CellInput` already keeps, in a component whose whole design note is "two copies
of the same fact drift". The baseline the box is already comparing against is
the same moment by construction.

**One request, not two.** `api.patch` takes both fields, be-01 writes one
journal entry per request, and the undo stack is that journal. Two requests
would make one gesture two undos, and a refusal could land after a success and
leave the row half written. That be-01 really does write one entry, and that
one undo really does restore both fields, is asserted through the route and the
real journal in `controller/undo.controller.test.ts` — the front end's test can
only ever prove one HTTP call.

## What the commit answers, and what the box does with it

`commit` returns `Promise<CommitOutcome>` — `landed`, `refused` or `unsent` —
and that answer is the whole of what a cell knows about its own text. Two rules
in `CellInput` are built on it, both from round 1 of the review:

- **A refused draft is held (rule 4).** A refusal arrives _after_ the blur that
  sent it, so rule 2 — "hold a peer's edit back while this cell has the focus"
  — is no longer in force by the time it comes. The typed text is then in the
  DOM and nowhere else: be-01 never got it, and the row this cell renders from
  says what it always said. The next refetch of any kind would write over both
  fields. So a refusal sets a flag `sync` consults before anything else, and it
  is cleared only by the person: leaving the cell again retries the same text
  (`shown` still holds the old baseline, so the diff is unchanged), and putting
  the box back to what it was showing abandons it.
- **The same text is not sent twice (rule 5).** `shown` deliberately does not
  advance until the refetch lands, so inside that window a second focus-and-
  leave looks exactly like a fresh edit. The cell records
  `{typed, baseline, landing}` on the way out and answers an identical
  resubmission with `landing` — the promise of the request that is already
  out — rather than sending a second one. The record is cleared whenever the
  answer is not `landed`, which is what keeps a deliberate retry of a refused
  edit working — and it expires by itself, because a refetch that moves `shown`
  moves the baseline half of it.

  **The promise is the third field because a flush is not only a blur.** Round
  2 of the review found the first version answering `unsent` here, which is the
  one answer that is untrue in that window: the request _is_ out. A chord that
  flushed the cell read `unsent` as "nothing is happening" and created a row or
  moved the focus while a patch that might still be refused was in the air —
  the exact contract `command-keys` exists to hold. Returning the in-flight
  promise makes the two callers agree: the blur ignores the answer as it always
  did, and the chord waits for it.

`unsent` is not `landed`. Two commits ask be-01 for nothing: the composite cell
whose two texts differ only in their line endings, and an estimate box holding
a half-typed trio as a draft. Calling either of those "landed" would record a
write that never happened; calling them "refused" would hold a draft nobody
refused.

## The caret rule

v1 of the plan said "leave from the first or last logical line". That is wrong
for a box that wraps, and Name has wrapped since `notes-and-wrap`: a name of
one logical line can occupy four visual ones, and the rule would take the key
on the first press while the caret still had three lines to climb.

The rule that ships is "position 0, or `value.length`". It needs no layout, so
jsdom and a browser agree on it, and it composes with the browser's own caret
movement: the first ↑ walks the caret up (or to 0), the next one leaves. The
cost is one extra press when leaving upward from the top visual line, which is
the same cost ← already has at the start of a name.

`nextCell` learns one new fact — `Caret.multiline` — and `caretOf` is the only
place that answers it, from the element type. Single-line cells keep
unconditional row movement, because ↑ and ↓ do nothing to a one-line value and
filling an estimate column downwards is a thing people do forty times.

## Where a `\r` can actually come from

Not the keyboard. A `<textarea>`'s value normalises `\r\n` and `\r` to `\n` on
its way in, so nothing typed or pasted into this box can hold one.

It can come from be-01, which stores what an API client or another front end
sent it. The cell then shows a note that differs from the stored one as text
while meaning the same thing — and every focus-and-leave of that row would be a
patch nobody typed, broadcast to everyone. `normalizeNewlines` on both sides of
the diff is what makes that a no-op, and the empty-patch return is what keeps
an empty `{}` off the wire. Both were watched failing on the same test.

## What the Name column gives up

It joins `POPOVER_COLUMNS`, so it no longer clips. It is also a pinned column,
which nothing in the table has combined before: the pin decides where the cell
sits and the clip decides what may leave it, and the preview has to. The
structural backstop against a control painting into the next column is off for
this cell, and what holds instead is the same thing that holds for `depends`
and `team` — every control in it is `width: 100%` with `border-box` sizing,
asserted in `lets no control in a cell assert a width of its own` and measured
in a browser by `keeps every control inside the cell it belongs to`.
