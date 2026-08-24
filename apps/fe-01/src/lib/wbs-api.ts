// The one exception to this file's "declare, do not import" rule, and it earns
// it: a band's three fields are not the interesting part — `priorityBandRankOf`
// and `priorityLadderProblem` are, they live beside the type in `libs/domain`,
// and a wire type declared here would be a second shape those two functions did
// not accept. It is a deep subpath import of a module holding four small pure
// functions and no runtime dependency at all, which is the same bargain
// `plan-export.ts` and `gantt-geometry.ts` already make with `effective-team`
// and `workday`.
import type { PriorityBand } from '@wbs/domain/priority-band';

/**
 * How a project turns its three-point estimates into the one number it plans
 * with. Mirrors `EstimateMethod` in `libs/domain`.
 *
 * Declared here rather than imported, like every other wire type in this file:
 * `libs/domain` pulls in arktype for its runtime validation, and none of that
 * belongs in a browser bundle. be-01 validates the value at its boundary — the
 * client's copy is a description of what comes back, not the rule.
 */
export const ESTIMATE_METHODS = ['pert', 'optimistic', 'realistic', 'pessimistic'] as const;
export type EstimateMethod = (typeof ESTIMATE_METHODS)[number];

/** Whether `value` is one of the four, for reading a `<select>`'s string back. */
export function isEstimateMethod(value: string): value is EstimateMethod {
  return (ESTIMATE_METHODS as readonly string[]).includes(value);
}

export interface Days {
  optimistic: number;
  realistic: number;
  pessimistic: number;
}

/**
 * When a work item can happen, in whole days from the project's day zero.
 *
 * No dates: a calendar brings weekends, holidays and timezones, and none of them
 * are needed to answer what is waiting on what. `estimated` is what stops a
 * zero-day row being read as instant when it means nobody has looked.
 */
export interface ScheduleView {
  duration: number;
  estimated: boolean;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  float: number;
  critical: boolean;
}

/**
 * What decided a slice's start: the latest of its floors, named.
 *
 * `projectStart` means nothing did. `predecessor` is a dependency onto another
 * work item, `roleOrder` the work item's own earlier phase, `notBefore` a
 * manual date, `person` the assignee finishing something else, and `capacity`
 * the work item's **team** having no slot free. A tie is never `person` and
 * never `capacity`: whoever came free exactly as the dependency cleared was not
 * holding anything up, and between the two the person is named first. be-01's
 * `ScheduleFloor` is the rule; this is a description of what comes back.
 */
export type ScheduleFloorView =
  | 'projectStart'
  | 'predecessor'
  | 'roleOrder'
  | 'notBefore'
  | 'person'
  | 'capacity';

/**
 * One placed slice — one work item's work for one phase — as be-01 sends it.
 *
 * A row's {@link ScheduleView} is the span this is a projection of, and both
 * are carried because neither answers the other's question: a row does not say
 * which phase ran when, and a slice does not know its parent's bracket.
 *
 * `id` is be-01's own key for the slice and is **opaque** — a string to look up,
 * never to take apart. `resourcePredecessorId` names another entry of the same
 * array by that id: the slice this one's assignee was busy with, and only where
 * `boundBy` is `person`, so a link drawn from it is a wait that really happened.
 * Reconstructing the id from `workItemId` and `roleId` would be a second copy of
 * be-01's `sliceKey`, and the two would disagree the day either changes.
 *
 * The numbers are be-01's verbatim, fractions and all — a chart drawn from them
 * and the Start/End columns beside it are then reading the same plan.
 */
export interface SliceView {
  id: string;
  workItemId: string;
  /** Null only in a project holding no phases at all, which is reachable. */
  roleId: string | null;
  personId: string | null;
  duration: number;
  /** False when nobody has estimated this pair, which is not the same as zero days. */
  estimated: boolean;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  float: number;
  critical: boolean;
  boundBy: ScheduleFloorView;
  resourcePredecessorId: string | null;
  /**
   * How many of its team's slots this slice held while it ran — the
   * **effective** width be-01 scheduled with.
   *
   * Already clamped to the team's size and already 1 wherever somebody is
   * named on the work (one human cannot work beside themselves). The number
   * somebody *typed* is {@link WorkItemView.maxParallel}, and the two
   * differing is a fact the chart, the table and the export each state.
   */
  width: number;
  /**
   * The days of work this slice is, before it was compressed across
   * {@link SliceView.width} slots — `duration` is `effort / width`.
   *
   * Both, because neither answers the other's question: the bar is drawn across
   * the duration and the estimate the reader typed is the effort. Recomputing
   * either from the other here would be a second division beside be-01's.
   */
  effort: number;
  /**
   * Every placed slice that had to end for this one to fit its team's pool.
   *
   * The whole blocking set, of which `resourcePredecessorId` names the one an
   * arrow is drawn from — be-01 picks the latest finisher. Empty for every
   * floor but `capacity`, and never empty under it: the panel refuses a
   * capacity floor with nothing behind it rather than drawing a sentence with a
   * hole in it.
   */
  capacityPredecessorIds: string[];
}

export interface WorkItemView {
  id: string;
  parentId: string | null;
  /**
   * How many times be-01 has written to this work item, counting writes to its
   * estimates, assignees and dependencies.
   *
   * Nothing on screen uses it yet, and nothing sends it back. It is here so a
   * client that holds a row can later say "apply this only if it has not moved
   * since I read it" — the primitive conditional undo and write preconditions
   * are both built on. be-01 owns the rule; this is a description of what
   * arrives.
   *
   * It does **not** move when {@link WorkItemView.number} does. A create
   * anywhere above renumbers rows nobody wrote to, and the table already
   * refetches for that.
   */
  revision: number;
  number: string;
  name: string;
  notes: string;
  frozenNumber: string | null;
  /** True when the estimates are sums of descendants and so not editable here. */
  rolledUp: boolean;
  estimates: Record<string, Days>;
  /** The work items this one waits for, by id. Either end may be a parent. */
  dependsOn: string[];
  /**
   * The one number this row is planned with, per role, and their sum — the
   * project's estimate method applied to the trio above.
   *
   * be-01 computes both, from the same call the schedule's durations come
   * from. Working them out here instead would be a second implementation of
   * "the final estimate" sitting one column away from the dates it must agree
   * with.
   */
  finalDays: Record<string, number>;
  finalTotal: number;
  /**
   * When this happens on a calendar, or null while the project has no start
   * date or the schedule could not be computed.
   *
   * Working days only, and `endsOn` is the last day the work is still on
   * rather than the day after. Computed by be-01 with the project's start
   * date; the client renders it and counts nothing.
   */
  dates: { startsOn: string; endsOn: string } | null;
  /** A day this item may not start before — a floor the dependencies can push past. */
  startNoEarlierThan: string | null;
  /**
   * Why, in the planner's own words, or null where nobody has said.
   *
   * Words about {@link WorkItemView.startNoEarlierThan} and nothing else — not a
   * status, not a second thing holding the row back, and nothing any date is
   * computed from. Null unless there is a date beside it: be-01 refuses the
   * pair, so a client clearing the date sends both fields as null in the one
   * patch.
   *
   * Shown where the date's effect is already explained — the bar's floor
   * sentence when the not-before is the **binding** floor, and the Not before
   * cell — and nowhere else, which is what keeps it from reading as a state of
   * its own.
   */
  startNoEarlierThanReason: string | null;
  /**
   * How important this work is — 1 upward, smaller first — or null where
   * nobody has said.
   *
   * An ordering of be-01's leveller and nothing the client computes with: it
   * decides which of two work items competing for one person is placed first,
   * and the dates that come back are already the answer. Rendered as a number
   * and sent back as one.
   */
  priority: number | null;
  /**
   * How many people may work on this item at once — 1 unless somebody has said
   * otherwise, and never null.
   *
   * `1` and *unset* are the same fact — one at a time — so be-01's column is
   * `NOT NULL DEFAULT 1` and sending `null` resets it to 1 rather than clearing
   * it to a second spelling of the same state.
   *
   * An ordering of nothing: it compresses an item's own effort across up to
   * this many of its team's slots, and the dates that come back are already the
   * answer. A row with children carries whatever it was last given, inert —
   * a parent holds no slices of its own to run in parallel.
   */
  maxParallel: number;
  /**
   * The teams this work is labelled with — **0..n**, and the only thing this
   * client reads. Never constrains who is assigned the work.
   *
   * In be-01's order (by team id), so two reads of an unchanged plan give the
   * same array. Empty means this row states nothing and takes its ancestor's
   * set; `effectiveTeamsOf` in `libs/domain` is the reading, shared with be-01's
   * own scheduler so that a bar and the pool it was placed against cannot
   * disagree.
   *
   * At most one member today: the write path sends one team until R2-4, and the
   * surfaces that show a second are R2-3.
   */
  teamIds: string[];
  /**
   * The one team, or null — **written by be-01, read by nothing here.**
   *
   * Kept on the wire for one release because blue and green share a database
   * and an fe-01 from the outgoing release is still served while the incoming
   * be-01 answers it. `teamIds` above is what this client reads; R2-6 removes
   * this field.
   */
  serviceTeamId: string | null;
  /**
   * What kind of thing this work item is, by tag id — `regulatory`,
   * `tech-debt`, `q3-must-have`.
   *
   * In be-01's order (by tag id), so two reads of an unchanged plan give the
   * same array. Empty means this row states nothing and takes its ancestor's
   * set; `effectiveTagsOf` in `libs/domain` is the reading, and it is literally
   * the same walk `teamIds` above uses.
   *
   * **Independent of `teamIds` in every respect.** A row states either, both or
   * neither, and inheriting one says nothing about the other. There is no
   * column behind this and never was — unlike `serviceTeamId` above, which is
   * `teamIds`' outgoing copy, a tag's whole existence is the join table.
   *
   * **Nothing that computes a date reads this.** A team is a pool the scheduler
   * spends; a tag is a label, and be-01 asserts the empty diff on a plan where a
   * sized team really does decide dates.
   *
   * **Optional on the wire, and required on a `TreeRow`.** Blue and green run
   * together during a swap, so an fe-01 carrying this change can be served a
   * tree by the outgoing be-01, which has never heard of the field. `toTree` is
   * the one place that absence is turned into an empty set; every surface above
   * it reads a `string[]` and is right to. Typing it as always-present here
   * would be this file asserting something about a release that does not exist
   * yet.
   */
  tagIds?: string[];
  /**
   * What this work item delivers, by service id — the whole set, empty where
   * nobody has said.
   *
   * **A list, as the two dimensions above are**, since task 10.2 replaced the
   * column with `work_item_service` (design.md D2 as amended): a row delivers as
   * many services as somebody states. Empty is _unstated_ and takes the
   * ancestor's answer; `effectiveServicesOf` in `libs/domain` is the reading, and
   * it is the same walk `teamIds` and `tagIds` use, now with no conversion at
   * either edge — the two singleton folds this field used to force are deleted.
   *
   * **Independent of `teamIds` and `tagIds` in every respect** — a row states
   * any of the three, all of them or none, and inheriting one says nothing about
   * the others. What relates a service to a team is the directory's ownership
   * map ({@link TeamView.serviceIds}), which labels no work item at all.
   *
   * **Nothing that computes a date reads this**, `tagIds`' rule and for its
   * reason: a team is a pool the scheduler spends, a service is what is being
   * delivered, and be-01 asserts the empty diff on a plan where a sized team
   * really does decide dates.
   *
   * **Optional on the wire, and required on a `TreeRow`** — `tagIds`' swap
   * window, argued there. `undefined` here is "the be-01 that answered has never
   * heard of services"; `toTree` folds it to `[]`, which is the one place it may,
   * because every surface above reads a `string[]` and is right to. The
   * distinction the singleton drew between `undefined` and `null` is gone with
   * the null: absent and empty were only ever different to a reader who could do
   * nothing with the difference.
   */
  serviceIds?: string[];
  /**
   * Who does this work, by role id.
   *
   * `string | undefined` rather than `string`: a role nobody is assigned to is
   * **absent** from this object, and a type saying otherwise would have every
   * reader believing an index always finds somebody.
   */
  assignees: Record<string, string | undefined>;
  /** The one person assumed to do every phase, when exactly one is assigned. */
  doesEveryPhase: string | null;
  /**
   * `estimates` is **effort** and this is **span**. For a parent they differ:
   * two independent children of 3 and 4 days are 7 days of work in a 4-day
   * branch. Both are true, and the table labels them so.
   */
  schedule: ScheduleView;
}

