import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const examples = sqliteTable('examples', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  createdAt: integer('created_at').notNull(),
});

export type ExampleRow = typeof examples.$inferSelect;

/**
 * `passwordHash` holds an argon2id digest from `Bun.password`, never a
 * password. `username` is unique at the database level rather than only in the
 * service: two concurrent registrations of the same name both pass a
 * check-then-insert, and only a constraint stops the second one.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash'),
    email: text('email'),
    idpIssuer: text('idp_issuer'),
    idpSub: text('idp_sub'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('users_username').on(t.username),
    uniqueIndex('users_email_normalized').on(sql`lower(${t.email})`),
    uniqueIndex('users_idp_identity').on(t.idpIssuer, t.idpSub),
  ],
);

export type UserRow = typeof users.$inferSelect;

export const eventSequencer = sqliteTable('event_sequencer', {
  subscription: text('subscription').primaryKey(),
  nextSeq: integer('next_seq').notNull().default(0),
});

export const eventLog = sqliteTable(
  'event_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscription: text('subscription').notNull(),
    seq: integer('seq').notNull(),
    message: text('message').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('event_log_sub_seq').on(t.subscription, t.seq)],
);

export type EventLogRow = typeof eventLog.$inferSelect;

/**
 * One work breakdown structure and the scope of everything below it.
 *
 * `restricted` gates writes only: every authenticated account may read every
 * project, and only the owner may edit a restricted one. `ownerId` is the
 * account that created it and never changes, so a restricted project whose
 * owner is gone can be read by all and edited by none.
 */
export const project = sqliteTable(
  'project',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    restricted: integer('restricted', { mode: 'boolean' }).notNull().default(false),
    solutionSlug: text('solution_slug'),
    solutionUrl: text('solution_url'),
    /**
     * Which of the four {@link EstimateMethod}s this project plans with. Text
     * rather than an integer so a database anyone opens says `pessimistic`
     * instead of `3`, and defaulted so every existing project keeps the PERT
     * behaviour it already had.
     */
    estimateMethod: text('estimate_method').notNull().default('pert'),
    /**
     * The calendar day the plan begins, as `YYYY-MM-DD`, or null for a project
     * that has not been placed on a calendar.
     *
     * Nullable rather than defaulted to the day the project was made: a plan
     * with no start date is an ordinary state — an estimate nobody has committed
     * to a date yet — and inventing one would put dates on screen that nobody
     * chose. Without it the schedule still answers in day offsets, as it always
     * has.
     */
    startDate: text('start_date'),
    /**
     * How many times this project has been written to — see {@link workItem}'s
     * `revision` for what a revision is and the rule that decides when one moves.
     *
     * The project's own stored fields (name, restriction, estimate method, start
     * date) and its **satellites** move it. Its roles are a satellite: adding,
     * renaming or removing one changes what every estimate in the project means,
     * and each of the three moves this column inside the transaction that makes
     * the change — see `RoleRepository`, asserted in `repository/role.test.ts`.
     *
     * A project's work items are **not** satellites of it. They are entities with
     * revisions of their own, and folding them in here would make this counter
     * move on every keystroke anybody types anywhere in the plan — a precondition
     * on it would then fail for two people editing unrelated branches.
     *
     * `project_access.last_opened_at` does not move it either: whose screen a
     * project is on is navigation history, not a change to the plan.
     */
    revision: integer('revision').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('project_solution_slug').on(t.solutionSlug)],
);

export type ProjectRow = typeof project.$inferSelect;

/**
 * When one account last opened one project, and nothing else.
 *
 * The picker sorts by it, which is the whole reason it exists: "the project I
 * was in yesterday" is how people find their way back, and creation order
 * answers a question nobody asks. One row per pair, overwritten on each open —
 * a log would answer "how often" and "when before that", which nothing asks.
 *
 * Its own table rather than a column anywhere: the fact belongs to the pair,
 * not to the project (every account has a different answer) and not to the
 * account (it has one per project).
 */
