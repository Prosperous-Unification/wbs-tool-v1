---
status: accepted
---

# A frozen number is a name, not a place

A frozen work item moves like any other and keeps the label that left the tool; a project
is ordered by **tree order** — depth-first, siblings by position, a tied position by id
(ADR 0016) — and never by the number string; unfrozen siblings take the natural labels for
their group skipping any label a frozen sibling holds; Fast breaks a contention tie by tree
order rather than by the number.

Until 2026-09-10 the number string _was_ the order. `deriveNumbers` built labels so that a
byte-wise sort equalled tree order, every reader sorted by that string
(`work-item.service.ts`, `directory-usage.ts`, fe-01's fake), and `goesFirst` used it as
Fast's third tie-break. That only holds while frozen labels ascend along position, which is
what the `frozen` move refusal guaranteed at four call sites. It is also why unfrozen
siblings were fitted _between_ frozen anchors — `0105` between `010` and `011` — through
`below` and `between`, a mechanism that throws outright the moment two anchors leave no
digit-shaped label between them.

**Dany chose movable work items over ordinal numbers** (2026-09-10, in the
`arrange-by-schedule` interview: _"we can freeze the number and still move the item; just
need to figure out how unfrozen numbers will behave"_). The plan being arranged by its
schedule is exactly the plan whose numbers have gone out to tickets, so a button that
refused there would be useless where it was asked for.

The cost is stated rather than hidden: in a sibling group where a frozen work item has
moved, the numbers no longer tell a reader where a row sits. The invariant that survives is
the one that matters — **no two siblings share a label** — and it survives by counting: a
group of _n_ has _n_ natural labels, the frozen ones consume at most as many as there are
frozen work items, so there is always a free natural for every unfrozen one.

Plans with no moved frozen work item are byte-identical before and after, because the
natural labels a group takes are the same labels the old anchor walk produced wherever the
anchors ascend and no label had to be fitted between them. Where a fitted label (`0105`)
exists today it becomes the next free natural, so those work items are renumbered once; that
population is measured and announced before the deploy, as ADR 0016 did for the tie order.

## Consequences

Arranging is one server command, `arrangeBySchedule`, computed inside the write lock from
the selected engine's schedule and journalled as one `set_positions` step whose inverse is
the prior positions verbatim. Not a client-built batch of `move`s: that is capped at 200
commands, orders from a read that may be stale, and replays through `placeAfter` with
`afterId`s that go stale the moment a sibling is added.

Reversing this is not cheap once it has run. `set_positions` entries sit in
`command_journal`, and any plan holding a moved frozen work item has numbers that the old
rule cannot reproduce.
