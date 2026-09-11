import { inMemoryActuals } from '@wbs/store-memory/actual-fixture';
import { inMemoryCapacity } from '@wbs/store-memory/capacity-fixture';
import { inMemoryCommandJournal } from '@wbs/store-memory/command-journal-fixture';
import { inMemoryDependencies } from '@wbs/store-memory/dependency-fixture';
import { inMemoryDirectory } from '@wbs/store-memory/directory-fixture';
import { inMemoryEstimates } from '@wbs/store-memory/estimate-fixture';
import { inMemoryMeasures } from '@wbs/store-memory/measure-fixture';
import { inMemoryWorkItems } from '@wbs/store-memory/memory-work-item-fixture';
import { inMemoryPriorityBands } from '@wbs/store-memory/priority-band-fixture';
import { inMemoryProgress } from '@wbs/store-memory/progress-fixture';
import { inMemoryProjects } from '@wbs/store-memory/project-fixture';
import { inMemorySubtrees } from '@wbs/store-memory/subtree-fixture';

import type { WorkItemServiceOptions } from '../service/work-item.service';
import { AvailableWorkItemService } from './available-work-item-service';
import { type RecordingBroadcaster, recordingBroadcaster } from './broadcast-fixture';
import { testClock } from './clock-fixture';
import { fastScheduler } from './scheduler-fixture';

/**
 * A {@link WorkItemService} over in-memory stores, **with the stores.**
 *
 * `buildServices` is the composition root over a real `Drizzle`; this is its T0
 * twin, and the two answer the same object graph so a suite can move between
 * tiers by changing one line.
 *
 * Handing the stores back is the whole difference from
 * {@link testWorkItemService}, which composes the same graph and then discards
 * them — which is why twenty-four test files re-derived it by hand instead of
 * using it. A suite that seeds a plan or asserts on a row needs the store, and
 * the graph is thirteen ports with three wiring rules that are easy to get
 * subtly wrong:
 *
 * - `inMemoryWorkItems` takes the **directory**, so labels resolve; built
 *   without one, a row's effective team set is empty and no test can see it.
 * - the four satellite stores take the **work item store**, so a row's figures
 *   follow it through a move and go with it on a delete.
 * - `inMemorySubtrees` takes **all seven**, because a subtree write is the one
 *   act that touches every table at once.
 *
 * Get one of those wrong and nothing says so: the graph still constructs, the
 * suite still runs, and a label or a figure is simply never there to assert on.
 *
 * (The 2026-09-02 review claimed `undo.test.ts:122` mixed a real
 * `SubtreeRepository(db)` into an in-memory graph. It does not. That suite wires
 * **real** repositories throughout and takes in-memory fixtures for exactly two
 * ports, `capacity` and `priorityBands`, which its cases never drive. It is a
 * T1 suite and this harness does not apply to it.)
 *
 * Every port can be overridden, because the variation between suites is real: a
 * test that reads the plan's history wraps the journal, and one that drives two
 * projects seeds the project store. Anything not named is built here.
 */
export interface InMemoryPlan {
  service: AvailableWorkItemService;
  scheduler: WorkItemServiceOptions['scheduler'];
  /** The recording broadcaster, unless one was passed in. */
  broadcast: RecordingBroadcaster;
  stores: Required<
    Pick<
      WorkItemServiceOptions,
      | 'workItems'
      | 'projects'
      | 'estimates'
      | 'actuals'
      | 'measures'
      | 'progress'
      | 'dependencies'
      | 'directory'
      | 'capacity'
      | 'priorityBands'
      | 'journal'
      | 'subtrees'
    >
  >;
}

export function inMemoryServices(overrides: Partial<WorkItemServiceOptions> = {}): InMemoryPlan {
  const directory =
    overrides.directory ??
    inMemoryDirectory((projectId): Promise<readonly { id: string }[]> =>
      workItems.listByProject(projectId),
    );
  const workItems = overrides.workItems ?? inMemoryWorkItems(directory);
  const estimates = overrides.estimates ?? inMemoryEstimates(workItems);
  const actuals = overrides.actuals ?? inMemoryActuals(workItems);
  const measures = overrides.measures ?? inMemoryMeasures(workItems);
  const progress = overrides.progress ?? inMemoryProgress(workItems);
  const dependencies = overrides.dependencies ?? inMemoryDependencies();
  const projects = overrides.projects ?? inMemoryProjects();
  const capacity = overrides.capacity ?? inMemoryCapacity();
  const priorityBands = overrides.priorityBands ?? inMemoryPriorityBands();
  const journal = overrides.journal ?? inMemoryCommandJournal();
  const subtrees =
    overrides.subtrees ??
    inMemorySubtrees({
      workItems,
      estimates,
      actuals,
      measures,
      progress,
      dependencies,
      directory,
    });
  // `recordingBroadcaster` unless the caller brought one, and the return type
  // says which: a suite that passes its own gets it back as the type it passed,
  // and one that does not gets the recorder it will want to read.
  const broadcast = overrides.broadcast ?? recordingBroadcaster();
  const scheduler = overrides.scheduler ?? fastScheduler;

  const stores = {
    workItems,
    projects,
    estimates,
    actuals,
    measures,
    progress,
    dependencies,
    directory,
    capacity,
    priorityBands,
    journal,
    subtrees,
  };
  return {
    service: new AvailableWorkItemService({ clock: testClock, ...stores, broadcast, scheduler }),
    scheduler,
    broadcast: broadcast as RecordingBroadcaster,
    stores,
  };
}
