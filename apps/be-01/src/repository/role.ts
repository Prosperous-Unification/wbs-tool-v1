import { and, eq, inArray, max } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import type {
  Assignment,
  NewRole,
  Role,
  RoleRemoved,
  RoleStore,
  RoleUsageRows,
  RoleWritten,
} from './index';
import { ROLE_POSITION_STEP } from './index';
import { bumpProject, bumpWorkItems } from './revision';
import { actual, assignment, estimate, role, roleMeasure, roleProgress, workItem } from './schema';

/**
 * Whether a thrown error is SQLite refusing a second role of the same name in
 * one project.
 *
 * The message rather than a typed error, because `bun:sqlite` has no typed
 * one — the same translation `UserRepository.create` makes for usernames. It
 * names the index's columns so that a different constraint failing here is
 * still an unknown, and still throws.
 */
function isDuplicateName(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('UNIQUE constraint failed: role.project_id, role.name')
  );
}

/**
 * Every assignment in one project, read through the work items that hold them.
 *
 * The whole project's rather than one role's, because whether a work item's
 * assumed assignee moves when a role goes depends on what it holds for the roles
 * that stay — see {@link RoleUsageRows}. Takes the writer so the refusal can
 * read it inside the transaction that refused.
 */
function assignmentsIn(reader: Pick<SQLiteBunDatabase, 'select'>, projectId: string): Assignment[] {
  return reader
    .select({
      workItemId: assignment.workItemId,
      roleId: assignment.roleId,
      personId: assignment.personId,
    })
    .from(assignment)
    .innerJoin(workItem, eq(assignment.workItemId, workItem.id))
    .where(eq(workItem.projectId, projectId))
    .all();
}

/**
 * A project's roles, and the writes that change them.
 *
 * Its own repository rather than more methods on `ProjectRepository`: removing
 * a role spans six tables — estimates, recorded days, stated progress, the
 * figures that are not days, assignments and the role itself — plus the
 * revisions of everything that lost a row, and that transaction has nothing to
 * do with a project's own columns.
 *
 * Every write here moves the **project's** revision, because a role is a
 * satellite of the project: adding, renaming or removing one changes what every
 * estimate in it means. See `project.revision` in `schema.ts`.
 */
export class RoleRepository implements RoleStore {
  constructor(private readonly db: SQLiteBunDatabase) {}

  /**
   * The project's roles, in role order.
   *
   * The `ORDER BY` is load-bearing, not tidiness: without it SQLite answers
   * `WHERE project_id = ?` from the `role_project_name` index and hands back
   * the rows in **name** order, which puts a role called `Analysis` in front of
   * `Dev` however late it was added — and role order is what a work item's
   * slices run in.
   *
   * Proof: with the `orderBy` removed, `reads a role added later last, however
   * its name sorts` fails with `Analysis, Dev, QA`; watched 2026-08-09.
   */
  listByProject(projectId: string): Promise<Role[]> {
    return this.db
      .select()
      .from(role)
      .where(eq(role.projectId, projectId))
      .orderBy(role.position, role.id);
  }

  async findById(roleId: string): Promise<Role | null> {
    const rows = await this.db.select().from(role).where(eq(role.id, roleId)).limit(1);
    return rows.at(0) ?? null;
  }

  /**
   * Writes the role and the project's bump together, or writes neither.
   *
   * The refusal comes from the unique index rather than from a read first: two
   * clients adding `Design` at the same moment both see it free.
   *
   * The place it takes is read **inside** the transaction, so two roles added
   * at the same moment cannot both be told the same last position — one of them
   * would then sort by id, which is a UUID, which is no order at all.
   *
   * Proof: with the `isDuplicateName` branch removed, `refuses a name the
   * project already holds, and leaves the roles as they were` fails with the
   * raw `SQLITE_CONSTRAINT_UNIQUE` instead of a refusal — the 500 this
   * translation exists to prevent. With `bumpProject` removed, `adds a role and
   * moves the project’s revision` fails, 1 expected and 0 read. Both watched
   * 2026-08-08.
   */
  async add(toAdd: NewRole): Promise<RoleWritten> {
    await Promise.resolve();
    try {
      return this.db.transaction((tx) => {
        const last = tx
          .select({ position: max(role.position) })
          .from(role)
          .where(eq(role.projectId, toAdd.projectId))
          .get();
        const written: Role = {
          ...toAdd,
          position: (last?.position ?? 0) + ROLE_POSITION_STEP,
        };
        tx.insert(role).values(written).run();
        bumpProject(tx, toAdd.projectId);
        return { ok: true, role: written };
      });
    } catch (err) {
      if (isDuplicateName(err)) return { ok: false, reason: 'taken' };
      throw err;
    }
  }

