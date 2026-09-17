import type {
  Broadcaster,
  CalendarMarkerStore,
  CapacityStore,
  Clock,
  DirectoryStore,
  Person,
  PersonAdded,
  PlanEventStore,
  PriorityBandStore,
  ProjectStore,
  StepStore,
  WorkItemService,
} from '@wbs/core';
import {
  CalendarMarkerService,
  CapacityService,
  DirectoryService,
  HistoryService,
  PriorityBandService,
  ProjectService,
  ReplayBuffer,
  ReplayOrchestrator,
  StepService,
} from '@wbs/core';
import { recordingBroadcaster } from '@wbs/core/testing/broadcast-fixture';
import { testClock } from '@wbs/core/testing/clock-fixture';
import { inMemoryServices } from '@wbs/core/testing/harness';

import { inMemoryCalendarMarkers } from '../calendar-marker-fixture';
import { inMemoryCapacity } from '../capacity-fixture';
import { inMemoryDirectory } from '../directory-fixture';
import { inMemoryPlanEvents } from '../history-fixture';
import { inMemoryPriorityBands } from '../priority-band-fixture';
import { inMemoryProjects } from '../project-fixture';
import { inMemoryEventLog } from '../replay-fixture';
import { inMemorySteps } from '../step-fixture';

export function testProjectService(projects: ProjectStore = inMemoryProjects()): ProjectService {
  return new ProjectService({ clock: testClock, projects, broadcast: recordingBroadcaster() });
}

export function testStepService(
  projects: ProjectStore = inMemoryProjects(),
  steps: StepStore = inMemorySteps(),
): StepService {
  return new StepService({ clock: testClock, projects, steps, broadcast: recordingBroadcaster() });
}

export function testDirectoryService(
  directory: DirectoryStore = inMemoryDirectory(),
  broadcast: Broadcaster = recordingBroadcaster(),
): DirectoryService {
  return new DirectoryService({ clock: testClock, directory, broadcast });
}

export function testCapacityService(
  projects: ProjectStore = inMemoryProjects(),
  capacity: CapacityStore = inMemoryCapacity(),
  broadcast: Broadcaster = recordingBroadcaster(),
): CapacityService {
  return new CapacityService({ clock: testClock, projects, capacity, broadcast });
}

export function testPriorityBandService(
  projects: ProjectStore = inMemoryProjects(),
  bands: PriorityBandStore = inMemoryPriorityBands(),
  broadcast: Broadcaster = recordingBroadcaster(),
): PriorityBandService {
  return new PriorityBandService({ clock: testClock, projects, bands, broadcast });
}

export function testCalendarMarkerService(
  projects: ProjectStore = inMemoryProjects(),
  markers: CalendarMarkerStore = inMemoryCalendarMarkers(),
  clock: Clock = testClock,
  broadcast?: Broadcaster,
): CalendarMarkerService {
  return new CalendarMarkerService({ projects, markers, clock, broadcast });
}

export function testHistoryService(
  projects: ProjectStore = inMemoryProjects(),
  events: PlanEventStore = inMemoryPlanEvents(),
): HistoryService {
  return new HistoryService({ projects, events });
}

export function testWorkItemService(): WorkItemService {
  return inMemoryServices().service;
}

export function testReplay(maxEvents?: number) {
  const log = inMemoryEventLog();
  const buffer = new ReplayBuffer({
    maxPerSubscription: 100,
    maxAgeMs: 5 * 60_000,
    now: () => 1_000,
  });
  return { log, buffer, replay: new ReplayOrchestrator({ log, buffer, maxEvents }) };
}

export async function personAdded(added: Promise<PersonAdded>): Promise<Person> {
  const written = await added;
  if (!written.ok) throw new Error(`the fixture person was refused: ${written.reason}`);
  return written.person;
}

export { labelledRow, workItemRow } from '@wbs/core/testing/work-item-fixture';
