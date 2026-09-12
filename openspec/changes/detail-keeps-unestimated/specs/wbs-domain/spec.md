## ADDED Requirements

### Requirement: The chart draws an unestimated slice whichever way the detail switch is set

The Gantt panel SHALL draw a bar for every placed slice, including one nobody has estimated,
in both states of the `Detail` switch. An unestimated slice's bar SHALL keep the marks that
say its span is a guess — the dashed stroke, the reduced fill and the `?` on its label — in
both states. The switch SHALL go on hiding the stored-dependency arrows and the parent rows'
summary brackets.

#### Scenario: an uncosted slice is drawn with the detail off

- **GIVEN** a plan with one estimated slice and one nobody has estimated
- **AND** the `Detail` switch is off
- **THEN** the uncosted slice is drawn as a bar carrying the assumed mark
- **AND** its label contains `?`

#### Scenario: the switch changes nothing about an uncosted slice

- **WHEN** the reader presses `Detail`
- **THEN** the uncosted slice's bar is drawn before and after the press
- **AND** the arrows and the summary brackets are drawn only while the switch is on

#### Scenario: a mark that hangs off an uncosted bar is drawn with it

- **GIVEN** a person hands off from an estimated slice to an uncosted one, and the uncosted
  work item carries a not-before date
- **AND** the `Detail` switch is off
- **THEN** the hand-off line onto the uncosted slice is drawn
- **AND** that work item's not-before caret is drawn

#### Scenario: a parent row still loses its caret with the switch off

- **GIVEN** a parent work item carrying a not-before date
- **AND** the `Detail` switch is off
- **THEN** the parent draws no bracket and no caret, because its only mark is the bracket
- **AND** turning the switch on draws both

#### Scenario: the canvas is one width in both states

- **WHEN** the reader presses `Detail` on a plan whose uncosted slice reaches past everything
  costed
- **THEN** the chart's drawn width and first day are the same before and after