  /**
   * Renames one role, or says why it could not.
   *
   * A refused rename writes nothing, the project's revision included: a request
   * that changed nothing must not defeat somebody else's precondition.
   *
   * Proof: with the empty-`returning` branch reporting success instead,
   * `reports a role that is gone rather than pretending to rename it` fails —
   * a rename of nothing answered `ok`; watched 2026-08-08.
   */
  async rename(roleId: string, name: string): Promise<RoleWritten> {
    await Promise.resolve();
    try {
      return this.db.transaction((tx) => {
        const rows = tx.update(role).set({ name }).where(eq(role.id, roleId)).returning().all();
        const renamed = rows.at(0);
        // Nothing was updated, so there is no role by that id — and nothing to
        // bump. Rolling back is not needed (the update wrote nothing), but the
        // early return keeps the bump and the write in the same branch.
        if (renamed === undefined) return { ok: false, reason: 'not_found' };
        bumpProject(tx, renamed.projectId);
        return { ok: true, role: renamed };
      });
    } catch (err) {
      if (isDuplicateName(err)) return { ok: false, reason: 'taken' };
      throw err;
    }
  }

  /**
   * What a removal would take with it, read for the refusal that names it.
   *
   * The assignments are the whole project's — see {@link RoleUsageRows} for why
   * this role's own rows cannot answer the question.
   */
  async usageOf(projectId: string, roleId: string): Promise<RoleUsageRows> {
    const held = await this.db
      .select({ workItemId: estimate.workItemId })
      .from(estimate)
      .where(eq(estimate.roleId, roleId));
    // Read through `actual_by_role`, which exists for this question and for the
    // one `remove` asks: the primary key leads with the work item, so counting
    // one role's rows without it is a scan.
    const recorded = await this.db
      .select({ workItemId: actual.workItemId })
      .from(actual)
      .where(eq(actual.roleId, roleId));
    // Read through `role_progress_by_role`, which exists for this question for
    // `actual_by_role`'s reason.
    const spoken = await this.db
      .select({ workItemId: roleProgress.workItemId })
      .from(roleProgress)
      .where(eq(roleProgress.roleId, roleId));
    // Not read through a by-role index, because `role_measure` has none: its
    // only index is the primary key's, and that leads with the work item, so
    // this is a scan of one deployment's figures. Filed rather than fixed —
    // `openspec/changes/token-tracking/verify.md`, Owed — because an index is a
    // migration, and this reads the same rows `remove` counts either way.
    const measured = await this.db
      .select({ workItemId: roleMeasure.workItemId })
      .from(roleMeasure)
      .where(eq(roleMeasure.roleId, roleId));
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
      .select()
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
   * The estimates are deleted **explicitly**: `estimate.role_id` has no
   * `onDelete` cascade, so deleting the role row on its own hits the foreign key
   * and answers 500. The assignments are deleted explicitly too, though their
   * column does cascade, so that what this reports having removed is what this
   * statement removed rather than what the database did behind it.
   *
   * Every read and every delete is scoped through `roleInProject`, a subquery
   * that is empty for a role that has gone or never belonged to this project. So
   * the loser of two removals counts nothing, deletes nothing, and is told
   * `not_found` by its own `DELETE ... RETURNING` — no revision moves and its
   * caller has no event to announce. The same scoping is what stops one
   * project's route from deleting another project's role by id.
   *
   * Proof, all watched: the estimate delete removed, and all three removal cases
   * fail on `FOREIGN KEY constraint failed` — the 500 a bare role delete answers
   * today (2026-08-08). The bump set narrowed to the assignments alone, and
   * `deletes an estimate written between the count and the confirmed removal`
   * fails on the third work item's revision (2026-08-08). The counting left in
   * the service alone, and `refuses an unconfirmed removal when an estimate
   * lands after the count` deletes it instead; the `RETURNING` check dropped,
   * and `refuses the loser of two removals, bumping and announcing nothing`
   * moves the project's revision and answers `ok`; the role delete's
   * `projectId` condition dropped, and `reports another project’s role as not
   * there, and leaves it alone` deletes theirs (2026-08-09).
   *
   * What no test here can observe is a writer landing **inside** this
   * transaction: `bun:sqlite` transactions are synchronous, so the interleave
   * the API actually faces — count, somebody else's write, confirm — is
   * reproduced across two calls rather than inside one.
   */
  async remove(projectId: string, roleId: string, cascade: boolean): Promise<RoleRemoved> {
    await Promise.resolve();
    return this.db.transaction((tx) => {
      const roleInProject = tx
        .select({ id: role.id })
        .from(role)
        .where(and(eq(role.id, roleId), eq(role.projectId, projectId)));
      const estimated = tx
        .select({ workItemId: estimate.workItemId })
        .from(estimate)
        .where(inArray(estimate.roleId, roleInProject))
        .all();
      // Counted inside the transaction with the estimates, and counted at all
      // because an actual is a record of work somebody has already done: a role
      // that holds one and no estimate is `in_use`, and an unconfirmed removal
      // of it is refused rather than quietly taking the only record of that
      // week. `actual.role_id` has no cascade for exactly this — see `role` in
      // `schema.ts`.
      const recorded = tx
        .select({ workItemId: actual.workItemId })
        .from(actual)
        .where(inArray(actual.roleId, roleInProject))
        .all();
      // And the statements, counted here for the recorded days' reason: a role
      // that holds no estimate and no actual but has been said to be **done** on
      // a work item is `in_use`, and an unconfirmed removal of it would turn
      // finished work back into work nobody has started, silently.
      const spoken = tx
        .select({ workItemId: roleProgress.workItemId })
        .from(roleProgress)
        .where(inArray(roleProgress.roleId, roleInProject))
        .all();
      // And the figures that are not days, counted here for the recorded days'
      // reason in two of its three units and for the estimates' reason in the
      // third: a `token_actual` or an `hours_actual` is an account of work that
      // has already happened, and a role holding one and nothing else is
      // `in_use`. Rows, not pairs — a pair holding a token estimate and an hours
      // fact is two statements, and the number a person is shown before
      // consenting has to be the number of statements that go.
      const measured = tx
        .select({ workItemId: roleMeasure.workItemId })
        .from(roleMeasure)
        .where(inArray(roleMeasure.roleId, roleInProject))
        .all();
      const assigned = tx
        .select({ workItemId: assignment.workItemId })
        .from(assignment)
        .where(inArray(assignment.roleId, roleInProject))
        .all();
      if (
        !cascade &&
        (estimated.length > 0 ||
          recorded.length > 0 ||
          spoken.length > 0 ||
          measured.length > 0 ||
          assigned.length > 0)
      ) {
        return {
          ok: false,
          reason: 'in_use',
          usage: {
            estimates: estimated.length,
            actuals: recorded.length,
            progress: spoken.length,
            measures: measured.length,
            assignments: assignmentsIn(tx, projectId),
          },
        };
      }
      tx.delete(estimate).where(inArray(estimate.roleId, roleInProject)).run();
      // Explicit, like the estimates and for the identical reason: `role_id`
      // carries no cascade here, so the role delete below hits the foreign key
      // and answers 500 without this statement.
      tx.delete(actual).where(inArray(actual.roleId, roleInProject)).run();
      // Explicit for the same reason once more: `role_progress.role_id` carries
      // no cascade either, deliberately.
      tx.delete(roleProgress).where(inArray(roleProgress.roleId, roleInProject)).run();
      // Explicit for the third time and the same reason: `role_measure.role_id`
      // carries no cascade either (`schema.ts`, `roleMeasure`), so without this
      // statement the role delete below hits the foreign key and answers 500 to
      // a confirmed cascade — the exact failure the estimates' delete was added
      // for in 2026-08-08, one table later.
      tx.delete(roleMeasure).where(inArray(roleMeasure.roleId, roleInProject)).run();
      tx.delete(assignment).where(inArray(assignment.roleId, roleInProject)).run();
      const removed = tx
        .delete(role)
        .where(and(eq(role.id, roleId), eq(role.projectId, projectId)))
        .returning()
        .all();
      // Nothing was deleted, so there was nothing here to delete: somebody
      // else's removal committed first, or this role belongs to another
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
      bumpWorkItems(tx, workItemIds);
      bumpProject(tx, projectId);
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
  }
}
