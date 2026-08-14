import {
  type AnySQLiteColumn,
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
    passwordHash: text('password_hash').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('users_username').on(t.username)],
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
export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id),
  restricted: integer('restricted', { mode: 'boolean' }).notNull().default(false),
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
});

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
     */
    priority: integer('priority'),
    /**
     * The team this work is labelled with, or null. A label on the work, not a
     * constraint on who may be assigned it.
     *
     * **Written, and no longer read** — `resource-model`, 2026-08-14. The label
     * is a set now, held in {@link workItemTeam}, and every read path in this
     * release takes it from there. This column is still written beside that
     * table on every path that changes a label, because blue and green share
     * one SQLite file and the outgoing release selects this column on every
     * tree read. The drop, and the end of the mirror, is R2-6.
     *
     * **The deployed column does carry a foreign key**, and this drizzle
     * definition does not say so — `20260806190000_add_teams_and_assignees`
     * writes `REFERENCES service_team(id)` with no `ON DELETE`, so a team that
     * still labels work cannot be deleted at all. `DirectoryRepository.removeTeam`
     * nulls this column inside the transaction that deletes the team, which is
     * why that path works and why nothing noticed the drift. Measured
     * 2026-08-14 against a migrated database, not read off this file; the
     * comment on `WorkItemRepository.patch` that calls the column
     * foreign-key-free is wrong about the same thing, and correcting the
     * definition would be a migration rather than an edit here. `resource-model`
     * records it (verify.md) and does not touch it.
     */
    serviceTeamId: text('service_team_id'),
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
 * Which teams one work item's work belongs to — 0..n of them, one row each.
 *
 * Dany, 2026-08-13: _"can be several teams and several services per work
 * item"_. This is the team half; {@link workItemService} is the other, and the
 * two are separate tables because {@link service} is separate from
 * {@link serviceTeam} — a team carries capacity and a service is a label
 * (Q1/Q3, 2026-08-13, `notes/wbs-brief-2026-08-13-r2-team-service.md` §10).
 *
 * **This table is what a reader reads.** `work_item.service_team_id` is still
 * written — `resource-model` mirrors every write into both — and is still what
 * the outgoing release selects, but no read path in this release consults it
 * for the label any more. The migration seeded one row here per work item that
 * carried a non-null column, so the two say the same thing on the day this
 * lands; they stay in step because the mirror is inside
 * `WorkItemRepository`'s own transactions.
 *
 * **Writes are capped at one row per work item in this release**, and the cap
 * is the whole reason nothing observable moved when the table arrived: a set of
 * one is the column, so every plan schedules identically. `multi-team-engine`
 * (R2-2) is what makes several spend several pools; until then a second row
 * would reach `soleMemberOf` and throw rather than be quietly half-read.
 *
 * Primary key is the pair, because the pair is the fact: naming the same team
 * twice is one statement, not two. Both columns cascade for
 * {@link projectTeamCapacity}'s reason — blue and green share one SQLite file,
 * and the outgoing release's plain `DELETE FROM service_team` must not hit a
 * constraint it cannot see.
 *
 * The index on `team_id` serves the direction the primary key cannot: the
 * directory's removal asks "which work items name this team", which is a scan
 * of the whole table without it.
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
 * A product area a work item's work belongs to — Payments, Auth, Reporting.
 *
 * **A label, and never a pool.** Dany, 2026-08-13 23:41, answering what a
 * service is against a team: _"A label."_ It has no size, no capacity row, no
 * members and **no effect on any date**. That is not a property of today's code
 * that a later change may quietly take away: no service id reaches
 * `schedule()`, the pool ids are built from the team set alone, and
 * `schedules the same plan identically with every row labelled with services`
 * in `service-labels-move-nothing.test.ts` is the differential that fails if
 * one ever does.
 *
 * **Global and user-extensible** (Q7, 2026-08-13 23:59): one list across every
 * project, the same shape as {@link serviceTeam} with the capacity cut out.
 * Deliberately no `project_id` — Payments means Payments in every plan, which
 * is what makes an export column, and R3's name-matched import, well defined.
 * A work item points at a row here and never carries free text, or `Payments`
 * and `payments ` would be two product areas with nothing to rename.
 *
 * Unique name at the database rather than only in the service, for
 * {@link serviceTeam}'s reason: two people creating `Payments` at the same
 * moment both pass a check-then-insert and only a constraint stops the second.
 *
 * **Two confusable nouns, said out loud**: `service_team` holds *teams* despite
 * its name and `service` holds *labels*; a reader grepping `service` gets both.
 * The rename of `service_team` to `team` is R2-6, once no running release reads
 * the old noun.
 *
 * Seeded with **nothing**, and there is no route that creates one in this
 * release: `resource-model` ships the schema and the read model, and
 * `service-label` (R2-5) ships the directory CRUD, the picker and the export
 * column. Today's `service_team` rows are pools, and nothing in the data
 * distinguishes a row somebody typed meaning "Payments" from one meaning
 * "Platform" — guessing would take a pool away from the rows that named it,
 * which is a date change nobody typed.
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
 * Which product areas one work item's work belongs to — 0..n of them.
 *
 * {@link workItemTeam}'s shape exactly, one dimension along, and the sameness
 * is deliberate: the two resolve through the same inheritance walk
 * (`effectiveSetOf`, `libs/domain`), each independently, because blank means
 * _unstated_ per dimension (Q4, 2026-08-13).
 *
 * What is **not** the same is what it costs: a row here spends no slot, clamps
 * no width and moves no date. See {@link service}.
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
 * Somebody who does work. Global, like the teams, and for the same reason.
 *
 * Not a `users` row: the people a plan assigns work to are mostly not accounts
 * on this tool, and requiring them to be would make the field unusable on the
 * day it is needed. If the two ever have to meet, they meet through a column
 * added then, not through a foreign key guessed at now.
 */
export const person = sqliteTable(
  'person',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('person_name').on(t.name)],
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
