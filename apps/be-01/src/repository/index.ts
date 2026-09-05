import type {
  DependencyReach,
  EstimateMethod,
  EstimateRounding,
  IsoDate,
  PertWeights,
  PriorityBand,
  StepState,
} from '@wbs/domain';

import type { MeasureMetric, PersonKind, ScheduleEngine, SolverObjectiveName } from './schema';

/**
 * Re-exported as types, and deliberately not as values.
 *
 * The interfaces below name both, so every caller of a store already needs
 * them; making them reachable through this module rather than through
 * `schema.ts` keeps the service layer's imports pointing at the seam it talks
 * to. The **constants** stay in `schema.ts`: this file is type-only, and a value
 * re-export here would pull drizzle into everything that imports a store
 * interface.
 */
export type { MeasureMetric, PersonKind, ScheduleEngine, SolverObjectiveName } from './schema';

/**
 * Who is acting, and when — carried into every write that stores a record.
 *
 * **One object rather than two parameters** because it is one fact: an act has
 * an actor and an instant, and a method that took them separately could be
 * handed one without the other. It is built **once per act** in the service
 * layer, which is the only layer holding both — `actorId` arrives from the
 * controller, `at` from the service's injected `now()` — and every row that act
 * writes carries the same one, so two tables touched by one act can never
 * disagree about when it happened. `WorkItemService.record` already kept that
 * discipline by hand for the journal and the plan event ("two `now()` calls
 * would let one act carry two timestamps"); this makes it the type system's.
 *
 * The repository layer deliberately has **no clock of its own**. Every instant
 * it stores arrived here, which is what lets a test drive time without a fake
 * database, and what stops one act from being dated twice.
 *
 * ADR 0012 records why this is an argument and not ambient per-request context:
 * an argument is found by the compiler at every call site, and `nx typecheck`
 * runs `tsc --build --force`, so a caller that has not been given one fails the
 * gate rather than throwing in production. It does **not** prove the columns are
 * filled — that is `auditOnCreate` / `auditOnUpdate` and `audit.test.ts`, which
 * reads this folder's source and fails naming any write that calls neither.
 */
export interface WriteStamp {
  readonly at: number;
  readonly by: string;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string | null;
  email?: string | null;
  idpIssuer?: string | null;
  idpSub?: string | null;
  createdAt: number;
}

export interface UserStore {
  /** Returns null when the username is already taken. */
  create(user: User, stamp: WriteStamp): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
}

interface OidcAccountIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

export interface OidcIdentityStore {
  /** Returns null when an existing email belongs to a different federated identity. */
  /**
   * `create` carries the id a first login would mint and **not** its instant:
   * that comes off the stamp, so one act cannot date the account one way and its
   * audit columns another. It used to be `{ id, createdAt }`, which was two
   * sources for one value.
   */
  resolveOidcIdentity(
    identity: OidcAccountIdentity,
    create: { id: string },
    stamp: WriteStamp,
  ): Promise<User | null>;
}

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

export interface Step {
  id: string;
  projectId: string;
  name: string;
  /**
   * Where this step sits in the project's step order — see `schema.ts` for why
   * the order has to be stored rather than read off the rows as they arrive.
   */
  position: number;
}

/**
 * A step as a caller offers it. The project decides where in its order the step
 * lands, in the same transaction that writes it: two clients adding a step at
 * once would otherwise both read the same last place.
 */
export type NewStep = Omit<Step, 'position'>;

/**
 * The gap between two consecutive steps' positions.
 *
 * Ten, like a work item's, and for the same reason: a step can be put between
 * two others without rewriting either.
 */
export const STEP_POSITION_STEP = 10;

/** Why a step could not be added or renamed. Both are states of the project, not faults. */
type StepWriteRefusal = 'taken' | 'not_found';

export type StepWritten = { ok: true; step: Step } | { ok: false; reason: StepWriteRefusal };

/**
 * What points at one step, read for the refusal that names it.
 *
 * The estimates are a count because a count is all anyone can act on. The
 * assignments are **every assignment in the project**, not only this step's:
 * whether a work item's assumed assignee moves when this step goes depends on
 * what it holds for the *other* steps, so the answer cannot be computed from
 * this step's rows alone. See `assumedAssigneeFlips`.
 */
export interface StepUsageRows {
  estimates: number;
  /**
   * How many actuals this step holds — a count, for {@link StepUsageRows.estimates}'
   * reason.
   *
   * Counted separately rather than added to the estimates, and counted **at
   * all**, because an actual is somebody's typing about work that has already
   * happened: a step removal that took one silently would delete the only record
   * of a week somebody spent. A step with no estimate and one actual is `in_use`.
   */
  actuals: number;
  /**
   * How many work items have said where this step's work has got to — a count,
   * for {@link StepUsageRows.estimates}' reason.
   *
   * Counted separately and counted **at all** for {@link StepUsageRows.actuals}'
   * reason, one table over: a statement is somebody's, and a step removal that
   * took one silently would turn finished work back into work nobody has
   * started, on a plan somebody is reading. A step with no estimate, no actual
   * and one stated row is `in_use`.
   */
  progress: number;
  /**
   * How many figures in the units that are not days this step holds — a count
   * of **rows**, so one pair holding a token estimate and an hours fact counts
   * two, for {@link StepUsageRows.estimates}' reason.
   *
   * Counted separately and counted **at all** for {@link StepUsageRows.actuals}'
   * reason in a third table: `token_actual` and `hours_actual` are records of
   * work that has already happened, and a removal that took them silently would
   * delete the only account of what a step's work cost. `token_estimate` is
   * counted with them rather than with the day-estimates because they share a
   * table and a key, and a count that split one table by its discriminator
   * would be reporting a schema rather than a loss.
   *
   * Rows rather than pairs because the primary key is the triple: two of the
   * three metrics on one pair are two separate statements somebody made, and
   * "1 figure" for them would understate what the cascade takes.
   */
  measures: number;
  assignments: readonly Assignment[];
}

/** What one confirmed removal took with it. */
export interface StepRemoval {
  estimates: number;
  actuals: number;
  progress: number;
  /** Rows, not pairs — {@link StepUsageRows.measures}. */
  measures: number;
  assignments: number;
  /** Every work item that lost an estimate, an actual, a state, a figure or an assignment, and whose revision therefore moved. */
  workItemIds: readonly string[];
}

/**
 * What the removal's own transaction decided, which is the only answer that
 * counts.
 *
 * `in_use` carries the usage the **transaction** read, not the usage anybody
 * counted earlier: an estimate written between a caller's count and its
 * confirmation is what this refusal is for.
 *
 * `not_found` is the loser of two removals of one step — and a step id that
 * belongs to another project, which is the same absence from this project's
 * point of view.
 */
export type StepRemoved =
  | { ok: true; removal: StepRemoval }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; usage: StepUsageRows };

