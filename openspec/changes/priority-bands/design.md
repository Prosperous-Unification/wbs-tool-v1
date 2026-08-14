# design — `priority-bands`

The written source is Dany's R9, captured verbatim in
`notes/wbs-scope-2026-08-13-wave6.md` and quoted in full in `proposal.md`. The
shape is `capacity-per-project`'s (C5) and was chosen as such: a per-project
configuration table with a seeded default, read by every face, edited from the
plan's own toolbar. This file is about the seven places that pattern had to be
departed from, and why.

## D1 — a band is a start value, not a range

Dany wrote ranges — _"1-20 are critical, 21-40 are high"_ — and the table stores
**starts**. The band above is what ends a band, and the top band ends nowhere.

The alternative is the literal transcription: `(low, high)` per band, free to be
anything. It is rejected because it admits two states that Dany's sentence does
not contain and that no face can draw:

- **a gap.** `1-20` and `22-40` leaves priority 21 with no label. What does the
  Prio cell paint? What does the export write? Every reader would need a "no
  band" arm, on every face, for a state that is a typo.
- **an overlap.** `1-20` and `18-40` gives priority 19 two labels, and
  `priorityBandRankOf` would have to pick one — which is a rule nothing states.

Contiguous-and-exhaustive-by-construction means neither state is
representable. The cost is that a reader thinks in ranges and the store holds
starts, and that cost is paid in one place: the `Priorities` dialog computes
`1 to 20` from the next rung's start and redraws it as the boxes change, so the
two bands either side of a moved cut are both visible while it moves (D5).

`priorityBandRankOf` is therefore **total**: the last band whose start is at or
below the number. It is a function with no failure case, and that is what lets
every face call it in a render without an arm for "this number has no band".

**Rejected: storing ranges and validating contiguity.** It is the same
invariant enforced twice — once by the validator and once by every reader's
`?? 'unbanded'` — with a stored representation that can express the thing the
validator refuses. One spelling of one fact is R2.

## D2 — the seeding is a materialisation, and the read is the contract

Every existing project gets five rows. A project holding **no** rows reads as
`DEFAULT_PRIORITY_BANDS`.

Both, and the pair is the decision. C5's D1 refused exactly this shape one fact
along — a per-project row with a global number behind it — on Dany's second
sentence, _"The global number should not matter"_. That objection does not reach
here, and the difference is what the fallback **is**:

- C5's fallback was `serviceTeam.size`: a number somebody typed on a screen, for
  a different plan, invisible from the plan it would have bounded. A plan
  silently bounded by it was bounded by a decision made elsewhere.
- This fallback is `DEFAULT_PRIORITY_BANDS`: a constant in `libs/domain`, the
  same five for every project on the deployment, editable by nobody. Reading it
  back is the source saying what a priority ladder is when nobody has said
  otherwise.

So there is exactly one observable rule — **every project's ladder is its five
rows, or Dany's five** — and the seeding changes nothing about it. That is why
the seeding's test asserts **rows** and not behaviour: with the whole
`INSERT … SELECT` struck out, every behavioural test in be-01 stays green and
`seeds every project that existed with the five default bands` fails on
`Expected length: 15, Received length: 0`. Watched.

**What the seeding is for**, then, since it is not for behaviour: the
deployment's real projects hold their vocabulary as data somebody can read out
of the database, diff between two projects, and edit one rung of. An absence
that means five things is a row nobody can find.

**What the fallback is for**: the blue/green swap window, and every project
created after it. C5's "Deployment" section had to name a hole here — the
outgoing release creates a project, green schedules it unconstrained, dates move
with nobody having edited a capacity. The same window exists for this table and
has no hole in it, because a project with no bands reads exactly as a project
with the seeded ones.

**Rejected: seeding at project create.** It would make a project's ladder depend
on when it was created, which is C5's D1 objection in its own words — and with
the read's default arm in place it buys nothing at all.

**Rejected: no seeding, fallback only.** Defensible, and it loses the paragraph
above: the ladder would exist nowhere a reader could look until somebody edited
one.

## D3 — five rungs, and the count is not configurable

Dany said _"all this needs to be configurable by project"_. What a project may
change: **every label, every cut, every default value**. What it may not:
**how many rungs there are.** `PUT` refuses a body of four or six with
`bands_must_number_5`.

This is a refusal, not an oversight, and it is the smallest thing that honours
the sentence. Dany enumerated three things and asked for all three; he did not
ask for a sixth rung. Refusing the count buys:

