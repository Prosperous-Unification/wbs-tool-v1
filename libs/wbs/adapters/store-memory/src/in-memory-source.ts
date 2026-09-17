import type { TransactionalStores } from '@wbs/core';

import { inMemoryActuals } from './actual-fixture';
import { inMemoryUsers } from './auth-fixture';
import { inMemoryCalendarMarkers } from './calendar-marker-fixture';
import { inMemoryCapacity } from './capacity-fixture';
import { inMemoryCommandJournal } from './command-journal-fixture';
import { inMemoryDependencies } from './dependency-fixture';
import { inMemoryDirectory } from './directory-fixture';
import { inMemoryEstimates } from './estimate-fixture';
import { inMemoryPlanEvents } from './history-fixture';
import { inMemoryMeasures } from './measure-fixture';
import { inMemoryWorkItems } from './memory-work-item-fixture';
import { inMemoryPriorityBands } from './priority-band-fixture';
import { inMemoryProgress } from './progress-fixture';
import { inMemoryProjects } from './project-fixture';
import { inMemoryEventLog } from './replay-fixture';
import { inMemorySteps } from './step-fixture';
import { inMemorySubtrees } from './subtree-fixture';

/**
 * The in-memory source's transactional stores, wired as
 * {@link inMemoryServices} wires the ones a work-item service needs and
 * completed with the rest.
 *
 * One function rather than seventeen constructions per suite: what the source
 * is* has to be one thing, or a kit run against it is a kit run against
 * whatever that suite happened to assemble.
 */
export function inMemoryStores(): TransactionalStores {
  const users = inMemoryUsers();
  const directory = inMemoryDirectory((projectId): Promise<readonly { id: string }[]> =>
    workItems.listByProject(projectId),
  );
  const workItems = inMemoryWorkItems(directory);
  const steps = inMemorySteps();
  const estimates = inMemoryEstimates(workItems, undefined, steps);
  const actuals = inMemoryActuals(workItems, undefined, steps);
  const measures = inMemoryMeasures(workItems, undefined, steps);
  const progress = inMemoryProgress(workItems, undefined, steps);
  const dependencies = inMemoryDependencies([], undefined, workItems);
  return {
    users,
    projects: inMemoryProjects(users),
    directory,
    workItems,
    estimates,
    actuals,
    measures,
    progress,
    dependencies,
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    calendarMarkers: inMemoryCalendarMarkers(),
    steps,
    planEvents: inMemoryPlanEvents(),
    journal: inMemoryCommandJournal(),
    eventLog: inMemoryEventLog(),
    subtrees: inMemorySubtrees({
      workItems,
      estimates,
      actuals,
      measures,
      progress,
      dependencies,
      directory,
    }),
  };
}
