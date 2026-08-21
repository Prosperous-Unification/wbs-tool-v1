import type {
  ActualStore,
  DependencyStore,
  DirectoryStore,
  EstimateStore,
  MeasureStore,
  RoleProgressStore,
  SubtreeStore,
  WorkItemStore,
} from '../repository';

/**
 * A SubtreeStore that writes a copy through the six in-memory stores it is
 * given, in the order the real foreign keys force.
 *
 * **It is not atomic, and cannot be.** Maps have no transaction to roll back,
 * so a fixture claiming atomicity here would be a check that cannot fail —
 * exactly what R5 forbids. The claim is proved where it is real, against
 * SQLite, in `repository/work-item.test.ts`: the last write is given a broken
 * foreign key and nothing lands.
 *
 * What it does keep is the ordering, because that part *is* observable: the
 * work item fixture throws on a reposition it cannot find, and every store
 * here would accept the writes in any order the real database refuses.
 */
export function inMemorySubtrees(stores: {
  workItems: WorkItemStore;
  estimates: EstimateStore;
  actuals: ActualStore;
  progress: RoleProgressStore;
  measures: MeasureStore;
  dependencies: DependencyStore;
  directory: DirectoryStore;
}): SubtreeStore {
  return {
    async insertSubtree(copy) {
      // The respacing rides with the first row, which is how `WorkItemStore.insert`
      // takes it — one call applies both, as the one transaction does.
      for (const [index, row] of copy.rows.entries()) {
        await stores.workItems.insert(row, index === 0 ? copy.respaced : []);
      }
      // After the rows, because the real transaction has no choice: these point
      // at rows that must already exist. `move` is what the in-memory work item
      // store offers for a reparent, and it applies exactly the same fields.
      for (const child of copy.reparented) {
        await stores.workItems.move(child.id, child.parentId, child.position, []);
      }
      for (const estimate of copy.estimates) await stores.estimates.set(estimate);
      for (const recorded of copy.actuals) await stores.actuals.set(recorded);
      for (const said of copy.progress) await stores.progress.set(said);
      for (const measured of copy.measures) await stores.measures.set(measured);
      for (const assigned of copy.assignments) {
        await stores.directory.assign(assigned.workItemId, assigned.roleId, assigned.personId);
      }
      for (const edge of copy.dependencies) await stores.dependencies.add(edge);
      for (const taken of copy.removedEstimates) {
        await stores.estimates.remove(taken.workItemId, taken.roleId);
      }
      for (const taken of copy.removedActuals) {
        await stores.actuals.remove(taken.workItemId, taken.roleId);
      }
      for (const taken of copy.removedProgress) {
        await stores.progress.remove(taken.workItemId, taken.roleId);
      }
      for (const taken of copy.removedMeasures) {
        await stores.measures.remove(taken.workItemId, taken.roleId, taken.metric);
      }
    },
  };
}