- **`rank` is a number from 0 to 4**, and every face keys its colour off it. A
  variable count needs a colour ramp of variable length, which is a design
  decision Dany has explicitly deferred ("colour strategy will be revisited once
  he can see it").
- **no insert, delete or renumber path.** The write is a whole-ladder replace
  (D4) and the primary key is `(project, rank)`; a variable count adds a
  reordering problem and a "what happens to rank 5's rows" question.
- **no empty ladder to render.** Every face's absence-arm is `null` for an
  unprioritised *work item*, and never for a project with no rungs.

**What it costs, stated rather than discovered:** a project that wants four
meaningful bands has to spend the fifth on something. It can — `Never` starting
at 900 is a rung nothing lands in — and it is uglier than deleting one. If Dany
asks for the count, the change is a `rank` renumber and a longer colour ramp,
and this paragraph is the argument to re-read.

## D4 — the write is the whole ladder, and the dialog holds its drafts

`PUT /api/projects/:id/priority-bands` takes five bands. There is no
per-band route.

C5's capacity write is per pair — `PUT …/teams/:teamId/capacity`, one number —
and `TeamsDialog` commits per box on blur. Copying that here is wrong twice
over:

1. **Contiguity is a fact about the five together.** A per-rung write would have
   to accept, store and serve states in which the ladder is not one: a fourth
   band starting below the third, a default outside its own band. A reader on
   another screen redraws from the payload and would draw one of them.
2. **Every intermediate state a person types through is invalid.** Moving `High`
   from 21 down to 15 is not a ladder until `Medium` moves too. A dialog
   committing per box would refuse the first keystroke of every re-cut.

So the drafts are held in the dialog and **Save** sends the whole ladder once,
and the store's `replace` is delete-then-insert inside one transaction. The
ladder that arrives is the ladder that is stored, so a project holding five rows
and a project holding none end in the same state from the same request — which
is what lets D2's read arm and a real write agree about what a ladder is.

The cost: a reader who types one rung and closes the dialog without saving loses
it. That is the ordinary shape of a form with a Save button, and it is the
trade a fact with a five-row invariant forces.

## D5 — the ladder is typed in a `Priorities` dialog beside `Teams`

C5 established the precedent one button along and argued it at length (its D5):
a project's own configuration is edited from the plan's toolbar, in a dialog
whose **trigger** lives in the component because Radix restores focus to the
trigger and to nothing without one. A ladder is the same class of fact and gets
the same treatment.

Rejected: **the directory page.** It has no project, and C5 already made this
mistake with the team size box and moved it.

Rejected: **the Prio column header.** A popover off a 48px header is the
smallest surface in the app for the widest configuration in it, and a
configuration reached only from a column is one nobody finds on a phone.

One thing the dialog does that C5's does not: it prints the **range** each start
amounts to, recomputed from the drafts as they are typed. D1 makes the store
hold starts and the reader think in ranges, and this is where that gap is paid.

## D6 — the cell takes a number or a name, through one commit path

Dany: _"I want to be able to easily select priority by labels **or** input a
number manually"_. Both, in one 48px box:

- **a typed number** is the number, exactly as before this change;
- **a typed band name** — trimmed, case-insensitive — is that band's own
  `defaultValue`;
- **a line taken from the list a click opens** sends the same
  `defaultValue`.

All three go through `setPriority`, so all three are one `PATCH`, one journal
entry and one undo. That is what makes the two languages round-trip into each
other rather than into two histories: `Medium` stores 50, the cell reads 50 back,
and 50 resolves to `Medium`.

The label is resolved **before** the number, which decides one real case: a
project that renames a rung to `7` has a name that is also a number, and the
name wins. Stated because nothing prevents it.

Anything that is neither is handed back verbatim to `setPriority`, which has
refused it out loud since `priority-column` — `Number('urgent')` is `NaN`, `NaN`
on the wire is `null`, and `null` is the clear, so a typo would otherwise
silently unprioritise the row.

**The list opens on a click, not on the focus**, and this is the one place the
component departs from `CreatablePicker`. Two reasons, and the second was found
rather than designed:

- the grid is walked with the arrow keys and this cell's common case is typing a
  digit, so a list that appeared every time the caret landed would be a popover
  over the rows below on every pass across a row;
- opening on focus is a `setState` **during** the focus that lands in the box, so
  `CellInput`'s inline `ref` callback runs again, `LiveField.takeNode`
  re-attaches, and a refusal held for that cell is written back over the draft
  somebody is part-way through typing. Three existing cases in
  `the priority cell` caught it — `sends what was typed on Enter` came back with
  no request at all. Watched; R5 #17.

The keyboard's way to the five names is to type one. Neither pointer nor
keyboard is left without Dany's "select by labels", and neither is made to walk
past a popover to type a number.

## D7 — one function decides how a band looks, and it is keyed on the rank

`priorityBandStyleOf(bands, priority)` in
`apps/fe-01/src/components/wbs/priority-band-style.ts`, and there is no second
opinion anywhere. It answers a label, a rank, an ink, a tint and a sentence, or
`null` for an unprioritised work item. Four faces read it:

| face | what it draws | why that channel |
| --- | --- | --- |
| the table's Prio cell | the digits in the band's ink, semibold | the column is 48px of right-aligned digits between two bordered cells; a filled swatch there reads as a selection |
| the chart's bars | a 3px cap at the bar's left edge, in the band's ink | `fill` is already the assignee and `stroke` is the critical path — the band gets a **third** mark rather than a repaint of either, so no two facts share a colour |
| the plan cards | a chip in the header: the name, the number, the ink on the tint | a phone shows no table and no chart, so this is the only face some readers have |
| the export | a `Priority band` column beside `Priority` | a CSV has no colour, so it takes the label alone — beside the number and not instead of it, because two rows at 10 and 18 are both `Critical` and are not the same priority |

**Keyed on the rank and never on the label**, because a project may rename
`Critical` to `Blocker` and a colour that followed the word would follow it out
of the ladder.

**Not in the geometry.** `layOutGantt` does not read the ladder and no
coordinate depends on a priority; the cap is resolved at paint time. Dany has
said the colours will be revisited once he can see them, and that is exactly why
they are five entries in one array behind one function: changing them is editing
that table, and no face has an opinion of its own to update.

Unprioritised is **nothing at all** on every face — no chip, no cap, no grey
`—`. That bargain predates this change (the Prio cell's blank at rest, the bar's
absent priority line) and is kept.

## D8 — the differential the corpus could not make, and the plan that could

The promise: **a ladder moves no date.** Priority already drives the leveller's
queue, so this is the claim the whole change rests on — a ladder that could reach
a date would be a scheduling change wearing a presentation change's clothes.

The obvious differential is C5's: replay its sixteen captured plans through this
branch's service and assert every field of every work item and every slice.
`priority-band-identity.test.ts` does that **twice** — once with the ladder the
migration seeds, once with a ladder re-cut so every priority in the corpus
changes its name — and both come back byte-identical to what be-01 answered at
`050fd45`.

**And neither replay can see the fault they are for.** Every priority in that
corpus is 1, 2, 3 or 4, so all 26 of them sit in the default ladder's first band:
a build that ordered on the *band* instead of the number collapses them to one
rank and still answers identically. Measured rather than supposed — the ladder
wired into `slicesOf` and `schedule` gives **4 pass / 0 fail** against the corpus
alone. Watched 2026-08-14.

So the file carries a third case: one project, one role, one person, two
independent leaves, no dependencies and no pool — a plan in which the two
priorities are the **only** thing deciding the order. It is measured three ways:
under the default ladder, under a re-cut one, and with the two numbers swapped.
The third is the control, and it is a control over the **dates** rather than over
the payload: comparing whole payloads is satisfied by the stored priorities being
different and says nothing about whether anything moved. That mistake was in the
first version of this test and is why the comparison is narrowed to each row's
placement and every slice.

With that case present, the ladder wired into the leveller gives **4 pass / 1
fail**, on slice `bdev` coming back at `earliestStart: 3` behind `adev` where 0
was owed. R5 #10.

## Plan versus reality

| the ask said | what is true | what shipped |
| --- | --- | --- |
| `1-20 are critical, 21-40 are high…` — ranges | a stored range can gap and can overlap, and a priority that resolves to no label or to two is undrawable | bands are **starts**; the one above ends the one below, and the ranges are computed for the reader in the dialog. D1 |
| "all this needs to be configurable by project" | the labels, the cuts and the defaults are three things; the count is a fourth nobody asked for | labels, cuts and defaults are the project's; five rungs is refused with `bands_must_number_5`, and what that buys is written down. D3 |
| C5's shape, so C5's per-fact write | contiguity is a fact about five rows together, and every re-cut types through invalid states | one `PUT` of the whole ladder, and a dialog that holds its drafts until Save. D4 |
| C5's shape, so C5's no-fallback read | C5 refused a fallback to a **number somebody typed elsewhere**; this one is a constant in the source | a project holding no rows reads as `DEFAULT_PRIORITY_BANDS`, and the seeding is a materialisation with no observable effect. D2 |
| an identity differential against C5's sixteen plans | every priority in that corpus is 1–4, so all of them are one band and the differential is blind to the fault it is for | the corpus replayed twice **plus** a contended plan whose order priority alone decides, with a control on the dates. D8 |
