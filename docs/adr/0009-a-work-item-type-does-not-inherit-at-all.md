# A work item type does not inherit at all

**Status:** accepted, 2026-08-30. Third and last answer to the inheritance
question first recorded as "Q4, Dany, 2026-08-13", alongside
[0008](0008-tags-accumulate-down-the-tree.md). Read the two together: they were
decided a day apart, about neighbouring dimensions, and either one alone reads
as an inconsistency.

A work item's types are **its own, and only its own**. A row with no types has no
types — not its parent's, not its ancestors' unioned. There is no
`effectiveTypesOf` beside `effectiveTagsOf` and `effectiveTeamsOf`, and its
absence is load-bearing rather than an omission.

The plan therefore holds three different answers to "what does a row inherit
from its ancestors", one per dimension:

| Dimension     | Rule                                             | Because                                                |
| ------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Team, service | **Override** — own set instead of the ancestor's | One answer at a time; a row naming its own has decided |
| Tag           | **Accumulate** — own ∪ every ancestor's          | A child of a `Risk` parent is still risky              |
| Type          | **Neither** — own, or nothing                    | A child of an `Epic` is emphatically not an `Epic`     |

Three answers to one question is the shape this repo normally treats as a smell,
which is exactly why it is written down rather than left to be discovered in
three walks.

## Why

The type dimension breaks the rule that makes the other two work. Teams and tags
are both statements that stay true as you descend: whoever owns the parent
plausibly owns the child, and whatever kind of thing the parent is about the
child is about too. That shared property is what lets 0008 pick union and the
2026-08-13 answer pick override — the two disagree about _how much_ survives the
descent, but both assume something does.

A type says what a row **is**, and a hierarchy exists precisely so that a row and
its children are different things. `Epic` is the clearest case: an epic's whole
meaning is that it decomposes into work that is not an epic. Under override, an
`Epic` parent would make every unset descendant an `Epic` — the tree would report
one epic containing eleven more. Under 0008's union it is worse, because the
child cannot escape by stating its own: a `Story` under an `Epic` would be an
`Epic` _and_ a `Story` at once, and the filter would find it under both.

So the question is not which of the two existing rules to copy. Both are wrong
here, and picking either because it already exists would be the shape of the code
deciding the shape of the domain.

## Considered options

**Union, matching tags (0008).** Rejected above: it makes a Story an Epic and
gives no way to say otherwise. This is the option to re-examine first if the
decision is ever revisited, because the pull to make the two set-valued
dimensions behave alike will be strong and it is wrong for this reason and not
for a structural one.

**Override, matching teams.** Rejected: it inherits `Epic` down the tree, and
"unset" would have to mean "same kind as my parent", which is false about the
only vocabulary anyone will actually load.

**Single-valued, one type per row, as a `type_id` column.** This is what a Jira
issue type is, and it was rejected on Dany's explicit call (2026-08-29) that a
row may carry several the way it carries several tags. Recorded because it is the
option a reader coming from Jira will expect, and because it is the one this
schema could not accommodate later without a migration that is not additive.

**Inheriting only some types — an `Epic` stops, a `Regulatory` descends.**
Rejected as a per-name rule inside a dimension. It would mean the vocabulary
carried behaviour, which the change's non-goals rule out ("a type deciding
anything — no colour, no schedule effect, no default"), and it would put the tool
in the position of knowing what somebody else's taxonomy means.

## Consequences

- The Type cell draws only stated chips. Every chip is removable, because every
  chip is stated on the row you are looking at — unlike the Tags cell after 0008,
  where an inherited chip is outlined, muted and carries no ✕.
- A blank Type cell means "nobody has said", and there is no second spelling of
  it. This is the one place the type dimension is _simpler_ than the other three
  rather than more complex.
- The type facet lists what the plan's rows state. No row is found under a type
  it does not carry itself.
- The export prints types with no provenance, because there is no provenance to
  print. 0008's `Risk (inherited from 010 Compliance)` has no analogue here.
- Nothing about dates changes. A type is not a pool and not a size, and
  `libs/domain/src/schedule.ts` had an empty diff. Its current location is
  `libs/wbs/domain/domain/src/schedule.ts`.

## The assumption, marked as one

Dany asked for the dimension and for it to be set-valued. **He was not asked
about inheritance, and this is my reading on his behalf**, in the same way 0008's
union is 0c's reading of "when i added new tag to 010.1 it stopped showing the
ones it inherited (??) fix it". The Epic argument is what I would defend it with
and I believe it is right, but nobody has said it out loud yet.

If it is wrong, the cheap direction is to add inheritance later: the schema
stores only stated rows, so a walk can be introduced over the same tables without
a migration. Going the other way — un-inheriting a dimension whose stored data
has come to assume inheritance — is the expensive direction, which is why the
uncertain call is made toward the smaller commitment.
