# WBS Tool

The domain glossary for this repo. Terms only — one or two sentences each, defining what
a thing IS. Design decisions live in `docs/adr/`, behaviour lives in `openspec/`.

## Language

### WBS

**Project**:
One work breakdown structure and everything scoped to it — its work items, its steps and
its restriction. Nothing is shared between projects.
_Avoid_: workspace, board, plan

**Work item**:
One unit of work in a project. Holds a name, notes and a place in the tree; owns no
estimate directly once it has children. Never `item` alone — R2 forbids the bare noun.
_Avoid_: item, task, row, node

**Subtree**:
One work item and every work item beneath it, to any depth. The unit a duplication
addresses, because a branch is what a planner thinks in. A deletion takes the one row
and promotes its children a level, unless it is explicitly asked to take the subtree.
_Avoid_: branch, descendants, group

**Duplicate**:
Copying a subtree whole, in one operation, as the next sibling of the original. The copies
carry their originals' names, notes, estimates, labels, assignees and dates, and no frozen
numbers.
_Avoid_: clone, copy-paste, template

**Work item number**:
The label a work item is known by outside the tool, formed `010`, `020`, `010.1`,
`010.01`. Derived from position unless frozen. Zero-prefixed so it sorts lexicographically,
zero-suffixed so later work can be inserted between two numbers already in use.
_Avoid_: id, index, wbs code

**Position**:
An integer ordering a work item among its siblings, spaced in gaps of ten. The input a
client sends when it creates or moves a work item; the number is the output derived from
it. Never shown to the user.
_Avoid_: order, rank, sort key, sequence

**Freeze**:
The project-wide act of writing every derived work item number into storage, because those
numbers have left the tool and cannot change. Work items created after a freeze derive
their numbers as before, until the next freeze.
_Avoid_: lock, pin, publish

**Frozen number**:
A work item number that a freeze wrote down. It survives insertions, deletions and
repadding elsewhere in the project, and blocks the work item from moving until explicitly
unfrozen.
_Avoid_: fixed number, locked number

**Repadding**:
Widening every child number under one parent when that parent gains a tenth child, so
`010.1` becomes `010.01` and the tenth sorts last rather than second.
_Avoid_: renumbering, padding fix

**Step**:
A named kind of work a project estimates separately, unique by name within it. Every
project starts with `Dev` and `QA`, and may then be given others, renamed or emptied.
_Avoid_: discipline, type, category

**Step order**:
The order a project works its steps in — `Dev` before `QA` before whatever was added
after them. One order for the whole project, held per step, and the order every list of
them is read in.
_Avoid_: phase order, role order, sequence, priority

**Assumed assignee**:
The person a work item with exactly one assignment is taken to be doing every step's work
for. Read from the assignments rather than stored, so a second one ends the assumption.
_Avoid_: default assignee, implicit owner, cover

**Step usage**:
What a step's removal would take with it: the estimates and assignments that hold it, and
the work items whose assumed assignee it would change.
_Avoid_: references, dependents, blast radius

**Directory**:
The people and service teams every project draws from — one list for the whole
deployment, readable and writable by any signed-in account. Not a per-project list, and
not an account on this tool.
_Avoid_: roster, address book, org chart, users

**Service team**:
A team work can be labelled with. A label on the work, never a constraint on who may be
assigned it, and unique by name across the directory. How many of them may be at work at
once is a separate fact, stated per project — a Capacity, not a property of the team.
_Avoid_: department, squad, group