export const projectAccess = sqliteTable(
  'project_access',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    lastOpenedAt: integer('last_opened_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })],
);

export type ProjectAccessRow = typeof projectAccess.$inferSelect;

/**
 * One unit of work, placed in a tree by `parentId` and among its siblings by
 * `position`.
 *
 * `position` is spaced in gaps of ten so an insertion writes one row instead of
 * renumbering the group; when a gap runs out the group is renumbered inside the
 * same transaction. It is an input, never displayed — the number the user sees
 * is derived from it on read.
 *
 * `frozenNumber` is the entire freeze mechanism. Null means the number is
 * derived; set means it was written down by a freeze because it had left the
 * tool, and it is then reported verbatim regardless of position. A row with it
 * set refuses to move until unfrozen.
 *
 * `id` is immutable for the life of the row. Dependencies between work items
 * will address it, and numbers are repadded and re-derived too often to be an
 * identity.
 */
export const workItem = sqliteTable(
  'work_item',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    parentId: text('parent_id').references((): AnySQLiteColumn => workItem.id),
    position: integer('position').notNull(),
    name: text('name').notNull().default(''),
    notes: text('notes').notNull().default(''),
    frozenNumber: text('frozen_number'),
    /**
     * A calendar day this work item may not start before, or null.
     *
     * A **constraint**, never a pin: the schedule takes the later of this and
     * whatever its dependencies allow, so a predecessor that slips still
     * pushes this item along. Dany's call, 2026-08-06 — "keeps systems
     * independent". A hard pin would let a date contradict the dependency tree
     * and leave nothing to say which of the two was right.
     */
    startNoEarlierThan: text('start_no_earlier_than'),
    /**
     * Why this work item may not start before {@link workItem.startNoEarlierThan},
     * in the planner's own words, or null where nobody has said.
     *
     * **Words about the floor beside it, and nothing else.** Not a state, not a
     * flag, and not a second thing that holds a row back: the date is the whole
     * of the constraint and this is the whole of the explanation. It is what was
     * built instead of a `blocked` state — Dany, 2026-08-18, *"Yeah let's not do
     * blocked"* — because the engine already models being held back four ways
     * and the chart already names which of them binds, so the one thing missing
     * was why. `blocked until the 12th` is this column and the one above it.
     *
     * **Meaningless without a date, and refused without one.** The pair may be
     * neither, the date alone, or both; a reason with no date is
     * `isOrphanedNotBeforeReason` in `@wbs/domain` and
     * {@link WorkItemStore.patch} refuses it inside the transaction that would
     * have written it. Deliberately not a `CHECK` — the argument, which turns on
     * the outgoing release writing this table where it does not write
     * `role_progress`, is on the migration.
     *
     * Nullable with no default, because null is a real state and not a missing
     * empty string: the absence of a reason is how "nobody has said" is spelled
     * here, exactly as the absence of a row is in {@link actual} and
     * {@link roleProgress}. A blank typed into the field is normalised to null
     * at the controller rather than stored, so there is one spelling.
     *
     * At most `LONGEST_NOT_BEFORE_REASON` (200) characters, checked at the
     * controller — the width of the hover card and the cell that read it.
     *
     * **Read by no scheduling code.** `service/schedule.ts` does not select it,
     * has an empty diff in the change that added it, and schedules a plan
     * identically with and without it.
     */
    startNoEarlierThanReason: text('start_no_earlier_than_reason'),
    /**
     * How important this work is, or null for "nobody has said" — an integer of
     * 1 or more, smaller being more important.
     *
     * An **ordering**, never a constraint. It decides which of two work items
     * competing for the same person is placed first, and it decides nothing at
     * all in a plan where nothing competes: it cannot move a work item in front
     * of its own dependencies, its floor or its earlier roles. See `goesFirst`
     * in `service/schedule.ts` for where it is asked.
     *
     * Nullable with no default, because null is a real state here and not a
     * missing 1: a plan where nobody has set a priority is scheduled exactly as
     * it was before this column existed, and a work item with no priority is placed
     * after every work item that has one rather than among them.
     *
     * What the number is **called** is the project's own — see
     * {@link projectPriorityBand}. The ladder is read on every face and by no
     * scheduling code: picking `Critical` writes this column's `10` and nothing
     * else happens, and re-cutting the ladder changes what this number is called
     * without touching it.
     */
    priority: integer('priority'),
    /**
     * The one team this work is labelled with, or null — **and no longer what
     * anything reads.** {@link workItemTeam} holds the set, and `team-sets`
     * (2026-08-14) switched every read to it.
     *
     * Kept, and kept written, for one release. Blue and green share one SQLite
     * file mid-swap and the outgoing release selects this column on every tree
     * read, so it is dual-written by every write that changes a work item's
     * team: it holds the single member of the set, or null for the empty set.
     * The write path writes at most one team until R2-4, which is what makes
     * that possible; R2-6 drops the column once no running release reads it.
     *
     * It is also the **journal's** spelling of the set until then — an undo of a
     * label travels as this scalar, and a restored or duplicated subtree gets
     * its join rows derived from it. See `team-sets`' design.md D2.
     *
     * A label on the work, not a constraint on who may be assigned it, and what
     * a **capacity** is spent through: a set on a parent reaches every leaf
     * beneath it whose own set is empty — most-specific wins, `effectiveTeamsOf`
     * in `libs/domain/src/effective-team.ts` — and each of those leaves' slices
     * draws a slot from that team's pool. The number of slots in that pool is
     * {@link projectTeamCapacity.size}, stated by **this project** and no other.
     * Labelling is still not assigning: who does the work is a second and
     * independent fact.
     *
     * What the number does to a plan's dates, in prose: `docs/capacity.md`.
     */
    serviceTeamId: text('service_team_id'),
    /**
     * The one service this work is delivered for, or null — the third label
     * dimension, beside teams and tags.
     *
     * Dany, 2026-08-20: _"I need to have service and team as separate
     * entities"_, and _"Let service and teams be independent"_. So this is not
     * read through {@link workItemTeam}: a row states its team and its service
     * separately, and either may be blank. {@link service} is what it points at.
     *
     * **Superseded by {@link workItemService}, and still here on purpose.** This
     * column was the dimension's first store, chosen so the schema stated the
     * cardinality rather than a comment stating it — one service per item. Dany
     * widened that to a set on 2026-08-21 (_"can be several services"_), the same
     * argument then pointed straight at the join table it had rejected, and
     * `20260821080000_add_work_item_service` seeded one from this column. The
     * paragraph that made the widening cost a read instead of a redesign was the
     * one saying the **domain** reading was set-shaped all along:
     * `effectiveServicesOf` handed the shared walk a singleton, so nothing about
     * the inheritance had to move.
     *
     * It survives the widening because blue and green share one SQLite file
     * during a swap and the outgoing release still selects and writes it.
     * Dropping it is a later migration, once no running release names it — the
     * same additive rule {@link serviceTeam}'s wrong name follows (design.md D2,
     * amended, and D9).
     *
     * **`ON DELETE SET NULL`, never `CASCADE`: deleting a service must not
     * delete work items.** It is also what makes the directory's removal effect
     * `label_nulled` rather than `label_removed` — a column is nulled, a set
     * member is removed, and `directory-usage.ts` already tells those two
     * sentences apart. That is still the true sentence while this column is the
     * one a reader is told about; it becomes `label_removed` when the read moves
     * to {@link workItemService} (tasks 10.2 and 10.5), not before.
     *
     * **Blank means inherit**, exactly as it does for teams and tags: a row with
     * no service takes its nearest ancestor's, and a row with one overrides it.
     * There is no third "deliberately none" state.
     *
     * **Nothing a date reads.** `service/schedule.ts` has an empty diff in the
     * change that adds this column: a service is a grouping and reporting fact,
     * with no pool and no size anywhere beside it.
     */
    serviceId: text('service_id').references(() => service.id, { onDelete: 'set null' }),
    /**
     * How many people may be on this work item at once — 1 or more, never
     * null.
     *
     * An item of `maxParallel: 3` and 6 days of effort runs for 2 days holding
     * 3 of its team's slots, as one indivisible block: it takes all three or it
     * waits. Clamped down by the team's own size, so an item cannot claim more
     * people than the team has, and overridden to 1 by a named assignee — one
     * human cannot work beside themselves. See `widthFor` in
     * `service/work-item.service.ts` for where the three rules meet.
     *
     * `NOT NULL DEFAULT 1` rather than `priority`'s nullable shape, because
     * unlike a priority `1` and *unset* are the same fact: one at a time. Two
     * spellings of one fact is what R2 exists to prevent, and the default is
     * what keeps the column additive across a blue/green swap.
     */
    maxParallel: integer('max_parallel').notNull().default(1),
    /**
     * How many times this work item has been written to: a monotonic counter
     * that starts at 0 and is bumped by every write that changes what the work
     * item means.
     *
     * **The rule of thumb: if a reader could see different data because of the
     * write, the owning entity's revision moved.** That includes writes to the
     * work item's **satellites** — rows in other tables that have no identity
     * of their own and are only ever read through the work item they hang off:
     *
     * - an `estimate` bumps the work item it is for, and a handoff between two
     *   work items bumps both;
     * - an `assignment` bumps the work item it is on;
     * - a `dependency` bumps **both** endpoints, because either end reads the
     *   edge.
     *
     * What it deliberately does **not** cover is the work item's derived
     * number. `position` is storage detail and the number a reader sees is
     * computed from the whole tree, so one structural edit changes the number
     * of rows nobody wrote to. Bumping all of them would make this counter
     * global — every reader would conflict with every writer — so a revision
     * covers the entity's own stored fields and its satellites, and never its
     * place in somebody else's numbering. A client that cares about the
     * numbers refetches the tree, which is what it already does.
     *
     * Bumped with SQL arithmetic (`revision = revision + 1`) in the same
     * statement or transaction as the write it describes, never read into the
     * process and written back: two writers that both read 4 would both write
     * 5, and one of the two writes would then be invisible to the very check
     * this column exists to serve.
     *
     * Nothing enforces a precondition on it yet — this column records the
     * fact. Conditional undo and write preconditions are the consumers, and
     * they are separate changes.
     */
    revision: integer('revision').notNull().default(0),
  },
  (t) => [index('work_item_siblings').on(t.projectId, t.parentId, t.position)],
);

export type WorkItemRow = typeof workItem.$inferSelect;

