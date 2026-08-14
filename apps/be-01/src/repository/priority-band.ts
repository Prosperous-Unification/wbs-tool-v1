import { DEFAULT_PRIORITY_BANDS, type PriorityBand } from '@wbs/domain';
import { asc, eq } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import type { PriorityBandStore, PriorityBandsWritten } from './index';
import { project, projectPriorityBand } from './schema';

/**
 * What one project calls its priority numbers.
 *
 * The shape is `CapacityRepository`'s — a per-project configuration table, read
 * by every face, written from the plan's own toolbar — and the one place it
 * deliberately departs is the read. A capacity pair with no row is _unstated_ and
 * constrains nothing, because Dany's call was that no global number may reach a
 * plan nobody typed it for. A ladder with no rows is the **default ladder**, and
 * the two are not the same shape wearing different names: the thing being read
 * back there was a number somebody set on another screen for another plan, and
 * the thing being read back here is a constant in the source that says what a
 * priority ladder is. `openspec/changes/priority-bands/design.md` D2.
 *
 * Nothing here bumps a revision. A ladder is a fact about the project and not
 * about any work item, the numbers it names are stored already, and the project
 * row's own revision counts writes to that row.
 */
export class PriorityBandRepository implements PriorityBandStore {
  constructor(private readonly db: SQLiteBunDatabase) {}

  /**
   * This project's five bands in rank order, or the default five where it holds
   * none.
   *
   * Rank order is the contract and not the planner's opinion: rank 0 is the most
   * important rung on every face, and a list that came back in insertion order
   * would colour a plan by whichever row SQLite reached first.
   *
   * Proof that the fallback is a fallback and not the only answer: the `length
   * === 0` arm replaced by an unconditional `DEFAULT_PRIORITY_BANDS`, and
   * three cases went red, `trims a name on the way in` on
   * `Expected: "Blocker" / Received: "Critical"` — a project that had re-cut its
   * ladder handed the five it had replaced. 4 pass, 3 fail; watched 2026-08-14.
   *
   * Proof that it is reached at all: the arm deleted so a project with no rows
   * answers `[]`, and **two** cases went red — `answers the default ladder for a
   * project holding no rows of its own` on a `toEqual` diff of all five bands
   * (`Expected - 27 / Received + 1`), and `answers a project's own ladder rather
   * than the default one`, whose second plan is the same state. 5 pass, 2 fail;
   * watched 2026-08-14. That is the state every project created after this
   * migration is in until somebody edits a rung.
   */
  async listFor(projectId: string): Promise<PriorityBand[]> {
    const rows = await this.db
      .select({
        startsAt: projectPriorityBand.startsAt,
        label: projectPriorityBand.label,
        defaultValue: projectPriorityBand.defaultValue,
      })
      .from(projectPriorityBand)
      .where(eq(projectPriorityBand.projectId, projectId))
      .orderBy(asc(projectPriorityBand.rank));
    if (rows.length === 0) return DEFAULT_PRIORITY_BANDS.map((band) => ({ ...band }));
    return rows;
  }

  /**
   * Replaces this project's whole ladder in one transaction.
   *
   * **Delete-then-insert, not an upsert per rung.** The ladder that arrives is
   * the ladder that is stored, so a project holding five rows and a project
   * holding none end in the same state from the same request — which is what lets
   * the read's default arm and a real write agree about what a ladder is. An
   * upsert would leave a project that somehow held six rows holding a sixth
   * forever.
   *
   * The project's existence is read **inside** the transaction, which is
   * `CapacityRepository.set`'s rule: the read is the decision, not a report about
   * it, and the foreign key would otherwise refuse an absent id by throwing a
   * `SQLiteError` out of a `run` — an unknown at the service boundary where a
   * modeled 404 is owed.
   *
   * The ladder itself is **not** validated here. `priorityLadderProblem` is the
   * one guard and the controller is its one caller; a second copy in the store is
   * a rule free to disagree with the one a client is answered against.
   *
   * Proof: the existence read deleted, leaving the foreign key as the only guard,
   * and `refuses a project that is not there, and writes nothing` failed with an
   * uncaught `SQLiteError: FOREIGN KEY constraint failed` where a modeled
   * `not_found` was owed. Watched 2026-08-14.
   *
   * Proof that the delete is load-bearing: the `tx.delete` struck, and `replaces
   * the whole ladder rather than merging into it` failed with
   * `UNIQUE constraint failed: project_priority_band.project_id,
   * project_priority_band.rank` — five rows written over five that were never
   * taken away. Watched 2026-08-14.
   */
  async replace(projectId: string, bands: readonly PriorityBand[]): Promise<PriorityBandsWritten> {
    await Promise.resolve();
    return this.db.transaction((tx) => {
      const held = tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, projectId))
        .all();
      if (held.length === 0) return { ok: false, reason: 'not_found' };
      tx.delete(projectPriorityBand).where(eq(projectPriorityBand.projectId, projectId)).run();
      tx.insert(projectPriorityBand)
        .values(
          bands.map((band, rank) => ({
            projectId,
            rank,
            startsAt: band.startsAt,
            label: band.label.trim(),
            defaultValue: band.defaultValue,
          })),
        )
        .run();
      return { ok: true };
    });
  }
}
