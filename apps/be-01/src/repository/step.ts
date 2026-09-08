import { and, eq, inArray, max } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnCreate, auditOnUpdate } from './audit';
import { isUniqueViolation, UNIQUE_INDEXES } from './constraint';
import type { Gate } from './gate';
import type {
  Assignment,
  NewStep,
  Step,
  StepRemoved,
  StepStore,
  StepUsageRows,
  StepWritten,
  WriteStamp,
} from './index';
import { STEP_POSITION_STEP } from './index';
import { bumpProject, bumpWorkItems } from './revision';
import { actual, assignment, estimate, step, stepMeasure, stepProgress, workItem } from './schema';

/**
 * The columns a {@link Step} is, named once because four reads and writes in
 * this file and one in `project.ts` want exactly them.
 *
 * Spelled out rather than left to `select()`, which is this folder's convention
 * (see `WORK_ITEM_COLUMNS`): the audit columns are **recorded, not published**,
 * so a bare select would put `created_at`, `updated_at` and `created_by` into
 * `Step` and from there into the plan payload. The declared return types check
 * the list is complete.
 */
export const STEP_COLUMNS = {
  id: step.id,
  projectId: step.projectId,
  name: step.name,
  position: step.position,
};

/**
 * Every assignment in one project, read through the work items that hold them.
 *
 * The whole project's rather than one step's, because whether a work item's
 * assumed assignee moves when a step goes depends on what it holds for the steps
 * that stay — see {@link StepUsageRows}. Takes the writer so the refusal can
 * read it inside the transaction that refused.
 */
function assignmentsIn(reader: Pick<SQLiteBunDatabase, 'select'>, projectId: string): Assignment[] {
  return reader
    .select({
      workItemId: assignment.workItemId,
      stepId: assignment.stepId,
      personId: assignment.personId,
    })
    .from(assignment)
    .innerJoin(workItem, eq(assignment.workItemId, workItem.id))
    .where(eq(workItem.projectId, projectId))
    .all();
}

/** What a step holds, counted for that step alone. */
export interface StepHoldings {
  estimates: number;
  actuals: number;
  progress: number;
  measures: number;
  assignments: number;
}

/**
 * Whether removing this step would take a statement with it.
 *
 * **One function because there are two callers and they had drifted.**
 * `StepService.remove` refuses early so a reader is asked to confirm before a
 * transaction opens, and the transaction below refuses again because the early
 * answer can be stale by the time the deletes would run. Those are two moments,
 * deliberately — but they are one rule, and the early one had been written as
 * `estimates > 0 || assignments > 0`. A step holding only recorded days, or only
 * progress, or only measures was let through the gate and refused by the
 * transaction instead, so a reader saw a generic failure where they were owed
 * the "this would take N statements" confirmation. {@link StepUsageRows.actuals}
 * argues at length that exactly that case must refuse.
 *
 * Proof: with the `actuals` term dropped, `refuses a step holding only recorded
 * days at the gate, before a transaction opens` fails on
 * `expect(received).toMatchObject(expected) · - "ok": false · + "ok": true` —
 * both callers ask this function, so a missing term deletes the step rather
 * than merely letting it past the gate (2026-09-02).
 */
export function stepIsInUse(held: StepHoldings): boolean {
  return (
    held.estimates > 0 ||
    held.actuals > 0 ||
    held.progress > 0 ||
    held.measures > 0 ||
    held.assignments > 0
  );
}

/**
 * A project's steps, and the writes that change them.
 *
 * Its own repository rather than more methods on `ProjectRepository`: removing
 * a step spans six tables — estimates, recorded days, stated progress, the
 * figures that are not days, assignments and the step itself — plus the
 * revisions of everything that lost a row, and that transaction has nothing to
 * do with a project's own columns.
 *
 * Every write here moves the **project's** revision, because a step is a
 * satellite of the project: adding, renaming or removing one changes what every
 * estimate in it means. See `project.revision` in `schema.ts`.
 */