/**
 * A kind of work a project estimates separately. Every project starts with `Dev`
 * and `QA`, which is a seed rather than the set it may hold: they can be
 * renamed, removed, and joined by others through `RoleRepository`.
 *
 * `estimate.role_id` deliberately has **no** `onDelete` cascade while
 * `assignment.role_id` does, and the difference is not an oversight. An
 * estimate is somebody's typing and a removal must count it before taking it;
 * the missing cascade is what makes a role delete that forgot to say so fail
 * loudly instead of quietly emptying the plan. `RoleRepository.remove` deletes
 * them explicitly, inside the transaction that removes the role.
 */
export const role = sqliteTable(
  'role',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    name: text('name').notNull(),
    /**
     * Where this role sits in the project's role order, spaced in tens like
     * {@link workItem}'s.
     *
     * The order is a contract now that the schedule runs a work item's slices
     * in it, and it cannot be inferred: `WHERE project_id = ?` is answered from
     * `role_project_name`, so a project's roles come back in **name** order
     * unless a query says otherwise. `Dev, QA` only looks like the order they
     * were seeded in.
     *
     * The default is what lets an outgoing release insert a role during a swap:
     * its `INSERT` does not name this column, and blue and green share one
     * file. Such a role lands first rather than last, which is a colour-swap
     * window's worth of wrong order and not a lost row.
     *
     * Proof: with `DEFAULT 0` removed from the migration, `lets the outgoing
     * release keep inserting roles against the migrated schema` fails on the
     * old release's three-column `INSERT` with `NOT NULL constraint failed:
     * role.position`; watched 2026-08-09.
     */
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('role_project_name').on(t.projectId, t.name)],
);

export type RoleRow = typeof role.$inferSelect;

/**
 * Three durations in days for one work item and one role.
 *
 * Its own table rather than columns on `work_item` because a project chooses
 * how many roles it estimates: columns would cap that number and make adding
 * `Design` a migration.
 *
 * Rows exist only for leaves. A work item with children reports the sums of its
 * descendants, computed on read and never stored, so there is no second copy to
 * fall out of date.
 */
export const estimate = sqliteTable(
  'estimate',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItem.id),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id),
    optimistic: real('optimistic').notNull(),
    realistic: real('realistic').notNull(),
    pessimistic: real('pessimistic').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workItemId, t.roleId] })],
);

export type EstimateRow = typeof estimate.$inferSelect;

/**
 * The days one role actually spent on one work item.
 *
 * Dany, 2026-08-13: _"I want to be able to track fact days near the estimate of
 * completion"_. `notes/wbs-brief-2026-08-14-r5-r6-history.md` §3.2.
 *
 * **Its own table rather than a fourth column on {@link estimate}.** Work nobody
 * estimated still takes days, and `estimate`'s three columns are `NOT NULL`, so a
 * column there would force a made-up trio to record a real actual. The two are
 * also written by different people at different times — an estimate before the
 * work, an actual after it — and one row holding both makes each write a
 * read-modify-write of the other's numbers.
 *
 * **The absence of a row is what "nobody has said" looks like, never a zero.**
 * The same rule {@link projectTeamCapacity} follows, and the same one the export
 * has carried since it was written: an empty cell means nobody typed it. A zero
 * here is a person saying the work took no days, which is a different sentence
 * and a rarer one. Clearing an actual deletes the row rather than writing 0.
 *
 * **Per (work item, role), matching the estimate's grain exactly.** Every read
 * path in the tool already groups by that pair — the estimate's own key, the
 * schedule's slice key, the export's per-role column group, the roll-up — and a
 * per-item actual would be a second spelling of a total that then has to agree
 * with per-role estimates and would not. "Who overran, Dev or QA?" is the
 * question actuals exist to answer.
 *
 * **Rows exist only for leaves**, exactly as estimates do: a parent's actual is
 * the sum of its descendants', computed on read and never stored.
 *
 * **Nothing here reaches the schedule.** The engine's input is built from
 * estimates in `slicesOf`, and this table is not read there or anywhere below it
 * — R6 is reporting only. The reason is not economy: the model has no completion
 * state anywhere, so it cannot tell "took 8 days, finished" from "8 days so far,
 * still running", and substituting the first reading for the second moves every
 * successor's dates on a claim nobody made. See
 * `openspec/changes/actual-days/design.md` D3.
 *
 * `role_id` gets **no** `onDelete` cascade, matching {@link estimate.roleId} and
 * for the identical reason spelled out on {@link role}: an actual is somebody's
 * typing and a role removal must count it before taking it.
 * `RoleRepository.remove` deletes them explicitly, inside the transaction that
 * removes the role.
 *
 * `work_item_id` **does** cascade, and that is about the blue/green swap window
 * rather than tidiness: two be-01 processes share one SQLite file while green
 * migrates, and the outgoing release's plain `DELETE FROM work_item` would hit a
 * constraint it cannot see. The same argument `dependency` makes.
 *
 * `recorded_at` is when the number was typed. It costs one column and it is what
 * a history row about an actual is dated against.
 */
export const actual = sqliteTable(
  'actual',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItem.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id),
    days: real('days').notNull(),
    recordedAt: integer('recorded_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workItemId, t.roleId] })],
);

export type ActualRow = typeof actual.$inferSelect;

/**
 * Where one role's work on one work item has got to.
 *
 * Dany, 2026-08-18: _"maybe we should augment actual days by completion
 * status?"_ — and the reason he is right is written in {@link actual} and in
 * `openspec/changes/actual-days/design.md` D3: with no completion state
 * anywhere, an actual cannot tell "took 8 days, finished" from "8 days so far",
 * and those are opposite claims about every successor. This table is the
 * sentence that disambiguates the number beside it.
 *
 * **Three states, two of them stored.** `in_progress` and `done` are rows;
 * **"not started" is the absence of one**, never a stored value — the rule
 * {@link projectTeamCapacity} and {@link actual} both follow. A stored
 * `not_started` would be a second spelling of "nobody has said" and every reader
 * would then have to handle both. There is no `blocked` and no `cancelled`:
 * each is a question the engine must answer the day it reads this, and it does
 * not read this yet.
 *
 * **Per (work item, role), the same grain as {@link estimate} and
 * {@link actual}.** Actuals are per role, so a per-item state would be a second
 * source of truth about the same subject and the disagreement it produces is
 * exactly "the item says done and a role has no actual". **A work item's own
 * state is derived from its roles on every read and never stored** — `agree` and
 * `stateOf` in `@wbs/domain`, where `done` is unanimous across the roles that
 * have work on the row, and any disagreement reads as `in_progress`.
 *
 * **Rows exist only for leaves**, exactly as estimates and actuals do: a
 * parent's state is folded from its descendants', computed on read.
 *
 * **What `done` makes true**, stated here because the change that consumes it
 * must not have to re-litigate it: an actual on a role marked `done` is
 * **final** — the whole of what that role spent, not a running count. The next
 * change is the one where the engine reads this (finished roles freeze,
 * in-progress roles get `remaining = max(0, estimate − actual)`), and that
 * reading is only available because this rule was fixed before any row was
 * written under it.
 *
 * **Nothing here reaches the schedule.** The engine's input is built from
 * estimates in `slicesOf` and this table is read nowhere below it — R6 is still
 * reporting only, and this change moves no date in either direction.
 *
 * `role_id` gets **no** `onDelete` cascade, matching {@link actual.roleId} and
 * {@link estimate.roleId}: a state is somebody's statement and a role removal
 * must count it before taking it. `work_item_id` **does** cascade, for the
 * blue/green swap window {@link actual.workItemId} explains.
 *
 * `stated_at` is when somebody said it — a fact about the tool, not about the
 * world. It is deliberately the only date this table has: an actual start or
 * finish **date** is a separate change, because a stored date that disagrees
 * with the scheduled one needs a decision about which of the two a chart draws.
 *
 * The `CHECK` is the closed set the whole design rests on, enforced rather than
 * trusted: Drizzle's enum is compile-time only, and a fourth value written by a
 * hand-edit or a future mistake would be dispatched on by every reader and
 * folded by none of them.
 */
