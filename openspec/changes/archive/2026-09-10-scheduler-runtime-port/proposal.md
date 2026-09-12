## Why

The remaining core extraction still depends on the optimizer's SQLite and process types.
The ports plan explicitly deferred its Scheduler boundary and engine-unavailable behavior.
A process without an optimized adapter currently lets a stored optimized project read Fast
without an availability refusal, while an installed optimizer's pending/failed results are
a different, already-modeled state. Core needs that distinction without depending on a driver.

## What Changes

- A synchronous scheduler-reading port takes the complete canonical input and explicit
  project selection. Reading never waits for a solver process to finish.
- Missing selected optimized capability is an `engine_unavailable` result, mapped to 409
  on live reads and exports. Installed pending/failed optimization retains its visible state
  and the existing Fast baseline policy.
- SQLite owns input hashing, cache interpretation and atomic outcome/event storage;
  the process adapter owns supervision, admission and lifecycle.
- Detached saved-plan capture consumes the same selection rules without starting a solve;
  absent schedules retain a typed reason and stored history is never recomputed.

## Non-Goals

Rewriting the solver, changing scheduling mathematics, new browser UI mode, changing
supervisor limits/host authority, migrations, or implementing unfinished scheduler features.

## Constraints

Land after the intersecting dual-optimized-scheduler interfaces settle and before core's
scheduling consumers move. Preserve contract version 8 unless mathematical semantics change;
preserve `contractVersionOf(solverVersion)` and existing cache hash bytes. No silent engine
substitution and no modeled refusal as a 500. Preserve independent saved-plan history.

## Capabilities

### New Capabilities

- `scheduler-runtime-port`: explicit installed scheduling capabilities and portable reads.

### Modified Capabilities

- `wbs-domain`: selected-engine saved/current schedule capture and truthful identity,
  explicitly amending the earlier Fast-only requirement. Sync its saved-plans base first.

## Domain Terms

Existing Schedule engine, Source, Refusal and Port.

## Decisions Recorded

[ADR0014](../../../docs/adr/0014-ports-live-in-a-framework-free-core-lib.md),
[ADR0018](../../../docs/adr/0018-adapter-transactions-stay-outside-core-ports.md),
[ADR0022](../../../docs/adr/0022-scheduling-reads-do-not-wait-for-solves.md).

## Impact

Core scheduler types, be-01 scheduling/capture/composition, SQLite cache helpers,
contracts' refusal descriptors, frontend query/refusal states and their integration tests.
