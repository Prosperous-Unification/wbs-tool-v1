## ADDED Requirements

### Requirement: Plan calendar range is validated after placement

The system SHALL validate the placed plan's latest finish against the project's
start date before projecting any row onto calendar dates. The validation SHALL
be plan-level and SHALL therefore cover duration accumulated through dependency,
person, or capacity placement. It SHALL NOT lower the maximum of one authored
estimate.

#### Scenario: legal points form an unrepresentable plan

- **WHEN** individually legal estimates produce a placed finish outside the
  ECMAScript `Date` range
- **THEN** the plan read SHALL return 200 with `scheduleError = calendar_range`
  and SHALL NOT return partial dates

#### Scenario: nearby representable control

- **WHEN** the same shape has a placed finish within the `Date` range
- **THEN** the plan read SHALL return its calendar dates unchanged

### Requirement: Commands do not strand a plan outside calendar range

A project command batch SHALL validate the resulting plan inside the batch's
unit of work. If the resulting plan has `scheduleError = calendar_range`, the
batch SHALL roll back and return 422 `calendar_range`, including the command
index and kind. A recovery edit whose resulting plan is representable SHALL be
allowed to commit.

#### Scenario: overflowing estimate is refused atomically

- **WHEN** an estimate command would move the placed plan beyond the calendar
  range
- **THEN** the system SHALL return 422 `calendar_range`
- **AND** a subsequent read SHALL show the estimate was not stored

#### Scenario: historical bad state is recoverable

- **GIVEN** a project already holds estimates whose placed finish exceeds the
  calendar range
- **WHEN** a command clears enough work to return the finish to range
- **THEN** the command SHALL commit and the next read SHALL have no schedule
  error

### Requirement: Range failure is typed at the calendar boundary

The shared workday-to-calendar conversion SHALL throw `CalendarRangeError`
naming the start date and requested workday offset when ECMAScript cannot
represent the result. Other conversion failures SHALL remain unmodeled errors.

#### Scenario: Date range is exceeded

- **WHEN** a finite non-negative offset produces an invalid ECMAScript `Date`
- **THEN** conversion SHALL throw `CalendarRangeError` rather than allowing a
  bare `toISOString` `RangeError` to escape
