# Verify — `multi-team-engine` (R2-2)

Branch `change/multi-team-engine`, base `main@30e8c4c`. **Prod mode**
(`notes/delivery-modes.md`): the diff touches `apps/be-01/src/service/schedule.ts`
and the record is the full one. **Not merged** — this one gets a cross-review.

Nothing ran on h1claw. Every number below is h2puni, in
`/home/puni1/wd/puni/wt-multi-team` (a worktree of `~/wbs-reds`).

---

## The gate

`bunx nx run-many -t test lint typecheck` — **Successfully ran targets test,
lint, typecheck for 21 projects.**

| project | result | bun |
|---|---|---|
| be-01 | **750 pass / 0 fail / 62 files**, 38,601 `expect()` | 1.2.20 |
| be-01 | **750 pass / 0 fail / 62 files**, 38,603 `expect()` | 1.3.14 |
| fe-01 | **1,342 pass / 0 fail / 52 files** | 1.2.20 |
| gw-01 | 45 pass / 0 fail / 8 files | 1.2.20 |
| `libs/domain` | 65 pass / 0 fail / 4 files | 1.2.20 |

**Quote the bun version beside the number or don't quote it** — the same tree
prints 38,601 and 38,603 under the two bins on that box (`/usr/local/bin/bun`
vs `~/wbs-dark/.bun-1314/bin/bun`), which is the `capacity-per-project` P3-7
finding, reproduced here. Test and file counts are identical under both.

Baselines at `main@30e8c4c`, from the `table-width-budget` and `priority-bands`
records: be-01 739, fe-01 1,340, gw-01 45, `libs/domain` 65. be-01 **+11**: nine
new cases in `schedule-joint-capacity.test.ts`, one in `schedule-identity.test.ts`,
and `work-item.service.test.ts` net +1 (two new `poolsFor` cases, the `team-sets`
arity refusal deleted). fe-01, gw-01 and `libs/domain` are untouched by the diff
and unmoved.

Also green on h2puni:

- `nx format:check --all` — clean (two record files failed it first; `format:write`
  is what prettier wanted, and `_emphasis_` for `*emphasis*` is the whole diff).
- secrets scan over every tracked file — clean.
- doc caps — clean.
- migration lint over every tracked `.sql` — clean. **This change adds no
  migration**; the seed and the join table are R2-1's, already on main.
- `bunx @fission-ai/openspec@1.3.0 validate --all --json` — **49 passed / 0
  failed** (47 at `main@30e8c4c`; this change adds two requirements).

`/tmp` on h2puni was 21–26% through the run, `TMPDIR=/var/tmp`.

CI: see the bottom of this file.

---

## R5 — the failure-proof table

Every check this change adds, the fault injected to redden it, and what the run
printed. Injections were applied to a clean tree, run, and reverted by
`~/mte-fault.sh`, which reports the dirty-file count afterwards (0 every time).

| # | check | fault injected | observed |
|---|---|---|---|
| 1 | `starts when the later pool frees a slot, not when the earlier one does` | the fixpoint's `window.start > best` written as `<` — the candidate follows the *earliest* pool | 3 pass / 5 fail. `earliestStart` 0 and `boundBy: 'projectStart'` where 5 and `capacity` were owed: a block running while both its pools were full |
| 2 | `names whichever team ran out, not the first of the set` | `capacityTeamId` read as `poolIds[0]` whenever the search bound anything | 6 pass / 2 fail. `"team-alpha"` where `"team-beta"` was owed — a date explained by a team that had room |
| 3 | `takes a slot from every pool it names, so both are busy behind it` | `reserve` narrowed to `poolIds.slice(0, 1)` | 7 pass / 1 fail. `after-beta` at `earliestStart` 0 where 3 was owed, `boundBy: 'projectStart'` |
| 4 | `edges every reservation either pool stepped over, and reports no float it has not got` | the blocking union taken from `binding`'s own sets — the final round's scans, which are empty | 7 pass / 1 fail. `blockersOf(both)` came back `[]` where both holds were owed: a slice claiming a capacity wait and edging nothing |
| 5 | `breaks a tie between two pools on the blocker the reader is looking at` | the latest-finisher clause dropped, leaving the pool-id tie alone | 7 pass / 1 fail. `"team-alpha"` where `"team-beta"` was owed |
| 6 | `names no team on a slice no pool held up` (multi-pool arm of the invariant) | `binding = reached` moved above the fixpoint's `return`, so the final round's set survives | 3 pass / 5 fail. `first role-dev names team-alpha with no pool binding it` — the placement's own invariant |
| 6b | the same invariant, single-pool arm | the single-pool branch's `binding: window.start > floor ? … : []` condition dropped | `schedule-capacity.test.ts` **8 pass / 17 fail**. `a role-dev names team-platform with no pool binding it` |
| 7 | `re-asks every pool from the instant another pool pushed it to` | `jointWindowFor`'s loop replaced by one pass over the pools from the floor, binding condition kept so the invariant stays quiet | 489 pass / 1 fail. `earliestStart` 3 where 6 was owed, `capacityTeamId: "team-alpha"` where Beta was owed |
| 8 | `takes the narrowest stated size, whichever team states it` + `spends in every sized team the row names` | `poolsFor`'s `Math.min` written as `Math.max` | 487 pass / 2 fail. `slots` came back **4** where 1 was owed |
| 9 | the oracle's `capacityTeamId` **name** assertion | the binding pool reported as `wrong-${poolId}` | `capacity-migration-identity.test.ts` 2 pass / 1 fail (`Expected: "team-platform"` / `Received: "wrong-team-platform"`); 483 / 7 across `src/service` |
| 10 | the oracle's **dates** — the identity claim itself | the single-pool arm of `jointWindowFor` made to answer the floor without consulting its pool | `capacity-migration-identity.test.ts` 2 pass / 1 fail. `p1`'s capacity-floored slices moved `earliestStart` 3 → 0 and 3.5 → 1; 475 / 15 across `src/service` |

