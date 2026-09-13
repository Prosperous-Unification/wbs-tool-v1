import type {
  NewProject,
  Project,
  ProjectPatch,
  ProjectStore,
  ProjectWithAccess,
  Step,
  WriteStamp,
} from '@wbs/core';
import {
  type DependencyReach,
  type EstimateMethod,
  type EstimateRounding,
  isDependencyReach,
  isEstimateMethod,
  isEstimateRounding,
  PertWeights,
} from '@wbs/domain';
import { type } from '@wbs/validation';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import {
  auditOnCreate,
  auditOnCreateBesidesCreatedAt,
  auditOnUpdate,
  withoutAuditColumns,
} from './audit';
import type { Gate } from './gate';
import { isScheduleEngine, isSolverObjective, unknownStoredValue } from './optimizer-rows';
import { bumpedProject } from './revision';
import {
  optimizationGeneration,
  project,
  projectAccess,
  type ScheduleEngine,
  type SolverObjectiveName,
  solverQueue,
  solverSlot,
  step,
  users,
} from './schema';
import { STEP_COLUMNS } from './step';

/**
 * One {@link PertWeights} as the three columns that hold it.
 *
 * Written once and used by both the insert and the update, so a project created
 * with weights and a project patched to them cannot land in different columns.
 */
function weightColumns(weights: PertWeights): {
  pertWeightOptimistic: number;
  pertWeightRealistic: number;
  pertWeightPessimistic: number;
} {
  return {
    pertWeightOptimistic: weights.optimistic,
    pertWeightRealistic: weights.realistic,
    pertWeightPessimistic: weights.pessimistic,
  };
}

/**
 * A stored row as a {@link Project}, checking the two columns SQLite cannot
 * constrain.
 *
 * `estimate_method` is text, so the database will hold `median` as happily as
 * `pert`. Reading one is malformed trusted data and it throws rather than
 * falling back to PERT: a project silently planned by a method nobody chose is
 * a wrong answer delivered confidently, and R5 exists to stop exactly that.
 *
 * `dep_reach` is the same shape of column and the same refusal. Its two values
 * differ by every date behind a multi-step predecessor, so reading an
 * unrecognised one as `whole-item` would schedule a plan by a rule nobody
 * chose and say nothing about it. The case is not hypothetical: an older colour
 * reading a value a newer release wrote arrives here mid-swap.
 *
 * `estimate_rounding` and the three `pert_weight_*` columns are the same
 * refusal a third and fourth time, and the weights are checked as a **triple**
 * rather than one column at a time: a single weight says nothing on its own,
 * and what makes a set of them unusable is a property of all three — they must
 * sum to a finite number above zero to divide by. `PertWeights`'s own narrow is
 * that rule, so this boundary and the PATCH boundary refuse the same triples
 * without either restating the arithmetic.
 *
 * Proof: with the two guards replaced by casts, `refuses a stored rounding it
 * does not know` failed on `expected [Function] to throw` — a project rounding
 * by `nearest` read back happily, and `roundDays` then charged every step by
 * `ceil` because that is its last branch; watched 2026-08-30, with `refuses
 * stored weights that cannot average a triple` failing beside it on the same
 * assertion.
 */
/**
 * Columns of `project` that are stored and never published.
 *
 * `optimizationDeletePendingAt` is the optimizer drain's cross-process fence
 * (tasks.md 3.1b): internal state, not a field of a project, and no boundary
 * returns it.
 */
const INTERNAL_PROJECT_COLUMNS = ['optimizationDeletePendingAt'] as const;

/**
 * What a project created without stating its settings gets — the same three
 * values `20260904140000_add_project_settings` writes into its `ADD COLUMN`
 * defaults (tasks.md 3b.1, 3b.2).
 *
 * Two statements of one fact, which is a drift risk and is therefore proved
 * rather than trusted: `create` writes these explicitly instead of omitting the
 * columns, and `a project created without settings agrees with the columns'
 * own defaults` in `project.db.test.ts` inserts a row **around** this constant
 * and reads both back. If the migration and this list ever disagree, that case
 * is the one that says so.
 *
 * OFF, `fast` and `pri` are not arbitrary: OFF is what makes an existing
 * project spend no solver time on deploy, and `fast`/`pri` are the engine and
 * the order every plan already had, so a project created today schedules
 * exactly as it did yesterday.
 */
