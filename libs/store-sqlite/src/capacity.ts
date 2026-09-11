import type { CapacityStore, CapacityWritten, TeamCapacity, WriteStamp } from '@wbs/core';
import { and, asc, eq } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnCreate, auditOnUpdate } from './audit';
import type { Gate } from './gate';
import { project, projectTeamCapacity, serviceTeam } from './schema';

/**
 * How many of each team may be at work at once on one project's plan.
 *
 * **Nothing in this file reads `service_team.size`**, and that is the change
 * rather than an implementation detail of it: Dany's call on 2026-08-13 was that
 * the global number stops mattering, so a pair with no row here is _unstated_ and
 * constrains nothing. `openspec/changes/capacity-per-project/design.md` D1.
 *
 * It is C1's `slotsOf` seam with the lookup behind it at last. C1's comment in
 * `work-item.service.ts` predicted "one additive table and a first lookup here",
 * and this is the table and the lookup; what C1 also predicted — "with this as
 * the fallback" — is the half Dany's second sentence removed.
 *
 * No revision is bumped by any write here. A capacity is a fact about the
 * project, not about a work item, and the numbers it moves are computed on read
 * rather than stored — so there is no stale-write hazard for a counter to guard.
 * The project's own revision is left alone too: it counts writes to the project
 * **row**, and this writes a different table.
 *
 * Proof that `slotsFor` is not the retired column in disguise: pointed at
 * `service_team.size` with the fixture's teams globally sized to match the first
 * project, `answers one project's own numbers, and never another's` failed on the
 * second project's map — it was handed the first's. Two more tests went with it.
 * Watched 2026-08-13.
 *
 * Proof against the **other** shape of the same mistake, which is the one a
 * maintainer writes: the per-project read kept and `serviceTeam.size` added
 * behind it for pairs with no row — D1's rejected "override in front of the
 * global number". That injection left all 693 be-01 tests green until
 * `never falls back to a globally sized team nobody stated per project` was
 * written for it; it now fails on `Expected: false / Received: true`. Watched
 * 2026-08-13. The difference between the two is worth holding: the replacement
 * disagrees with the seeding on day two, the addition agrees with everything
 * until somebody makes a project.
 */
export class CapacityRepository implements CapacityStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * One indexed read — the primary key's own prefix — keyed on the team alone,
   * because one call is one project.
   *
   * A team this project has stated nothing about is **absent** rather than
   * present as `null`. The engine reads an absent key as unconstrained, which is
   * exactly what unstated means, and a `null` in the map would be a value every
   * caller had to test for on the way to the same answer.
   */
  async slotsFor(projectId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        serviceTeamId: projectTeamCapacity.serviceTeamId,
        size: projectTeamCapacity.size,
      })
      .from(projectTeamCapacity)
      .where(eq(projectTeamCapacity.projectId, projectId));
    return new Map(rows.map((row) => [row.serviceTeamId, row.size]));
  }

  /**
   * The same fact in the shape the payload carries, ordered by team id.
   *
   * The order is part of the contract rather than the query planner's opinion: a
   * payload whose array reshuffles between two reads makes every client that
   * renders it in order redraw for no reason, and makes a diff of two captures
   * unreadable.
   */
  async listFor(projectId: string): Promise<TeamCapacity[]> {
    return this.db
      .select({
        serviceTeamId: projectTeamCapacity.serviceTeamId,
        size: projectTeamCapacity.size,
      })
      .from(projectTeamCapacity)
      .where(eq(projectTeamCapacity.projectId, projectId))
      .orderBy(asc(projectTeamCapacity.serviceTeamId));
  }

  /**
   * Sets this project's capacity for one team, or clears it on `null`.
   *
   * **`null` deletes the row.** Unstated has one spelling and it is the absence
   * of one — the argument is on `projectTeamCapacity.size` in `schema.ts`. So
   * this is not an update to `NULL`, and a clear of something never stated is a
   * delete of no rows, which is `ok` rather than `not_found`: a client emptying
   * a box that was already empty has not made a mistake.
   *
   * Both ids are read **inside the write's own transaction**, which is the
   * `StepRepository.remove` rule — the read is the decision, not a report about
   * it. The foreign keys would refuse an absent id anyway, and they would do it
   * by throwing a `SQLiteError` out of a `run`: an unknown at the service
   * boundary rather than the modeled 404 a caller can be answered with.
   *
   * Proof: both existence reads deleted, leaving the constraints as the only
   * guard, and `refuses a project or a team that is not there, and writes
   * nothing` failed with an uncaught `SQLiteError: FOREIGN KEY constraint
   * failed` where a modeled `not_found` was owed. Watched 2026-08-13.
   */
  async set(
    projectId: string,
    serviceTeamId: string,
    size: number | null,
    stamp: WriteStamp,
  ): Promise<CapacityWritten> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      return this.db.transaction((tx) => {
        // The clear needs neither id to exist to be honest about its outcome — it
        // is still checked, because "cleared the capacity of a project that is not
        // there" is a claim this must not make.
        const held = tx
          .select({ id: project.id })
          .from(project)
          .where(eq(project.id, projectId))
          .all();
        if (held.length === 0) return { ok: false, reason: 'not_found' };
        const team = tx
          .select({ id: serviceTeam.id })
          .from(serviceTeam)
          .where(eq(serviceTeam.id, serviceTeamId))
          .all();
        if (team.length === 0) return { ok: false, reason: 'not_found' };

        if (size === null) {
          tx.delete(projectTeamCapacity)
            .where(
              and(
                eq(projectTeamCapacity.projectId, projectId),
                eq(projectTeamCapacity.serviceTeamId, serviceTeamId),
              ),
            )
            .run();
          return { ok: true };
        }
        // Upsert on the pair rather than a read-then-write: two clients typing
        // into the same box at once both pass a check-then-insert, and only the
        // primary key stops the second from becoming a second answer to one
        // question.
        tx.insert(projectTeamCapacity)
          .values({ projectId, serviceTeamId, size, ...auditOnCreate(stamp) })
          .onConflictDoUpdate({
            target: [projectTeamCapacity.projectId, projectTeamCapacity.serviceTeamId],
            set: { size, ...auditOnUpdate(stamp) },
          })
          .run();
        return { ok: true };
      });
    });
  }
}
