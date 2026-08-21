# WBS Tool

The domain glossary for this repo. Terms only — one or two sentences each, defining what
a thing IS. Design decisions live in `docs/adr/`, behaviour lives in `openspec/`.

## Language

### WBS

**Project**:
One work breakdown structure and everything scoped to it — its work items, its roles and
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

**Role**:
A named kind of work a project estimates separately, unique by name within it. Every
project starts with `Dev` and `QA`, and may then be given others, renamed or emptied.
_Avoid_: discipline, type, category

**Role order**:
The order a project works its roles in — `Dev` before `QA` before whatever was added
after them. One order for the whole project, held per role, and the order every list of
them is read in.
_Avoid_: phase order, sequence, priority

**Assumed assignee**:
The person a work item with exactly one assignment is taken to be doing every role's work
for. Read from the assignments rather than stored, so a second one ends the assumption.
_Avoid_: default assignee, implicit owner, cover

**Role usage**:
What a role's removal would take with it: the estimates and assignments that hold it, and
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
_Avoid_: department, squad, group, service

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
Somebody who does work, named in the directory and assigned to a work item's role. Not an
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
one role. A work item with children has no estimates of its own.
_Avoid_: points, effort, sizing

**Trio shorthand**:
One estimate written as one value — `2/3/8`, or `5` meaning all three are five. What a
folded role's cell takes, in place of three boxes.
_Avoid_: quick entry, inline estimate, compact form

**Estimate gap**:
One leaf work item and one role it holds no estimate for. A work item with children never
has one, because its figures are rolled up rather than typed.
_Avoid_: missing estimate, unestimated row, TBD

**Roll-up**:
The sum of a parent's descendants' estimates, per role, computed on read and never stored.
_Avoid_: aggregate, total, computed estimate

**Measure**:
One number somebody typed about one work item, one role and one **metric**, with the
moment they typed it. Rolls up like an estimate; absent, never zero, when nobody typed it.
Days live outside this term — they are the **estimate** and the **recorded days**.
_Avoid_: metric value, figure, datapoint, reading

