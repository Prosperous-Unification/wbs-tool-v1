## ADDED Requirements

### Requirement: Every row says its status at its left edge

Every row of the table SHALL carry `data-row-status` holding its status, and SHALL draw a
status strip at its left edge, before the drag handle, whether or not the Status column is
shown: no strip for `unknown`, the in-progress colour for `in_progress`, the done colour for
`done`. The strip SHALL be painted with `box-shadow` on the drag cell and SHALL move no
pixel of the layout. A row whose status is `done` SHALL additionally be tinted with the done
colour across every cell, pinned cells included, under the band, the hover, the dependency
light and the drop light rather than in place of them. The two colours SHALL be palette
tokens defined for both themes.

#### Scenario: a done row wears the strip and the tint with its column hidden

- **GIVEN** a plan with the Status column hidden and one leaf whose every step says `done`
- **WHEN** the table is rendered
- **THEN** that row carries `data-row-status="done"`, its drag cell paints the strip, every
  cell of it paints the done tint, and the row above it carries `data-row-status="unknown"`
  with no strip and no tint

#### Scenario: an in-progress row wears the strip and no tint

- **GIVEN** a leaf whose `Dev` says `done` and whose `QA` says nothing
- **WHEN** the table is rendered
- **THEN** the row carries `data-row-status="in_progress"`, its drag cell paints the
  in-progress strip, and no cell of it paints the done tint

#### Scenario: the tint lets the lights through

- **GIVEN** a done row that some hovered Depends on cell waits for
- **WHEN** the row is painted
- **THEN** its cells carry the dependency light's `--cell-bg` and the done tint together, and
  the pinned cells paint the same pair as the unpinned ones

### Requirement: Choosing Done opens the completion prompt before anything is written

Choosing `Done` in the Status cell of a row whose status is not `done` SHALL open the
completion prompt and SHALL send nothing until it is confirmed. The prompt SHALL name the
row, SHALL hold one date field prefilled with the row's fact end when it holds one and with
the reader's local calendar day otherwise, SHALL offer `Cancel` and `Mark done`, and SHALL
put focus in the date field; on close, confirmed or dismissed, focus SHALL return to the
Status cell that asked. Confirming SHALL send `setStatus` with the field's day as `on`;
when the row already held a fact end and the field's day differs, a `patch` of `factEnd` to
the field's day SHALL follow. Cancel, Escape and a click outside SHALL close the prompt with
nothing sent and the status unchanged. A field holding no day or a day that is not an
`IsoDate` SHALL disable `Mark done`. Choosing `Unknown` SHALL open no prompt.

#### Scenario: today is offered and sent

- **GIVEN** a leaf reading `Unknown` with no fact end, on a browser whose local day is
  `2026-09-13`
- **WHEN** `Done` is chosen and the prompt confirmed unchanged
- **THEN** exactly one command was sent, `setStatus` with `on: '2026-09-13'`, and the row reads
  `Done`

#### Scenario: another day is typed

- **GIVEN** the same leaf
- **WHEN** `Done` is chosen, the field changed to `2026-09-10`, and the prompt confirmed
- **THEN** `setStatus` carries `on: '2026-09-10'` and the Fact end cell reads that day

#### Scenario: a held fact end is offered, and a change to it follows as a patch

- **GIVEN** a leaf reading `In progress` whose fact end is `2026-09-10`
- **WHEN** `Done` is chosen, the field changed to `2026-09-11`, and the prompt confirmed
- **THEN** `setStatus` with `on: '2026-09-11'` is sent, then `patchWorkItem` with `factEnd:
'2026-09-11'`, in that order

#### Scenario: cancelling writes nothing

- **GIVEN** a leaf reading `Unknown`
- **WHEN** `Done` is chosen and the prompt dismissed by Cancel, by Escape, or by a click outside
- **THEN** no command is sent, the row still reads `Unknown`, and focus is back in the Status
  cell

#### Scenario: a parent's prompt speaks for its leaves

- **GIVEN** a parent reading `In progress`
- **WHEN** `Done` is chosen and the prompt confirmed with `2026-09-12`
- **THEN** one `setStatus` for the parent carries `on: '2026-09-12'`, and every leaf beneath
  it with no fact end reads that day

### Requirement: The Status column is one glyph, pinned after the number

The Status column SHALL sit after `#` and before Links, SHALL be a member of the pinned
block between them, and SHALL be 28px wide. Its heading SHALL be the `○` glyph with the
accessible name `Status`. Its cell SHALL show `○` for `unknown`, `◐` for `in_progress` and
`✓` for `done`, coloured as the strip is, its accessible name naming the row (`Status of 010`)
and its `title` saying the status in words; the picker SHALL keep offering `Unknown` and
`Done` in words. The status itself SHALL be readable off `data-status-value`. The column SHALL stay
hidden by default and SHALL be offered in the Columns control as `Status`, after `Deadline`
as before.