const DEFAULT_PROJECT_SETTINGS = {
  enabled: false,
  engine: 'fast',
  objective: 'pri',
} as const satisfies { enabled: boolean; engine: ScheduleEngine; objective: SolverObjectiveName };

/**
 * A row with {@link INTERNAL_PROJECT_COLUMNS} taken off, for
 * {@link withoutAuditColumns}' reason and by its method.
 *
 * {@link toProject} is generic over its row and spreads whatever is left of it,
 * so a column added to `project` is published **by default** and has to be
 * taken off deliberately — the trap `createdBy` sprang on 2026-09-02, caught
 * both times by the same guard in `project.db.test.ts`.
 */
function withoutInternalColumns<T extends object>(
  row: T,
): Omit<T, (typeof INTERNAL_PROJECT_COLUMNS)[number]> {
  const dropped = new Set<string>(INTERNAL_PROJECT_COLUMNS);
  return Object.fromEntries(Object.entries(row).filter(([name]) => !dropped.has(name))) as Omit<
    T,
    (typeof INTERNAL_PROJECT_COLUMNS)[number]
  >;
}

/**
 * The two settings columns that are stored as text and refused on the way out
 * (tasks.md 3b.2, 3b.8).
 *
 * `optimization_enabled` is not among them and needs no validator: drizzle
 * reads it through `{ mode: 'boolean' }`, so the only values it can produce are
 * `true` and `false`. Its `CHECK (optimization_enabled IN (0,1))` is what keeps
 * a `2` out of the column in the first place, and `refuses a value outside each
 * column vocabulary` in `project-settings.db.test.ts` proves that half.
 */
function toProject<
  T extends {
    estimateMethod: string;
    depReach: string;
    estimateRounding: string;
    pertWeightOptimistic: number;
    pertWeightRealistic: number;
    pertWeightPessimistic: number;
    solutionSlug: string | null;
    solutionUrl: string | null;
    scheduleEngine: string;
    scheduleObjective: string;
    optimizationDeletePendingAt?: number | null;
  },
>(
  row: T,
  // Nested rather than one union of keys, because that is what the body
  // produces and TypeScript does not prove `Omit<Omit<T, A>, B>` equals
  // `Omit<T, A | B>` for a generic `T`.
): Omit<
  Omit<
    Omit<
      T,
      | 'estimateMethod'
      | 'depReach'
      | 'estimateRounding'
      | 'pertWeightOptimistic'
      | 'pertWeightRealistic'
      | 'pertWeightPessimistic'
      | 'solutionSlug'
      | 'solutionUrl'
      | 'scheduleEngine'
      | 'scheduleObjective'
    >,
    'createdBy' | 'updatedAt' | 'updatedBy'
  >,
  // The list rather than the one name it held until run 33, so a column added
  // to {@link INTERNAL_PROJECT_COLUMNS} is a column this signature stops
  // declaring — the body already stopped returning it.
  (typeof INTERNAL_PROJECT_COLUMNS)[number]
