import type { EstimateMethod, IsoDate } from '@wbs/domain';

export interface Example {
  id: string;
  label: string;
  createdAt: number;
}

export interface ExampleRepo {
  create(ex: Example): Promise<void>;
  findById(id: string): Promise<Example | null>;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
}

export interface UserStore {
  /** Returns null when the username is already taken. */
  create(user: User): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
}

export interface Project {
  id: string;
  name: string;
  ownerId: string;
  restricted: boolean;
  /** How this project turns its three-point estimates into one planning number. */
  estimateMethod: EstimateMethod;
  /** The calendar day the plan begins, or null for a plan not yet on a calendar. */
  startDate: IsoDate | null;
  /**
   * How many times this project has been written to. Moves on its own stored
   * fields and on its roles; never on a work item beneath it, and never on
   * somebody opening it. See `schema.ts` for the rule and why it is bumped in
   * SQL rather than in this process.
   */
  revision: number;
  createdAt: number;
}

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

export interface Role {
  id: string;
  projectId: string;
  name: string;
  /**
   * Where this role sits in the project's role order — see `schema.ts` for why
   * the order has to be stored rather than read off the rows as they arrive.
   */
  position: number;
}

/**
 * A role as a caller offers it. The project decides where in its order the role
 * lands, in the same transaction that writes it: two clients adding a role at
 * once would otherwise both read the same last place.
 */
export type NewRole = Omit<Role, 'position'>;

/**
 * The gap between two consecutive roles' positions.
 *
 * Ten, like a work item's, and for the same reason: a role can be put between
 * two others without rewriting either.
 */
export const ROLE_POSITION_STEP = 10;

/** Why a role could not be added or renamed. Both are states of the project, not faults. */
export type RoleWriteRefusal = 'taken' | 'not_found';

export type RoleWritten = { ok: true; role: Role } | { ok: false; reason: RoleWriteRefusal };

/**
 * What points at one role, read for the refusal that names it.
 *
 * The estimates are a count because a count is all anyone can act on. The
 * assignments are **every assignment in the project**, not only this role's:
 * whether a work item's assumed assignee moves when this role goes depends on
 * what it holds for the *other* roles, so the answer cannot be computed from
 * this role's rows alone. See `assumedAssigneeFlips`.
 */
export interface RoleUsageRows {
  estimates: number;
  assignments: readonly Assignment[];
}

/** What one confirmed removal took with it. */
export interface RoleRemoval {
  estimates: number;
  assignments: number;
  /** Every work item that lost an estimate or an assignment, and whose revision therefore moved. */
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
 * `not_found` is the loser of two removals of one role — and a role id that
 * belongs to another project, which is the same absence from this project's
 * point of view.
 */
export type RoleRemoved =
  | { ok: true; removal: RoleRemoval }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; usage: RoleUsageRows };

export interface RoleStore {
  /** In role order, which is the order every reader of a project's roles gets. */
  listByProject(projectId: string): Promise<Role[]>;
  /** By id alone: the caller checks the role belongs to the project it was asked about. */
  findById(roleId: string): Promise<Role | null>;
  /**
   * Adds a role, or refuses a name the project already holds.
   *
   * Refused by the unique index rather than by asking first: two clients adding
   * `Design` at the same moment both pass a check-then-insert. Moves the
   * project's revision in the same transaction — a role is a satellite of the
   * project, and adding one changes what every estimate in it means.
   *
   * The role lands last in the project's role order, and the written role
   * carries the place it took.
   */
  add(role: NewRole): Promise<RoleWritten>;
  /** The same rules as {@link RoleStore.add}, and `not_found` for a role that has gone. */
  rename(roleId: string, name: string): Promise<RoleWritten>;
  /**
   * What points at the role right now — a **fast path** for the refusal, never
   * the authority for it. Between this answer and any delete, anybody may write.
   * {@link RoleStore.remove} is what decides.
   */
  usageOf(projectId: string, roleId: string): Promise<RoleUsageRows>;
  /**
   * Counts what points at the role, refuses an unconfirmed removal that would
   * take any of it, and otherwise deletes the role's estimates, its assignments
   * and the role row — all in **one** transaction, bumping the project and every
   * work item that lost one of them.
   *
   * The count lives inside the transaction because it is the decision: a caller
   * that asked without `cascade` never consented to take anything, so an
   * estimate written after that caller's own count must refuse it rather than be
   * deleted by it.
   *
   * The estimates are deleted explicitly because `estimate.role_id` has no
   * cascade: a bare delete of the row hits the foreign key and answers 500.
   */
  remove(projectId: string, roleId: string, cascade: boolean): Promise<RoleRemoved>;
}