**Service**:
What the work is part of — a system, a product surface, a deliverable — named globally and
unique across the directory. Independent of the team that does it (Dany, 2026-08-20: "let
service and teams be independent"), so it has no pool and no size; which teams **own** one
is a separate map, and owning it constrains nothing about who may be assigned the work.
_Avoid_: component, system, area, service team

**Work item type**:
A word for what a work item **is** — `epic`, `story`, `spike` — named globally and unique
across the directory. Unlike a Tag it does not inherit at all
(`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`): a row's types are the row's
own, and an ancestor's say nothing about it.
_Avoid_: kind, category, issue type, tag

**Team set**:
The teams one work item states — none, one, or several. Stated in `work_item_team` and
read from there; the work item's own column holds the single member until it is dropped.
Empty means _unstated_ and takes the ancestor's, never "deliberately no team".
_Avoid_: teams field, labels, tags

**Effective team set**:
The team set in force for a row: its own if that is non-empty, else the nearest
ancestor's, whole. Most-specific wins and the set is replaced rather than accumulated, so
a row stating one team is on that team alone however many its parent states. A reading,
computed in one place and never written down.
_Avoid_: inherited teams, resolved teams, effective team

**Tag**:
A word for what kind of thing a work item is — `regulatory`, `tech-debt`, `q3-must-have`.
Global, named, and unique across the directory; it has no pool, no size, and no effect on
any date.
_Avoid_: label, category, type, marker

**Tag set**:
The tags one work item states — none, one, or several. Stated in `work_item_tag` and read
from there. Empty means the row has added no word of its own, never "deliberately
untagged".
_Avoid_: tags field, labels

**Effective tag set**:
The tags in force for a row: its own **plus every ancestor's**, unioned, each carrying the
row that states it. Accumulated rather than replaced — the opposite of an Effective team
set, because a child of a `Risk` parent is still risky (ADR 0008). A tag two rows both
state belongs to the nearer one. A reading, computed in one place and never written down.
_Avoid_: inherited tags, resolved tags, effective tag

**Stating row**:
The work item a label in force was actually written on — itself for a stated one, an
ancestor for an inherited one. What decides where a label can be removed: only its stating
row can take it off.
_Avoid_: source, owner, origin

**Capacity**:
How many of one team may be at work at once on **one project's plan**. A fact about the
pair, never about the team: two plans labelled with the same team each state their own,
and there is no global number behind either. Absent is _unstated_ and constrains nothing.
_Avoid_: team size, headcount, allocation, availability

**Pool**:
The slots one team's capacity provides on one plan, and the thing work labelled with that
team competes for. Keyed on the work item's team, never on the assignee's memberships.
_Avoid_: bucket, resource pool, team capacity, queue

**Slot**:
One person's worth of a pool, held for the whole of a block's duration and released when
it finishes. Counted, never named — a slot is not a person and does not decide who does
the work.
_Avoid_: seat, lane, place, unit

**Maximum parallelism**:
How many people may be on one work item at once — 1 or more, never absent, because 1 and
unset are one fact. What the `∥` column carries. A ceiling on the ask; what a slice
actually gets is its Width.
_Avoid_: in-parallel, concurrency, people, parallelism (bare)

**Width**:
How many slots a slice actually runs at: its work item's maximum parallelism, clamped to
the pool's slots, and 1 whenever a person is named on it. What divides effort into
duration.
_Avoid_: parallelism, size, slots used

**Block**:
One slice as the pool sees it — its width for its whole duration, taken indivisibly. It
starts only where every one of its slots is free for all of it; it never starts narrow and
widens later.
_Avoid_: reservation, chunk, allocation

**Blocking set**:
Every reservation that had to end for a block to fit, carried whole rather than as the one
that happened to end last. What float is computed against, so no row is reported movable
when another row's finish is holding its slack.
_Avoid_: blockers, predecessors, holders

**Display referent**:
The one member of a blocking set the chart names and draws an arrow from — the latest
finisher of it. The rest are counted, because the wait is disjunctive and a card listing
five rows is a card nobody finishes.
_Avoid_: cause, blocker, main predecessor

**Remembered capacity**:
A capacity a project still holds for a team its work is no longer labelled with. Invisible,
because the plan lists only the teams on it, and re-applied silently if that team labels a
row again. A third state beside stated and unstated.
_Avoid_: stale capacity, orphan capacity, leftover

**Person**:
Somebody who does work, named in the directory and assigned to a work item's step. Not an
account: most of the people a plan names never sign in.
_Avoid_: user, resource, member, assignee (which is the assignment, not the person)

**Free agent**:
A person who belongs to no service team. The absence of memberships, never membership of
a "Free agents" row — a real row could be renamed, deleted or given work of its own.
_Avoid_: unassigned, independent, teamless

**Person kind**:
Whether a person in the directory is a human or a piece of software — `person` or `agent`,
one per person, always set. Everyone the directory held before kinds existed is a `person`.
_Avoid_: type, category, is-agent, human flag

**Agent**:
A person whose kind is `agent`: software that does a work item's work. Assigned,
scheduled and counted against capacity exactly as a human is; the kind is a label reports
read, not a rule the engine follows. Not to be confused with **free agent**, which is
about team membership and predates this term.
_Avoid_: bot, AI, machine user, automation

**Directory usage**:
What removing a person or a service team would take with it, named rather than counted:
the affected projects with their work items by number and name, each work item's effects,
and the people whose membership would be dropped. What a refusal carries so that the
second, confirming request is agreeing to something it has seen.
_Avoid_: references, impact, blast radius, dependents

**Membership chip**:
One team a person belongs to, drawn on the directory page as a token that removes that
one membership.
_Avoid_: tag, pill, badge

**Add button**:
The `+` on a reference cell — Tags, Teams, Services, Types and Depends on. It **toggles**:
it opens the cell's picker, and pressed again with that picker's list open it closes it
and leaves the cell at rest. What it reads is the list, never whether the focus is in the
cell — a box holding the focus with no list under it is where a reader stands the moment
after taking a value, and the `+` has to open from there. It never takes the keyboard
itself.
_Avoid_: plus, add affordance, new button, opener

**Project owner**:
The account that created a project and the only one that may edit it while it is
restricted. An account, never a person from the directory.
_Avoid_: author, creator, user

**Project entry**:
One project as the picker offers it: the name it is chosen by, followed by its entry
meta. The unit the list is bounded and truncated by — one line, whole or clipped, never
two.
_Avoid_: option, row, list item, project summary

**Entry meta**:
The muted parenthetical on a project entry in the picker: who owns the project and the
day it was created. Shown to tell same-named projects apart, never searched.
_Avoid_: subtitle, caption, details

**Estimate**:
Three durations in days — optimistic, realistic, pessimistic — held for one work item and
one step. A work item with children has no estimates of its own.
_Avoid_: points, effort, sizing

**Trio shorthand**:
One estimate written as one value — `2/3/8`, or `5` meaning all three are five. What a
folded step's cell shows and takes, in place of three boxes.
_Avoid_: quick entry, inline estimate, compact form

**Final days**:
One step's single number of days for one work item — the project's estimate method applied
to its **estimate** and charged at the project's **estimate rounding**. Shown beside the
**trio shorthand** it came from, summed across steps into the work item's total days, and
summed across descendants for a work item with children.
_Avoid_: PERT number, computed figure, effective estimate

**PERT weights**:
The three coefficients a project weighs an **estimate**'s optimistic, realistic and
pessimistic figures by, whose sum is the divisor. 1, 4 and 1 unless the project says
otherwise; read only under the `pert` estimate method.
_Avoid_: PERT formula, coefficients, lambda

**Estimate rounding**:
A project's answer to how one step's combined figure becomes the days it is charged:
`floor`, `round`, `ceil`, or `exact` for the fraction itself. `ceil` unless the project says
otherwise, and applied per step before any sum is taken.
_Avoid_: precision, rounding mode, day granularity

**Estimate gap**:
One leaf work item and one step it holds no estimate for. A work item with children never
has one, because its figures are rolled up rather than typed.
_Avoid_: missing estimate, unestimated row, TBD

**Roll-up**:
The sum of a parent's descendants' estimates, per step, computed on read and never stored.
_Avoid_: aggregate, total, computed estimate

**Measure**:
One number somebody typed about one work item, one step and one **metric**, with the
moment they typed it. Rolls up like an estimate; absent, never zero, when nobody typed it.
Days live outside this term — they are the **estimate** and the **recorded days**.
_Avoid_: metric value, figure, datapoint, reading

**Metric**:
Which unit a measure is in, from a closed set: `token_estimate`, `token_actual`,
`hours_actual`. A measure is absent per metric — an hours figure says nothing about
whether a token figure exists.
_Avoid_: unit, kind (which is the person's), measure type

**Token estimate**:
The tokens a step's work on one work item is expected to take. One number, not a trio: no
scheduler folds it, so there is nothing for a range to reduce to.
_Avoid_: token budget, projected spend, cost estimate

**Token fact**:
The tokens a step's work on one work item actually took. Says nothing about whether that
work is finished — completion is the step's **progress**, recorded separately.
_Avoid_: actual tokens, token spend, usage

**Hours fact**:
The hours a step's work on one work item actually took. Recorded, never derived: no
conversion from tokens or from days exists, because neither is one.
_Avoid_: actual hours, time spent, effort

**Dependency**:
One work item waiting for another's reached slice to finish before it starts — which of
the predecessor's slices that is comes from the project's Dependency reach. Either end may
be a parent, which means every leaf beneath it. Held once per pair, in one direction.
_Avoid_: link, blocker, edge (outside the graph code)

**Dependency reach**:
A project's answer to how far into a predecessor its dependencies reach: `whole-item`, the
predecessor's last slice in step order, or `anchor-slice`, its Anchor slice with the steps
behind it running alongside the successor. Stored per project, read by the scheduler, never
sent by a client. `whole-item` unless the project says otherwise.
_Avoid_: dependency mode, wait rule, link type

**Slice**:
One leaf work item's work for one step — the unit a schedule is computed in. A leaf in a
project holding two steps is two slices, run one after the other in step order.
_Avoid_: task, bar, segment, phase, role, item×step

**Anchor slice**:
A work item's first slice in role order that somebody estimated — the one a dependency
waits on where the project's Dependency reach is `anchor-slice`. A role listed in front of
it and left unestimated is stepped over, and having an assumed duration does not make it
the anchor. Reordering a project's roles moves what every such dependency waits for. Where
nothing is estimated the anchor is the work item's finish, which is its steps' assumed
durations end to end — the one case where both reaches name the same slice.
_Avoid_: dev slice, first slice, handoff point

**Projection**:
A work item's own schedule, read off its slices: the earliest of their starts, the latest
of their finishes, the least of their slack. What leaves be-01 and what the table draws —
slices themselves never do.
_Avoid_: aggregate, summary, rollup (which is estimates, not time)

**Resource leveling**:
Placing every slice so that nobody is doing two at once. Always on, and invisible in a
plan with nobody assigned — which is what every plan was until it arrived. Per person;
the per-team bound beside it is a Capacity.
_Avoid_: smoothing, balancing, allocation

**Priority**:
How important one work item's work is, as an integer from 1 upward, smaller being more
important — or absent, which is a state of its own and not a large number. A created work
item takes its project's rank 2 band's own default unless the create names one; absent is
what a create is explicitly told to write, and what every work item written before
2026-08-29 still holds. Decides which of two eligible slices is **placed** first; a leaf
that carries one is not reached by a priority written on a step above it. Never overrides
a dependency, a floor or a calendar, and placed first is not started first — a narrow
block can take a hole a wide one of higher priority cannot use. What the number is **called** is the project's own —
see Priority band — and the name decides nothing the number does not.
_Avoid_: priority, importance, urgency, severity, weight

**Priority band**:
One rung of what a project calls its priority numbers: a start value, a label, and the
number choosing that label writes. The band above ends the one below, and the highest ends
nowhere, so every priority resolves to exactly one band. Five per project, renamable and
re-cuttable; the count is not.
_Avoid_: priority level, priority range, severity level, tier

**Priority ladder**:
A project's five bands, in rank order. It is a vocabulary and never a constraint: re-cutting
it renames what a plan's numbers are called and moves no date. A project that has stored
none reads the default five.
_Avoid_: priority scheme, priority config, priority scale

**Project settings**:
The one surface where a project's own configuration is edited: its teams' capacity, its
priority ladder and its steps, each a section of one modal opened from one plan-toolbar
control. A section holds an edit until it is saved or abandoned, and the surface refuses to
close over one.
_Avoid_: project config, settings dialog, Teams dialog, Priorities dialog, Steps dialog

**Rank**:
A band's position in its ladder, 0 (most important) to 4. What every face keys a band's
colour off, because a label can be renamed out from under one and a position cannot, and
what a create reads its default priority from. Rank 2 is the ordinary rung: the colours
diverge around it — neutral there, warm above, cool below — so colour reads as distance
from ordinary.
_Avoid_: band index, level, tier number

**Eligible slice**:
One whose predecessors have all been placed — its dependencies and its work item's
earlier steps. The set of them is what the schedule takes its next slice from, highest
priority first.
_Avoid_: ready, available, unblocked, frontier

**Binding floor**:
The one thing a slice's start is set by, out of the day the project starts, a dependency,
its work item's earlier step, a manual date, its assignee's last finish, and its team's
capacity. A tie is never the person and never the capacity: somebody — or some slot —
free exactly when the dependency clears is holding nothing up.
_Avoid_: constraint, reason, blocker, driver

**Resource predecessor**:
The slice a person was busy with immediately before the one they were the binding floor
of. What a person link on the Gantt is drawn between; absent when nobody waited.
_Avoid_: previous task, queue parent, resource link

**Gantt panel**:
The second drawing of the plan: every shown row as marks on a calendar axis, under the
plan renderer and mirroring its rows. Read-only — edits happen where they always did.
_Avoid_: chart, timeline, gantt view

**Row label**:
A work item's number and name as the Gantt panel prints them, in the fixed column to the
left of the marks. The panel's own naming of the row a mark sits on, indented to the plan's
outline, and a control: clicking one takes the plan to that row.
_Avoid_: label column, gutter, row header, legend

**Linked scroll**:
The one row the plan renderer and the Gantt panel are both showing first. Scrolling either
vertically brings the other to that row, whichever was scrolled; sideways they are
independent, because the columns on screen and the part of the calendar on screen are
different facts. Rows and not pixels: the two faces do not draw a row at the same height.
_Avoid_: scroll sync, scroll lock, pinned scroll

**Pointed row**:
The one work item both faces of the plan agree the pointer is on, lit in three places at
once: the plan renderer's row, the Gantt panel's label for it, and a band across its Gantt
row. One at a time, from whichever face the pointer is over or a bar holds the focus —
including the plan renderer's own row, which since 2026-09-01 carries the row light like
any other rather than being left to the alternating band's hover. It moves nothing:
nothing scrolls to a pointed row.
_Avoid_: hovered row, active row, current row, selection, highlight

**Row line**:
A Gantt row's whole width as a thing the pointer can be on, bar or no bar. What makes the
empty part of a row point it, and the only surface a row nobody has estimated has. Not a
mark — it is never painted, and it draws under every bar so a bar keeps its own hover.
_Avoid_: row hit area, row track, row background, lane

**Row light**:
The tint a row is painted to say it is being pointed at — one colour for every cause and
on every stripe, because there is one pointer and so only ever one reason on screen at a
time. What a hovered Depends on cell paints the rows it waits for, and what a pointed row
is painted. The alternating band says which row is which **at rest**; it has no say in
what a pointed row looks like.
_Avoid_: highlight colour, selection colour, active background

**Calendar axis**:
The Gantt panel's horizontal scale on a plan that has a start date: one unit and one
cell per calendar day from the plan's first working day, weekends among them and greyed,
the heavy line on Mondays. Every mark the panel draws takes its horizontal coordinate
from it.
_Avoid_: date axis, timeline, time axis

**Calendar scale**:
What turns a workday offset into a place on the calendar axis, read two ways: where a
span that starts there stands, and where a span that finishes there stops. The two differ
by exactly the weekend between two workdays, which is what puts a gap between work that
ended on the Friday and work that begins on the Monday.
_Avoid_: converter, mapping, projection

**Workday axis**:
The Gantt panel's horizontal scale on a plan with **no** start date: one unit per workday,
printing the offset itself. Weekends are not on it — there is no calendar to have one on
— so a week is five cells rather than seven. A rendered state, not a fallback.
_Avoid_: time axis, date axis, offset axis

**Horizon**:
How far the drawing reaches: the furthest right edge of anything drawn, in the unit the
chart is in — calendar days on a calendar axis, workdays without one — and far enough to
hold every assumed span drawn past a slice's own finish. The width of the Gantt panel's
drawing space.
_Avoid_: extent, range, span

**Bar**:
The drawing of one slice on the Gantt panel — a rectangle from where its start stands to
where the span it is **drawn** across stops. A picture of a slice, never the slice itself:
its width is the days it is drawn over, weekends inside it included, while the workday
numbers it carries stay the engine's.
_Avoid_: segment, block, task bar

**Assumed duration**:
The two workdays a schedule gives a slice nobody has estimated, so that unsized work is
work of unknown length rather than no work. One constant, shared by the engine and the
drawing. It is never an estimate: nothing is written, the days column and the roll-up stay
blank, and the readiness badge still counts the gap.
_Avoid_: default duration, placeholder estimate, assumed estimate

**Assumed span**:
How a slice on its assumed duration is painted: a dotted translucent bar with a `?`, so
that the width reads as a guess. The width itself is the schedule's — what the bar adds is
the saying.
_Avoid_: ghost bar, placeholder bar

**Slack**:
How long a work item can be late before the plan's end moves — its latest finish less its
earliest finish. Zero slack is Critical. One word for it, and `float` is the one to avoid:
the scheduler's own field is `float` and its prose says `slack`, which is one concept with
two names and the rename is owed.
_Avoid_: float, buffer, spare time

**Critical**:
A work item with no Slack: every day it slips, the plan's end slips. A reading of the
schedule rather than a property anybody types, and a plan with no dates has none.
_Avoid_: blocker, bottleneck, on the critical path (as a flag)

**Summary bracket**:
The drawing of a parent on the Gantt panel: a bracket over its projection. A span,
never a sum, exactly as the projection is.
_Avoid_: parent bar, group bar, rollup bar

**Arrow route**:
The corners a dependency arrow is drawn through, from the predecessor's anchor to the
successor's start: horizontal and vertical runs only, arriving from the left so the head
points right. Chosen against the bars the panel is drawing — it passes through no bar's
interior, the two it joins included — and not merely from the two ends.
_Avoid_: elbow, path, polyline

**Person link**:
The line from a resource predecessor to the slice that waited for it — one person's
hand-off, drawn unlike a dependency arrow. Exists only where the binding floor is the
person.
_Avoid_: resource arrow, queue line, assignment link

**Not-before flag**:
The mark standing on the day a row's manual start date holds it at, on rows that have one.
Where it stands is that date's place on the axis; what it says on hover is the date itself.
_Avoid_: constraint marker, lock, milestone

**Not-before reason**:
Why a row's manual start date is there, in the planner's own words. Words about that date
and nothing else: it holds nothing back on its own, moves no date, reaches no other row,
and cannot exist without the date it explains. Said where that date's effect is already
said — the floor sentence of a bar the date binds, and the Not before cell.
_Avoid_: blocked, blocker, status, hold reason, note

**Refused dependency**:
A dependency be-01 will not write: onto the work item itself, onto an ancestor or a
descendant of it, or one that closes a loop once every dependency is expanded to the
leaves beneath its ends. be-01 decides; the picker predicts, to grey the row before it is
clicked.
_Avoid_: invalid dependency, illegal link, blocked edge

**Search**:
What is typed into the table's Find box, and the narrowing it causes: the work items whose
name contains it, the ancestors that place them and the descendants beneath them. Local to
one reader, and it changes nothing — nobody else's table moves.
_Avoid_: filter, query, lookup

**Match**:
A work item whose own name contains the search. Marked as such, because the rows kept
around it are on screen as context rather than as answers.
_Avoid_: hit, result, found row

**Facet**:
One dimension the table narrows by — a team, a person, a step, a tag, a service, a type, a
priority band. Every facet answers "which rows carry this", and a facet naming a value the
plan no longer holds narrows to nothing rather than being repaired.
_Avoid_: filter, dimension, criterion

**Saved view**:
How one reader is looking at a plan, named so it can be picked again: the facets in force
and, since `configurable-columns`, the Column set that was on screen. Per browser and never
told to be-01 — not the expansion, not the column widths.
_Avoid_: preset, bookmark, layout, filter set

**Expansion**:
Which branches of one project's tree are open, in one browser. Either every branch or a
named set of them; a branch not named is closed. Remembered per project, per browser, and
overridden on screen for as long as a search is running.
_Avoid_: collapse state, open rows, fold

**Key binding**:
One key or chord the table acts on, what it does, and where it applies. Held once, as
data, so the cheat sheet and the keyboard cannot disagree.
_Avoid_: shortcut, hotkey, accelerator

**Cheat sheet**:
The modal list of every key binding, opened by `?` from outside a text box. It reads the
keyboard out; it does not change it.
_Avoid_: help, shortcuts dialog, legend

**Name cell**:
The one box a work item's name and its notes are written in: the first line is the name,
everything under it is the notes. At rest the cell shows the name alone, whole, wrapped and
read as inline markdown; writing in it gives the source back. The notes appear while it is
edited and in its hover preview. They stay two fields in storage — the cell is where they
are composed for reading and split again on the way out.
_Avoid_: title field, notes column, description

**Inline markdown**:
How a work item's name is read on every face that draws one — the Name cell, the hover
preview's heading, a plan card and the chart's row label. Emphasis, strong, inline code,
strikethrough and links parse; block syntax does not, and a heading, list, quote, fence,
table or rule marker is shown as the characters it is rather than stripped. A name never
changes the height of what it is drawn in, and a link is followable only from the hover
preview. The export and the search read the source instead.
_Avoid_: rich text, formatted name, markdown name

**Hover preview**:
The rendered reading of one work item, opened over its Name cell from the notes marker on
that cell: the name as a level-one heading the application itself writes, with the name's
own inline markdown inside it, and the notes as markdown under it. The name is never
composed into the notes' markdown source. The only place notes render; nowhere does raw
HTML in either field become markup.
_Avoid_: tooltip, popover, notes preview

**Notes marker**:
The small mark at the right edge of a Name cell whose work item has notes, and the only
thing that opens that cell's hover preview. It says a row has notes; it is not a control —
nothing to click, no focus, no place in the keyboard grid.
_Avoid_: notes icon, badge, indicator, button

**Hover card**:
The instant answer a cell gives to the mouse resting on it: the whole of what its at-rest
face folds away — a folded step's three points and assignee, a depends chip's names. Opens
on enter with no delay, one at a time; the Name cell's hover preview is one.
_Avoid_: tooltip, title attribute, hint

**Project fact**:
Words a mark carries that say something about **this project** — who a tag was inherited
from, how many days a row can slip, where a link goes. Shown the moment the pointer
arrives, because the reader came to the plan to learn it.
_Avoid_: data hint, content tooltip, instant hint

**Tool hint**:
Words a control carries that say what **the control** does — a toolbar button, a column
heading, a resize handle. Shown only after the pointer has rested on it, because a reader
who already knows the button does not need telling every time they cross it.
_Avoid_: UI tooltip, chrome hint, slow hint

**Wait ring**:
The mark drawn beside the cursor while a tool hint is waiting to open, and the only sign
that one exists. It is not a control and it never appears for a project fact.
_Avoid_: spinner, loader, progress indicator, countdown

**Press quiet**:
The silence a control keeps after the pointer has pressed it: the wait its tool hint had
started is cancelled, and no new one begins until the cursor actually moves. A reader who
has pressed a control has said they know what it does. Nothing remembers which control was
pressed — the cursor moving is what ends it, so the page redrawing under a still cursor
does not.
_Avoid_: dismissed, suppressed hint, seen control, tooltip cooldown

**Actions menu**:
The list of things one work item can be asked to do — duplicate it, delete it, unfreeze
its number — behind a single button on its row. One is open at a time, and it owns the
keyboard while it is.
_Avoid_: context menu, row menu, kebab, overflow menu

**Theme choice**:
What a reader has asked the app to be painted in: `system`, `light` or `dark`. Remembered
per browser, under one key for every project, because it answers about this screen in this
room. `system` is an answer of its own — follow whatever the machine is set to, and keep
following it while the page is open — rather than the absence of one.
_Avoid_: theme mode, dark mode setting, colour preference

**Palette**:
Which of the two token sets is actually on screen once a Theme choice has been resolved:
`light` or `dark`. `styles.css` declares both and the `dark` class on the root selects the
second; every `bg-card` and `color-mix` in the app reads it through a custom property and
knows nothing about there being two. Not a Colour, which is a deploy slot.
_Avoid_: theme (for what is painted), colour scheme, skin

**Flexible column**:
The one column whose `<col>` never declares a width — the name — which absorbs whatever the
viewport leaves over, down to a floor it does not shrink past. Draggable like any other:
a dragged width becomes a column width override riding on its cells, with the `<col>` still
silent so the excess keeps landing on it alone. Asking for its width with no override in
force is an error, because the pinned offsets are sums of declared widths.
_Avoid_: auto column, fill column, stretch

**Table minimum width**:
The narrowest the table may be laid out for the columns it is currently showing: every
declared width plus each flexible column's floor. Above it nothing scrolls sideways; below
it the frame scrolls and the pinned columns hold the left edge.
_Avoid_: total width, table width, min size

**Frame layout**:
Every width one drawing of the table declares, resolved together from the columns on
screen and the plan being drawn: each column's declared width, the table minimum, and the
offset each pinned column is held at. One resolution, read by every consumer — a width
that changes changes all of them, because there is only one of them. What a width may
depend on is one object, so a new fact is a field rather than an argument somebody forgets
to pass.
_Avoid_: width table, column config, geometry, sizing

**Display envelope**:
The widest content a column undertakes to show whole, where there is no widest content to
size it to. The Number column's is eleven characters at the deepest indent, beside the
row's expander and its frozen-number lock; a number past it is clipped and kept whole in
the cell's title. Measured by a browser, never chosen by reading the markup.
_Avoid_: max width, longest value, cap

**Number indent**:
The capped share of a row's indent, drawn inside the Number cell: one step per level down
to a stated deepest level, and flat past it, so the indent can never outgrow the column's
declared width. One half of a pair with the hierarchy indent.
_Avoid_: indent, padding, offset

**Hierarchy indent**:
A row's whole indent, one step per level with no cap. Surfaces with no declared column
width to protect take it whole; the Name cell carries its difference from the number
indent, so the outline keeps stepping right past the Number cell's cap.
_Avoid_: full indent, real depth, uncapped padding

**Column width override**:
One column's width as this browser was told it by a drag, replacing the width the frame
layout would otherwise resolve. Held per project, per browser, and never seen by anyone
else.
_Avoid_: resize, custom width, preference

**Panel height override**:
The Gantt panel's height as this browser was told it by a drag on the panel's top edge,
replacing the bounded share the panel would otherwise take. Held per project, per browser,
and never seen by anyone else.
_Avoid_: chart height, panel size, splitter position

**Layout reset**:
Forgetting every column width override, the panel height override and the hidden columns
for one project, so each returns to what is resolved for it now rather than to what it was
when the override was made.
_Avoid_: width reset, restore defaults, revert, clear

**Column set**:
Which of the table's columns one reader has on screen for one project: the default column
set less that reader's hidden columns. Held per project, per browser, and never seen by
anyone else; a saved view may carry one.
_Avoid_: column config, visible columns, layout, column preferences

**Default column set**:
The columns a project's table shows before anybody has hidden or shown one — the same set
on every deployment, whatever its directory holds. The set the folded-width budget is
measured over.
_Avoid_: fixed columns, standard columns, all columns

**Hidden column**:
A column a reader has taken off the table for one project, still in the plan and still
counted in every roll-up and date; a whole step can be hidden, and then none of its columns
is on screen. Number, Name and the row's controls cannot be.
_Avoid_: collapsed column, disabled column, removed column, folded column

**Short date**:
A calendar day as somebody reads one — `1 Jun`, and `1 Jun 2027` when the year is not the
current one — with the whole `YYYY-MM-DD` still in the cell's title. Read out of the
day's own components, never parsed into a moment: a moment has a zone and a calendar day
has none. An instant printed this way is a different question and a different formatter.
_Avoid_: formatted date, pretty date, display date

**Edit exit**:
How an edit in a field ends, as one of two answers: committed, or abandoned. Leaving and
Enter commit; Escape abandons and puts back what the server agreed, so nothing is left for
the blur it causes to send. Closing returns the focus to the cell that was being edited.
_Avoid_: cancel, dismiss, close, blur handling

**Hover preview**:
The one positioned surface a mark shows on hover or focus, wherever the plan is drawn;
the Name cell's and a Gantt bar's are the same surface with different bodies.
_Avoid_: tooltip, popover, hovercard

**Plan renderer**:
Whichever of the two things is drawing the plan right now — the table or the outline cards.
Chosen by how wide the viewport is and by nothing else, and never both at once; the plan,
its cells and their unsaved state are the same under either.
_Avoid_: view, mode, layout, breakpoint

**Outline card**:
One work item as a phone reads it: its number at its own depth, its name and notes in one
box, its figures, its dates, and one line per step. Read whole; edited one field at a time.
_Avoid_: tile, row, list item, mobile row

**Mention**:
A person looked up from inside another box, written as `@` and part of their name — in the
folded step cell, where `2/3/8@kat` is one gesture. Held apart from whatever the box is
otherwise for: the estimate never sees the mention and the mention never becomes an
estimate.
_Avoid_: at-mention, tag, autocomplete

**Toast**:
One message about something that just happened, shown in a corner of the screen. A failure
waits there until it is dismissed; a note takes itself off. Reports events only — a
condition that stays true is a banner.
_Avoid_: notification, snackbar, flash, alert

**Stale tree**:
The rows on screen after a refetch failed: the last ones that arrived, and possibly behind
what be-01 now holds. Ends at the next refetch that lands, whichever asked for it.
_Avoid_: out of date, dirty, unsynced, desynced

**Plan export**:
One project written out as a document somebody reads elsewhere — a Markdown table, a CSV
file, or a plan document — headed, in the two prose formats, by what the table alone cannot
say: the estimate method by name, whether the dates are dates or day offsets, and when the
figures were taken. Always the whole project, never the view of it.
_Avoid_: report, download, dump, extract

**Plan document**:
The one plan export the tool can read back: a JSON file carrying the project's settings,
steps, priority ladder, capacity, every work item with everything typed on it, and the names
behind every directory id it uses, under a format name and version. Derived figures ride
along for readers and are never restored.
_Avoid_: backup, dump, snapshot, JSON export (as a term)

**Saved plan**:
One project's whole plan copied by value at one instant and kept in the database: the
settings, the tree, the estimates, the ownership, the names behind every id it uses, and
the dates the scheduler gave it. Read to be looked at or compared, never exported, never
imported, never applied to a project — nothing puts one back. Not a Plan document: that one
leaves the tool for a reader and can make a new project; this one never leaves.
_Avoid_: snapshot, checkpoint, backup, version

**Import**:
Making a new project from a plan document, whole or not at all: the importer owns it, every
id is minted afresh, directory entries are found by name and created when absent. Never a
change to a project that already exists.
_Avoid_: restore, load, upload, merge

**Revision**:
A count of how many times one work item or one project has been written to, starting at
zero and never going down. Moves on the entity's own stored fields and on its satellites,
and never on the number derived for it.
_Avoid_: version, etag, timestamp, sequence

**Phase**:
Retired, and recorded so nobody reintroduces it: what a Step was called until
`steps-not-phases`. A reader who says "phase" means a step, and the schema, the routes and
the screens all say `step` since `20260831120000_rename_role_to_step`.
_Avoid_: it entirely — say Step

**Satellite**:
A row that belongs to one entity, has no identity anyone holds, and is only ever read
through that entity — an estimate, an assignment, a step. Writing one moves the owner's
revision; a dependency has two owners and moves both.
_Avoid_: child row, detail, related record

**Solution ref**:
The external solution a project belongs to, as a slug and a URL on the project itself. The
slug is what `GET /plans/by-solution/{slug}` resolves, which is the one route an integration
token reaches with nothing but a name it already knows.
_Avoid_: integration, link, external project

**Command journal**:
The last fifty reversible commands one account ran on one project, held on the server in
the order they happened. One stack per account per project — undo is personal, and
reversing somebody else's change because it happened to be the newest is not undo. Not
the plan history: see that term for the five ways they differ.
_Avoid_: history, audit log, activity, event log

**Plan history**:
Every command anybody ran on one project, kept — the plan's own record, per project
rather than per account, added to and never edited, and thinned only by age. It is not
the command journal, which is one account's fifty-deep undo stack and drops what it must
to stay one; and it is not the event log, which is the websocket's resume buffer.
_Avoid_: audit log, activity feed, changelog, journal

**Plan event**:
One row of the plan history: a command that happened, the sentence describing it, the
work item and step it was aimed at where it had one, and the two commands the journal
holds — what it did, and what would undo it. It names its work item without depending on
it, so it survives the row's deletion.
_Avoid_: history entry, audit record, revision

**Compensating command**:
The command that reverses another one, carrying the before-state it needs — the old field
value, the removed trio, the whole deleted subtree. Applied through the same paths any
mutation goes through, so it is an ordinary write that happens to restore.
_Avoid_: inverse operation, rollback, revert

**Precondition**:
The revisions a command left every entity it touched at, checked before that command is
reversed or re-applied. All of them must still hold; one that does not is a refusal, never
an overwrite.
_Avoid_: guard, expected version, if-match

**Stale undo**:
An undo or redo refused because something it touched has been written to since. The entry
is discarded — its preconditions can never hold again — and the reader is told which
change stood in the way.
_Avoid_: conflict, rejected undo, out of date undo

**Command batch**:
One request carrying an ordered list of plan commands — creates, patches, moves, estimates,
dependencies, directory entries — applied all or none in one transaction and written to the
command journal as one entry, so one undo puts the whole of it back. A batch of one command
is that command.
_Avoid_: bulk update, transaction (for the request), operation list, macro

**Ref**:
A name a batch gives to an entity it creates, so a later command in the same batch can point
at it before an id exists. Lives only inside the request that minted it; the response says
which id each ref became.
_Avoid_: temp id, client id, placeholder, alias

**Write lock**:
The one-at-a-time rule every be-01 write waits behind while a command batch is open, because
the server has one database connection and a batch holds a transaction on it across awaits.
Reads never wait.
_Avoid_: mutex, semaphore, queue, serialization

**Restricted project**:
A project only its owner may edit. Every authenticated account may still read it; an
unrestricted project may be edited by any of them.
_Avoid_: private, locked project

**External ref**:
One link out of a work item to where that work also exists — an external system and a URL,
in the order the refs were added. A work item may hold several into one system, because two
pull requests are two links. Nothing about it is fetched: a ref is an address, never a
status. Always said in full — the bare **Ref** above is the batch-scoped name, and they are
different things.
_Avoid_: link (alone), reference, external link, integration

**External system**:
The name an external ref's target belongs to — `jira-issue`, `github-pr`, `github-issue`,
`confluence-page`, `slack-message`. A directory-wide vocabulary, unique by name, seeded with
exactly the names the URL rules can derive. Derived from the URL when a ref is written and
**stored**; nothing re-derives it on read, so a ref keeps the type it was given when the
rules later change.
_Avoid_: provider, integration, source, kind

**Ref mark**:
One dot in the plan's Links column, standing for a **family** of external systems a row
links to rather than for a link. Four GitHub pull requests are one mark; a fifth family
collapses into an overflow mark. Told apart by fill as well as by hue, and named for a
reader who sees neither.
_Avoid_: dot, badge, icon, chip

**Write stamp**:
Who is acting and the instant they are acting, carried together into every write. Built
once per act in the service layer, which is the only layer holding both, and passed to
the store as one argument. One act carries one stamp however many tables it touches, so
two rows written by one act never disagree about when it happened.
_Avoid_: audit context, metadata, timestamps, actor (alone)

**Audit columns**:
The three columns every stored record carries: `created_at`, `updated_at` and
`created_by`. On a row nobody has changed since making it, the first two are equal.
_Avoid_: bookkeeping columns, tracking fields

**Unattributed row**:
A row written before the audit columns existed, whose `created_by` is null. Not a row
with a missing value to be filled in later — its author is unknowable rather than
unknown, which is why nothing substitutes for it.
_Avoid_: orphan row, legacy row, anonymous row

### Architecture

**Port**:
An interface core owns and an adapter satisfies: every store, the unit of work, the gate, the
clock, the broadcaster, the identity resolver, and every runtime concern — password hashing,
token signing, digest, timers, push transport, scheduler. Named for what the
caller wants, never for what implements it. ADR 0014.
_Avoid_: abstraction, contract (for this), interface (alone)

**Ring**:
A dependency direction across Nx projects, stated as a tag and enforced by the module-boundary
rule: domain (vocabulary, contracts, validation, logging types, config shapes), application
(core), adapter (sources, runtime adapters, auth, realtime, the solver, every app). Every
project has exactly one. A project depends only on its own ring or inward. Not a folder: a
layer is a folder inside one project.
_Avoid_: layer (for this), tier (that is a deployable process), level

**Adapter**:
A concrete thing that satisfies a port: a drizzle repository, an in-memory store, the Elysia
mount, the browser digest. `Repository` is the SQLite adapter's suffix and means nothing
outside that source.
_Avoid_: implementation (when the seam is the topic), driver, provider

**Source**:
A set of store adapters (the event log included), a write coordinator and a unit of work,
opened, health-checked and closed together: SQLite and in-memory are the two. A source may
offer a subset of the store ports and is certified for the ones it offers by the conformance
kits, and not otherwise.
_Avoid_: backend, database, persistence layer, data layer

**Write coordinator**:
The source's queue of turns: every transactional writer asks for one through its gate, and
a unit of work holds one through its batch and any repair; independent saved-plan operations
are outside this queue.
Keyed as the source needs — the process for one-connection SQLite, the project for a Postgres
advisory lock. Nothing that holds a turn ever asks for another.
_Avoid_: write lock (as the port's name), mutex, semaphore, re-entrant lock

**Gate**:
What a store adapter asks for a turn through. Either the source's write coordinator, or the
open gate, which grants at once because the caller already holds an admitted turn. A store
does not know which it has.
_Avoid_: lock handle, guard, admission

**Scope**:
The transactional stores a caller may use during one admitted turn, belonging either to a
batch or to its post-rollback repair. Independent saved-plan operations are outside that
scope; a repair belongs to the surviving state, not the refused batch. ADR 0015.
_Avoid_: transaction context, batch context, ambient stores

**Unit of work**:
The port that makes a batch's writes observable together or leaves none of them after it
settles; an explicitly declared post-rollback repair is a separate surviving act. It promises
terminal atomicity, not isolation from concurrent readers. ADR 0015.
_Avoid_: outer transaction (as the port's name), transaction handle, session

**Endpoint shape**:
One HTTP route's contract — method, path, operation id, request policies, request and response
validators, matching document schemas, and modeled refusal statuses — with no handler. A client,
an OpenAPI document and an MCP tool share this contract.
_Avoid_: route (for this), spec, contract (alone)

**Endpoint**:
An endpoint shape bound to one pure handler that returns an `HttpReply`, which an adapter
mounts on a framework. The handler never sees the framework. Every shape has exactly one
endpoint.
_Avoid_: controller, route handler, resolver

**Refusal**:
An endpoint's modeled rejection, carrying a code and its detail, including validation,
throttling and temporary unavailability; redirects and unexpected failures are not refusals.
`engine_unavailable` means the project's chosen schedule engine has no adapter here and
nothing schedules in its place.
_Avoid_: error response, problem, fault (for this)

**Request policy**:
A rule the adapter applies to a request before its body is parsed and before the handler
runs: an origin policy, or an identity policy naming `signed-in`, `read-scope`,
`write-scope` or `internal`. Stated per endpoint; a handler never checks identity or origin
itself.
_Avoid_: guard, caller requirement, middleware (for this), auth level

**Conformance kit**:
A test suite exported as a function of a factory, one per port, so a source or an adapter is
held to a port's contract by one file that calls it; a source's certificate is the composition
of the kits for the ports it offers. Every case in a kit was watched failing against an
implementation that lacks the behaviour it names.
_Avoid_: contract tests (alone), shared tests, test harness

**Product**:
One application family in this repository — WBS is the first — named by a top-level directory,
a project-name prefix and a `product:` tag that keeps one product's code out of another's.
Tools belong to no product.
_Avoid_: app (that is one deployable), workspace, scope (that is an Nx tag axis already in use)

**Composition root**:
The one place ports are bound to adapters and services are built, in core, called by be-01
over the SQLite source and by tests over the in-memory one. The batch runner calls its
services half again over a scope.
_Avoid_: DI container, wiring file, bootstrap (for this)

### Deployment

**Environment**:
One complete, independently deployable copy of the three tiers on a host, identified by
`WBS_ENV`. `prod` and `dev` are the two that exist.
_Avoid_: stage, instance, deployment (as a noun for this)

**Environment root**:
The directory on the remote host that holds one environment's compose files, rendered
Caddy site, tier state, secrets and data. `/home/puni1/wbs` for `prod` and
`/home/puni1/wbs-dev` for `dev` (ADR 0002). `/srv/wbs` is a stale rollback copy: reading it
shows an environment that has not moved since 2026-08-04.
_Avoid_: srv dir, deploy dir

**Deploy trigger**:
The unattended process on the build host that decides a commit should be deployed to an
environment and invokes the deploy. It never decides anything about `prod`.
_Avoid_: poller, watcher, CD runner

**Colour**:
Which of the two interchangeable slots (`blue`, `green`) a tier's current container
occupies. Each tier holds its colour independently of the others.
_Avoid_: slot, side, version

**Tier**:
One of the three deployable services: `be`, `gw`, `fe`.
_Avoid_: app, service, component

**Engine**:
Which schedule a project displays: `Fast`, the deterministic millisecond pass that always
runs and is always the fallback, or `Optimized`, a stored solver result. A project-wide
persisted setting, never a per-user view state, and never an input to the Input hash.
_Avoid_: mode, scheduler type, solver toggle

**Objective**:
Which ordering an Optimized schedule was solved for: `Priority-first` (PRI) or
`Finish-first` (Time). Project-wide and persisted like Engine, and a cache dimension rather
than an Input hash input — both are solved, and Objective picks which stored one is shown.
_Avoid_: strategy, goal, optimization mode

**Input hash**:
The SHA-256 of the canonical JSON of the exact argument tuple `schedule()` receives — rows
with `position`/`frozenNumber`/as-written priority, authored dependency edges, the slice
array grouped by work item with groups ordered by id and each group's own order preserved
(only that intra-item order is step precedence — the order between groups is whatever SQL
returned), `notBefore` floors in days from day zero,
pool sizes, and the project's dependency reach. Two scheduling inputs are the same exactly
when their hashes match. Engine, Objective, the optimization toggle, the display variant,
the clock, the acting user and the solver budget are all excluded from the hash. Three of
them — Objective, Contract version and the solver budget — are cache-key columns instead;
the clock, the acting user, the toggle, Engine and the display variant are read by nothing
that produces a schedule and appear nowhere in the cache identity.
_Avoid_: plan hash, cache key, fingerprint

**Contract version**:
The cache-key column identifying the code that produced a stored result: the domain
`SCHEDULER_CONTRACT_VERSION` joined to the `wbs-solver` package version. Both are needed
because durations, the leaf expansion and the Baseline schedule come from domain code that
the Python package version does not describe.
_Avoid_: solver version, schema version, cache version

**Generation**:
A monotonic optimization counter held per `(project, Contract version)` in the
`optimization_generation` table — not on the project row, because a canonicalizer bump
would otherwise let two coexisting releases increment one counter against each other for
ever. It is stored beside the Input hash it was allocated for and carried by every solver
run. The pair is what makes allocation atomic across processes: an equal hash reuses the
generation, a different one increments it under a compare-and-swap. Every cache write is conditional on it still being current, so a
superseded run cannot store, evict, or broadcast — which an Input hash alone cannot
prevent, because an undo can make an old hash current again.
_Avoid_: run id, epoch, version

**Optimizer floor**:
The `ScheduleFloor` member `optimizer`, reported when an optimized start is strictly later
than every floor of its slice — including the person and capacity floors, so a slice
delayed because its assignee or team was busy keeps that explanation instead — the optimizer deliberately idled it so higher-priority work
could run. It is the only floor that names a choice rather than a constraint, and like
`projectStart` it carries no capacity predecessors and no binding team.
_Avoid_: idle, slack, deliberate delay

**Solver quantum**:
`SOLVER_QUANTUM = 48`, the number of integer solver units in one workday. It exists because
Fast's durations are genuinely fractional — a width-two one-day slice is 0.5 workdays — and
CP-SAT interval variables are integers. Durations round **up** to the next unit when an
estimate does not divide, never down — which is what makes every quantised-feasible
solution real-feasible. Because rounding up can also put real Fast's value out of reach
(three serial `days=1, width=5` slices finish at 28.8 units but need 30 rounded), the
solver's hint and bound come from the Quantised baseline, never from real Fast.
_Avoid_: tick, granularity, resolution

**Quantised baseline**:
Fast's own placement re-run over the rounded durations, in integer solver units. It is what
the solver receives as `fastHint` and `baselineOffsets` and what bounds the first stage,
because it is feasible in the model the solver actually gets. Distinct from the Baseline
schedule, which is the real-domain Fast result the publication guard scores against.
_Avoid_: rounded Fast, hint schedule

**Cancel epoch**:
A counter carried by each `(project, Contract version)` generation row, advanced when
optimization is switched OFF — an OFF transition advances every one of that project's rows.
It exists because the toggle is excluded from the Input hash, so an OFF transition cannot
advance the Generation that allocation is required to reuse. **Worker-owned outcome writes**
are conditional on it, together with the current generation, the toggle and the writer's own
attempt token; allocation eviction is authorised instead by the winning generation CAS, OFF
cleanup by its own epoch increment, and deletion/retirement eviction by the cancel-and-drain
protocol — none of those three holds a child token, so a universal predicate would make them
unimplementable. Owners observe the epoch on their slot heartbeat, so a child owned by
another backend process is cancelled too.
_Avoid_: cancel flag, kill switch, generation bump

**Attempt token**:
The unforgeable 128-bit value minted when a solver slot is admitted — stamped into the
`starting` row, handed to the Lifecycle launcher as `--attempt-token` argv, and the
predicate of the bind CAS beside `lifecycle = 'starting'` — and thereafter carried by that
owner's heartbeat, release, result write and event write. It is the fence that stops a
superseded owner — one whose slot expired and was re-admitted to someone else — from
binding, refreshing, releasing or writing over the replacement.
_Avoid_: lease id, lock, owner id

**Baseline schedule**:
The real-domain Fast schedule for the same canonical input, with fractional `days / width`
intact. It never crosses the solver wire: that is the Quantised baseline, which also supplies
the movement reference. Its only consumer is the real-domain publication guard in task 4.11b,
which scores a materialised optimized result against it before storage.
_Avoid_: current schedule, published schedule, previous plan

**Optimized result**:
What a cache row stores — `{ dtoVersion, publication, objectiveValues, schedule }` — never a
bare `Schedule` and never the solver's offsets map. `publication` is `solver` or
`quantisation-floor`, and `objectiveValues` is what records how far a partially staged run
got; `Schedule` carries neither, so a row holding only a schedule silently discards both.
_Avoid_: cached schedule, scheduleJson, stored plan

**Stage value**:
The incumbent a lexicographic stage found, reported beside the published schedule's own
recomputed `value`, and never confused with it. A later stage constrained by `T <= stageValue`
may return a strictly better `T`, so `value` is what Bun re-validates and `stageValue`,
`bound` and `status` describe the stage that produced the constraint.
_Avoid_: objective value, incumbent, best value

**Publication**:
Which schedule a cache row actually holds — `solver` for a solver result, `quantisation-floor`
for Fast's own schedule republished because the quantised solve could not beat it. It is a
field of its own and never a value of `ObjectiveValue.status`, whose domain is the three stage
outcomes; a floor row's `value` terms are recomputed in the real domain on the stored Fast
schedule with `stageValue` and `bound` null.
_Avoid_: floor status, fallback result, Fast result

**Admitted deadline**:
The absolute instant a solver slot expires, stamped into the row at admission from the
**admitting** coordinator's own budget (`startedAt + budgetMs + 5000 + SLOT_RECLAIM_MARGIN_MS`).
Reclamation reads it and never recomputes it, because co-existing releases may run different
budgets and an observer applying its own would reclaim a child still inside its deadline.
_Avoid_: slot TTL, heartbeat timeout, expiry window

**Lifecycle launcher**:
The distinct entrypoint the coordinator spawns for an admitted slot — never `wbs-solver`
itself. It loads no CP-SAT and solves nothing. Its lifecycle wrapper reads the clock once to
convert `--child-deadline-epoch-ms` into CP-SAT's `max_time_in_seconds` — the in-process half;
the load-bearing half is the per-child scope's `RuntimeMaxSec` kill at that same instant, since a
Python alarm cannot preempt a native solve under the GIL — installs `PR_SET_PDEATHSIG`, re-checks
`getppid()`, and then blocks for the bind verdict before it touches the request at all. On
`bound` it `exec`s `wbs-solver` in place, keeping the pid the bind CAS recorded; on `abort`,
a closed stdin, `BIND_TIMEOUT_MS` expiry, or a `bound` verdict arriving when the child deadline
has already passed it exits **without** `exec`ing. That is what
makes the ceiling literal: a process named `wbs-solver` cannot exist before its row is
`running`, so a delayed spawn after reclaim creates no uncounted solver.
_Avoid_: shim, supervisor, solver wrapper — "lifecycle wrapper" is the launcher's own
clock-reading part, not a second process, and the two are not interchangeable.

**Slot lifecycle**:
The `solver_slot.lifecycle` column, `'starting' | 'running'`. Admission inserts `starting`
with a null `pid`; a successful bind CAS moves it to `running` and records the launcher's
pid. A `starting` row counts against the 4-per-project and 16-fleet ceilings exactly like a
`running` one — it _is_ the reservation — and is reclaimed by the same
`now > admittedDeadlineAt` rule.
_Avoid_: slot state, pending, provisional
