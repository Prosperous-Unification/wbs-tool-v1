## ADDED Requirements

### Requirement: A project arranges every sibling group by the schedule it draws

A project SHALL accept one plan command, `arrangeBySchedule`, that rewrites the positions of
every sibling group — roots and every parent's children, at every depth — so that siblings
read in ascending order of their projection's earliest start in the schedule the plan read
draws. Two siblings with equal starts SHALL keep the order they read in before the command.
No work item SHALL change parent. Groups already in that order SHALL not be written.

#### Scenario: roots out of schedule order are put in it

- **GIVEN** roots `010` and `020`, and `020` starts on day 0 while `010` waits for a
  predecessor and starts on day 5
- **WHEN** `arrangeBySchedule` runs
- **THEN** the former `020` reads as `010` and the former `010` as `020`
- **AND** the read's rows are in the order the chart's bars start

#### Scenario: a nested group is arranged under a parent that also moves

- **GIVEN** a parent whose two children start on days 4 and 2 in that order, and a sibling
  root starting on day 3
- **WHEN** the command runs
- **THEN** the children read as day 2 then day 4
- **AND** the parent reads before the root, because a parent's start is the least of its
  leaves' — day 2, before the root's day 3

#### Scenario: equal starts keep their order

- **GIVEN** three roots all starting on day 0, read as A, B, C
- **WHEN** the command runs
- **THEN** they still read A, B, C and nothing is written

#### Scenario: the arrangement follows the displayed optimized variant when it is ready

- **GIVEN** a project displaying `pri` whose `pri` variant is `ready` and orders two roots
  the other way round from Fast
- **WHEN** the command runs
- **THEN** the rows read in the `pri` order

#### Scenario: a pending optimized variant means the arrangement is by Fast

- **GIVEN** a project displaying `pri` whose `pri` variant is not `ready`
- **WHEN** the command runs
- **THEN** the rows read in Fast's order, which is what the read was drawing

#### Scenario: a plan with a dependency cycle is refused

- **GIVEN** a project whose read reports `scheduleError: 'cycle'`
- **WHEN** the command runs
- **THEN** it is refused with reason `cycle` and nothing is written

#### Scenario: a second press moves nothing

- **GIVEN** a project just arranged, re-read and rescheduled by Fast
- **WHEN** the command runs again
- **THEN** no group changes and no journal entry is added

### Requirement: A frozen work item keeps its place among its siblings

When a sibling group holds frozen work items, each frozen work item SHALL keep its current
place in the group and the unfrozen siblings SHALL take the remaining places in schedule
order. A frozen work item's number SHALL be unchanged by the command.

#### Scenario: a frozen middle row stays in the middle

- **GIVEN** roots A (day 6), B frozen as `020` (day 9), C (day 0)
- **WHEN** the command runs
- **THEN** the rows read C, B, A, and B is still `020`

#### Scenario: a plan with every row frozen is unchanged

- **GIVEN** a project where every work item carries a frozen number
- **WHEN** the command runs
- **THEN** it lands, nothing is written and no journal entry is added

### Requirement: An arrangement is one act to undo

The command SHALL be journalled as one entry whose inverse restores the exact prior positions
of every work item in a group that changed, SHALL announce one `tree_replaced`, and SHALL
bump the revision of exactly the work items whose place changed. Undo SHALL be refused, in
the existing wording, when such a work item has changed, been deleted or been frozen since.

#### Scenario: undo puts every row back where it was

- **GIVEN** an arrangement that changed two groups
- **WHEN** the actor undoes once
- **THEN** every work item has the position it had before the press, and the read's order is
  the pre-press order

#### Scenario: undo is refused once a moved row has been frozen

- **GIVEN** an arrangement that moved row X, and X frozen afterwards
- **WHEN** the actor undoes
- **THEN** the undo is refused with `stale_undo` and the entry is discarded

#### Scenario: rows the arrangement did not move keep their revision

- **GIVEN** a group already in order and a group that changes
- **WHEN** the command runs
- **THEN** rows in the unchanged group have their previous revision
- **AND** a peer's pending undo on one of them still applies

### Requirement: The plan toolbar offers the arrangement as one control

The plan toolbar SHALL offer a control named `Arrange by schedule` that issues the command
through the toolbar's one write path, is disabled with the busy affordance while a write is
in flight, carries a tool hint saying what it does, and on a plan with a dependency cycle is
disabled and carries a project fact saying why instead. On success it SHALL show one info
toast. The control SHALL appear in the phone toolbar sheet.

#### Scenario: the control arranges the table in a browser

- **GIVEN** a plan whose bottom root starts first
- **WHEN** the reader presses `Arrange by schedule`
- **THEN** that root is the first row, its number is `010`, and its bar is the leftmost

#### Scenario: a cycle turns the hint into a fact

- **GIVEN** a plan whose read reports a cycle
- **WHEN** the reader rests the pointer on the control
- **THEN** the control is disabled and shows a project fact naming the cycle, at once

#### Scenario: the toolbar stays inside its width budgets

- **GIVEN** the folded toolbar at 1280×900
- **WHEN** the control is on the bar
- **THEN** the bar's laid-out width is within the pinned budget recorded in `layout.spec.ts`
  and `project-settings.spec.ts`, each re-measured and written down in `verify.md`