export class StepRepository implements StepStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * The project's steps, in step order.
   *
   * The `ORDER BY` is load-bearing, not tidiness: without it SQLite answers
   * `WHERE project_id = ?` from the `step_project_name` index and hands back
   * the rows in **name** order, which puts a step called `Analysis` in front of
   * `Dev` however late it was added — and step order is what a work item's
   * slices run in.
   *
   * Proof: with the `orderBy` removed, `reads a step added later last, however
   * its name sorts` fails with `Analysis, Dev, QA`; watched 2026-08-09.
   */
  listByProject(projectId: string): Promise<Step[]> {
    return this.db
      .select(STEP_COLUMNS)
      .from(step)
      .where(eq(step.projectId, projectId))
      .orderBy(step.position, step.id);
  }

  async findById(stepId: string): Promise<Step | null> {
    const rows = await this.db.select(STEP_COLUMNS).from(step).where(eq(step.id, stepId)).limit(1);
    return rows.at(0) ?? null;
  }

  /**
   * Writes the step and the project's bump together, or writes neither.
   *
   * The refusal comes from the unique index rather than from a read first: two
   * clients adding `Design` at the same moment both see it free.
   *
   * The place it takes is read **inside** the transaction, so two steps added
   * at the same moment cannot both be told the same last position — one of them
   * would then sort by id, which is a UUID, which is no order at all.
   *
   * Proof: with the `stepNameInProject` unique-violation branch removed, `refuses a name the
   * project already holds, and leaves the steps as they were` fails with the
   * raw `SQLITE_CONSTRAINT_UNIQUE` instead of a refusal — the 500 this
   * translation exists to prevent. With `bumpProject` removed, `adds a step and
   * moves the project’s revision` fails, 1 expected and 0 read. Both watched
   * 2026-08-08.
   */
  async add(toAdd: NewStep, stamp: WriteStamp): Promise<StepWritten> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      try {
        return this.db.transaction((tx) => {
          const last = tx
            .select({ position: max(step.position) })
            .from(step)
            .where(eq(step.projectId, toAdd.projectId))
            .get();
          const written: Step = {
            ...toAdd,
            position: (last?.position ?? 0) + STEP_POSITION_STEP,
          };
          tx.insert(step)
            .values({ ...written, ...auditOnCreate(stamp) })
            .run();
          bumpProject(tx, toAdd.projectId, stamp);
          return { ok: true, step: written };
        });
      } catch (err) {
        if (isUniqueViolation(err, UNIQUE_INDEXES.stepNameInProject))
          return { ok: false, reason: 'taken' };
        throw err;
      }
    });
  }

  /**
   * Renames one step, or says why it could not.
   *
   * A refused rename writes nothing, the project's revision included: a request
   * that changed nothing must not defeat somebody else's precondition.
   *
   * Proof: with the empty-`returning` branch reporting success instead,
   * `reports a step that is gone rather than pretending to rename it` fails —
   * a rename of nothing answered `ok`; watched 2026-08-08.
   */
  async rename(stepId: string, name: string, stamp: WriteStamp): Promise<StepWritten> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      try {
        return this.db.transaction((tx) => {
          const rows = tx
            .update(step)
            .set({ name, ...auditOnUpdate(stamp) })
            .where(eq(step.id, stepId))
            .returning(STEP_COLUMNS)
            .all();
          const renamed = rows.at(0);
          // Nothing was updated, so there is no step by that id — and nothing to
          // bump. Rolling back is not needed (the update wrote nothing), but the
          // early return keeps the bump and the write in the same branch.
          if (renamed === undefined) return { ok: false, reason: 'not_found' };
          bumpProject(tx, renamed.projectId, stamp);
          return { ok: true, step: renamed };
        });
      } catch (err) {
        if (isUniqueViolation(err, UNIQUE_INDEXES.stepNameInProject))
          return { ok: false, reason: 'taken' };
        throw err;
      }
    });
  }

  /**
   * What a removal would take with it, read for the refusal that names it.
   *
   * The assignments are the whole project's — see {@link StepUsageRows} for why
   * this step's own rows cannot answer the question.
   */
  async usageOf(projectId: string, stepId: string): Promise<StepUsageRows> {
    const held = await this.db
      .select({ workItemId: estimate.workItemId })
      .from(estimate)
      .where(eq(estimate.stepId, stepId));
    // Read through `actual_by_step`, which exists for this question and for the
    // one `remove` asks: the primary key leads with the work item, so counting
    // one step's rows without it is a scan.
    const recorded = await this.db
      .select({ workItemId: actual.workItemId })
      .from(actual)
      .where(eq(actual.stepId, stepId));
    // Read through `step_progress_by_step`, which exists for this question for
    // `actual_by_step`'s reason.
    const spoken = await this.db
      .select({ workItemId: stepProgress.workItemId })
      .from(stepProgress)
      .where(eq(stepProgress.stepId, stepId));
    // Read through `step_measure_by_step`, which exists for this question for
    // `actual_by_step`'s reason — the primary key leads with the work item, so
    // counting one step's rows without it would be a scan. Nothing owed here:
    // the index has shipped with the table since
    // `20260821140000_add_role_measure`.
    const measured = await this.db
      .select({ workItemId: stepMeasure.workItemId })
      .from(stepMeasure)
      .where(eq(stepMeasure.stepId, stepId));
    const ids = await this.db
      .select({ id: workItem.id })
      .from(workItem)
      .where(eq(workItem.projectId, projectId));
    // `inArray` with an empty list becomes `IN ()`, which SQLite refuses — and
    // a project with no work items has no assignments by definition.
    if (ids.length === 0)
      return {
        estimates: held.length,
        actuals: recorded.length,
        progress: spoken.length,
        measures: measured.length,
        assignments: [],
      };
    const assignments = await this.db
      .select({
        workItemId: assignment.workItemId,
        stepId: assignment.stepId,
        personId: assignment.personId,
      })
      .from(assignment)
      .where(
        inArray(
          assignment.workItemId,
          ids.map((row) => row.id),
        ),
      );
    return {
      estimates: held.length,
      actuals: recorded.length,
      progress: spoken.length,
      measures: measured.length,
      assignments,
    };
  }

  /**
   * Counts, decides and deletes in **one** transaction.
   *
   * The count is inside because it *is* the decision, not a report about it. A
   * caller that asked without `cascade` consented to nothing, so an estimate
   * written between that caller's own count and this statement has to refuse the
   * removal rather than be deleted by it — the counts a person was shown never
   * mentioned it. `cascade` is the only thing carried across the two requests;
   * every number is read here, freshly.
   *
   * The estimates are deleted **explicitly**: `estimate.step_id` has no
   * `onDelete` cascade, so deleting the step row on its own hits the foreign key
   * and answers 500. The assignments are deleted explicitly too, though their
   * column does cascade, so that what this reports having removed is what this
   * statement removed rather than what the database did behind it.
   *
   * Every read and every delete is scoped through `stepInProject`, a subquery
   * that is empty for a step that has gone or never belonged to this project. So
   * the loser of two removals counts nothing, deletes nothing, and is told
   * `not_found` by its own `DELETE ... RETURNING` — no revision moves and its
   * caller has no event to announce. The same scoping is what stops one
   * project's route from deleting another project's step by id.
   *
   * Proof, all watched: the estimate delete removed, and all three removal cases
   * fail on `FOREIGN KEY constraint failed` — the 500 a bare step delete answers
   * today (2026-08-08). The bump set narrowed to the assignments alone, and
   * `deletes an estimate written between the count and the confirmed removal`
   * fails on the third work item's revision (2026-08-08). The counting left in
   * the service alone, and `refuses an unconfirmed removal when an estimate
   * lands after the count` deletes it instead; the `RETURNING` check dropped,
   * and `refuses the loser of two removals, bumping and announcing nothing`
   * moves the project's revision and answers `ok`; the step delete's
   * `projectId` condition dropped, and `reports another project’s step as not
   * there, and leaves it alone` deletes theirs (2026-08-09).
   *
   * What no test here can observe is a writer landing **inside** this
   * transaction: `bun:sqlite` transactions are synchronous, so the interleave
   * the API actually faces — count, somebody else's write, confirm — is
   * reproduced across two calls rather than inside one.
   */
  async remove(
    projectId: string,
    stepId: string,
    cascade: boolean,
    stamp: WriteStamp,
  ): Promise<StepRemoved> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      return this.db.transaction((tx) => {
        const stepInProject = tx
          .select({ id: step.id })
          .from(step)
          .where(and(eq(step.id, stepId), eq(step.projectId, projectId)));
        const estimated = tx
          .select({ workItemId: estimate.workItemId })
          .from(estimate)
          .where(inArray(estimate.stepId, stepInProject))
          .all();
        // Counted inside the transaction with the estimates, and counted at all
        // because an actual is a record of work somebody has already done: a step
        // that holds one and no estimate is `in_use`, and an unconfirmed removal
        // of it is refused rather than quietly taking the only record of that
        // week. `actual.step_id` has no cascade for exactly this — see `step` in
        // `schema.ts`.
        const recorded = tx
          .select({ workItemId: actual.workItemId })
          .from(actual)
          .where(inArray(actual.stepId, stepInProject))
          .all();
        // And the statements, counted here for the recorded days' reason: a step
        // that holds no estimate and no actual but has been said to be **done** on
        // a work item is `in_use`, and an unconfirmed removal of it would turn
        // finished work back into work nobody has started, silently.
        const spoken = tx
          .select({ workItemId: stepProgress.workItemId })
          .from(stepProgress)
          .where(inArray(stepProgress.stepId, stepInProject))
          .all();
        // And the figures that are not days, counted here for the recorded days'
        // reason in two of its three units and for the estimates' reason in the
        // third: a `token_actual` or an `hours_actual` is an account of work that
        // has already happened, and a step holding one and nothing else is
        // `in_use`. Rows, not pairs — a pair holding a token estimate and an hours
        // fact is two statements, and the number a person is shown before
        // consenting has to be the number of statements that go.
        const measured = tx
          .select({ workItemId: stepMeasure.workItemId })
          .from(stepMeasure)
          .where(inArray(stepMeasure.stepId, stepInProject))
          .all();
        const assigned = tx
          .select({ workItemId: assignment.workItemId })
          .from(assignment)
          .where(inArray(assignment.stepId, stepInProject))
          .all();
        const held: StepHoldings = {
          estimates: estimated.length,
          actuals: recorded.length,
          progress: spoken.length,
          measures: measured.length,
          assignments: assigned.length,
        };
        if (!cascade && stepIsInUse(held)) {
          return {
            ok: false,
            reason: 'in_use',
            // Every count but the assignments is the one just tested. The
            // assignments are re-read across the whole project rather than for
            // this step, because the caller reports assumed-assignee flips from
            // them and those are a fact about rows this step does not hold.
            usage: { ...held, assignments: assignmentsIn(tx, projectId) },
          };
        }
        tx.delete(estimate).where(inArray(estimate.stepId, stepInProject)).run();
        // Explicit, like the estimates and for the identical reason: `step_id`
        // carries no cascade here, so the step delete below hits the foreign key
        // and answers 500 without this statement.
        tx.delete(actual).where(inArray(actual.stepId, stepInProject)).run();
        // Explicit for the same reason once more: `step_progress.step_id` carries
        // no cascade either, deliberately.
        tx.delete(stepProgress).where(inArray(stepProgress.stepId, stepInProject)).run();
        // Explicit for the third time and the same reason: `step_measure.step_id`
        // carries no cascade either (`schema.ts`, `stepMeasure`), so without this
        // statement the step delete below hits the foreign key and answers 500 to
        // a confirmed cascade — the exact failure the estimates' delete was added
        // for in 2026-08-08, one table later.
        tx.delete(stepMeasure).where(inArray(stepMeasure.stepId, stepInProject)).run();
        tx.delete(assignment).where(inArray(assignment.stepId, stepInProject)).run();
        const removed = tx
          .delete(step)
          .where(and(eq(step.id, stepId), eq(step.projectId, projectId)))
          .returning()
          .all();
        // Nothing was deleted, so there was nothing here to delete: somebody
        // else's removal committed first, or this step belongs to another
        // project. Either way this request changed nothing and must move no
        // revision — the two deletes above touched nothing for the same reason.
        if (removed.length === 0) return { ok: false, reason: 'not_found' };
        const workItemIds = [
          ...new Set(
            [...estimated, ...recorded, ...spoken, ...measured, ...assigned].map(
              (row) => row.workItemId,
            ),
          ),
        ];
        bumpWorkItems(tx, workItemIds, stamp);
        bumpProject(tx, projectId, stamp);
        return {
          ok: true,
          removal: {
            estimates: estimated.length,
            actuals: recorded.length,
            progress: spoken.length,
            measures: measured.length,
            assignments: assigned.length,
            workItemIds,
          },
        };
      });
    });
  }
}