export interface RoleView {
  id: string;
  name: string;
}

/**
 * Somebody an assignment on the tree names — their id and what they are called.
 *
 * A {@link PersonView} without the teams, because that is all the chart needs
 * and all be-01 sends on this read: the teams are a question about who could be
 * assigned, which is `/api/people`'s and the pickers'.
 */
export interface AssignedPersonView {
  id: string;
  name: string;
}

/**
 * One work item whose {@link WorkItemView.doesEveryPhase} a removal would move.
 *
 * Nobody wrote these rows: the assumption is derived from a work item holding
 * exactly one assignment, so removing a role can promote somebody to covering
 * every phase or end that reading. be-01 computes them (`assumed-assignee.ts`)
 * and the confirmation prints them, which is the only reason they cross the
 * wire — the client never derives one.
 */
export interface AssumedAssigneeFlipView {
  workItemId: string;
  /** Who is assumed to be doing all of it now, or null for nobody. */
  assumedNow: string | null;
  /** Who would be, once the phase and its assignments have gone. */
  assumedAfter: string | null;
}

/** What removing a phase would take with it, as be-01's refusal reports it. */
export interface RoleUsage {
  estimates: number;
  /** Explicit assignments on this phase. The assumed ones are in `assumedAssignees`. */
  assignments: number;
  assumedAssignees: AssumedAssigneeFlipView[];
}

/**
 * What came of asking for a phase to be removed.
 *
 * `in_use` is a **modeled answer** rather than a thrown code, for the reason
 * {@link UndoResult}'s refusals are: it is an ordinary state of a plan somebody
 * has been estimating, and the counts riding along with it are the whole point
 * of the refusal — the next request is the same one with the cascade, and
 * nobody can agree to that without being told what it takes. Every other
 * refusal throws its code, which {@link roleRefusalSentence} turns into a
 * sentence.
 */
export type RoleRemoval = { ok: true } | { ok: false; reason: 'in_use'; inUse: RoleUsage };

/**
 * A service or team, global to this deployment. A name and nothing else.
 *
 * **No `size`, and its absence is the change.** A team used to carry one global
 * number for every plan on the deployment; since `capacity-per-project` the
 * number is the plan's, and be-01 does not send the retired column at all —
 * `/api/teams` answers `{ id, name }` and a be-01 test pins that shape. So a
 * fallback to a team's global size cannot be written here: it does not compile.
 *
 * That is stronger than the test which used to stand in this file's place, and
 * it is why that test is gone. How many of a team may be at work at once on one
 * plan is {@link TeamCapacityView}.
 */
export interface TeamView {
  id: string;
  name: string;
  /**
   * The services this team is **responsible for** — the ownership map, shipped
   * whole (design D4).
   *
   * Not a label on any work item and not inherited: it is directory data about
   * the team itself, edited on the team's own row. The client needs the map per
   * row anyway to filter on **built by a non-owner** without a round trip, so
   * be-01 sends the map rather than a derived flag — a flag would be a second
   * copy of a rule the client already has to hold, and the copy nobody looks at
   * is the one that drifts.
   *
   * Empty means a team that owns nothing, which is every team until somebody
   * fills the map in: it ships with no data, because nothing may invent who owns
   * what.
   *
   * **Optional on the wire, for the blue/green window and nothing else** —
   * `WorkItemView.serviceIds`' rule one level up. `undefined` is "the be-01 that
   * answered has never heard of services", which a browser holding the new
   * bundle against the old server sees for the length of a deploy; `[]` is "it
   * has, and this team owns none". They are the same thing to every reader here,
   * so `WbsTable` folds the first into the second in the one place it may
   * (`ownedServicesByTeam`) and nothing below that has to know. A crash in that
   * window is what this costs a line to avoid.
   */
  serviceIds?: string[];
}

/**
 * A tag, global to this deployment. A name and nothing else, and the absence is
 * bigger than {@link TeamView}'s.
 *
 * A team has no `size` **any more**; a tag has never had one and has no
 * per-project table beside it either, so there is no `TagCapacityView` under
 * this and nothing to write one from. A reader who notices that the directory
 * page renders tags with no capacity column has learned the model rule.
 */
export interface TagView {
  id: string;
  name: string;
}

/**
 * One service in the global directory — {@link TagView}'s two columns, and for
 * a different absence again.
 *
 * A tag has no size because nothing about a tag is spent. A service has none
 * because a service is not a pool either: it is what the work is *part of*, and
 * who has the people is still {@link TeamView}, whose ownership of services is
 * {@link TeamView.serviceIds} and not a column here.
 *
 * **Read-only on this client so far.** Adding, renaming and removing a service
 * are the directory page's, and that card is task 7.5; the list arrived early
 * because the filter's service facet cannot name what it offers without it
 * (task 6.3). A reader who notices `listServices` standing alone where the tags
 * have four methods has read the order the change is being built in, not a gap
 * in the API.
 */
export interface ServiceView {
  id: string;
  name: string;
}

/**
 * How many of one team may be at work at once **on one project's plan**.
 *
 * A team the plan has stated nothing about is **absent** from the list, not
 * present with a `null`: unstated constrains that team's work on that plan not at
 * all, and it has one spelling on the wire exactly as it has one in the database.
 * There is deliberately no fallback to a team's retired global size — Dany,
 * 2026-08-13 — and since that column left {@link TeamView} there is nothing here
 * to fall back to.
 */
export interface TeamCapacityView {
  serviceTeamId: string;
  /** At least 1. Never null, and never zero — a pool of no slots is a plan of infinite dates. */
  size: number;
}

/**
 * One rung of what this project calls its priority numbers.
 *
 * Structurally {@link PriorityBand} from `libs/domain`, and named apart for the
 * reason every other `…View` in this file is: this is the shape on the wire, and
 * the day be-01 sends a field the domain type does not carry, the two must be
 * free to differ. The resolution rules — `priorityBandRankOf`,
 * `priorityLadderProblem` — are the domain's and are imported rather than
 * re-typed, because a second copy of "which band holds 25" is a second answer.
 */
export type PriorityBandView = PriorityBand;

