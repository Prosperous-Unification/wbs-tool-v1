import { and, eq } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnCreate, auditOnUpdate } from './audit';
import type { Gate } from './gate';
import type { EstimateStore, StoredEstimate, WriteStamp } from './index';
import { bumpWorkItems } from './revision';
import { estimate, step, workItem } from './schema';

/**
 * An estimate is a **satellite** of the work item it is for: it has no identity
 * anyone holds and is only ever read through that work item. So every write
 * here moves that work item's revision, inside the same transaction as the
 * estimate write — see `work_item.revision` in `schema.ts`.
 *
 * **What the four satellite stores share is named, and it is not the class.**
 * `rowsChanged` is one function where three of them held the same eight lines,
 * and `listByProject` is one statement in all four — a join through
 * `work_item`, where it used to be an id read followed by an `IN (…)` over
 * every row. What is *not* shared is the four classes themselves, and the
 * reason is in this paragraph and the next: the value columns, the key width
 * (`step_measure` carries a third column) and the bump below all differ, so a
 * parameterised store would take each of them as an option and would need a
 * cast to hand drizzle a table it does not know the shape of. The rules would
 * be no shorter and no longer typechecked.
 *
 * The bumps are unconditional rather than conditional on rows having actually
 * changed. Asking first would be a read-then-write, which is exactly the shape
 * the counter exists to avoid; and the two mistakes are not symmetric. A bump
 * nobody needed costs a conditional write one retry. A bump that did not happen
 * lets a stale write land on data that moved, which is the failure being
 * prevented.
 */
export class EstimateRepository implements EstimateStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * Every estimate in the project, **in step order** within each work item.
   *
   * The order is part of the contract, not a side effect of how SQLite felt
   * about the query. A caller that adds these up — the schedule's adapter does,
   * one work item at a time — is doing floating-point addition, which is not
   * associative: three steps summed in one order and in another can differ in
   * the last bit, and a work item's finish is read through `Math.ceil`, so that
   * bit can be a whole day on the screen. An unordered read makes which day it
   * is depend on the query planner.
   *
   * Ordered by the step's **position** rather than by its id, so that the order
   * this hands back is the order the work actually runs in.
   *
   * Proof: with the `orderBy` removed, `reads a work item's estimates in step
   * order, not in the order the row ids happen to sort` fails, handing back the
   * project's second step first — the composite primary key's own order;
   * watched 2026-08-09.
   */
  async listByProject(projectId: string): Promise<StoredEstimate[]> {
    await Promise.resolve();
    return (
      this.db
        .select({
          workItemId: estimate.workItemId,
          stepId: estimate.stepId,
          optimistic: estimate.optimistic,
          realistic: estimate.realistic,
          pessimistic: estimate.pessimistic,
        })
        .from(estimate)
        // Inner rather than left: `estimate.step_id` is a foreign key, so an
        // estimate whose step is gone cannot exist — `StepRepository.remove`
        // deletes them in the same transaction as the step.
        .innerJoin(step, eq(estimate.stepId, step.id))
        // And the work item, so the project is asked for in the statement that
        // reads the rows. This was two queries until 2026-09-02 — every work item
        // id, then `IN (…)` over the lot — which put one bound parameter per row
        // into the read, four times over per plan read. Inner again, and for the
        // same reason: `workItemId` is a foreign key.
        .innerJoin(workItem, eq(estimate.workItemId, workItem.id))
        .where(eq(workItem.projectId, projectId))
        .orderBy(estimate.workItemId, step.position, estimate.stepId)
    );
  }

  async set(toSet: StoredEstimate, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        tx.insert(estimate)
          .values({ ...toSet, ...auditOnCreate(stamp) })
          .onConflictDoUpdate({
            target: [estimate.workItemId, estimate.stepId],
            set: {
              optimistic: toSet.optimistic,
              realistic: toSet.realistic,
              pessimistic: toSet.pessimistic,
              ...auditOnUpdate(stamp),
            },
          })
          .run();
        bumpWorkItems(tx, [toSet.workItemId], stamp);
      });
    });
  }

  async remove(workItemId: string, stepId: string, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      // Both halves of the key, not the step alone: the composite primary key is
      // (work item, step), and narrowing to one of them would clear that step
      // across the whole database. `estimate.test.ts` keeps a survivor for each
      // half so that mistake cannot pass.
      //
      // Proof: narrowed to `eq(estimate.stepId, stepId)` alone, `removes one
      // work item's step without touching the other step or the same step
      // elsewhere` fails; watched 2026-08-06.
      await Promise.resolve();
      this.db.transaction((tx) => {
        tx.delete(estimate)
          .where(and(eq(estimate.workItemId, workItemId), eq(estimate.stepId, stepId)))
          .run();
        bumpWorkItems(tx, [workItemId], stamp);
      });
    });
  }

  /**
   * Both work items move: one lost every estimate it held, the other gained
   * them, and a reader of either sees different figures afterwards.
   *
   * Proof: bumped for `to` alone, `hands the estimate down to a first child,
   * moving both` fails on the parent's revision; watched 2026-08-07.
   */
  async moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        tx.update(estimate)
          .set({ workItemId: toWorkItemId, ...auditOnUpdate(stamp) })
          .where(eq(estimate.workItemId, fromWorkItemId))
          .run();
        bumpWorkItems(tx, [fromWorkItemId, toWorkItemId], stamp);
      });
    });
  }
}