#### Scenario: the pinned block holds Status in its place

- **GIVEN** the Status column shown
- **WHEN** the frame is laid out
- **THEN** the pinned columns are `drag`, `number`, `status`, `refs`, `name` in that order, and
  the `refs` and `name` offsets are 28px further right than with Status hidden

#### Scenario: the cell reads as a glyph and says the word

- **GIVEN** a done leaf `010` with the Status column shown
- **WHEN** its Status cell is read
- **THEN** the cell shows `✓`, its title is `Done`, `data-status-value` is `done`, and opening it
  lists `Unknown` and `Done`

## MODIFIED Requirements

### Requirement: Marking done fills an empty fact end with the day of the act

Marking a work item `done` SHALL fill the fact end of every work item the act writes — the
leaves and, for a parent, the parent itself — whose `factEnd` is `null` with `on`; `on`
absent, be-01 SHALL take the calendar day of the act's own write stamp in UTC. A stored fact
end SHALL NOT be overwritten by the fill. fe-01 SHALL always send `on` as the day the
completion prompt confirmed. Setting `unknown` SHALL set `factEnd` to `null` on every work
item in scope — the leaves and, for a parent, the parent itself — whose status read `done`
before the act, and SHALL leave every other fact date untouched. The fill and the clear SHALL
be part of the same journal entry as the statements, so one undo takes them away together.

#### Scenario: a typed fact end survives the mark

- **GIVEN** a leaf whose fact end reads `2026-09-10`
- **WHEN** it is marked `done` with `on: '2026-09-12'`
- **THEN** its fact end still reads `2026-09-10`

#### Scenario: be-01 supplies the day when the client does not

- **GIVEN** a clock whose act stamps `2026-09-12T23:30:00Z`
- **WHEN** a leaf with no fact end is marked `done` with no `on`
- **THEN** its fact end reads `2026-09-12`

#### Scenario: leaving done takes the fact end away, and undo puts it back

- **GIVEN** a done leaf whose fact end reads `2026-09-12` and whose fact start reads
  `2026-09-08`
- **WHEN** `setStatus` sets it `unknown`, then the actor undoes once
- **THEN** after the act its `progress` is empty, its fact end is `null` and its fact start is
  `2026-09-08`; after the undo every statement and the fact end `2026-09-12` are back, from one
  journal entry

#### Scenario: a parent's unknown clears only what read done

- **GIVEN** an in-progress parent with a typed fact end `2026-09-12` over two leaves, one done
  with fact end `2026-09-11`, one in progress whose fact end was typed as `2026-09-09`
- **WHEN** `setStatus` sets the parent `unknown`
- **THEN** the done leaf's fact end is `null`, and the parent's `2026-09-12` and the other
  leaf's `2026-09-09` stand

#### Scenario: a done parent's unknown clears the parent and every leaf, and one undo restores them

- **GIVEN** a parent marked `done` on `2026-09-12`, so it and both leaves hold that fact end
- **WHEN** `setStatus` sets the parent `unknown`, then the actor undoes once
- **THEN** all three fact ends are `null` after the act and `2026-09-12` again after the undo,
  and the act added one journal entry

#### Scenario: unknown on a row that was not done leaves the facts

- **GIVEN** an in-progress leaf with a typed fact end
- **WHEN** `setStatus` sets it `unknown`
- **THEN** its `progress` is empty and its fact end is what it was

### Requirement: The table shows Status, Fact start and Fact end, and strikes a done row

The table SHALL offer three columns — `Status`, `Fact start`, `Fact end` — hidden by default
and offered in the Columns control in table order after `Deadline`. The Status cell SHALL show
the row's status as a glyph with the word as its title and offer `Unknown` and
`Done` to choose, on a parent as on a leaf; `In progress` SHALL be shown but not offered. The
two fact cells SHALL be date cells with the deadline cell's rest and edit states. A row whose
status is `done` SHALL carry `data-row-done` and its name and number SHALL read struck
through, on every stripe and under every row light.

#### Scenario: the Columns control offers the three in order

- **GIVEN** the Columns control open on a two-step plan
- **WHEN** its entries are read
- **THEN** `Status`, `Fact start`, `Fact end` follow `Deadline` in that order, and none of the
  three is on screen until chosen

#### Scenario: choosing Done marks the row and fills the fact end

- **GIVEN** a leaf reading `Unknown` with the three columns shown
- **WHEN** `Done` is chosen in its Status cell and the completion prompt confirmed unchanged
- **THEN** the row reads `Done`, its name is struck through, and its Fact end cell reads today

#### Scenario: a partly done row reads In progress and can still be finished

- **GIVEN** a leaf whose `Dev` says `done` and whose `QA` says nothing
- **WHEN** its Status cell is read and then opened
- **THEN** it shows `◐` titled `In progress`, and the list offers `Unknown` and `Done` only