/**
 * Whether the assignee is a human being or an AI agent.
 *
 * Two arms and no third, the same closed set be-01 checks in
 * `DirectoryService`: a value outside it is `invalid_kind`, a **400**, and this
 * type is what keeps the page from ever sending one.
 *
 * Named `…View` like everything else here because it is the shape on the wire,
 * and structurally be-01's `PersonKind` rather than an import of it: fe-01 does
 * not depend on the backend's repository types, and the day be-01 grows a third
 * arm this file is where the page learns of it.
 *
 * An array first and a type off it, {@link ESTIMATE_METHODS}' shape, because a
 * `<select>` hands its value back as a `string` and something has to narrow it.
 */
export const PERSON_KINDS = ['person', 'agent'] as const;
export type PersonKindView = (typeof PERSON_KINDS)[number];

/** Whether `value` is one of the two, for reading a `<select>`'s string back. */
export function isPersonKind(value: string): value is PersonKindView {
  return (PERSON_KINDS as readonly string[]).includes(value);
}

/** Somebody who does work, and the teams they belong to. Empty means a free agent. */
export interface PersonView {
  id: string;
  name: string;
  /**
   * **Required, and never defaulted here.**
   *
   * The column is `NOT NULL DEFAULT 'person'`, so every row that comes back out
   * of be-01 carries a kind whether or not anybody ever sent one — which is
   * exactly what makes "existing people render as `person` without a request"
   * (task 7.1) a fact about the read rather than a client-side fallback. A
   * `kind?: PersonKindView` with `?? 'person'` at the render would draw the
   * word `person` for a payload that said nothing, and the page would look
   * identical on the day be-01 stopped sending the field at all.
   */
  kind: PersonKindView;
  teamIds: string[];
}

/**
 * What removing a directory entry would do to one work item, as be-01 names it.
 *
 * Each arm names its kind **and what that kind does**, rather than a count
 * somebody would have to interpret. Mirrors `DirectoryEffect` in
 * `apps/be-01/src/service/directory-usage.ts`, which owns the rule; this is a
 * description of what arrives.
 */
export type DirectoryEffect =
  | { kind: 'assignment_dropped'; role: { id: string; name: string } }
  | { kind: 'label_nulled' }
  /**
   * The row carries the **tag** being removed, and will stop carrying it.
   *
   * Its own kind rather than `label_nulled`, because nothing is nulled: a tag
   * has no column on the work item to clear, and what goes is the labelling
   * row. It never appears beside a `capacity_released` — a tag has no pool —
   * and it is never named on a row that merely *inherits* the tag, because
   * losing an inherited tag moves no date and there is nothing to confirm.
   */
  | { kind: 'label_removed' }
  | {
      /**
       * The pool bounding this work item goes with the team, so its dates may
       * move earlier.
       *
       * Named on **inheriting** rows too, which is why it is a separate arm
       * from `label_nulled` rather than a field on it: a leaf under a labelled
       * parent holds no label to clear and its dates move exactly as the
       * labelled row's do. A confirmation carrying only `label_nulled` would
       * show one row and move twenty.
       */
      kind: 'capacity_released';
      /** How many of the team may be at work at once today — the bound that goes. */
      size: number;
      /**
       * The row whose label puts this one on the pool: this row itself, or the
       * nearest ancestor above it that carries the team.
       *
       * Equal to the row's own id exactly when the label is its own, so the
       * payload never says "inherited" twice.
       */
      fromId: string;
    }
  | {
      kind: 'assumed_assignee_changed';
      /**
       * The **assumed assignee**'s name, or `null` — and `null` means
       * `unassigned`. A removal that takes a work item's sole assignee names
       * the flip rather than leaving it to be inferred from an absence, which
       * is why the confirmation can print it without deriving anything.
       */
      assumedNow: string | null;
      assumedAfter: string | null;
    };

/** One work item a removal would touch, named as the plan shows it. */
export interface UsedWorkItem {
  id: string;
  /** The derived number the plan shows — `3.1`, never a row index. */
  number: string;
  name: string;
  effects: DirectoryEffect[];
}

export interface UsedProject {
  id: string;
  name: string;
  workItems: UsedWorkItem[];
}

/**
 * **Directory usage**: what removing a person or a service team would take with
 * it, named rather than counted.
 *
 * Both halves are always present and never optional. A confirmation reading
 * `usage.members` has to be able to tell "nobody" from "this payload does not
 * say", and an absent key says the second while meaning the first — which is
 * why {@link isDirectoryUsage} refuses a body missing either.
 */
export interface DirectoryUsage {
  projects: UsedProject[];
  members: { id: string; name: string }[];
}

/**
 * What came of asking for a person or a service team to be removed.
 *
 * `in_use` is a **modeled answer** rather than a thrown code, for the reason
 * {@link RoleRemoval}'s is: the usage riding along with it is the whole value of
 * the refusal, and {@link send} throws the `error` field and drops every field
 * beside it. The next request is the same one with the cascade, and nobody can
 * agree to that without being shown what it takes.
 */
export type DirectoryRemoval =
  | { ok: true }
  | { ok: false; reason: 'in_use'; usage: DirectoryUsage };

/**
 * What came of renaming a person or a service team, or editing memberships.
 *
 * `taken` is modeled for the same reason and a second one: it carries the
 * **surviving** name — the one the row that already holds it keeps — and a
 * sentence built from what was typed would read `“ Kat ”` where be-01 kept
 * `Kat`. Every other refusal throws its code, which
 * {@link directoryRefusalSentence} turns into a sentence.
 */
export type DirectoryWrite<T> =
  | { ok: true; entry: T }
  | { ok: false; reason: 'taken'; survivingName: string };

/**
 * The parts of a person a patch may change.
 *
 * An absent `teamIds` leaves the memberships alone and an empty one makes a
 * **free agent** — be-01 tells the two apart, so this type must not collapse
 * them into one optional array with a default.
 */
export interface PersonPatch {
  name?: string;
  /**
   * Marks somebody a person or an agent. Absent leaves the classification
   * alone, exactly as an absent `name` leaves the name alone.
   *
   * Typed as the closed set rather than `string`, which is where this differs
   * from be-01's own `PersonPatchInput`: the controller takes a `string` on
   * purpose, so that a value outside the set reaches the service and is refused
   * as `invalid_kind` rather than being turned away by the framework's
   * validator (4.4). Nothing on this page can produce such a value — the
   * control offers two options — so the narrow type here costs nothing and
   * makes a third arm a compile error rather than a 400.
   */
  kind?: PersonKindView;
  teamIds?: readonly string[];
}

/**
 * The parts of a team a patch may change.
 *
 * {@link PersonPatch}'s shape and its rule about absence, one entity over: an
 * absent `serviceIds` leaves the **ownership map** alone and an empty one makes
 * a team that owns nothing. be-01 tells those two apart inside its own write
 * transaction, so this type must not collapse them into one array with a
 * default.
 *
 * `serviceIds` is the whole set as it will stand, not a delta — it is the same
 * full-replacement bargain `teamIds` makes, and for the same reason: a delta
 * needs the client to know what it is diffing against, and this page redraws
 * from a directory somebody else may have changed.
 *
 * This is directory data **about a team**, not a label on anybody's work: it
 * says which services the team is responsible for, which is what makes a row
 * built by a non-owner nameable at all (Dany, 2026-08-20 23:18).
 */
export interface TeamPatch {
  name?: string;
  serviceIds?: readonly string[];
}

/**
 * The deployment's directory, and everything the directory page does to it.
 *
 * Separate from {@link ProjectApi} because it belongs to no project: these four
 * reads are the same on every page, and `httpProjectApi`'s own directory
 * methods delegate here so each call has exactly one spelling.
 */
export interface DirectoryApi {
  listPeople(): Promise<PersonView[]>;
  listTeams(): Promise<TeamView[]>;
  /** Every tag in the global directory, by name. */
  listTags(): Promise<TagView[]>;
  /** Every service in the global directory, by name. */
  listServices(): Promise<ServiceView[]>;
  addTag(name: string): Promise<TagView>;
  renameTag(tagId: string, name: string): Promise<DirectoryWrite<TagView>>;
  /**
   * Removes a tag. Without `cascade` a tag anything carries is refused with the
   * usage naming what would be unlabelled — `removeTeam`'s shape, and the same
   * 409-then-confirm gesture.
   */
  removeTag(tagId: string, cascade: boolean): Promise<DirectoryRemoval>;
  /**
   * Adds a service, idempotent by name at be-01.
   *
   * Read-only on the plan page until 2026-08-23, when Dany made the service
   * cell search-or-add like Tags; the cell now creates through here.
   */
  addService(name: string): Promise<ServiceView>;
  renameService(serviceId: string, name: string): Promise<DirectoryWrite<ServiceView>>;
  /**
   * Removes a service — `removeTag`'s shape exactly, and since task 10.2 that
   * is literal rather than analogous: the removal takes labelling **rows** off
   * `work_item_service` and nulls no column, so its usage arrives as
   * `label_removed` like a tag's and not as the `label_nulled` a team's does.
   *
   * The `team_service` rows it also takes are deliberately **absent** from that
   * usage (design.md D7): losing an ownership claim about a service that is
   * going is not an effect on any plan.
   */
  removeService(serviceId: string, cascade: boolean): Promise<DirectoryRemoval>;
  /** Adds a person; no teams means a **free agent**. Idempotent by name at be-01. */
  addPerson(name: string, teamIds: readonly string[]): Promise<PersonView>;
  addTeam(name: string): Promise<TeamView>;
  /**
   * Renames a person, marks them a person or an agent, sets exactly the teams
   * they belong to, or any of those at once — one method for the one route,
   * `patchTeam`'s standing argument.
   */
  patchPerson(id: string, patch: PersonPatch): Promise<DirectoryWrite<PersonView>>;
  /**
   * Renames a team, or sets exactly the services it is responsible for, or
   * both — `patchPerson`'s shape, and **one** spelling for the one route
   * be-01 offers.
   *
   * It was `renameTeam(id, name)` until task 7.5's ownership picker needed the
   * other field. A second method beside it would have been two ways to write
   * `PATCH /api/teams/:id`, which is how a page and a picker come to disagree
   * about what a team is — this client's own standing argument.
   */
  patchTeam(id: string, patch: TeamPatch): Promise<DirectoryWrite<TeamView>>;
  /**
   * Removes a person, or answers the **directory usage** that would go with
   * them.
   *
   * Called first without a cascade, always: be-01 removes an entry nothing
   * points at outright and refuses one that is used, with its usage. `cascade`
   * is the caller saying it has shown that usage to somebody and been told to
   * go on.
   */
  removePerson(id: string, cascade: boolean): Promise<DirectoryRemoval>;
  removeTeam(id: string, cascade: boolean): Promise<DirectoryRemoval>;
}