**Metric**:
Which unit a measure is in, from a closed set: `token_estimate`, `token_actual`,
`hours_actual`. A measure is absent per metric — an hours figure says nothing about
whether a token figure exists.
_Avoid_: unit, kind (which is the person's), measure type

**Token estimate**:
The tokens a role's work on one work item is expected to take. One number, not a trio: no
scheduler folds it, so there is nothing for a range to reduce to.
_Avoid_: token budget, projected spend, cost estimate

**Token fact**:
The tokens a role's work on one work item actually took. Says nothing about whether that
work is finished — completion is the role's **progress**, recorded separately.
_Avoid_: actual tokens, token spend, usage

**Hours fact**:
The hours a role's work on one work item actually took. Recorded, never derived: no
conversion from tokens or from days exists, because neither is one.
_Avoid_: actual hours, time spent, effort

**Dependency**:
One work item waiting for another's anchor slice to finish before it starts; the
predecessor's later roles run in parallel with it. Either end may be a parent, which
means every leaf beneath it. Held once per pair, in one direction.
_Avoid_: link, blocker, edge (outside the graph code)

**Slice**:
One leaf work item's work for one role — the unit a schedule is computed in. A leaf in a
project holding two roles is two slices, run one after the other in role order.
_Avoid_: task, bar, segment, phase, item×role

**Anchor slice**:
A work item's first slice in role order that somebody estimated — the one a dependency
waits on. A role listed in front of it and left unestimated is stepped over. Reordering a
project's roles moves what every dependency waits for. Where nothing is estimated the
anchor is the work item's finish, which for a work item of no days is its own start.
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
important — or absent, which is a state of its own and not a large number. Decides which
of two eligible slices is **placed** first; never overrides a dependency, a floor or a
calendar, and placed first is not started first — a narrow block can take a hole a wide
one of higher priority cannot use. What the number is **called** is the project's own —
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

**Rank**:
A band's position in its ladder, 0 (most important) to 4. What every face keys a band's
colour off, because a label can be renamed out from under one and a position cannot.
_Avoid_: band index, level, tier number

**Eligible slice**:
One whose predecessors have all been placed — its dependencies and its work item's
earlier roles. The set of them is what the schedule takes its next slice from, highest
priority first.
_Avoid_: ready, available, unblocked, frontier

**Binding floor**:
The one thing a slice's start is set by, out of the day the project starts, a dependency,
its work item's earlier role, a manual date, its assignee's last finish, and its team's
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
row. One at a time, from whichever face the pointer is over or a bar holds the focus. The
second thing the two faces share, after the linked scroll, and it moves nothing — nothing
scrolls to a pointed row.
_Avoid_: hovered row, active row, current row, selection, highlight

**Row light**:
The tint a row is painted to say it is being pointed at — one colour for every cause,
because there is one pointer and so only ever one reason on screen at a time. What a
hovered Depends on cell paints the rows it waits for, and what a pointed row is painted.
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

**Assumed span**:
The two workdays an unestimated slice's bar is drawn across, so that a slice nobody has
sized reads as work of unknown length rather than as nothing at all. A property of the
drawing and never of the schedule: the engine's numbers, the date columns and the arrows
between rows do not know about it, and the bar says it is a guess by how it is painted.
_Avoid_: default duration, placeholder estimate, assumed estimate

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
everything under it is the notes. At rest the cell shows the name alone, whole and wrapped;
the notes appear while it is edited and in its hover preview. They stay two fields in
storage — the cell is where they are composed for reading and split again on the way out.
_Avoid_: title field, notes column, description

**Hover preview**:
The rendered reading of one work item, opened over its Name cell from the notes marker on
that cell: the name as a level-one heading, the notes as markdown under it. The only place
notes render; nowhere does raw HTML in either field become markup.
_Avoid_: tooltip, popover, notes preview

**Notes marker**:
The small mark at the right edge of a Name cell whose work item has notes, and the only
thing that opens that cell's hover preview. It says a row has notes; it is not a control —
nothing to click, no focus, no place in the keyboard grid.
_Avoid_: notes icon, badge, indicator, button

**Hover card**:
The instant answer a cell gives to the mouse resting on it: the whole of what its at-rest
face folds away — a folded role's three points and assignee, a depends chip's names. Opens
on enter with no delay, one at a time; the Name cell's hover preview is one.
_Avoid_: tooltip, title attribute, hint

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
Forgetting every column width override and the panel height override for one project, so
each returns to what is resolved for it now rather than to what it was when the override
was made.
_Avoid_: width reset, restore defaults, revert, clear

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
box, its figures, its dates, and one line per phase. Read whole; edited one field at a time.
_Avoid_: tile, row, list item, mobile row

**Mention**:
A person looked up from inside another box, written as `@` and part of their name — in the
folded role cell, where `2/3/8@kat` is one gesture. Held apart from whatever the box is
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
One project written out as a document somebody reads elsewhere — a Markdown table or a CSV
file — headed by what the table alone cannot say: the estimate method by name, whether the
dates are dates or day offsets, and when the figures were taken. Always the whole project,
never the view of it.
_Avoid_: report, download, dump, extract

**Revision**:
A count of how many times one work item or one project has been written to, starting at
zero and never going down. Moves on the entity's own stored fields and on its satellites,
and never on the number derived for it.
_Avoid_: version, etag, timestamp, sequence

**Satellite**:
A row that belongs to one entity, has no identity anyone holds, and is only ever read
through that entity — an estimate, an assignment, a role. Writing one moves the owner's
revision; a dependency has two owners and moves both.
_Avoid_: child row, detail, related record

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
work item and role it was aimed at where it had one, and the two commands the journal
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

**Restricted project**:
A project only its owner may edit. Every authenticated account may still read it; an
unrestricted project may be edited by any of them.
_Avoid_: private, locked project

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
