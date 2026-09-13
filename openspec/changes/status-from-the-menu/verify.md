# Verify

Implementation landed 2026-09-13 on `change/actions-set-status`. Local (macOS, UTC+3); CI is
the gate.

## Assumptions

- One status entry on the menu, never both: the one that changes something. `In progress` is a
  step's statement and is not offered.
- `Finished on` prefers the forecast end only when today is **after** it; on the forecast end's
  own day it is today (the two are equal).
- A held day the reader changes in the prompt is a second journal entry, as before.
- On a card the way back (`Set status to Unknown`) is proven on the table; the card suite's own
  fake does not fold a status.

## Commands

| Command                                                                         | Result                            |
| ------------------------------------------------------------------------------- | --------------------------------- |
| `bunx nx run core:test`                                                         | 424 pass                          |
| `bunx nx run-many -t test -p contracts mcp-01`                                  | pass                              |
| `bun test src/controller/work-item.controller.test.ts` (be-01)                  | 84 pass                           |
| fe-01: completion-prompt, plan-cells, plan-structure, plan-cards, wbs-api tests | 339 pass (before the wiring test) |

## Failure proofs

| Check                                          | Fault injected                                 | Test that observed it                                                  | Observed                                                         |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| the mark fills an empty fact start             | the `factStart` fill dropped from the done arm | core › `fills an empty fact start with the day given…`                 | `Expected: "2026-09-08" / Received: null`                        |
| unknown clears the fact start too              | the start half of the clear dropped            | core › `unknown takes the statements away…`, `one undo of an unknown…` | both red on the start day                                        |
| a non-date `factStart` is refused at the route | `parseFactStart` made a pass-through           | controller › `fills the fact start a mark names, and refuses one…`     | `Expected: 400 / Received: 200`                                  |
| the end defaults to the forecast end once past | the `today > forecast.endsOn` arm dropped      | completion-prompt › `finishes today while the forecast end is ahead…`  | `expected '2026-09-13' to be '2026-09-10'`                       |
| the menu offers the mark                       | the entry dropped from `createActionsColumn`   | plan-structure › `marks a row done from its ⋯ menu…`                   | `Unable to find … role "menuitem" and name "Set status to Done"` |
