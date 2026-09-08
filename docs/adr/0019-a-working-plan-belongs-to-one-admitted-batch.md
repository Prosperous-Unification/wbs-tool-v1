---
status: accepted
---

# A working plan belongs to one admitted batch

A command batch currently rereads whole-project collections while applying successive
commands. Its working plan is created after write admission from that batch's own stores;
successful mutations refresh the affected records before another command reads them, and
the working plan is discarded on settlement. Detached return values preserve journal
before-images. Global directory mutations form explicit reload barriers because their
effects can cross project boundaries. A project-scoped assignment refreshes its affected
row instead; it is not a global directory edit merely because DirectoryStore owns it.

We chose this lifetime over a process cache, which would need reliable invalidation for
every peer and source, and over saved-plan capture, whose independent read connection cannot
see this batch's uncommitted writes. Saved plans remain immutable history; repair uses the
surviving state supplied by the unit of work, never the discarded working plan. The acceptance
budget counts whole-project scans separately from required writes and targeted refreshes;
the old estimate of twenty total SQL statements for two hundred writes is not a contract.

The executable read/mutation matrix belongs to
[the live-plan-snapshot change](../../openspec/changes/live-plan-snapshot/design.md).
This records the user's authorized assumption on 2026-09-08, not measured implementation
performance.
