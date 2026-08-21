import {
  addWorkdays,
  effectiveTeamsOf,
  type EstimateMethod,
  finalDays,
  firstWorkdayOf,
  type IsoDate,
  lastWorkdayOf,
  NOT_STARTED,
  type PriorityBand,
  type RoleState,
  workdaysBetween,
} from '@wbs/domain';

import type {
  ActualStore,
  CapacityStore,
  CommandJournalStore,
  DependencyStore,
  DirectoryStore,
  EstimateStore,
  JournalEntry,
  LabelledWorkItem,
  Person,
  PriorityBandStore,
  Project,
  ProjectStore,
  Reparented,
  Role,
  RoleProgressStore,
  StoredActual,
  StoredEstimate,
  StoredProgress,
  SubtreeStore,
  TeamCapacity,
  UndoState,
  WorkItem,
  WorkItemPatch,
  WorkItemStore,
} from '../repository';
import { isForeignKeyViolation } from '../repository/constraint';
import { assumedAssignee } from './assumed-assignee';
import type { Broadcaster } from './broadcast';
import { withAncestors } from './broadcast';
import {
  type CompensatingCommand,
  quoteName,
  readCommand,
  readPayload,
  readPreconditions,
  type Revisions,
  subjectOf,
  touchedBy,
} from './compensating';
import { canDepend } from './dependency';
import { deriveNumbers } from './derive-numbers';
import { placeAfter, POSITION_STEP, type Sibling } from './place-sibling';
import { canEdit } from './project.service';
import {
  type Days,
  rollUp,
  rollUpActuals,
  rollUpItemStates,
  rollUpProgress,
  workedRolesOf,
} from './roll-up';
import {
  schedule,
  ScheduleCycleError,
  type Scheduled,
  type ScheduledSlice,
  type Slice,
  sliceKey,
} from './schedule';

/**
 * What a work item shows before any schedule could be computed for it.
 *
 * Reached only when a row is absent from the schedule, which cannot happen for a
 * row the schedule was given. It exists so the type has no optional field: an
 * absent schedule and a zero-day one look identical to a caller, and only one of
 * them is a plan.
 */
const UNSCHEDULED: Scheduled = {
  duration: 0,
  estimated: false,
  earliestStart: 0,
  earliestFinish: 0,
  latestStart: 0,
  latestFinish: 0,
  float: 0,
  critical: false,
};

/**
 * The project's plan as slices: one per leaf and role, in role order.
 *
 * The order is the project's, and it is the order the work runs in — Dev
 * finishes, then QA starts. That was an assumption written as a sum until this
 * change; it is now an edge, and the schedule can say when each role's part of
 * a work item happens rather than only when the whole of it does.
 *
 * A pair nobody has estimated carries `null` rather than zero, which is what
 * lets the schedule report it as unestimated instead of instant. Every leaf
 * gets a slice for every role even so, because an unestimated `Dev` in front of
 * an estimated `QA` is what hands `QA` the work item's predecessors.
 *
 * Two shapes the project's own role list does not cover:
 *
 * - **No roles at all.** Reachable — a project's last role can be removed. Each
 *   leaf gets one slice belonging to nobody, so the plan still schedules
 *   instead of losing every row that a neighbour depends on.
 * - **An estimate naming a role the project does not hold.** Not reachable
 *   through the API — every write that names a role is refused with
 *   `unknown_role`, and `estimate.role_id` is a foreign key — but the days are
 *   somebody's typing and they already count towards today's duration. They are
 *   kept, in a slice after the roles the project does hold, rather than dropped
 *   silently or thrown over the whole project's read.
 */
/**
 * Which pool one row's slices spend slots in, and how many slots that pool
 * holds — read off the row's effective **team** set.
 *
 * Three rules, and the first two are today's, unchanged by the arity:
 *
 * 1. **No team, no pool.** An empty set states nothing, so the slice is
 *    unconstrained.
 * 2. **An unsized team labels the work and constrains nothing.** A team this
 *    project has stated no capacity for is absent from `teamSizes`, and the
 *    `null` pool that comes back is what keeps the engine's `no size for pool`
 *    throw a caller-fault assertion rather than ordinary control flow.
 * 3. **More than one team throws.** The engine takes one pool per slice
 *    (`Slice.poolId`), so the honest answers are "refuse" and "spend in all of
 *    them" — and the second is R2-2, the change after this one. Narrowing to
 *    the first member instead would schedule the work against a pool the plan
 *    never narrowed to, silently, and is exactly the trap `effectiveTeamsOf`
 *    was renamed to prevent (design.md D3, D4).
 *
 * Rule 3 is an invariant assertion rather than a modelled refusal, of the same
 * kind as `schedule.ts`'s `no size for pool`: nothing a client can send
 * produces a second team while the write path writes at most one. R5 — unknown
 * is not OK — and it is a throw rather than a comment because a throw can be
 * watched, which is what the negative below does.
 *
 * Exported for that test alone; `slicesOf` is its only production caller.
 *
 * Proof: the arity guard made unreachable, so the body falls through to
 * `teamIds.at(0)`, and `refuses a set the engine cannot spend` failed on
 * `Received function did not throw` — the silent narrowing this exists to
 * prevent, reported as a passing schedule; watched 2026-08-14.
 */
export function poolFor(
  teamIds: readonly string[],
  teamSizes: ReadonlyMap<string, number>,
): { poolId: string | null; slots: number | undefined } {
  if (teamIds.length > 1) {
    throw new Error(
      `a work item’s effective team set holds ${String(teamIds.length)} teams (${teamIds.join(', ')}), and a slice spends slots in one pool`,
    );
  }
  const teamId = teamIds.at(0) ?? null;
  const slots = teamId === null ? undefined : teamSizes.get(teamId);
  return { poolId: slots === undefined ? null : teamId, slots };
}

function slicesOf(
  rows: readonly WorkItem[],
  estimates: readonly StoredEstimate[],
  hasChildren: ReadonlySet<string>,
  roleIds: readonly string[],
  method: EstimateMethod,
  /**
   * Each work item's assignees by role, from which every slice's person is
   * read.
   *
   * The planner takes the person per slice and never derives one, so this is
   * the only place the assumed assignee becomes a queue: a work item with one
   * named person carries them on **every** slice, which is what "when just one
   * is assigned it is assumed they do both" means once time is involved.
   */
  assigneesOf: ReadonlyMap<string, Record<string, string>>,
  /**
   * Each row's effective team set — its own, or the nearest ancestor's, from
   * {@link effectiveTeamsOf}.
   *
   * Passed in rather than resolved here, because the reading is shared: the
   * table cell, the cards, the Gantt and the export all show the same inherited
   * label, and a second walk here would be the copy that drifts.
   */
  teamOf: ReadonlyMap<string, { teamIds: readonly string[] }>,
  /**
   * How many people each **sized** team may have at work at once. A team nobody
   * has sized is simply absent, and its work draws from no pool.
   */
  teamSizes: ReadonlyMap<string, number>,
): Slice[] {
  const inProject = new Set(rows.map((row) => row.id));
  const held = new Set(roleIds);
  const days = new Map<string, number>();
  const unlisted = new Set<string>();
  for (const estimate of estimates) {
    if (hasChildren.has(estimate.workItemId)) continue;
    if (!inProject.has(estimate.workItemId)) continue;
    days.set(sliceKey(estimate.workItemId, estimate.roleId), finalDays(estimate, method));
    if (!held.has(estimate.roleId)) unlisted.add(estimate.roleId);
  }

  const order = [...roleIds, ...[...unlisted].sort()];
  const slices: Slice[] = [];
  for (const row of rows) {
    if (hasChildren.has(row.id)) continue;
    const byRole = assigneesOf.get(row.id) ?? {};
    // The role's own assignee, or — when exactly one role is named — the person
    // that one assignment is read as covering the lot. {@link assumedAssignee}
    // is that reading, shared with the tree's `doesEveryPhase` and with the
    // role removal that has to say whose answer it would change.
    //
    // Proof: the fallback dropped, so that only named assignments queue, and
    // `queues every phase of a work item its one assignee is assumed to be
    // doing` failed — the work item finished on day 3 with its `QA` running
    // while its own assignee was on somebody else's `Dev`; watched 2026-08-09.
    const personFor = (roleId: string | null): string | null =>
      (roleId === null ? undefined : byRole[roleId]) ?? assumedAssignee(byRole);
    const { poolId, slots } = poolFor(teamOf.get(row.id)?.teamIds ?? [], teamSizes);
    /**
     * How many slots one of this row's slices holds while it runs.
     *
     * Three rules, in this order, and each is a statement the plan actually
     * makes:
     *
     * 1. **A named person is one person.** `assumedAssignee` means one named
     *    assignment covers every role of the item, so naming somebody on a
     *    `maxParallel: 3` item collapses the whole item to width 1 and
     *    serialises its roles. One human cannot work beside themselves, and the
     *    alternative — "kat plus two others" — has the engine claiming people
     *    the plan has not named.
     * 2. **Nobody may claim more people than the team has.** A `maxParallel` of
     *    4 against a team of 2 runs at 2.
     * 3. Otherwise the stored number.
     *
     * Resolved here rather than in the pass for `personId`'s reason: a second
     * implementation of this inside the scheduler would put work on widths
     * nobody asked for.
     *
     * Proof: the clamp against `slots` dropped and `clamps a work item's
     * parallelism down to the size of its team` failed with `width: 4` and
     * `duration: 1` — a plan claiming four of a team of two; watched
     * 2026-08-12.
     *
     * Proof: the named-person arm dropped and `runs a named person's work one
     * at a time however parallel the item is` failed with `width: 3` and
     * `duration: 2` on work one person is doing; watched 2026-08-12.
     */
    const widthFor = (personId: string | null): number => {
      if (personId !== null) return 1;
      return Math.min(row.maxParallel, slots ?? row.maxParallel);
    };
    if (order.length === 0) {
      const personId = personFor(null);
      slices.push({
        workItemId: row.id,
        roleId: null,
        days: null,
        personId,
        width: widthFor(personId),
        poolId,
      });
      continue;
    }
    for (const roleId of order) {
      const personId = personFor(roleId);
      slices.push({
        workItemId: row.id,
        roleId,
        days: days.get(sliceKey(row.id, roleId)) ?? null,
        personId,
        width: widthFor(personId),
        poolId,
      });
    }
  }
  return slices;
}

/**
 * A row's assignees, and who — if anyone — is assumed to be doing every phase.
 *
 * The reading itself is {@link assumedAssignee}, shared with the role removal
 * that has to say whose answer it would change. Written out twice, the two
 * would drift, and the drift would show up as a confirmation naming the wrong
 * people.
 */
function phasesOf(assignees: Record<string, string>): {
  assignees: Record<string, string>;
  doesEveryPhase: string | null;
} {
  return { assignees, doesEveryPhase: assumedAssignee(assignees) };
}

/**
 * One row's span as calendar days, or null when it cannot have one.
 *
 * Null in two cases, both of them honest: the project is not on a calendar, or
 * the schedule could not be computed at all. Printing a date from a schedule
 * that failed would be the same confident lie as printing a page of zeroes,
 * which the banner above the table exists to prevent.
 *
 * The finish is nudged back inside the span: a task of any length occupies the
 * day it finishes on, so a one-day task starting Monday ends Monday rather
 * than Tuesday. A zero-length row — a parent with nothing under it, or an
 * unestimated leaf — starts and ends the same day.
 */
function datesOf(
  startDate: IsoDate | null,
  timing: Scheduled,
  failed: boolean,
): { startsOn: IsoDate; endsOn: IsoDate } | null {
  if (startDate === null || failed) return null;
  // Both readings are `@wbs/domain`'s, shared with fe-01's Gantt so the chart
  // and these dates cannot disagree on a drifted offset: `firstWorkdayOf` is
  // snap-then-floor, and `lastWorkdayOf` is snap-then-`ceil − 1` clamped to
  // the start's day — the day containing `earliestFinish`, minus the one it
  // would otherwise spill into. The history of that arithmetic — why `ceil −
  // 1` and not `finish - Number.EPSILON`, why the snap sits inside the
  // discrete step, and the faults watched — is on the helpers themselves.
  // Across a dependency chain the drifted bit survives on the wire by design
  // (see `schedule-shapes.test.ts`, 'accumulates PERT sixths…'); these two
  // boundaries are what keep it off the calendar.
  return {
    startsOn: addWorkdays(startDate, firstWorkdayOf(timing.earliestStart)),
    endsOn: addWorkdays(startDate, lastWorkdayOf(timing.earliestStart, timing.earliestFinish)),
  };
}

/**
 * One row's final figure per role, and their sum, under the project's method.
 *
 * Split out so the shape is built in one place: `finalDays` and `finalTotal`
 * disagreeing would be two answers to one question, and the table prints both
 * side by side.
 */
function finalsOf(
  byRole: ReadonlyMap<string, Days>,
  method: EstimateMethod,
): { finalDays: Record<string, number>; finalTotal: number } {
  const perRole: Record<string, number> = {};
  let total = 0;
  for (const [roleId, days] of byRole) {
    const final = finalDays(days, method);
    perRole[roleId] = final;
    total += final;
  }
  return { finalDays: perRole, finalTotal: total };
}

/**
 * A work item as a reader sees it: the stored row, the number derived for it and
 * its estimates by role — its own if it is a leaf, its descendants' sums if not.
 */
export interface NumberedWorkItem extends LabelledWorkItem {
  /**
   * How many times this work item has been written to, including writes to its
   * estimates, assignments and dependencies.
   *
   * Redeclared from {@link WorkItem} only to say what it means **for a reader**,
   * which is the reason it is on the wire at all: hold it alongside the row you
   * read, and a later write can ask to land only if the row has not moved
   * since. Nothing asks that yet — conditional undo and write preconditions are
   * the changes that will.
   *
   * It does **not** move when `number` does. A create anywhere above renumbers
   * rows nobody wrote to, and a revision that tracked the derived number would
   * be a project-wide counter with a work item's name on it.
   *
   * A created work item is 0. One created as the first child of a work item
   * that held estimates is 1: the handoff of those estimates down to it is a
   * second write, to a row that then genuinely holds something it did not
   * before.
   */
  revision: number;
  number: string;
  estimates: Record<string, Days>;
  /** True when the estimates above are sums and therefore not editable here. */
  rolledUp: boolean;
  /** The work items this one waits for, as written — either end may be a parent. */
  dependsOn: string[];
  /**
   * The one number this row is planned with, per role, and their sum.
   *
   * Computed here rather than on the client, from the same {@link finalDays}
   * the schedule's durations come from. Two implementations of "the final
   * estimate" is how a table comes to disagree with the dates printed beside
   * it, and this figure sits in the next column along from those dates.
   *
   * A role with no estimate anywhere below is absent, exactly as `estimates`
   * is: absent and zero mean opposite things.
   */
  finalDays: Record<string, number>;
  /** Every role's final figure, summed — the row's whole planning duration. */
  finalTotal: number;
  /**
   * When this can happen, in whole days from the project's day zero.
   *
   * `estimates` above is **effort** and this is **span**, and for a parent they
   * are different numbers: two independent children of 3 and 4 days are 7 days
   * of work inside a 4-day branch. Both are true and neither substitutes.
   */
  schedule: Scheduled;
  /**
   * When this happens on a calendar, or null while the project has no start
   * date.
   *
   * Working days only: weekends are skipped, so a five-day task starting on a
   * Thursday ends on the following Wednesday. Public holidays are not modelled
   * — they differ by country, company and year, and inventing them would put
   * dates in a plan nobody can account for.
   *
   * `endsOn` is the day the work item is still being worked on, not the day
   * after: a one-day task starting Monday ends Monday.
   */
  dates: { startsOn: IsoDate; endsOn: IsoDate } | null;
  /**
   * Who is doing this work, by role id.
   *
   * A role with nobody assigned is absent rather than null. When exactly one
   * role is assigned, `doesEveryPhase` names that person: Dany's "when just
   * one is assigned it is assumed they do both dev and QA". It is reported as
   * a reading of the assignments rather than written as a second row, so
   * nobody is recorded against work they were never given, and assigning the
   * other role simply stops the assumption.
   */
  assignees: Record<string, string>;
  doesEveryPhase: string | null;
}

