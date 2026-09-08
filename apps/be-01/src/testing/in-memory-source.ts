import type { TransactionalStores } from '../repository';
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
import { inMemoryPriorityBands } from './priority-band-fixture';
import { inMemoryProgress } from './progress-fixture';
import { inMemoryProjects } from './project-fixture';
import { inMemoryEventLog } from './replay-fixture';
import { inMemorySteps } from './step-fixture';
import { inMemorySubtrees } from './subtree-fixture';
import { inMemoryWorkItems } from './work-item-fixture';

/**
 * Every method the in-memory source does not offer, by `store.method`.
 *
 * **A named list, and a test fails on a stub that is not on it** (D29,
 * `docs/2026-09-05-ports-and-adapters-plan.md`). The memory source is allowed
 * to lag the SQLite one — per-feature fan-out of two to four files today would
 * be six across five projects otherwise — but it is not allowed to lag
 * quietly*: `sourceConformance` reads this list and prints the cases it
 * skipped by name, so "certified" never means "was not asked".
 *
 * Each line says what is missing and why, because the reason is what tells a
 * reader whether the gap is a decision or an omission nobody noticed.
 */
export const NOT_OFFERED_BY_MEMORY: readonly string[] = [
  // The fixtures hold rows in arrays with no references between them, so a
  // write naming a step that is not there succeeds and answers `'written'`.
  // Refusing would mean giving four stores a step source of their own; the
  // service checks `holdsStep` before every one of these writes, so what is
  // lost is the race, not the rule.
  //
  // `actuals.set`, `measures.set` and `progress.set` lag in exactly the same
  // way and are **not** listed, because a line here that matches no kit case is
  // a stale allowlist — the source's own test fails on one. They join this list
  // the day their kits do.
  'estimates.set:unknown_step',
];

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
  const estimates = inMemoryEstimates(workItems);
  const actuals = inMemoryActuals(workItems);
  const measures = inMemoryMeasures(workItems);
  const progress = inMemoryProgress(workItems);
  return {
    users,
    projects: inMemoryProjects(users),
    directory,
    workItems,
    estimates,
    actuals,
    measures,
    progress,
    dependencies: inMemoryDependencies(),
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    calendarMarkers: inMemoryCalendarMarkers(),
    steps: inMemorySteps(),
    planEvents: inMemoryPlanEvents(),
    journal: inMemoryCommandJournal(),
    eventLog: inMemoryEventLog(),
    subtrees: inMemorySubtrees({
      workItems,
      estimates,
      actuals,
      measures,
      progress,
      dependencies: inMemoryDependencies(),
      directory,
    }),
  };
}
