# Verify

Implementation landed 2026-09-13 on `change/status-polish`, stacked on PR #429. Local
(macOS, UTC+3); CI is the gate.

## Assumptions

- The green outline outranks the critical ring on a done bar: finished work is off the
  critical path in the reader's mind, and two rings on one bar say two things.
- The strip marks done predecessors on both surfaces that name them, the card and the picker;
  the chip itself is unchanged.
- The tint drops to 7%; Dany asked for "a little bit fader" and 7 is the band's dose plus the
  hover's, the scale the grid already uses.
- The tick stays on narrow bars (Dany: "leave the checkmark"); the label gives way to it.

## Commands

| Command                                                                                                            | Result                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `bunx vitest run` gantt-panel, hint, depends-card, dep-picker, plan-cells, plan-layout, table-frame, plan-keyboard | 630 passed                                                   |
| `bunx vitest run` (fe-01, whole suite)                                                                             | 2693 passed, 2 failed — the pre-existing UTC+3 Mermaid cases |
| `bunx nx run-many -t typecheck lint:fast -p fe-01`                                                                 | pass                                                         |
| `bunx nx format:check --all`                                                                                       | exit 0                                                       |
| `OPENSPEC_TELEMETRY=0 bunx openspec validate --all --json`                                                         | see below                                                    |

## Failure proofs

| Check                        | Fault injected                                  | Test that observed it                                                        | Observed                                                                |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| the done bar's green outline | the `bar.done ? DONE_BAR_STROKE :` arm dropped  | gantt-panel › `is painted as done and never as assumed…`                     | `expected '#475569' to be '#16a34a'`                                    |
| a done predecessor's strip   | `statusStripStyle` transparent for every status | depends-card › `marks a finished predecessor with the status strip…`         | `expected '3px solid transparent' to be '3px solid var(--status-done)'` |
| the fact's lead drawn bold   | `factWords` returning the plain words           | hint › `bolds the lead where it occurs in the words, and colours a done one` | `expected null not to be null`                                          |

The rule between Status and Links and the 7% tint are CSS with no unit oracle; judged on the
rendered plan in Chromium after the dev server picked the change up.
