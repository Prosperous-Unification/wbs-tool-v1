## ADDED Requirements

### Requirement: The chart leaves the tool as a Mermaid gantt in a Markdown fence

The table SHALL offer, without asking be-01 for anything, a copy of the whole
current project's chart on the clipboard as a fenced ` ```mermaid ` block
holding a `gantt` diagram, followed by a legend in Markdown. It SHALL carry
every work item in the project's own order, whatever the viewer has collapsed or
searched for. The diagram SHALL declare `dateFormat YYYY-MM-DD` and SHALL
exclude weekends, SHALL open one `section` per work item carrying its number,
its team and its priority, and SHALL carry one task per placed slice naming the
role, the assignee and the number of people the slice ran at when that is more
than one. A slice on the critical path SHALL be tagged `crit`. Task dates SHALL
come from the chart's own calendar placement, with a start rounded down and a
finish rounded up so that no bar is drawn shorter than the work in it. The same
project exported twice SHALL produce byte-identical text.

#### Scenario: the chart is a diagram somebody can paste

- **GIVEN** a project with two estimated work items
- **WHEN** the plan is copied as Mermaid
- **THEN** the clipboard holds a ` ```mermaid ` fence containing `gantt`,
  `dateFormat YYYY-MM-DD` and `excludes weekends`, one `section` per work item
  and one task per slice

#### Scenario: the whole plan, not the view of it

- **GIVEN** a branch collapsed, so the chart on screen is not drawing its
  children
- **WHEN** the plan is copied as Mermaid
- **THEN** the collapsed branch's children each have a section in the diagram

#### Scenario: the same plan twice

- **WHEN** one project is copied as Mermaid twice with the same timestamp
- **THEN** the two documents are identical, character for character

### Requirement: What a gantt cannot draw is stated, never dropped

The export SHALL state everything the diagram cannot draw, both as a `%%`
comment block inside the fence and as a legend under it, because a comment is
invisible in a rendered picture. The legend SHALL list every stored dependency,
every slice held up by a team's capacity or by a busy assignee — in the chart's
own words for that wait — and every start-no-earlier-than date with its date. A
list the plan has nothing for SHALL say so in words rather than be omitted. The
legend SHALL name the export that carries the fields the diagram cannot.

#### Scenario: the arrows a gantt has no way to draw

- **GIVEN** a work item that depends on another
- **WHEN** the plan is copied as Mermaid
- **THEN** the legend lists that dependency by both work items' numbers and
  names, under a heading saying Mermaid's gantt draws no arrows

#### Scenario: why a bar starts where it does

- **GIVEN** a slice whose start was held by its team having nobody free
- **WHEN** the plan is copied as Mermaid
- **THEN** the legend carries the chart's own sentence for that wait, naming the
  team and the work that freed it

#### Scenario: a plan with none of a thing

- **GIVEN** a plan with no dependencies and no start-no-earlier-than dates
- **WHEN** the plan is copied as Mermaid
- **THEN** the legend says the plan stores none of either, rather than leaving
  the bullets out

### Requirement: A diagram is not drawn from a schedule that does not exist

When the project's dependencies run in a circle, or when no slice has been
scheduled yet, the export SHALL produce no `gantt` block at all and SHALL say
which of the two it is. A project with no start date SHALL be drawn from a
stated synthetic Monday rather than refused, and the export SHALL say so both in
the comment block and in the legend. A work item with no name SHALL be given the
tree's own words for an unnamed row, and a colon inside a name SHALL be replaced
before it reaches a task line, because Mermaid splits a task line on its first
colon.

#### Scenario: dependencies in a circle

- **GIVEN** a project be-01 could not order
- **WHEN** the plan is copied as Mermaid
- **THEN** the document holds no `gantt` block and says the dependencies run in
  a circle

#### Scenario: a plan that is not on a calendar

- **GIVEN** a project with no start date
- **WHEN** the plan is copied as Mermaid
- **THEN** the dates run from `2000-01-03` and the document says that day zero
  is drawn there because the plan is not on a calendar

#### Scenario: a name with a colon in it

- **GIVEN** a work item named `Payments: phase two`
- **WHEN** the plan is copied as Mermaid
- **THEN** its section title reads `Payments- phase two`, and the task line
  under it still splits into a name and a set of dates

### Requirement: A chart that cannot be laid out is reported, not silence

When the payload the export is built from names a role, a person or a slice the
plan does not hold, the copy SHALL report that in the chart's own words rather
than fail silently, because a click handler has no error boundary over it. The
clipboard's absence and its refusal SHALL be reported as they already are for
the Markdown table.

#### Scenario: a payload that lost something

- **GIVEN** a tree read whose slices name a role the same read does not list
- **WHEN** the plan is copied as Mermaid
- **THEN** an error toast says the chart cannot be drawn and names the role

#### Scenario: a page with no clipboard

- **GIVEN** a page served over http, where `navigator.clipboard` is absent
- **WHEN** the plan is copied as Mermaid
- **THEN** an error toast says the page has no clipboard