export const roleProgress = sqliteTable(
  'role_progress',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItem.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id),
    state: text('state', { enum: ['in_progress', 'done'] }).notNull(),
    statedAt: integer('stated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workItemId, t.roleId] }),
    check('role_progress_state', sql`${t.state} IN ('in_progress', 'done')`),
  ],
);

/**
 * The closed set of units a {@link roleMeasure} can be in.
 *
 * Exported because every read and write path takes one of these as a parameter
 * rather than defaulting it — the cost of a discriminated table, paid on
 * purpose. `openspec/changes/token-tracking/design.md` D1.
 */
export const MEASURE_METRICS = ['token_estimate', 'token_actual', 'hours_actual'] as const;

export type MeasureMetric = (typeof MEASURE_METRICS)[number];

/**
 * What one role's work on one work item cost, in a unit that is not days.
 *
 * Dany, 2026-08-20: _"estimate token use and then record fact token use for each
 * task (even each phase/role) … then how many hours was spent on a task"_. Three
 * figures — the tokens a role's work is expected to take, the tokens it took,
 * and the hours it took — at the grain {@link estimate} and {@link actual}
 * already use.
 *
 * **One table with a `metric` discriminator, not three tables**, and this is the
 * decision in the change worth arguing rather than assuming:
 * `openspec/changes/token-tracking/design.md` D1. Three tables would each need
 * the five-method repository, the `PUT`/`DELETE` pair, the `rolled_up` and
 * `unknown_role` refusals, two journalled commands, the roll-up fold, the
 * hand-down/hand-up/restore/no-copy structure rules and the role-removal count —
 * seven mechanisms times three, every copy able to drift from its siblings in
 * silence.
 *
 * **The obvious objection is that {@link estimate} and {@link actual} are two
 * tables, and it does not carry over.** That split exists because folding an
 * actual into `estimate` would have made it a **fourth column on the same row**,
 * and `estimate`'s three columns are `NOT NULL`, so recording a real actual
 * would have forced a made-up trio beside it. Here the figures are separate
 * **rows**: recording hours writes one row and touches nothing else. The rule
 * that argument was protecting is preserved exactly — the primary key carries
 * `metric`, so **absence is per metric**, and a pair holding an hours figure is
 * still absent from every token figure.
 *
 * **Absence of a row is what "nobody has said" looks like, never a zero** — the
 * rule {@link actual} and {@link projectTeamCapacity} follow. Clearing deletes
 * the row. A stored `0` survives, because "this cost nothing" is a statement
 * somebody made and a rarer one.
 *
 * **One number per figure, not a trio.** {@link estimate} is three durations
 * because a weighted final falls out of them and the scheduler consumes it.
 * Nothing consumes these, so a range here would be three numbers no code folds
 * and no surface reduces. Design D2.
 *
 * **Hours are recorded, never derived.** No tokens-to-hours or days-to-hours
 * conversion exists in this repo, because neither is a fact about the world: an
 * agent's tokens buy no hours of anybody's attention, and a day here is a
 * capacity unit rather than eight hours of one person. Design D5.
 *
 * **Rows exist only for leaves**, exactly as estimates and actuals do: a
 * parent's figure is the sum of its descendants', computed on read and never
 * stored.
 *
 * **Nothing here reaches the schedule.** The engine's input is built from
 * estimates in `slicesOf` and no read path below it touches this table. A token
 * fact is not evidence about a date — a row that burned four million tokens may
 * be finished or may still be running, and the model's only completion state
 * ({@link roleProgress}) is silent about tokens. Design D3, and the change that
 * adds this table has an empty diff on `service/schedule.ts` and `libs/domain`.
 *
 * `metric` is a Drizzle enum **and** a `CHECK`, the pair {@link roleProgress}
 * uses and for the identical reason: the enum is erased at runtime, and a fourth
 * value written by a hand-edit or a stale release would be dispatched on by
 * every reader and folded by none of them.
 *
 * `role_id` gets **no** `onDelete` cascade and `work_item_id` does, matching
 * {@link actual} exactly: a measure is somebody's typing, so a role removal must
 * count it before taking it, and `RoleRepository.remove` deletes these rows
 * explicitly inside its transaction. The cascade on `work_item_id` is the
 * blue/green swap window — two be-01 processes share one SQLite file while green
 * migrates, and the outgoing release's plain `DELETE FROM work_item` would hit a
 * constraint it cannot see.
 *
 * `recorded_at` is when the number was typed, and a correction carries the
 * moment the correction was typed rather than the moment the figure it replaced
 * was.
 */
export const roleMeasure = sqliteTable(
  'role_measure',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItem.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id),
    metric: text('metric', { enum: MEASURE_METRICS }).notNull(),
    value: real('value').notNull(),
    recordedAt: integer('recorded_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workItemId, t.roleId, t.metric] }),
    check(
      'role_measure_metric',
      sql`${t.metric} IN ('token_estimate', 'token_actual', 'hours_actual')`,
    ),
  ],
);

export type RoleMeasureRow = typeof roleMeasure.$inferSelect;

export type RoleProgressRow = typeof roleProgress.$inferSelect;

/**
 * A service or team that work can be labelled with — global, not per project.
 *
 * Dany's ask, 2026-08-06: it behaves like a Jira label. Anyone may add one by
 * typing a name the list does not have, and every project draws from the same
 * list, because the same teams do work across projects and one list per
 * project would be the same names typed again and again with typos between
 * them.
 *
 * The name is unique at the database rather than only in the service: two
 * people creating `Platform` at the same moment both pass a check-then-insert,
 * and only a constraint stops the second.
 */
export const serviceTeam = sqliteTable(
  'service_team',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /**
     * **Retired by `capacity-per-project` (2026-08-13) and read by nothing.**
     * Kept in the table and not dropped, and the two halves are separate facts.
     *
     * Read by nothing: capacity is a fact about one project now, held in
     * {@link projectTeamCapacity}, and there is deliberately **no fallback** to
     * this number — Dany's call, quoted in that change's `design.md` D1. Every
     * project that existed at the migration was seeded with whatever stood here,
     * so no plan moved; what stands here now is the last global number anybody
     * typed and it decides nothing.
     *
     * Not dropped: blue and green share one SQLite file mid-swap and the
     * outgoing release still selects this column. The drop is a later change,
     * once no running release reads it — `capacity-per-project`'s D4.
     *
     * The rule it used to carry, for the reader who finds a number in here and
     * wonders what it meant: null was _unstated_ and constrained nothing, and a
     * sized team of N bounded how many of its work items' slices ran at once
     * across the whole of one project's plan. That rule now lives on
     * {@link projectTeamCapacity.size}, per project.
     */
    size: integer('size'),
  },
  (t) => [uniqueIndex('service_team_name').on(t.name)],
);

