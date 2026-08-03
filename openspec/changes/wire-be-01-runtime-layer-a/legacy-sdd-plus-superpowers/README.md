# Retired artifacts — do not follow these

This change was authored under the `sdd-plus-superpowers` schema, which had
seven artifacts. The repo now uses `sdd-lean`, which has four plus one optional.
Two artifacts no longer exist:

| File            | Where its role went                                             |
| --------------- | --------------------------------------------------------------- |
| `brainstorm.md` | merged into the `intent` artifact, which writes `proposal.md`   |
| `plan.md`       | folded into `tasks.md` — there is no separate plan artifact now |

They are kept because this change is 0/33 tasks done and the reasoning in them
is real work, not because they are current. They were moved here rather than
deleted so an agent reading the change directory follows `tasks.md` and does not
start executing a 1684-line micro-plan the schema no longer recognises.

If you resume this change: read `proposal.md`, `design.md` and `tasks.md`. Treat
anything here as background only, and re-derive rather than trusting it — it
predates AGENTS.md, so its slices carry no negative tests and its "done" bar is
not R5's.