/**
 * One placed slice as a reader sees it: the engine's own output, under the key
 * the engine holds it by.
 *
 * `id` is that key — {@link sliceKey}'s string, and opaque on both sides of the
 * wire. It is what a slice's `resourcePredecessorId` names, so the person a
 * reader draws a link from is **looked up** among these ids rather than derived
 * from a work item and a role: reconstructing the key on the client would be a
 * second implementation of {@link sliceKey}, and the two would disagree the day
 * either changes.
 *
 * Everything else is {@link ScheduledSlice} unchanged. The numbers are the
 * engine's verbatim — a slice starting at 3.6666666666666665 leaves as that, so
 * a bar drawn from it and the Start column beside it cannot say different days.
 */
export interface IdentifiedSlice extends ScheduledSlice {
  id: string;
}

/** Why a project has no dates, when it has none. `null` is the ordinary case. */
export type ScheduleError = 'cycle' | null;

export type DeleteStrategy = 'cascade' | 'promote';

export type WorkItemRefusal =
  | 'not_found'
  | 'forbidden'
  | 'strategy_required'
  | 'cycle'
  | 'frozen'
  | 'rolled_up'
  /**
   * A parallelism written on a row that has children.
   *
   * Its own reason rather than `rolled_up`: nothing is rolled up here — a
   * parent's parallelism is not the sum of its children's — and a client
   * showing "this row's figures come from below" for a refusal that means "this
   * cell is not yours to type in" would be explaining the wrong thing.
   */
  | 'has_children'
  /** A dependency onto the work item's own ancestor, descendant, or itself. */
  | 'ancestor'
  /** A subtree past {@link MAX_DUPLICATED_ROWS}. */
  | 'too_large'
  /**
   * A role the project does not hold — usually one somebody removed while this
   * caller had it on screen. `estimate.role_id` and `assignment.role_id` are
   * foreign keys, so without this the write reaches the database and answers
   * 500 for a request whose only fault is being out of date.
   */
  | 'unknown_role'
  /**
   * A person the directory no longer holds, decided inside the write's own
   * transaction — see {@link AssignmentWritten}. Without it the same
   * out-of-date picker reaches `assignment.person_id` and answers 500.
   */
  | 'unknown_person'
  /**
   * A team the directory no longer holds, decided inside the write's own
   * transaction — see {@link WorkItemPatched}. Without it the same out-of-date
   * picker reaches `work_item.service_team_id` and answers 500: the column
   * **does** carry a foreign key, against what the comment here claimed until
   * `team-sets` measured it (2026-08-14). `unknown_team` is what turns that
   * constraint failure into a refusal somebody can read.
   */
  | 'unknown_team'
  /**
   * A tag the directory no longer holds, decided inside the write's own
   * transaction — see {@link WorkItemPatch.tagIds}. The same out-of-date picker
   * as `unknown_team`, and a separate reason from it deliberately: a reader
   * told a label is gone has to know **which** of the two pickers to reopen,
   * and the dimensions are independent everywhere else in this model.
   */
  | 'unknown_tag'
  /**
   * A service the directory no longer holds, decided inside the write's own
   * transaction — see {@link WorkItemPatch.serviceIds}. The third picker, and a
   * third reason on purpose: told only that "a label is gone", a reader has
   * three pickers to reopen and no way to choose.
   */
  | 'unknown_service'
  /**
   * A patch that would leave a work item holding a reason with no not-before
   * date for it to be a reason about, decided inside the write's own
   * transaction — see {@link WorkItemPatched}.
   *
   * 400 and not 409: the request is malformed against **any** tree, because
   * there is no state of the plan in which words about a floor that is not
   * there mean anything. The two ways to meet it are a reason sent on a row with
   * no date, and — much the commoner — a date cleared without clearing the words
   * beside it, which is `{ startNoEarlierThan: null }` where
   * `{ startNoEarlierThan: null, startNoEarlierThanReason: null }` was meant.
   *
   * Refused rather than tidied on the caller's behalf: the words are somebody's
   * sentence, and a write that silently deletes them is the worse of the two
   * answers.
   */
  | 'not_before_reason_needs_a_date';

export type WorkItemOutcome<T> = { ok: true; result: T } | { ok: false; reason: WorkItemRefusal };

export interface CreateWorkItem {
  parentId: string | null;
  afterId: string | null;
  name?: string;
  notes?: string;
}

export interface MoveWorkItem {
  parentId: string | null;
  afterId: string | null;
}

export interface WorkItemServiceOptions {
  workItems: WorkItemStore;
  projects: ProjectStore;
  estimates: EstimateStore;
  /**
   * Where the days actually spent are kept.
   *
   * Required rather than optional, for {@link WorkItemServiceOptions.journal}'s
   * reason turned around: a service built without one would answer every read
   * with no actuals at all, which is indistinguishable from a plan nobody has
   * recorded anything against — and that is the true answer for every plan on
   * the day this ships, so the mistake would be invisible for a week.
   */
  actuals: ActualStore;
  /**
   * Where each role says its work on a work item has got to.
   *
   * Required rather than optional, for {@link WorkItemServiceOptions.actuals}'
   * reason exactly: a service built without one would answer every read with
   * nothing stated anywhere, which is the true answer for every plan on the day
   * this ships and therefore an invisible mistake for a week.
   */
  progress: RoleProgressStore;
  directory: DirectoryStore;
  /**
   * How many of each team this project may have at work at once — C1's `slotsOf`
   * seam with the per-project lookup behind it.
   *
   * A collaborator of its own rather than four methods on `directory`, because
   * the fact is a **project's** and the directory is what the global list is read
   * through. `capacity-per-project`'s design.md D3.
   */
  capacity: CapacityStore;
  /**
   * What this project calls its priority numbers, read on the plan's own payload.
   *
   * A read and never a write from here, and read by nothing that computes a date:
   * the leveller orders on `work_item.priority` alone. It is on this service
   * because a ladder has to arrive in the same payload as the numbers it names —
   * see {@link WorkItemService.tree}'s `priorityBands`.
   */
  priorityBands: PriorityBandStore;
  dependencies: DependencyStore;
  subtrees: SubtreeStore;
  /**
   * Where every reversible command is written down.
   *
   * Required rather than optional. A service built without one would apply
   * every mutation and record none of them, and the only symptom would be an
   * undo key that quietly does nothing — the shape of failure `AGENTS.md` R5
   * exists to keep out of this repo.
   */
  journal: CommandJournalStore;
  broadcast: Broadcaster;
  newId?: () => string;
  now?: () => number;
}

/** Why an undo or a redo did not happen. */
export type UndoRefusal =
  | 'not_found'
  | 'forbidden'
  /** The account has nothing left in that half of its stack for this project. */
  | 'nothing_to_undo'
  /**
   * Something the command touched has been written to since, so reversing it
   * would overwrite a change nobody asked to lose. The entry is thrown away:
   * it can never apply again, and leaving it would refuse every later press of
   * the key for a change nobody can reach.
   */
  | 'stale_undo';

export interface UndoDone {
  /** What was reversed, as a sentence: `rename “Strip”`. */
  done: string;
  /** What could not be put back exactly, or null when everything was. */
  detail: string | null;
}

/**
 * What came of walking one step along the undo stack.
 *
 * **A refusal's `detail` is a finished sentence, full stop and all.** The client
 * shows it verbatim at the tail of its own — `That could not be undone: …` —
 * and every one of these used to stop mid-phrase: `“Roof it” has changed since`
 * reached a reader's screen on 2026-08-09, with no full stop and no answer to
 * "since *what*?". A clause is not a sentence just because something else
 * supplies its opening.
 */
export type UndoOutcome =
  | { ok: true; result: UndoDone }
  | { ok: false; reason: UndoRefusal; detail: string | null };

/** Whether applying one compensating command worked, and what it could not do. */
type ApplyOutcome = { ok: true; detail: string | null } | { ok: false; detail: string };

/**
 * The largest subtree one duplication will copy.
 *
 * A judgement rather than a measurement: well above any phase somebody builds
 * by hand, well below anything that makes one transaction slow. It exists
 * because each duplication can double what the next one copies, and nothing
 * else in the tool bounds that.
 */
export const MAX_DUPLICATED_ROWS = 500;

/** What a duplicated root's name gains, so two identical siblings can be told apart in a picker. */
const COPY_SUFFIX = ' (copy)';

const asSibling = (workItem: WorkItem): Sibling => ({
  id: workItem.id,
  position: workItem.position,
});

/** Whether `candidateId` sits anywhere below `ancestorId`, walking parents upward. */
function descendsFrom(rows: readonly WorkItem[], candidateId: string, ancestorId: string): boolean {
  const parentOf = new Map(rows.map((w) => [w.id, w.parentId]));
  let cursor: string | null | undefined = candidateId;
  while (cursor !== null && cursor !== undefined) {
    if (cursor === ancestorId) return true;
    cursor = parentOf.get(cursor);
  }
  return false;
}

/** `rootId` and everything beneath it. */
function subtreeOf(rows: readonly WorkItem[], rootId: string): string[] {
  const childrenOf = new Map<string | null, WorkItem[]>();
  for (const row of rows) {
    const group = childrenOf.get(row.parentId) ?? [];
    group.push(row);
    childrenOf.set(row.parentId, group);
  }
  const collected: string[] = [];
  const visit = (id: string): void => {
    collected.push(id);
    for (const child of childrenOf.get(id) ?? []) visit(child.id);
  };
  visit(rootId);
  return collected;
}

/** One row of `rows`, or a throw: an id from the same read is not allowed to be missing. */
function rowOf(rows: readonly WorkItem[], id: string): WorkItem {
  const found = rows.find((row) => row.id === id);
  if (found === undefined) throw new Error(`${id} is not a row of this project`);
  return found;
}

/** A work item's name for a sentence, or the empty string when the row has gone. */
function nameOf(rows: readonly WorkItem[], id: string): string {
  return rows.find((row) => row.id === id)?.name ?? '';
}

/** Which fields a patch actually names. An absent field and a null one mean different things. */
function fieldsOf(patch: WorkItemPatch): (keyof WorkItemPatch)[] {
  const named: (keyof WorkItemPatch)[] = [];
  if (patch.name !== undefined) named.push('name');
  if (patch.notes !== undefined) named.push('notes');
  if (patch.startNoEarlierThan !== undefined) named.push('startNoEarlierThan');
  // Proof: this line deleted, so a patch naming only the reason journals
  // nothing — **62 pass, 1 fail** — and `undoes a reason written beside a date
  // that was already there` failed at its `expectDone` on `refused: stale_undo
  // — “Strip” has changed since then`: the undo reached past the unjournalled
  // write to an entry that write had already made stale, so the words stay on
  // screen and the press is refused. The parallelism line's own red, one field
  // over. Watched 2026-08-18.
  if (patch.startNoEarlierThanReason !== undefined) named.push('startNoEarlierThanReason');
  // Proof: this line and the matching one in {@link revertTo} each deleted in
  // turn, and both `puts a replaced priority back, and leaves a priority a rename
  // did not name` and `takes a first priority away again, rather than leaving a
  // 1 behind` failed — the undo restored nothing and the work item kept the
  // priority the undone patch had written; watched 2026-08-11.
  if (patch.priority !== undefined) named.push('priority');
  if (patch.serviceTeamId !== undefined) named.push('serviceTeamId');
  // Proof: this line deleted, so a patch naming only the service journals
  // nothing, and `puts a replaced service back` failed at its `expectDone` on
  // `refused: stale_undo — “Strip the roof” has changed since then`: the undo
  // reached past the unjournalled write to an entry that write had already made
  // stale. The tag line's own red, one dimension over. Watched 2026-08-21.
  if (patch.serviceIds !== undefined) named.push('serviceIds');
  // Proof: this line deleted, so a patch naming only a parallelism journals
  // nothing at all, and all three parallelism undo tests — `puts a replaced
  // parallelism back, and leaves one a rename did not name`, `takes a first
  // parallelism away again, rather than leaving a 3 behind` and `puts a reset to
  // one at a time back to the number it replaced` — failed at their `expectDone`
  // (undo.test.ts:226, :245, :259) on
  // `refused: stale_undo — “Strip” has changed since then` — the undo reached
  // past the unjournalled write to an entry the same write had made stale.
  // Watched 2026-08-12; {@link revertTo}'s matching line fails differently and
  // carries its own.
  if (patch.maxParallel !== undefined) named.push('maxParallel');
  // Proof: this line deleted, so a patch naming only the tags journals nothing
  // — and `puts a replaced tag set back, whole` failed at its `expectDone` on
  // `refused: stale_undo — “Strip the roof” has changed since then`: the undo
  // reached past the unjournalled write to an entry that write had already made
  // stale. The parallelism line's own red, one dimension over. Watched
  // 2026-08-19.
  if (patch.tagIds !== undefined) named.push('tagIds');
  return named;
}

/**
 * The patch that puts `before` back, naming **only** the fields the forward
 * patch named.
 *
 * Naming every field would be a rename that also silently restored a note
 * somebody else edited in between — an undo that reverses more than the change
 * it is undoing.
 */
