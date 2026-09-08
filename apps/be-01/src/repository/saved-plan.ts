import { and, desc, eq, sql } from 'drizzle-orm';

import { isWriteLockBusy } from './constraint';
import type { Connection, Drizzle } from './db';
import { drizzleOuterTransaction, drizzleReadTransaction, refuseToWaitForWriteLock } from './db';
import type { SavedPlanStore } from './saved-plan-ports';
import type { SavedPlanRow } from './schema';
import { project, savedPlan, savedPlanBody } from './schema';

/**
 * How the writer obtains the connection it takes the write lock on.
 *
 * A **new** connection each call, closed on every path — `openConnection`
 * injected exactly as {@link SavedPlanCaptureRepository} takes it, and for the
 * stronger of that class's two reasons. Obligation (i) of the topology
 * (design.md, "The three write-path requirements"): today be-01 opens one
 * process handle, so a save written against it would put two body writes inside
 * whatever the request path is doing, and the guarantee that a live edit
 * completes during a save would be void whatever `busy_timeout` says.
 */
export interface SavedPlanWriteOptions {
  readonly openConnection: () => Connection;
}

/** One side's stored bytes and the hash taken over them. */
export interface SavedPlanBodyWrite {
  /** `CanonicalPlanInput`'s (or the schedule body's) schema version. */
  readonly schemaVersion: number;
  /** The serialized body, exactly as hashed and exactly as stored. */
  readonly bytes: string;
  /** SHA-256 over those bytes, computed by the caller that serialized them. */
  readonly sha256: string;
}

/**
 * The schedule side, present or absent — **a union, not five nullable fields.**
 *
 * `saved_plan`'s `saved_plan_schedule_all_or_nothing` check refuses half a
 * schedule, and a record shaped as five optional columns can express one: five
 * fields that can disagree are five ways to store a state the reader would then
 * have to pick a belief about (`schema.ts`). Here the illegal states are
 * unconstructible, so the constraint is a second opinion rather than the only
 * one, and a caller cannot reach a `SQLITE_CONSTRAINT` from a type that
 * compiled.
 */
export type SavedPlanScheduleWrite =
  | {
      readonly present: true;
      readonly body: SavedPlanBodyWrite;
      /**
       * The `input_sha256` these dates were computed from — stored rather than
       * assumed so a reader can *check* it and refuse to render dates against
       * an input that did not produce them.
       */
      readonly inputSha256: string;
      /** Which scheduling algorithm produced the dates. */
      readonly algorithmId: string;
    }
  | {
      readonly present: false;
      /** Why there is no schedule. Never empty: absence still has a reason. */
      readonly absentReason: string;
    };

/** One save, as the service hands it over: a header and one or two bodies. */
export interface SavedPlanWrite {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** The display name at the instant of the save, by value — never a `users` reference. */
  readonly createdBy: string;
  /**
   * The saving account, **by reference** — the only column task 6.1's permission
   * rule may read (assumption A-8).
   *
   * Required and nullable rather than optional, deliberately. `null` is a real
   * answer — a save with no authenticated account behind it — and it is the same
   * answer a deleted creator leaves: the rule falls back to the project owner.
   * An optional field would let a caller omit it by accident and get that
   * fallback for every plan it writes, which is the whole permission rule
   * quietly switched off. Stating it is cheap; forgetting it must not compile.
   */
  readonly createdById: string | null;
  /**
   * The instant the capture's read snapshot **opened**, not the instant this
   * transaction commits. A slow capture makes the two differ, and the honest
   * label on a comparison is when the plan was looked at.
   */
  readonly createdAt: number;
  readonly input: SavedPlanBodyWrite;
  readonly schedule: SavedPlanScheduleWrite;
}

/**
 * What one call to {@link SavedPlanRepository.write} did — three states, as a
 * union rather than `Refusal | null`.
 *
 * A nullable refusal has room for two answers and there are three: written,
 * refused by the caller's own check, and refused by SQLite because another
 * connection holds the write lock. Folding the third into `null` would report a
 * save that did not happen; folding it into `Refusal` would make every caller's
 * refusal type carry a case that is not about that caller's rule. Widening the
 * return instead makes the new state unignorable — a caller that still reads
 * the answer as a nullable stops compiling, which is how `snapshot_busy` got in
 * front of the service rather than past it.
 */
