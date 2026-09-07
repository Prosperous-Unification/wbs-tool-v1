# TASK-325 — solver-supervisor pins a Bun version h2puni has never had

State dump written 2026-09-07T16:00Z at the request of the repository owner, so
the branch carries its own current state.

- **Branch:** `change/solver-bun-measured-versions`
- **PR:** [#288](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/288)
- **Head before this commit:** `f5c9f48479aa922419e734343bf12c6944adb84b`
- **Position:** 2 commits ahead of `origin/main`, 1 behind
- **Queue task:** TASK-325, `status: review`, **prod mode** — merged only after a
  real main-session review, not on green CI alone.

## What the branch does

`install-solver-supervisor` refused any host whose Bun version was not the one
pinned in the install contract — and the pinned version was one h2puni has never
run. The branch replaces that with the measured host versions, and adds a test
holding the contract to what was actually observed rather than to a number
nobody had seen.

## Acceptance criteria

- [x] **#1** The pin's shape is decided and the reason recorded in the file, not
      just changed.
- [x] **#2** A test covers the chosen contract, watched red before green.
- [ ] **#3 SUPERSEDED** 2026-09-07T09:11Z. The dry run could never produce the
      refusal it asked to see: `install-solver-supervisor.ts` returns the plan at
      `if (!args.execute) return plan` **before** `assertSolverSupervisorBunVersion`
      is reached, so the check sits behind `--execute`. Restated: the authorized
      `--execute` run records which listed version the host reported and whether the
      service came up and held its socket, and that observation is added to the
      constant beside the two existing entries. **That run is the only thing this
      task still owes.**

## CI

| Run         | Head       | Result  |
| ----------- | ---------- | ------- |
| 34134802447 | `f5c9f484` | success |
| 34127739638 | `708825d8` | success |
| 34124316781 | `70a576f2` | success |

Green at `f5c9f484`. **Adding this dump moves the head**, so the green above no
longer sits at the tip and CI re-runs; the merge gate is green at whatever head
the reviewer reads, not at `f5c9f484`.

## For the reviewer

The three highest-value checks, as raised by the review seat on the earlier
round:

1. That the constant's comment is honest about what `--preflight=dev` proves —
   module load and config decode, and not more.
2. That the refusal path is reachable at all in the shape it is now tested in,
   given AC #3's finding that the dry run returns early.
3. That the measured versions recorded in the constant are the ones the host
   actually reported, traceable to the run that reported them.

## What remains

1. The authorized `--execute` run on h2puni, to close AC #3.
2. Re-read CI at the head this commit creates.
3. Prod-mode review, then merge.
