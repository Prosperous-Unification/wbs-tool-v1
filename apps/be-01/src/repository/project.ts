import { type EstimateMethod, isEstimateMethod } from '@wbs/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import type { Project, ProjectPatch, ProjectStore, ProjectWithAccess, Role } from './index';
import { bumpedProject } from './revision';
import { project, projectAccess, role, users } from './schema';

/**
 * A stored row as a {@link Project}, checking the one column SQLite cannot
 * constrain.
 *
 * `estimate_method` is text, so the database will hold `median` as happily as
 * `pert`. Reading one is malformed trusted data and it throws rather than
 * falling back to PERT: a project silently planned by a method nobody chose is
 * a wrong answer delivered confidently, and R5 exists to stop exactly that.
 */
function toProject<
  T extends { estimateMethod: string; solutionSlug: string | null; solutionUrl: string | null },
>(
  row: T,
): Omit<T, 'estimateMethod' | 'solutionSlug' | 'solutionUrl'> & {
  estimateMethod: EstimateMethod;
  solutionRef: { slug: string; url: string } | null;
} {
  if (!isEstimateMethod(row.estimateMethod)) {
    throw new Error(`unknown estimate method in the database: ${row.estimateMethod}`);
  }
  if ((row.solutionSlug === null) !== (row.solutionUrl === null)) {
    throw new Error('project has a partial solution reference');
  }
  const { estimateMethod, solutionSlug, solutionUrl, ...rest } = row;
  return {
    ...rest,
    estimateMethod,
    solutionRef:
      solutionSlug === null || solutionUrl === null
        ? null
        : { slug: solutionSlug, url: solutionUrl },
  };
}

/**
 * A listed row as one whose owner is known, checking the one column a LEFT JOIN
 * can leave empty.
 *
 * The join answers null in exactly one case: a `project.owner_id` naming no
 * `users` row. The foreign key says that cannot happen, so meeting it is
 * malformed trusted data — and the two ways to carry on are both wrong
 * answers delivered confidently. Dropping the project hides it from its own
 * owner's picker; blanking the name puts `( · 1 Jun)` on screen and calls the
 * list complete.
 *
 * Proof: with the throw replaced by `?? ''`, `fails the list rather than
 * answering a project whose owner is nobody` in `project.test.ts` failed —
 * `listFor` resolved with `["Orphan", ""]` beside `["Rewire the shed",
 * "owner"]`. Watched, 2026-08-09.
 */
function withOwnerName<T extends { name: string; ownerName: string | null }>(
  row: T,
): Omit<T, 'ownerName'> & { ownerName: string } {
  if (row.ownerName === null) {
    throw new Error(`project "${row.name}" has an owner id naming no account`);
  }
  // Narrowed by the check above, which is the boundary this function exists to be.
  return { ...row, ownerName: row.ownerName };
}

/**
 * `create` writes the project and its roles in one transaction. A project that
 * existed briefly without roles would accept an estimate with no role to belong
 * to, and the failure would surface later as a missing join rather than here as
 * a rejected write.
 *
 * Role name uniqueness is left to the schema index: checking first is a race
 * two concurrent additions both win.
 */
export class ProjectRepository implements ProjectStore {
  constructor(private readonly db: SQLiteBunDatabase) {}

  // `async` is load-bearing rather than decorative: `db.transaction` is
  // synchronous, so a constraint violation would otherwise be thrown before the
  // promise this signature advertises exists — and a caller holding it with
  // `.catch()` would never see the rejection.
  async create(toCreate: Project, startingRoles: readonly Role[]): Promise<Project> {
    await Promise.resolve();
    this.db.transaction((tx) => {
      const { solutionRef, ...fields } = toCreate;
      tx.insert(project)
        .values({
          ...fields,
          solutionSlug: solutionRef?.slug ?? null,
          solutionUrl: solutionRef?.url ?? null,
        })
        .run();
      if (startingRoles.length > 0)
        tx.insert(role)
          .values([...startingRoles])
          .run();
    });
    return toCreate;
  }

  async findById(id: string): Promise<Project | null> {
    const rows = await this.db.select().from(project).where(eq(project.id, id)).limit(1);
    const found = rows.at(0);
    return found === undefined ? null : toProject(found);
  }

  async findBySolutionSlug(slug: string): Promise<Project | null> {
    const rows = await this.db
      .select()
      .from(project)
      .where(eq(project.solutionSlug, slug))
      .limit(1);
    const found = rows.at(0);
    return found === undefined ? null : toProject(found);
  }

  async list(): Promise<Project[]> {
    const rows = await this.db.select().from(project).orderBy(desc(project.createdAt));
    return rows.map(toProject);
  }

