## ADDED Requirements

### Requirement: A work item's status is unknown, in progress or done, and is never stored

Every work item SHALL report a `status` of `unknown`, `in_progress` or `done`, folded on read
from its steps' progress — `done` when every step with work on it says so, `unknown` when no
step has said anything, `in_progress` for every disagreement — and, for a parent, from its
children's statuses. The value SHALL never be stored on the row. `unknown` replaces the former
`not_started` on the wire, in `@wbs/domain` and in every reader; no row ever held the old
value, so no migration accompanies the rename.

#### Scenario: a leaf nobody has spoken about is unknown

- **GIVEN** a leaf with an estimate on `Dev` and no progress statement on any step
- **WHEN** the plan is read
- **THEN** the leaf reports `status: 'unknown'` and its `progress` object is empty

#### Scenario: one silent step keeps a leaf in progress

- **GIVEN** a leaf whose `Dev` says `done` and whose `QA` holds an estimate and no statement
- **WHEN** the plan is read
- **THEN** the leaf reports `status: 'in_progress'`

#### Scenario: a parent reads its children's fold

- **GIVEN** a parent with two leaves, both reporting `done`
- **WHEN** the plan is read
- **THEN** the parent reports `status: 'done'`, and `in_progress` the moment one leaf reports
  anything else

### Requirement: A work item's status is set to done or unknown as one act

A project SHALL accept one plan command, `setStatus`, carrying a work item, a `status` of
`done` or `unknown`, and an optional `on` date. For a leaf, `done` SHALL write `done` on every
step of the project for that leaf; for a parent, on every step of every leaf beneath it. For a
leaf, `unknown` SHALL take away every progress statement the leaf holds; for a parent, every
statement every leaf beneath it holds. Steps already reading the asked-for state SHALL NOT be
rewritten. The command SHALL be journalled as one entry whose inverse restores every prior
statement and every prior fact end verbatim, SHALL bump the revision of exactly the work items
it wrote, and SHALL announce one tree change. When nothing would change, nothing SHALL be
written, journalled or announced. `in_progress` SHALL NOT be accepted: it is a step's
statement and has its own command.

#### Scenario: marking a two-step leaf done writes both steps

- **GIVEN** a project holding `Dev` and `QA`, and a leaf estimated on `Dev` only
- **WHEN** `setStatus` marks the leaf `done`
- **THEN** the leaf's `progress` reads `{ Dev: 'done', QA: 'done' }` and its `status` is `done`

#### Scenario: marking a parent done speaks for every leaf beneath

- **GIVEN** a parent with three leaves, one of them already `done` on every step
- **WHEN** `setStatus` marks the parent `done`
- **THEN** the two other leaves gain `done` on every step, the already-done leaf is not
  rewritten, the parent reports `done`, and one journal entry holds the act

#### Scenario: one undo puts every statement back

- **GIVEN** a parent whose leaves held `{ Dev: 'in_progress' }`, `{}` and `{ Dev: 'done', QA:
'done' }` before it was marked `done`
- **WHEN** the actor undoes once
- **THEN** each leaf holds exactly the statements it held before, and each fact end this act
  filled is `null` again

#### Scenario: a second press writes nothing

- **GIVEN** a leaf already `done` on every step with a fact end
- **WHEN** `setStatus` marks it `done` again
- **THEN** no journal entry is added, no revision moves and no tree change is announced

#### Scenario: unknown takes the statements away and leaves the facts

- **GIVEN** a done leaf with a fact start and a fact end
- **WHEN** `setStatus` sets it `unknown`
- **THEN** its `progress` is empty, its `status` is `unknown`, and both fact dates are what they
  were

#### Scenario: the value is guarded where the shape is not

- **GIVEN** a `setStatus` command whose `status` is `in_progress`, `finished` or `7`
- **WHEN** it reaches the commands route
- **THEN** it is refused `400 invalid_status` before any service runs; an `on` that is not an
  `IsoDate` is refused `400 on_must_be_a_date`

### Requirement: A work item carries a fact start and a fact end, date-only, on any row

Every work item SHALL carry `factStart` and `factEnd`: nullable, date-only `IsoDate`, with no
time of day and no zone, stored as `work_item.fact_start` and `work_item.fact_end`. Both SHALL
join the work-item patch as nullable dates validated at the route — a non-date refused `400
fact_start_must_be_a_date` / `fact_end_must_be_a_date`, `null` clearing — on any work item,
leaf or parent, never handed down when a leaf gains a child and never folded. Both SHALL ride
the existing `patch` journal entry and its undo, with no new step kind. A duplicate SHALL copy
neither. Saved plans SHALL hold neither. The JSON export SHALL carry both and the status
through the shared work-item shape, and the table's spreadsheet export SHALL carry all three
as columns. Every work item existing before this change SHALL report both as `null`.

#### Scenario: a fact end is written, read and undone as an ordinary field

- **GIVEN** a leaf with `factEnd: null`
- **WHEN** it is patched with `factEnd: '2026-09-12'`, then the edit is undone
- **THEN** the read reports `'2026-09-12'` after the patch and `null` after the undo, through
  the same `patch` entry every other field uses

#### Scenario: a non-date is refused at the boundary

- **GIVEN** a patch with `factStart: 'yesterday'`
- **WHEN** it reaches the commands route
- **THEN** it is refused `400 fact_start_must_be_a_date` and no row is written

#### Scenario: a duplicate has not happened

