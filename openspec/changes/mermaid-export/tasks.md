# tasks — `mermaid-export`

## 1. The writer, pure

- [x] 1.1 `plan-mermaid.test.ts` first, over hand-built `GanttPlan` fixtures: sections and
      tasks in the chart's order, the header Mermaid needs, dates off the plan's calendar with
      a weekend between two spans, an outward-rounded fraction, `crit`, the two kinds of
      milestone, the assignee and the width on the task name, the team and priority on the
      section title.
- [x] 1.2 `plan-mermaid.ts`: `planToMermaid(plan, doc)` over a `GanttPlan` and four facts
      about the project. No React, no clock — the timestamp is an argument, exactly as
      `planToMarkdown`'s is.
- [x] 1.3 One placement for the whole document (`placeOnCalendar`, called once), read by the
      tasks and by the not-before list alike.
  - **Negative test (R1):** the not-before date read off the geometry's raw workday offset
    instead of the placed one. `lists every start-no-earlier-than date` failed, watched. The
    fixture was moved past the first weekend first — inside week one the two readings land on
    the same day and the test could not fail at all.

## 2. What the diagram cannot hold

- [x] 2.1 The `%%` comment block inside the fence and the Markdown legend under it, carrying
      the same losses.
  - **Negative test (R8):** the empty-list arm replaced by dropping the bullet.
    `says the plan holds none rather than dropping the bullet` failed, watched.
- [x] 2.2 The dependency list, the wait list quoted from `GanttBar.floorWords`, and the
      start-no-earlier-than list. The waits are found through the chart's own
      `capacityLinks`/`personLinks`, never through a second reading of `boundBy`.
- [x] 2.3 The two states with no diagram, decided **before** `layOutGantt` is asked for a
      layout.
  - **Negative test (R6):** the cycle return removed.
    `draws no diagram at all for a plan whose dependencies run in a circle` failed, watched.
  - **Negative test (R7):** the no-slices return removed.
    `draws no diagram for a plan nothing has scheduled yet` failed on a `GanttDataError`
    about an arrow with no anchor, watched.

## 3. The grammar, measured rather than assumed

- [x] 3.1 The colon escape and the unnamed-row fallback, both written against Mermaid
      11.16.1's own parser and database — see `verify.md`.
  - **Negative test (R2):** the escape removed. `escapes a colon in a name` failed, watched;
    the same emission fed to Mermaid read the task back as `{task: 'Dev', id: 'ada :t5'}`.
  - **Negative test (R3):** the fallback removed. `gives an unnamed row the tree's own words`
    failed, watched; the same emission fed to Mermaid was a parse error.
- [x] 3.2 `crit` for the critical path, milestones for the two spans of no days.
  - **Negative test (R5):** the `crit` tag dropped. `marks the critical path` failed, watched.
  - **Negative test (R4):** the unestimated slice drawn across the chart's two assumed days.
    `draws an unestimated slice as a milestone` failed, watched.
- [x] 3.3 Determinism: `t1` upward in layout order, nothing else.
  - **Negative test (R9):** the counter replaced by `Math.random()`. Eight tests failed,
    `is byte-identical twice over the same plan` among them, watched.

## 4. The toolbar

- [x] 4.1 `ganttRowOf` extracted so the panel and the export map a row once; `exportGanttPlan`
      walks every row of the tree and every stored edge.
  - **Negative test (R10):** the export's `rows` dropped, so it falls back to the panel's shown
    rows. `copies a collapsed branch's children` failed, watched.
- [x] 4.2 `copyAsMermaid`: the layout failure caught and reported, then the clipboard's
      absence, then its refusal.
  - **Negative test (R12):** the catch replaced by a rethrow.
    `reports a chart that cannot be laid out` failed with the `GanttDataError` uncaught,
    watched.
  - **Negative test (R11):** the absence guard removed.
    `says so when the page has no clipboard at all, on the Mermaid button too` failed on an
    uncaught `TypeError`, watched.
- [x] 4.3 The button, beside the two exports already there, its title saying what the legend is
      for.

## 5. Gate

- [x] 5.1 `nx format:check --all`, the fe-01 and be-01 suites, lint and typecheck over 21
      projects, and `openspec validate --all --json` — numbers in `verify.md`, measured on
      h2puni.
- [x] 5.2 CI green on the pushed head: `gate` and `pixels`.
- [ ] 5.3 Dany pastes a real plan's block into a GitHub comment and looks at it. Not done here:
      the rendered appearance is a judgement, and neither this box nor h2puni can run a browser
      — see `verify.md`, "What was not observed".