  /**
   * The caller's own order, in one query.
   *
   * The ordering rests on a SQLite fact worth naming: `ORDER BY x DESC` puts
   * NULLs **last**, because NULL sorts below every value. That is exactly the
   * rule this needs — never-opened projects after opened ones — and it is not
   * portable, so a test watches it rather than a comment claiming it.
   *
   * The join is on both columns: `project_access` holds one row per pair, and
   * joining on the project alone would attach somebody else's history to this
   * caller's list — every project would then look opened, in the order the
   * busiest account visited them.
   *
   * The owner's name rides in the same statement, so listing fifty projects
   * still costs one query rather than fifty-one. Both joins are LEFT joins and
   * for opposite reasons: a never-opened project has no access row and must
   * still be listed, while a missing **user** row is not a project without an
   * owner — it is a foreign key the database says cannot happen — so the LEFT
   * join is what makes that impossible row visible instead of dropping the
   * project silently. Seeing it, this throws.
   *
   * Proof: with the owner join replaced by a `select` per row, `costs one
   * statement however many projects there are` in `project.test.ts` failed on
   * `Expected length: 1 / Received length: 51`. Watched, 2026-08-09.
   *
   * @throws when a listed project's owner id names no account.
   */
  async listFor(userId: string): Promise<ProjectWithAccess[]> {
    const rows = await this.db
      .select({
        id: project.id,
        name: project.name,
        ownerId: project.ownerId,
        restricted: project.restricted,
        estimateMethod: project.estimateMethod,
        startDate: project.startDate,
        solutionSlug: project.solutionSlug,
        solutionUrl: project.solutionUrl,
        revision: project.revision,
        createdAt: project.createdAt,
        lastOpenedAt: projectAccess.lastOpenedAt,
        ownerName: users.username,
      })
      .from(project)
      .leftJoin(
        projectAccess,
        and(eq(projectAccess.projectId, project.id), eq(projectAccess.userId, userId)),
      )
      .leftJoin(users, eq(users.id, project.ownerId))
      .orderBy(desc(projectAccess.lastOpenedAt), desc(project.createdAt));
    return rows.map((row) => toProject(withOwnerName(row)));
  }

  /**
   * Deliberately does **not** move the project's revision. Which screen a
   * project is on is one account's navigation history: nobody else's read of
   * the plan differs because of it, so a write that had to be sure the plan had
   * not changed must not be defeated by somebody opening it in another tab.
   *
   * Proof: bumping the project here fails `opening a project does not move its
   * revision` in `service/revision.test.ts`.
   */
  async recordOpen(userId: string, projectId: string, at: number): Promise<void> {
    await this.db
      .insert(projectAccess)
      .values({ userId, projectId, lastOpenedAt: at })
      // The pair is the primary key, so a second open is an update rather than
      // a constraint violation — and `at` is taken as given rather than
      // maxed: the caller's clock is the one that saw the open happen.
      .onConflictDoUpdate({
        target: [projectAccess.userId, projectAccess.projectId],
        set: { lastOpenedAt: sql`excluded.last_opened_at` },
      });
  }

  async update(id: string, patch: ProjectPatch): Promise<Project | null> {
    // An empty patch would make drizzle emit `SET` with no assignments, which
    // SQLite rejects — so a request that changes nothing reads instead.
    if (
      patch.name === undefined &&
      patch.restricted === undefined &&
      patch.estimateMethod === undefined &&
      patch.startDate === undefined &&
      patch.solutionRef === undefined
    ) {
      return this.findById(id);
    }
    // The bump rides in the same `SET` as the change it describes, so a patch
    // that lands without moving the revision is not a state this can reach.
    const { solutionRef, ...fields } = patch;
    const rows = await this.db
      .update(project)
      .set({
        ...fields,
        ...(solutionRef === undefined
          ? {}
          : {
              solutionSlug: solutionRef?.slug ?? null,
              solutionUrl: solutionRef?.url ?? null,
            }),
        revision: bumpedProject,
      })
      .where(eq(project.id, id))
      .returning();
    const updated = rows.at(0);
    return updated === undefined ? null : toProject(updated);
  }

  /**
   * The project's roles, in role order — the same order and the same reason as
   * {@link RoleRepository.listByProject}, which this does not replace: the
   * schedule reads its role order through here.
   *
   * Proof: with the `orderBy` removed, `reads the same order through the
   * project, which is where the schedule asks` fails with `Analysis, Dev, QA`
   * — SQLite answers this from the `(project_id, name)` index; watched
   * 2026-08-09.
   */
  rolesOf(projectId: string): Promise<Role[]> {
    return this.db
      .select()
      .from(role)
      .where(eq(role.projectId, projectId))
      .orderBy(role.position, role.id);
  }
}
