## Context

R1 already owns generation counters and trailing reads in `apps/fe-01/src/lib/plan-refresh.ts`. The four resources are tree, steps, grouped directory and markers. `use-plan-read.ts` still calls a default full refresh after local success. Six directory lists install as one resource. `use-reference-sets.ts` has create-and-attach gestures with two separate requests; a created tag or person survives if the second request refuses.

## Goals / Non-Goals

Narrow completed local operations and preserve the coordinator. No reliance on receiving one's own socket announcement; page tests run with no subscription. No conversion of two HTTP writes into an atomic batch in this change.

## Decisions

Introduce `LocalWrite` in `lib/local-write.ts`:

```ts
interface LocalWrite {
  perform<T>(resources: readonly RefreshResource[], request: () => Promise<T>): Promise<T>;
}
type RunPlanWrite = (action: (write: LocalWrite) => Promise<void>) => Promise<CommitOutcome>;
```

`run` creates one owner-bound set of completed resource obligations. `perform` awaits a request and adds its declared resources immediately on successful resolution, then returns the response. Each API call must be inside perform; declarations describe one request, not the closure containing later writes. No default resource set exists on perform. The union is invalidated once after the gesture settles. A refused later request still refreshes successful-prefix resources and still returns refused, preserving its draft/toast. A request that itself refuses contributes no resources.

Unknown transport failures or malformed reply bodies have ambiguous commit outcome: use the existing typed client distinction and conservatively refresh ALL_RESOURCES for that path. A modeled refusal with no successful prefix retains the current no-read behavior, except not_found and INVALID_REQUEST recover with ALL_RESOURCES. Known marker refusals retain their current marker reread. Unexpected programming errors are not converted to successful writes. Successful writes with failed reads remain landed plus stale banner.

Keep ownership checks around obligations and completion exactly as R1: an old project/API owner's completion cannot invalidate, toast, clear busy state or move focus in its replacement. Invalidation occurs after the operation succeeds, so an earlier in-flight GET cannot satisfy it. Use the existing coordinator's outcome wait; never add a GET cache or patch local arrays.

The required caller matrix is:

| API operation family                                                                                                                       | Successful request resources               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Row create/patch/move/duplicate/delete, freeze/unfreeze; estimates, actuals, progress, measures; dependency and existing-person assignment | tree                                       |
| Project start/method/reach/weights/rounding, priority bands/capacity, optimization setting/retry                                           | tree                                       |
| Step add/rename/remove                                                                                                                     | tree, steps                                |
| Directory add/patch/delete; person/team membership or kind                                                                                 | tree, directory                            |
| Calendar marker add/patch/delete                                                                                                           | markers                                    |
| Undo/redo and explicit recovery/retry-load                                                                                                 | ALL_RESOURCES, preserving current behavior |

Directory requests conservatively include tree because a cascade or changed membership affects effective assignments and capacity. A compound create-and-attach marks tree+directory as soon as the create succeeds; the attach separately marks tree. Arbitrary command batches, if introduced as a local caller, derive the union from kinds or explicitly use ALL_RESOURCES; no URL-based inference.

## File Map

Integration baseline: R10 landed in #353 (`f66f73e8`). Preserve its existing
`PlanRowReadings`/`PlanRenderRow` immutable inputs in `plan-render-rows.ts` and event-only
`PlanLiveValues` in `plan-live.ts`; the latter still carries the run capability.
`usePlanRead` receives `cellCards: CellCards`, not a `setHoveredCell` setter.
`usePlanStructureEffects` receives `attachCell: RefObject<CellAttacher>` and passes it to
`FocusIntent.land`. Keep these attachment/card subscriptions and immutable readings while
changing run; do not restore the pre-R10 render-time live contract.

Own `lib/local-write.ts`, `components/wbs/use-plan-read.ts` and the RunPlanWrite type imported by `use-plan-structure.ts`, `use-plan-fields.ts`, `use-estimate-drafts.ts`, `use-reference-sets.ts`, `use-plan-dependencies.ts`, `plan-live.ts`, `plan-cell-props.ts`, `plan-toolbar.tsx`, `plan-columns/{actions,depends}.tsx`, `wbs-table.tsx` and any settings-panel props that receive run. Inventory by actual API calls, including `refreshOrMarkStale` direct callers; no broad text substitution. Coordinate signatures with measured-rendering before editing.

## Migration Plan

Install the explicit perform contract and convert all run callers in one compiling slice using conservative ALL_RESOURCES. Then narrow one operation family per slice with production-page read-count tests. Preserve runMarkerWrite and stepStack contracts; route them through the same obligation helper only if needed without changing their refusal policy.

## Risks / Trade-offs

A function's successful return is not proof the whole gesture committed. The new helper accounts for actual successful subrequests. Context null means disposal/lifecycle cancellation, not permission to silently claim an edit landed. The type alone cannot prove a caller used perform: the integration inventory and no-subscription tests cover every compound family.

## Open Questions

None. Read-count measurements and mutation negatives remain to be run.
