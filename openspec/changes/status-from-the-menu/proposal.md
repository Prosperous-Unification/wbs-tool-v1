<!-- INTENT. Hard cap: 400 words excluding these comments. -->

## Why

Status is settable only from a column that is hidden by default, and the completion prompt
knows one day: today, for the finish. Dany, 2026-09-13: "add a 'Set status ...' to the actions
to allow setting the status from UI without enabling the status column … add setting the fact
start date - by default it is set to the forecast start date … for the end date - only set it
to current date if done status is set up before the forecast date … when from done -> unknown
clear fact start and fact end". Also: "center the actions dots".

## What Changes

**The row menu sets the status.** The ⋯ on a table row and on a card offers one status entry:
`Set status to Done` on a row that is not done, which opens the completion prompt; `Set status to
unknown` on a done row. The ⋯ itself is centred in its cell.

**The prompt asks for both days, from the forecast.** A `Started on` field opens on the held
fact start, else the forecast start, else today; `Finished on` opens on the held fact end,
else today while the forecast end is ahead, else the forecast end. Each field says what its
day is: recorded, the forecast's, today, or typed. Confirming sends `setStatus` with `on` and a
new `factStart`; a held day the reader changed follows as a patch.

**`setStatus` fills the fact start.** The command gains `factStart?: IsoDate`, refused as
`factStart_must_be_a_date` when not a day, filled where the row holds none.

**Unknown clears both facts.** A row that read done loses its fact start with its fact end,
in the same journal entry; one undo restores both.

## Non-Goals

No `In progress` entry (a step's statement). No overwrite of a held day by the mark. No
change to what the chart draws.

## Constraints

One command shape change, additive; `mcp-01`'s derived tool follows the OpenAPI document.
The menu entry is built once per face (table column, card) with the same label and id.

## Capabilities

### Modified Capabilities

- `wbs-domain`: status from the row menu; the prompt's two forecast-aware days; `factStart`
  on `setStatus`; unknown clears both facts.

## Domain Terms

None new; **Completion prompt** widens to two days.

## Decisions Recorded

None.

## Impact

`libs/contracts`, `libs/core`, `be-01` (route tests), `fe-01`.
