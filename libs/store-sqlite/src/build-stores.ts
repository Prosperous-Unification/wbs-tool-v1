import { ActualRepository } from './actual';
import { CalendarMarkerRepository } from './calendar-marker';
import { CapacityRepository } from './capacity';
import { CommandJournalRepository } from './command-journal';
import type { Drizzle } from './db';
import { DependencyRepository } from './dependency';
import { DirectoryRepository } from './directory';
import { EstimateRepository } from './estimate';
import { DrizzleEventLogStore } from './event-log';
import type { Gate } from './gate';
import { PlanEventRepository } from './plan-event';
import { PriorityBandRepository } from './priority-band';
import { ProjectRepository } from './project';
import { StepRepository } from './step';
import { StepMeasureRepository } from './step-measure';
import { StepProgressRepository } from './step-progress';
import { UserRepository } from './user';
import { SubtreeRepository, WorkItemRepository } from './work-item';

/** Builds the complete transactional SQLite catalog over one write gate. */
export function buildStores(db: Drizzle, gate: Gate) {
  return {
    projects: new ProjectRepository(db, gate),
    users: new UserRepository(db, gate),
    directory: new DirectoryRepository(db, gate),
    capacity: new CapacityRepository(db, gate),
    priorityBands: new PriorityBandRepository(db, gate),
    calendarMarkers: new CalendarMarkerRepository(db, gate),
    eventLog: new DrizzleEventLogStore(db, gate),
    planEvents: new PlanEventRepository(db, gate),
    steps: new StepRepository(db, gate),
    workItems: new WorkItemRepository(db, gate),
    estimates: new EstimateRepository(db, gate),
    actuals: new ActualRepository(db, gate),
    measures: new StepMeasureRepository(db, gate),
    progress: new StepProgressRepository(db, gate),
    dependencies: new DependencyRepository(db, gate),
    subtrees: new SubtreeRepository(db, gate),
    journal: new CommandJournalRepository(db, gate),
  };
}