Faults 9 and 10 are the two halves of the same lift and **each is green under
the other's fault**, which is why both are listed: a wrong team name moves no
date, and a moved date says nothing about the name.

---

## Two vacuous checks, both found by running the injection rather than by reading the code

**1. Nothing in the suite needed the fixpoint to loop.** Fault 7 in its first
form — the joint search cut to a single pass over the pools from the plan floor
— left the whole of `apps/be-01/src/service` at **489 pass / 0 fail**. Every
multi-pool fixture in this change, and the thousand-plan mirrored corpus,
happened to be answerable in one round: in the corpus the two pools are
identical, so the first round's max is already the fixpoint.

The plan a single round gets wrong needs a pool that is free at the floor and
busy at the instant *another* pool pushes the block to. `re-asks every pool from
the instant another pool pushed it to` is that plan — Alpha busy 0→3, Beta free
until a manual date floors its hold at 3 and busy 3→6, so the answer is 6 and a
one-round search says 3. With the test in place the same fault gives 489 / 1.

**2. The `boundBy === 'capacity'` gate on `capacityTeamId` could not fail**, and
neither could the two `binding` conditions under it, because an empty blocking
set left the tightest-pool loop's `-Infinity` sentinel unmoved and the field
null anyway. Faults 6 and 6b both passed — 8/8 and 25/25 — against the first
version of the loop. Fixed two ways at once (design.md D5): the gate became the
invariant `(boundBy === 'capacity') !== (capacityTeamId !== null)`, and the loop
names a binding pool whether or not its blocking set is empty. Both faults
redden now, as the table says.

---

## What the identity claim rests on, and what it does not

**A set of one schedules byte-identically.** Two instruments, and the brief says
to reuse rather than copy them:

- `capacity-migration-identity.test.ts` — the committed oracle captured at
  `050fd45`, 16 plans / 151 rows / all six binding floors / 25 capacity-floored
  slices, replayed through this branch's service. `capacityTeamId` is **lifted
  off every slice and asserted** rather than dropped: non-null exactly on
  capacity-floored slices, and equal to the row's own effective team, which the
  test derives by walking the fixture's own parent chain. Fault 10 is the proof
  it is measuring dates and fault 9 the proof it is measuring the name.
- `schedule-identity.test.ts` — the thousand-plan corpus, already differentialled
  against the pre-slice engine and against the unpooled run, both unchanged and
  both green.

**The multi-pool path has its own corpus differential**, which is what the brief
asks for and what a fixture cannot give: `answers what one pool answered when a
second pool mirrors it exactly`. Two pools of the same size spent by the same
blocks are one pool wearing two names, so the fixpoint must land on the single
search's answer — every date, every blocking set, every float, over 1,000 plans,
with a `contended` counter (>100 seeds) refusing a run in which no pool ever said
no.

**One thing that comparison had to stop doing.** It first used
`expectSameSchedule`, which puts the *oracle* side's float through
`snappedSlack` — a helper that exists to absorb drift between this engine and
the one it replaced. Both sides here are this engine, so the answer owed is the
identical double. It failed at seed 3 on `r0c0g0.critical` while the two runs
were byte-identical: the snap had rewritten the oracle out from under itself.
Replaced with a plain field-by-field `toBe`, which is strictly stronger.

**`priority-band-identity.test.ts` reads the same oracle**, so its `lifted()`
gained the same field. A lift with nothing behind it is a hole, so it asserts
the null/non-null equivalence; the stronger "and it is the row's own team" claim
stays in `capacity-migration-identity.test.ts`, where the ancestry is in hand.

---

## Not proven here, and stated rather than left to be found

- **No plan on the deployment can reach the multi-pool path.** The write path
  writes at most one team (R2-1), so every production set is ≤ 1 and every one
  of the nine multi-pool cases is a fixture. That is the same position C1's
  `boundBy: 'capacity'` shipped in, and it is deliberate: the reader learns the
  shape before the writer produces it.
- **fe-01 is untouched.** `capacityTeamId` reaches the wire because the payload
  spreads the whole slice, but `ScheduleSliceView` does not declare it and
  nothing reads it. Until R2-3, the chart's floor sentence still names the row's
  own team — correct on production data, wrong the moment R2-4 lets a release
  write two. design.md D8; the brief's split already says R2-3 must not merge
  after R2-4.
- **No manual test.** Nothing about this change is visible in a browser, because
  nothing can write the input that would make it visible.
- **No deployment.** No migration, no route, no wire field a client must learn
  to send. `bin/dev-deploy.sh` was not run and does not need to be.

---

## Deployment / blue-green

Nothing to say beyond the above, and that is the point: this change adds no
table, no column and no migration, so the two be-01 processes that share one
SQLite file during a swap read and write exactly what they read and write today.
The only shape that moved is in-process (`Slice`, `ScheduledSlice`), and the one
payload field that moved is additive.

---

## CI

- **Pending at the time this file was written.** Filled in below once the run
  finishes; a run id written before the run exists is not evidence.
