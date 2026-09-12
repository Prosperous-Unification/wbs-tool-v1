## Why

A URL-only in-flight cache can answer a post-edit invalidation with a pre-edit tree response. Separately, a single whole-refresh generation discards a slower steps or directory response when a newer narrow tree read starts. Calendar markers now have another independent read owner and share the stale flag, so one successful resource can conceal another resource's unresolved failure.

## What Changes

Introduce one plan-refresh coordinator per project/API lifetime beside project-stream.ts. It accepts resource-scoped invalidations and optional event sequences, owns running reads and pending obligations, and exposes installed snapshots plus resource-specific freshness. A new invalidation arriving during a read requires a later covering read; superseded callers await an eventual covering outcome rather than an obsolete transport promise.

Track tree, steps, grouped directory and calendar markers independently. Route initial load, mutations, marker success/refusal rereads, Retry and socket callbacks through this owner. Forward socket event sequences and acknowledge only covered installed state. Remove module-global URL-only GET sharing and the old competing refresh generations.

## Non-goals

No endpoint migration, scheduler change, render dependency redesign, search deferral, virtualization, marker CRUD change, background retry policy or new transport cancellation framework. No claim that separately fetched resources form a server-atomic snapshot.

## Constraints

Approved refactoring plan §67 R1 and the merged calendar-marker contract govern this slice; no new interview is required. Preserve columns identity, focused half-typed values, draft/refusal settlement, ChartRead publication, typed mutation outcomes and teardown behavior. Faults must fail through production API/host paths in held-response windows; write Proof comments only after observing failures. R10 and typed HTTP-client migration follow this slice.
