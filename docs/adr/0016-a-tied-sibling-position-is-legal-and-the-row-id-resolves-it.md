---
status: proposed
---

# A tied sibling position is legal, and the row id resolves it

Two siblings may share a `position`. `work_item_siblings`
(`schema.ts:562`) is a plain `index('work_item_siblings').on(projectId, parentId, position)`
with no uniqueness, and `placeAfter` appends at `last + POSITION_STEP` from a group it read
outside any lock (`libs/domain/src/place-sibling.ts:53`), so two appends racing on one parent
both compute the same number. That tie is not inert: `deriveNumbers` sorts each sibling group
with `Array#sort`, which is **stable**, so the order the repository answered in survives into
the derived number, and the number is the third of `goesFirst`'s four tie-breaks
(`schedule.ts:2283`). Whatever breaks the tie decides dates.

**We tolerate the tie and make `work_item.id` its documented resolution.** The alternative —
repair the positions and constrain them unique — was considered and rejected on two counts,
and the second is the decisive one.

- **A migration that rewrites live `position` values does not remove the race.** Uniqueness is
  a property of the stored rows; the collision is produced by two readers of the same group
  computing the same next number before either writes. Repairing today's rows leaves tomorrow's
  append racing exactly as it does now.
- **A unique index converts a silent tie into a failed write on a legal action.** The losing
  side of that race is a user who dragged an item into a group at the same moment as a
  colleague. Today they get a plan whose dates were decided arbitrarily; under uniqueness they
  get an error on an action that is not wrong. Trading a stable arbitrary answer for a refusal
  is the worse deal, and making `placeAfter` re-read under a lock is a different change with a
  different subject.

So the resolution is `work_item.id` ascending, imposed at the read: `listByProject` orders by
it, and that order is a promise the repository makes rather than whatever SQLite chose. Ids are
UUIDv4, so the resolution is **arbitrary but stable**, and stable is the whole property — the
defect being closed is that two reads of an unchanged project could hand Fast two different
argument tuples and produce two different plans. An arbitrary tie-break that never moves is a
schedule; a tie-break that depends on page order is not.

**This costs one visible movement, once.** Every project holding a tied sibling pair whose
current row order disagrees with id order gets different dates on the deploy that ships the
`ORDER BY`, whether or not `optimization_enabled` is set — the read is on the ordinary Fast
path. That movement is measured against the live population and announced before the deploy;
it is not discovered by a user. Projects with no tie are byte-identical before and after,
because with distinct positions the labels come off `position` alone.

Two things have moved since, both in the same direction. The resolution is no longer imposed
only by `listByProject`'s `ORDER BY`: `siblingGroupsOf` sorts on `id` explicitly, so a caller
holding rows in any other order gets the same project (ADR 0023). And a changed sibling group
is respaced to `10, 20, 30…` by an arrangement, which retires whatever ties it held — a
repair where it happens rather than a migration, which is what this decision declined.

Reversing this is cheap: the order is one clause and one index, no stored value changes shape.
That is why it is an ADR about a tolerated defect rather than a migration.