> & {
  estimateMethod: EstimateMethod;
  depReach: DependencyReach;
  estimateRounding: EstimateRounding;
  pertWeights: PertWeights;
  solutionRef: { slug: string; url: string } | null;
  scheduleEngine: ScheduleEngine;
  scheduleObjective: SolverObjectiveName;
} {
  const {
    estimateMethod,
    depReach,
    estimateRounding,
    pertWeightOptimistic,
    pertWeightRealistic,
    pertWeightPessimistic,
    solutionSlug,
    solutionUrl,
    scheduleEngine,
    scheduleObjective,
    ...rest
  } = row;
  if (!isEstimateMethod(estimateMethod)) {
    throw new Error(`unknown estimate method in the database: ${estimateMethod}`);
  }
  if (!isDependencyReach(depReach)) {
    throw new Error(`unknown dependency reach in the database: ${depReach}`);
  }
  if (!isEstimateRounding(estimateRounding)) {
    throw new Error(`unknown estimate rounding in the database: ${estimateRounding}`);
  }
  const weights = PertWeights({
    optimistic: pertWeightOptimistic,
    realistic: pertWeightRealistic,
    pessimistic: pertWeightPessimistic,
  });
  if (weights instanceof type.errors) {
    throw new Error(`unusable PERT weights in the database: ${weights.summary}`);
  }
  if ((solutionSlug === null) !== (solutionUrl === null)) {
    throw new Error('project has a partial solution reference');
  }
  if (!isScheduleEngine(scheduleEngine)) {
    throw unknownStoredValue('project', 'schedule_engine', scheduleEngine);
  }
  if (!isSolverObjective(scheduleObjective)) {
    throw unknownStoredValue('project', 'schedule_objective', scheduleObjective);
  }
  return {
    // Named by {@link withoutAuditColumns} rather than spread whole: this
    // mapper is generic over its row, so it has no column list of its own, and
    // `...rest` published `createdBy` and `updatedAt` until 2026-09-02.
    ...withoutInternalColumns(withoutAuditColumns(rest)),
    estimateMethod,
    depReach,
    estimateRounding,
    pertWeights: weights,
    solutionRef:
      solutionSlug === null || solutionUrl === null
        ? null
        : { slug: solutionSlug, url: solutionUrl },
    scheduleEngine,
    scheduleObjective,
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
 * `create` writes the project and its steps in one transaction. A project that
 * existed briefly without steps would accept an estimate with no step to belong
 * to, and the failure would surface later as a missing join rather than here as
 * a rejected write.
 *
 * Step name uniqueness is left to the schema index: checking first is a race
 * two concurrent additions both win.
 */
export class ProjectRepository implements ProjectStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  // `async` is load-bearing rather than decorative: `db.transaction` is
  // synchronous, so a constraint violation would otherwise be thrown before the
  // promise this signature advertises exists — and a caller holding it with
  // `.catch()` would never see the rejection.
  async create(
    toCreate: NewProject,
    startingSteps: readonly Step[],
    stamp: WriteStamp,
  ): Promise<Project> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      // Stated here rather than left to the column defaults, because this method
      // answers with the project it wrote and a caller comparing that answer to a
      // later read must see the same three values. Leaving them out of the INSERT
      // and guessing them in the return would be two sources for one row.
      const settings = {
        optimizationEnabled: toCreate.optimizationEnabled ?? DEFAULT_PROJECT_SETTINGS.enabled,
        scheduleEngine: toCreate.scheduleEngine ?? DEFAULT_PROJECT_SETTINGS.engine,
        scheduleObjective: toCreate.scheduleObjective ?? DEFAULT_PROJECT_SETTINGS.objective,
      };
      const written: Project = { ...toCreate, ...settings };
      this.db.transaction((tx) => {
        const { solutionRef, pertWeights, ...fields } = written;
        tx.insert(project)
          .values({
            ...fields,
            ...weightColumns(pertWeights),
            solutionSlug: solutionRef?.slug ?? null,
            solutionUrl: solutionRef?.url ?? null,
            ...auditOnCreateBesidesCreatedAt(stamp),
          })
          .run();
        if (startingSteps.length > 0)
          tx.insert(step)
            .values(startingSteps.map((starting) => ({ ...starting, ...auditOnCreate(stamp) })))
            .run();
      });
      return written;
    });
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
        depReach: project.depReach,
        estimateRounding: project.estimateRounding,
        pertWeightOptimistic: project.pertWeightOptimistic,
        pertWeightRealistic: project.pertWeightRealistic,
        pertWeightPessimistic: project.pertWeightPessimistic,
        startDate: project.startDate,
        solutionSlug: project.solutionSlug,
        solutionUrl: project.solutionUrl,
        // Listed as well as read one at a time: the picker's rows are
        // `ProjectWithAccess`, which extends `Project`, so a settings column
        // missing here is a listing that cannot type-check rather than one that
        // quietly answers `undefined` (tasks.md 3b.2).
        optimizationEnabled: project.optimizationEnabled,
        scheduleEngine: project.scheduleEngine,
        scheduleObjective: project.scheduleObjective,
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
  async recordOpen(projectId: string, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await this.db
        .insert(projectAccess)
        .values({ userId: stamp.by, projectId, lastOpenedAt: stamp.at, ...auditOnCreate(stamp) })
        // The pair is the primary key, so a second open is an update rather than
        // a constraint violation — and the stamp's instant is taken as given
        // rather than maxed: the clock that saw the open happen is the one that
        // stamped the act.
        .onConflictDoUpdate({
          target: [projectAccess.userId, projectAccess.projectId],
          set: { lastOpenedAt: sql`excluded.last_opened_at`, ...auditOnUpdate(stamp) },
        });
    });
  }

  async update(id: string, patch: ProjectPatch, stamp: WriteStamp): Promise<Project | null> {
    return await this.gate.enter(async () => {
      // An empty patch would make drizzle emit `SET` with no assignments, which
      // SQLite rejects — so a request that changes nothing reads instead.
      // Read off the patch rather than from a list of its fields: the list was
      // one line per `ProjectPatch` key, and a key added without a line here is a
      // patch that silently reads instead of writing. `Object.values` cannot
      // forget a field (tasks.md 3b.2, which added three at once).
      if (Object.values(patch).every((value) => value === undefined)) {
        return this.findById(id);
      }
      const { solutionRef, pertWeights, ...fields } = patch;
      // The bump rides in the same `SET` as the change it describes, so a patch
      // that lands without moving the revision is not a state this can reach.
      const updates = {
        ...fields,
        // The triple is written as a triple or not at all: a patch holding one
        // weight would leave the other two as they were, and the divisor is
        // their sum — half an answer is a different arithmetic rather than a
        // partial one. `ProjectPatch` carries them as one object for that
        // reason, and this is where it becomes three columns.
        ...(pertWeights === undefined ? {} : weightColumns(pertWeights)),
        ...(solutionRef === undefined
          ? {}
          : {
              solutionSlug: solutionRef?.slug ?? null,
              solutionUrl: solutionRef?.url ?? null,
            }),
        revision: bumpedProject,
      };
      return this.db.transaction((tx) => {
        // Claim the ON→OFF edge with a write, not a read followed by a write.
        // Two backend processes can PATCH one SQLite file during a blue/green
        // swap; the conditional UPDATE serializes them so exactly one advances
        // every release's cancellation epoch.
        let updated =
          patch.optimizationEnabled === false
            ? tx
                .update(project)
                .set({ ...updates, ...auditOnUpdate(stamp) })
                .where(and(eq(project.id, id), eq(project.optimizationEnabled, true)))
                .returning()
                .all()
                .at(0)
            : undefined;
        const turnedOff = updated !== undefined;
        updated ??= tx
          .update(project)
          .set({ ...updates, ...auditOnUpdate(stamp) })
          .where(eq(project.id, id))
          .returning()
          .all()
          .at(0);
        if (updated === undefined) return null;

        if (turnedOff) {
          tx.update(optimizationGeneration)
            .set({
              cancelEpoch: sql`${optimizationGeneration.cancelEpoch} + 1`,
              updatedAt: stamp.at,
            })
            .where(eq(optimizationGeneration.projectId, id))
            .run();
          tx.update(solverSlot)
            .set({ cancelRequestedAt: stamp.at })
            .where(eq(solverSlot.projectId, id))
            .run();
          tx.delete(solverQueue).where(eq(solverQueue.projectId, id)).run();
        }
        // Proof: without this cleanup, `turns optimization off as an idempotent
        // project-scoped cancellation` leaves both epochs, slots and queues live.
        return toProject(updated);
      });
    });
  }

  /**
   * The project's steps, in step order — the same order and the same reason as
   * {@link StepRepository.listByProject}, which this does not replace: the
   * schedule reads its step order through here.
   *
   * Proof: with the `orderBy` removed, `reads the same order through the
   * project, which is where the schedule asks` fails with `Analysis, Dev, QA`
   * — SQLite answers this from the `(project_id, name)` index; watched
   * 2026-08-09.
   */
  stepsOf(projectId: string): Promise<Step[]> {
    return (
      this.db
        // {@link STEP_COLUMNS}, not a bare `select()`, and not the mapper the
        // project reads above it use: `toProject` drops the audit columns by
        // name, and it did not until 2026-09-02 — it spread the rest of the row
        // — so `createdBy` and `updatedAt` reached `GET /api/projects/{id}` for
        // as long as those columns existed, with the comment here asserting
        // they did not. This read has no mapper, so the column list is the only
        // thing between the audit columns and a `Step`.
        .select(STEP_COLUMNS)
        .from(step)
        .where(eq(step.projectId, projectId))
        .orderBy(step.position, step.id)
    );
  }
}