export interface DeleteOptions {
  strategy?: 'cascade' | 'promote';
}

/**
 * What came of walking one step along the undo stack.
 *
 * A refusal is a **modeled answer** rather than a thrown error, because both
 * of them are ordinary states of a shared plan rather than faults: a stack
 * with nothing left in it, and a change somebody else has since written over.
 * A network failure still throws — that is the caller's to report as a failed
 * request, and it says nothing about the stack.
 */
export type UndoResult =
  | {
      ok: true;
      /** What was reversed, as be-01 phrased it: `rename “Strip”`. */
      done: string;
      /** What could not be put back exactly, or null when everything was. */
      detail: string | null;
    }
  | {
      ok: false;
      reason: 'nothing_to_undo' | 'stale_undo';
      /** Which change stood in the way, for `stale_undo`. */
      detail: string | null;
    };

/**
 * One project as the picker offers it — what fe-01 **reads** of a list entry.
 *
 * A subset, deliberately: `GET /api/projects` sends the whole project row plus
 * the owner's name, and the owner id, estimate method and revision are all on
 * the wire and none of them are on this screen. Naming only what is read is
 * the honest version, and it is not a description of the wire —
 * nobody should later read this as be-01's contract and delete a field from
 * the query to make the two match. `startDate` is the one wire field this now
 * reads beyond the entry's own meta: the hover card prints it, and it is the
 * only project field cheap enough to be worth it — everything else the card
 * might show (phase counts, last *modified*) is not on this wire at all.
 *
 * Separate from {@link CreatedProject} because the two routes answer different
 * things: one type standing for both is how `createProject` came to declare a
 * `lastOpenedAt` the create route has never sent.
 */
export interface ProjectListEntry {
  id: string;
  name: string;
  restricted: boolean;
  /** When this account last opened it, or null if it never has. */
  lastOpenedAt: number | null;
  /** The username of the account that owns it — the first half of the entry meta. */
  ownerName: string;
  /**
   * The calendar day the plan begins, or null while it is not on a calendar.
   *
   * On the wire already (see the type's head comment) and read here for the
   * hover card alone: the picker entry itself never prints it, only the card.
   */
  startDate: string | null;
  /**
   * When the project was made, as an **epoch millisecond**.
   *
   * An instant rather than a calendar day, which is what decides the formatter:
   * `shortInstant` prints it in the reader's own zone, and `shortIsoDate` — the
   * table's Start, End and Not before cells — is for the zone-free days a plan
   * is made of. See `components/wbs/short-date.ts`.
   */
  createdAt: number;
}

/**
 * A project as the create route answers with it — again, what fe-01 reads.
 *
 * No `lastOpenedAt`: create writes the project and answers with it, and an
 * account's navigation history is not part of a row that has just come into
 * being. The page selects the id and reloads the list, which is where the
 * fuller entry comes from.
 */
export interface CreatedProject {
  id: string;
  name: string;
  restricted: boolean;
}

/**
 * Everything the table does to a project.
 *
 * An interface rather than bare functions so the table can be driven by a fake
 * in tests: the keyboard behaviour is the part worth proving, and asserting it
 * through a real fetch would test the network instead.
 */