export type SavedPlanWriteOutcome<Refusal> =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'refused'; readonly refusal: Refusal }
  /** `BEGIN IMMEDIATE` met a lock another connection holds. Nothing was written. */
  | { readonly outcome: 'snapshot_busy' };

/**
 * One saved plan exactly as it is stored — header row, and each side's bytes.
 *
 * Both bodies are nullable because both absences are real and mean different
 * things: a schedule-less save writes no `schedule` row at all, and a missing
 * `input` row is a fault. Deciding which is which is the reader's business, not
 * this shape's, so it reports what it found rather than a verdict.
 */
export interface StoredSavedPlan {
  readonly header: SavedPlanRow;
  readonly bodies: {
    readonly input: string | null;
    readonly schedule: string | null;
  };
}

/** What a project already holds, for the in-transaction quota check. */
export interface SavedPlanHoldingRow {
  readonly plans: number;
  readonly bytes: number;
}

/**
 * What a rename or a delete found, said as an outcome rather than a boolean.
 *
 * Both statements are `UPDATE`/`DELETE ... WHERE id = ?` and both can match
 * nothing, which is a fact the route has to turn into an answer. `false` would
 * carry the same information and lose the name for it at every call site.
 */
export type SavedPlanTouchOutcome = 'touched' | 'no_such_plan' | 'snapshot_busy';

/**
 * The two ids a rename or a delete has to be authorised against, and nothing
 * else.
 *
 * A **header-only** shape, and the reason it is not
 * {@link SavedPlanService.read}'s job: that path reads every stored byte and can
 * answer `corrupt`, and a corrupt plan must still be renameable and deletable or
 * it holds its project's quota forever with no way to reach it. Authorisation
 * must therefore be answerable about a plan nobody can open.
 *
 * `createdById` is nullable and `projectOwnerId` is not — the project's owner
 * exists whenever the project does, which is what makes it the fallback when no
 * live account claims the plan.
 */
export interface SavedPlanPrincipals {
  readonly savedPlanId: string;
  readonly projectId: string;
  readonly projectOwnerId: string;
  readonly createdById: string | null;
}

/**
 * The byte length of a body, measured **once**, here.
 *
 * `String.length` counts UTF-16 code units and is not the number of bytes
 * SQLite stores: one emoji in a work item's name is two units and four bytes.
 * The header's `input_bytes` and the quota's arithmetic have to be the same
 * measurement as each other or the bound is on a number nobody stores, so both
 * come through this function and neither counts for itself.
 */
export function bodyByteLength(bytes: string): number {
  return Buffer.byteLength(bytes, 'utf8');
}

/**
 * Writes a saved plan's header and bodies, and reads what a project holds.
 *
 * **No `UPDATE` is issued here, ever.** That is the whole immutability property
 * of `saved_plan_body` and it is stated as one sentence a reader can check
 * against this file (`schema.ts`). A rename is a different route's business and
 * touches the header's `name` alone.
 */
export class SavedPlanRepository implements SavedPlanStore {
  constructor(private readonly opts: SavedPlanWriteOptions) {}

  /**
   * The count and the byte total, as one read.
   *
   * Public and separate from {@link write} because the quota check it feeds
   * must run **inside** the write transaction: read outside it, two saves at 99
   * of 100 both pass and both commit while "refused before any row is written"
   * stays technically true (design.md, "Write order"). So it takes a `Drizzle`
   * rather than opening its own connection — the caller is already inside a
   * transaction on one, and a second connection here would read a snapshot the
   * write lock does not cover.
   *
   * The total sums the **stored** `input_bytes`/`schedule_bytes` rather than
   * measuring the body rows, so it costs one row of the header index and never
   * reads a megabyte to learn its size.
   */
  async holdingOf(db: Drizzle, projectId: string): Promise<SavedPlanHoldingRow> {
    const rows = await db
      .select({
        plans: sql<number>`count(*)`,
        // `coalesce` twice: the outer one for a project with no rows at all,
        // the inner for a row whose schedule side is absent and therefore null.
        // Without the inner one SQLite's `sum` over any null makes the whole
        // total null, and a project holding one schedule-less plan would read
        // as holding no bytes.
        bytes: sql<number>`coalesce(sum(${savedPlan.inputBytes} + coalesce(${savedPlan.scheduleBytes}, 0)), 0)`,
      })
      .from(savedPlan)
      .where(eq(savedPlan.projectId, projectId));
    // An aggregate over no rows is still one row, so the empty case is the
    // `coalesce` above and not this line. It is written as a length check
    // rather than as `rows[0]?.plans ?? 0` because drizzle types the element
    // as present and the lint rule refuses a chain it can prove unnecessary.
    return rows.length === 0
      ? { plans: 0, bytes: 0 }
      : { plans: rows[0].plans, bytes: rows[0].bytes };
  }

