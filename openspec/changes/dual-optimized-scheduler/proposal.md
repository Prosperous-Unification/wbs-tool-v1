<!--
INTENT. Hard cap: 400 words excluding these comments. Change name is proposal.md (OpenSpec CLI hardcodes it).
-->

## Why

The scheduler is one deterministic millisecond pass (Fast) with no notion of optimality. Its dates are usable but never ordered against the two objectives Dany cares about — priority-first and finish-first. He wants an optional mode that computes better schedules with a real constraint solver, leaving Fast the default and the sole fallback.

## What Changes

**Optimization toggle**

- From: one Fast schedule, always computed.
- To: a project-wide hidden toggle, OFF by default. OFF keeps Fast only and cancels solver work; ON publishes Fast, consults the cache, then starts the missing CP-SAT solves — PRI and Time.

**Selection**

- From: no choice of schedule.
- To: Engine (Fast / Optimized) and Objective (Priority-first / Finish-first), persisted project columns selecting which cached result is shown. An already-computed variant re-solves nothing.

**Results**

- From: recomputed in memory each read.
- To: validated results in a durable SQLite cache keyed by project, Input hash, objective, contract version and budget, plus one `status='failed'` marker per failed variant. The row and its `schedule_optimized` event commit together, once per newly stored result, never on a hit.

**Feedback**

- To: one compact indicator — Earlier/Later project deadline by N days, Same project deadline + reordered, Same project deadline + same order, `Optimizing…`, or `Optimization unavailable · Retry`.

**Packaging**

- To: a versioned Python package `wbs-solver` (OR-Tools CP-SAT), a short-lived stdin/stdout CLI.

## Non-Goals

- No daemon, port, sidecar, outbox, or background service.
- No proven-optimality claim — best-found only.
- No timer auto-retry, toast, or modal.
- No per-user objective; the capacity/floor finding stays open.

## Constraints

- Backward-compatible migrations (blue/green share one SQLite file).
- `solverBudgetMs` default 60000; caps of 4 solver processes per project and 16 global, enforced in SQLite so co-existing releases share one budget.
- The Input hash is exactly `schedule()`'s arguments; Engine, Objective, the toggle, the display variant and the budget are excluded.
- Two migrations land under `apps/be-01/drizzle/`, a prod-mode path: reviewed PRs, no self-merge.
- Builds and autotests run on h2puni or CI, never locally.

## Capabilities

### New Capabilities

- `scheduler-optimization`: dual-objective optimization, selection, caching, events, and the indicator.

### Modified Capabilities

- (none)

## Domain Terms

- Seventeen glossary terms added to CONTEXT.md; `design.md` names each.

## Decisions Recorded

- none (settled by Dany; see `design.md`)

## Impact

- be-01 (coordinator, cache, project settings, event), fe-01 (toggle, selectors, indicator), new `wbs-solver` package. Adds OR-Tools to the deploy image.