export interface StepStore {
  /** In step order, which is the order every reader of a project's steps gets. */
  listByProject(projectId: string): Promise<Step[]>;
  /** By id alone: the caller checks the step belongs to the project it was asked about. */
  findById(stepId: string): Promise<Step | null>;
  /**
   * Adds a step, or refuses a name the project already holds.
   *
   * Refused by the unique index rather than by asking first: two clients adding
   * `Design` at the same moment both pass a check-then-insert. Moves the
   * project's revision in the same transaction — a step is a satellite of the
   * project, and adding one changes what every estimate in it means.
   *
   * The step lands last in the project's step order, and the written step
   * carries the place it took.
   */
  add(step: NewStep, stamp: WriteStamp): Promise<StepWritten>;
  /** The same rules as {@link StepStore.add}, and `not_found` for a step that has gone. */
  rename(stepId: string, name: string, stamp: WriteStamp): Promise<StepWritten>;
  /**
   * What points at the step right now — a **fast path** for the refusal, never
   * the authority for it. Between this answer and any delete, anybody may write.
   * {@link StepStore.remove} is what decides.
   */
  usageOf(projectId: string, stepId: string): Promise<StepUsageRows>;
  /**
   * Counts what points at the step, refuses an unconfirmed removal that would
   * take any of it, and otherwise deletes the step's estimates, its assignments
   * and the step row — all in **one** transaction, bumping the project and every
   * work item that lost one of them.
   *
   * The count lives inside the transaction because it is the decision: a caller
   * that asked without `cascade` never consented to take anything, so an
   * estimate written after that caller's own count must refuse it rather than be
   * deleted by it.
   *
   * The estimates are deleted explicitly because `estimate.step_id` has no
   * cascade: a bare delete of the row hits the foreign key and answers 500. The
   * **actuals** are deleted explicitly for exactly the same reason, and counted
   * for a stronger one — see {@link StepUsageRows.actuals}. The **stated
   * progress** goes the same way and is counted the same way, see
   * {@link StepUsageRows.progress}.
   */
  remove(
    projectId: string,
    stepId: string,
    cascade: boolean,
    stamp: WriteStamp,
  ): Promise<StepRemoved>;
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

export interface WorkItem {
  id: string;
  projectId: string;
  parentId: string | null;
  position: number;
  name: string;
  notes: string;
  frozenNumber: string | null;
  /** A day this item may not start before — a floor, never a pin. */
  startNoEarlierThan: IsoDate | null;
  /**
   * Why, in the planner's own words, or null where nobody has said.
   *
   * Words about {@link WorkItem.startNoEarlierThan} and nothing else — no state
   * and no second constraint. Null unless there is a date for it to be about:
   * `isOrphanedNotBeforeReason` in `@wbs/domain` is the rule and
   * {@link WorkItemStore.patch} is where it is refused. See `schema.ts`.
   */
  startNoEarlierThanReason: string | null;
  /**
   * How important this work is — an integer of 1 or more, smaller being more
   * important — or null for "nobody has said".
   *
   * An ordering of the leveller's queue, never a constraint on the calendar. See
   * `schedule.ts`'s `goesFirst` for what it decides and `schema.ts` for why
   * null is a state of its own.
   */
  priority: number | null;
  /** The service or team this work is labelled with, or null. */
  serviceTeamId: string | null;
  /**
   * Which service delivers this work, or null for "nobody has said".
   *
   * A column and not a set (design.md D2): one service per item. Nothing to do
   * with {@link serviceTeamId} above it, whose name is a leftover — that one is
   * a **team**, and it keeps the name for one release because blue and green
   * share one SQLite file mid-swap (D9).
   *
   * Null is _unstated_ and inherits, exactly as an empty `teamIds` or `tagIds`
   * does; see `effectiveServicesOf` in `libs/domain` for the walk. There is no
   * third "deliberately no service" state.
   *
   * On {@link WorkItem} rather than {@link LabelledWorkItem} because it is
   * stored in the row: a restore that dropped it would bring a subtree back
   * unlabelled, and the label would have been lost by the undo that was
   * supposed to preserve it.
   */
  serviceId: string | null;
  /**
   * How many people may be on this work item at once — an integer of 1 or
   * more, never null, because 1 and unset are the same fact.
   *
   * The **stored** number. What the schedule actually runs the work at is
   * narrower: `widthFor` clamps it to the team's own size and drops it to 1 for
   * a named assignee. See `schema.ts`.
   */
  maxParallel: number;
  /**
   * How many times this work item has been written to, counting writes to its
   * estimates, assignments and dependencies — and not counting a change to the
   * number derived for it. See `schema.ts` for the whole rule.
   */
  revision: number;
}

/**
 * A work item as every read of a plan gives it: the stored row, plus the teams
 * it is joined to.
 *
 * A second interface rather than a field on {@link WorkItem}, because
 * {@link WorkItem} is also what a **write** takes — `insert`, the journal's
 * `restore_subtree` rows and every fixture build one — and `work_item` has no
 * column for a set. The two shapes are genuinely different facts about the same
 * thing: what is stored in the row, and what is joined to it.
 *
 * `teamIds` is ordered by team id, so two reads of an unchanged plan answer the
 * same array — `openspec/changes/team-sets/design.md` D6. Empty means the row
 * states nothing and inherits; see `effectiveTeamsOf` in `libs/domain`.
 */
export interface LabelledWorkItem extends WorkItem {
  teamIds: readonly string[];
  /**
   * What kind of thing the row is, 0..n, and **independent of `teamIds` in every
   * respect** — a row states either, both or neither, and inheriting one says
   * nothing about the other.
   *
   * Ordered by tag id, for `teamIds`' reason. **What the row states, and only
   * that**: the tags in force on it are these plus every ancestor's, unioned by
   * `effectiveTagsOf` in `libs/domain` (ADR 0008). A row that states none is not
   * a special case there — it simply adds nothing to what it was carrying.
   *
   * Unlike `teamIds` this has no column behind it and never had one: there is no
   * `work_item.tagId` to be the outgoing release's copy, because the dimension
   * arrived after the set was already the shape. `work_item_tag` is the whole of
   * the fact.
   */
  tagIds: readonly string[];
  /**
   * What this row delivers, 0..n, off `work_item_service` and **never**
   * `work_item.service_id`.
   *
   * Here from task 10.2, where the third dimension stopped being a column: the
   * comment this replaces argued the field would be a second declaration of the
   * fact the row already carried, and that argument died with the join table.
   * {@link WorkItem.serviceId} is still declared and still written by the
   * outgoing release, and is read by nothing in this one (design D2) — so this
   * is now the only place a reader may learn what a row delivers.
   *
   * Ordered by service id, `teamIds`' rule and for its reason: two reads of an
   * unchanged plan answer the same array. Empty means the row states nothing and
   * inherits; see `effectiveServicesOf` in `libs/domain`.
   */
  serviceIds: readonly string[];
  /**
   * What kind of work the row **is**, 0..n — `Story`, `Bug`, `Spike`, `Epic`.
   *
   * The fourth dimension, and the one whose empty case does **not** mean what
   * the other three's does. Empty here means the row has no type, full stop: it
   * does not inherit, there is no `effectiveTypesOf` beside `effectiveTagsOf`,
   * and a reader may take this array as the whole answer. A child of an `Epic`
   * is emphatically not an `Epic`, which is the argument in
   * `docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`.
   *
   * That makes this the only one of the four a face can draw without walking the
   * tree, and the only one whose chips are all removable — nothing on it was
   * stated somewhere else.
   *
   * Ordered by type id, `teamIds`' rule and for its reason: two reads of an
   * unchanged plan answer the same array.
   */
  typeIds: readonly string[];
  /**
   * Where this row's work also exists, in the order the refs were added.
   *
   * **Not a label set, and the only reference-shaped field here that is a list
   * of records rather than of ids.** A tag or a service is a name from a
   * vocabulary; a ref is a vocabulary name *plus* the address of one thing, and
   * two refs into the same system are two different links rather than one fact
   * stated twice.
   *
   * Nothing inherits here either: a ref is on the row that carries it.
   */
  externalRefs: readonly ExternalRef[];
}

/**
 * One link out of a work item: which system, and where.
 *
 * `systemId` is the **stored** derivation (design D1) — `systemOfUrl` answered
 * it when the ref was written and nothing re-derives it on read, so a ref keeps
 * the type it was given when the rule later changes.
 *
 * `url` is a string and not a parsed URL: it is stored as typed, and every
 * surface that renders it as a link checks the scheme first. A `javascript:`
 * URL written by a peer edit is the fault that rule exists for.
 */
export interface ExternalRef {
  id: string;
  systemId: string;
  url: string;
}

/**
 * One external system in the global directory — {@link Tag}'s two columns.
 *
 * Seeded where the tag is empty: these names are what `systemOfUrl` can answer,
 * so the vocabulary and the deriving rule are one fact.
 */
export interface ExternalSystem {
  id: string;
  name: string;
}

/**
 * One tag in the global directory: an id and a name, and deliberately nothing
 * else.
 *
 * **No size and no capacity**, unlike {@link ServiceTeam}, which still carries
 * a retired `size`. That absence is the model rule — a tag says what kind of
 * thing a work item is, and nothing about a tag is ever spent — and it is
 * visible here, in the table, and on the directory page, which renders tags
 * with no capacity column.
 */
export interface Tag {
  id: string;
  name: string;
}

/**
 * What a tag rename answered.
 *
 * `taken` carries no surviving name here — the caller has it, because it typed
 * it — and the controller turns this into the 409 the directory page shows.
 * {@link ServiceTeamWritten}'s shape, one dimension over.
 *
 * `projectIds` is every project holding a row that carries the tag, read in the
 * rename's own transaction so the events published after it name the plans that
 * were labelled when it happened.
 */
export type TagWritten =
  | { ok: true; tag: Tag; projectIds: readonly string[] }
  | { ok: false; reason: 'taken' | 'not_found' };

/**
 * One work item type in the global directory: an id and a name, nothing else.
 *
 * {@link Tag}'s two columns, for {@link Tag}'s reason — nothing about a type is
 * ever spent — and for one more of its own: the change that adds this dimension
 * rules out a type deciding anything, so there is deliberately no colour here,
 * no default, no ordering weight and no `isDefault`. A type is a label, and a
 * reader's taxonomy is not the tool's to interpret.
 */
export interface WorkItemType {
  id: string;
  name: string;
}

/**
 * What a work item type rename answered — {@link TagWritten}'s shape, one
 * dimension over, including `taken` carrying no surviving name because the
 * caller typed it.
 *
 * `projectIds` is every project holding a row that carries the type, read in the
 * rename's own transaction so the events published after it name the plans that
 * were labelled when it happened.
 */
export type WorkItemTypeWritten =
  | { ok: true; workItemType: WorkItemType; projectIds: readonly string[] }
  | { ok: false; reason: 'taken' | 'not_found' };

/**
 * One service in the global directory: an id and a name, and nothing else.
 *
 * {@link Tag}'s two columns, and for a different reason than the tag's. A tag
 * has no size because nothing about a tag is ever spent; a service has none
 * because a service is not a pool either — it is what the work is part of, and
 * who has the people is {@link ServiceTeam}, whose name is a leftover. The
 * ownership between the two is `team_service`, read through
 * {@link DirectoryStore} and never a column here.
 */
export interface Service {
  id: string;
  name: string;
}

/**
 * What a service rename answered — {@link TagWritten}'s shape, one dimension
 * over, and the same reading of each arm.
 *
 * `projectIds` is every project holding a work item that names the service,
 * read inside the rename's own transaction so the events published after it
 * name the plans that were labelled when it happened.
 */
export type ServiceWritten =
  | { ok: true; service: Service; projectIds: readonly string[] }
  | { ok: false; reason: 'taken' | 'not_found' };

export interface WorkItemPatch {
  name?: string;
  notes?: string;
  /** `null` removes the constraint and lets the dependencies alone decide. */
  startNoEarlierThan?: IsoDate | null;
  /**
   * Why the work is held back, or `null` to take the words off and leave the
   * date.
   *
   * **A patch that leaves this row with a reason and no date is refused** —
   * `not_before_reason_needs_a_date`, decided against the row as it will stand
   * rather than against this patch, because a patch naming only the reason is
   * legal on a row that already has a date and illegal on one that does not.
   * The commonest way to meet it is taking the date off and forgetting the
   * words: `{ startNoEarlierThan: null }` on a row that has a reason is refused,
   * and `{ startNoEarlierThan: null, startNoEarlierThanReason: null }` is the
   * request that means it. Nothing is cleared on the caller's behalf — the words
   * are somebody's sentence, and deleting them quietly is worse than a 400.
   *
   * Length is the controller's (`LONGEST_NOT_BEFORE_REASON`), which is also
   * where a blank becomes this `null`, so `''` never reaches the column.
   */
  startNoEarlierThanReason?: string | null;
  /**
   * An integer of 1 or more, or `null` to leave this work with no priority.
   *
   * Validated at the controller, which is the only place a value that is not a
   * whole number of at least 1 can enter: the column is an integer and the
   * leveller reads it as a priority, so a 0 or a 1.5 would order the queue by a
   * number nobody could have meant.
   */
  priority?: number | null;
  /** `null` takes the label off. Never constrains who may be assigned the work. */
  serviceTeamId?: string | null;
  /**
   * The row's whole own team set. Absent leaves it alone and `[]` makes it
   * unstated. Kept beside `serviceTeamId` for one compatibility release; the
   * controller refuses requests that name both.
   */
  teamIds?: readonly string[];
  /**
   * Which services deliver this work, as the **whole** set. Absent leaves the
   * dimension alone, like every other field here; `[]` is the one spelling of
   * taking the label off, and puts the row back to inheriting its ancestors'.
   *
   * A **set, replaced whole**, which is {@link tagIds}'s rule and no longer the
   * inverse of it — the scalar this replaces was the column's shape, and task
   * 10.2 took the column out of the read path. There is no `null` arm any more:
   * a set has an empty spelling, so the second spelling of "no service" that
   * `null` used to be would now be two ways to say one thing.
   *
   * Deduplicated by the store on the way in — the join's primary key would
   * refuse a repeated pair, and a payload naming one service twice is a client
   * being untidy rather than a request that means anything else.
   *
   * An id the directory no longer holds refuses the **whole** patch with
   * `unknown_service`, decided **inside the transaction that performs the
   * update** — {@link serviceTeamId}'s argument, plus `work_item_tag`'s: the
   * join cascades, so a service removed between a precheck and this write
   * leaves nothing for a foreign key to catch and the insert would answer a 500
   * where the honest answer names the service.
   */
  serviceIds?: readonly string[];
  /**
   * How many people may be on this work item at once — an integer of 1 to
   * 1000, or `null` to put it back to one at a time.
   *
   * `null` **resets** where `priority`'s clears: `work_item.max_parallel` is
   * `NOT NULL` because 1 and unset are the same fact, and a second spelling of
   * one fact is what the column's default exists to prevent. The store turns
   * the `null` into a 1 rather than writing it — see
   * {@link WorkItemStore.patch}.
   *
   * Validated at the controller, which is the only place a value that is not a
   * whole number of 1 to 1000 can enter. A 0 there would be a width of 0, and
   * `effort / 0` is a plan of `Infinity` dates.
   */
  maxParallel?: number | null;
  /**
   * What kind of thing this work item is, **whole**: the set as it will stand,
   * never a member to add or remove.
   *
   * `[]` takes every tag off, and there is no `null` arm because there is
   * nothing else `[]` could mean — a tag has no column to reset to a default,
   * unlike {@link maxParallel}, and no third "deliberately untagged" state,
   * unlike nothing at all in this model. Absent leaves the row's tags alone,
   * which is the same reading every other field here takes.
   *
   * Whole rather than a delta because the undo journal has to carry a
   * before-value that restores what was there: a patch of "add `regulatory`"
   * has no inverse that a second patch can express, and the compensating
   * command for a set is the prior set. That is the seam a scalar habit loses
   * data at, and it has its own watched red in the service.
   *
   * An id the directory no longer holds is refused with `unknown_tag`, decided
   * **inside the transaction that performs the update** — `serviceTeamId`'s
   * argument exactly, and for a stronger reason: `work_item_tag.tag_id`
   * cascades, so an id removed in the gap between a precheck and the write
   * would not fail on a foreign key at all. It would insert against a `tag` row
   * that is gone, and SQLite would refuse it — but the refusal a reader gets
   * must name the tag rather than be a 500, and only the transaction can.
   */
  tagIds?: readonly string[];
  /**
   * What kind of work this row **is**, **whole**: the set as it will stand,
   * never a member to add or remove — {@link tagIds}'s rule and every one of its
   * reasons, including the undo journal needing a before-value that restores.
   *
   * `[]` takes every type off and is the only spelling of it. Unlike
   * {@link tagIds}, `[]` here also has no inheritance behind it to fall back to:
   * a row with no types has no types, so this is the one dimension where the
   * empty set and the answer a reader sees are the same thing
   * (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`).
   *
   * An id the directory no longer holds refuses the **whole** patch with
   * `unknown_type`, decided **inside the transaction that performs the update**
   * — {@link tagIds}'s argument unchanged: the join cascades, so an id removed
   * between a precheck and this write leaves nothing for a foreign key to catch,
   * and the refusal a reader gets must name the type rather than be a 500.
   */
  typeIds?: readonly string[];
  /**
  /**
   * Where this row's work also exists, **whole**: the list as it will stand.
   *
   * `tagIds`' replacement rule and its undo argument, with one difference that
   * matters — the members are records, so "the same list" means the same refs in
   * the same order rather than the same set of ids. `[]` removes every ref.
   *
   * A ref whose `systemId` the directory does not hold refuses the **whole**
   * patch with `unknown_system`, decided inside the write's transaction:
   * `work_item_external_ref.system_id` cascades, so a system removed between a
   * precheck and the write leaves nothing for a foreign key to catch.
   */
  externalRefs?: readonly ExternalRefWrite[];
}

/** A ref as a caller states it — no `id`, because the store mints one per row. */
interface ExternalRefWrite {
  systemId: string;
  url: string;
}

/**
 * What a patch answered: the written row, or the reason nothing was written.
 *
 * `unknown_team` is a `serviceTeamId` the directory no longer holds, decided
 * **inside the transaction that performs the update**. It is not a service-level
 * precheck's answer: a check one statement earlier passes for a team removed in
 * the gap, and the update then fails on the column's own foreign key — a 500 for
 * a request whose only fault is being out of date. `assignment.person_id`'s
 * case exactly, and the same shape of answer.
 *
 * The column's foreign key is real, and this comment said the opposite until
 * `team-sets` measured it (2026-08-14): `work_item.service_team_id` was added
 * by `ALTER TABLE … ADD … REFERENCES service_team(id)` with no `ON DELETE`
 * action, so SQLite refuses both an unknown id and the delete of a team any row
 * still names. What has no cascade is the *delete* — which is why
 * {@link DirectoryStore.removeTeam} nulls the labels itself.
 *
 * `unknown_tag` is the same answer for the other label dimension, decided in
 * the same transaction and argued in {@link WorkItemPatch.tagIds}. The two are
 * deliberately separate reasons rather than one `unknown_label`: a reader told
 * a label is gone has to know **which** picker to reopen, and the two
 * dimensions are independent everywhere else in this model.
 *
 * `unknown_service` is the third dimension's, and a third reason for the same
 * reason: three pickers now, and "a label is gone" would leave a reader opening
 * all of them. `work_item.service_id` has `ON DELETE SET NULL`, so unlike the
 * tag it *would* be caught by the column's own foreign key — as a raw
 * `FOREIGN KEY constraint failed`, which is a 500 where the honest answer names
 * the service.
 *
 * `not_before_reason_needs_a_date` is decided in the same transaction and for a
 * version of the same reason: the rule is about the row **as it will stand**, so
 * it has to be asked against the stored date and the patch's together, and a
 * service-level precheck followed by an update is two statements with a
 * concurrent write's worth of gap between them — another patch clearing the date
 * in that gap leaves exactly the pair this refuses. There is no constraint
 * behind it to catch that (the migration argues why a `CHECK` here would 500 the
 * outgoing release mid-swap), so this transaction is the whole of the guarantee.
 */
export type WorkItemPatched =
  | { ok: true; workItem: WorkItem }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'unknown_team'
        | 'unknown_tag'
        | 'unknown_service'
        | 'unknown_type'
        | 'unknown_system'
        | 'not_before_reason_needs_a_date';
    };

