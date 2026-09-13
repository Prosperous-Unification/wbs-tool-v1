## ADDED Requirements

### Requirement: The row menu offers the one status change that applies

The ⋯ menu of a row — on the table and on a card — SHALL offer `Set status to Done` when the row's
status is not `done`, which SHALL open the completion prompt for that row and send nothing
until it is confirmed; and SHALL offer `Set status to Unknown` when the row is `done`, which
SHALL send `setStatus … unknown` at once. The ⋯ SHALL sit centred in its cell.

#### Scenario: from the menu to the prompt and back

- **GIVEN** a leaf reading unknown with the Status column hidden
- **WHEN** `Set status to Done` is chosen from its ⋯ and the prompt confirmed
- **THEN** one `setStatus … done` is sent and the row reads done; its ⋯ then offers `Set status
to unknown`, which sends `setStatus … unknown`

### Requirement: The completion prompt asks for both days, starting from the forecast

The completion prompt SHALL show `Started on` and `Finished on`. `Started on` SHALL open on the
row's held fact start, else the forecast start, else today. `Finished on` SHALL open on the
held fact end, else today while today is not after the forecast end, else the forecast end.
Beside each field the prompt SHALL say what the day is — the day already recorded, the same as
the forecast start or end, today, or a day the reader typed — read off the field's current
value. `Mark done` SHALL be held back while either field is not a calendar day. Confirming
SHALL send `setStatus` with `on` as the finish and `factStart` as the start; a held day the
reader changed SHALL follow as a `patch`.

#### Scenario: today before the forecast end

- **GIVEN** a leaf forecast `2026-09-01` → `2026-09-20`, no facts held, today `2026-09-13`
- **WHEN** the prompt opens
- **THEN** `Started on` reads `2026-09-01` with `Same as the forecast start.`, `Finished on`
  reads `2026-09-13` with `Today.`, and confirming sends `on: '2026-09-13', factStart:
'2026-09-01'`

#### Scenario: today after the forecast end

- **GIVEN** a leaf forecast `2026-09-01` → `2026-09-10`, no facts held, today `2026-09-13`
- **WHEN** the prompt opens
- **THEN** `Finished on` reads `2026-09-10` with `Same as the forecast end.`

## MODIFIED Requirements

### Requirement: Marking done fills an empty fact end with the day of the act

Marking a work item `done` SHALL fill the fact end of every work item the act writes — the
leaves and, for a parent, the parent itself — whose `factEnd` is `null` with `on`, and the
fact start of each whose `factStart` is `null` with `factStart` when the command carries one;
`on` absent, be-01 SHALL take the calendar day of the act's own write stamp in UTC. A stored
day SHALL NOT be overwritten by the fill. A `factStart` that is not an `IsoDate` SHALL be
refused `400 factStart_must_be_a_date` before any service runs. Setting `unknown` SHALL set
both `factEnd` and `factStart` to `null` on every work item in scope whose status read `done`
before the act, and SHALL leave the facts of every other row untouched. The fills and the
clears SHALL be part of the same journal entry as the statements, so one undo takes them away
or puts them back together.

#### Scenario: the start is filled where empty and kept where typed

- **GIVEN** two leaves, one with no fact start and one with `2026-09-02`
- **WHEN** each is marked `done` with `on: '2026-09-12', factStart: '2026-09-08'`
- **THEN** the first's fact start reads `2026-09-08` and the second's still `2026-09-02`

#### Scenario: a non-date start is refused

- **GIVEN** a `setStatus` with `factStart: 'last week'`
- **WHEN** it reaches the commands route
- **THEN** it is refused `400 factStart_must_be_a_date` and no row is written

#### Scenario: unknown takes both days, and one undo brings both back

- **GIVEN** a parent marked `done` on `2026-09-12` from `2026-09-08`
- **WHEN** `setStatus` sets it `unknown`, then the actor undoes once
- **THEN** every fact start and fact end in scope is `null` after the act and back after the
  undo, from one journal entry
