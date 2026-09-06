# Tags accumulate down the tree; teams and services still override

**Status:** accepted, 2026-08-29. Supersedes the tag half of the inheritance
decision recorded as "Q4, Dany, 2026-08-13" and reused unchanged by the `tags`
change — that answer stands for teams and for services. Read alongside
[0009](0009-a-work-item-type-does-not-inherit-at-all.md), decided a day later
about the neighbouring dimension and the **other** way; either one alone reads as
an inconsistency.

A work item's effective tag set is its own tags **plus every ancestor's**,
unioned, with each tag carrying the row that states it. A row that states tags of
its own no longer replaces what it was carrying. Teams and services are
unchanged: a row that states either means that set **instead** of its ancestor's,
and they keep the overriding walk in `libs/domain/effective-label.ts`.

## Why

The 2026-08-13 answer was given about **teams**, and it was right about teams: a
team is who does the work, the scheduler spends that team's capacity, and a row
that names its own team has made a decision that its parent's naming cannot also
be true of. A service is the same shape — what is being delivered is one answer,
and a row naming its own is not adding to its parent's.

A tag is not that kind of fact. It says _what kind of thing this work is_, and a
child of a `Risk` parent is still risky. Under override, adding `Ready` to
`010.1` took `Risk` and `Review` off it — reported by Dany on 2026-08-29 with a
screenshot, and correct behaviour under the rule as written, which is what makes
this a decision to reverse rather than a bug to fix. Every reading surface then
disagreed with the plan: the filter stopped finding the row under `Risk`, the
export printed a blank where the parent's word still applied, and the bar's hover
text said the work was of a kind it was not.

## Three answers to one question, on purpose

0009's table is the record; this is the half of it that is 0008's to defend.

| Dimension     | Rule                                             | Because                                                |
| ------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Team, service | **Override** — own set instead of the ancestor's | One answer at a time; a row naming its own has decided |
| Tag           | **Accumulate** — own ∪ every ancestor's          | A child of a `Risk` parent is still risky              |
| Type          | **Neither** — own, or nothing (0009)             | A child of an `Epic` is emphatically not an `Epic`     |

The line between 0008 and 0009 is whether the statement **stays true as you
descend**. A tag does: `Risk` said of a parent is said of the work under it, so
the child cannot honestly shed it and union is the only rule that keeps the
sentence true. A type does not: a hierarchy exists so that a row and its children
are different things, and under 0008's union a `Story` under an `Epic` would be
both at once with no way to say otherwise. Copying this rule to the type
dimension because the two are both set-valued is the specific mistake 0009 exists
to stop, and copying 0009's rule here would put `Risk` on a parent and nothing on
the work it describes.

## What it cost, and what was considered

**Keeping override and showing inherited tags as decoration** was rejected. The
cell would name words the domain says do not apply, the filter would still not
find the row, and the two would then be two answers to one question — the
stored-versus-effective split this repo has already shipped three times.

**A per-tag "unset" state** — a row explicitly taking an ancestor's tag off
itself — was rejected as the third state the model has refused since teams: a
second spelling of "nobody has said" that every reader has to handle twice. A tag
comes off where it was written.

**One walk with a `union` flag** was rejected. The two rules answer different
questions and only one of them can move a date, so the walks are two files: a
hand aimed at the tag rule must not be able to reach the team's.

The shape cost is real and is the reason this is written down. An overriding
answer has exactly one stating row, so `EffectiveTeams` carries one `fromId`. An
accumulating answer has as many stating rows as it has members, so
`effectiveTagsOf` answers a **list of `{ tagId, fromId }`** and every face that
draws a tag draws provenance per name. `TagLabel` stopped being a discriminated
union for the same reason: `named` and `inherited` are no longer exclusive.

## The identity corpora assert **stated** tags, and must go on doing so

`capacity-migration-identity.test.ts` and `priority-band-identity.test.ts` lift
`tagIds` off sixteen replayed plans and assert `[]` on every row. Under union
that assertion **stays and stays true**, because no replayed row _states_ a tag —
they are lifted from be-01's tree payload, which carries the row's own set and has
never carried the effective reading.

Leave it that way. The corpora are a replay-fidelity oracle: their claim is that
every plan schedules identically across a migration. Assert **effective** tags
there and the file fails on every future change to an inheritance rule, reporting
a rule change as a fidelity regression; and because an effective set is a
function of tree shape, it would also be testing `effectiveTagsOf`'s walk sixteen
times inside a file about migration identity, so a red there could not say which
of the two had broken.

The trap is that the wrong fix is the easier one and leaves the suite green: if
one of those files ever fails on a tag, the fix is never to lift effective tags
into it.

## Consequences

- The Tags cell draws inherited tags as chips beside the row's own, outlined and
  muted and carrying no ✕: a tag is removable only on the row that states it.
  0009's Type cell draws stated chips only, every one of them removable.
- The tag facet matches the union, so a row is found by any word in force on it.
- The export prints the source per name — `Ready; Risk (inherited from 010
Compliance)`. Types have no analogue, because they have no provenance.
- `MOST_TAGS_ON_ONE_ITEM` (50) is unaffected: `work-item.routes.ts` applies
  it to the **stated** set on a write, so no legal plan becomes unwritable. What
  is now unbounded is a **reading** — a deep row's effective set grows with its
  depth — so the cell keeps its one clipped line however many it carries, and the
  facet and the export must cope with a long one rather than assume a short one.
- Nothing about dates changes. A tag is still not a pool and not a size, and
  `libs/domain/src/schedule.ts` still has an empty diff.