- **GIVEN** a done leaf with both fact dates
- **WHEN** its subtree is duplicated
- **THEN** the copy reports `factStart: null`, `factEnd: null` and `status: 'unknown'`

#### Scenario: an undo of a delete puts the facts back

- **GIVEN** a leaf with both fact dates that is deleted
- **WHEN** the delete is undone
- **THEN** the restored row reports both dates as they were

### Requirement: Marking done fills an empty fact end with the day of the act

Marking a work item `done` SHALL fill the fact end of every work item the act writes — the
leaves and, for a parent, the parent itself — whose `factEnd` is `null` with `on`; `on`
absent, be-01 SHALL take the calendar day of the act's own write stamp in UTC. A stored fact
end SHALL NOT be overwritten. fe-01 SHALL always send `on` as the reader's local calendar day.
`unknown` SHALL leave both fact dates untouched. The fill SHALL be part of the same journal
entry, so one undo takes it away with the statements.

#### Scenario: a typed fact end survives the mark

- **GIVEN** a leaf whose fact end reads `2026-09-10`
- **WHEN** it is marked `done` with `on: '2026-09-12'`
- **THEN** its fact end still reads `2026-09-10`

#### Scenario: be-01 supplies the day when the client does not

- **GIVEN** a clock whose act stamps `2026-09-12T23:30:00Z`
- **WHEN** a leaf with no fact end is marked `done` with no `on`
- **THEN** its fact end reads `2026-09-12`

#### Scenario: the reader's day wins over the server's

- **GIVEN** a browser whose local day is `2026-09-13` while UTC is still `2026-09-12`
- **WHEN** the Status cell marks a leaf done
- **THEN** the command carries `on: '2026-09-13'` and the fact end reads `2026-09-13`

### Requirement: The table shows Status, Fact start and Fact end, and strikes a done row

The table SHALL offer three columns — `Status`, `Fact start`, `Fact end` — hidden by default
and offered in the Columns control in table order after `Deadline`. The Status cell SHALL show
the row's status in words and offer `Unknown` and `Done` to choose, on a parent as on a leaf;
`In progress` SHALL be shown but not offered. The two fact cells SHALL be date cells with the
deadline cell's rest and edit states. A row whose status is `done` SHALL carry `data-row-done`
and its name SHALL read struck through, on every stripe and under every row light.

#### Scenario: the Columns control offers the three in order

- **GIVEN** the Columns control open on a two-step plan
- **WHEN** its entries are read
- **THEN** `Status`, `Fact start`, `Fact end` follow `Deadline` in that order, and none of the
  three is on screen until chosen

#### Scenario: choosing Done marks the row and fills the fact end

- **GIVEN** a leaf reading `Unknown` with the three columns shown
- **WHEN** `Done` is chosen in its Status cell
- **THEN** the row reads `Done`, its name is struck through, and its Fact end cell reads today

#### Scenario: a partly done row reads In progress and can still be finished

- **GIVEN** a leaf whose `Dev` says `done` and whose `QA` says nothing
- **WHEN** its Status cell is read and then opened
- **THEN** it reads `In progress`, and the list offers `Unknown` and `Done` only

### Requirement: A done work item draws one done bar over its fact span

On the Gantt panel a leaf whose status is `done` SHALL draw one bar in place of its slices: it
SHALL stop at the end of its fact end's day and start at its fact start's day, or where its
first slice started when it has no fact start; a start at or after the stop SHALL be drawn as
the one day the fact end names. Absent a fact end, the done bar SHALL span the leaf's slices.
On a plan with no start date the done bar SHALL span the leaf's slices unclipped. The done bar
SHALL be marked as done in paint, in its `aria-label` and in `data-done`, SHALL NOT reuse the
assumed span's dotted translucent signature, SHALL answer for every slice id of its leaf so
person and capacity links still find it, and dependency arrows leaving the leaf SHALL leave the
done bar's stop. A parent's bracket SHALL stay be-01's projection.

#### Scenario: the estimate reaches past the fact and the bar does not

- **GIVEN** a done leaf whose slices run workdays 8→15 and whose fact end is the day of
  workday 11
- **WHEN** the chart is laid out
- **THEN** one bar is drawn for the leaf, starting at 8 and stopping at the end of workday 11,
  and no bar for the leaf reaches 15

#### Scenario: a plan that drifted past the fact still draws the fact

- **GIVEN** a done leaf whose slices run workdays 20→25 and whose fact end is the day of
  workday 11, with no fact start
- **WHEN** the chart is laid out
- **THEN** the leaf draws one bar covering exactly workday 11

#### Scenario: a fact start moves the bar's start

- **GIVEN** a done leaf whose slices run workdays 8→15, fact start on workday 6, fact end on
  workday 11
- **WHEN** the chart is laid out
- **THEN** the bar runs 6→12 (the stop of workday 11)

#### Scenario: the arrow leaves the done bar

- **GIVEN** a done leaf clipped to workday 11 with a successor waiting on it
- **WHEN** the arrows are laid out
- **THEN** the arrow's `fromFinish` is the done bar's stop, not the slice's 15

#### Scenario: a person link still finds the done bar

- **GIVEN** a done leaf whose `QA` slice was somebody's resource predecessor
- **WHEN** the person links are laid out
- **THEN** the link is drawn from the done bar and none is dropped

#### Scenario: the done bar is not the assumed span

- **GIVEN** a done leaf whose slices were unestimated
- **WHEN** its bar is painted
- **THEN** it carries `data-done="true"`, no `data-assumed`, a solid stroke and the done mark
