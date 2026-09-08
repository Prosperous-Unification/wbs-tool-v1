## Context

Ports plan D23 is an unavailable **adapter**, not an installed optimizer whose current
result is pending or failed. `WorkItemService.tree` currently conflates the first case
with Fast; the latter already has explicit variant states and a marked Fast baseline.
The selected engine also reaches export, post-write announcements and saved-plan capture.
This packet resolves those callers rather than leaving their refusal policy to the mover.

The alternatives and accepted boundary are recorded in
[ADR0022](../../../docs/adr/0022-scheduling-reads-do-not-wait-for-solves.md).

The inspected scheduler contract version is already 8. `scheduleInputHash` has multiple
callers, including the coordinator; the old single-caller move description is stale.
This is an extraction and availability change, not another algorithm-version increment.

The inspected feature baseline is `aca7a5c9`, carried by optimization PR #354 or its
successor equivalent. At integration base `main` `14cc7367`, `OptimizedScheduleRead`
still exposes `selectedSchedule`, not the feature's `schedules: { pri, time }`, and the
wire comparison shape differs. Land those feature interfaces before this extraction;
S1 preserves the inspected two-schedule/cue contract rather than implementing that
feature implicitly. Record and recheck the actual landing SHA.

## Goals / Non-Goals

Remove driver/process types from scheduling consumers and fulfill D23. Preserve scheduling
math, cache keys, supervisor lifecycle, authorization and installed-optimizer behavior.
No new scheduling engine, solver protocol, storage migration or offline product mode.

## Decisions

### S1. Reading is synchronous; solving remains asynchronous behind the adapter

Create `libs/core/src/ports/scheduler.ts` after core tasks 2.2b/2.2b.1 establish neutral
value types. The port has the following public shape (named imports are the existing
domain/value types, not schema or cache types):

```ts
interface ScheduleAsk {
  readonly projectId: string;
  readonly input: ScheduleInput;
  readonly engine: ScheduleEngine;
  readonly objective: SolverObjectiveName;
  readonly enabled: boolean;
  readonly mode: 'live' | 'capture';
}

type EngineUnavailable = {
  readonly kind: 'engine_unavailable';
  readonly error: 'engine_unavailable';
  readonly engine: 'optimized';
};

type ScheduleRead =
  | EngineUnavailable
  | {
      readonly kind: 'scheduled';
      readonly fast: Schedule;
      readonly optimization: OptimizedScheduleRead | null;
    };

interface Scheduler {
  supports(engine: ScheduleEngine): boolean;
  read(ask: ScheduleAsk): ScheduleRead;
}
```

`OptimizedScheduleRead`, `OptimizationVariantState` and the shared ask value fields move
from `service/optimized-schedule-reader.ts` into core. They retain the complete current
variant union, both schedules, generation and key identity. `optimizationVariantState`
stays beside SQLite's `CachedOutcome`, not in this port. Unknown adapter failures throw;
only `ScheduleCycleError` has the current domain-cycle interpretation. A `ready` variant
without its schedule is an invariant failure, never Fast.

The `createScheduler` factory in `libs/runtime-portable/src/scheduler.ts` takes a required
Fast function and one optional optimized adapter containing **both** `readLive` and
`readCaptured` callbacks. `supports('fast')` is true; optimized availability is derived
from that single adapter object. Do not pass an independent availability boolean.
Production injects the domain `schedule` wrapper; tests inject literal, argument-recording
functions. Forward all seven `ScheduleInput` fields in domain argument order, including
`poolSizes`, `reach` and authored `deadlines`, without copying or normalizing twice.

An enabled project selecting optimized with no adapter returns `EngineUnavailable`
**before** Fast runs. A disabled project can retain its engine preference and use Fast.
With an installed adapter, live reads call `readLive` with the current enabled flag;
capture reads call `readCaptured`, which never admits work. Both return immediately;
neither may await supervisor completion. Core keeps selection and comparison projection:
selected-ready uses its schedule, other installed states retain today's visible Fast
baseline and optimization metadata. Fast selection still receives both optimized variants
for comparison when enabled; it must not stop background optimization or lose its cue.

### S2. Cache and process ownership

Move `scheduleInputHash` to `apps/be-01/src/repository/schedule-input-hash.ts` initially;
core extraction 3.1 subsequently moves that file to `libs/store-sqlite/src/`. Retarget
**every** import found by `rg`, including tests and coordinator. Canonical serialization
stays in domain and imports no Node module. The function remains SHA-256 over the exact
UTF-8 canonical bytes; budget and `contractVersionOf(solverVersion)` remain separate key
columns. Existing golden corpus and published-row tests are independent byte oracles.

`readCaptured` is a new read-only SQLite adapter function using `readOptimizedPair` for
the exact captured input/project/version/budget key. It normalizes stored outcomes with
the existing variant normalizer and reads current liveness without mutation. It MUST NOT
call `readPlan`, `allocateEnabledGeneration`, `reserveSolverSlot`, enqueue or spawn.
`readPlan({ enabled:false })` is **not** a substitute: it returns idle identities before
reading the cache and would hide a ready capture. A missing generation is legitimate;
malformed stored identity is not.

Process coordination stays in be-01, later `runtime/optimization/`; synchronous cache
decode/hash/normalization stays in SQLite. `storeOptimizedOutcomeAndRecord` retains the
single adapter transaction from ADR0018. Runtime wiring provides matching live/capture
readers from one db/version/budget configuration. Do not change host authority, drain,
retries or solver admission limits. Recheck active feature interfaces at the landing SHA.

### S3. All live callers surface missing capability

