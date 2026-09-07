# Optimized scheduler — one place to read the whole state

Written 2026-09-07T20:50Z at the repository owner's request: *"make sure that
all scheduler plans and current work is pushed to a single branch/PR."*

Read this first. It says what shipped, what is open, where the plan lives, and
the one thing every open item is waiting on.

## The short version

**Nothing scheduler-related is unpushed any more.** Every scheduler PR is
merged; the one pocket of local-only work is now on a remote branch (below).
The remaining tasks are not stalled on code — they are all gated behind a
single deploy chain that ends in a decision only the owner can take.

## Shipped and merged

| Task | What it was | PR |
|---|---|---|
| TASK-218 | dual-optimized-scheduler design | — (design only) |
| TASK-219 | dual-objective solver core | [#203](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/203) |
| TASK-254 | invariant 8 does not bound the published priority value | [#203](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/203) |
| TASK-220 | optimized-scheduler coordinator cache | [#216](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/216) |
| TASK-221 | schedule-selector comparison indicator | [#246](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/246) |
| TASK-260 | work-item read order decides tied siblings | [#215](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/215) |
| TASK-261 | scheduler corpus and floor audit case | [#210](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/210) |
| TASK-268 | optimizer retry and hardening | [#253](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/253) |
| TASK-292 | dev deploy broken, missing solver supervisor config | [#250](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/250) |

Verified branch by branch: `change/optimized-scheduler-coordinator` (#216),
`change/schedule-selector-comparison` (#246), `change/task261-scheduler-corpus`
(#210), `change/optimizer-terminal-review-minors` (#276),
`change/deadline-solver-core` (#256), `change/devsync-solver-preflight-outage`
(#250), `change/solver-quantum-pinned-in-schema` (#297) — **every one MERGED.**
They still appear under `git branch -r --no-merged` because the repository
squash-merges, which leaves the branch tip outside main's ancestry even though
the content landed. That listing is not evidence of unlanded work.

## The one pocket of work that was local-only

`/home/claw/wd/puni/wt-optimized-coordinator` held **19 commits on
`change/optimizer-terminal-review-minors` that had never been pushed anywhere.**
They are now preserved at:

**`wip/optimizer-terminal-minors-local-20260907`**, tip `d7bcef41`.

What they contain, by their own subjects: the optimizer admission write fence
and the tests that expose the race, supervisor recovery ownership and its race
tests, `Retry` failure stamping from admission, bounded durable-recovery
artifacts, a centralized durable poller Bun pin, real Docker cleanup edge
coverage, and pruning of interrupted poller candidates.

**Do not merge that branch as it stands.** It is roughly 577 files behind
`main` — `main` has since taken the http-endpoint-port refactor (TASK-347) — so
a diff against `main` reads as tens of thousands of deletions that are really
just main's newer work. `git cherry` marks all 19 as unlanded, but patch-id
equivalence cannot see through the squash merge of #276, so some of them
certainly did land. Anything wanted from it should be re-derived onto current
`main` commit by commit, with each one re-checked against what #276 already
delivered.

## The plan

`openspec/changes/dual-optimized-scheduler/` on `main` — `proposal.md`,
`design.md`, `tasks.md`, `verify.md`, `supervisor-amendment.md`, and
`specs/scheduler-optimization/`. It is the live plan; nothing is missing and
nothing is only on a branch.

`tasks.md` stands at **91 ticked, 20 open**. The open items, by section:

- **1.5** — `SCHEDULER_CONTRACT_VERSION` exported from `libs/domain`
- **2.10** — `horizonUnits > 2**31 - 1` fails before spawn
- **3.4, 3.6, 3.9, 3.9b, 3b.6** — cache migration and the two prod-mode
  `apps/be-01/drizzle/**` slices, each of which must ship as its own reviewed PR
- **5.4b** — bounded CPU and memory per child, with values
- **8.3, 8.4, 8.6, 8.7, 8.8, 8.9** — the compact indicator, its tests, the
  server-side `sameOrder(a, b)` relation, the `schedule_optimization_failed`
  path and its FE mirror, plus one lane-q Browser Use Cloud QA task
- **9.1, 9.2, 9.3** — corpus to ≥1,000 seeds, the Fast corpus, and the known
  capacity/floor hand-off audit finding
- **10.1, 10.2, 10.3** — the h2puni remote gate, terminal peer review, and
  slices 3 and 3b shipping as reviewed PRs

## What is open, and the single thing it all waits on

| Task | P | Lane | State |
|---|---|---|---|
| **TASK-222** scheduler QA | p1 | q | the last gate on the feature |
| TASK-294 optimization-indicator accessibility and polish | p4 | d | PR #268 merged, verify-deploy owed |
| TASK-297 dev poller cannot deploy a fix to its own deployer | p2 | d | — |
| TASK-312 optimizer terminal review minors | p3 | d | — |
| TASK-314 optimization-indicator terminal review follow-ups | p5 | d | — |
| TASK-320 optimizer poller prune record and proof minors | p3 | d | — |

TASK-222 depends on TASK-221 (done), TASK-268 (done) and **TASK-294**. Until
2026-09-07T20:45Z, TASK-294 was `status: blocked` on a re-ask date of
2026-09-08T06:00Z — and a blocked task is excluded from selection entirely, so
it would not have resumed when the deploy cleared and TASK-222 behind it would
have waited indefinitely. TASK-294 and TASK-297 are now `queued` with the
dependency declared instead of a date.

The chain, in the order it must clear:

**TASK-354 → TASK-355 → TASK-321 → TASK-294 → TASK-222**

- **TASK-354** — the poller extracts the target commit's `sync.ts` to
  `/home/puni1/wbs-dev/bin/` and Bun cannot resolve `@wbs/deploy-contract` from
  there; the pinned `12302b8` checkout predates the package, so there is nothing
  to point a `node_modules` symlink at.
- **TASK-355** — 13 `libs/solver-py` files changed between the deployed commit
  and `main`, so the solver supervisor config is a genuine prerequisite and the
  deploy is refusing **correctly**. No durable image exists to pin it to; every
  be-01 image on h2puni is an ephemeral `127.0.0.1:327xx` CI artifact.
  **Publishing is an external action and needs the owner's decision.** The
  `/tmp` precondition that used to block it is cleared: 55% → 24%, under the
  publisher's 25% refusal.

Nothing in the list above is waiting on scheduler code. It is waiting on a
deploy that cannot prove itself.