export type ServiceTeamRow = typeof serviceTeam.$inferSelect;

/**
 * Which teams one work item's work belongs to — **several**, since `team-sets`.
 *
 * Dany, 2026-08-13: _"can be several teams and several services per work item"_.
 * A column holds one team and this holds the set, so this table — not
 * {@link workItem.serviceTeamId} — is what every read of a work item's teams
 * goes through. The column is still written beside it and is still the only
 * thing the outgoing release can see; see its JSDoc for the window that keeps
 * them both.
 *
 * The pair is the primary key because the pair is the fact: "this work item's
 * work is Platform's" is either stated or not, and a second row saying it again
 * would be a second answer to one question. `project_team_capacity`'s shape, one
 * table along.
 *
 * Both columns cascade, and the cascade is the **only** mechanism that removes
 * these rows — nothing in be-01 deletes them on the way to deleting a team or a
 * work item. That is deliberate and it is the same argument
 * {@link projectTeamCapacity} makes: blue and green share one SQLite file during
 * a swap, the outgoing release knows nothing about this table, and its plain
 * `DELETE FROM service_team` must not hit a constraint it cannot see.
 *
 * Indexed by team, because the directory asks "what would removing this team
 * touch" of every project at once and the primary key answers only the other
 * direction.
 */
export const workItemTeam = sqliteTable(
  'work_item_team',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItem.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => serviceTeam.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.workItemId, t.teamId] }),
    index('work_item_team_by_team').on(t.teamId),
  ],
);

export type WorkItemTeamRow = typeof workItemTeam.$inferSelect;

/**
 * What kind of thing a work item is — `regulatory`, `tech-debt`, `q3-must-have`.
 *
 * Dany, 2026-08-19: _"Ok let's add tags - might be useful."_ R2-5 designed this
 * dimension already, under the name `service`, and `notes/decisions.md:85`
 * dropped it pointing at R10; this is that design built, `service` renamed to
 * `tag` and nothing else about it changed.
 *
 * **What this table is not, and the absences are the design.** Not a pool: there
 * is no `size` here and no per-project table beside it, so nothing anywhere can
 * ask how many of a tag may be at work at once. Not a size. **Not anything a
 * date reads** — {@link serviceTeam} answers _who does the work_ and the
 * scheduler spends its capacity; a tag answers _what kind of thing this is_ and
 * `service/schedule.ts` has an empty diff in the change that adds it, watched by
 * a test that wires the scheduler to a tag and shows every downstream date
 * moving. The directory page renders these with no capacity column and no
 * membership chips for the same reason: a reader who sees no capacity column
 * learns the model rule without being told it.
 *
 * **Global — no project column**, mirroring {@link serviceTeam} exactly. A label
 * that meant one thing on one plan and another on the next would make the
 * directory a per-project screen and the filter a per-project vocabulary, and
 * neither is what a tag is for.
 *
 * `name` is `NOT NULL` with a unique index on it, and the index is what lets a
 * rename answer `taken` with the surviving name rather than writing a second row
 * that reads identically. Two tags spelled the same are two answers to one
 * question — {@link serviceTeam}'s `service_team_name`, one table up.
 */
export const tag = sqliteTable(
  'tag',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('tag_name').on(t.name)],
);

export type TagRow = typeof tag.$inferSelect;

/**
 * Which tags one work item carries — **several**, and independently of its teams.
 *
 * The pair is the primary key because the pair is the fact: "this work item is
 * regulatory" is either stated or not, and a second row saying it again would be
 * a second answer to one question. {@link workItemTeam}'s shape, one table up,
 * and the deliberate sameness is the point — an item answers _who_ and _what
 * kind_ at once, through two tables of identical shape that nothing joins to
 * each other.
 *
 * **Both sides cascade, and this is where the tag differs from
 * {@link roleProgress}.** There, `role_id` deliberately does not cascade, because
 * a state is somebody's statement about their own work and a role removal must
 * count it before taking it. A tag is a label: deleting the label should take the
 * labelling with it, and there is nothing to count that the label itself was not.
 * The cascade on `work_item_id` carries {@link workItemTeam}'s argument
 * unchanged — blue and green share one SQLite file during a swap, the outgoing
 * release knows nothing about this table, and its plain `DELETE FROM work_item`
 * must not hit a constraint it cannot see.
 *
 * The cascade on `tag_id` is also the whole of what `DELETE /api/tags/:id`
 * does to plans: the route counts what it would unlabel, refuses with 409 unless
 * `?cascade=1`, and then deletes the tag and lets the database remove the
 * labelling. Nothing in be-01 deletes rows from this table on its own.
 *
 * **Inheritance is not stored here.** A row with no rows in this table inherits
 * its ancestor's tags, and one with rows overrides them — override, per
 * dimension, independently, R2's Q4. That is computed by `effectiveTagsOf` on
 * every read, exactly as `effectiveTeamsOf` computes the other dimension, and
 * nothing denormalised is ever written. Blank means inherit; there is no third
 * "deliberately none" state, exactly as there is none for teams.
 *
 * Indexed by tag, because the directory asks "what would removing this tag
 * touch" of every project at once and the primary key answers only the other
 * direction — {@link workItemTeam}'s `work_item_team_by_team`.
 */
export const workItemTag = sqliteTable(
  'work_item_tag',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItem.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.workItemId, t.tagId] }),
    index('work_item_tag_by_tag').on(t.tagId),
  ],
);

export type WorkItemTagRow = typeof workItemTag.$inferSelect;

/**
 * What a work item is delivered **for** — `Payments`, `Search`, `Billing`.
 *
 * Dany, 2026-08-20: _"I need to have service and team as separate entities"_,
 * and, asked how the two relate, _"Let service and teams be independent"_. Until
 * this table the directory's one entity was literally called `service_team` and
 * answered both questions with one row; this is the second question given its
 * own table.
 *
 * **The name trap, and it is real for one release: {@link serviceTeam} means
 * _team_ and this means _service_.** No rename here — blue and green share one
 * SQLite file during a swap and the outgoing release selects `service_team` on
 * every tree read, so renaming it would break the release still running while
 * this one boots. R2-6 does the rename once no running release reads the old
 * name (`service-split`'s design.md D9).
 *
 * **What this table is not, and the absences are the design.** Not a pool: no
 * `size` column here and no per-project table beside it, so nothing anywhere can
 * ask how many of a service may be at work at once — {@link serviceTeam} is
 * where capacity lives, because capacity is spent by the people doing the work
 * and not by the thing the work is for. **Not anything a date reads**:
 * `service/schedule.ts` has an empty diff in the change that adds this, watched
 * by a test that wires the scheduler to a service and shows every downstream
 * date move. Not a tag either — {@link tag} stayed general-purpose, and what
 * makes a service more than a label is {@link teamService} below.
 *
 * **Global — no project column**, mirroring {@link serviceTeam} and {@link tag}
 * exactly. `Payments` means `Payments` in every plan, which is what lets an
 * export column mean the same thing across plans.
 *
 * `name` is `NOT NULL` with a unique index on it, and the index is what lets a
 * rename answer `taken` with the surviving name rather than writing a second row
 * that reads identically. Unique at the database rather than only in the
 * service: two people creating `Payments` at the same moment both pass a
 * check-then-insert, and only a constraint stops the second.
 */