export interface ProjectApi {
  /**
   * Every project, in this account's own order: opened first by recency, then
   * never-opened by creation date. The order is be-01's and is used as given —
   * sorting again on the client would be a second implementation of the rule,
   * and the two would eventually disagree.
   */
  listProjects(): Promise<ProjectListEntry[]>;
  createProject(name: string): Promise<CreatedProject>;
  /** Records this account as having opened the project, which is what sorts the picker. */
  openProject(id: string): Promise<void>;
  /** Renames the project. be-01 answers `forbidden` on a restricted one. */
  renameProject(id: string, name: string): Promise<void>;
  /**
   * The project's work items, and the event sequence they were read at.
   *
   * The sequence is what a socket resumes from, so it belongs to the read that
   * produced the rows: taken separately it would describe a different moment
   * than the tree on screen.
   */
  tree(projectId: string): Promise<{
    workItems: WorkItemView[];
    seq: number;
    scheduleError: 'cycle' | null;
    /**
     * Every slice the schedule placed, in be-01's own order — what the chart
     * draws, where the rows carry the spans the columns show.
     *
     * Empty when `scheduleError` says the plan could not be scheduled at all,
     * exactly as the rows' dates go: bars from a plan that no longer computes
     * would be the same stale lie in a different shape.
     */
    slices: SliceView[];
    /**
     * The phases the slices above were placed under, in the engine's own order.
     *
     * The same list {@link ProjectApi.roles} answers with, carried here so that
     * a chart drawn from this read never has to pair it with another one. Both
     * are needed and they are not the same fact: this one describes **these**
     * slices, and the separate read is what the column headers and the phases
     * dialog edit.
     */
    roles: RoleView[];
    /**
     * The names of everybody an assignment on these rows points at.
     *
     * Not the directory — {@link ProjectApi.listPeople} is that, and the
     * pickers offer from it. This is who is on the plan that just arrived, so a
     * bar can be painted and labelled from one moment's answer.
     */
    assignedPeople: AssignedPersonView[];
    /**
     * How many of each team this plan may have at work at once, for the teams it
     * has stated a number about.
     *
     * Carried on the tree rather than fetched separately, and for a stronger
     * reason than `roles` has: the dates and bars in this very payload were
     * computed **from** these numbers, so a second request at a second moment
     * could put a capacity on screen that does not explain the bars beside it.
     *
     * A team with no entry is _unstated_ and bounds nothing. Which teams the plan
     * is labelled with is a different question, answered by the rows — see
     * `effectiveTeamOf`.
     */
    teamCapacities: TeamCapacityView[];
    /**
     * What this project calls its priority numbers — five rungs, most important
     * first.
     *
     * Always five and never empty: a project that has never been configured reads
     * as be-01's `DEFAULT_PRIORITY_BANDS`, so every priority on this plan resolves
     * to exactly one label without this client holding a fallback of its own.
     *
     * **No date in this payload was computed from it.** The ladder names the
     * numbers; the leveller orders on the numbers. What it does drive is every
     * face — the Prio cell, the chart's bars, the cards and the export all read
     * their label and their colour through the one resolution in
     * `priority-band-style.ts`.
     */
    priorityBands: PriorityBandView[];
    estimateMethod: EstimateMethod;
    startDate: string | null;
    /**
     * The project row's own revision: its name, restriction, estimate method,
     * start date and roles. It does not move when a work item does — each
     * carries its own.
     */
    projectRevision: number;
    /**
     * Whether **this account** has anything to undo or redo on this project.
     *
     * Carried on the tree rather than asked for separately: the tree is
     * already reread after every change this client makes and every event from
     * anybody else, which is exactly when these can have moved. A second
     * endpoint would be a second round trip at the same moments.
     */
    undoable: boolean;
    redoable: boolean;
  }>;
  /**
   * Reverses this account's last change to the project, **if nothing it
   * touched has been written to since**.
   *
   * be-01 owns the condition and the wording of what it did; this is a
   * description of what comes back. A refused step also discards the entry it
   * refused, so the caller reads the tree again afterwards either way.
   */
  undo(projectId: string): Promise<UndoResult>;
  /** Puts back what {@link ProjectApi.undo} took away, under the same condition. */
  redo(projectId: string): Promise<UndoResult>;
  /** Changes how the project turns its three-point estimates into one number. */
  setEstimateMethod(projectId: string, method: EstimateMethod): Promise<void>;
  /** Puts the plan on a calendar, or `null` to take it off again. */
  setStartDate(projectId: string, startDate: string | null): Promise<void>;
  /**
   * States how many of one team may be at work at once on this plan, or clears it
   * to unstated on `null`.
   *
   * `PUT`, because the body carries the whole of the fact and the same request
   * twice is the same state — be-01's shape, and the reason is on its route.
   *
   * The number is **not** validated here. `capacity-per-project` owns what it may
   * be, at be-01's boundary, and a second copy of that rule in this client is a
   * rule free to disagree with it — so `0`, `-1`, `1.5` and `1001` are all sent
   * and answered on. The two things the caller decides, because be-01 cannot see
   * them, are what an *empty box* means and that a non-finite draft is not sent;
   * both are argued in `teams-dialog.tsx` and were C3's D6 before that.
   */
  setTeamCapacity(projectId: string, teamId: string, size: number | null): Promise<void>;
  /**
   * Replaces what this project calls its priority numbers — the whole ladder, in
   * one request.
   *
   * **All five rungs, never one.** Contiguity is a fact about the five together,
   * so a per-rung write would have to pass through states in which the ladder is
   * not one. be-01's shape, and the argument is on its route.
   *
   * The ladder is **not** validated here. `priorityLadderProblem` in
   * `libs/domain` is the one guard and be-01's controller is its one caller, so a
   * default outside its own band or a cut below the one beneath it is sent and
   * answered on — the bargain `setTeamCapacity` makes one fact along.
   */
  setPriorityBands(projectId: string, bands: readonly PriorityBandView[]): Promise<void>;
  roles(projectId: string): Promise<RoleView[]>;
  /** Adds a phase to the project. Throws `taken` when the name is already one. */
  addRole(projectId: string, name: string): Promise<RoleView>;
  renameRole(projectId: string, roleId: string, name: string): Promise<RoleView>;
  /**
   * Removes a phase, or answers what it would take.
   *
   * Called first without a cascade, always: be-01 removes a phase nothing points
   * at outright and refuses one that is used, with its counts. `cascade` is the
   * caller saying it has shown those counts to somebody and been told to go on.
   */
  removeRole(projectId: string, roleId: string, cascade: boolean): Promise<RoleRemoval>;
  create(
    projectId: string,
    input: { parentId: string | null; afterId: string | null; name?: string },
  ): Promise<{ id: string }>;
  patch(
    id: string,
    patch: {
      name?: string;
      notes?: string;
      startNoEarlierThan?: string | null;
      /**
       * Why the work is held back, `null` to take the words off, or absent to
       * leave them.
       *
       * Refused with a 400 (`not_before_reason_needs_a_date`) when the row would
       * be left holding words with no date for them to be about — so **clearing
       * the date means clearing this in the same request**. A blank is stored as
       * no reason; at most 200 characters.
       */
      startNoEarlierThanReason?: string | null;
      /** An integer of 1 or more, or `null` to leave the work with no priority. */
      priority?: number | null;
      /**
       * An integer from 1 to 1000, or `null` to put it back to one at a time.
       *
       * Refused with a 400 on a work item that has children: a parent holds no
       * slices of its own, so a parallelism on it would be a number that
       * schedules nothing.
       */
      maxParallel?: number | null;
      serviceTeamId?: string | null;
      /**
       * The tags this row will carry, **whole** — the set as it will stand,
       * never a member to add or a delta to apply.
       *
       * `[]` takes every tag off and is the one spelling of that; absent leaves
       * them alone. There is no `null` arm, because there is no column to reset
       * and no third "deliberately untagged" state.
       *
       * Refused with a 404 (`unknown_tag`) for an id the directory no longer
       * holds — the out-of-date picker, decided inside be-01's own write
       * transaction. At most 50 ids.
       */
      tagIds?: readonly string[];
      /**
       * The services this row delivers, **whole**: the set as it will stand, not
       * a delta against the one that is there.
       *
       * No `null` arm, and `tagIds`' rule rather than its own since task 10.2:
       * the store is `work_item_service` and not a nullable column (D2 as
       * amended), so "no services" is the empty array and a null would be a
       * second spelling of it. Absent leaves the dimension alone — which is why
       * the cell that clears it sends `[]` rather than omitting the field.
       *
       * Refused with a 404 (`unknown_service`) for an id the directory does not
       * carry — the **whole** patch, rename included — decided inside be-01's own
       * write transaction, `unknown_tag`'s rule one dimension over. At most 10
       * ids.
       */
      serviceIds?: readonly string[];
    },
  ): Promise<void>;
  /** The global team list, and adding to it — idempotent by name at be-01. */
  listTeams(): Promise<TeamView[]>;
  /** Every tag in the global directory, by name. */
  listTags(): Promise<TagView[]>;
  /**
   * Every service in the global directory, by name.
   *
   * Add was read-only here between task 7.5 and 2026-08-23: the plan page read
   * the vocabulary for its picker but only the directory page changed it. Dany
   * reversed that ("services ... search or add"), so the plan cell creates
   * through {@link addService} exactly as the tag cell creates through
   * {@link addTag}.
   */
  listServices(): Promise<ServiceView[]>;
  /** Adds a service — `addTag`'s shape. Idempotent by name at be-01. */
  addService(name: string): Promise<ServiceView>;
  addTag(name: string): Promise<TagView>;
  renameTag(tagId: string, name: string): Promise<DirectoryWrite<TagView>>;
  /**
   * Removes a tag. Without `cascade` a tag anything carries is refused with the
   * usage naming what would be unlabelled — `removeTeam`'s shape, and the same
   * 409-then-confirm gesture.
   */
  removeTag(tagId: string, cascade: boolean): Promise<DirectoryRemoval>;
  addTeam(name: string): Promise<TeamView>;
  listPeople(): Promise<PersonView[]>;
  /** Adds a person; no teams means a free agent. */
  addPerson(name: string, teamIds: readonly string[]): Promise<PersonView>;
  /** Sets or (with `null`) clears who does one work item's work for one role. */
  assign(workItemId: string, roleId: string, personId: string | null): Promise<void>;
  move(id: string, parentId: string | null, afterId: string | null): Promise<void>;
  /**
   * Copies a work item and everything under it, as the next sibling of the
   * original, answering the copy's id.
   *
   * One call rather than a create per row: be-01 writes the whole branch in one
   * transaction, so nobody watching ever sees half a copy, and the copied
   * dependencies point at the copies. What is and is not carried over — no
   * frozen numbers, no edges leaving the branch — is be-01's rule, stated in
   * `openspec/changes/duplicate-subtree/`.
   */
  duplicate(id: string): Promise<{ id: string }>;
  remove(id: string, options?: DeleteOptions): Promise<void>;
  setEstimate(id: string, roleId: string, days: Days): Promise<void>;
  /**
   * Takes one work item's stored trio for one role back off.
   *
   * Idempotent at be-01, which is what lets the table call it from a gesture —
   * emptying three boxes — rather than from a button that has to know whether
   * there is anything there to remove.
   */
  clearEstimate(id: string, roleId: string): Promise<void>;
  freeze(projectId: string): Promise<void>;
  unfreezeProject(projectId: string): Promise<void>;
  unfreeze(id: string): Promise<void>;
  /**
   * Records "`predecessorId`'s **anchor** must finish before this starts" —
   * its first role somebody estimated, not the whole of it. The roles behind
   * that anchor run alongside this work item. Since `dep-waits-on-first-role`
   * (2026-08-11); the edge itself is unchanged, only what it means.
   */
  addDependency(id: string, predecessorId: string): Promise<void>;
  removeDependency(id: string, predecessorId: string): Promise<void>;
}

/** The header the edge does not read; see `lib/api.ts` for why it is never `Authorization`. */
const auth = (token: string) => ({ 'content-type': 'application/json', 'x-wbs-token': token });

async function send<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: auth(token) });
  const text = await res.text();
  if (!res.ok) {
    let code = `http_${String(res.status)}`;
    try {
      code = (JSON.parse(text) as { error?: string }).error ?? code;
    } catch {
      // A proxy error page rather than our JSON — the status is all there is.
    }
    throw new Error(code);
  }
  return (text === '' ? null : JSON.parse(text)) as T;
}

/**
 * One step along the undo stack, with be-01's two refusals read out of the 409
 * rather than turned into a thrown code.
 *
 * `send` throws the `error` field for every non-2xx, which loses the `detail`
 * beside it — and the detail is the whole value of a `stale_undo`: it names the
 * change that stood in the way. Anything that is not one of the two modeled
 * refusals still throws, through the same path as every other call.
 */
async function stepStack(path: string, token: string): Promise<UndoResult> {
  const res = await fetch(path, { method: 'POST', headers: auth(token) });
  const text = await res.text();
  if (res.status === 409) {
    const body = JSON.parse(text) as { error?: string; detail?: string | null };
    if (body.error === 'nothing_to_undo' || body.error === 'stale_undo') {
      return { ok: false, reason: body.error, detail: body.detail ?? null };
    }
  }
  if (!res.ok) {
    let code = `http_${String(res.status)}`;
    try {
      code = (JSON.parse(text) as { error?: string }).error ?? code;
    } catch {
      // A proxy error page rather than our JSON — the status is all there is.
    }
    throw new Error(code);
  }
  const body = JSON.parse(text) as { done: string; detail: string | null };
  return { ok: true, done: body.done, detail: body.detail };
}

/**
 * Removes a phase, reading be-01's `in_use` counts out of the 409 instead of
 * throwing the code alone.
 *
 * The same shape as {@link stepStack} and for the same reason: `send` throws the
 * `error` field and loses everything beside it, and here everything beside it is
 * what the confirmation is made of. Any other 409 — there is none today — still
 * throws through the ordinary path rather than being read as a refusal this
 * client understands.
 */
