import type { IsoDate } from '@wbs/domain';

import type { WriteStamp } from './write-stamp';

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
   * The last day this work may finish on, or null where nobody has said.
   *
   * The mirror of {@link WorkItem.startNoEarlierThan} at the other end: a
   * date-only ceiling, never a pin and never a promise the scheduler keeps —
   * Fast orders by it and reports `Late by N workdays` when it cannot be met.
   * **No reason column beside it**, unlike the floor; `tasks.md` 1.1 says why.
   */
  deadline: IsoDate | null;
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
 *
 * `name` is what a reader calls this link, and `''` means they have not said.
 * That is a stated absence rather than a missing value — the column is
 * `NOT NULL DEFAULT ''`, so there is one spelling of it — and every surface
 * draws `refLabelOf(url)` in its place. Never fetched: see the table's own
 * JSDoc for why a typed name is not the cached title this table refuses.
 */
export interface ExternalRef {
  id: string;
  systemId: string;
  url: string;
  name: string;
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
   * The last day this work may finish on, or `null` to take the deadline off.
   *
   * **No pair rule and no second field**: the floor above has a reason column to
   * stay consistent with and this has nothing, so this store takes any
   * `IsoDate` or `null` and refuses neither. Two layers above it do. The
   * **controller** refuses a value that is not an `IsoDate`, through the same
   * malformed-payload path the floor uses — a 400, like every other malformed
   * field. The **service** refuses a date before the project's day zero, which
   * is where that check has to live because it is the first layer holding the
   * project as well as the payload; that one is a 422.
   */
  deadline?: IsoDate | null;
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

/**
 * A ref as a caller states it — no `id`, because the store mints one per row.
 *
 * `name` is required rather than optional, and the boundary that parses the
 * request is what supplies `''` for a caller that named nothing
 * (`asOptionalExternalRefs`). An optional field here would let the store's own
 * insert reach SQLite without the column, which is the same row written two
 * ways — and the way that skips it is the one no reader can tell from a name
 * somebody deleted.
 */
interface ExternalRefWrite {
  systemId: string;
  url: string;
  name: string;
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
export type AssignmentWritten =
  { ok: true } | { ok: false; reason: 'unknown_person' | 'unknown_step' };

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