export const service = sqliteTable(
  'service',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('service_name').on(t.name)],
);

export type ServiceRow = typeof service.$inferSelect;

/**
 * Which services one team is **responsible for** — several, and this is the fact
 * that makes a service more than a label.
 *
 * Dany, 2026-08-20: _"one team can be responsible for several services - it must
 * be configurable in the directory. It will help in the future to flag where
 * teams build something they do not own."_ So this is directory data about teams
 * and services themselves. It labels no work item, and the flagging it enables
 * is a **signal** computed on read — a row whose effective team and effective
 * service are both stated, where the service is not in that team's owned set —
 * never a validation and never a block.
 *
 * The pair is the primary key because the pair is the fact: "Platform owns
 * Payments" is either stated or not, and a second row saying it again would be a
 * second answer to one question. {@link workItemTeam}'s shape, two tables up.
 *
 * **Both sides cascade**, carrying {@link workItemTag}'s argument unchanged:
 * blue and green share one SQLite file during a swap, the outgoing release knows
 * nothing about this table, and its plain `DELETE FROM service_team` must not
 * hit a constraint it cannot see. `DELETE /api/services/:id` still counts what
 * it would unlabel and still refuses with 409 unless `?cascade=1` — but the
 * rows **this** table loses are deliberately not in that count, because an
 * ownership statement about a service that is being deleted is not a loss a
 * person needs to weigh (`service-split`'s design.md D7).
 *
 * **Not a capacity, and not a scheduling input.** Nothing here bounds anything,
 * and no date reads it: a team owning three services is not thereby three times
 * as busy.
 *
 * Indexed by `service_id`, because the directory asks "what would removing this
 * service touch" and the primary key answers only the other direction —
 * {@link workItemTag}'s `work_item_tag_by_tag`, one dimension over.
 */
export const teamService = sqliteTable(
  'team_service',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => serviceTeam.id, { onDelete: 'cascade' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => service.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.serviceId] }),
    index('team_service_by_service').on(t.serviceId),
  ],
);

export type TeamServiceRow = typeof teamService.$inferSelect;

/**
 * Which services one work item is delivered for — **several**, and independently
 * of its teams and its tags.
 *
 * Dany, 2026-08-21: _"can be several services."_ {@link workItem.serviceId} was
 * this dimension's first store and held exactly one; this table is the same fact
 * widened, and it is {@link workItemTag} line for line because the cardinality is
 * now the same.
 *
 * **The column above is still there and is not read here.** Blue and green share
 * one SQLite file during a swap: the outgoing release selects
 * `work_item.service_id` on every tree read and writes it on every patch, so the
 * migration that adds this table leaves the column standing and merely stops
 * being interested in it. Dropping it is a later migration, once no running
 * release names it — the additive rule `service_team`'s surviving name already
 * follows (`service-split`'s design.md D2 and D9).
 *
 * **Seeded from that column, so the widening loses nothing.** Every row with a
 * stated service arrives here carrying it, and the set the reader gets after the
 * migration is the singleton it got before. A migration that created this table
 * empty would have unlabelled every plan on the box in the name of a wider type.
 *
 * The pair is the primary key because the pair is the fact: "this work item is
 * delivered for Payments" is either stated or not, and a second row saying it
 * again would be a second answer to one question.
 *
 * **Both sides cascade**, and each side's reason is {@link workItemTag}'s
 * unchanged. `work_item_id`: the outgoing release's plain `DELETE FROM work_item`
 * must not hit a constraint it cannot see. `service_id`: a service is a label,
 * deleting the label should take the labelling with it, and there is nothing to
 * count that the label itself was not — `DELETE /api/services/:id` still counts
 * what it would unlabel and still refuses with 409 unless `?cascade=1`, for the
 * person pressing the button rather than for the integrity of anything.
 *
 * The cascade is also the one behaviour that changes for a reader on the day this
 * lands: {@link workItem.serviceId} nulls on a service delete
 * (`ON DELETE SET NULL`) and a row here is _removed_, so the directory's effect
 * kind becomes `label_removed` — with the read path, not with this table, since
 * until then it is the column a reader is told about (tasks 10.2 and 10.5).
 *
 * **Inheritance is not stored here**, exactly as it is not stored for teams or
 * tags: a work item with no rows in this table inherits its nearest ancestor's
 * services, one with rows overrides them, and `effectiveServicesOf` computes that
 * on every read. Blank means inherit; there is no third "deliberately none"
 * state.
 *
 * Indexed by `service_id`, because the directory asks "what would removing this
 * service touch" of every project at once and the primary key answers only the
 * other direction — {@link workItemTag}'s `work_item_tag_by_tag`, one dimension
 * over.
 */
export const workItemService = sqliteTable(
  'work_item_service',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItem.id, { onDelete: 'cascade' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => service.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.workItemId, t.serviceId] }),
    index('work_item_service_by_service').on(t.serviceId),
  ],
);

export type WorkItemServiceRow = typeof workItemService.$inferSelect;

/**
 * How many of one team may be at work at once **on one project's plan**.
 *
 * Dany, 2026-08-13, and the second sentence is the one that shapes this table:
 * _"the capacity must be configurable per project"_, and _"The global number
 * should not matter, only per project capacity configuration matters."_ So this
 * is not an override in front of {@link serviceTeam.size} — that column is read
 * by nothing, and a pair with no row here is **unstated**, constraining that
 * team's work on that plan not at all.
 *
 * The primary key is the pair, because the pair is the identity of the fact: one
 * project states one number about one team, and a second row for the same pair
 * would be a second answer to one question.
 *
 * `size` is `NOT NULL` and _unstated_ is the **absence of a row**, deliberately
 * one spelling rather than two. A nullable column would let unstated arrive as
 * either a missing row or a stored null, and every reader would then have to
 * handle both — the shape R2 exists to prevent. It is also why the write path's
 * `null` deletes rather than updates.
 *
 * Both columns cascade, and the cascade is the **only** mechanism that removes
 * these rows: nothing in be-01 deletes them before a project or a team goes —
 * {@link CapacityStore.set}'s clear-to-unstated is the single `DELETE` against
 * this table. That is not an oversight. Blue and green share one SQLite file
 * during a swap, the outgoing release knows nothing about this table, and its
 * plain `DELETE FROM service_team` would hit a constraint it cannot see and
 * answer 500 — so the removal has to belong to the database rather than to a
 * release. `dependency`'s own argument, one table along.
 *
 * The scheduler reads it through `CapacityStore.slotsFor`, which is C1's
 * `slotsOf` seam with the per-project lookup behind it at last. Why the map that
 * seam hands the engine stays keyed on the team alone, and not on the pair:
 * `openspec/changes/capacity-per-project/design.md` D3.
 */