async function removeRoleAt(path: string, token: string): Promise<RoleRemoval> {
  const res = await fetch(path, { method: 'DELETE', headers: auth(token) });
  const text = await res.text();
  if (res.status === 409) {
    const body = JSON.parse(text) as { error?: string; inUse?: RoleUsage };
    // Both halves are asked for. A refusal claiming to be `in_use` with no
    // counts in it is a be-01 that has changed shape, and confirming a cascade
    // from an empty confirmation is exactly the unknown this repository refuses
    // to default through.
    //
    // Proof, both watched 2026-08-09. This branch deleted so the 409 falls to
    // the throw below: `reads the counts out of the refusal rather than throwing
    // the code` failed on `promise rejected "Error: in_use" instead of
    // resolving`. The `inUse !== undefined` half dropped: `throws an in_use with
    // no counts rather than confirming against nothing` failed on `promise
    // resolved "{ ok: false, reason: 'in_use', …(1) }" instead of rejecting`.
    if (body.error === 'in_use' && body.inUse !== undefined) {
      return { ok: false, reason: 'in_use', inUse: body.inUse };
    }
  }
  if (!res.ok) {
    let code = `http_${String(res.status)}`;
    try {
      code = (JSON.parse(text) as { error?: string }).error ?? code;
    } catch {
      // A proxy error page rather than our JSON — the status is all there is.
    }
    throw new Error(code);
  }
  return { ok: true };
}

/**
 * What a refused phase change says out loud.
 *
 * be-01's codes are the vocabulary everywhere else in this client — `cycle` and
 * `forbidden` reach a toast as themselves — and phases are the exception on
 * purpose: these are refusals aimed at somebody typing a name into a box, not at
 * somebody reading a plan, and `taken` in the corner of the screen is a word
 * about HTTP rather than about their project.
 *
 * `Partial` would make every read a `string | undefined` with a fallback
 * invented at each call site, which is how two spellings of one refusal happen;
 * this takes the code as a string and answers for anything, so there is one
 * fallback and it is here.
 */
export function roleRefusalSentence(code: string): string {
  switch (code) {
    case 'taken':
      return 'That name is already a phase on this plan.';
    case 'name_required':
      return 'A phase needs a name.';
    case 'in_use':
      return 'That phase still holds estimates or assignments on this plan.';
    case 'unknown_role':
      return 'That phase is no longer on this plan — somebody else removed it.';
    case 'not_found':
      return 'That phase is no longer on this plan.';
    case 'forbidden':
      return 'This plan is not yours to change.';
    default:
      return `The phase could not be changed (${code}).`;
  }
}

/** A JSON object, as far as anything read off the wire can be said to be one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A name or the absence of one — `null` is a value here, `undefined` is a missing field. */
function isNameOrNobody(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNamed(value: unknown): value is { id: string; name: string } {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string';
}

/**
 * One arm of {@link DirectoryEffect}, as it really arrives.
 *
 * Every arm the type declares is answered here, and the reason is a defect
 * found on dev 2026-08-21: this guard knew three of five, so a tag or a service
 * that labelled any row came back from be-01 with a correct
 * `409 in_use`+`usage`, failed the parse on its one `label_removed`, and fell
 * through to the throw below — the generic refusal banner, no confirmation
 * dialog, and therefore no way to reach the `?cascade=true` second ask. An
 * entry nothing could remove, from a payload nothing was wrong with.
 *
 * `capacity_released` was unknown to it too and had simply never been sent by a
 * case: a team on a project carrying a capacity would have been as unremovable
 * as the tag. `directory-page.tsx` has had a sentence for both arms since each
 * landed — the page could always *say* it, this could never *read* it.
 *
 * The arms are answered in the order the type declares them, and
 * `wbs-api.test.ts` sends one payload per arm off a `Record` keyed by the
 * union's own `kind`, so a sixth arm fails the typecheck there until it is
 * given one.
 */
function isDirectoryEffect(value: unknown): value is DirectoryEffect {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'label_nulled') return true;
  if (value['kind'] === 'label_removed') return true;
  if (value['kind'] === 'capacity_released') {
    // Both fields checked, because the sentence prints both: a `size` that
    // arrived as a string would reach the page as "no longer limited to 4 at a
    // time" spelled from something that is not a number, and a missing
    // `fromId` would take the inherited-limit sentence's whole subject with it.
    return typeof value['size'] === 'number' && typeof value['fromId'] === 'string';
  }
  if (value['kind'] === 'assignment_dropped') return isNamed(value['role']);
  if (value['kind'] === 'assumed_assignee_changed') {
    // Both, and present: `undefined` fails this, so a payload that dropped the
    // flip's "after" cannot be drawn as a flip to nobody.
    return isNameOrNobody(value['assumedNow']) && isNameOrNobody(value['assumedAfter']);
  }
  return false;
}

function isUsedWorkItem(value: unknown): value is UsedWorkItem {
  if (!isRecord(value)) return false;
  const effects = value['effects'];
  if (!Array.isArray(effects)) return false;
  // `id` and `name` are checked here rather than through `isNamed`, which would
  // narrow `value` to exactly those two and put `number` and `effects` beyond
  // reach of the compiler.
  const each: unknown[] = effects;
  return (
    typeof value['id'] === 'string' &&
    typeof value['number'] === 'string' &&
    typeof value['name'] === 'string' &&
    each.every(isDirectoryEffect)
  );
}

function isUsedProject(value: unknown): value is UsedProject {
  if (!isRecord(value)) return false;
  const workItems = value['workItems'];
  if (!Array.isArray(workItems)) return false;
  const each: unknown[] = workItems;
  return (
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    each.every(isUsedWorkItem)
  );
}

/**
 * Whether a 409's `usage` is the whole **directory usage** this client draws a
 * confirmation from.
 *
 * The whole shape, not a probe: `projects` and `members` both present, every
 * work item carrying the `number` and `name` the confirmation prints and the
 * `effects` it explains them by. A confirmation drawn from a payload this page
 * could only half read asks somebody to approve a cascade they were never
 * shown, which is the unknown this repository refuses to default through.
 */
export function isDirectoryUsage(value: unknown): value is DirectoryUsage {
  if (!isRecord(value)) return false;
  const projects = value['projects'];
  const members = value['members'];
  if (!Array.isArray(projects) || !Array.isArray(members)) return false;
  const eachProject: unknown[] = projects;
  const eachMember: unknown[] = members;
  return eachProject.every(isUsedProject) && eachMember.every(isNamed);
}

/** be-01's `error` field, or the status when the body was somebody else's error page. */
function refusalCodeIn(text: string, status: number): string {
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && typeof body['error'] === 'string') return body['error'];
  } catch {
    // A proxy error page rather than our JSON — the status is all there is.
  }
  return `http_${String(status)}`;
}

/**
 * Removes a person or a team, reading the **directory usage** out of the 409
 * rather than throwing the code alone.
 *
 * The same shape as {@link removeRoleAt} and for the same reason: `send` throws
 * the `error` field and loses everything beside it, and here everything beside
 * it is what the confirmation is made of.
 *
 * A 409 claiming `in_use` whose usage this client cannot read whole falls
 * through to the throw below **on purpose**. Proof, both watched 2026-08-09:
 * with the `isDirectoryUsage` half dropped, `throws an in_use with no usage
 * rather than confirming against nothing` failed on `promise resolved
 * "{ ok: false, reason: 'in_use', …(1) }" instead of rejecting`; with the whole
 * branch deleted, `reads the usage out of the refusal rather than throwing the
 * code` failed on `promise rejected "Error: in_use" instead of resolving`.
 */
async function removeDirectoryAt(path: string, token: string): Promise<DirectoryRemoval> {
  const res = await fetch(path, { method: 'DELETE', headers: auth(token) });
  const text = await res.text();
  if (res.status === 409) {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && body['error'] === 'in_use' && isDirectoryUsage(body['usage'])) {
      return { ok: false, reason: 'in_use', usage: body['usage'] };
    }
  }
  if (!res.ok) throw new Error(refusalCodeIn(text, res.status));
  return { ok: true };
}

/**
 * Renames a directory entry — or edits a person's memberships — reading
 * `taken`'s **surviving name** out of the 409 instead of throwing the code.
 *
 * `send` would throw `taken` and lose the name beside it, and that name is what
 * the sentence is made of: somebody who typed `‹space›Kat‹space›` against a
 * held `Kat` has to be told which spelling survived, and the local draft cannot
 * say. Every other refusal throws its code for
 * {@link directoryRefusalSentence} to phrase.
 *
 * @throws `unexpected_response` when a 2xx carries no entry — a panel drawn
 * from `undefined` is a row with no name, and that is not a state to default
 * into.
 */
async function writeDirectoryAt<T>(
  path: string,
  token: string,
  init: RequestInit,
  key: 'person' | 'team' | 'tag' | 'service',
): Promise<DirectoryWrite<T>> {
  const res = await fetch(path, { ...init, headers: auth(token) });
  const text = await res.text();
  if (res.status === 409) {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && body['error'] === 'taken' && typeof body['name'] === 'string') {
      return { ok: false, reason: 'taken', survivingName: body['name'] };
    }
  }
  if (!res.ok) throw new Error(refusalCodeIn(text, res.status));
  const body = JSON.parse(text) as Partial<Record<'person' | 'team' | 'tag' | 'service', T>>;
  const entry = body[key];
  if (entry === undefined) throw new Error('unexpected_response');
  return { ok: true, entry };
}