Extract the existing successful tree return type as `PlanTree`; change `tree` to
`Promise<PlanTree | EngineUnavailable | null>`. Preserve null for a missing project,
existing cycle rows, sequence-before-rows and every successful payload field. The binding
for `getWorkItems` and both JSON/Markdown `exportProject` paths map the unavailable arm to
409 `{ error:'engine_unavailable', engine:'optimized' }`, before reading success fields.
Add this shape to the exact endpoint replies and shared refusal vocabulary; generated
clients and MCP tools derive it. Existing settings PATCH retains its established
`optimizer_unavailable` spelling and uses `scheduler.supports` as the one capability
source. Do not rename an unrelated published refusal.

`announceTree` is also a caller. After a successful write, an unavailable tree produces
`ProjectEvent { type:'plan_unavailable', error:'engine_unavailable', engine:'optimized' }`
through the normal durable broadcaster. It neither publishes a Fast `tree_replaced` nor
turns a committed write into a 500. Batch collectors still publish once after commit;
refused batches publish nothing. `resourcesFor('plan_unavailable')` invalidates `tree`;
the refetch receives the typed 409 and renders the existing resource-failure state with
the specific message "Optimized scheduling is unavailable in this runtime."
Do not erase a last-installed tree as though it were a successful empty answer, or show
its dates without the existing stale/failure indication. Export failure offers no file.

### S4. Capture preserves the chosen schedule's identity

This deliberately supersedes the active `saved-plans` delta's Fast-only `schedule()`
wording and its assertion that `current` is always present except for a cycle, only
for the engine-selection and absent-state policy below. The complete affected
requirements are repeated in `specs/wbs-domain/spec.md`; sync the eligible saved-plans
base delta before those MODIFIED requirements, without archiving unrelated unfinished
work. Immutable stored bytes, truthful identity, complete schedule-field coverage,
detached authored capture, independent atomic history writes, access and quota behavior
are unchanged. Existing history is never restated under the newly selected engine.

Saved-plan input capture remains independent, detached, and complete before scheduling.
The canonical input body's existing schema/bytes are unchanged. Scheduler selection
comes from the detached `PlanInputReads.project`; its optimization preferences are not
added to that body's currently enumerated settings. Consequently a preference-only change
can leave canonical input equal while schedule identity/presence differs; that difference
is reported by the existing schedule comparison. This is an explicit compatibility limit,
not a claim that the old input schema captures every new optimizer setting. An input-schema
evolution and normalization of historical bodies is outside this extraction.
Replace the optional Fast-only scheduler callback with required Scheduler; share a pure
`scheduleInputOfCaptured(reads)` with the current `schedulePlanInput` derivation. Current
live canonical parts and captured parts must agree on literal fixtures; do not reuse an
expected value derived by the helper under test. Ordinary saved reads/diffs still use
stored bytes only and never invoke any scheduler.

For `save` and `current`, apply this closed policy to detached input:

| Selection/state                             | Captured schedule                      |
| ------------------------------------------- | -------------------------------------- |
| Fast or disabled optimization               | Fast, existing `SCHEDULE_ALGORITHM_ID` |
| enabled optimized, no adapter               | absent `unavailable`                   |
| enabled optimized, selected ready           | that optimized schedule, never Fast    |
| selected idle/pending/retrying              | absent `pending`                       |
| selected failed/corrupt                     | absent `unavailable`                   |
| selected plan-infeasible, or a domain cycle | absent `infeasible`                    |

Absence is the saved-plan contract's visible degradation, not HTTP success pretending
to contain dates. Input history can still be saved; current returns the same typed
absence. A selected zero-work plan with no stored solve is pending rather than invented
optimized output. This packet does not schedule an empty solver job to remove that state.

Make `buildScheduleBody` accept the actual algorithm identity. Keep the Fast identity
byte-for-byte; optimized identity is
`optimized:<contractVersion>:<objective>:<budgetMs>` (decimal integer milliseconds),
derived from the returned cache key. Store that identity in both body/header and pass it
through `current`. The schedule body's schema stays version 1: its existing algorithmId
is a string, and algorithm changes are already distinct from shape changes. Old saved
rows remain untouched. No fallback to the current runtime identity while reading history.

## File Map and Migration Plan

Scheduler packet executes between core's neutral contracts/runtime extraction and its
work-item/saved-plan consumer moves: core 2.2b–2.2b.4 → this packet → core 2.2c onward.
It initially edits be-01 service/controller/repository paths; core later moves them using
the same basenames. New files: core `ports/scheduler.ts`, runtime-portable `scheduler.ts`,
be-01 `repository/{schedule-input-hash,captured-optimization-reader}.ts`, and their tests.
Update be-01 `services.ts`, `boot.ts`, `service/{work-item.service,saved-plan.service,
saved-plan-schedule,saved-plan-schedule-body,broadcast,optimizer-wiring}.ts`; contracts
`http/{endpoint-shapes,refusal}.ts` at their actual declarations; frontend `plan-refresh`,
query/refusal rendering and the browser regression. Only touched targets gain new inputs.

`plan-json-import` later checks enabled optimized capability before writes through this
same `supports` method. Core's accountless composition proves the unavailable read without
HTTP. WorkingPlan changes input-read frequency only; it does not cache scheduling results.

## Risks / Trade-offs

The intentional product changes are D23's unavailable live read and faithful captured
engine selection. They require delta scenarios below; they are not called mechanical
refactoring. Pending installed live reads still use their explicitly marked Fast baseline,
while saved history records absence rather than unlabelled substitution. Publication uses
an invalidation event because a committed mutation cannot truthfully become a refusal.

## Open Questions

None. Existing accepted solver behavior is the compatibility baseline; a changed feature
interface requires mechanical rebasing to the named obligations, not a new policy choice.