function revertTo(before: LabelledWorkItem, patch: WorkItemPatch): WorkItemPatch {
  const out: WorkItemPatch = {};
  if (patch.name !== undefined) out.name = before.name;
  if (patch.notes !== undefined) out.notes = before.notes;
  if (patch.startNoEarlierThan !== undefined) out.startNoEarlierThan = before.startNoEarlierThan;
  // The inverse of a pair patch names **both** halves of the pair the forward
  // patch named, which is what keeps every inverse legal against the rule that
  // refuses a reason with no date: naming only the fields the forward named
  // reconstructs `before`'s own pair for those fields and leaves the rest as
  // they are — and the rest are `before`'s too, because the forward did not
  // touch them. So an inverse can only ever land the row back on a pair it was
  // already in, and there is no undo this store refuses.
  //
  // Proof: this line deleted, so the inverse of `{ date: null, reason: null }`
  // names the date alone — **61 pass, 2 fail**. `puts the words back with the
  // date they explain` failed on `Expected: "waiting on client sign-off" /
  // Received: null`: a pressable undo that reports done, restores the floor and
  // drops the sentence saying why it is there. `undoes a reason written beside
  // a date that was already there` failed with it, on the words never coming
  // off. Watched 2026-08-18.
  if (patch.startNoEarlierThanReason !== undefined) {
    out.startNoEarlierThanReason = before.startNoEarlierThanReason;
  }
  if (patch.priority !== undefined) out.priority = before.priority;
  if (patch.serviceTeamId !== undefined) out.serviceTeamId = before.serviceTeamId;
  // **The whole prior set**, the rule below it and no longer its inverse. The
  // comment that stood here argued the opposite at length — a column has exactly
  // one prior value, so wrapping it in an array would journal a shape the patch
  // cannot take — and task 10.2 ended that argument by making the join table the
  // store. The patch takes a set now, so the undo restores a set.
  //
  // `[]` is a legal before-value and means the row stated no service of its own:
  // the inverse of labelling it is taking the label off, which is the empty set
  // rather than an absent field. Absent would leave behind the label the undo
  // exists to remove.
  //
  // The scalar habit is what this loses data to, and it is the *tags* fault one
  // dimension over rather than the throw the column used to give: journal one
  // member of a two-service row and the undo reports success while restoring
  // half the fact. This line arrived with 10.2's type change, which left no
  // compiling way to keep the scalar; **task 10.3 drove the red that makes it a
  // rule rather than a shape** — written as `before.serviceIds.slice(0, 1)`,
  // `puts a replaced service set back, whole` in `undo.test.ts` fails alone (76
  // pass, 1 fail over that file) on a restored set holding one of the row's two
  // services, while every one-service case beside it stays green. Watched
  // 2026-08-21.
  if (patch.serviceIds !== undefined) out.serviceIds = before.serviceIds;
  // **The whole prior set, and this is the seam a scalar habit loses data at.**
  // A set-valued field's inverse cannot be a member of the set or a delta
  // against it: undoing "these three tags" has to restore the two that were
  // there, and any spelling that carries one id restores one of them and drops
  // the rest — silently, reporting a successful undo.
  //
  // It is also why `before` here is a {@link LabelledWorkItem} rather than the
  // {@link WorkItem} every other line in this function reads: `work_item` has
  // no column for a tag, so the prior set exists only on the row the plan read
  // gave back. Reading the store's own row for it would be a second read with a
  // concurrent write's worth of gap in front of it.
  //
  // `[]` is a legal before-value and means the row had no tags: the inverse of
  // "tag it" is "take them off", which is the empty set rather than an absent
  // field. There is no null arm here for the same reason there is none on the
  // patch.
  //
  // Proof: written as `out.tagIds = before.tagIds.slice(0, 1)` — the scalar
  // habit, keeping "the tag" — and **68 pass, 1 fail**: `puts a replaced tag
  // set back, whole` failed on `expect(received).toEqual(expected)` with one of
  // the two restored ids missing from the array. A pressable undo that reports
  // **done** and leaves the row carrying one of the two labels it had, which is
  // the whole failure mode this field's design is about — nothing else in the
  // suite notices. Watched 2026-08-19, see verify.md.
  if (patch.tagIds !== undefined) out.tagIds = before.tagIds;
  // `before.maxParallel` is a number and never null — the column is `NOT NULL`
  // — so the inverse of a reset to 1 is the stored number itself rather than a
  // second null.
  //
  // Proof: this line deleted, so the inverse of a parallelism patch is the
  // empty patch. The undo then reports **done** — an inverse naming no field
  // takes the store's no-field branch and writes nothing — and what fails is the
  // value each test reads back afterwards, in all three: `puts a replaced
  // parallelism back, and leaves one a rename did not name` on
  // `Expected: 3, Received: 5` (undo.test.ts:227), `takes a first parallelism
  // away again, rather than leaving a 3 behind` on `Expected: 1, Received: 3`
  // (:250), and `puts a reset to one at a time back to the number it replaced`
  // on `Expected: 4, Received: 1` (:261). That is the worse of the two failures
  // either line can produce: {@link fieldsOf}'s red at least refuses out loud,
  // where this one reports a successful undo that moved nothing.
  // Watched 2026-08-12.
  if (patch.maxParallel !== undefined) out.maxParallel = before.maxParallel;
  return out;
}

/** The revisions of `ids` as `rows` holds them, skipping ids `rows` does not have. */
function revisionsIn(rows: readonly WorkItem[], ids: readonly string[]): Revisions {
  const byId = new Map(rows.map((row) => [row.id, row.revision]));
  const out: Revisions = {};
  for (const id of new Set(ids)) {
    const revision = byId.get(id);
    if (revision !== undefined) out[id] = revision;
  }
  return out;
}

/** A journalled command, as the mutation that ran it hands it over. */
interface Recording {
  /** What a redo re-applies. */
  forward: CompensatingCommand;
  /** What an undo applies. */
  inverse: CompensatingCommand;
  /** Every work item the command wrote to, whose revisions become its preconditions. */
  touched: string[];
  /**
   * The project's rows as the mutation read them **before** writing.
   *
   * Every mutation already has this: it is what its own guards were decided
   * against. It is here so the entry can record where the entities it touched
   * started, which is what lets the entry below it survive this one's undo —
   * see `Preconditions` in `compensating.ts`.
   */
  before: readonly WorkItem[];
}

export class WorkItemService {
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(private readonly opts: WorkItemServiceOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Every work item in the project, each carrying the number derived for it,
   * ordered as the tree reads.
   *
   * Sorting by the derived number rather than by position is what makes the
   * padding rules load-bearing: the numbers are built so that this one
   * lexicographic sort produces tree order across every level at once.
   */
  /**
   * The project's work items, and the event sequence the read happened at.
   *
   * The sequence is read *before* the rows rather than after. Reading it after
   * would let an event recorded mid-read be counted as already seen, and the
   * client would resume from a point past a change its rows do not contain. Read
   * first, the same event is replayed and the client refetches once too often —
   * the harmless direction.
   */
  async tree(projectId: string): Promise<{
    workItems: NumberedWorkItem[];
    seq: number;
    scheduleError: ScheduleError;
    /**
     * How many work items hold a slice a person is the reason for — the
     * schedule header's "N tasks wait for a person".
     *
     * A count rather than the slices themselves: what the reader is told here
     * is that people are the constraint and how much of the plan they hold up.
     * Which slice waits for whom is in {@link IdentifiedSlice.boundBy} beside
     * it, and is a Gantt bar rather than a sentence.
     */
    waitingForPerson: number;
    /**
     * How many work items hold a slice a **team's capacity** is the reason for.
     *
     * Beside `waitingForPerson` rather than folded into it: a planner reads a
     * queue and a headcount differently, and `boundBy` names exactly one of the
     * two for any slice.
     */
    waitingForCapacity: number;
    /**
     * Every slice the schedule placed, in the order the engine placed them.
     *
     * The projection in each row's `schedule` is what a table column shows; this
     * is what it is a projection **of**, and it is what a chart draws — one bar
     * per entry, and the person links from `resourcePredecessorId`. Both are
     * carried because they answer different questions, and neither is derivable
     * from the other: a row's span does not say which role ran when, and a
     * slice does not know its parent's bracket.
     *
     * Empty when there is no schedule at all, exactly as the row schedules
     * degrade to {@link UNSCHEDULED} — a cycle leaves the rows on screen and
     * takes the dates away, and bars left over from a plan that no longer
     * computes would be the same confident lie in a different shape.
     */
    slices: IdentifiedSlice[];
    /**
     * The project's roles, in the order the engine ran the slices in.
     *
     * The same array `slicesOf` was given, carried on the read that produced
     * the slices rather than left to `/api/projects/:id` — which is a second
     * request at a second moment. A chart reads a slice's `roleId` to place its
     * bar and to name its phase, and a peer removing a phase between the two
     * reads left a client holding slices under a role its own role list no
     * longer had. Within one payload that skew cannot exist.
     *
     * Read **after** the rows and before the schedule, so a phase added between
     * them is at worst a role nothing points at, never a slice with no role.
     */
    roles: Role[];
    /**
     * Every person an assignment on these rows names, by id and name.
     *
     * The names, not the whole directory: a chart paints a bar in its
     * assignee's colour and writes their name on it, and both are facts about
     * the slices in this very payload. `/api/people` answers a different question — who
     * could be assigned — and is still what the pickers read.
     *
     * Read after {@link DirectoryStore.assignmentsOf} on purpose. People are
     * only ever added, so a person created between the two reads is one this
     * list has and no assignment names; the other order would hand out an
     * assignment to somebody unnamed.
     */
    assignedPeople: Person[];
    /**
     * How many of each team this project may have at work at once, for the teams
     * it has stated a number about.
     *
     * The same map `slotsOf` was built from, carried on the read that produced
     * the slices rather than left to a route of its own — the argument
     * {@link roles} makes, and it is stronger here: the dates in this payload were
     * computed **from** these numbers, and a second request at a second moment
     * could hand a client a number that does not explain the bars beside it.
     *
     * A team the project has stated nothing about is **absent** rather than
     * present as `null`, exactly as it is absent from `slotsOf`: unstated
     * constrains nothing, and one spelling of it is the rule the column is shaped
     * by. Every team on the plan is in `/api/teams`; this says which of them this
     * plan bounds.
     */
    teamCapacities: TeamCapacity[];
    /**
     * What this project calls its priority numbers — five bands in rank order.
     *
     * Carried on the read that produced the rows rather than left to a route of
     * its own, which is the argument {@link roles} and {@link teamCapacities}
     * make. The reason is weaker here in one way and stronger in another: no date
     * in this payload was computed from the ladder, so a stale one cannot
     * contradict a bar the way a stale capacity can — but *every* face draws
     * every priority through it, so a client holding a ladder from one moment
     * over numbers from another paints the wrong label on every row of the plan
     * rather than on one.
     *
     * Never absent and never empty: a project holding no rows reads as
     * {@link DEFAULT_PRIORITY_BANDS}, so a client can resolve every priority
     * without a fallback of its own.
     * `openspec/changes/priority-bands/design.md` D2.
     */
    priorityBands: PriorityBand[];
    estimateMethod: EstimateMethod;
    startDate: IsoDate | null;
    /**
     * The project row's own revision, which moves on its name, restriction,
     * estimate method, start date and roles — and on none of the work items
     * below it, each of which carries its own.
     */
    projectRevision: number;
  } | null> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return null;
    const seq = await this.opts.broadcast.latestSeq(projectId);
    const rows = await this.opts.workItems.listByProject(projectId);
    const stored = await this.opts.estimates.listByProject(projectId);
    // Read beside the estimates and used for nothing but the payload. It is
    // handed to no scheduling function — not `slicesOf`, not `schedule` — and
    // that absence is this change's whole claim about itself: R6 reports, it
    // does not plan. See `openspec/changes/actual-days/design.md` D3.
    const recorded = await this.opts.actuals.listByProject(projectId);
    // Read beside the actuals and, like them, handed to nothing that schedules.
    // What it is for is the tense of the number above it: 8 days against an
    // estimate of 5 is "overran by 3" or "is 3 over so far", and until this row
    // says which, a variance is a figure nobody can act on.
    const stated = await this.opts.progress.listByProject(projectId);
    const edges = await this.opts.dependencies.listByProject(projectId);
    const assigned = await this.opts.directory.assignmentsOf(rows.map((row) => row.id));
    // The names for the ids just read, on this read rather than on a client's
    // separate one. Filtered to who is actually on this plan: the directory is
    // global and a chart has no use for people no slice names.
    const assignedIds = new Set(assigned.map((each) => each.personId));
    const assignedPeople = (await this.opts.directory.listPeople())
      .filter((each) => assignedIds.has(each.id))
      .map(({ id, name }) => ({ id, name }));
    const assigneesOf = new Map<string, Record<string, string>>();
    for (const each of assigned) {
      assigneesOf.set(each.workItemId, {
        ...(assigneesOf.get(each.workItemId) ?? {}),
        [each.roleId]: each.personId,
      });
    }
    const numbers = deriveNumbers(rows);
    const totals = rollUp(rows, stored);
    const recordedTotals = rollUpActuals(rows, recorded);
    const hasChildren = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
    // Which roles have work on each leaf: the ones with an estimate, the ones
    // with a recorded day, and the ones somebody has already spoken about.
    //
    // This set is what makes `done` mean anything. A leaf where Dev says done
    // and QA holds an estimate nobody has spoken about is **in progress**, not
    // finished — and the only way the fold can know QA exists on that row is for
    // the estimate to put it here. See `rollUpProgress`.
    const statedTotals = rollUpProgress(rows, stated, workedRolesOf(stored, recorded, stated));
    // The row's own reading, folded over its **children** rather than over its
    // rolled-up roles — see `rollUpItemStates` for why the two differ and which
    // one is true.
    const itemStates = rollUpItemStates(rows, statedTotals);
    // The write path refuses an edge that would close a cycle, but two clients
    // drawing conflicting edges at the same instant are each checked against the
    // graph as they read it. If one ever lands, every read of this project must
    // still work: the rows are there, and a plan nobody can open is worse than
    // one with no dates in it. The dates go, the rows stay, and the reason is
    // reported rather than left as a page of zeroes.
    // Role order comes from the project, because the order the roles are read
    // in is the order the work runs in — see `ProjectRepository.rolesOf`.
    const roles = await this.opts.projects.rolesOf(projectId);
    // How many slots this project may take of each team, read here rather than
    // inside `slicesOf` so the adapter stays a pure function of what it is
    // handed.
    //
    // `slotsOf` in name and in shape, and the seam C1 built is now doing the job
    // it was built for. C1's own comment here predicted "one additive table and a
    // first lookup, with this as the fallback"; `capacity-per-project` (Dany,
    // 2026-08-13) kept the first half and refused the second, so this is the one
    // lookup and there is **no fallback to `serviceTeam.size`** — a team this
    // project has stated nothing about is absent from the map, and an absent key
    // is unconstrained.
    //
    // Keyed on the team alone, not on the (project, team) pair: this is called
    // once per project, so a project component inside the map would be constant
    // for the whole call and every engine test would have to spell it. The pair
    // is the key in the **store**. design.md D3.
    const slotsOf = await this.opts.capacity.slotsFor(projectId);
    // The ladder, read here and handed straight to the payload. It is passed to
    // nothing — not `slicesOf`, not `schedule` — and that is the change's whole
    // claim about itself: `git diff` on this file shows one read and one field.
    const priorityBands = await this.opts.priorityBands.listFor(projectId);
    // One reading of the label, shared with the table, the cards, the Gantt and
    // the export — a leaf's own team set, or the nearest ancestor's. No write
    // ever copies a set down; see {@link effectiveTeamsOf}.
    const teamOf = effectiveTeamsOf(rows);
    const slices = slicesOf(
      rows,
      stored,
      hasChildren,
      roles.map((each) => each.id),
      project.estimateMethod,
      assigneesOf,
      teamOf,
      slotsOf,
    );
    // A manual date becomes an offset before the pass, and offsets become dates
    // after it: the schedule itself never sees a calendar, so weekends are
    // counted in exactly one place. Without a project start date there is
    // nothing to count from, so the constraints are simply not applied — a
    // plan off the calendar is the state it has always been in.
    const notBefore = new Map<string, number>();
    if (project.startDate !== null) {
      for (const row of rows) {
        if (row.startNoEarlierThan === null) continue;
        notBefore.set(row.id, workdaysBetween(project.startDate, row.startNoEarlierThan));
      }
    }
    let timing = new Map<string, Scheduled>();
    let scheduleError: ScheduleError = null;
    /**
     * How many work items are waiting for a person rather than for the plan.
     *
     * Zero when there is no schedule at all, which is honest rather than
     * convenient: a plan that could not be computed has nobody queueing in it,
     * and the banner about the cycle is what that reader needs.
     */
    let waitingForPerson = 0;
    /**
     * How many work items are waiting for a slot of their team rather than for
     * the plan. Zero with no schedule, for {@link waitingForPerson}'s reason.
     */
    let waitingForCapacity = 0;
    /**
     * The engine's own output, kept: a plan that could not be scheduled leaves
     * this empty and the rows keep their {@link UNSCHEDULED} spans.
     */
    let scheduledSlices: IdentifiedSlice[] = [];
    try {
      // The projection **and** the slices: a row's column shows its own span,
      // and a chart draws the slices the span is a projection of.
      const planned = schedule(rows, edges, slices, notBefore, slotsOf);
      timing = planned.workItems;
      waitingForPerson = planned.waitingForPerson;
      waitingForCapacity = planned.waitingForCapacity;
      // Spread rather than rebuilt field by field, and never put through any
      // arithmetic: the engine's numbers are the answer, and this is the layer
      // that would otherwise quietly round them.
      //
      // Proof: `({ id, ...placed })` mapped through `Math.round` on every
      // number and `reports the engine's fractional numbers verbatim` failed —
      // a slice of 3.6666666666666665 days came back as 4, a whole day of bar
      // against the same plan's Start column; watched 2026-08-09.
      //
      // Proof: `resourcePredecessorId` left out of the entry — the spread
      // replaced by the other twelve fields written out — and `names the slice
      // the person was finishing, under the engine's own id` failed on
      // `undefined`; the hand-off a person link is drawn from would have been
      // absent from the payload with nothing to say it ever existed; watched
      // 2026-08-09.
      scheduledSlices = [...planned.slices].map(([id, placed]) => ({ id, ...placed }));
    } catch (err) {
      // Only the modeled failure. An unqualified catch here turned every
      // exception in this block — a stack overflow on a pathological tree, a
      // future mistake in `slicesOf` — into "your dependencies run in a
      // circle", which is a lie told confidently. R5: unknown is not OK.
      if (!(err instanceof ScheduleCycleError)) throw err;
      scheduleError = 'cycle';
    }
    const waitingFor = new Map<string, string[]>();
    for (const found of edges) {
      waitingFor.set(found.successorId, [
        ...(waitingFor.get(found.successorId) ?? []),
        found.predecessorId,
      ]);
    }
    const workItems = rows
      .map((row) => ({
        ...row,
        number: numbers.get(row.id) ?? '',
        estimates: Object.fromEntries(totals.get(row.id) ?? []),
        // The days recorded against this row: its own if it is a leaf, the sum
        // of its descendants' if it is not — the same fold, one table over.
        //
        // A role nobody has recorded days for is **absent from this object**,
        // and an empty object means nobody has recorded anything on this row.
        // Neither is a zero, and a face that renders a missing key as `0` is
        // saying somebody stated the work took no time. See `actual` in
        // `schema.ts`.
        actuals: Object.fromEntries(recordedTotals.get(row.id) ?? []),
        // Where each role's work on this row has got to: its own if it is a
        // leaf, `agree` across its descendants' if it is not.
        //
        // **A role reading `not_started` is absent from this object**, exactly
        // as an unestimated role is absent from `estimates` — the absence of a
        // statement is how "nobody has said" is spelled everywhere in this tool,
        // including on the wire. So an empty object means nobody has said
        // anything about this row, and a role that is not a key has not been
        // spoken about.
        progress: Object.fromEntries(
          [...(statedTotals.get(row.id) ?? [])].filter(
            (entry): entry is [string, RoleState] => entry[1] !== NOT_STARTED,
          ),
        ),
        // The row's own reading, **derived from its roles and never stored**:
        // `done` when every role with work on it says so, `not_started` when
        // none of them has said anything, and `in_progress` for every
        // disagreement in between — including the one that matters most, one
        // role finished and another silent. `@wbs/domain`'s `agree`.
        state: itemStates.get(row.id) ?? NOT_STARTED,
        // A parent's final figure is its rolled-up totals put through the same
        // method, not the sum of its children's finals. For PERT the two agree
        // (the weighting is linear); for the others they agree too, since each
        // picks one point and the points are summed. Doing it from the totals
        // keeps one path rather than two that happen to match today.
        ...finalsOf(totals.get(row.id) ?? new Map(), project.estimateMethod),
        rolledUp: hasChildren.has(row.id),
        // Only predecessors that are in this project. A stored edge naming a
        // work item from elsewhere — which the schema does not prevent — would
        // otherwise be reported as a dependency on a number nobody can see.
        dependsOn: (waitingFor.get(row.id) ?? []).filter((id) => rows.some((r) => r.id === id)),
        ...phasesOf(assigneesOf.get(row.id) ?? {}),
        schedule: timing.get(row.id) ?? UNSCHEDULED,
        dates: datesOf(
          project.startDate,
          timing.get(row.id) ?? UNSCHEDULED,
          scheduleError !== null,
        ),
      }))
      .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
    return {
      workItems,
      seq,
      scheduleError,
      waitingForPerson,
      waitingForCapacity,
      slices: scheduledSlices,
      // The very array `slicesOf` was handed the ids of, so a slice's `roleId`
      // is a role this list has and its place in the list is the order the
      // engine placed the bars in. Neither is true of a role list fetched
      // separately.
      roles,
      assignedPeople,
      // Built from `slotsOf` rather than read a second time, so the numbers a
      // client renders and the numbers these dates came out of cannot be answers
      // to two different questions. Team-id order, as `listFor` gives, so the
      // array does not reshuffle between two reads of an unchanged plan.
      teamCapacities: [...slotsOf]
        .map(([serviceTeamId, size]) => ({ serviceTeamId, size }))
        .sort((a, b) => a.serviceTeamId.localeCompare(b.serviceTeamId)),
      priorityBands,
      estimateMethod: project.estimateMethod,
      startDate: project.startDate,
      projectRevision: project.revision,
    };
  }