/**
 * Why a directory write was refused, as this client has to phrase it.
 *
 * Two arms rather than a bare code, because `taken` is the one refusal that
 * carries a value: the name the directory kept. {@link directoryRefusedWith}
 * makes the other arm out of whatever was thrown.
 */
export type DirectoryRefusal =
  | { reason: 'taken'; survivingName: string }
  | { reason: 'refused'; code: string };

/** The refusal a thrown directory call amounts to, code and all. */
export function directoryRefusedWith(thrown: unknown): DirectoryRefusal {
  return { reason: 'refused', code: thrown instanceof Error ? thrown.message : 'request_failed' };
}

/**
 * The leader of be-01's over-the-ceiling refusal code, whose tail is the
 * ceiling itself — `size_must_be_at_most_1000` today.
 */
const SIZE_CEILING_CODE = 'size_must_be_at_most_';

/**
 * The leaders of be-01's two built refusal codes for a ladder, whose tails carry
 * the numbers themselves — `bands_must_number_5` and
 * `band_label_must_be_1_to_40_characters` today.
 *
 * Prefixes rather than literal cases for {@link SIZE_CEILING_CODE}'s reason:
 * be-01 builds both out of constants in `libs/domain`, and a `5` or a `40`
 * written out here would be a second copy free to drift from the rule that
 * refused the request.
 */
const BAND_COUNT_CODE = 'bands_must_number_';
const BAND_LABEL_CODE = 'band_label_must_be_';

/**
 * What any 5xx says, in this dialog's own words.
 *
 * `wbs-table.tsx`'s refusal helper has carried this arm since 2026-08-09, when
 * `http_500` reached the corner of the screen verbatim; `send` throws
 * `Error('http_502')` for a proxy error, so without it the grammatical fallback
 * below prints a wire code into a dialog somebody is typing a number into. The
 * sentence never says "the server did not answer", because something did.
 */
const SERVER_REFUSAL = 'The server could not save that. Try again.';

/**
 * What a refused **capacity** change says out loud.
 *
 * Its own function rather than an arm of {@link directoryRefusalSentence}, and
 * that is the whole of `capacity-per-project`'s move on this tier: the two size
 * arms used to live there, because the box lived on the directory page and the
 * number was the team's. It is the plan's number now, and every sentence here
 * says "on this plan" — which the directory's own refusals must not, because the
 * directory has no plan.
 *
 * The ceiling arm is a **prefix**, not a case, because be-01 builds the code out
 * of its own `MOST_PEOPLE_AT_ONCE`: a literal `size_must_be_at_most_1000` here
 * would be a second copy of that limit, free to drift from it and to fall back to
 * printing the wire code the day it did.
 *
 * One fallback, and it names the code rather than swallowing it: an unrecognised
 * refusal is something to report, and a message that hid it would leave nobody
 * able to say what be-01 answered. A 5xx is taken **before** it, because a proxy
 * error is not a word of be-01's and `(http_502)` in the corner of a dialog is
 * the defect `wbs-table.tsx` fixed for `http_500` a week ago.
 */
export function capacityRefusalSentence(code: string): string {
  if (/^http_5\d\d$/.test(code)) return SERVER_REFUSAL;
  if (code.startsWith(SIZE_CEILING_CODE)) {
    return `A plan can have at most ${code.slice(SIZE_CEILING_CODE.length)} of one team at work at once.`;
  }
  switch (code) {
    // The floor arm, spelled out rather than left to the fallback: this is a box
    // somebody types a *number* into, and `(size_must_be_a_whole_number_from_1)`
    // in the corner of the screen is a wire code where a sentence about their plan
    // belongs. A pool of nobody is a plan of infinite dates, which is why zero is
    // a refusal and an empty box is not.
    case 'size_must_be_a_whole_number_from_1':
      return 'How many of a team are at work at once is a whole number of 1 or more. Leave it empty for a team this plan does not limit.';
    case 'size_required':
      return 'That change asked for nothing, so nothing was sent.';
    case 'not_found':
      return 'That team or this plan is no longer there — somebody else removed it.';
    case 'forbidden':
      return 'This plan is restricted, so its capacities cannot be changed from this account.';
    case 'unexpected_response':
      return 'The server replied with something this page could not read.';
    default:
      return `That capacity could not be changed (${code}).`;
  }
}

/**
 * What a refused ladder change says out loud.
 *
 * {@link capacityRefusalSentence}'s sibling one dialog along, and here for its
 * reason: every one of these is aimed at somebody typing into a box on the
 * Priorities surface, and `band_default_must_be_inside_its_own_band` in the
 * corner of that surface is a wire code where a sentence about their ladder
 * belongs.
 *
 * The 5xx arm is taken **first**, which is C3's P2-2 and C5's R5 #18 and is
 * written here rather than rediscovered: a proxy error is not a word of be-01's,
 * and `(http_502)` beside a box somebody is typing in is the same defect a third
 * time.
 *
 * The count arm reads its number out of the code rather than printing a literal
 * `5`, because be-01 builds the code from `PRIORITY_BAND_COUNT` — a literal here
 * would be a second copy of that number, free to drift.
 */
export function priorityBandRefusalSentence(code: string): string {
  if (/^http_5\d\d$/.test(code)) return SERVER_REFUSAL;
  if (code.startsWith(BAND_COUNT_CODE)) {
    return `A priority ladder has exactly ${code.slice(BAND_COUNT_CODE.length)} bands — one cannot be added or taken away.`;
  }
  if (code.startsWith(BAND_LABEL_CODE)) {
    return `A band's name is ${code.slice(BAND_LABEL_CODE.length).replace(/_/g, ' ')}.`;
  }
  switch (code) {
    case 'first_band_must_start_at_1':
      return 'The most important band has to start at 1, or the priorities below it would have no name.';
    case 'bands_must_start_in_increasing_order':
      return 'Each band has to start above the one before it, so every number belongs to exactly one of them.';
    case 'band_start_must_be_a_whole_number_from_1':
      return 'A band starts at a whole number of 1 or more.';
    case 'band_default_must_be_a_whole_number_from_1':
      return 'The number a band writes is a whole number of 1 or more.';
    case 'band_default_must_be_inside_its_own_band':
      return 'The number a band writes has to fall inside that band, or picking its name would land on a different one.';
    case 'band_labels_must_differ':
      return 'Two bands cannot share a name — one of the two would do nothing anybody could predict.';
    case 'not_found':
      return 'This plan is no longer there — somebody else removed it.';
    case 'forbidden':
      return 'This plan is restricted, so its priority bands cannot be changed from this account.';
    case 'unexpected_response':
      return 'The server replied with something this page could not read.';
    default:
      return `Those priority bands could not be saved (${code}).`;
  }
}

/**
 * What a refused directory change says out loud.
 *
 * {@link roleRefusalSentence}'s sibling, and here for the same reason: these
 * refusals are aimed at somebody typing a name into a box, and `taken` in the
 * corner of the screen is a word about HTTP rather than about their directory.
 *
 * The `taken` sentence is built from the **surviving** name the refusal carried
 * — never from what was typed. be-01 trims, so a `‹space›Kat‹space›` typed
 * against a held `Kat` collides with `Kat`, and a sentence made of the local
 * draft would quote a name nobody's directory holds.
 *
 * One fallback, and it names the code rather than swallowing it: an
 * unrecognised refusal is something to report, and a message that hid it would
 * leave nobody able to say what be-01 answered.
 */
export function directoryRefusalSentence(refusal: DirectoryRefusal): string {
  if (refusal.reason === 'taken') {
    return `“${refusal.survivingName}” is already in the directory, so nothing was renamed.`;
  }
  switch (refusal.code) {
    case 'name_required':
      return 'A name cannot be blank.';
    case 'unknown_team':
      return 'One of those teams is no longer in the directory — somebody else removed it.';
    case 'not_found':
      return 'That entry is no longer in the directory — somebody else removed it.';
    case 'nothing_to_change':
      return 'That change asked for nothing, so nothing was sent.';
    case 'unexpected_response':
      return 'The server replied with something this page could not read.';
    default:
      return `The directory could not be changed (${refusal.code}).`;
  }
}

/**
 * The deployment's directory over HTTP.
 *
 * The one spelling of these calls. `httpProjectApi`'s four directory
 * methods delegate here rather than repeating the paths, because two copies of
 * `/api/people` is how a page and a picker come to disagree about what a person
 * is.
 */