export const projectTeamCapacity = sqliteTable(
  'project_team_capacity',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    serviceTeamId: text('service_team_id')
      .notNull()
      .references(() => serviceTeam.id, { onDelete: 'cascade' }),
    /**
     * How many of the team may be at work at once on this project's plan — at
     * least 1, and the floor is a correctness bound rather than a preference: a
     * slice's duration is its effort divided by its width, so a pool of 0 slots
     * is a plan of `Infinity` dates. The bound is enforced at be-01's boundary,
     * which is the only place a number can enter.
     */
    size: integer('size').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.serviceTeamId] })],
);

export type ProjectTeamCapacityRow = typeof projectTeamCapacity.$inferSelect;

/**
 * What one project calls its priority numbers — five rungs, keyed on the rung.
 *
 * A band is a **start value**; the band above it is what ends it, and the top
 * band ends nowhere. That is what makes the ladder contiguous and exhaustive by
 * construction, so every {@link workItem.priority} resolves to exactly one label
 * and no stored range can gap or overlap. The rule and its alternative are
 * `openspec/changes/priority-bands/design.md` D1.
 *
 * **Read by no scheduling code.** The leveller reads `work_item.priority` and
 * that column alone; this table is the vocabulary the number is read and written
 * in. Re-cutting a ladder renames what a plan's numbers are called and moves not
 * one date — asserted, not asserted-about, in
 * `service/priority-band-identity.test.ts`.
 *
 * A project holding **no** rows here reads as {@link DEFAULT_PRIORITY_BANDS},
 * which is a code constant and not a global anybody can type into. That is the
 * difference from {@link projectTeamCapacity}, whose D1 refused exactly this
 * shape: a capacity fallback meant one plan silently bounded by a number
 * somebody set for another, and there is no such number here. design.md D2.
 */
export const projectPriorityBand = sqliteTable(
  'project_priority_band',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    /**
     * The rung, 0 (most important) to 4.
     *
     * The key rather than {@link projectPriorityBand.startsAt}, so a project
     * moving a cut is an update to a row rather than a delete and an insert of a
     * new key. It is also what every face keys a colour off: a label is
     * renameable, and a colour following the word `Critical` would follow it out
     * of the ladder the moment somebody typed `Blocker`.
     */
    rank: integer('rank').notNull(),
    /** The smallest priority this band holds — 1 for rank 0, always. */
    startsAt: integer('starts_at').notNull(),
    label: text('label').notNull(),
    /** What choosing this band by name writes into a work item's priority. */
    defaultValue: integer('default_value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.rank] })],
);

export type ProjectPriorityBandRow = typeof projectPriorityBand.$inferSelect;

/**
 * The closed set of things a {@link person} row can be.
 *
 * Exported for the same reason {@link MEASURE_METRICS} is: the directory route
 * and the card take one of these as a value rather than a boolean, so the day a
 * third kind arrives it is a value added here and not a schema change.
 * `openspec/changes/token-tracking/design.md` D6.
 */
export const PERSON_KINDS = ['person', 'agent'] as const;

export type PersonKind = (typeof PERSON_KINDS)[number];

/**
 * Somebody who does work. Global, like the teams, and for the same reason.
 *
 * Not a `users` row: the people a plan assigns work to are mostly not accounts
 * on this tool, and requiring them to be would make the field unusable on the
 * day it is needed. If the two ever have to meet, they meet through a column
 * added then, not through a foreign key guessed at now.
 *
 * `kind` says whether the row is a human or an AI agent. Dany, 2026-08-20:
 * _"Also maybe allow to set agent as assignee. I mean mark ppl as agents vs
 * person."_ Design D6, and three parts of it are worth keeping next to the
 * column:
 *
 * **A column, not a boolean `is_agent`.** A third kind is plausible — a service
 * account, a team inbox — and under a boolean each one is a migration plus a
 * rewrite of every `if` that read it. Under a `CHECK`ed set it is a value.
 *
 * **A column, not a table.** A `person_kind` table would buy renameable labels
 * for a set whose members are dispatched on by name in code; the label and the
 * key would then be free to disagree.
 *
 * **The default is a claim, and it is the one exception this design makes.**
 * Everywhere else absence means "nobody has said" and is never filled with a
 * guess. Here `NOT NULL DEFAULT 'person'` writes `person` onto every row that
 * predates the column. That is not a guess: the directory predates agents
 * entirely, so `person` is what those rows *are*. It is also what keeps the
 * blue/green swap window safe — the outgoing release's
 * `INSERT INTO person (id, name)` knows nothing of this column and must keep
 * working while green migrates.
 *
 * `kind` is a Drizzle enum **and** a `CHECK`, the pair {@link roleMeasure} and
 * {@link roleProgress} use, for the identical reason: the enum is erased at
 * runtime and a third value written by a hand-edit or a stale release would be
 * dispatched on by every reader and folded by none of them.
 *
 * Nothing about scheduling changes. An agent is assigned, and appears in
 * capacity, exactly as a person is — the classification is what the reports and
 * the future SDLC integration read, and `service/schedule.ts` has an empty diff
 * in the change that adds it.
 */
export const person = sqliteTable(
  'person',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: PERSON_KINDS }).notNull().default('person'),
  },
  (t) => [
    uniqueIndex('person_name').on(t.name),
    check('person_kind', sql`${t.kind} IN ('person', 'agent')`),
  ],
);

export type PersonRow = typeof person.$inferSelect;

/**
 * Which teams a person belongs to — several, deliberately.
 *
 * Dany, 2026-08-06: "one assignee might be from different service/teams". A
 * person with no rows here is a **free agent**, which is computed on read
 * rather than stored as membership of a magic team: a real "Free agents" row
 * could be renamed, deleted or assigned work of its own, and then the default
 * would mean whatever somebody last did to it.
 */
export const personTeam = sqliteTable(
  'person_team',
  {
    personId: text('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    serviceTeamId: text('service_team_id')
      .notNull()
      .references(() => serviceTeam.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.personId, t.serviceTeamId] })],
);

export type PersonTeamRow = typeof personTeam.$inferSelect;

/**
 * Who does one work item's work for one role — one person per phase.
 *
 * The primary key is the pair, so a work item has at most one Dev and at most
 * one QA. Dany, 2026-08-06: "one per dev, one per QA", and "when just one is
 * assigned it is assumed they do both" — that last part is a **reading** of an
 * absent row, not a second row written on somebody's behalf, so nobody is
 * recorded against work they were never given.
 *
 * The person is deliberately unconstrained by the work item's `serviceTeamId`:
 * Dany's call, "keep people and service/team lists decoupled for the work
 * item". A team labels the work; a person does it; the two need not match.
 */
export const assignment = sqliteTable(
  'assignment',
  {
    workItemId: text('work_item_id')
      .notNull()
      .references((): AnySQLiteColumn => workItem.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.workItemId, t.roleId] })],
);

export type AssignmentRow = typeof assignment.$inferSelect;