  async create(
    projectId: string,
    actorId: string,
    input: CreateWorkItem,
  ): Promise<WorkItemOutcome<WorkItem>> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };

    const rows = await this.opts.workItems.listByProject(projectId);
    // `rows` is this project only, so a parent that is not among them belongs to
    // another project — or to none. The schema cannot catch it: `parent_id`
    // references `work_item.id` alone, not `(project_id, id)`. Accepting it
    // makes the row unreachable from any root here, and every later read of the
    // project throws instead of rendering.
    if (input.parentId !== null && !rows.some((row) => row.id === input.parentId)) {
      return { ok: false, reason: 'not_found' };
    }
    const placed = placeAfter(this.groupUnder(rows, input.parentId), input.afterId);
    const workItem: WorkItem = {
      id: this.newId(),
      projectId,
      parentId: input.parentId,
      position: placed.position,
      name: input.name ?? '',
      notes: input.notes ?? '',
      frozenNumber: null,
      startNoEarlierThan: null,
      // No floor, so no words about one — the only pair a new row can be in.
      startNoEarlierThanReason: null,
      priority: null,
      serviceTeamId: null,
      // Unlabelled, in the third dimension as in the other two: a new row states
      // nothing and therefore inherits whatever its parent is delivering. The
      // alternative — copying the parent's service down on create — is the
      // stored-versus-effective bug this repo has shipped twice.
      //
      // The **column**, which since task 10.2 is read by the outgoing release
      // alone; the set a reader of this release sees is the absence of any
      // `work_item_service` row, and a create writes none. Both spell the same
      // unlabelled row, which is the whole point of leaving the column standing.
      serviceId: null,
      // One at a time, which is what every work item has always done and what
      // the column's `DEFAULT 1` says for every row that predates it.
      maxParallel: 1,
      // A row that has never been changed since it came into existence. The
      // estimate handoff below is a real second write and leaves a first child
      // at 1 — see {@link NumberedWorkItem.revision}.
      revision: 0,
    };
    await this.opts.workItems.insert(workItem, placed.renumbered);
    // A work item that had an estimate and now has a child no longer holds one:
    // the estimate described the work, and the work is the child now. Moving it
    // down keeps the total identical, which is what makes this safe to do
    // silently — the plan's numbers do not shift under the user.
    const gainsFirstChild =
      input.parentId !== null && !rows.some((row) => row.parentId === input.parentId)
        ? input.parentId
        : null;
    // Read before the move, because afterwards they are the child's. This is
    // the whole before-state an undo of this create has to put back.
    const handedDown =
      gainsFirstChild === null
        ? []
        : (await this.opts.estimates.listByProject(projectId)).filter(
            (each) => each.workItemId === gainsFirstChild,
          );
    // The actuals go down with them, and for a sharper reason than the
    // estimates do. A parent's figures are the sum of its children's, so an
    // actual left behind on a row that has just gained a child is a row no
    // reader can see and no writer can reach — invisible rather than zero, and
    // back on screen the day somebody deletes the child. Read before the move,
    // like the estimates, because afterwards they are the child's.
    const recordedHandedDown =
      gainsFirstChild === null
        ? []
        : (await this.opts.actuals.listByProject(projectId)).filter(
            (each) => each.workItemId === gainsFirstChild,
          );
    // The statements go down with the figures, and the reason is the sharpest of
    // the three. A row that has just gained a child folds its state from below,
    // so a `done` left behind is not merely invisible — it is a claim that
    // reappears the day somebody deletes the child, over work the plan has since
    // moved on from. Read before the move, like the other two.
    const statedHandedDown =
      gainsFirstChild === null
        ? []
        : (await this.opts.progress.listByProject(projectId)).filter(
            (each) => each.workItemId === gainsFirstChild,
          );
    if (gainsFirstChild !== null) {
      await this.opts.estimates.moveAll(gainsFirstChild, workItem.id);
      await this.opts.actuals.moveAll(gainsFirstChild, workItem.id);
      await this.opts.progress.moveAll(gainsFirstChild, workItem.id);
    }
    await this.announceTree(projectId);
    await this.record(projectId, actorId, 'create', `add ${quoteName(workItem.name)}`, {
      forward: {
        do: 'restore_subtree',
        rows: [workItem],
        rootPosition: workItem.position,
        reparented: [],
        estimates: handedDown.map((each) => ({ ...each, workItemId: workItem.id })),
        actuals: recordedHandedDown.map((each) => ({ ...each, workItemId: workItem.id })),
        progress: statedHandedDown.map((each) => ({ ...each, workItemId: workItem.id })),
        assignments: [],
        internalDependencies: [],
        externalDependencies: [],
        removedEstimates: handedDown.map((each) => ({
          workItemId: each.workItemId,
          roleId: each.roleId,
        })),
        removedActuals: recordedHandedDown.map((each) => ({
          workItemId: each.workItemId,
          roleId: each.roleId,
        })),
        removedProgress: statedHandedDown.map((each) => ({
          workItemId: each.workItemId,
          roleId: each.roleId,
        })),
      },
      inverse: {
        do: 'delete_subtree',
        rootId: workItem.id,
        // Exactly this row and nothing else. A work item somebody has since
        // built under is not one this undo may take away, and its own revision
        // would not say so — a child is a row of its own.
        expectedSubtree: [workItem.id],
        remove: [workItem.id],
        reparented: [],
        setEstimates: handedDown,
        // Back to the row they came from, exactly as they were. Re-applying
        // this create's own undo is what runs it.
        setActuals: recordedHandedDown,
        // And the statements, back on the row they came from. Undoing this
        // create makes the parent a leaf again, and a leaf reports what it
        // holds — including whether its work is finished.
        setProgress: statedHandedDown,
      },
      touched: gainsFirstChild === null ? [workItem.id] : [workItem.id, gainsFirstChild],
      before: rows,
    });
    return { ok: true, result: workItem };
  }

  async patch(
    id: string,
    actorId: string,
    patch: WorkItemPatch,
  ): Promise<WorkItemOutcome<WorkItem>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    // The row as the **plan read** gave it, not as `findById` did: the tag set
    // has no column behind it, so it exists only here. Falling back to the bare
    // row with an empty set would make the inverse of a tag patch "take every
    // tag off" for a row that had some — an undo that loses exactly the data
    // this field's whole design is about — so a row the plan read cannot see is
    // `not_found` instead, which is what it is.
    const before = context.result.rows.find((row) => row.id === id);
    if (before === undefined) return { ok: false, reason: 'not_found' };
    // A row with children has no slices of its own — `slicesOf` skips it — so a
    // parallelism stored there would be a number on screen that decides
    // nothing. Refused rather than accepted-and-ignored, which is the same
    // refusal `setEstimate` makes about the same shape of row, decided against
    // the same read.
    //
    // A leaf that *later* gains a child keeps whatever it was given: the write
    // was legal when it was made, and rewriting it now would be this change
    // editing a row nobody asked it to.
    //
    // Proof: this check deleted and `refuses a parallelism on a row that has
    // children` failed on `Expected: 400, Received: 200` — the parent took the
    // write and came back carrying a number no slice of that plan reads;
    // watched 2026-08-12.
    if (patch.maxParallel !== undefined && context.result.rows.some((row) => row.parentId === id)) {
      return { ok: false, reason: 'has_children' };
    }
    const written = await this.opts.workItems.patch(id, patch);
    if (!written.ok) return { ok: false, reason: written.reason };
    const updated = written.workItem;
    await this.announceWorkItem(updated.projectId, id);
    // A patch naming no field wrote nothing — the store returns the row it
    // found — so there is nothing to reverse. Journalling it would put an
    // entry on the stack whose undo is visibly a no-op.
    if (fieldsOf(patch).length > 0) {
      await this.record(
        updated.projectId,
        actorId,
        'patch',
        patch.name === undefined
          ? `edit ${quoteName(updated.name)}`
          : `rename ${quoteName(updated.name)}`,
        {
          forward: { do: 'patch', workItemId: id, patch },
          inverse: { do: 'patch', workItemId: id, patch: revertTo(before, patch) },
          touched: [id],
          before: context.result.rows,
        },
      );
    }
    return { ok: true, result: updated };
  }

  /**
   * Sets, replaces or clears who does one work item's work for one role.
   *
   * The person is deliberately **not** checked against the work item's
   * `serviceTeamId`: Dany's call, 2026-08-06 — "keep people and service/team
   * lists decoupled for the work item". A team labels the work, a person does
   * it, and a platform engineer picking up a piece of billing work is an
   * ordinary Tuesday rather than a mistake to refuse.
   */
  async assign(
    id: string,
    actorId: string,
    roleId: string,
    personId: string | null,
  ): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem } = context.result;
    if (!(await this.holdsRole(workItem.projectId, roleId)))
      return { ok: false, reason: 'unknown_role' };
    const before =
      (await this.opts.directory.assignmentsOf([id])).find((each) => each.roleId === roleId)
        ?.personId ?? null;
    const assigned = await this.writeNamingRole(workItem.projectId, roleId, () =>
      this.opts.directory.assign(id, roleId, personId),
    );
    if (assigned === null) return { ok: false, reason: 'unknown_role' };
    if (!assigned.ok) return { ok: false, reason: assigned.reason };
    await this.announceWorkItem(workItem.projectId, id);
    await this.record(
      workItem.projectId,
      actorId,
      personId === null ? 'unassign' : 'assign',
      personId === null
        ? `clear who does ${quoteName(workItem.name)}`
        : `assign ${quoteName(workItem.name)}`,
      {
        forward: { do: 'assign', workItemId: id, roleId, personId },
        inverse: { do: 'assign', workItemId: id, roleId, personId: before },
        touched: [id],
        before: context.result.rows,
      },
    );
    return { ok: true, result: null };
  }

  async move(id: string, actorId: string, input: MoveWorkItem): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem, rows } = context.result;

    // A frozen number has left the tool — it is in someone's ticket. Moving the
    // row would either break that reference or quietly stop it meaning what it
    // said, so the freeze has to be lifted deliberately first.
    if (workItem.frozenNumber !== null) return { ok: false, reason: 'frozen' };

    // Same reason as in `create`: a parent outside this project detaches the row
    // from every root here.
    if (input.parentId !== null && !rows.some((row) => row.id === input.parentId)) {
      return { ok: false, reason: 'not_found' };
    }

    // Moving a work item beneath itself detaches its whole subtree from every
    // root: the rows survive, no number can be derived for them, and the project
    // reads as though the work vanished.
    if (input.parentId !== null && descendsFrom(rows, input.parentId, id)) {
      return { ok: false, reason: 'cycle' };
    }

    // Where it was, read before it leaves: the sibling it sat directly after,
    // or null when it was first. That is the shape `move` takes, so the
    // inverse is the same command with the arguments it had before.
    const wasAfter = this.groupUnder(rows, workItem.parentId)
      .filter((sibling) => sibling.id !== id && sibling.position < workItem.position)
      .sort((a, b) => a.position - b.position)
      .at(-1);

    const group = this.groupUnder(rows, input.parentId).filter((sibling) => sibling.id !== id);
    const placed = placeAfter(group, input.afterId);
    await this.opts.workItems.move(id, input.parentId, placed.position, placed.renumbered);
    await this.announceTree(workItem.projectId);
    await this.record(workItem.projectId, actorId, 'move', `move ${quoteName(workItem.name)}`, {
      forward: { do: 'move', workItemId: id, parentId: input.parentId, afterId: input.afterId },
      inverse: {
        do: 'move',
        workItemId: id,
        parentId: workItem.parentId,
        afterId: wasAfter?.id ?? null,
      },
      touched: [id],
      before: rows,
    });
    return { ok: true, result: null };
  }

  /**
   * Copies a work item and everything beneath it, as the next sibling of the
   * original.
   *
   * One write, on the server, because the alternative is the client replaying
   * a create and a patch per row: every intermediate state published to
   * everybody watching, a refetch each time, and copied dependencies still
   * pointing at the originals.
   *
   * What the copy carries, and what it deliberately does not, is in
   * `openspec/changes/duplicate-subtree/specs/wbs-domain/spec.md`. Two of
   * those rules are load-bearing enough to repeat here:
   *
   * - **No frozen numbers.** A frozen number is an identity that has left the
   *   tool — it is in somebody's ticket, which is why {@link move} refuses a
   *   frozen row. Two rows answering one ticket is the failure freezing
   *   exists to prevent. The original is untouched, so a frozen work item can
   *   still be duplicated: copying is not moving.
   * - **Only internal dependencies.** An edge with one end outside the
   *   subtree is left behind, so the copy schedules against its own work
   *   rather than inheriting wiring nobody asked it to have.
   *
   * Refuses `too_large` past {@link MAX_DUPLICATED_ROWS}, having written
   * nothing.
   */
  async duplicate(id: string, actorId: string): Promise<WorkItemOutcome<{ id: string }>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem, rows } = context.result;

    // Ancestors-first, which is the order the copies have to be written in:
    // `parent_id` references a row that must already be there.
    const originals = subtreeOf(rows, id);
    if (originals.length > MAX_DUPLICATED_ROWS) return { ok: false, reason: 'too_large' };

    const newIds = new Map(originals.map((originalId) => [originalId, this.newId()]));
    /**
     * The copy of one original. Throws rather than defaulting: an id that was
     * not copied means the map and the subtree disagree, and carrying the
     * original's id through would wire the copy to the row it was copied from.
     */
    const copyOf = (originalId: string): string => {
      const copied = newIds.get(originalId);
      if (copied === undefined) throw new Error(`no copy was generated for ${originalId}`);
      return copied;
    };
    /**
     * A descendant's parent, which is always another row of the same subtree.
     * A null here would mean `subtreeOf` returned a second root.
     */
    const parentInside = (source: WorkItem): string => {
      if (source.parentId === null)
        throw new Error(`${source.id} is below the root but parentless`);
      return source.parentId;
    };
    const sourceOf = new Map(rows.map((row) => [row.id, row]));
    const inside = new Set(originals);

    const placed = placeAfter(this.groupUnder(rows, workItem.parentId), id);
    const copies = originals.map((originalId, index) => {
      const source = sourceOf.get(originalId);
      if (source === undefined) throw new Error(`${originalId} is not a row of this project`);
      const isRoot = index === 0;
      return {
        ...source,
        id: copyOf(originalId),
        // The root keeps the original's parent — it is its sibling. Everything
        // below hangs off the copy of its own parent, never the original's.
        parentId: isRoot ? source.parentId : copyOf(parentInside(source)),
        // Descendants keep their positions: their whole sibling group is
        // copied with them, so the order survives and stays distinct.
        position: isRoot ? placed.position : source.position,
        // Only the root is renamed. Its children are already told apart by the
        // parent above them, and suffixing every one of them would rewrite a
        // branch nobody asked to rename.
        name: isRoot ? `${source.name}${COPY_SUFFIX}` : source.name,
        frozenNumber: null,
        // Not the original's count. A copy is a new row that has never been
        // changed, and carrying the original's revision across would have a
        // reader's precondition on one row pass against the other.
        revision: 0,
      };
    });

    const stored = await this.opts.estimates.listByProject(workItem.projectId);
    const assigned = await this.opts.directory.assignmentsOf(originals);
    const edges = await this.opts.dependencies.listByProject(workItem.projectId);

    const copiedEstimates = stored
      .filter((each) => inside.has(each.workItemId))
      .map((each) => ({ ...each, workItemId: copyOf(each.workItemId) }));
    const copiedAssignments = assigned.map((each) => ({
      ...each,
      workItemId: copyOf(each.workItemId),
    }));
    const copiedEdges = edges
      .filter((edge) => inside.has(edge.predecessorId) && inside.has(edge.successorId))
      .map((edge) => ({
        id: this.newId(),
        projectId: edge.projectId,
        predecessorId: copyOf(edge.predecessorId),
        successorId: copyOf(edge.successorId),
      }));

    await this.opts.subtrees.insertSubtree({
      rows: copies,
      respaced: placed.renumbered,
      reparented: [],
      estimates: copiedEstimates,
      // **Deliberately empty.** A duplicate is work that has not been done:
      // copying the original's actuals would tell the plan a fortnight nobody
      // has worked was already spent, and the copy would appear with a variance
      // as though it were finished. Estimates copy because an estimate
      // describes work; actuals do not because an actual records a week. See
      // `openspec/changes/actual-days/design.md` D5.
      actuals: [],
      // **Deliberately empty, and for a stronger reason than the actuals.** A
      // copied `done` would hand the plan a branch that reports itself finished
      // the moment it appears — work nobody has started, drawn as work nobody
      // needs to do. See `design.md` P4.
      progress: [],
      assignments: copiedAssignments,
      dependencies: copiedEdges,
      removedEstimates: [],
      removedActuals: [],
      removedProgress: [],
    });
    // Once, at the end. The copy renumbers rows it never touched — every later
    // sibling of the original, at every level — so it is the whole tree rather
    // than the rows that were written.
    await this.announceTree(workItem.projectId);
    const copyIds = copies.map((copy) => copy.id);
    await this.record(
      workItem.projectId,
      actorId,
      'duplicate',
      `duplicate ${quoteName(workItem.name)}`,
      {
        forward: {
          do: 'restore_subtree',
          rows: copies,
          rootPosition: placed.position,
          reparented: [],
          estimates: copiedEstimates,
          // Empty for the write's reason above: a redo of a duplication puts
          // back the copy that was made, and no days were ever recorded on it.
          actuals: [],
          // Empty for the write's reason above: a redo of a duplication puts
          // back the copy that was made, and nobody ever said a word about it.
          progress: [],
          assignments: copiedAssignments,
          internalDependencies: copiedEdges,
          externalDependencies: [],
          removedEstimates: [],
          removedActuals: [],
          removedProgress: [],
        },
        inverse: {
          do: 'delete_subtree',
          rootId: copyOf(id),
          expectedSubtree: copyIds,
          remove: copyIds,
          reparented: [],
          setEstimates: [],
          setActuals: [],
          setProgress: [],
        },
        // Every copied row, all of them at 0. Anything typed into the copy
        // moves one of these and the undo refuses rather than throwing away
        // work somebody did in it.
        touched: copyIds,
        before: rows,
      },
    );
    return { ok: true, result: { id: copyOf(id) } };
  }

  async remove(
    id: string,
    actorId: string,
    strategy: DeleteStrategy | null,
  ): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem, rows } = context.result;

    const children = rows
      .filter((row) => row.parentId === id)
      .sort((a, b) => a.position - b.position);
    // A parent carries work below it that the caller may not have on screen, so
    // which of the two things they meant is theirs to say.
    if (children.length > 0 && strategy === null) return { ok: false, reason: 'strategy_required' };

    const label = `delete ${quoteName(workItem.name)}`;
    const storedEstimates = await this.opts.estimates.listByProject(workItem.projectId);
    // Read before anything is deleted, exactly like the estimates and the
    // assignments: `actual.work_item_id` cascades, so a moment later there is
    // nothing left to read and the restore would put the branch back with the
    // days nobody recorded again.
    const storedActuals = await this.opts.actuals.listByProject(workItem.projectId);
    // Read before anything is deleted, for the actuals' reason:
    // `role_progress.work_item_id` cascades, so a moment later there is nothing
    // left to read and the restore would put the branch back reading as work
    // nobody had started.
    const storedProgress = await this.opts.progress.listByProject(workItem.projectId);
    const allEdges = await this.opts.dependencies.listByProject(workItem.projectId);

    if (children.length === 0 || strategy === 'cascade') {
      // The mirror of the rule in `create`: a parent losing its last child takes
      // the estimates back, so the work is still described somewhere.
      //
      // The totals rather than the rows. `moveAll` alone was wrong whenever the
      // deleted child was itself a parent: its figures live on its descendants,
      // it holds no estimate rows of its own, so nothing moved and the whole
      // subtree's estimates were then deleted with it.
      const parentId = workItem.parentId;
      const doomed = subtreeOf(rows, id);
      const inside = new Set(doomed);
      const handedUp: StoredEstimate[] = [];
      // The same rule, one table over: the parent is about to become a leaf
      // again, and a leaf reports what it holds. Without this the days the
      // branch recorded are simply gone the moment its last child is deleted —
      // the estimates would survive on the parent and the actuals beside them
      // would not, which is the drift this whole change is written not to have.
      //
      // The **totals**, not the rows, for the reason the estimates' comment
      // above gives: a deleted child that is itself a parent holds no rows of
      // its own, so moving rows would move nothing and the branch's figures
      // would go with it.
      //
      // `recordedAt` is the newest stamp in the branch — the parent's number is
      // now the whole branch's, and the day it was last added to is the honest
      // answer to "when was this recorded".
      const recordedHandedUp: StoredActual[] = [];
      // And the statements, folded rather than moved — the same argument the two
      // figures make, in the tense this change is about. The parent is becoming a
      // leaf, and a leaf that has just absorbed a finished branch's work reads as
      // not started unless the statement comes up with it.
      //
      // The **fold**, not the rows: a deleted child that is itself a parent holds
      // no rows of its own, so moving rows would move nothing and the branch's
      // reading would go with it. `not_started` is skipped rather than written,
      // because the absence of a row is how it is spelled everywhere.
      //
      // `statedAt` is the newest stamp in the branch, for `recordedAt`'s reason:
      // the parent's reading is now the whole branch's, and the day it was last
      // spoken about is the honest answer to "when was this said".
      const statedHandedUp: StoredProgress[] = [];
      if (parentId !== null && rows.filter((row) => row.parentId === parentId).length === 1) {
        const totals = rollUp(rows, storedEstimates);
        for (const [roleId, days] of totals.get(id) ?? []) {
          handedUp.push({ workItemId: parentId, roleId, ...days });
        }
        const recordedInside = storedActuals.filter((each) => inside.has(each.workItemId));
        for (const [roleId, days] of rollUpActuals(rows, storedActuals).get(id) ?? []) {
          const latest = recordedInside
            .filter((each) => each.roleId === roleId)
            .reduce((newest, each) => Math.max(newest, each.recordedAt), 0);
          recordedHandedUp.push({ workItemId: parentId, roleId, days, recordedAt: latest });
        }
        const statedInside = storedProgress.filter((each) => inside.has(each.workItemId));
        const branchStates = rollUpProgress(
          rows,
          storedProgress,
          workedRolesOf(storedEstimates, storedActuals, storedProgress),
        ).get(id);
        for (const [roleId, state] of branchStates ?? []) {
          if (state === NOT_STARTED) continue;
          const latest = statedInside
            .filter((each) => each.roleId === roleId)
            .reduce((newest, each) => Math.max(newest, each.statedAt), 0);
          statedHandedUp.push({ workItemId: parentId, roleId, state, statedAt: latest });
        }
      }
      for (const each of handedUp) await this.opts.estimates.set(each);
      for (const each of recordedHandedUp) await this.opts.actuals.set(each);
      for (const each of statedHandedUp) await this.opts.progress.set(each);
      const cut = allEdges.filter(
        (edge) => inside.has(edge.predecessorId) || inside.has(edge.successorId),
      );
      // Read before the delete, not after. `assignment.work_item_id` cascades,
      // so a moment later there is nothing left to read and the restore would
      // put the branch back with nobody on it.
      const doomedAssignments = await this.opts.directory.assignmentsOf(doomed);
      // Edges first, and every one touching anything in the subtree. The
      // foreign keys refuse a delete that would orphan one, so this is not
      // tidiness: without it, deleting a work item anything depends on fails
      // with a constraint error the caller cannot act on.
      for (const gone of doomed) await this.opts.dependencies.removeAllFor(gone);
      await this.opts.workItems.remove(doomed, []);
      await this.announceTree(workItem.projectId);
      await this.record(workItem.projectId, actorId, 'delete', label, {
        forward: {
          do: 'delete_subtree',
          rootId: id,
          expectedSubtree: doomed,
          remove: doomed,
          reparented: [],
          setEstimates: handedUp,
          setActuals: recordedHandedUp,
          setProgress: statedHandedUp,
        },
        inverse: {
          do: 'restore_subtree',
          rows: doomed.map((each) => rowOf(rows, each)),
          rootPosition: workItem.position,
          reparented: [],
          estimates: storedEstimates.filter((each) => inside.has(each.workItemId)),
          // Every day recorded anywhere in the branch, put back where it was
          // recorded. Without this an undo of a delete answers `ok` and returns
          // the branch with its estimates and none of its actuals — the plan
          // looks whole and a week of somebody's record is gone.
          actuals: storedActuals.filter((each) => inside.has(each.workItemId)),
          // Every statement made anywhere in the branch, put back where it was
          // made. Without this an undo of a delete answers `ok` and returns the
          // branch reading as work nobody has started — the plan looks whole and
          // a fortnight of finished work is unfinished again.
          progress: storedProgress.filter((each) => inside.has(each.workItemId)),
          assignments: doomedAssignments,
          internalDependencies: cut.filter(
            (edge) => inside.has(edge.predecessorId) && inside.has(edge.successorId),
          ),
          externalDependencies: cut.filter(
            (edge) => !inside.has(edge.predecessorId) || !inside.has(edge.successorId),
          ),
          removedEstimates: handedUp.map((each) => ({
            workItemId: each.workItemId,
            roleId: each.roleId,
          })),
          removedActuals: recordedHandedUp.map((each) => ({
            workItemId: each.workItemId,
            roleId: each.roleId,
          })),
          removedProgress: statedHandedUp.map((each) => ({
            workItemId: each.workItemId,
            roleId: each.roleId,
          })),
        },
        // Two deliberate absences. The deleted rows are not here — nothing can
        // hold a revision of a row that is gone, and the restore's refusal to
        // write over an id that exists is what guards them. Neither are the
        // surviving ends of the edges that left with the branch: those edges
        // are best-effort by design, and refusing to put a whole branch back
        // because somebody renamed a neighbour would strand the work for a
        // reason that has nothing to do with it.
        touched: handedUp.map((each) => each.workItemId),
        before: rows,
      });
      return { ok: true, result: null };
    }

    const formerGroup = rows
      .filter((row) => row.parentId === workItem.parentId)
      .sort((a, b) => a.position - b.position);
    const promoted: Reparented[] = formerGroup
      .flatMap((sibling) => (sibling.id === id ? children : [sibling]))
      .map((sibling, i) => ({
        id: sibling.id,
        parentId: workItem.parentId,
        position: (i + 1) * POSITION_STEP,
      }));
    const cut = allEdges.filter((edge) => edge.predecessorId === id || edge.successorId === id);
    // Read before the delete: the assignment rows cascade with the work item.
    const deletedAssignments = await this.opts.directory.assignmentsOf([id]);
    // The same reason as the cascade branch above: an edge to a row that is
    // going has nothing to point at, and the foreign keys say so. Only this row
    // leaves here — its children are promoted, and their edges stay valid.
    await this.opts.dependencies.removeAllFor(id);
    await this.opts.workItems.remove([id], promoted);
    await this.announceTree(workItem.projectId);
    await this.record(workItem.projectId, actorId, 'delete', label, {
      forward: {
        do: 'delete_subtree',
        rootId: id,
        expectedSubtree: subtreeOf(rows, id),
        remove: [id],
        reparented: promoted,
        setEstimates: [],
        // A promotion deletes one row and keeps its children, so the parent
        // below is not becoming a leaf and nothing is handed anywhere.
        setActuals: [],
        setProgress: [],
      },
      inverse: {
        do: 'restore_subtree',
        rows: [workItem],
        rootPosition: workItem.position,
        // Everyone the promotion rewrote, back where they were: the children
        // under the row coming back, and the former siblings at the positions
        // the promotion took from them. Restoring only the children would
        // leave the group respaced around a gap that is no longer there.
        reparented: promoted.map((each) => {
          const was = rowOf(rows, each.id);
          return { id: was.id, parentId: was.parentId, position: was.position };
        }),
        estimates: storedEstimates.filter((each) => each.workItemId === id),
        // The promoted row's own recorded days — it had children, so it holds
        // none, and this is the empty list every time until a promotion of a
        // leaf becomes representable. Written from the same source as the
        // estimates beside it rather than hard-coded, so it stays true if that
        // ever changes.
        actuals: storedActuals.filter((each) => each.workItemId === id),
        // The promoted row's own statements — it had children, so it holds none,
        // and this is the empty list every time until a promotion of a leaf
        // becomes representable. Written from the same source as the two figures
        // beside it rather than hard-coded, so it stays true if that ever changes.
        progress: storedProgress.filter((each) => each.workItemId === id),
        assignments: deletedAssignments,
        internalDependencies: [],
        externalDependencies: cut,
        removedEstimates: [],
        removedActuals: [],
        removedProgress: [],
      },
      // The promoted rows are preconditions because putting them back under the
      // restored parent is part of the undo. The ends of the edges that left
      // are not, for the reason given in the cascade branch above.
      touched: promoted.map((each) => each.id),
      before: rows,
    });
    return { ok: true, result: null };
  }

  /**
   * Writes the currently derived number of every work item that has none stored.
   *
   * Work items added afterwards keep deriving, so a project can be frozen,
   * planned into further, and frozen again — each freeze pinning only what was
   * unpinned at the time. Numbers already stored are not rewritten, which is the
   * whole point: they are what left the tool.
   */
  async freeze(projectId: string, actorId: string): Promise<WorkItemOutcome<null>> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };

    const rows = await this.opts.workItems.listByProject(projectId);
    const numbers = deriveNumbers(rows);
    const updates = rows
      .filter((row) => row.frozenNumber === null)
      .map((row) => ({ id: row.id, frozenNumber: numbers.get(row.id) ?? null }));
    await this.opts.workItems.setFrozenNumbers(updates);
    await this.announceTree(projectId);
    // A freeze that pinned nothing — every number was already written down —
    // is not a change to reverse.
    if (updates.length > 0) {
      await this.record(projectId, actorId, 'freeze', 'freeze the numbers', {
        forward: { do: 'set_frozen', updates },
        inverse: {
          do: 'set_frozen',
          updates: updates.map((each) => ({ id: each.id, frozenNumber: null })),
        },
        touched: updates.map((each) => each.id),
        before: rows,
      });
    }
    return { ok: true, result: null };
  }

  /** Returns one work item to deriving, which is what lets it move again. */
  async unfreeze(id: string, actorId: string): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem } = context.result;
    await this.opts.workItems.setFrozenNumbers([{ id, frozenNumber: null }]);
    await this.announceTree(workItem.projectId);
    await this.record(
      workItem.projectId,
      actorId,
      'unfreeze',
      `unfreeze ${quoteName(workItem.name)}`,
      {
        forward: { do: 'set_frozen', updates: [{ id, frozenNumber: null }] },
        inverse: {
          do: 'set_frozen',
          updates: [{ id, frozenNumber: workItem.frozenNumber }],
        },
        touched: [id],
        before: context.result.rows,
      },
    );
    return { ok: true, result: null };
  }

  async unfreezeProject(projectId: string, actorId: string): Promise<WorkItemOutcome<null>> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };

    const rows = await this.opts.workItems.listByProject(projectId);
    const frozen = rows.filter((row) => row.frozenNumber !== null);
    await this.opts.workItems.setFrozenNumbers(
      frozen.map((row) => ({
        id: row.id,
        frozenNumber: null,
        startNoEarlierThan: null,
        serviceTeamId: null,
      })),
    );
    await this.announceTree(projectId);
    if (frozen.length > 0) {
      await this.record(projectId, actorId, 'unfreeze', 'unfreeze the whole plan', {
        forward: {
          do: 'set_frozen',
          updates: frozen.map((row) => ({ id: row.id, frozenNumber: null })),
        },
        inverse: {
          do: 'set_frozen',
          updates: frozen.map((row) => ({ id: row.id, frozenNumber: row.frozenNumber })),
        },
        touched: frozen.map((row) => row.id),
        before: rows,
      });
    }
    return { ok: true, result: null };
  }

  /**
   * Writes one work item's estimate for one role.
   *
   * Refused for a work item that has children: its figures are the sum of what
   * is below it, and a stored estimate there would either be ignored or
   * double-counted. Neither is visible to whoever typed it.
   */
  async setEstimate(
    id: string,
    actorId: string,
    roleId: string,
    days: Days,
  ): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { rows, workItem } = context.result;
    if (rows.some((row) => row.parentId === id)) return { ok: false, reason: 'rolled_up' };
    if (!(await this.holdsRole(workItem.projectId, roleId)))
      return { ok: false, reason: 'unknown_role' };
    const before = await this.storedTrio(workItem.projectId, id, roleId);
    const written = await this.writeNamingRole(workItem.projectId, roleId, () =>
      this.opts.estimates.set({ workItemId: id, roleId, ...days }),
    );
    if (written === null) return { ok: false, reason: 'unknown_role' };
    await this.announceWorkItem(workItem.projectId, id);
    await this.record(
      workItem.projectId,
      actorId,
      'estimate',
      `estimate ${quoteName(workItem.name)}`,
      {
        forward: { do: 'set_estimate', workItemId: id, roleId, days },
        inverse:
          before === null
            ? { do: 'clear_estimate', workItemId: id, roleId }
            : { do: 'set_estimate', workItemId: id, roleId, days: before },
        touched: [id],
        before: context.result.rows,
      },
    );
    return { ok: true, result: null };
  }

  /**
   * Takes one work item's estimate for one role back off.
   *
   * Idempotent: clearing a trio that is not stored is the state the caller
   * asked for, so it succeeds rather than reporting a 404 for an estimate.
   * A missing *work item* is still `not_found` — that is a different absence,
   * and the same one `removeDependency` reports.
   *
   * No roll-up work is needed: a parent's figures are summed on read, never
   * stored, so the announce below carries the recomputed ancestors with it.
   * Not refused for a rolled-up work item either — one cannot hold a stored
   * estimate to begin with, so the call is already a no-op there, and refusing
   * it would make "clear what is not there" an error in exactly one place.
   *
   * Proof: dropping the `estimates.remove` call fails four tests across
   * `estimate.test.ts` and `work-item.controller.test.ts`, including the
   * parent roll-up one; dropping the announce fails `tells the project's
   * subscribers, with the ancestors whose totals moved` alone. Both watched
   * 2026-08-06 — see `openspec/changes/clear-estimate/verify.md`.
   */
  async clearEstimate(id: string, actorId: string, roleId: string): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem } = context.result;
    const before = await this.storedTrio(workItem.projectId, id, roleId);
    await this.opts.estimates.remove(id, roleId);
    await this.announceWorkItem(workItem.projectId, id);
    // Clearing a trio that was not there changed nothing — the call is
    // idempotent by design — so there is nothing to put back.
    if (before !== null) {
      await this.record(
        workItem.projectId,
        actorId,
        'clear_estimate',
        `clear the estimate on ${quoteName(workItem.name)}`,
        {
          forward: { do: 'clear_estimate', workItemId: id, roleId },
          inverse: { do: 'set_estimate', workItemId: id, roleId, days: before },
          touched: [id],
          before: context.result.rows,
        },
      );
    }
    return { ok: true, result: null };
  }

  /**
   * Writes the days one role actually spent on one work item.
   *
   * Guarded exactly as {@link WorkItemService.setEstimate} is, and the two
   * refusals are the same two for the same reasons: a row with children is
   * `rolled_up`, because its figures are the sum of what is below it and a
   * stored number there would be ignored or double-counted; a `roleId` this
   * project does not hold is `unknown_role`.
   *
   * **Nothing about this reaches the schedule.** The engine's input map is built
   * from estimates in `slicesOf` and this number is not in it, so recording an
   * actual moves no date, no bar and no critical path. That is not a saving, it
   * is the only honest reading available: the model has no completion state, so
   * it cannot tell "took 8 days, finished" from "8 days so far", and the two
   * mean opposite things for every successor. See `design.md` D3.
   *
   * Journalled through the same {@link WorkItemService.record} seam as every
   * other command, which is what makes it undoable and what puts it in the
   * plan's history without a second write path — the ordering H1 called
   * non-negotiable.
   */
  async setActual(
    id: string,
    actorId: string,
    roleId: string,
    days: number,
  ): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { rows, workItem } = context.result;
    if (rows.some((row) => row.parentId === id)) return { ok: false, reason: 'rolled_up' };
    if (!(await this.holdsRole(workItem.projectId, roleId)))
      return { ok: false, reason: 'unknown_role' };
    const before = await this.storedActual(workItem.projectId, id, roleId);
    const written = await this.writeNamingRole(workItem.projectId, roleId, () =>
      this.opts.actuals.set({ workItemId: id, roleId, days, recordedAt: this.now() }),
    );
    if (written === null) return { ok: false, reason: 'unknown_role' };
    await this.announceWorkItem(workItem.projectId, id);
    await this.record(
      workItem.projectId,
      actorId,
      'actual',
      `record days on ${quoteName(workItem.name)}`,
      {
        forward: { do: 'set_actual', workItemId: id, roleId, days },
        // The number that was there, or its absence. A `clear_actual` inverse
        // is what makes undoing the first recording take the row away rather
        // than write a zero — the one thing this table must never hold as a
        // stand-in for "nobody said".
        inverse:
          before === null
            ? { do: 'clear_actual', workItemId: id, roleId }
            : { do: 'set_actual', workItemId: id, roleId, days: before },
        touched: [id],
        before: context.result.rows,
      },
    );
    return { ok: true, result: null };
  }

  /**
   * Takes the recorded days back off one work item for one role.
   *
   * Idempotent, and not refused on a rolled-up row, for exactly the reasons
   * {@link WorkItemService.clearEstimate} gives: clearing what is not stored is
   * the state the caller asked for, and a parent cannot hold a row to begin
   * with, so refusing there would make "clear what is not there" an error in
   * one place and a success everywhere else. A missing **work item** is still
   * `not_found`.
   */
  async clearActual(id: string, actorId: string, roleId: string): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem } = context.result;
    const before = await this.storedActual(workItem.projectId, id, roleId);
    await this.opts.actuals.remove(id, roleId);
    await this.announceWorkItem(workItem.projectId, id);
    // Nothing was stored, so nothing changed and there is nothing to put back —
    // the same skip `clearEstimate` makes, and the reason a plan does not gain
    // a history row every time somebody empties an empty box.
    if (before !== null) {
      await this.record(
        workItem.projectId,
        actorId,
        'clear_actual',
        `clear the recorded days on ${quoteName(workItem.name)}`,
        {
          forward: { do: 'clear_actual', workItemId: id, roleId },
          inverse: { do: 'set_actual', workItemId: id, roleId, days: before },
          touched: [id],
          before: context.result.rows,
        },
      );
    }
    return { ok: true, result: null };
  }

  /**
   * States where one role's work on one work item has got to.
   *
   * Guarded exactly as {@link WorkItemService.setActual} is, and the two
   * refusals are the same two for the same reasons: a row with children is
   * `rolled_up`, because its reading is folded from what is below it and a
   * stored state there would be ignored by every reader; a `roleId` this project
   * does not hold is `unknown_role`.
   *
   * **Nothing about this reaches the schedule.** Recording that a role is done
   * moves no date, no bar and no critical path — `service/schedule.ts` has an
   * empty diff in the change that adds this. What it buys is that the number
   * beside it becomes readable: 8 days spent against 5 estimated, **finished**,
   * is a variance somebody can act on, and 8 days spent against 5 estimated,
   * still running, is a different sentence about the same two numbers.
   *
   * **What `done` makes true, and it is a rule rather than a note:** an actual on
   * a role marked done is **final** — the whole of what that role spent, not a
   * running count. The change that lets the engine consume this reads exactly
   * that (finished roles freeze; in-progress roles get
   * `remaining = max(0, estimate − actual)`), and it must not have to
   * re-litigate the meaning of rows this method wrote.
   *
   * Journalled through the same {@link WorkItemService.record} seam as every
   * other command, which is what makes it undoable and what puts it in the
   * plan's history without a second write path.
   */
  async setProgress(
    id: string,
    actorId: string,
    roleId: string,
    state: RoleState,
  ): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { rows, workItem } = context.result;
    if (rows.some((row) => row.parentId === id)) return { ok: false, reason: 'rolled_up' };
    if (!(await this.holdsRole(workItem.projectId, roleId)))
      return { ok: false, reason: 'unknown_role' };
    const before = await this.storedProgress(workItem.projectId, id, roleId);
    const written = await this.writeNamingRole(workItem.projectId, roleId, () =>
      this.opts.progress.set({ workItemId: id, roleId, state, statedAt: this.now() }),
    );
    if (written === null) return { ok: false, reason: 'unknown_role' };
    await this.announceWorkItem(workItem.projectId, id);
    await this.record(
      workItem.projectId,
      actorId,
      'progress',
      `${state === 'done' ? 'finish' : 'start'} work on ${quoteName(workItem.name)}`,
      {
        forward: { do: 'set_progress', workItemId: id, roleId, state },
        // What was said before, or that nothing was. A `clear_progress` inverse
        // is what makes undoing the first statement take the row away rather
        // than write a `not_started` — the one value this table must never hold,
        // because it is the absence of a row everywhere else.
        inverse:
          before === null
            ? { do: 'clear_progress', workItemId: id, roleId }
            : { do: 'set_progress', workItemId: id, roleId, state: before },
        touched: [id],
        before: context.result.rows,
      },
    );
    return { ok: true, result: null };
  }

  /**
   * Takes the statement back, leaving the role reading as not started.
   *
   * Idempotent, and not refused on a rolled-up row, for exactly the reasons
   * {@link WorkItemService.clearActual} gives: clearing what is not stored is
   * the state the caller asked for, and a parent cannot hold a row to begin
   * with. A missing **work item** is still `not_found`.
   *
   * Worth saying plainly, because it is the one place this table can lose
   * information a reader was relying on: clearing a `done` does not say the work
   * was undone, it says nobody has spoken about it. Those are different
   * sentences and this is the second one.
   */
  async clearProgress(id: string, actorId: string, roleId: string): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem } = context.result;
    const before = await this.storedProgress(workItem.projectId, id, roleId);
    await this.opts.progress.remove(id, roleId);
    await this.announceWorkItem(workItem.projectId, id);
    // Nothing was stated, so nothing changed and there is nothing to put back —
    // the same skip `clearEstimate` and `clearActual` make, and the reason a
    // plan does not gain a history row every time somebody clears an empty box.
    if (before !== null) {
      await this.record(
        workItem.projectId,
        actorId,
        'clear_progress',
        `clear the progress on ${quoteName(workItem.name)}`,
        {
          forward: { do: 'clear_progress', workItemId: id, roleId },
          inverse: { do: 'set_progress', workItemId: id, roleId, state: before },
          touched: [id],
          before: context.result.rows,
        },
      );
    }
    return { ok: true, result: null };
  }

  /** Sends the whole tree, for a change that can renumber more than it touched. */
  /**
   * Records "`predecessorId`'s anchor — its first slice in role order — must
   * finish before this starts"; the predecessor's later roles run beside it.
   *
   * Broadcast as a whole-tree change, not a patch: one edge moves every date
   * downstream of it, and working out which rows those are is the schedule's
   * job, computed on read.
   */
  async addDependency(
    id: string,
    actorId: string,
    predecessorId: string,
  ): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem, rows } = context.result;

    const existing = await this.opts.dependencies.listByProject(workItem.projectId);
    // `rows` is this project's only, so a predecessor from another project is
    // simply not among them and comes back `not_found` — the cross-project case
    // is unrepresentable rather than separately guarded.
    const refusal = canDepend(rows, existing, predecessorId, id);
    if (refusal !== null) return { ok: false, reason: refusal };

    await this.opts.dependencies.add({
      id: this.newId(),
      projectId: workItem.projectId,
      predecessorId,
      successorId: id,
    });
    await this.announceTree(workItem.projectId);
    await this.record(
      workItem.projectId,
      actorId,
      'add_dependency',
      `make ${quoteName(workItem.name)} wait for ${quoteName(nameOf(rows, predecessorId))}`,
      {
        forward: { do: 'add_dependency', successorId: id, predecessorId },
        inverse: { do: 'remove_dependency', successorId: id, predecessorId },
        touched: [id, predecessorId],
        before: rows,
      },
    );
    return { ok: true, result: null };
  }

  /** Removing an edge that was not there is not an error; the state asked for is the state left. */
  async removeDependency(
    id: string,
    actorId: string,
    predecessorId: string,
  ): Promise<WorkItemOutcome<null>> {
    const context = await this.contextFor(id, actorId);
    if (!context.ok) return context;
    const { workItem, rows } = context.result;

    const existed = (await this.opts.dependencies.listByProject(workItem.projectId)).some(
      (edge) => edge.predecessorId === predecessorId && edge.successorId === id,
    );
    await this.opts.dependencies.remove(predecessorId, id);
    await this.announceTree(workItem.projectId);
    // The removal is idempotent, so a request for an edge that was not there
    // changed nothing and there is nothing to put back.
    if (existed) {
      await this.record(
        workItem.projectId,
        actorId,
        'remove_dependency',
        `stop ${quoteName(workItem.name)} waiting for ${quoteName(nameOf(rows, predecessorId))}`,
        {
          forward: { do: 'remove_dependency', successorId: id, predecessorId },
          inverse: { do: 'add_dependency', successorId: id, predecessorId },
          touched: [id, predecessorId],
          before: rows,
        },
      );
    }
    return { ok: true, result: null };
  }

  /**
   * Whether this account has anything to undo or redo on this project.
   *
   * Read by the controller alongside the tree rather than from its own route.
   * The tree read is already the thing every client does after every change of
   * its own and after every event from anybody else, so the answer arrives
   * exactly when it can have changed — and {@link tree} itself stays free of
   * an account, which matters because the broadcast reuses it.
   */
  undoState(projectId: string, actorId: string): Promise<UndoState> {
    return this.opts.journal.stateOf(projectId, actorId);
  }

  /**
   * Reverses this account's newest command on this project — **if nothing it
   * touched has moved since**.
   *
   * The condition is the whole design. An undo is a write computed from a
   * state that was read a while ago, so applying it blind is not "last writer
   * wins" by accident but by construction: it puts back a value nobody
   * currently on the plan asked for. Every entity the original command wrote
   * to is checked against the revision that command left it at, and a single
   * mismatch refuses the whole thing and says which row changed.
   *
   * A refused entry is **thrown away**. Its preconditions can never hold
   * again — revisions do not go down — so keeping it would jam the stack,
   * refusing every later press of the key for a change nobody can reach.
   */
  undo(projectId: string, actorId: string): Promise<UndoOutcome> {
    return this.walkStack(projectId, actorId, 'undo');
  }

  /**
   * Re-applies the command this account most recently undid on this project,
   * under exactly the same condition.
   *
   * A redo is as much a write from a stale read as an undo is, and the
   * asymmetry that would make it safe does not exist: between the undo and the
   * redo anybody may have edited the same row. The redo branch is cleared the
   * moment this account makes any forward change, because re-applying a
   * command on top of a plan that has moved on is a different command.
   */
  redo(projectId: string, actorId: string): Promise<UndoOutcome> {
    return this.walkStack(projectId, actorId, 'redo');
  }

  private async walkStack(
    projectId: string,
    actorId: string,
    direction: 'undo' | 'redo',
  ): Promise<UndoOutcome> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found', detail: null };
    // An undo is a mutation. Being allowed to read a restricted project is not
    // being allowed to reverse somebody's work in it.
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden', detail: null };

    // The whole stack, because applying one entry re-stamps its neighbours.
    // It is capped at fifty rows.
    const stack = await this.opts.journal.entriesFor(projectId, actorId);
    const entry: JournalEntry | undefined =
      direction === 'undo'
        ? [...stack].reverse().find((each) => !each.undone)
        : stack.find((each) => each.undone);
    if (entry === undefined) return { ok: false, reason: 'nothing_to_undo', detail: null };

    const payload = readPayload(entry.payload);
    const command = direction === 'undo' ? readCommand(entry.inverse) : payload.forward;
    const preconditions = readPreconditions(entry.preconditions);

    const moved = await this.staleness(projectId, preconditions.expected);
    if (moved !== null) {
      await this.opts.journal.discard(entry.id);
      return { ok: false, reason: 'stale_undo', detail: moved };
    }

    const applied = await this.apply(projectId, command);
    if (!applied.ok) {
      await this.opts.journal.discard(entry.id);
      return { ok: false, reason: 'stale_undo', detail: applied.detail };
    }

    // The entry now describes the other direction, so it checks the revisions
    // this application left and remembers the ones it started from. Nothing is
    // appended: an undo that was itself journalled would be undoable, and the
    // key would toggle one change forever instead of walking back through two.
    const now = await this.revisionsOf(projectId, touchedBy(command));
    await this.opts.journal.flip(entry.id, direction === 'undo', {
      expected: now,
      from: preconditions.expected,
    });
    await this.rebase(stack, entry, direction, preconditions.from, now);
    await this.announceTree(projectId);
    return { ok: true, result: { done: payload.label, detail: applied.detail } };
  }

  /**
   * Carries the entries this one was stacked on top of past the write the
   * application just made.
   *
   * This is what lets somebody press the key twice. An undo is an ordinary
   * mutation, so it moves the revisions of everything it touched — and the
   * entry below, which recorded those entities as it left them, would then be
   * checking against a number this account's own undo has walked past.
   *
   * The condition is exact and it is the whole safety of it: a neighbour is
   * carried forward **only** where the revision it expects is the one the
   * just-applied command started from. That equality says nobody wrote between
   * the two commands, and therefore that the entity now holds precisely what
   * the neighbour left it holding. Where somebody did write in between, the
   * numbers do not match, nothing is re-stamped, and that entry refuses when
   * it is reached — which is the entire point of the feature.
   *
   * Only the side being walked toward is touched: undoing carries the live
   * entries below, redoing carries the undone ones above.
   */
  private async rebase(
    stack: readonly JournalEntry[],
    applied: JournalEntry,
    direction: 'undo' | 'redo',
    startedFrom: Revisions,
    now: Revisions,
  ): Promise<void> {
    for (const other of stack) {
      if (other.id === applied.id) continue;
      const ahead = direction === 'undo' ? other.seq < applied.seq : other.seq > applied.seq;
      if (!ahead) continue;
      const their = readPreconditions(other.preconditions);
      let changed = false;
      const expected: Revisions = { ...their.expected };
      for (const [id, reached] of Object.entries(now)) {
        // Only where this neighbour has an opinion about the entity at all,
        // and where that opinion is exactly the revision the applied command
        // started from. Both halves matter: the first keeps a precondition
        // from being invented for a row the neighbour never touched, and the
        // second is what somebody else's write in between fails.
        if (!Object.hasOwn(their.expected, id)) continue;
        if (their.expected[id] !== startedFrom[id]) continue;
        expected[id] = reached;
        changed = true;
      }
      if (changed) await this.opts.journal.restamp(other.id, { ...their, expected });
    }
  }

  /**
   * Which entity has moved since the command ran, said in words a reader can
   * act on — or null when every one of them is exactly where it was.
   *
   * A row that is **gone** counts as moved. Its revision cannot be compared to
   * anything, and the change that removed it is a change the undo would be
   * computed against.
   */
  private async staleness(projectId: string, expected: Revisions): Promise<string | null> {
    const rows = await this.opts.workItems.listByProject(projectId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [id, revision] of Object.entries(expected)) {
      const row = byId.get(id);
      // "since then" rather than a bare "since": these are read out at the end
      // of the caller's own sentence — `That could not be undone: “Roof it” has
      // changed since` reached a reader on 2026-08-09 and stopped mid-phrase,
      // with no full stop and no answer to "since what?".
      if (row === undefined) {
        return 'a work item this change touched has been deleted since then.';
      }
      if (row.revision !== revision) return `${quoteName(row.name)} has changed since then.`;
    }
    return null;
  }

  /**
   * The current revisions of `ids`, skipping the ones that no longer exist.
   *
   * A row that is gone is deliberately absent rather than recorded as missing:
   * nobody can hold a revision for it, and the guard that matters for a row
   * that should stay gone is `restore_subtree` refusing to write over an id
   * that is there.
   */
  private async revisionsOf(projectId: string, ids: readonly string[]): Promise<Revisions> {
    const rows = await this.opts.workItems.listByProject(projectId);
    return revisionsIn(rows, ids);
  }

  /**
   * Applies one compensating command through the same stores every ordinary
   * mutation writes through, so revisions move, satellites follow and the
   * invariants hold.
   *
   * It re-checks the handful of rules a revision cannot express — a sibling
   * that has to exist for a placement, a leaf that has become a parent, an id
   * that is supposed to still be free — and answers `ok: false` rather than
   * throwing. Those are conditions to report, not faults: the caller turns
   * them into the same refusal a moved revision produces.
   *
   * **A directory id the replay would put back is one of those rules.** Undo
   * never resurrects a person, a team or a membership, and the guard that says
   * so is the store's own — `patch` and `assign` each read the id inside the
   * transaction that writes it, and this switch reports what they answered
   * rather than replaying around them.
   *
   * Proof, both watched 2026-08-09: with `assign`'s refusal ignored here,
   * `refuses a redo whose person has since been removed, and writes nothing`
   * fails; with `patch`'s `unknown_team` treated as applied, `refuses an undo
   * that would put back a label whose team has gone` fails and the work item
   * carries the dead id.
   */
  private async apply(projectId: string, command: CompensatingCommand): Promise<ApplyOutcome> {
    switch (command.do) {
      case 'patch': {
        const written = await this.opts.workItems.patch(command.workItemId, command.patch);
        if (!written.ok) {
          // The label's team or service was removed after the command ran, or
          // the row was. Either way the state this entry describes is gone, and
          // putting the dead id back is exactly what the guarded path exists to
          // refuse.
          //
          // The service gets its own sentence for the reason it gets its own
          // reason code: three dimensions can each be the one that went, and
          // "the work item is no longer there" would be a false sentence about
          // a row still on screen.
          return {
            ok: false,
            detail:
              written.reason === 'unknown_team'
                ? 'that service team is no longer in the directory.'
                : written.reason === 'unknown_service'
                  ? 'that service is no longer in the directory.'
                  : 'the work item is no longer there.',
          };
        }
        return { ok: true, detail: null };
      }
      case 'set_estimate': {
        const rows = await this.opts.workItems.listByProject(projectId);
        if (rows.some((row) => row.parentId === command.workItemId)) {
          return { ok: false, detail: 'that work item has children now, so its figures are sums.' };
        }
        // The phase the trio belonged to has been removed since. Putting the
        // figures back would be a foreign key error on a key somebody pressed
        // to be safe, so the entry is refused and discarded like any other
        // command the plan has moved past.
        if (!(await this.holdsRole(projectId, command.roleId))) {
          return { ok: false, detail: 'that phase is no longer in this project.' };
        }
        const restored = await this.writeNamingRole(projectId, command.roleId, () =>
          this.opts.estimates.set({
            workItemId: command.workItemId,
            roleId: command.roleId,
            ...command.days,
          }),
        );
        if (restored === null)
          return { ok: false, detail: 'that phase is no longer in this project.' };
        return { ok: true, detail: null };
      }
      case 'clear_estimate':
        await this.opts.estimates.remove(command.workItemId, command.roleId);
        return { ok: true, detail: null };
      case 'set_actual': {
        const rows = await this.opts.workItems.listByProject(projectId);
        if (rows.some((row) => row.parentId === command.workItemId)) {
          return { ok: false, detail: 'that work item has children now, so its figures are sums.' };
        }
        // The phase the days were recorded against has been removed since.
        // `actual.role_id` is a foreign key, so putting the number back would be
        // a constraint error on a key somebody pressed to be safe.
        if (!(await this.holdsRole(projectId, command.roleId))) {
          return { ok: false, detail: 'that phase is no longer in this project.' };
        }
        const restored = await this.writeNamingRole(projectId, command.roleId, () =>
          this.opts.actuals.set({
            workItemId: command.workItemId,
            roleId: command.roleId,
            days: command.days,
            // Now, not the stamp the row carried. An undo is somebody recording
            // the number again, and this column says when it was recorded — see
            // the `set_actual` command in `compensating.ts`.
            recordedAt: this.now(),
          }),
        );
        if (restored === null)
          return { ok: false, detail: 'that phase is no longer in this project.' };
        return { ok: true, detail: null };
      }
      case 'clear_actual':
        await this.opts.actuals.remove(command.workItemId, command.roleId);
        return { ok: true, detail: null };
      case 'set_progress': {
        const rows = await this.opts.workItems.listByProject(projectId);
        if (rows.some((row) => row.parentId === command.workItemId)) {
          return { ok: false, detail: 'that work item has children now, so its figures are sums.' };
        }
        // The phase the statement was made about has been removed since.
        // `role_progress.role_id` is a foreign key, so putting the statement
        // back would be a constraint error on a key somebody pressed to be safe.
        if (!(await this.holdsRole(projectId, command.roleId))) {
          return { ok: false, detail: 'that phase is no longer in this project.' };
        }
        const restored = await this.writeNamingRole(projectId, command.roleId, () =>
          this.opts.progress.set({
            workItemId: command.workItemId,
            roleId: command.roleId,
            state: command.state,
            // Now, not the stamp the row carried. An undo is somebody saying it
            // again, and this column says when it was said — the same reading
            // `set_actual` takes of `recordedAt`.
            statedAt: this.now(),
          }),
        );
        if (restored === null)
          return { ok: false, detail: 'that phase is no longer in this project.' };
        return { ok: true, detail: null };
      }
      case 'clear_progress':
        await this.opts.progress.remove(command.workItemId, command.roleId);
        return { ok: true, detail: null };
      case 'assign':
        if (command.personId !== null && !(await this.holdsRole(projectId, command.roleId))) {
          return { ok: false, detail: 'that phase is no longer in this project.' };
        }
        {
          const reassigned = await this.writeNamingRole(projectId, command.roleId, () =>
            this.opts.directory.assign(command.workItemId, command.roleId, command.personId),
          );
          if (reassigned === null) {
            return { ok: false, detail: 'that phase is no longer in this project.' };
          }
          // The person was removed after the command ran. Undo never
          // resurrects one, so the entry is refused and discarded like any
          // other the plan has moved past.
          if (!reassigned.ok) {
            return { ok: false, detail: 'that person is no longer in the directory.' };
          }
        }
        return { ok: true, detail: null };
      case 'add_dependency': {
        const rows = await this.opts.workItems.listByProject(projectId);
        const existing = await this.opts.dependencies.listByProject(projectId);
        const refusal = canDepend(rows, existing, command.predecessorId, command.successorId);
        if (refusal !== null) {
          return { ok: false, detail: `that dependency would now be refused: ${refusal}` };
        }
        await this.opts.dependencies.add({
          id: this.newId(),
          projectId,
          predecessorId: command.predecessorId,
          successorId: command.successorId,
        });
        return { ok: true, detail: null };
      }
      case 'remove_dependency':
        await this.opts.dependencies.remove(command.predecessorId, command.successorId);
        return { ok: true, detail: null };
      case 'move':
        return this.applyMove(projectId, command.workItemId, command.parentId, command.afterId);
      case 'set_frozen': {
        const rows = await this.opts.workItems.listByProject(projectId);
        const gone = command.updates.find((each) => !rows.some((row) => row.id === each.id));
        if (gone !== undefined) {
          return {
            ok: false,
            detail: 'a work item this change froze has been deleted since then.',
          };
        }
        await this.opts.workItems.setFrozenNumbers(command.updates);
        return { ok: true, detail: null };
      }
      case 'delete_subtree':
        return this.applyDelete(projectId, command);
      case 'restore_subtree':
        return this.applyRestore(projectId, command);
    }
  }

  private async applyMove(
    projectId: string,
    id: string,
    parentId: string | null,
    afterId: string | null,
  ): Promise<ApplyOutcome> {
    const rows = await this.opts.workItems.listByProject(projectId);
    const moving = rows.find((row) => row.id === id);
    if (moving === undefined) return { ok: false, detail: 'the work item is no longer there.' };
    if (moving.frozenNumber !== null) {
      return { ok: false, detail: 'that work item has been frozen since, so it cannot move.' };
    }
    if (parentId !== null && !rows.some((row) => row.id === parentId)) {
      return { ok: false, detail: 'the work item it sat under has been deleted since then.' };
    }
    const group = this.groupUnder(rows, parentId).filter((sibling) => sibling.id !== id);
    // `placeAfter` throws on a sibling that is not in the group, which is the
    // right answer for a caller that made the id up and the wrong one for a
    // row somebody deleted while this entry sat on the stack.
    if (afterId !== null && !group.some((sibling) => sibling.id === afterId)) {
      return { ok: false, detail: 'the work item it sat after has been deleted since then.' };
    }
    const placed = placeAfter(group, afterId);
    await this.opts.workItems.move(id, parentId, placed.position, placed.renumbered);
    return { ok: true, detail: null };
  }

  private async applyDelete(
    projectId: string,
    command: Extract<CompensatingCommand, { do: 'delete_subtree' }>,
  ): Promise<ApplyOutcome> {
    const rows = await this.opts.workItems.listByProject(projectId);
    if (!rows.some((row) => row.id === command.rootId)) {
      return { ok: false, detail: 'the work item is no longer there.' };
    }
    // The guard a revision cannot give. A child written under a work item is a
    // row of its own and moves nothing on its parent, so a created row that
    // has since been built on still reads at the revision it was created with
    // — and taking it away would take somebody else's work with it.
    const now = new Set(subtreeOf(rows, command.rootId));
    const then = new Set(command.expectedSubtree);
    if (now.size !== then.size || [...then].some((id) => !now.has(id))) {
      return { ok: false, detail: 'work has been added or removed under that row since then.' };
    }
    for (const gone of command.remove) await this.opts.dependencies.removeAllFor(gone);
    await this.opts.workItems.remove(command.remove, command.reparented);
    for (const each of command.setEstimates) await this.opts.estimates.set(each);
    // The hand-up again, actuals with estimates. A re-applied delete that put
    // back only half of what the original handed to the surviving parent would
    // leave the plan reporting an estimate with no record beside it.
    for (const each of command.setActuals) await this.opts.actuals.set(each);
    // And the statements, for the same reason one line up: a re-applied delete
    // that put back the figures and not the reading would leave the surviving
    // parent reporting a finished branch's work as work nobody has started.
    for (const each of command.setProgress) await this.opts.progress.set(each);
    return { ok: true, detail: null };
  }

  private async applyRestore(
    projectId: string,
    command: Extract<CompensatingCommand, { do: 'restore_subtree' }>,
  ): Promise<ApplyOutcome> {
    const root = command.rows.at(0);
    if (root === undefined) throw new Error('a restore was journalled with no rows in it');
    const rows = await this.opts.workItems.listByProject(projectId);
    const taken = command.rows.find((row) => rows.some((each) => each.id === row.id));
    if (taken !== undefined) {
      // Nothing recreates an id, so this means something else is using one
      // this branch owns. Remapping to fresh ids would leave every reference
      // to the branch — journalled and otherwise — aimed at rows that are gone.
      return { ok: false, detail: 'something already exists where that work item was.' };
    }
    if (root.parentId !== null && !rows.some((each) => each.id === root.parentId)) {
      return { ok: false, detail: 'the work item it sat under has been deleted since then.' };
    }

    // The sibling group as it will be once the reparenting has happened: the
    // rows going back under this branch leave it, and the ones the deletion
    // respaced take their old positions again. Placing against the group as it
    // stands would put the branch beside rows that are about to move.
    const backById = new Map(command.reparented.map((each) => [each.id, each]));
    const projected = rows
      .map((row) => {
        const back = backById.get(row.id);
        return back === undefined
          ? row
          : { ...row, parentId: back.parentId, position: back.position };
      })
      .filter((row) => row.parentId === root.parentId)
      .map(asSibling);
    const wasAfter = projected
      .filter((sibling) => sibling.position < command.rootPosition)
      .sort((a, b) => a.position - b.position)
      .at(-1);
    const placed = placeAfter(projected, wasAfter?.id ?? null);

    await this.opts.subtrees.insertSubtree({
      rows: command.rows.map((row) => ({
        ...row,
        position: row.id === root.id ? placed.position : row.position,
        // A row that has been away and come back is new to every reader
        // holding a number for it, so it starts again at 0 rather than
        // resuming the count it had. The consequence is deliberate: an older
        // entry on the stack that expected one of these rows at 4 now refuses,
        // which is the safe direction — see `design.md`.
        revision: 0,
      })),
      respaced: placed.renumbered,
      reparented: command.reparented,
      estimates: command.estimates,
      actuals: command.actuals,
      progress: command.progress,
      assignments: command.assignments,
      dependencies: command.internalDependencies,
      removedEstimates: command.removedEstimates,
      removedActuals: command.removedActuals,
      removedProgress: command.removedProgress,
    });

    // The edges that leave the branch, one at a time and through the same
    // guard an ordinary request goes through. This is the one part of a
    // restore that can come back incomplete, and it says so rather than
    // pretending otherwise.
    const after = await this.opts.workItems.listByProject(projectId);
    const skipped: string[] = [];
    for (const edge of command.externalDependencies) {
      const current = await this.opts.dependencies.listByProject(projectId);
      const refusal = canDepend(after, current, edge.predecessorId, edge.successorId);
      if (refusal !== null) {
        skipped.push(refusal);
        continue;
      }
      await this.opts.dependencies.add({
        id: this.newId(),
        projectId,
        predecessorId: edge.predecessorId,
        successorId: edge.successorId,
      });
    }
    return {
      ok: true,
      detail:
        skipped.length === 0
          ? null
          : `put back without ${String(skipped.length)} dependenc${skipped.length === 1 ? 'y' : 'ies'} the plan no longer allows (${[...new Set(skipped)].join(', ')})`,
    };
  }

  /**
   * Writes one command down — to the account's undo stack and to the project's
   * history — after it has been applied and announced.
   *
   * **Ordering, and what it costs.** The change is applied and broadcast
   * first, then journalled. A journal write that throws therefore fails the
   * request for a change that has already happened — the client refetches and
   * sees it — while everybody else's view of the plan stays correct. The
   * alternative, journalling before the broadcast, would trade an accurate
   * error for a project full of readers sitting on a tree that has moved.
   * Neither swallows the failure: the one thing this must never do is report
   * success for a command it did not record, because the symptom would be an
   * undo key that quietly skips a change. See `design.md`.
   *
   * The preconditions are read **after** the mutation, and are the revisions
   * it left behind. Recording the revisions from before it would make an undo
   * of somebody's own second edit pass when it must refuse.
   *
   * **The history row is written from here and from nowhere else.** Every
   * journalled command — all fifteen kinds — becomes one `plan_event` row, per
   * project rather than per account and never pruned by anybody's undo, which is
   * the whole of R5's "examine the history of estimates changes". It is one extra
   * `INSERT` in the transaction the journal append already opens rather than a
   * second call, so a command cannot be undoable without also being recorded; see
   * {@link CommandJournalStore.append}. Adding a sixteenth journalled kind
   * therefore adds it to the history for free, which is why H2's actuals must go
   * through this seam and not around it.
   *
   * **What the history does not hold, stated because it will be asked.** Undo and
   * redo append nothing here — they flip an entry in place, by design — so an
   * estimate set to 8 and then undone leaves one event reading "set to 8" and no
   * event saying it was taken back. Every event is true about the moment it
   * records; the sequence is incomplete. Closing it means logging from the undo
   * path too, which is a second write site and R5's H5 question, not this change's.
   * See `openspec/changes/plan-history/design.md` D4.
   */
  private async record(
    projectId: string,
    actorId: string,
    kind: string,
    label: string,
    recording: Recording,
  ): Promise<void> {
    const at = this.now();
    const subject = subjectOf(recording.forward);
    await this.opts.journal.append(
      {
        id: this.newId(),
        projectId,
        userId: actorId,
        kind,
        payload: { label, forward: recording.forward },
        inverse: recording.inverse,
        preconditions: {
          expected: await this.revisionsOf(projectId, recording.touched),
          // The same entities as they were before the mutation, read off the row
          // list the mutation's own guard produced. Nothing is checked against
          // it — it is what tells a later undo whether the entry beneath this
          // one is still describing an unbroken chain. See `Preconditions`.
          from: revisionsIn(recording.before, recording.touched),
        },
        createdAt: at,
      },
      {
        id: this.newId(),
        projectId,
        userId: actorId,
        kind,
        label,
        workItemId: subject.workItemId,
        roleId: subject.roleId,
        // The compensating command, which is where the before-state lives: for
        // the estimate kinds it carries the trio that was stored, and for the
        // rest it is the only before-state that exists. See `plan_event`.
        before: recording.inverse,
        after: recording.forward,
        // The same instant as the journal entry, read once. Two `now()` calls
        // would let one act carry two timestamps, and the history is ordered by
        // this column.
        createdAt: at,
      },
    );
  }

  /**
   * Runs a write that names a role, answering `null` when the role went between
   * the check above it and the statement itself, and otherwise whatever the
   * write answered.
   *
   * {@link WorkItemService.holdsRole} narrows the window and does not close it:
   * a removal can commit between that read and this write, and `estimate` and
   * `assignment` both reference `role.id` by foreign key. Left alone that is a
   * 500 for a caller whose only fault is being a moment out of date, which R5
   * calls a modeled condition wearing an invariant's clothes.
   *
   * The translation is deliberately narrow. SQLite's message names no column,
   * so the role is re-read before the refusal is believed: a foreign key that
   * failed over a work item or a person that has gone is still unknown, and
   * still thrown.
   *
   * Proof: with the `catch` removed, `refuses the estimate rather than
   * answering with the foreign key` and `refuses the assignee the same way`
   * both fail with `SQLiteError: FOREIGN KEY constraint failed`; with the
   * `holdsRole` re-read dropped, `still throws a foreign key that is not about
   * the role` fails, an absent person reported as an absent phase. Watched
   * 2026-08-09.
   */
  private async writeNamingRole<T>(
    projectId: string,
    roleId: string,
    write: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await write();
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err;
      if (await this.holdsRole(projectId, roleId)) throw err;
      return null;
    }
  }

  /**
   * Whether the project still holds this role.
   *
   * Asked on every write that names one, because a role can be removed while a
   * client has it on screen — and both `estimate` and `assignment` reference it
   * by foreign key. Reading the project's roles rather than taking a role store
   * of its own: the answer is one column of a list this service already reads.
   *
   * Proof: with both calls removed, `refuses an estimate and an assignee for a
   * role that has gone, rather than 500ing` fails with two 500s, and `leaves an
   * undo whose role has gone refusing as stale, not writing` 500s too; watched
   * 2026-08-08.
   */
  private async holdsRole(projectId: string, roleId: string): Promise<boolean> {
    const roles = await this.opts.projects.rolesOf(projectId);
    return roles.some((each) => each.id === roleId);
  }

  /** One work item's stored trio for one role, or null when it holds none. */
  private async storedTrio(
    projectId: string,
    workItemId: string,
    roleId: string,
  ): Promise<Days | null> {
    const found = (await this.opts.estimates.listByProject(projectId)).find(
      (each) => each.workItemId === workItemId && each.roleId === roleId,
    );
    if (found === undefined) return null;
    return {
      optimistic: found.optimistic,
      realistic: found.realistic,
      pessimistic: found.pessimistic,
    };
  }

  /**
   * One work item's recorded days for one role, or null when it holds none.
   *
   * Null rather than 0, and every caller of this treats the two as different
   * answers: 0 is a person saying the work took no time, and null is nobody
   * having said anything. The absence is what an undo of the first recording
   * puts back.
   */
  private async storedActual(
    projectId: string,
    workItemId: string,
    roleId: string,
  ): Promise<number | null> {
    const found = (await this.opts.actuals.listByProject(projectId)).find(
      (each) => each.workItemId === workItemId && each.roleId === roleId,
    );
    return found?.days ?? null;
  }

  /**
   * What one work item's role currently says, or null when it has said nothing.
   *
   * Null rather than `not_started`, and every caller treats the two as one
   * answer with two spellings only in the direction that matters: null is what
   * an undo of the first statement puts back, and it puts it back by deleting
   * the row rather than by writing a third value into the column.
   */
  private async storedProgress(
    projectId: string,
    workItemId: string,
    roleId: string,
  ): Promise<RoleState | null> {
    const found = (await this.opts.progress.listByProject(projectId)).find(
      (each) => each.workItemId === workItemId && each.roleId === roleId,
    );
    return found?.state ?? null;
  }

  private async announceTree(projectId: string): Promise<void> {
    const tree = await this.tree(projectId);
    if (tree === null) return;
    await this.opts.broadcast.publish(projectId, {
      type: 'tree_replaced',
      workItems: tree.workItems,
    });
  }

  /** Sends one work item and its ancestors, whose roll-ups its change moved. */
  private async announceWorkItem(projectId: string, id: string): Promise<void> {
    const tree = await this.tree(projectId);
    if (tree === null) return;
    await this.opts.broadcast.publish(projectId, {
      type: 'work_items_changed',
      workItems: withAncestors(tree.workItems, id),
    });
  }

  private groupUnder(rows: readonly WorkItem[], parentId: string | null): Sibling[] {
    return rows.filter((row) => row.parentId === parentId).map(asSibling);
  }

  /** The work item, its project and the project's rows — or the refusal that stops the caller. */
  private async contextFor(
    id: string,
    actorId: string,
  ): Promise<WorkItemOutcome<{ workItem: WorkItem; project: Project; rows: LabelledWorkItem[] }>> {
    const workItem = await this.opts.workItems.findById(id);
    if (workItem === null) return { ok: false, reason: 'not_found' };
    const project = await this.opts.projects.findById(workItem.projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };
    const rows = await this.opts.workItems.listByProject(workItem.projectId);
    return { ok: true, result: { workItem, project, rows } };
  }
}