export function httpDirectoryApi(token: string): DirectoryApi {
  return {
    async listPeople() {
      const body = await send<{ people: PersonView[] }>('/api/people', token);
      return body.people;
    },
    async listTeams() {
      const body = await send<{ teams: TeamView[] }>('/api/teams', token);
      return body.teams;
    },
    async addPerson(name, teamIds) {
      const body = await send<{ person: PersonView }>('/api/people', token, {
        method: 'POST',
        body: JSON.stringify({ name, teamIds }),
      });
      return body.person;
    },
    async addTeam(name) {
      const body = await send<{ team: TeamView }>('/api/teams', token, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return body.team;
    },
    patchPerson(id, patch) {
      return writeDirectoryAt<PersonView>(
        `/api/people/${id}`,
        token,
        { method: 'PATCH', body: JSON.stringify(patch) },
        'person',
      );
    },
    patchTeam(id, patch) {
      return writeDirectoryAt<TeamView>(
        `/api/teams/${id}`,
        token,
        { method: 'PATCH', body: JSON.stringify(patch) },
        'team',
      );
    },
    // The tag half, and it is the team half with the word changed. Global —
    // no project in any of these paths, exactly as the teams are.
    async listTags() {
      const body = await send<{ tags: TagView[] }>('/api/tags', token);
      return body.tags;
    },
    // The service half, and it is the tag half with the word changed —
    // `/api/services` is global exactly as `/api/tags` is, with no project in
    // any of these four paths.
    async listServices() {
      const body = await send<{ services: ServiceView[] }>('/api/services', token);
      return body.services;
    },
    async addService(name) {
      const body = await send<{ service: ServiceView }>('/api/services', token, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return body.service;
    },
    renameService(id, name) {
      return writeDirectoryAt<ServiceView>(
        `/api/services/${id}`,
        token,
        { method: 'PATCH', body: JSON.stringify({ name }) },
        'service',
      );
    },
    removeService(id, cascade) {
      return removeDirectoryAt(`/api/services/${id}${cascade ? '?cascade=true' : ''}`, token);
    },
    async addTag(name) {
      const body = await send<{ tag: TagView }>('/api/tags', token, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return body.tag;
    },
    renameTag(id, name) {
      return writeDirectoryAt<TagView>(
        `/api/tags/${id}`,
        token,
        { method: 'PATCH', body: JSON.stringify({ name }) },
        'tag',
      );
    },
    removeTag(id, cascade) {
      return removeDirectoryAt(`/api/tags/${id}${cascade ? '?cascade=true' : ''}`, token);
    },
    // `?cascade=true` and nothing else — `directoryController`'s own rule, and
    // `roleController`'s before it: the flag is the second, explicit call
    // rather than a body on a DELETE, and it is **absent** rather than
    // `?cascade=false` so that nobody reading a request log can mistake a first
    // ask for a confirmed one.
    removePerson(id, cascade) {
      return removeDirectoryAt(`/api/people/${id}${cascade ? '?cascade=true' : ''}`, token);
    },
    removeTeam(id, cascade) {
      return removeDirectoryAt(`/api/teams/${id}${cascade ? '?cascade=true' : ''}`, token);
    },
  };
}

export function httpProjectApi(token: string): ProjectApi {
  const directory = httpDirectoryApi(token);
  return {
    async listProjects() {
      const body = await send<{ projects: ProjectListEntry[] }>('/api/projects', token);
      return body.projects;
    },
    async createProject(name) {
      const body = await send<{ project: CreatedProject }>('/api/projects', token, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return body.project;
    },
    async openProject(id) {
      await send(`/api/projects/${id}/opened`, token, { method: 'POST' });
    },
    async renameProject(id, name) {
      await send(`/api/projects/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
    },
    tree(projectId) {
      return send<{
        workItems: WorkItemView[];
        seq: number;
        scheduleError: 'cycle' | null;
        slices: SliceView[];
        roles: RoleView[];
        assignedPeople: AssignedPersonView[];
        teamCapacities: TeamCapacityView[];
        priorityBands: PriorityBandView[];
        estimateMethod: EstimateMethod;
        startDate: string | null;
        projectRevision: number;
        undoable: boolean;
        redoable: boolean;
      }>(`/api/projects/${projectId}/work-items`, token);
    },
    undo(projectId) {
      return stepStack(`/api/projects/${projectId}/undo`, token);
    },
    redo(projectId) {
      return stepStack(`/api/projects/${projectId}/redo`, token);
    },
    // The directory belongs to no project, so these four are the directory
    // client's verbatim. Delegated rather than repeated: two spellings of
    // `/api/people` is how the pickers and the directory page come to disagree
    // about what a person is.
    listTeams: () => directory.listTeams(),
    addTeam: (name) => directory.addTeam(name),
    listTags: () => directory.listTags(),
    listServices: () => directory.listServices(),
    addService: (name) => directory.addService(name),
    addTag: (name) => directory.addTag(name),
    renameTag: (tagId, name) => directory.renameTag(tagId, name),
    removeTag: (tagId, cascade) => directory.removeTag(tagId, cascade),
    listPeople: () => directory.listPeople(),
    addPerson: (name, teamIds) => directory.addPerson(name, teamIds),
    async assign(workItemId, roleId, personId) {
      await send(`/api/work-items/${workItemId}/assignees/${roleId}`, token, {
        method: 'PUT',
        body: JSON.stringify({ personId }),
      });
    },
    async setStartDate(projectId, startDate) {
      await send(`/api/projects/${projectId}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ startDate }),
      });
    },
    // `PUT` and the whole body, which is be-01's shape: there is one field, so
    // the same request twice is the same state and an absent one could only mean
    // "leave the only thing there is alone".
    //
    // Sent as typed. The rule about what a capacity may be lives at be-01's
    // boundary — see `setTeamCapacity` on {@link ProjectApi} — so a `0` or a
    // `1001` goes and is refused with a code the dialog turns into a sentence.
    async setTeamCapacity(projectId, teamId, size) {
      await send(`/api/projects/${projectId}/teams/${teamId}/capacity`, token, {
        method: 'PUT',
        body: JSON.stringify({ size }),
      });
    },
    // `PUT` and the whole ladder, which is be-01's shape and the reason is on its
    // route: five rungs are one fact, and half a ladder is not a ladder.
    //
    // Sent as typed, exactly as `setTeamCapacity` is: the rule about what a ladder
    // may be lives at be-01's boundary, so a `Critical` that writes 30 goes and is
    // refused with a code the dialog turns into a sentence.
    async setPriorityBands(projectId, bands) {
      await send(`/api/projects/${projectId}/priority-bands`, token, {
        method: 'PUT',
        body: JSON.stringify({ bands }),
      });
    },
    async setEstimateMethod(projectId, method) {
      await send(`/api/projects/${projectId}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ estimateMethod: method }),
      });
    },
    async roles(projectId) {
      const body = await send<{ roles: RoleView[] }>(`/api/projects/${projectId}`, token);
      return body.roles;
    },
    async addRole(projectId, name) {
      const body = await send<{ role: RoleView }>(`/api/projects/${projectId}/roles`, token, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return body.role;
    },
    async renameRole(projectId, roleId, name) {
      const body = await send<{ role: RoleView }>(
        `/api/projects/${projectId}/roles/${roleId}`,
        token,
        { method: 'PATCH', body: JSON.stringify({ name }) },
      );
      return body.role;
    },
    removeRole(projectId, roleId, cascade) {
      // `?cascade=true` and nothing else, which is `roleController`'s own rule:
      // the flag is the second, explicit call rather than a body on a DELETE.
      // Absent rather than `?cascade=false` for the same reason — the
      // controller reads `=== 'true'`, and a flag that is always on the URL is
      // one nobody reading a request log can tell from a confirmed one.
      // Proof: pinned to `?cascade=true`, `asks for the cascade only when it is
      // given one` failed on `expected [ …(2) ] to deeply equal [ …(2) ]`.
      // Watched, 2026-08-09.
      return removeRoleAt(
        `/api/projects/${projectId}/roles/${roleId}${cascade ? '?cascade=true' : ''}`,
        token,
      );
    },
    create(projectId, input) {
      return send<{ id: string }>(`/api/projects/${projectId}/work-items`, token, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    async patch(id, patch) {
      await send(`/api/work-items/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },
    async move(id, parentId, afterId) {
      await send(`/api/work-items/${id}/move`, token, {
        method: 'POST',
        body: JSON.stringify({ parentId, afterId }),
      });
    },
    duplicate(id) {
      return send<{ id: string }>(`/api/work-items/${id}/duplicate`, token, { method: 'POST' });
    },
    async remove(id, options) {
      const query = options?.strategy === undefined ? '' : `?strategy=${options.strategy}`;
      await send(`/api/work-items/${id}${query}`, token, { method: 'DELETE' });
    },
    async setEstimate(id, roleId, days) {
      await send(`/api/work-items/${id}/estimates/${roleId}`, token, {
        method: 'PUT',
        body: JSON.stringify(days),
      });
    },
    async clearEstimate(id, roleId) {
      await send(`/api/work-items/${id}/estimates/${roleId}`, token, { method: 'DELETE' });
    },
    async freeze(projectId) {
      await send(`/api/projects/${projectId}/freeze`, token, { method: 'POST' });
    },
    async unfreezeProject(projectId) {
      await send(`/api/projects/${projectId}/unfreeze`, token, { method: 'POST' });
    },
    async unfreeze(id) {
      await send(`/api/work-items/${id}/unfreeze`, token, { method: 'POST' });
    },
    async addDependency(id, predecessorId) {
      await send(`/api/work-items/${id}/dependencies`, token, {
        method: 'POST',
        body: JSON.stringify({ predecessorId }),
      });
    },
    async removeDependency(id, predecessorId) {
      await send(`/api/work-items/${id}/dependencies/${predecessorId}`, token, {
        method: 'DELETE',
      });
    },
  };
}

/** How deep a work item sits, read off its number rather than by walking parents. */
export function depthOf(workItem: WorkItemView): number {
  return workItem.number.split('.').length - 1;
}