/**
 * A finish-to-start dependency: `successor` cannot start until `predecessor`'s
 * **anchor slice** — its first slice in role order — finishes; the
 * predecessor's later roles run in parallel with the successor
 * (`service/schedule.ts`).
 *
 * Either end may be a parent, and that is the point — "all of 010's first-role
 * work before any of 020" is what a planner writes, and drawing an edge from
 * every leaf under 010 would be tedious and wrong the moment a leaf is added.
 * The expansion to leaves happens when the schedule is computed, not here;
 * storing it would be a second copy to fall out of date with the tree.
 *
 * `projectId` is denormalised from the two work items so a project's edges are
 * one indexed read rather than a join. It does **not** make a cross-project edge
 * unrepresentable — the three foreign keys are independent, and nothing ties
 * either endpoint's project to this one. `canDepend` refuses it, and the read
 * drops an edge whose predecessor is not in the project; enforcing it in the
 * schema would need composite keys. An earlier version of this comment claimed
 * the stronger thing, which a reviewer was right to call out.
 *
 * The work-item references cascade on delete. The application removes edges
 * before deleting a row, but blue and green share one SQLite file during a swap:
 * the outgoing release knows nothing about this table, and its plain
 * `DELETE FROM work_item` would hit a constraint it cannot see and answer 500.
 * The cascade is what keeps a migration applied under the old release safe.
 *
 * The unique pair is what makes adding the same dependency twice a no-op at the
 * database rather than a decision in the service.
 */
export const dependency = sqliteTable(
  'dependency',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    predecessorId: text('predecessor_id')
      .notNull()
      .references((): AnySQLiteColumn => workItem.id, { onDelete: 'cascade' }),
    successorId: text('successor_id')
      .notNull()
      .references((): AnySQLiteColumn => workItem.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('dependency_project').on(t.projectId),
    uniqueIndex('dependency_pair').on(t.predecessorId, t.successorId),
  ],
);

export type DependencyRow = typeof dependency.$inferSelect;

/**
 * One command somebody ran, and everything needed to reverse it — the undo
 * stack, held on the server so it survives a reload.
 *
 * **One stack per (project, account).** Undo is personal: reversing somebody
 * else's last edit because it happened to be the newest is how a shared plan
 * loses work nobody meant to lose. Two browser tabs of one account share one
 * stack, which is accepted and stated in
 * `openspec/changes/conditional-undo/design.md`.
 *
 * `seq` orders that stack and is assigned by SQLite from the pair's current
 * maximum, inside the `INSERT` itself — the same rule as `work_item.revision`
 * and for the same reason. Two processes sharing the file mid-swap would
 * otherwise both read the same maximum and both write it, and the unique index
 * on `(project_id, user_id, seq)` would then refuse the second insert, failing
 * an edit that had already been applied.
 *
 * `payload` holds what the command did, as `{label, forward}`: the sentence
 * shown after an undo, and the command a **redo** re-applies. `inverse` holds
 * the compensating command that reverses it, carrying the before-state it
 * needs — the old field value, the removed trio, the whole deleted subtree.
 * `preconditions` holds `{workItemId: revision}` for every entity the command
 * touched, at the revisions the command **left them at**: an undo applies only
 * when every one of them still reads that number, and otherwise refuses out
 * loud rather than overwriting whatever arrived since.
 *
 * `undone` is which half of the stack an entry is in — 0 is undoable, 1 is
 * redoable. A redo flips it back. Undo and redo append nothing here: an undo
 * that was itself journalled would be undoable, and pressing the key twice
 * would toggle one change forever instead of walking back through two.
 *
 * The three JSON columns are text this process wrote and reads back. The
 * service checks the command discriminator and nothing else; see
 * `readCommand` for why, and for what that leaves unchecked.
 */
export const commandJournal = sqliteTable(
  'command_journal',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    inverse: text('inverse').notNull(),
    preconditions: text('preconditions').notNull(),
    undone: integer('undone', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('command_journal_stack').on(t.projectId, t.userId, t.seq)],
);

export type CommandJournalRow = typeof commandJournal.$inferSelect;

/**
 * One command somebody ran on one project, kept — the plan's history.
 *
 * **This is the third log in this file and it is not either of the other two.**
 * `event_log` is the websocket resume buffer, keyed by subscription and pruned
 * by count. `command_journal` is an undo stack: one per (project, **account**),
 * fifty deep, and its `append` deletes that account's redo branch every time it
 * writes. Neither can answer "how did this estimate move" — the first never
 * held it, and the second is per-person, evicted after an afternoon's editing,
 * and loses anything undone. Dany, 2026-08-13: *"so that later I can examine
 * the history of estimates changes"*. `notes/wbs-brief-2026-08-14-r5-r6-history.md`
 * §1.1 lists all five properties that rule the journal out.
 *
 * **Per project, not per account.** Two people editing one plan produce two
 * disjoint undo stacks and one history, because the history is the plan's and
 * not anybody's. `user_id` is who did it, which the sentence in `label` names.
 *
 * **Append-only.** Every row is written by one `INSERT` from
 * `WorkItemService.record`, inside the transaction that appends to the journal —
 * so a command cannot become undoable without also becoming history. Nothing
 * updates a row. The only `DELETE` is retention, by **age** and never by count:
 * pruning a history table by count is deletion of exactly the thing being asked
 * for. See {@link PLAN_EVENT_RETENTION_DAYS}.
 *
 * `work_item_id` and `role_id` are **not** foreign keys, and that is the whole
 * point of a history. A cascade would delete the record of an item when the item
 * went — losing the estimate changes of the very row somebody is asking about —
 * and a restricting reference would refuse the delete instead. The same argument
 * `frozenNumber` makes for a number that has left the tool. They are nullable
 * because not every command has one subject: a freeze touches the whole plan.
 *
 * `before` and `after` hold the two commands `record` already builds: `after` is
 * the forward command a redo would re-apply, `before` the compensating command
 * an undo would, which is where the before-state lives — `set_estimate` carries
 * the trio that was there. For the estimate kinds that pair *is* the before and
 * after of the figure, which is what R5 asks for; for a structural command it is
 * the two commands, because that is the only before-state that exists. Both are
 * `NOT NULL`: every row comes from `record`, which always holds both, so a
 * nullable column would be a state nothing can write.
 *
 * The project reference cascades, and it has to. Blue and green share one SQLite
 * file during a swap and the outgoing release knows nothing about this table, so
 * its plain `DELETE FROM project` would hit a constraint it cannot see and answer
 * 500 — the argument `dependency` and `project_priority_band` both make.
 * `user_id` cascades for the same reason and no other: nothing in the product
 * deletes an account today, and a history row outliving its `users` row would be
 * a foreign key nothing could satisfy.
 */
export const planEvent = sqliteTable(
  'plan_event',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** The sentence `record` already built — `estimate “Strip the roof”`. */
    label: text('label').notNull(),
    /** The one work item the command was aimed at, or null when it named many. */
    workItemId: text('work_item_id'),
    /** The role, for the kinds that carry one: the estimate kinds and `assign`. */
    roleId: text('role_id'),
    before: text('before').notNull(),
    after: text('after').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('plan_event_project_time').on(t.projectId, t.createdAt),
    index('plan_event_item').on(t.workItemId, t.createdAt),
  ],
);

export type PlanEventRow = typeof planEvent.$inferSelect;