export interface ProjectPatch {
  name?: string;
  restricted?: boolean;
  estimateMethod?: EstimateMethod;
  /** `null` takes the plan back off the calendar. */
  startDate?: IsoDate | null;
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

export interface WorkItemPatch {
  name?: string;
  notes?: string;
  /** `null` removes the constraint and lets the dependencies alone decide. */
  startNoEarlierThan?: IsoDate | null;
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
}

/**
 * What a patch answered: the written row, or the reason nothing was written.
 *
 * `unknown_team` is a `serviceTeamId` the directory no longer holds, decided
 * **inside the transaction that performs the update**. It is not a service-level
 * precheck's answer: `work_item.service_team_id` has no foreign key, so a check
 * one statement earlier passes for a team removed in the gap and the update
 * then stores an id nothing holds, for ever, with nothing to report it.
 */
export type WorkItemPatched =
  | { ok: true; workItem: WorkItem }
  | { ok: false; reason: 'not_found' | 'unknown_team' };

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

/**
 * Which teams and which product areas each work item of one project names —
 * **as stored**, before any inheritance is resolved.
 *
 * Two maps rather than a field on {@link WorkItem}, and the reason is which
 * question each type answers. `WorkItem` is the row a write path hands to the
 * database, and a work item's resources are not columns of that row: they are
 * rows of `work_item_team` and `work_item_service`, written in the same
 * transaction and read back by their own statement. Putting them on the row
 * type would make every construction of a work item — every write path, every
 * fixture — state a set it has nothing to say about. R2-4, the release where a
 * client writes several, is where the sets join the write shape.
 *
 * A work item naming nothing in a dimension is **absent** from that dimension's
 * map, never present with `[]`: absence is the one spelling of _unstated_ that
 * `effectiveSetOf` resolves, and two spellings would have every reader handling
 * both.
 *
 * Ordered by id within each row's list, so two reads of an unchanged plan
 * cannot answer in two orders.
 */
export interface ResourceSets {
  /** Each work item's own team ids, keyed by work item id. */
  teamIdsOf: ReadonlyMap<string, readonly string[]>;
  /** Each work item's own service ids, keyed by work item id. Empty in this release. */
  serviceIdsOf: ReadonlyMap<string, readonly string[]>;
}

export interface WorkItemStore {
  listByProject(projectId: string): Promise<WorkItem[]>;
  /**
   * One project's stored resource sets, from the join tables and **not** from
   * `work_item.service_team_id`.
   *
   * The column is still written beside them and is still what the outgoing
   * release reads, so the two agree — which is exactly why this has to read the
   * join: a reader that took the column would pass every test the mirror keeps
   * in step and would still be reading the thing R2-4 stops maintaining.
   */
  resourceSetsOf(projectId: string): Promise<ResourceSets>;
  findById(id: string): Promise<WorkItem | null>;
  /**
   * Inserts, and respaces the sibling group in the same transaction when the
   * insertion had no gap to take. Two calls would leave a window in which two
   * siblings share a position, and the number derived in that window would be
   * wrong for whoever read it.
   *
   * A non-null `serviceTeamId` on the row is **mirrored into
   * `work_item_team`** in that same transaction — see {@link ResourceSets} for
   * which of the two a reader reads.
   */
  insert(workItem: WorkItem, respaced: readonly Repositioned[]): Promise<void>;
  /**
   * Applies the patch and validates any `serviceTeamId` it names **in one
   * transaction** — see {@link WorkItemPatched}. A patch naming no field writes
   * nothing and answers the row it found.
   *
   * A patch that names `serviceTeamId` also rewrites that work item's rows in
   * `work_item_team`, in the same transaction: one row for an id, none for
   * `null`. The set the reader reads and the column the outgoing release reads
   * are never apart, not even for the length of a statement.
   */
  patch(id: string, patch: WorkItemPatch): Promise<WorkItemPatched>;
  move(
    id: string,
    parentId: string | null,
    position: number,
    respaced: readonly Repositioned[],
  ): Promise<void>;
  /**
   * Writes or clears stored numbers. `null` returns a work item to deriving.
   *
   * A freeze is one call rather than a write per work item: a project half
   * frozen is a project where some numbers moved and some did not, and nobody
   * reading it could tell which.
   */
  setFrozenNumbers(updates: readonly FrozenNumber[]): Promise<void>;
  /** Removes `ids` and applies `promoted` together, so a promotion cannot outlive its parent. */
  remove(ids: readonly string[], promoted: readonly Reparented[]): Promise<void>;
}

export interface StoredEstimate {
  workItemId: string;
  roleId: string;
  optimistic: number;
  realistic: number;
  pessimistic: number;
}

export interface EstimateStore {
  listByProject(projectId: string): Promise<StoredEstimate[]>;
  /** Writes one work item's estimate for one role, replacing any earlier one. */
  set(estimate: StoredEstimate): Promise<void>;
  /**
   * Takes away one work item's estimate for one role, leaving every other
   * role on that work item and that role on every other work item alone.
   *
   * Removing one that is not stored is not an error: the state asked for is
   * the state left, and two people emptying the same three boxes must not turn
   * the second one into a failure on screen.
   */
  remove(workItemId: string, roleId: string): Promise<void>;
  /**
   * Moves every estimate from one work item to another.
   *
   * Used in both directions by the same rule: an estimated work item that gains
   * its first child hands the estimate down, and a work item whose last child is
   * deleted takes it back. Neither is a merge — a parent never holds estimates of
   * its own while it has children.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string): Promise<void>;
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
  add(dependency: StoredDependency): Promise<void>;
  remove(predecessorId: string, successorId: string): Promise<void>;
  /** Every edge touching a work item, so deleting the row can take them with it. */
  removeAllFor(workItemId: string): Promise<void>;
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

/** Somebody who does work. Not an account on this tool. */
export interface Person {
  id: string;
  name: string;
}

/** A person and the teams they belong to — empty means a free agent. */
export interface PersonWithTeams extends Person {
  teamIds: string[];
}

/** Who is doing one work item's work for one role. */
export interface Assignment {
  workItemId: string;
  roleId: string;
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
export type DirectoryWriteRefusal = 'not_found' | 'taken';

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

export type ServiceTeamWritten =
  | { ok: true; team: ServiceTeam; projectIds: TouchedProjects }
  | { ok: false; reason: DirectoryWriteRefusal };

/**
 * A change to one person: a new name, a new set of memberships, or both.
 *
 * `teamIds` is a **full replacement**, so an absent field and an empty array
 * mean different things: absent leaves the memberships alone, empty makes the
 * person a free agent.
 */
export interface PersonPatch {
  name?: string;
  teamIds?: readonly string[];
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
 * naming the entity, for the reason {@link RoleUsageRows} gives: whether a work
 * item's **assumed assignee** moves depends on what it holds for the *other*
 * roles.
 */
export interface DirectoryUsageRows {
  workItems: readonly WorkItem[];
  projects: readonly { id: string; name: string }[];
  assignments: readonly Assignment[];
  roles: readonly { id: string; name: string }[];
  /** Every person an assignment above names, so an effect can say who rather than which id. */
  people: readonly Person[];
  /**
   * People whose membership the removal would drop, **other than the entity
   * being removed**. Empty for a person: their own memberships name nobody
   * else and go with them, so they force no confirmation.
   */
  members: readonly Person[];
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
  /**
   * Each of `workItems`' own team ids, keyed by work item id — the stored sets,
   * before inheritance.
   *
   * Carried for `capacityOf`'s reason one table along: the confirmation names
   * the rows that draw from the pool going away, and that reading is
   * `effectiveSetOf`'s, which needs each row's own set rather than the column
   * beside it. Read in the same transaction as `workItems`, so the confirmation
   * describes one moment.
   *
   * A work item naming no team is absent, never present with `[]` — see
   * {@link ResourceSets}.
   */
  teamIdsOf: ReadonlyMap<string, readonly string[]>;
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
  set(projectId: string, serviceTeamId: string, size: number | null): Promise<CapacityWritten>;
}

export interface DirectoryStore {
  listTeams(): Promise<ServiceTeam[]>;
  /**
   * Adds a team, or returns the one that already has that name.
   *
   * Idempotent by name at the database rather than by asking first: this list
   * is typed into by everybody, and two people adding `Platform` at once both
   * pass a check-then-insert.
   */
  addTeam(team: ServiceTeam): Promise<ServiceTeam>;
  /**
   * Renames one team, or says why it could not.
   *
   * Refused by the unique index rather than by asking first, exactly as
   * {@link DirectoryStore.addTeam} is: two clients renaming towards `Platform`
   * at the same moment both pass a check-then-update.
   */
  renameTeam(teamId: string, name: string): Promise<ServiceTeamWritten>;
  listPeople(): Promise<PersonWithTeams[]>;
  /**
   * Adds a person, or returns the one with that name, joining them to
   * `teamIds` — the person and every membership in **one** transaction, with
   * the teams read inside it. See {@link PersonAdded}.
   */
  addPerson(toAdd: Person, teamIds: readonly string[]): Promise<PersonAdded>;
  /**
   * Renames a person and replaces their memberships, in **one** transaction.
   *
   * The two are one write because a caller may send both and the spec forbids
   * them being observable half-applied. A `teamIds` entry naming a team the
   * directory no longer holds refuses the whole patch as `unknown_team` and
   * writes nothing — the id is read in the same transaction as the writes, so
   * a team removed after some earlier check cannot slip between them.
   */
  patchPerson(personId: string, patch: PersonPatch): Promise<PersonWritten>;
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
  removePerson(personId: string, cascade: boolean): Promise<DirectoryRemoved>;
  /**
   * The same for a team, and it **nulls the labels itself**:
   * `work_item.service_team_id` has no foreign key, so deleting the team row on
   * its own would leave every labelled work item pointing at an id the
   * directory no longer holds — a dangle nothing would ever report.
   */
  removeTeam(teamId: string, cascade: boolean): Promise<DirectoryRemoved>;
  assignmentsOf(workItemIds: readonly string[]): Promise<Assignment[]>;
  /**
   * Sets, replaces or (with `null`) removes one work item's assignee for one
   * role, validating the person **inside the write's own transaction** — see
   * {@link AssignmentWritten}.
   */
  assign(workItemId: string, roleId: string, personId: string | null): Promise<AssignmentWritten>;
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
  rows: readonly WorkItem[];
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
}

/** One estimate row's whole identity: the pair its primary key is. */
export interface EstimateKey {
  workItemId: string;
  roleId: string;
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
  insertSubtree(copy: SubtreeCopy): Promise<void>;
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

export interface CommandJournalStore {
  /**
   * Appends a command to the account's stack for this project, **clearing that
   * account's redo branch** and pruning past {@link JOURNAL_DEPTH}, in one
   * transaction.
   *
   * The redo branch goes because it describes a future that no longer exists:
   * having undone a rename and then typed something else, re-applying the
   * rename would put back a value computed from a plan that has moved on. Only
   * this account's branch goes — the stacks are per account.
   */
  append(entry: NewJournalEntry): Promise<void>;
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
   * Writes the project and its starting roles together. A project that existed
   * for even one request without roles would accept an estimate that had no
   * role to belong to, so the two are one transaction rather than two calls.
   */
  create(project: Project, roles: readonly Role[]): Promise<Project>;
  findById(id: string): Promise<Project | null>;
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
   * Records `userId` as having opened `projectId` at `at`, replacing whatever
   * moment was recorded before. Idempotent by the primary key rather than by
   * asking first: two tabs opening one project at once would both see "no row"
   * and both insert.
   */
  recordOpen(userId: string, projectId: string, at: number): Promise<void>;
  /** Returns null when the project is gone. */
  update(id: string, patch: ProjectPatch): Promise<Project | null>;
  rolesOf(projectId: string): Promise<Role[]>;
}