/**
 * What an assignment write answered.
 *
 * `unknown_person` is decided inside the write's own transaction, for the
 * mirror-image reason: `assignment.person_id` *does* have a foreign key, so a
 * person removed in the gap makes the insert answer a raw constraint failure —
 * a 500 for a request whose only fault is being out of date.
 */
export type AssignmentWritten = { ok: true } | { ok: false; reason: 'unknown_person' };

/** A position write the caller has already worked out, applied with whatever prompted it. */
export interface Repositioned {
  id: string;
  position: number;
}

/** A promoted child: a new parent and a new place among its new siblings. */
export interface Reparented extends Repositioned {
  parentId: string | null;
}

export interface FrozenNumber {
  id: string;
  frozenNumber: string | null;
}

export interface WorkItemStore {
  /**
   * Every work item of one project, each carrying the teams it is joined to.
   *
   * The join is the read since `team-sets`: `work_item.service_team_id` is
   * still written beside it and is still what the outgoing release selects, but
   * nothing here consults it.
   */
  listByProject(projectId: string): Promise<LabelledWorkItem[]>;
  findById(id: string): Promise<WorkItem | null>;
  /**
   * Inserts, and respaces the sibling group in the same transaction when the
   * insertion had no gap to take. Two calls would leave a window in which two
   * siblings share a position, and the number derived in that window would be
   * wrong for whoever read it.
   */
  insert(workItem: WorkItem, respaced: readonly Repositioned[], stamp: WriteStamp): Promise<void>;
  /**
   * Applies the patch and validates any `serviceTeamId` it names **in one
   * transaction** — see {@link WorkItemPatched}. A patch naming no field writes
   * nothing and answers the row it found.
   */
  patch(id: string, patch: WorkItemPatch, stamp: WriteStamp): Promise<WorkItemPatched>;
  move(
    id: string,
    parentId: string | null,
    position: number,
    respaced: readonly Repositioned[],
    stamp: WriteStamp,
  ): Promise<void>;
  /**
   * Writes or clears stored numbers. `null` returns a work item to deriving.
   *
   * A freeze is one call rather than a write per work item: a project half
   * frozen is a project where some numbers moved and some did not, and nobody
   * reading it could tell which.
   */
  setFrozenNumbers(updates: readonly FrozenNumber[], stamp: WriteStamp): Promise<void>;
  /** Removes `ids` and applies `promoted` together, so a promotion cannot outlive its parent. */
  remove(ids: readonly string[], promoted: readonly Reparented[], stamp: WriteStamp): Promise<void>;
}

