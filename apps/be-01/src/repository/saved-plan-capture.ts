import type { PriorityBand } from '@wbs/domain';

import { ActualRepository } from './actual';
import { CapacityRepository } from './capacity';
import type { Connection } from './db';
import { drizzleReadTransaction } from './db';
import { DependencyRepository } from './dependency';
import { DirectoryRepository } from './directory';
import { EstimateRepository } from './estimate';
import type {
  Assignment,
  ExternalSystem,
  LabelledWorkItem,
  PersonWithTeams,
  Project,
  Service,
  Step,
  StoredActual,
  StoredDependency,
  StoredEstimate,
  StoredMeasure,
  StoredProgress,
  Tag,
  TeamWithServices,
  WorkItemType,
} from './index';
import { PriorityBandRepository } from './priority-band';
import { ProjectRepository } from './project';
import { StepMeasureRepository } from './step-measure';
import { StepProgressRepository } from './step-progress';
import { WorkItemRepository } from './work-item';

/**
 * Every row one capture read, as the stores returned it.
 *
 * Deliberately **not** `PlanInputRows` (`@wbs/domain`): that is the canonical
 * shape, and folding into it is a separate, pure step over these values. Keeping
 * the two apart is what lets the fold be tested without a database and this
 * class be tested without asserting anything about hashing. It is also what
 * makes 3.3 possible at all — `schedule()` runs over detached values, outside
 * the read snapshot, and cannot do that if the only way to obtain them is a
 * function that also canonicalises.
 *
 * One field per read, named for the read. Nothing here is sorted, deduplicated
 * or reshaped; a row arrives exactly as its store handed it over.
 */
export interface PlanInputReads {
  readonly project: Project;
  readonly steps: readonly Step[];
  readonly workItems: readonly LabelledWorkItem[];
  readonly estimates: readonly StoredEstimate[];
  readonly actuals: readonly StoredActual[];
  readonly progress: readonly StoredProgress[];
  readonly measures: readonly StoredMeasure[];
  readonly dependencies: readonly StoredDependency[];
  readonly assignments: readonly Assignment[];
  readonly capacity: ReadonlyMap<string, number>;
  readonly priorityBands: readonly PriorityBand[];
  readonly people: readonly PersonWithTeams[];
  readonly teams: readonly TeamWithServices[];
  readonly services: readonly Service[];
  readonly tags: readonly Tag[];
  readonly workItemTypes: readonly WorkItemType[];
  readonly externalSystems: readonly ExternalSystem[];
}

/** How the capture obtains the connection it holds its snapshot on. */
export interface SavedPlanCaptureOptions {
  /**
   * A **new** connection each call, closed by this class on every path.
   *
   * Injected rather than a `dbPath` string so a test can watch the connection
   * be opened and closed, and so this file never imports the adapter. In the
   * process it is `() => openConnection(dbPath)`.
   */
  readonly openConnection: () => Connection;
}

