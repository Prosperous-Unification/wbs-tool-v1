import type {
  DependencyReach,
  EstimateMethod,
  EstimateRounding,
  IsoDate,
  PertWeights,
  ScheduleEngine,
  SolverObjectiveName,
} from '@wbs/domain';

import type { Step } from './step-store';
import type { WriteStamp } from './write-stamp';

export interface Project {
  id: string;
  name: string;
  ownerId: string;
  restricted: boolean;
  /** How this project turns its three-point estimates into one planning number. */
  estimateMethod: EstimateMethod;
  /**
   * How far into a predecessor this project's dependencies reach — see
   * {@link DependencyReach}. Read by the scheduler and never supplied by a
   * client: the schedule is the server's answer, and a client-supplied
   * scheduling rule is one two clients can disagree about.
   */
  depReach: DependencyReach;
  /**
   * The coefficients this project's PERT figure weighs its three points by, and
   * whose **sum** is the divisor — see {@link PertWeights}. 1/4/1 unless the
   * project has said otherwise, which is the arithmetic every plan had before
   * the weights could be set.
   */
  pertWeights: PertWeights;
  /**
   * How one step's combined figure is charged as whole days — see
   * {@link EstimateRounding}. `ceil` unless the project has said otherwise, and
   * applied per step before any sum is taken.
   */
  estimateRounding: EstimateRounding;
  /** The calendar day the plan begins, or null for a plan not yet on a calendar. */
  startDate: IsoDate | null;
  /** The external solution this plan implements, or null when it is standalone. */
  solutionRef: { slug: string; url: string } | null;
  /**
   * How many times this project has been written to. Moves on its own stored
   * fields and on its steps; never on a work item beneath it, and never on
   * somebody opening it. See `schema.ts` for the rule and why it is bumped in
   * SQL rather than in this process.
   */
  revision: number;
  createdAt: number;
  /**
   * Whether this project may spend solver time at all (tasks.md 3b.2).
   *
   * `false` for every project that existed before the setting did, and for
   * every project created without stating otherwise — the column default is
   * what makes that true retroactively, not a backfill.
   */
  optimizationEnabled: boolean;
  /**
   * Which engine this project's schedule is produced by — the heuristic that
   * has always run, or the CP-SAT solver. Separate from
   * {@link Project.optimizationEnabled}: this is the engine the project
   * wants, and a project switched off keeps `optimized` recorded so it comes
   * back to it rather than to a default.
   */
  scheduleEngine: ScheduleEngine;
  /**
   * Which of the cached pair is the published one: priority order, or makespan.
   * The same two-member vocabulary the cache, the slot table and the queue
   * store under `objective`.
   */
  scheduleObjective: SolverObjectiveName;
}

/**
 * A project as it is **written**: everything {@link Project} declares except the
 * three settings, which the repository fills from the column defaults.
 *
 * The split exists because those three are read-published and default-written.
 * Requiring them on the create path would make every caller and fixture state
 * `false`/`fast`/`pri` — the same three literals, in twenty places, each of
 * which could disagree with the migration's defaults without anything noticing.
 * A caller that genuinely wants a project created optimized states it; the rest
 * say nothing and get the OFF-by-default the migration guarantees.
 */
export type NewProject = Omit<
  Project,
  'optimizationEnabled' | 'scheduleEngine' | 'scheduleObjective'
> &
  Partial<Pick<Project, 'optimizationEnabled' | 'scheduleEngine' | 'scheduleObjective'>>;

/**
 * A project as one account sees it: null when that account has never opened it.
 *
 * `ownerName` is the {@link User.username} behind {@link Project.ownerId},
 * joined in the listing query rather than looked up per project. It is not
 * nullable: a project whose owner names no account is malformed stored data,
 * and {@link ProjectStore.listFor} throws rather than answering a blank owner.
 */
export interface ProjectWithAccess extends Project {
  lastOpenedAt: number | null;
  ownerName: string;
}

export interface ProjectPatch {
  name?: string;
  restricted?: boolean;
  estimateMethod?: EstimateMethod;
  depReach?: DependencyReach;
  /** All three at once: a weight is only meaningful against the other two. */
  pertWeights?: PertWeights;
  estimateRounding?: EstimateRounding;
  /** `null` takes the plan back off the calendar. */
  startDate?: IsoDate | null;
  /** `null` detaches the plan from its external solution. */
  solutionRef?: { slug: string; url: string } | null;
  /**
   * The three project settings (tasks.md 3b.2). Each moves on its own: a
   * project may be switched off without forgetting which engine and objective
   * it was on, which is the whole reason they are three columns rather than
   * one nullable engine.
   */
  optimizationEnabled?: boolean;
  scheduleEngine?: ScheduleEngine;
  scheduleObjective?: SolverObjectiveName;
}

export interface ProjectStore {
  /**
   * Writes the project and its starting steps together. A project that existed
   * for even one request without steps would accept an estimate that had no
   * step to belong to, so the two are one transaction rather than two calls.
   */
  create(project: NewProject, steps: readonly Step[], stamp: WriteStamp): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  findBySolutionSlug(slug: string): Promise<Project | null>;
  /** Every project, newest first. Readable by any account, so it is not filtered by owner. */
  list(): Promise<Project[]>;
  /**
   * Every project in `userId`'s own order: the ones that account has opened
   * first, most recent before less recent, then the ones it never opened,
   * newest created first.
   *
   * Not a filter — every account still sees every project, because reading is
   * open. Only the order and the extra `lastOpenedAt` differ per caller; the
   * owner's name on each entry is the same for everybody asking.
   *
   * @throws when a listed project's owner id names no account. Every
   * implementation, the in-memory fixture included: a store that answered a
   * blank owner here would let a test pass against a list production refuses.
   */
  listFor(userId: string): Promise<ProjectWithAccess[]>;
  /**
   * Records the acting account as having opened `projectId` at the stamp's
   * instant, replacing whatever moment was recorded before. Idempotent by the
   * primary key rather than by asking first: two tabs opening one project at
   * once would both see "no row" and both insert.
   *
   * The stamp carries both halves this used to take separately — it was
   * `recordOpen(userId, projectId, at)` — because the account that opened the
   * project is the acting user and the moment it was opened is the instant of
   * the act. Two names for one fact is how the two drift apart.
   */
  recordOpen(projectId: string, stamp: WriteStamp): Promise<void>;
  /** Returns null when the project is gone. */
  update(id: string, patch: ProjectPatch, stamp: WriteStamp): Promise<Project | null>;
  stepsOf(projectId: string): Promise<Step[]>;
}
