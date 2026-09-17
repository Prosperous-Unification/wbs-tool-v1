# Capacity

How many of a team may be at work at once on one plan, and what stating that
number does to the plan's dates.

Written because nothing else in this repo says it. The capacity program shipped
as four changes — `capacity-engine` (#48), `capacity-write-paths` (#53),
`capacity-ui` (#57), `capacity-per-project` (#58) — and every word explaining it
to a reader lived inside those change folders, which nobody opens to answer
"why did my dates move".

## The one-sentence version

A team's capacity is a **number of slots**. Work labelled with that team spends
a slot per person while it runs, and work that cannot get its slots waits.

## What the number is a fact about

**One project.** Not the team, and not the deployment. Two plans labelled
`Platform` each state their own number for `Platform`, and neither reads the
other's. There is no global default behind the per-project number: a pair the
plan has not stated is _unstated_ and constrains that plan not at all.

This is Dany's call of 2026-08-13 — _"the capacity must be configurable per
project"_, and the sentence that decided the shape, _"The global number should
not matter, only per project capacity configuration matters."_ Before it, a
single number on the team told every project it had the whole team; the reasons
that model was replaced rather than kept as a fallback are
`openspec/changes/capacity-per-project/design.md`, D1.

## Where the number is typed

**The plan's own toolbar → `Teams`.** The dialog is titled _Teams on this plan_
and lists exactly the teams this plan's work is labelled with — including a team
only an ancestor row names, because the leaves beneath it inherit the label and
spend its slots. One box each.

**Not the directory.** The directory page has no project, so a box there could
only ever have meant "the plan you last had open". It keeps names, members and
removal, and it offers no size. C3 did put a box there, correctly, while the
number was still global; C5 moved it.

An **empty** box means _unstated_, not zero. Zero is refused, and it would be a
pool of no slots — a plan of infinite dates. The accepted range is a whole
number from 1 to 1000.

## What it does to the dates

A slice — one leaf work item's work for one role — asks for a **width**: how
many people are on it at once, which is the row's `∥` column and 1 where that
column is blank. Its duration is `effort / width`, and it runs as **one
indivisible block**: it takes all of its slots for the whole of its duration or
it waits. It never starts narrow and widens later.

So, for a team with 2 slots:

- Three independent two-day items, each of width 1 → two start on day 0, the
  third starts on day 2.
- One item of width 2 and 4 days of effort → it runs for 2 days and holds the
  whole team while it does.
- The same item where the team states 1 → the width is clamped to the slots
  that exist. The plan still runs it, at 1, for 4 days.

**Naming a person collapses the width to 1** — one human cannot work beside
themselves — so an assignee on a slice makes that row's `∥` inert for it. The
table's `∥` cell now reads this per **slice**, the same way be-01 does: it
mutes wherever every one of a leaf's estimated roles has its own name, whether
that is one person assumed to cover the lot or several people each named on
their own role. It used to lean on the row-level "one assumed assignee" fact
alone, which went `null` — and the cell un-muted — the moment a _second_ role
got its own explicit name, even though that role's slice had also collapsed to
width `1`. The chart already got this right per bar; the cards still read per
row and are recorded as open, C3's P3 not yet taken.

Naming a person does **not** exempt the work from the pool. The slot is keyed on
the work item's team, never on the assignee's memberships: a team of four never
shows five people at work, and naming somebody from another team on this team's
work does not spend that other team's slots.

An **unsized** team is the state every plan written before this feature existed
is in, and it schedules byte for byte as a plan with no team at all.

## The sentence the chart shows

A bar held back by a pool says, on hover:

> Waits for Platform to free 2 people — after strip (Dev) and 1 other

Read it in four pieces:

- **`Platform`** — whose pool ran out. The row's _effective_ team, so it may be
  a label written on an ancestor rather than on this row.
- **`2 people`** — the slots this bar needed, which is its width. One slot reads
  `a person`.
- **`after strip (Dev)`** — the **display referent**: the latest-finishing of
  the bars that were holding the pool, and the one an arrow is drawn from.
- **`and 1 other`** — how many _more_ bars were holding it. The wait is
  disjunctive — at least one of these had to move — so naming one and counting
  the rest is the only reading that is true, and a card listing five rows is a
  card nobody finishes.

Where the referent's row is collapsed away or narrowed off by a search, the
sentence says `after work that is not shown` rather than papering over it.

**What that sentence does not say** is that the team's size clamped the width —
it is about the wait rather than the clamp. A **second line** on the same card
says the clamp, wherever there was one:

> The team may have 2 at work at once — 3 in parallel not applied

A row asking for 3 people from a team of 2 runs at 2, and that is the line
saying so. It prints only where the two numbers differ, so a plan that got what
it asked for never sees it, and it is silent on work somebody is named on — a
named person collapses the width to 1 on its own, and the line above it says
that instead. At width 1 it is the only thing the card says about parallelism,
which is the case that used to say nothing at all: the compressed line
(`2 people in parallel — …`) does not print for one person.

The export carries the same pair as columns — `People at once` is what was
asked for, `Ran at` is what be-01 placed — and the `∥` cell's `title` hints at
it.

## The three states, one of which has no box

A (project, team) pair is in one of three states, and only two of them are
visible:

1. **Stated** — a number in the `Teams` dialog's box. Bounds the work.
2. **Unstated** — an empty box, or a pair the dialog never listed. Bounds
   nothing.
3. **Remembered** — a number stated earlier, for a team the plan's work is no
   longer labelled with. The dialog lists only teams currently on the plan, so
   clearing the last label carrying a team leaves its number stored with nowhere
   on screen to clear it — and labelling a row with that team again silently
   re-applies it.

The third is defensible as "the plan remembers", and it is the one to reach for
when a capacity appears that nobody typed today. It was recorded in
`capacity-per-project/verify.md` and named nowhere a reader would look until
this page.

## Capacity and priority are different questions

Priority decides which slice is **placed** first. Capacity decides when the
slice already chosen can **fit**. They are not the same sentence, and under
contention they come apart:

> A priority-1 block needing 3 slots can be overtaken by a priority-2 block
> needing 1, because the narrow one fits a hole the wide one cannot use.

That is deliberate. Reserving the earliest feasible window for the wide block
would idle slots that work is available for and finish the whole plan later, for
the sake of a display promise. The argument is `capacity-engine/design.md`, D7.

## Where the code is

| Thing                                  | File                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------- |
| The stored number                      | `apps/wbs/be-01/src/repository/schema.ts`, `projectTeamCapacity`            |
| The lookup the scheduler uses          | `apps/wbs/be-01/src/repository/capacity.ts`, `slotsFor`                     |
| Placement against the pool             | `libs/wbs/domain/domain/src/schedule.ts`                                    |
| Label inheritance, shared by both apps | `libs/wbs/domain/domain/src/effective-team.ts`                              |
| The box                                | `apps/wbs/fe-01/src/components/wbs/teams-panel.tsx`                         |
| The chart's sentence                   | `apps/wbs/fe-01/src/components/wbs/gantt-geometry.ts`, `capacityFloorWords` |
| The chart's clamp line                 | `apps/wbs/fe-01/src/components/wbs/gantt-panel.tsx`, `clampWords`           |

The behaviour is specified in `openspec/changes/capacity-engine/`,
`capacity-write-paths/`, `capacity-ui/`, `capacity-per-project/` and
`capacity-docs/`. Terms are in `CONTEXT.md`.
