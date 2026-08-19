## ADDED Requirements

### Requirement: The chart marks the day the reader is having

The chart SHALL mark the reader's current calendar day as a column of the
chart's own width, on the same scale as every gridline and every bar beside it,
so that a bar drawn across the mark reads as work begun and not finished.

The mark SHALL be read from the axis the chart is already drawn on rather than
computed a second time: the marker's column and the day cells SHALL be one
number, never two that agree only while nobody has touched either.

The day SHALL be the reader's own, in the reader's own zone. A conversion
through UTC is refused: east of Greenwich it names yesterday for the first hours
of every day, and west of it tomorrow for the last.

The mark SHALL carry its meaning in text as well as in colour — the axis cell
for today SHALL be marked `aria-current="date"` — so a reader who cannot see the
tint is told the same fact.

#### Scenario: today falls inside the plan

- **GIVEN** a plan whose span contains the reader's current day
- **THEN** that day is drawn as a column one day wide, with a leading edge, and
  its axis cell is marked as the current date

#### Scenario: today falls on a weekend

- **GIVEN** a plan whose span contains a Saturday that is the reader's current
  day
- **THEN** the mark stands in that weekend column, between the work either side
  of it, and the weekend band is drawn under it unchanged

### Requirement: The chart marks nothing when today is not on it

The chart SHALL draw no marker at all where the reader's current day is before
the plan's first drawn day, after its last, or where the chart has no calendar.
A marker clamped to either margin is refused: it would say the plan starts or
ends today, which is a statement the chart would be inventing.

Where a plan has no start date the chart is drawn on the workday axis, on which
nothing is a date; it SHALL therefore carry no marker, for the reason its hover
text carries workday offsets instead of days.

#### Scenario: today is before the plan begins

- **GIVEN** a plan whose first drawn day is after the reader's current day
- **THEN** no marker is drawn anywhere, and the chart is drawn in full

#### Scenario: the plan has no start date

- **GIVEN** a plan with no start date, drawn on the workday axis
- **THEN** no marker is drawn, whatever the reader's current day is
