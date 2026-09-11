---
status: accepted
---

# Scheduling reads do not wait for solves

An unavailable optimized adapter and an installed optimizer with no ready answer are
different states. A scheduling read stays synchronous and reports installed capability;
supervision and asynchronous solve admission remain behind the runtime adapter. Awaiting
the solver through the proposed asynchronous Scheduler would couple ordinary plan reads
to process lifetime. Silently using Fast when the selected adapter is absent would violate
[D23](../2026-09-05-ports-and-adapters-plan.md): those dates have no mark explaining that
the selected engine never ran. Live reads and exports therefore refuse absent capability,
while installed pending/failed variants retain their existing marked Fast baseline.

A committed mutation cannot truthfully become a refused write because its following tree
read is unavailable. Publication emits a durable invalidation and the peer refetch renders
the typed failure. It does not fabricate a replacement schedule or hide the successful write.

Detached saved-plan capture cannot wait for or start a solve either. It stores the selected
ready schedule with its actual algorithm identity, or the existing typed absence appropriate
to the selected state. This deliberately amends the earlier Fast-only save/current contract;
keeping Fast under an optimized identity would make immutable history misleading. Existing
saved bytes and canonical input schema remain unchanged. Preference-only changes can thus
appear in schedule identity/presence without changing the older input body's settings.

The exact state table and affected spec requirements belong to
[scheduler-runtime-port](../../openspec/changes/archive/2026-09-10-scheduler-runtime-port/design.md).
Accepted for implementation under the user's 2026-09-08 authorization to resolve and
document assumptions; no runtime behavior or failure proof is claimed by this decision.
