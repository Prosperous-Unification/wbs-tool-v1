## ADDED Requirements

### Requirement: A project says what its priority numbers are called, and every number has exactly one name

The system SHALL store, per project, five priority bands. A band SHALL be a
**start value**, a label, and the number choosing that label writes; the band
above it SHALL be what ends it, and the highest band SHALL end nowhere.

The lowest band SHALL start at 1 and each band SHALL start above the one below
it, so every priority of 1 or more SHALL resolve to exactly one band. A stored
ladder SHALL NOT be able to leave a number unnamed or give it two names.

A project that has stored no bands SHALL read as the default five — `Critical`
from 1 writing 10, `High` from 21 writing 30, `Medium` from 41 writing 50, `Low`
from 61 writing 70, `Lowest` from 81 writing 90. That default SHALL be a fact
about the system rather than a number anybody may set, so a project that has
stored bands and one that has not SHALL be indistinguishable on every face where
their ladders agree.

#### Scenario: every number in and around a cut resolves to one band

- **GIVEN** a project with the default ladder
- **WHEN** the priorities 20, 21, 80 and 81 are read
- **THEN** 20 SHALL be the most important band and 21 the one above it
- **AND** 80 SHALL be the fourth band and 81 the least important
- **AND** no priority of 1 or more SHALL resolve to no band

#### Scenario: a project that has configured nothing still names its priorities

- **GIVEN** a project created after this change, whose bands nobody has stored
- **WHEN** its plan is read
- **THEN** the plan SHALL carry the five default bands
- **AND** a work item at priority 10 SHALL be named the same as one on a project
  whose bands were stored

#### Scenario: one number is two names on two plans

- **GIVEN** two projects and one priority of 20
- **AND** the first project's ladder being the default and the second's second
  band starting at 16
- **WHEN** each plan is read
- **THEN** the first project SHALL name that priority with its first band
- **AND** the second project SHALL name it with its second

### Requirement: A priority band decides no date

A band SHALL be read by no code that computes a schedule. Changing a project's
bands — renaming one, moving a cut, or re-pointing the number a band writes —
SHALL move no date, no float and no placement in that project's plan or in any
other.

Applying this change SHALL leave every plan scheduling exactly as it did: every
field of every work item and every slice.

#### Scenario: re-cutting a ladder moves nothing

- **GIVEN** a plan whose order is decided by two work items' priorities
- **WHEN** the project's bands are replaced with bands that name both priorities
  differently
- **THEN** every work item SHALL be placed exactly where it was
- **AND** every slice SHALL start and finish exactly where it did

#### Scenario: the numbers still decide the order

- **GIVEN** the same plan
- **WHEN** the two work items' priorities are exchanged
- **THEN** the plan SHALL be placed differently

### Requirement: A project's bands may be written, all five at once, and only that project is told

The API SHALL accept exactly five bands for a project and SHALL refuse any other
number of them, so that a project may rename its bands, move their cuts and
change the numbers they write, and may not add or remove one.

A ladder SHALL be refused with 400, and SHALL write nothing, when its lowest band
does not start at 1, when any band does not start above the one below it, when
any band's start or written number is not a whole number of 1 or more, when a
band's written number falls outside that band, when two bands share a name, or
when a name is empty or longer than 40 characters.

A write SHALL be refused with 404 for a project that does not exist, and with 403
for a restricted project this account may not edit; both SHALL write nothing.

A write SHALL announce to **the project it names and no other**, so that a plan
open on another screen redraws its labels.

#### Scenario: a band that writes a number outside itself is refused

- **GIVEN** a project with the default ladder
- **WHEN** a client asks for a most-important band that writes 90
- **THEN** the request SHALL be refused with 400
- **AND** the project SHALL still hold the ladder it had

#### Scenario: a sixth band is refused

- **GIVEN** a project
- **WHEN** a client sends six bands
- **THEN** the request SHALL be refused with 400
- **AND** the project SHALL still hold five

#### Scenario: only the project named is told

- **GIVEN** two projects, both open on a screen
- **WHEN** one project's bands are written
- **THEN** that project SHALL be told to read again
- **AND** the other SHALL NOT be told

### Requirement: A priority is chosen by name or typed as a number, and both round-trip

The plan SHALL let a reader set a work item's priority either by choosing a band
by name or by typing a number, and both SHALL be one edit — one request, and one
step of undo.

Choosing a band SHALL store the number that band writes. Typing a band's name
SHALL store the same number, whatever its case and surrounding spaces. Reading a
stored number back SHALL name the band it falls in, so a priority chosen by name
and the same priority typed as a number SHALL be indistinguishable afterwards.

Text that is neither a number nor a band's name SHALL be refused out loud and
SHALL store nothing — in particular it SHALL NOT clear the work item's priority.

#### Scenario: a band chosen by name comes back as its own name

- **GIVEN** a work item with no priority, on a project with the default ladder
- **WHEN** the band that writes 30 is chosen for it
- **THEN** the work item's priority SHALL be 30
- **AND** the cell SHALL name that band

#### Scenario: a typo does not unprioritise the row

- **GIVEN** a work item at priority 7
- **WHEN** a word that is no band's name is typed into its priority
- **THEN** the change SHALL be refused with a sentence
- **AND** the work item SHALL still be at priority 7

### Requirement: Every face draws a priority in its band's own colour

A work item's priority SHALL be drawn so that two work items in different bands
look different, on the plan's table, on its chart, on its cards and in its
export. Bands SHALL be distinguished by their **position** in the ladder rather
than by their names, so that renaming a band SHALL NOT change how it is drawn.

A work item nobody has prioritised SHALL be drawn with no band mark at all,
rather than with a placeholder.

The chart's band mark SHALL take no pointer, no focus and no accessible name, so
that the bar it marks remains the only control there.

#### Scenario: two bands look different on the chart

- **GIVEN** a plan with one work item in the most important band and one in the
  least
- **WHEN** the chart is drawn
- **THEN** each of their bars SHALL carry a band mark
- **AND** the two marks SHALL be different colours

#### Scenario: an unprioritised row carries no band mark anywhere

- **GIVEN** a work item nobody has prioritised
- **WHEN** the plan is drawn
- **THEN** its bar SHALL carry no band mark
- **AND** its card SHALL carry no band chip
- **AND** its export row's band SHALL be blank

#### Scenario: the export names the band the plan it came from used

- **GIVEN** a project whose ladder names priority 10 differently from the default
- **WHEN** its plan is exported
- **THEN** the export SHALL name that project's band, beside the number itself