  /**
   * Header, input body, schedule body, commit — on this class's own connection.
   *
   * `check` runs inside the transaction, after `BEGIN IMMEDIATE` and before any
   * insert, and returning a value from it refuses the save with nothing
   * written. It is a parameter rather than a step the caller takes first
   * because the only place the quota can be honestly read is in here, holding
   * the write lock; a caller that checked before calling would be checking a
   * number another save is free to change.
   *
   * The rollback is unconditional on failure and the connection is closed on
   * every path. A body write that throws leaves no header behind: that is 4.3's
   * subject, and it is a property of this ordering rather than of a later test.
   *
   * **A save never waits for the write lock.** `busy_timeout` is turned off on
   * this connection first, so a lock another connection holds refuses this
   * attempt in about a millisecond instead of blocking on it for five seconds.
   * The mechanism is SQLite's own lock and not a marker in this process:
   * blue and green are two processes on one file during a swap, and a set of
   * in-flight project ids in either of them is invisible to the other. What the
   * refusal buys is that no save ever *holds* the lock while waiting, which is
   * the behaviour that would queue every live edit in the project behind two
   * body writes (design.md, "Fail-fast, not queue").
   *
   * Only `BEGIN` is watched for it. A `SQLITE_BUSY` out of a later statement is
   * not this condition — the lock is already held by then — so it stays an
   * unknown and is thrown.
   */
  async write<Refusal>(
    plan: SavedPlanWrite,
    check: (holding: SavedPlanHoldingRow, incomingBytes: number) => Promise<Refusal | null>,
  ): Promise<SavedPlanWriteOutcome<Refusal>> {
    const inputBytes = bodyByteLength(plan.input.bytes);
    const scheduleBytes = plan.schedule.present ? bodyByteLength(plan.schedule.body.bytes) : null;
    const connection = this.opts.openConnection();
    try {
      const db = connection.db;
      refuseToWaitForWriteLock(db);
      const tx = drizzleOuterTransaction(db);
      try {
        tx.begin();
      } catch (failure) {
        if (!isWriteLockBusy(failure)) throw failure;
        // Nothing was written and no transaction is open, so there is nothing
        // to roll back — `BEGIN` is the statement that failed.
        return { outcome: 'snapshot_busy' };
      }
      try {
        const refusal = await check(
          await this.holdingOf(db, plan.projectId),
          inputBytes + (scheduleBytes ?? 0),
        );
        if (refusal !== null) {
          // Nothing has been written, so this releases the write lock rather
          // than undoing anything. `ROLLBACK` and not `COMMIT` all the same:
          // committing a transaction opened to write and then refused would
          // read, in a log, as a save that happened.
          tx.rollback();
          return { outcome: 'refused', refusal };
        }
        await db.insert(savedPlan).values({
          id: plan.id,
          projectId: plan.projectId,
          name: plan.name,
          createdBy: plan.createdBy,
          createdById: plan.createdById,
          createdAt: plan.createdAt,
          inputSchemaVersion: plan.input.schemaVersion,
          inputBytes,
          inputSha256: plan.input.sha256,
          scheduleSchemaVersion: plan.schedule.present ? plan.schedule.body.schemaVersion : null,
          scheduleBytes,
          scheduleSha256: plan.schedule.present ? plan.schedule.body.sha256 : null,
          scheduleInputSha256: plan.schedule.present ? plan.schedule.inputSha256 : null,
          schedulerAlgorithmId: plan.schedule.present ? plan.schedule.algorithmId : null,
          scheduleAbsentReason: plan.schedule.present ? null : plan.schedule.absentReason,
        });
        await db
          .insert(savedPlanBody)
          .values({ savedPlanId: plan.id, kind: 'input', bytes: plan.input.bytes });
        if (plan.schedule.present) {
          await db
            .insert(savedPlanBody)
            .values({ savedPlanId: plan.id, kind: 'schedule', bytes: plan.schedule.body.bytes });
        }
        tx.commit();
        return { outcome: 'written' };
      } catch (failure) {
        tx.rollback();
        throw failure;
      }
    } finally {
      connection.close();
    }
  }

