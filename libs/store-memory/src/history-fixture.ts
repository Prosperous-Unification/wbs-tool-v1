import type { PlanEvent, PlanEventStore } from '@wbs/core';

/**
 * A {@link PlanEventStore} backed by an array, for service and controller tests
 * that do not need SQLite.
 *
 * It keeps the three guarantees a reader depends on, because a fixture laxer than
 * production lets a test pass against behaviour that does not exist: **newest
 * first** with the id breaking a tie, a `workItemId` filter that excludes the
 * plan-wide events rather than including them, and a `kinds` list that names
 * nothing being no filter at all.
 *
 * What it deliberately does not model is the JSON round trip — `before` and
 * `after` are held as the values they were given. A caller that cares about the
 * parse runs against the real store, exactly as `inMemoryCommandJournal` says of
 * the journal's three columns.
 */
export interface MemoryPlanEventTable {
  readonly held: PlanEvent[];
}
export function memoryPlanEventTable(seed: readonly PlanEvent[] = []): MemoryPlanEventTable {
  return { held: structuredClone([...seed]) };
}

export function inMemoryPlanEvents(
  seed: readonly PlanEvent[] = [],
  table: MemoryPlanEventTable = memoryPlanEventTable(seed),
): PlanEventStore & {
  readonly held: PlanEvent[];
} {
  const { held } = table;
  return {
    held,
    listFor(projectId, filter) {
      const kinds = filter.kinds ?? [];
      return Promise.resolve(
        held
          .filter((each) => each.projectId === projectId)
          .filter(
            (each) => filter.workItemId === undefined || each.workItemId === filter.workItemId,
          )
          .filter((each) => kinds.length === 0 || kinds.includes(each.kind))
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
      );
    },
    pruneOlderThan(cutoff) {
      const doomed = held.filter((each) => each.createdAt < cutoff);
      for (const each of doomed) held.splice(held.indexOf(each), 1);
      return Promise.resolve(doomed.length);
    },
  };
}
