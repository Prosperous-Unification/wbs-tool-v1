import type { DependencyStore, StoredDependency } from '@wbs/core';

/** The dependency table in an array, for tests whose subject is not SQLite. */
export interface MemoryDependencyTable {
  readonly rows: StoredDependency[];
}

export function memoryDependencyTable(
  seed: readonly StoredDependency[] = [],
): MemoryDependencyTable {
  return { rows: structuredClone([...seed]) };
}

export function inMemoryDependencies(
  seed: readonly StoredDependency[] = [],
  table: MemoryDependencyTable = memoryDependencyTable(seed),
): DependencyStore & { readonly rows: StoredDependency[] } {
  const { rows } = table;
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */
  return {
    rows,
    listByProject: (projectId) =>
      Promise.resolve(rows.filter((row) => row.projectId === projectId)),
    add(toAdd, _stamp) {
      // The real one leans on the unique pair; this mirrors it, because a test
      // that could hold the same edge twice would not be modelling the database.
      const already = rows.some(
        (row) => row.predecessorId === toAdd.predecessorId && row.successorId === toAdd.successorId,
      );
      if (!already) rows.push(toAdd);
      return Promise.resolve();
    },
    remove(predecessorId, successorId, _stamp) {
      const index = rows.findIndex(
        (row) => row.predecessorId === predecessorId && row.successorId === successorId,
      );
      if (index >= 0) rows.splice(index, 1);
      return Promise.resolve();
    },
    removeAllFor(workItemIds, _stamp) {
      const doomed = new Set(workItemIds);
      const kept = rows.filter(
        (row) => !doomed.has(row.predecessorId) && !doomed.has(row.successorId),
      );
      rows.splice(0, rows.length, ...kept);
      return Promise.resolve();
    },
  };
}
