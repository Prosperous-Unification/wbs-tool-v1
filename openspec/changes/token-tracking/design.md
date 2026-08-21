# design — `token-tracking`

Seven decisions. D1 is the one that departs from what the repo has done four
times already, so it carries the counter-argument as well as the argument.

## D1. One `role_measure` table with a `metric` discriminator, not three tables

Three figures arrive together — a token estimate, a token fact, an hours fact —
and all three are the same sentence about the same pair: _somebody says this
role's work on this work item is worth N of some unit_. Written as three tables
they would each need the five-method repository, the `PUT`/`DELETE` pair, the
`rolled_up` / `unknown_role` refusals, the two journalled commands, the roll-up
fold, the hand-down/hand-up/restore/no-copy structure rules, and the role-removal
count. That is seven mechanisms times three, and every one of the twenty-one
copies can drift from its siblings silently — the failure this repo has been
bitten by more than any other.

**The obvious objection is that `estimate` and `actual` are already two tables,
and this contradicts them.** It does not, and the reason is worth stating
precisely: `actual` is separate from `estimate` because folding it in would have
made it a **fourth column on the same row**, and `estimate`'s three columns are
`NOT NULL`, so recording a real actual would have forced a made-up trio beside
it (`schema.ts`, `actual`'s JSDoc). Here the three figures are separate **rows**.
Recording hours writes one row and touches nothing else; a token estimate nobody
gave is one row that does not exist. The NOT-NULL argument has no purchase on a
row-per-metric design, so it does not carry over — and the absence rule, which is
what that argument was protecting, is preserved exactly: the primary key is
`(work_item_id, role_id, metric)`, so absence is per metric.

**What the discriminator costs**, stated so a future reader does not discover it:
the unit lives in data rather than in the type, so nothing in TypeScript stops
`hours_actual` being read where tokens were meant. Two things hold the line —
`metric` is a Drizzle enum for the compile-time half, and a `CHECK` constraint
for the half Drizzle cannot enforce (its enums are erased; a fourth value written
by a hand-edit would be dispatched on by every reader and folded by none, the
argument `role_progress` already makes). Every read path takes the metric as a
parameter rather than defaulting it.

**`actual.days` stays where it is.** It is the obvious fourth tenant, and folding
it in later is a data migration plus a rewrite of a shipped, journalled, tested
write path with live rows behind it on dev and prod. Doing it inside a change
that is adding three new figures would put a migration of real data and an
untested table in one PR, and the failure modes would be indistinguishable. If
this shape proves out, that fold is its own change.

## D2. One number per token estimate, not a three-point range

Days are estimated optimistic/realistic/pessimistic because a weighted final
falls out of the trio and the scheduler consumes it. Nothing consumes a token
estimate — D3 — so a trio here would be three numbers no code folds and no
surface reduces, and the reader would be asked which of the three the variance is
against. One number, one answer.

## D3. Reporting only. Neither the scheduler nor `libs/domain` reads this

Identical to `actual-days` D3, and load-bearing for the same reason: the engine's
input is built from estimates in `slicesOf`, and no read path below it touches
`role_measure`. A token fact is not evidence about a date — an agent that burned
four million tokens on a row may have finished it or may still be going, and the
model's only completion state (`role_progress`) is per role and says nothing
about tokens. Substituting one reading for the other moves every successor's
dates on a claim nobody made.

The check is mechanical rather than sentimental: `apps/be-01/src/service/
schedule.ts` and `libs/domain/**` have an **empty diff** in this change, which
`verify.md` quotes from `git diff --stat`. If a later change wants tokens in the
engine, it argues for it there.

## D4. Absence is the absence of a row; zero is a statement

A role nobody costed is **absent** from the payload, not present as `0`. Clearing
deletes the row. A stored `0` survives, because "this took no tokens" is a real
and rarer sentence — the rule `actual` and `project_team_capacity` both follow,
and the one the export has carried since it was written.

The discriminator makes this rule sharper than a wide row would: recording hours
against a pair leaves that pair's `token_actual` absent, because it is a
different row. A three-column table would have had to invent nullable columns and
then decide whether `NULL` and "no row" mean different things.

## D5. Hours are recorded, never derived

There is no tokens-to-hours conversion and no days-to-hours conversion in this
change, because neither exists as a fact about the world: an agent's tokens buy
no hours of anybody's attention, and a day in this plan is a capacity unit rather
than eight hours of one person. `hours_actual` is what somebody typed, beside the
days estimate that was already there. The estimate side stays days — Dany asked
"how many hours was spent", past tense, and inventing an hours **estimate** to
sit opposite it would be answering a question nobody asked with a number nobody
gave.

## D6. `person.kind` is a column with a default, not a table and not a boolean

One closed-set attribute, one per person, always known: a column. Not a
membership table, because a person is one kind at a time and a join would let two
rows disagree.

**Not a boolean `is_agent`**, because a third kind is plausible enough to plan
for — a shared service account, a team inbox — and each would otherwise be a
migration plus a re-reading of every `if (isAgent)`.

**`NOT NULL DEFAULT 'person'` and every existing row backfilled as `person`.**
This is a stored claim rather than an absence, which the rest of this design
argues against, and the exception is deliberate and narrow: the directory
predates agents entirely, so `person` is not a guess about those rows, it is what
they are. The alternative — nullable, meaning "nobody has classified this one" —
would put a third state into every reader in exchange for a distinction with no
consumer.

**No behavioural difference.** An agent is assigned, scheduled, and counted
against capacity exactly as a person is. What the kind buys today is that the
directory and future reports can tell them apart; what it must not buy is a
scheduler that treats them differently, which D3's empty diff also covers.

## D7. `role_id` does not cascade; `work_item_id` does

Unchanged from `estimate`, `actual` and `role_progress`, and repeated here so the
new table is not the one that quietly differs. A measure is somebody's typing, so
a role removal must **count** it before taking it —
`RoleRepository.remove` deletes measures explicitly inside the transaction that
removes the role. `work_item_id` cascades because during a blue/green swap two
be-01 processes share one SQLite file, and the outgoing release's plain
`DELETE FROM work_item` would hit a constraint it cannot see.

## What this change does not decide

Where any of it is **shown**: the four faces, the export's column groups, and the
history view all read the payload this adds and each is its own change. Variance
(`token_actual − token_estimate`) is derived on read by whichever surface shows
it and is stored nowhere.

Whether an agent assignee ever behaves differently from a person — capacity,
parallelism, working days. This change gives that question a subject; it does not
answer it.

Whether the queue engine writes its own token facts into the plan over MCP. The
brief names it as the point of the exercise and it needs `wbs-mcp` merged first;
the routes this change adds are what it would call.