  /** One saved plan's stored body, or `null` when it has none of that kind. */
  async bodyOf(
    db: Drizzle,
    savedPlanId: string,
    kind: 'input' | 'schedule',
  ): Promise<string | null> {
    const rows = await db
      .select({ bytes: savedPlanBody.bytes })
      .from(savedPlanBody)
      .where(and(eq(savedPlanBody.savedPlanId, savedPlanId), eq(savedPlanBody.kind, kind)));
    // Absent for real here, unlike the aggregate above: a schedule-less save
    // writes no `schedule` row at all, which is the point of the body table.
    return rows.length === 0 ? null : rows[0].bytes;
  }

  /**
   * One saved plan's header and both stored bodies, read as of one instant.
   *
   * **The bytes come back untouched.** Nothing here parses a body, checks a
   * hash or looks at a version: this class's job is to hand over what is on
   * disk, and every judgement about whether it is trustworthy belongs to the
   * service, where it can be tested without a database. A repository that
   * validated would also be a repository that could quietly decline to return
   * the bytes a corruption report needs to name.
   *
   * **Header and bodies ride one read snapshot.** They are three rows in two
   * tables and a `DELETE` cascades across both, so two unsynchronised reads can
   * see a header whose bodies are already gone and report a hash fault for an
   * ordinary deletion. `BEGIN DEFERRED` costs nothing here and removes that
   * reading entirely.
   *
   * On its own connection, opened and closed on every path, for the reason
   * {@link SavedPlanCaptureRepository} states at length: `boot.ts` opens one
   * handle for the process, and a transaction held on it encloses whatever
   * every other in-flight request is doing.
   */
  async readOf(savedPlanId: string): Promise<StoredSavedPlan | null> {
    const connection = this.opts.openConnection();
    try {
      const db = connection.db;
      const tx = drizzleReadTransaction(db);
      tx.begin();
      try {
        const headers = await db.select().from(savedPlan).where(eq(savedPlan.id, savedPlanId));
        if (headers.length === 0) return null;
        const rows = await db
          .select({ kind: savedPlanBody.kind, bytes: savedPlanBody.bytes })
          .from(savedPlanBody)
          .where(eq(savedPlanBody.savedPlanId, savedPlanId));
        const bytesOf = (kind: 'input' | 'schedule'): string | null => {
          const row = rows.find((candidate) => candidate.kind === kind);
          return row === undefined ? null : row.bytes;
        };
        return {
          header: headers[0],
          bodies: { input: bytesOf('input'), schedule: bytesOf('schedule') },
        };
      } finally {
        // A read transaction has nothing to commit, and `COMMIT` on one that a
        // throw left open would be a second error on the way out. Rolling back
        // releases the snapshot on either path.
        tx.rollback();
      }
    } finally {
      connection.close();
    }
  }

  /**
   * Every saved plan a project holds, newest first — **headers only**.
   *
   * No body is read here and none can be: a project at the quota holds a
   * hundred plans and tens of megabytes of bytes, and a list that joined the
   * body table would load all of it to render a column of names. The header
   * carries the lengths and the hashes, which is everything a list shows.
   *
   * Ordered by `created_at` descending with `id` as the tie-break, so two plans
   * captured inside the same second have **an** order rather than SQLite's.
   * The capture stamps the instant its read snapshot opened, and two saves of
   * one project a moment apart is the ordinary case, not the exotic one.
   *
   * On its own connection, like {@link readOf} and unlike {@link holdingOf}.
   * The division is what the read is *for*, not what it costs: `holdingOf` and
   * `bodyOf` take a `Drizzle` because they run **inside** a caller's
   * transaction, where a second connection would read a snapshot the write lock
   * does not cover. This one is a route's whole answer, and a controller in
   * this app holds services rather than a database handle — a signature that
   * asked for one would push `boot.ts`'s process connection through the
   * controller layer to reach it.
   *
   * No read transaction: this is one statement against one table, which SQLite
   * already runs atomically. `readOf` needs `BEGIN DEFERRED` because a header
   * and its bodies are three rows in two tables and a cascade can land between
   * two unsynchronised reads; there is no second read here to synchronise with.
   */
  async listOf(projectId: string): Promise<SavedPlanRow[]> {
    const connection = this.opts.openConnection();
    try {
      return await connection.db
        .select()
        .from(savedPlan)
        .where(eq(savedPlan.projectId, projectId))
        .orderBy(desc(savedPlan.createdAt), savedPlan.id);
    } finally {
      connection.close();
    }
  }

