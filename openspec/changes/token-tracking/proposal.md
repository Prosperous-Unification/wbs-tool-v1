## Why

Dany, 2026-08-20 23:23: _"estimate token use and then record fact token use for
each task (even each phase/role) … then how many hours was spent on a task. Also
maybe allow to set agent as assignee. I mean mark ppl as agents vs person."_

The plan measures work in days and assigns it to people. Both assumptions are now
wrong at the edges: some of this plan's rows are executed by agents, whose effort
is not a day of somebody's attention but a number of tokens, and whose cost is
knowable to the digit rather than guessed. There is nowhere to write that number
down — not the guess before the work, not the fact after it — and no way to tell
an assignee who is a person from one who is not.

## What Changes

**One table, three figures.** `role_measure (work_item_id, role_id, metric,
value, recorded_at)`, keyed on the pair the estimate and the actual are already
keyed on, with `metric` a `CHECK`ed closed set: `token_estimate`,
`token_actual`, `hours_actual`. Separate rows rather than separate columns, so
recording hours never forces a token figure nobody has. Design D1.

**Unstated is the absence of a row, per metric, never a zero** — the rule
`actual` and `project_team_capacity` follow. Clearing deletes.

**One number, not a trio.** A token estimate reaches no scheduler, so an
optimistic/realistic/pessimistic range would be three numbers nothing folds. D2.

**Hours are recorded, never derived.** No conversion from tokens or days exists
or is invented; the estimate stays days. D5.

**Two routes**, `PUT` and `DELETE
/work-items/:id/measures/:metric/:roleId`, refusing `rolled_up` (409),
`unknown_role` (404), `unknown_metric` (404) and `invalid_measure` (400) —
the shape the actual routes already have.

**Journalled** through `WorkItemService.record` as `set_measure` /
`clear_measure`, so undo and plan history come from H1's seam.

**Rolled up and structure-following** exactly as actuals are: summed on read
through `foldByRole`, handed down on a first child, up on a last, restored with a
branch, not copied into a duplicate, counted before a role removal.

**`person.kind`** — `person | agent`, `NOT NULL DEFAULT 'person'`, `CHECK`ed,
editable in the directory card. A classification reports read; assignment,
capacity and scheduling are untouched. D6.

## Non-goals

**No date moves.** Nothing below `slicesOf` reads any of this;
`service/schedule.ts` has an **empty diff**, watched.

No variance figure (`estimate − fact` is derived by whichever surface shows it),
no export columns, no agent behaving differently from a person, and no migration
of the existing `actual.days` into `role_measure` — D1 says why it is the obvious
next tenant and why not in this change.