export interface StoredEstimate {
  workItemId: string;
  stepId: string;
  optimistic: number;
  realistic: number;
  pessimistic: number;
}

export interface EstimateStore {
  listByProject(projectId: string): Promise<StoredEstimate[]>;
  /** Writes one work item's estimate for one step, replacing any earlier one. */
  set(estimate: StoredEstimate, stamp: WriteStamp): Promise<void>;
  /**
   * Takes away one work item's estimate for one step, leaving every other
   * step on that work item and that step on every other work item alone.
   *
   * Removing one that is not stored is not an error: the state asked for is
   * the state left, and two people emptying the same three boxes must not turn
   * the second one into a failure on screen.
   */
  remove(workItemId: string, stepId: string, stamp: WriteStamp): Promise<void>;
  /**
   * Moves every estimate from one work item to another.
   *
   * Used in both directions by the same rule: an estimated work item that gains
   * its first child hands the estimate down, and a work item whose last child is
   * deleted takes it back. Neither is a merge — a parent never holds estimates of
   * its own while it has children.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}

/**
 * The days one step spent on one work item, and when somebody said so.
 *
 * One number rather than a trio: an estimate is a guess about a range and an
 * actual is a fact about what happened.
 */
export interface StoredActual {
  workItemId: string;
  stepId: string;
  days: number;
  /** When the number was typed, in epoch milliseconds. */
  recordedAt: number;
}

/** One actual row's whole identity: the pair its primary key is. */
export interface ActualKey {
  workItemId: string;
  stepId: string;
}

/**
 * Reading and writing the days actually spent.
 *
 * Deliberately the same four methods as {@link EstimateStore}, in the same
 * order, doing the same things to a table with the same key. Actuals follow
 * estimates through every structural change — the hand-down when a leaf gains
 * its first child, the hand-up when a parent loses its last, the copy a
 * duplication makes, the restore an undo runs — and the way to keep those two
 * sets of rules from drifting is for the second store to have no shape of its
 * own to drift into.
 */
export interface ActualStore {
  /** Every actual in the project, in step order within each work item. */
  listByProject(projectId: string): Promise<StoredActual[]>;
  /** Writes one work item's actual for one step, replacing any earlier one. */
  set(actual: StoredActual, stamp: WriteStamp): Promise<void>;
  /**
   * Takes away one work item's actual for one step, leaving every other step on
   * that work item and that step on every other work item alone.
   *
   * Removing one that is not stored is not an error, for
   * {@link EstimateStore.remove}'s reason: the state asked for is the state
   * left.
   */
  remove(workItemId: string, stepId: string, stamp: WriteStamp): Promise<void>;
  /**
   * Moves every actual from one work item to another, exactly as
   * {@link EstimateStore.moveAll} does and at the same call sites.
   *
   * A leaf that gains its first child stops holding figures of its own — its
   * numbers become the sum of what is below it — so an actual left behind would
   * be a row no reader can see and no writer can reach: invisible, not zero, and
   * back on screen if the child is ever deleted.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}

/**
 * Where one step's work on one work item has got to, and when somebody said so.
 *
 * `state` is one of the two a step may be **stored** in. The third state — not
 * started — is the absence of this row, so it has no spelling here and cannot
 * be written by anybody: see {@link StepState} in `@wbs/domain`.
 */
export interface StoredProgress {
  workItemId: string;
  stepId: string;
  state: StepState;
  /** When somebody said so, in epoch milliseconds. */
  statedAt: number;
}

/** One progress row's whole identity: the pair its primary key is. */
export interface ProgressKey {
  workItemId: string;
  stepId: string;
}

/**
 * Reading and writing where the work has got to.
 *
 * Deliberately the same four methods as {@link ActualStore}, in the same order,
 * doing the same things to a table with the same key — and for the reason that
 * store gives for being a copy of {@link EstimateStore}. A state follows its
 * work item through every structural change: the hand-down when a leaf gains its
 * first child, the hand-up when a parent loses its last, the restore an undo
 * runs. The failure this shape prevents is the one where estimates and actuals
 * follow a subtree and the statement about them quietly does not — a branch that
 * comes back from an undo reading "not started" over work somebody finished.
 */
export interface StepProgressStore {
  /** Every stated step on every work item in the project, in step order within each. */
  listByProject(projectId: string): Promise<StoredProgress[]>;
  /** States one work item's step, replacing whatever it said before. */
  set(progress: StoredProgress, stamp: WriteStamp): Promise<void>;
  /**
   * Takes the statement back, leaving every other step on that work item and
   * that step on every other work item alone.
   *
   * Removing one that is not stored is not an error, for
   * {@link EstimateStore.remove}'s reason: the state asked for is the state
   * left. What it leaves behind is "not started", which is the absence of a row
   * and never a row saying so.
   */
  remove(workItemId: string, stepId: string, stamp: WriteStamp): Promise<void>;
  /**
   * Moves every statement from one work item to another, exactly as
   * {@link ActualStore.moveAll} does and at the same call sites.
   *
   * A leaf that gains its first child stops holding a state of its own — its
   * reading is folded from what is below it — so a row left behind would be
   * invisible to every reader and back on screen the day the child is deleted,
   * claiming work is finished that the plan has since moved on from.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}

/**
 * What one step's work on one work item cost in one unit that is not days, and
 * when somebody said so.
 *
 * `metric` is part of the identity rather than a property of it: the same pair
 * holding a token estimate, a token fact and an hours fact is three of these,
 * and each is absent on its own. See {@link stepMeasure} in `schema.ts` and
 * `openspec/changes/token-tracking/design.md` D1.
 */
export interface StoredMeasure {
  workItemId: string;
  stepId: string;
  metric: MeasureMetric;
  /** The figure itself — tokens or hours, in whatever `metric` says. */
  value: number;
  /** When the number was typed, in epoch milliseconds. */
  recordedAt: number;
}

/** One measure row's whole identity: the triple its primary key is. */
export interface MeasureKey {
  workItemId: string;
  stepId: string;
  metric: MeasureMetric;
}

/**
 * Reading and writing the figures that are not days.
 *
 * Deliberately the same four methods as {@link ActualStore}, in the same order,
 * doing the same things to a table whose key is that one's with a third column
 * on the end — and for the reason that store gives for being a copy of
 * {@link EstimateStore}. Measures follow their work item through every
 * structural change: the hand-down when a leaf gains its first child, the
 * hand-up when a parent loses its last, the restore an undo runs. The failure
 * this shape prevents is the one where estimates and actuals follow a subtree
 * and the tokens quietly do not.
 *
 * **The third key column reaches exactly one of these four.** {@link remove}
 * names one row, so it takes the metric; {@link set} carries it in the record.
 * {@link listByProject} and {@link moveAll} name no row and take none — the
 * first because the roll-up folds all three metrics from one read, the second
 * because a leaf gaining a child stops holding figures in every unit at once.
 */
export interface MeasureStore {
  /** Every measure in the project, in step order within each work item and metric order within each pair. */
  listByProject(projectId: string): Promise<StoredMeasure[]>;
  /**
   * Writes one work item's figure in one metric for one step, replacing any
   * earlier one in that metric and leaving the pair's other metrics alone.
   */
  set(measure: StoredMeasure, stamp: WriteStamp): Promise<void>;
  /**
   * Takes away one work item's figure in one metric for one step, leaving every
   * other metric on that pair, every other step on that work item and that step
   * on every other work item alone.
   *
   * Removing one that is not stored is not an error, for
   * {@link EstimateStore.remove}'s reason: the state asked for is the state
   * left. What it leaves behind is nobody having said, which is the absence of a
   * row and never a stored zero.
   */
  remove(
    workItemId: string,
    stepId: string,
    metric: MeasureMetric,
    stamp: WriteStamp,
  ): Promise<void>;
  /**
   * Moves every measure in every metric from one work item to another, exactly
   * as {@link ActualStore.moveAll} does and at the same call sites.
   *
   * A leaf that gains its first child stops holding figures of its own — its
   * numbers become the sum of what is below it — so a measure left behind would
   * be a row no reader can see and no writer can reach: invisible, not zero, and
   * back on screen if the child is ever deleted.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}

/** A finish-to-start edge as it is stored: either end may be a parent. */
export interface StoredDependency {
  id: string;
  projectId: string;
  predecessorId: string;
  successorId: string;
}

export interface DependencyStore {
  listByProject(projectId: string): Promise<StoredDependency[]>;
  /**
   * Writes the edge, or does nothing if it is already there.
   *
   * Idempotent at the database through the unique pair rather than by asking
   * first: two clients drawing the same arrow at once would both see "not there"
   * and both insert.
   */
  add(dependency: StoredDependency, stamp: WriteStamp): Promise<void>;
  remove(predecessorId: string, successorId: string, stamp: WriteStamp): Promise<void>;
  /**
   * Every edge touching any of these work items, so deleting the rows can take
   * them along.
   *
   * Takes the whole doomed set rather than one id at a time. A subtree delete
   * knows every row it is about to remove, and calling this once per row cost
   * one transaction, one read and one write **each** — and bumped rows that
   * were themselves on the way out, because from inside a single-id call a
   * doomed sibling is indistinguishable from a survivor.
   */
  removeAllFor(workItemIds: readonly string[], stamp: WriteStamp): Promise<void>;
}

/**
 * A service or team work can be labelled with. Global, shared by every project.
 *
 * **No `size`.** The column is still in the table — blue and green share one
 * SQLite file and the outgoing release still selects it, which is `design.md`
 * D4 — but nothing in this release reads it, and this type is where that claim
 * is enforced rather than asserted. A team's capacity is a fact about one
 * project now: {@link CapacityStore}.
 *
 * It is also the shape `/api/teams` answers with, so leaving `size` here would
 * put the retired number back on the wire through an unqualified `select()`,
 * which is exactly how it got there before this type said no.
 */
export interface ServiceTeam {
  id: string;
  name: string;
}

/**
 * A team and the services it is **responsible for** — the ownership map, read
 * on the team's own row.
 *
 * {@link PersonWithTeams}' shape one dimension over, and the resemblance stops
 * at the shape: a person's `teamIds` says who they work with, and a team's
 * `serviceIds` says what it is accountable for. Neither labels a work item.
 *
 * Empty means a team that owns nothing, which is every team the day this ships
 * — the map starts with no data by design, because nothing may invent who owns
 * what.
 */
export interface TeamWithServices extends ServiceTeam {
  serviceIds: string[];
}

/**
 * A change to one team: a new name, a new owned set, or both.
 *
 * `serviceIds` is a **full replacement**, exactly as {@link PersonPatch}'
 * `teamIds` is, so an absent field and an empty array mean different things:
 * absent leaves the map alone, empty makes the team own nothing. A patch
 * naming neither is refused rather than answered as a no-op.
 */
export interface TeamPatch {
  name?: string;
  serviceIds?: readonly string[];
}

/**
 * Somebody who does work. Not an account on this tool.
 *
 * `kind` is **required, because every row read back carries one**: the column is
 * `NOT NULL DEFAULT 'person'` and the migration wrote `person` onto every row
 * that predates it, so there is no person in the database without a kind and no
 * read path that could produce one. It was optional between 2.1 and this
 * narrowing only because making it required means a separate input type for the
 * insert, which is {@link PersonInsert}.
 *
 * It is declared at all because it *arrives* at all: `DirectoryRepository`
 * spreads the Drizzle row, so `kind` reached the API response the moment the
 * column existed, and a type that denied it would have been a lie TypeScript
 * cannot catch — excess properties survive a spread. Required is the stronger
 * form of the same argument: a caller that reads a person and renders `kind`
 * now needs no `?? 'person'` fallback, and a fallback is where the two spellings
 * of "unknown kind" would have started to diverge.
 */
export interface Person {
  id: string;
  name: string;
  kind: PersonKind;
}

/**
 * What an insert of a person may name, which is **not** what a read of one
 * carries: `kind` is optional here and required on {@link Person}.
 *
 * The asymmetry is the column's, not a convenience. `NOT NULL DEFAULT 'person'`
 * means a two-column insert is a legal insert — that is exactly what lets the
 * outgoing release keep writing people across a blue/green swap — while every
 * row that comes back out has a kind whether or not anybody sent one.
 *
 * `kind` is on the type rather than left off because the table takes it, not
 * because a caller sends it today: `DirectoryService.addPerson` omits it, and
 * the API's way to make an agent is `PATCH /people/:id` (4.4). A store method is
 * the table's contract, and `adds an agent when the insert names one` in
 * `directory.test.ts` holds the store to it.
 */
export interface PersonInsert {
  id: string;
  name: string;
  kind?: PersonKind;
}

/** A person and the teams they belong to — empty means a free agent. */
export interface PersonWithTeams extends Person {
  teamIds: string[];
}

/** Who is doing one work item's work for one step. */
export interface Assignment {
  workItemId: string;
  stepId: string;
  personId: string;
}

/**
 * What a directory write answered.
 *
 * `taken` is the unique index on the name refusing a second row, translated
 * rather than thrown — two people renaming towards the same name is an ordinary
 * race, not a fault. `not_found` is an id the directory no longer holds, which
 * is the loser of two removals and a client working from a stale picker.
 */
type DirectoryWriteRefusal = 'not_found' | 'taken';

/**
 * Every project a directory write touched, collected **inside the write's own
 * transaction** — the projects holding a work item that carries the renamed
 * team or an assignment naming the renamed person.
 *
 * It rides on the outcome rather than being read again afterwards because the
 * rows it is read from are exactly the rows the write is about: a second read
 * would be answering a question about a directory that had already moved on.
 */
export type TouchedProjects = readonly string[];

/**
 * What a team patch answered.
 *
 * The team comes back **with its owned set**, for {@link PersonWritten}'s
 * reason: the caller has just replaced it, and a client that had to re-read the
 * directory to see what it wrote would render the set it sent rather than the
 * set that is there.
 *
 * `unknown_service` refuses the **whole** patch, rename included —
 * `team_service.service_id` is a foreign key, so the alternative is a raw
 * constraint failure, and a half-applied patch is not an observable state.
 */
export type ServiceTeamWritten =
  | { ok: true; team: TeamWithServices; projectIds: TouchedProjects }
  | { ok: false; reason: DirectoryWriteRefusal | 'unknown_service' };

/**
 * A change to one person: a new name, a new set of memberships, or both.
 *
 * `teamIds` is a **full replacement**, so an absent field and an empty array
 * mean different things: absent leaves the memberships alone, empty makes the
 * person a free agent.
 *
 * `kind` is how a person becomes an agent and back again, and patching it back
 * is the **only** undo it has: the directory journals nothing — no call to
 * `record` anywhere in `directory.service.ts` — and it cannot, because
 * `plan_event.project_id` is `NOT NULL REFERENCES project(id) ON DELETE
 * CASCADE` while the directory belongs to no project. A person's history would
 * have to be filed under an invented project and would vanish with it.
 * `openspec/changes/token-tracking/tasks.md` 4.4 carries the whole argument.
 */
export interface PersonPatch {
  name?: string;
  teamIds?: readonly string[];
  kind?: PersonKind;
}

export type PersonWritten =
  | { ok: true; person: PersonWithTeams; projectIds: TouchedProjects }
  | { ok: false; reason: DirectoryWriteRefusal | 'unknown_team' };

/**
 * What a create answered.
 *
 * `unknown_team` refuses the **whole** create rather than making the person and
 * dropping the membership: `person_team.service_team_id` is a foreign key, so
 * the alternative is not a partial success but a raw constraint failure — a 500
 * for a client whose picker was rendered a moment too early.
 */
export type PersonAdded = { ok: true; person: Person } | { ok: false; reason: 'unknown_team' };

/**
 * The rows a refused directory removal is described from, read in one place for
 * both the fast path and the transaction that decides.
 *
 * **Whole projects, not only the touched rows.** A work item's number is
 * derived from the tree it sits in, so naming `3.1` needs every sibling and
 * ancestor around it; reading only the rows that point at the entity would name
 * them by a number nobody's screen shows.
 *
 * `assignments` are every assignment in those projects rather than the ones
 * naming the entity, for the reason {@link StepUsageRows} gives: whether a work
 * item's **assumed assignee** moves depends on what it holds for the *other*
 * steps.
 */
export interface DirectoryUsageRows {
  /**
   * Labelled, because the usage is computed through `effectiveTeamsOf` — which
   * reads the join and never the column — and a row without its set would make
   * every effect the confirmation names come out empty.
   */
  workItems: readonly LabelledWorkItem[];
  projects: readonly { id: string; name: string }[];
  assignments: readonly Assignment[];
  steps: readonly { id: string; name: string }[];
  /** Every person an assignment above names, so an effect can say who rather than which id. */
  people: readonly Person[];
  /**
   * People whose membership the removal would drop, **other than the entity
   * being removed**. Empty for a person: their own memberships name nobody
   * else and go with them, so they force no confirmation.
   *
   * Named rather than {@link Person}, the shape `projects` and `steps` above
   * already use: the confirmation prints who loses the membership, and
   * `directory-usage.ts` narrows this to `{ id, name }` before it leaves the
   * service. Widening it to a whole person would mean reading a `kind` column
   * to satisfy a type, which is the tail wagging the query.
   */
  members: readonly { id: string; name: string }[];
  /**
   * What each project in this usage has stated about the team being removed, as
   * `projectId -> slots`. Empty when the usage is a person's.
   *
   * Carried because removing a team a project has **stated a capacity for** does
   * more than null a label: it takes a pool constraint away, and every row whose
   * effective team is this one moves. The reader cannot tell that from the work
   * items alone, and a confirmation that says only "the label goes" about a
   * removal that also moves every date is a confirmation of the wrong thing.
   *
   * **Per project, and that is the change `capacity-per-project` made here.** The
   * same team may be stated at four on one plan and unstated on the next, so a
   * single number for the whole confirmation would name a bound that does not
   * apply to half the rows it is printed on.
   */
  capacityOf: ReadonlyMap<string, number>;
}

/** What one confirmed directory removal took with it. */
export interface DirectoryRemoval {
  /** Every work item that lost an assignment or a label, and whose revision therefore moved. */
  workItemIds: readonly string[];
  /** Every project one of those work items sits in — who has to be told. */
  projectIds: readonly string[];
}

/**
 * What a removal's own transaction decided, which is the only answer that
 * counts.
 *
 * `in_use` carries the usage the **transaction** read, not the usage anybody
 * counted earlier: an assignment written between a caller's count and its
 * confirmation is what this refusal is for.
 */
export type DirectoryRemoved =
  | { ok: true; removal: DirectoryRemoval }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; usage: DirectoryUsageRows };

/** How many of one team may be at work at once on one project's plan. */
export interface TeamCapacity {
  serviceTeamId: string;
  /** At least 1. There is no `null` here: unstated is the absence of an entry. */
  size: number;
}

/**
 * What a capacity write decided. `not_found` is a project or a team nothing
 * holds, and it is decided by reading both inside the write's own transaction
 * rather than in front of it.
 */
export type CapacityWritten = { ok: true } | { ok: false; reason: 'not_found' };

/**
 * How many of each team may be at work at once, per project.
 *
 * This is C1's `slotsOf` seam with the lookup behind it at last, and the reason
 * it is a store of its own rather than four methods on {@link DirectoryStore}:
 * the fact is a **project's**, not the directory's, and the directory store is
 * the thing the global list is read through. See
 * `openspec/changes/capacity-per-project/design.md` D3 and D6.
 *
 * There is deliberately no read of `serviceTeam.size` anywhere in here. A pair
 * with no row is _unstated_ and constrains nothing — Dany's call, 2026-08-13,
 * and the whole of D1.
 */
export interface CapacityStore {
  /**
   * The slots this project may take of each team it has stated a number for —
   * keyed on the team alone, because one call is one project.
   *
   * A team the project has stated nothing about is **absent from the map**, not
   * present as `null` or as `Infinity`: the engine reads an absent key as
   * unconstrained, which is exactly what unstated means.
   */
  slotsFor(projectId: string): Promise<Map<string, number>>;
  /** The same fact in the shape the payload carries, in team-id order. */
  listFor(projectId: string): Promise<TeamCapacity[]>;
  /**
   * Sets this project's capacity for one team, or clears it on `null`.
   *
   * `null` **deletes the row**, because unstated has one spelling and it is the
   * absence of one. A stored null would be a second, and every reader would
   * then have to handle both — `schema.ts` has the argument on the column.
   */
  set(
    projectId: string,
    serviceTeamId: string,
    size: number | null,
    stamp: WriteStamp,
  ): Promise<CapacityWritten>;
}

/**
 * One dated, named overlay on a project's Gantt axis.
 *
 * **Not a work item and not an SVG marker**, which is the confusion the ADR
 * (`docs/adr/0014-refuse-a-calendar-marker-on-an-undated-plan.md`) exists to
 * refuse: it holds an absolute project date, it schedules nothing, and no
 * scheduler input reads it.
 *
 * `color` is `null` for **automatic**, meaning `automaticColor(id)` decides the
 * fill at read time and the row stores no opinion. A stored default would be a
 * second spelling of the same state and would freeze the palette at the instant
 * the marker was made, so a later palette change would leave old markers behind.
 */
export interface CalendarMarker {
  /** A v4 UUID the composer issues, not the server — design.md §6.1. */
  id: string;
  projectId: string;
  /** An `IsoDate`. No instant, ever — see {@link CalendarMarkerStore.create}. */
  date: IsoDate;
  name: string;
  /** `null` means automatic. */
  color: string | null;
  createdAt: number;
}

/**
 * What a marker write decided.
 *
 * `not_found` covers **both** "no such project" and "no such marker of this
 * project", and the merge is the spec's: a marker of another project answers
 * `not_found` rather than `forbidden`, because the caller may not learn it
 * exists (spec.md, the refusal table).
 *
 * `taken` is a create against an id that is already stored. Separate from
 * `not_found` because it is the one refusal whose row is left **untouched and
 * still readable** — the caller retries with a new id rather than concluding
 * anything is missing.
 */
export type CalendarMarkerWritten =
  | { ok: true; marker: CalendarMarker }
  | { ok: false; reason: 'not_found' | 'taken' };

/**
 * A project's calendar markers.
 *
 * A store of its own for {@link PriorityBandStore}'s reason: this is a
 * project's own list, gated by the project's write permission, and it bumps no
 * work-item revision because it changes no work item.
 *
 * **Nothing in here validates a marker.** The shape rules — `IsoDate`, UUID v4,
 * hex triple, `MARKER_NAME_MAX`, the 3:1 contrast bar — are the controller's,
 * and a second copy in the store would be a rule free to disagree with the one
 * a client is answered against. `PriorityBandRepository.replace` states the
 * same rule for `priorityLadderProblem`.
 */
export interface CalendarMarkerStore {
  /**
   * This project's markers, totally ordered by `(date, createdAt, id)`.
   *
   * The third key is not decoration: `(date, createdAt)` ties for two markers
   * created inside the same millisecond, and a tie leaves the order free to
   * change between two reads of unchanged data (spec.md).
   */
  listFor(projectId: string): Promise<CalendarMarker[]>;
  /**
   * Stores one marker, or refuses.
   *
   * The `id` and the `createdAt` both arrive from the caller — the id because
   * the composer needs it before it can preview the colour, the instant because
   * the repository layer has no clock of its own ({@link WriteStamp}).
   *
   * `date` is stored as **the exact text given**. No `Date` is constructed
   * anywhere on the way in, because constructing one is the only way a clicked
   * day can turn into its UTC neighbour.
   */
  create(marker: CalendarMarker): Promise<CalendarMarkerWritten>;
  /** Renames one marker of this project, leaving its date and colour alone. */
  rename(projectId: string, id: string, name: string): Promise<CalendarMarkerWritten>;
  /** Sets one marker's fill, or clears it back to automatic on `null`. */
  recolor(projectId: string, id: string, color: string | null): Promise<CalendarMarkerWritten>;
  /** Removes one marker of this project. */
  remove(projectId: string, id: string): Promise<CalendarMarkerWritten>;
}

/**
 * What a ladder write decided. `not_found` is a project nothing holds, read
 * inside the write's own transaction rather than in front of it — the
 * {@link CapacityStore.set} rule, and for its reason: the read is the decision.
 */
export type PriorityBandsWritten = { ok: true } | { ok: false; reason: 'not_found' };

/**
 * What one project calls its priority numbers.
 *
 * A store of its own rather than methods on {@link ProjectStore}, for
 * {@link CapacityStore}'s reason one fact along: this is a project's
 * configuration and not a field of the project row, its write is gated
 * differently from the directory's, and the project row's revision counts writes
 * to the row.
 *
 * **Nothing in here is read by the scheduler.** A ladder is the vocabulary
 * `work_item.priority` is read and written in; the ordering the leveller applies
 * is the integer's own. `openspec/changes/priority-bands/design.md` D1.
 */
export interface PriorityBandStore {
  /**
   * This project's five bands, in rank order.
   *
   * A project holding no rows answers {@link DEFAULT_PRIORITY_BANDS} rather than
   * an empty list, and the absence is therefore not a state any caller has to
   * render: every priority resolves to exactly one label on every plan, seeded
   * or not. design.md D2.
   */
  listFor(projectId: string): Promise<PriorityBand[]>;
  /**
   * Replaces this project's whole ladder, five bands at once.
   *
   * **The whole ladder, never one band.** Contiguity is a fact about the five
   * rows together — a first band at 1, strictly increasing starts, each default
   * inside its own band — and a per-band write would have to pass through states
   * where it does not hold, with a reader in another browser drawing one of them.
   * design.md D4.
   */
  replace(
    projectId: string,
    bands: readonly PriorityBand[],
    stamp: WriteStamp,
  ): Promise<PriorityBandsWritten>;
}

export interface DirectoryStore {
  /** Every tag in the global directory, by name. */
  listTags(): Promise<Tag[]>;
  /**
   * Adds a tag idempotently **by name**, answering the row that is there — which
   * is the earlier one when two callers added the same name at once.
   */
  addTag(toAdd: Tag, stamp: WriteStamp): Promise<Tag>;
  /** Renames one tag, refusing a name another tag holds. */
  renameTag(tagId: string, name: string, stamp: WriteStamp): Promise<TagWritten>;
  /**
   * What points at one tag right now — a fast path for the confirmation, never
   * the authority for it. {@link DirectoryStore.removeTag} decides.
   */
  usageOfTag(tagId: string): Promise<DirectoryUsageRows>;
  /**
   * Counts what carries the tag, refuses an unconfirmed removal that would
   * unlabel anything, and otherwise deletes the tag — letting the cascade take
   * the labelling — all in one transaction, bumping every row that lost one.
   */
  removeTag(tagId: string, cascade: boolean, stamp: WriteStamp): Promise<DirectoryRemoved>;
  /** Every work item type in the global directory, by name. */
  listWorkItemTypes(): Promise<WorkItemType[]>;
  /**
   * Adds a work item type idempotently **by name**, answering the row that is
   * there — {@link DirectoryStore.addTag}'s rule and its reason: the list is
   * typed into by everybody, two people adding `Bug` at the same moment both
   * pass a check-then-insert, and only the unique index stops the second.
   */
  addWorkItemType(toAdd: WorkItemType, stamp: WriteStamp): Promise<WorkItemType>;
  /** Renames one work item type, refusing a name another type holds. */
  renameWorkItemType(typeId: string, name: string, stamp: WriteStamp): Promise<WorkItemTypeWritten>;
  /**
   * What points at one work item type right now — a fast path for the
   * confirmation, never the authority for it.
   * {@link DirectoryStore.removeWorkItemType} decides.
   */
  usageOfWorkItemType(typeId: string): Promise<DirectoryUsageRows>;
  /**
   * Counts what carries the type, refuses an unconfirmed removal that would
   * unlabel anything, and otherwise deletes the type — letting the cascade take
   * the labelling — all in one transaction, bumping every row that lost one.
   */
  removeWorkItemType(
    typeId: string,
    cascade: boolean,
    stamp: WriteStamp,
  ): Promise<DirectoryRemoved>;
  /**
   * Every external system in the global directory, by name.
   *
   * Read-only: the vocabulary is seeded by the migration and grows only when a
   * ref names a system that is not there — which the write path does, rather
   * than a route of its own. There is no rename and no removal, and that absence
   * is the change's own non-goal: removing a system takes every **link** with
   * it, not a label off a row, and nothing has asked for that yet.
   */
  listExternalSystems(): Promise<ExternalSystem[]>;
  /** Every service in the global directory, by name. */
  listServices(): Promise<Service[]>;
  /**
   * Adds a service idempotently **by name**, answering the row that is there —
   * {@link DirectoryStore.addTag}'s rule and its reason.
   */
  addService(toAdd: Service, stamp: WriteStamp): Promise<Service>;
  /** Renames one service, refusing a name another service holds. */
  renameService(serviceId: string, name: string, stamp: WriteStamp): Promise<ServiceWritten>;
  /**
   * What points at one service right now — a fast path for the confirmation,
   * never the authority for it. {@link DirectoryStore.removeService} decides.
   */
  usageOfService(serviceId: string): Promise<DirectoryUsageRows>;
  /**
   * Counts what names the service, refuses an unconfirmed removal that would
   * unlabel anything, and otherwise deletes the service — letting
   * `work_item.service_id`'s `ON DELETE SET NULL` clear the column and
   * `team_service`'s cascade take the ownership rows — all in one transaction,
   * bumping every row that lost its label.
   */
  removeService(serviceId: string, cascade: boolean, stamp: WriteStamp): Promise<DirectoryRemoved>;
  /**
   * Every team with the services it owns — the ownership map ships **whole**,
   * on the row where it is edited (design D4).
   *
   * One read rather than a second endpoint because both mismatch signals need
   * the map per row, and a client that had to ask twice would render a tree
   * against a map from a moment ago.
   */
  listTeams(): Promise<TeamWithServices[]>;
  /**
   * Adds a team, or returns the one that already has that name.
   *
   * Idempotent by name at the database rather than by asking first: this list
   * is typed into by everybody, and two people adding `Platform` at once both
   * pass a check-then-insert.
   */
  addTeam(team: ServiceTeam, stamp: WriteStamp): Promise<ServiceTeam>;
  /**
   * Renames one team and replaces the services it owns, in **one** transaction,
   * or says why it could not.
   *
   * A rename is refused by the unique index rather than by asking first,
   * exactly as {@link DirectoryStore.addTeam} is: two clients renaming towards
   * `Platform` at the same moment both pass a check-then-update. The owned set
   * is validated **before** anything is written, for
   * {@link DirectoryStore.patchPerson}'s reason: returning from a drizzle
   * transaction callback commits it, so a refusal decided after the name had
   * been set would answer `unknown_service` and leave the rename behind.
   */
  patchTeam(teamId: string, patch: TeamPatch, stamp: WriteStamp): Promise<ServiceTeamWritten>;
  listPeople(): Promise<PersonWithTeams[]>;
  /**
   * Adds a person, or returns the one with that name, joining them to
   * `teamIds` — the person and every membership in **one** transaction, with
   * the teams read inside it. See {@link PersonAdded}.
   *
   * Takes a {@link PersonInsert} rather than a {@link Person}: the kind may be
   * omitted on the way in and never is on the way out.
   */
  addPerson(
    toAdd: PersonInsert,
    teamIds: readonly string[],
    stamp: WriteStamp,
  ): Promise<PersonAdded>;
  /**
   * Renames a person and replaces their memberships, in **one** transaction.
   *
   * The two are one write because a caller may send both and the spec forbids
   * them being observable half-applied. A `teamIds` entry naming a team the
   * directory no longer holds refuses the whole patch as `unknown_team` and
   * writes nothing — the id is read in the same transaction as the writes, so
   * a team removed after some earlier check cannot slip between them.
   */
  patchPerson(personId: string, patch: PersonPatch, stamp: WriteStamp): Promise<PersonWritten>;
  /**
   * What points at this person right now — a **fast path** for the refusal,
   * never the authority for it. Between this answer and any delete, anybody may
   * assign them. {@link DirectoryStore.removePerson} is what decides.
   */
  usageOfPerson(personId: string): Promise<DirectoryUsageRows>;
  /** The same, for a team: the work items labelled with it and the people in it. */
  usageOfTeam(teamId: string): Promise<DirectoryUsageRows>;
  /**
   * Counts what points at the person, refuses an unconfirmed removal that would
   * take any of it, and otherwise drops their assignments, their memberships
   * and the person — all in **one** transaction, moving the revision of every
   * work item that lost an assignment.
   *
   * The count lives inside the transaction because it *is* the decision: a
   * caller that asked without `cascade` consented to nothing, so an assignment
   * written after that caller's own count must refuse the removal rather than
   * be deleted by it.
   */
  removePerson(personId: string, cascade: boolean, stamp: WriteStamp): Promise<DirectoryRemoved>;
  /**
   * The same for a team, and it **nulls the labels itself**:
   * `work_item.service_team_id` carries a foreign key with no `ON DELETE`
   * action, so deleting the team row while any work item still names it is
   * refused outright by SQLite. The join rows in `work_item_team` go the other
   * way and need no statement at all — they cascade.
   */
  /**
   * Stamped, unlike its four sibling removals, because this one **updates**
   * surviving rows as well as deleting: it nulls `work_item.serviceTeamId` on
   * every work item the team labelled. A delete has no column left to stamp; an
   * update to a row that stays does.
   */
  removeTeam(teamId: string, cascade: boolean, stamp: WriteStamp): Promise<DirectoryRemoved>;
  assignmentsOf(workItemIds: readonly string[]): Promise<Assignment[]>;
  /**
   * Sets, replaces or (with `null`) removes one work item's assignee for one
   * step, validating the person **inside the write's own transaction** — see
   * {@link AssignmentWritten}.
   */
  assign(
    workItemId: string,
    stepId: string,
    personId: string | null,
    stamp: WriteStamp,
  ): Promise<AssignmentWritten>;
}

/**
 * A duplicated subtree, ready to be written: every copied row and everything
 * that hangs off it, already carrying its new ids.
 *
 * It arrives as one value because it is written as one act — see
 * {@link SubtreeStore.insertSubtree}. The caller has already decided every id,
 * so nothing here is generated on the way in.
 */
export interface SubtreeCopy {
  /**
   * The copies, **parents before children**. `work_item.parent_id` references
   * `work_item.id`, so any other order is refused by the database rather than
   * silently reordered.
   */
  rows: readonly (WorkItem & { teamIds?: readonly string[] })[];
  /** Existing siblings of the copied root whose positions the placement moved. */
  respaced: readonly Repositioned[];
  /**
   * Rows already in the tree that this write moves back **under** one of
   * `rows`, with the position each had before.
   *
   * Empty for a duplication, which invents every row it writes. It is what
   * makes restoring a promoted deletion one act: the deleted parent comes back
   * and the children that were promoted out of it go back beneath it, and a
   * reader can never land between the two and see the same work twice.
   *
   * Applied after `rows`, because `parent_id` references a row that must
   * already be there.
   */
  reparented: readonly Reparented[];
  estimates: readonly StoredEstimate[];
  /**
   * The days already recorded against the rows being written.
   *
   * **Empty for a duplication, and that is a decision rather than an
   * omission.** A duplicate is work that has not been done yet: copying the
   * original's actuals would tell the plan that a fortnight nobody has worked
   * was already spent, and the copy's variance would read as finished work the
   * moment it appeared. Estimates copy because an estimate is a description of
   * work; actuals do not because an actual is a record of a week.
   *
   * Non-empty for a **restore**, which is the other caller: an undo of a delete
   * has to put back what the delete took, and the actuals went with the rows.
   */
  actuals: readonly StoredActual[];
  /**
   * Where the work on the rows being written had got to, put back with them.
   *
   * **Empty for a duplication, for {@link SubtreeCopy.actuals}' reason and one
   * of its own.** A duplicate is work that has not been done, so copying a
   * `done` would hand the plan a branch that reports itself finished the moment
   * it appears — the same lie the copied actual would tell, in a stronger
   * tense. Estimates copy because an estimate describes work; neither of these
   * does, because both are records of what happened to it.
   *
   * Non-empty for a **restore**: an undo of a delete has to put back what the
   * delete took, and the statements went with the rows.
   */
  progress: readonly StoredProgress[];
  /**
   * The tokens and hours on the rows being written, in every metric that may be
   * on them.
   *
   * **The one field here a duplication fills selectively, and the first place
   * the single discriminated table costs something.** Every other collection on
   * this interface is copied whole or not at all, because each names one kind of
   * thing; this one names three, and the copy rule's line is drawn through the
   * middle of it. `token_estimate` is a description of work and copies for
   * {@link SubtreeCopy.estimates}' reason exactly — a duplicate that carried the
   * days plan and not the token plan would be half-planned in a way the reader
   * can see. `token_actual` and `hours_actual` are records of what a particular
   * piece of work cost, and do not copy for {@link SubtreeCopy.actuals}' reason
   * exactly. See `openspec/changes/token-tracking/design.md` D1 and D8.
   *
   * Non-empty in every metric for a **restore**: an undo of a delete has to put
   * back what the delete took, and the measures went with the rows.
   */
  measures: readonly StoredMeasure[];
  assignments: readonly Assignment[];
  /** Only the edges with both ends inside the subtree, remapped to the copies. */
  dependencies: readonly StoredDependency[];
  /**
   * Estimates to take off a work item **outside** `rows`, in the same write.
   *
   * Empty for a duplication. It exists for the mirror of the rule in
   * `WorkItemService.remove`: deleting a parent's last child hands that child's
   * figures up to the parent, so putting the child back has to take them off
   * again, or the same days are counted twice — once on the restored leaf and
   * once on the parent that is no longer a leaf.
   */
  removedEstimates: readonly EstimateKey[];
  /** Actuals to take off a work item **outside** `rows`, for {@link SubtreeCopy.removedEstimates}' reason. */
  removedActuals: readonly ActualKey[];
  /** Statements to take off a work item **outside** `rows`, for {@link SubtreeCopy.removedEstimates}' reason. */
  removedProgress: readonly ProgressKey[];
  /**
   * Figures to take off a work item **outside** `rows`, for
   * {@link SubtreeCopy.removedEstimates}' reason, one key per metric.
   *
   * Keyed by the triple rather than the pair, because the row's identity is the
   * triple: the parent may hold a figure in a metric this restore is not
   * putting back, and taking the pair away wholesale would delete it.
   */
  removedMeasures: readonly MeasureKey[];
}

/** One estimate row's whole identity: the pair its primary key is. */
export interface EstimateKey {
  workItemId: string;
  stepId: string;
}

export interface SubtreeStore {
  /**
   * Writes a whole {@link SubtreeCopy} in one transaction, across all four
   * tables it touches.
   *
   * Wider than any other store here on purpose. A copy applied in pieces can
   * fail between them and leave rows that look like real work with no
   * estimates and nobody assigned — a plan that is quietly wrong rather than
   * visibly incomplete, and nothing in the tree says which rows they are.
   *
   * Throws whatever the database throws. A rejected write means **nothing**
   * was written, which `work-item.test.ts` asserts against a deliberately
   * broken foreign key rather than claiming it here.
   */
  insertSubtree(copy: SubtreeCopy, stamp: WriteStamp): Promise<void>;
}

/**
 * One command an account ran on one project, and what it takes to reverse it.
 *
 * The three JSON fields arrive parsed but **unvalidated beyond their shape** —
 * see `command_journal` in `schema.ts` for what is written into them and
 * `readCommand` in `service/compensating.ts` for the one thing that is checked.
 */
export interface JournalEntry {
  id: string;
  projectId: string;
  userId: string;
  /** This entry's place in the account's stack for this project; higher is newer. */
  seq: number;
  kind: string;
  /** `{label, forward}` — what to say about it, and what a redo re-applies. */
  payload: unknown;
  /** The compensating command an undo applies, carrying its before-state. */
  inverse: unknown;
  /** `{workItemId: revision}` at the revisions the command left them at. */
  preconditions: unknown;
  /** True once undone: the entry has left the undo stack and joined the redo one. */
  undone: boolean;
  createdAt: number;
}

/** A journal entry on its way in, before the store decides where it sits in the stack. */
export interface NewJournalEntry {
  id: string;
  projectId: string;
  userId: string;
  kind: string;
  payload: unknown;
  inverse: unknown;
  preconditions: unknown;
  createdAt: number;
}

/** Whether an account has anything to undo or redo on one project. */
export interface UndoState {
  undoable: boolean;
  redoable: boolean;
}

/**
 * The last {@link JOURNAL_DEPTH} commands each account ran on each project.
 *
 * Deep enough to walk back through a working session, shallow enough that the
 * table does not grow without bound on a plan somebody edits every day. A
 * number rather than a setting: nothing about an environment changes the right
 * answer.
 */
export const JOURNAL_DEPTH = 50;

/**
 * One command somebody ran on one project: a row of the plan's history.
 *
 * The fields are the ones `WorkItemService.record` already holds. `before` and
 * `after` are the compensating and forward commands as objects — the store
 * serialises them on the way in and parses them on the way out, the way it does
 * the journal's three JSON columns, and they come back `unknown` for the same
 * reason: a cast here would be a claim about rows written by a release that may
 * no longer exist.
 *
 * There is no `NewPlanEvent` twin of this, unlike {@link NewJournalEntry}: the
 * store assigns nothing. A journal entry's `seq` is chosen by the database
 * inside the insert, so what goes in genuinely is not what comes back; here the
 * row is written exactly as the caller states it.
 *
 * See `plan_event` in `schema.ts` for what this is and — more importantly — what
 * it is not.
 */
export interface PlanEvent {
  id: string;
  projectId: string;
  userId: string;
  kind: string;
  /** The sentence `record` built, stored rather than re-derived; see {@link JournalPayload}. */
  label: string;
  /** The one work item the command was aimed at, or null when it named many. */
  workItemId: string | null;
  /** The step, for the kinds that carry one. */
  stepId: string | null;
  before: unknown;
  after: unknown;
  createdAt: number;
}

/** What narrows a project's history to the part somebody asked for. */
export interface PlanEventFilter {
  /**
   * One work item's own events. Omitted is every item's, and not "the events
   * that name no item" — those are the plan-wide ones, and they are in the
   * project's history rather than any row's.
   */
  workItemId?: string;
  /**
   * The kinds to keep. Omitted — or empty — is every kind: an empty list names
   * no kind, which is the same question as asking for no filter at all, and it
   * is the only reading that cannot surprise a caller.
   *
   * A kind nothing was ever recorded under answers nothing, and that is not an
   * error. `plan_event.kind` is a string rather than an enumeration precisely so
   * that H2's `actual` lands here without a migration, so there is no closed set
   * to refuse a name against.
   */
  kinds?: readonly string[];
}

/**
 * How long a recorded event lives.
 *
 * By **age**, and never by count. Pruning a history table by count is deletion
 * of exactly the thing being asked for: an afternoon's editing on one plan would
 * evict the morning, which is the property that already rules `command_journal`
 * out as a history. A year is long enough that the question "how did this
 * estimate move" has an answer for any plan anybody is still running, and short
 * enough that the table does not grow forever in the file the domain lives in.
 *
 * A constant rather than configuration, for `EVENT_LOG_MAX_PER_SUBSCRIPTION`'s
 * reason: nothing about an environment changes the right answer, and a knob
 * nobody sets is a knob nobody keeps correct.
 */
export const PLAN_EVENT_RETENTION_DAYS = 365;

export interface PlanEventStore {
  /**
   * One project's history, **newest first**, narrowed by `filter`.
   *
   * There is no `append` here, and that absence is the design. A history row is
   * written by {@link CommandJournalStore.append}, inside the transaction that
   * writes the undo entry, because the two record one act — see that method.
   */
  listFor(projectId: string, filter: PlanEventFilter): Promise<PlanEvent[]>;
  /**
   * Deletes every event recorded before `cutoff`, and answers how many went.
   *
   * The only statement in the product that removes a row from this table.
   */
  pruneOlderThan(cutoff: number): Promise<number>;
}

export interface CommandJournalStore {
  /**
   * Appends a command to the account's stack for this project and the same
   * command to the project's history, **clearing that account's redo branch**
   * and pruning past {@link JOURNAL_DEPTH}, in one transaction.
   *
   * The redo branch goes because it describes a future that no longer exists:
   * having undone a rename and then typed something else, re-applying the
   * rename would put back a value computed from a plan that has moved on. Only
   * this account's branch goes — the stacks are per account.
   *
   * **`event` is a second argument rather than a second call**, and that is the
   * one thing this signature exists to guarantee. Two calls are two
   * transactions, and the second can fail: a plan would then gain an undo entry
   * for a change absent from its history, which is a history that is quietly
   * short rather than visibly incomplete. `record` is already called after the
   * mutation and after the broadcast — see `WorkItemService.record` for why —
   * so widening that window with a second statement of its own is the failure
   * this refuses to be able to have.
   */
  append(entry: NewJournalEntry, event: PlanEvent): Promise<void>;
  /**
   * The whole of one account's stack for one project, **oldest first**.
   *
   * All of it rather than just the end being asked for, because applying one
   * entry re-stamps its neighbours: an undo is a write, and the entries below
   * it hold revisions that this account's own undo has just walked past. It is
   * bounded by {@link JOURNAL_DEPTH}, so this is fifty rows at worst.
   */
  entriesFor(projectId: string, userId: string): Promise<JournalEntry[]>;
  /**
   * Moves one entry between the two halves of the stack, and records the
   * revisions the direction just applied left behind.
   *
   * The two go together because they describe one act. An entry that changed
   * sides while keeping the preconditions of the direction it came from would
   * be checked against revisions the tree has deliberately moved past — every
   * redo would read as stale, and the redo half of the stack would be
   * decorative.
   */
  flip(id: string, undone: boolean, preconditions: unknown): Promise<void>;
  /**
   * Rewrites one entry's preconditions where it stands, without moving it
   * between the halves of the stack.
   *
   * For the neighbours of an entry that was just applied — see
   * `Preconditions` in `service/compensating.ts` for when a neighbour may be
   * re-stamped and when it must be left to refuse.
   */
  restamp(id: string, preconditions: unknown): Promise<void>;
  /**
   * Throws an entry away for good.
   *
   * What happens to an entry whose preconditions no longer hold: it can never
   * apply again — the state it described is gone — and leaving it at the top
   * would jam the stack, refusing every later press of the key for a change
   * nobody can reach any more.
   */
  discard(id: string): Promise<void>;
  /** Whether either half of the account's stack has anything in it. */
  stateOf(projectId: string, userId: string): Promise<UndoState>;
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
