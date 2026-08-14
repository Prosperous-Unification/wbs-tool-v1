# Export the chart as Mermaid

## Why

Dany, 2026-08-13, wave 6 R7:

> I want to be able to export the diagram as a markdown-compatible format;
> mermaid or smth else that will work in markdown

The plan already leaves the tool twice — as a Markdown table and as a CSV — and
both of them are the **grid**. The chart is the thing people are shown in a
review, and today the only way to put it in a document is a screenshot: not
diffable, not searchable, and stale the moment an estimate moves. Mermaid is the
one diagram syntax GitHub, GitLab, Obsidian and Notion render from source.

## What Changes

**The chart leaves as text**

- A third toolbar button, **Copy as Mermaid**, puts the whole plan on the
  clipboard as a fenced ` ```mermaid ` block holding a `gantt` diagram, followed
  by a legend in Markdown. It copies rather than downloads, because the other
  Markdown-shaped export copies and only the spreadsheet one downloads.
- **The whole plan, every time** — not the rows the chart is drawing. A
  collapsed branch and a running search are how one reader is looking at it;
  `Copy as Markdown` already refuses to carry either, and so does this.
- One `section` per work item, titled with its number, its team and its
  priority; one task per role slice, named with the role, the assignee and how
  many people ran on it at once. Dates come off the chart's own calendar
  placement, rounded outward so no bar is drawn shorter than the work in it.
  The critical path is Mermaid's `crit`.

**Nothing is dropped silently**

- Mermaid's gantt is weaker than this chart. What it cannot draw is written
  **twice**: as a `%%` comment inside the fence, for whoever reads the source,
  and as a legend under it, for whoever reads the rendered picture. Every stored
  dependency, every capacity and hand-off wait in the chart's own words, and
  every start-no-earlier-than date are listed there rather than lost.
- An empty list says the plan holds none of that fact, rather than vanishing.
- A plan whose dependencies run in a circle, and a plan nothing has scheduled
  yet, produce **no diagram at all** and a sentence saying why.
- A plan with no start date is pinned to a synthetic Monday, and says so.

## Non-Goals

- **No second table.** `planToMarkdown` already exports every field; the legend
  names that button rather than repeating twenty columns under a picture.
- No image, no PDF, no server-side render, no `flowchart` of the dependencies.
- No choice of format, no row selection, no options dialog.
- No change to the chart, the scheduler or any wire type.

## Constraints

fe-01 only, no API change. `planToMermaid` is pure, reads no clock, and is
byte-deterministic. `gantt-geometry.ts` is read and not touched.

## Domain Terms

`Mermaid export`, added to `CONTEXT.md` beside `Plan export`.

## Decisions Recorded

`design.md` — D1 to D11. No ADR: every one of them is a one-file change to
reverse.

## Impact

`apps/fe-01/src/components/wbs/plan-mermaid.ts` (new), `plan-mermaid.test.ts`
(new), `wbs-table.tsx`, `wbs-table.test.tsx`, `CONTEXT.md`.