/**
 * Reads one project's whole plan input as of a single instant.
 *
 * ## What "the whole plan input" is bounded by
 *
 * `CanonicalPlanInput`'s field list, **not** the live projection's. The
 * projection is where most of these reads come from, and the capture list is a
 * strict superset of it: the projection may resolve an id against a live
 * registry on the next request, and a saved plan may not — it reads no live
 * table ever again, so a `tag`, `work_item_type` or `external_system` row it did
 * not capture is a label it can never render. Two holes make that concrete, and
 * both are ordinary in the early planning this feature targets:
 *
 * - `capacity.slotsFor` is keyed by team id, so a team with stated capacity and
 *   no junction row is named by the capacity map and by nothing else. The
 *   unfiltered {@link DirectoryRepository.listTeams} is what captures its name.
 * - The live tree reads assigned names through
 *   {@link DirectoryRepository.assignmentsInProject}. A `person_team` row for
 *   an unassigned person therefore names someone the live projection does not
 *   include. Capture separately calls {@link DirectoryRepository.listPeople}
 *   to retain every person and membership in its independent history.
 *
 * ## The seventeen reads
 *
 * Eleven calls are shared with the live projection, excluding
 * `broadcast.latestSeq`, which is a refresh cursor rather than plan input.
 * The project-scoped assignment call includes assigned names in its answer.
 * Six calls are capture-only: `listPeople`, `listTeams`, `listServices`,
 * `listTags`, `listWorkItemTypes` and `listExternalSystems`. They retain the
 * complete directory that memberships, junctions and capacity rows name.
 *
 * All seventeen reads run inside one transaction, on a connection of this
 * class's own. Project-scoped assignment reads do not narrow the separate
 * directory capture.
 *
 * ## Why a revision counter cannot substitute for any of this
 *
 * `project.revision` and `work_item.revision` (`schema.ts:215`) move on writes,
 * so re-reading them after the fact could tell you *that* something changed
 * between two reads — never *what* the first read should have seen instead. A
 * capture that detects tearing and retries still needs the consistent read this
 * class provides in order to succeed; and a counter cannot see the tables that
 * carry none. `tag`, `work_item_type`, `external_system`, `person_team` and
 * `team_service` have no revision column at all, which is precisely where the
 * expensive tearing lives: a tag renamed between the item read and the registry
 * read stores pre-edit items beside post-edit labels, and every counter in the
 * database still agrees.
 *
 * ## The connection, and why it is this class's own
 *
 * `boot.ts:64` opens exactly one connection for the whole process, `bun:sqlite`
 * has no pool, and every store read opens with `await Promise.resolve()` — a
 * real microtask yield before the query, so another in-flight request's
 * continuation can issue a statement between any two reads below. A
 * `BEGIN DEFERRED` held on that shared handle would therefore enclose every
 * statement the rest of the process issues until it commits, making a
 * stranger's write the capture's to commit or to roll back. So the capture
 * opens its own connection, holds the snapshot there, and **closes it on every
 * path** — success, refusal, and throw alike. A leaked connection is a leaked
 * WAL reader, which during a blue/green swap is the other colour's problem.
 *
 * **Measured, not reasoned.** `saved-plan-capture.db.test.ts` runs one scenario
 * twice, differing only in the connection this class is handed: on its own, a
 * stranger's `UPDATE tag` survives the capture's rollback; on the process
 * handle, the same write is inside the capture's transaction and the rollback
 * revokes it while the writing request is told it succeeded. design.md, "The
 * topology found", records what changed.
 */
export class SavedPlanCaptureRepository {
  constructor(private readonly opts: SavedPlanCaptureOptions) {}

  /**
   * Every read the canonical input requires, inside one read snapshot.
   *
   * `null` when the project does not exist — the same answer the projection
   * gives, decided by the first read inside the transaction rather than by a
   * probe before it, so a project deleted between the two cannot produce an
   * empty-but-present capture.
   */
  async readPlanInput(projectId: string): Promise<PlanInputReads | null> {
    const connection = this.opts.openConnection();
    try {
      const db = connection.db;
      const projects = new ProjectRepository(db);
      const directory = new DirectoryRepository(db);
      const tx = drizzleReadTransaction(db);
      tx.begin();
      try {
        const project = await projects.findById(projectId);
        if (project === null) {
          // Nothing was read and nothing was written, so the block is closed
          // rather than rolled back: `COMMIT` on a read-only DEFERRED
          // transaction releases the snapshot and is not a write.
          tx.commit();
          return null;
        }
        const workItems = await new WorkItemRepository(db).listByProject(projectId);
        const estimates = await new EstimateRepository(db).listByProject(projectId);
        const actuals = await new ActualRepository(db).listByProject(projectId);
        const progress = await new StepProgressRepository(db).listByProject(projectId);
        const measures = await new StepMeasureRepository(db).listByProject(projectId);
        const dependencies = await new DependencyRepository(db).listByProject(projectId);
        const { assignments } = await directory.assignmentsInProject(projectId);
        const steps = await projects.stepsOf(projectId);
        const capacity = await new CapacityRepository(db).slotsFor(projectId);
        const priorityBands = await new PriorityBandRepository(db).listFor(projectId);
        // Capture the directory whole for independent saved-plan history;
        // the live tree's assigned-name projection cannot replace these reads.
        const people = await directory.listPeople();
        const teams = await directory.listTeams();
        const services = await directory.listServices();
        const tags = await directory.listTags();
        const workItemTypes = await directory.listWorkItemTypes();
        const externalSystems = await directory.listExternalSystems();
        tx.commit();
        return {
          project,
          steps,
          workItems,
          estimates,
          actuals,
          progress,
          measures,
          dependencies,
          assignments,
          capacity,
          priorityBands,
          people,
          teams,
          services,
          tags,
          workItemTypes,
          externalSystems,
        };
      } catch (err) {
        // The snapshot is released before the connection closes. Closing a
        // handle with an open transaction would roll it back anyway, but only
        // after `bun:sqlite` has decided how to complain about it.
        tx.rollback();
        throw err;
      }
    } finally {
      connection.close();
    }
  }
}