  /**
   * Who may rename or delete one plan, as one row and no bodies.
   *
   * Joined to `project` rather than left to the caller, because the two ids are
   * one question — "may this account touch this plan" — and two round trips
   * across a `project` row that can be deleted between them would answer it
   * about a project that no longer exists. `innerJoin`, so a header whose
   * project is gone reads as no such plan, which is what a cascade leaves and
   * what a route should say.
   *
   * Its own connection, like every other read here, and it takes no write lock:
   * an authorisation check must never be the thing a live edit is queued behind.
   */
  async principalsOf(savedPlanId: string): Promise<SavedPlanPrincipals | null> {
    const connection = this.opts.openConnection();
    try {
      const rows = await connection.db
        .select({
          savedPlanId: savedPlan.id,
          projectId: savedPlan.projectId,
          projectOwnerId: project.ownerId,
          createdById: savedPlan.createdById,
        })
        .from(savedPlan)
        .innerJoin(project, eq(project.id, savedPlan.projectId))
        .where(eq(savedPlan.id, savedPlanId));
      return rows[0] ?? null;
    } finally {
      connection.close();
    }
  }

  /**
   * The one `UPDATE` this class issues, and it writes `name` alone.
   *
   * `.set({ name })` is not shorthand for brevity — `saved-plan-immutability.test.ts`
   * scans this folder's `.set({ … })` literals and fails on any `saved_plan`
   * column but this one, so the statement below is the guard's subject as well
   * as the rename. A hash added to this object is caught there rather than in
   * production, which is the point of writing the rename as one statement.
   *
   * On its own connection with the write lock refused rather than waited on,
   * for {@link write}'s reason: a rename is a header row and must never hold a
   * lock a live edit is queued behind.
   */
  async renameTo(savedPlanId: string, name: string): Promise<SavedPlanTouchOutcome> {
    const connection = this.opts.openConnection();
    try {
      const db = connection.db;
      refuseToWaitForWriteLock(db);
      let touched: { id: string }[];
      try {
        touched = await db
          .update(savedPlan)
          .set({ name })
          .where(eq(savedPlan.id, savedPlanId))
          .returning({ id: savedPlan.id });
      } catch (failure) {
        if (!isWriteLockBusy(failure)) throw failure;
        return 'snapshot_busy';
      }
      return touched.length === 0 ? 'no_such_plan' : 'touched';
    } finally {
      connection.close();
    }
  }

  /**
   * Deletes a saved plan's header; both body rows go with it.
   *
   * The cascade is `saved_plan_body`'s own foreign key (`schema.ts`) and not a
   * second statement here, so there is no ordering to get wrong and no window
   * in which a header is gone and its bytes are not. That is also why this is
   * one statement rather than a transaction: SQLite applies the cascade inside
   * the implicit one.
   *
   * Deleting is the only way a saved plan leaves, and it is permissioned like
   * the rename — creator or project owner (6.1), decided above this line.
   */
  async deleteOf(savedPlanId: string): Promise<SavedPlanTouchOutcome> {
    const connection = this.opts.openConnection();
    try {
      const db = connection.db;
      refuseToWaitForWriteLock(db);
      let removed: { id: string }[];
      try {
        removed = await db
          .delete(savedPlan)
          .where(eq(savedPlan.id, savedPlanId))
          .returning({ id: savedPlan.id });
      } catch (failure) {
        if (!isWriteLockBusy(failure)) throw failure;
        return 'snapshot_busy';
      }
      return removed.length === 0 ? 'no_such_plan' : 'touched';
    } finally {
      connection.close();
    }
  }
}
