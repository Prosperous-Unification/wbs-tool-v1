import {
  testCalendarMarkerService,
  testCapacityService,
  testDirectoryService,
  testPriorityBandService,
  testProjectService,
  testStepService,
  testWorkItemService,
} from '@wbs/store-memory/testing/service-fixtures';

import type { TransactionalStores } from '../ports/stores';
import type { Scope, UnitOfWork } from '../ports/unit-of-work';
import type { Broadcaster } from '../service/broadcast';
import type { CalendarMarkerService } from '../service/calendar-marker.service';
import type { PlanCommandServices } from '../service/plan-commands';
import type { ProjectService } from '../service/project.service';
import type { StepService } from '../service/step.service';
import type { InMemoryPlan } from './harness';

export interface WritingServices extends PlanCommandServices {
  projects: ProjectService;
  steps: StepService;
  calendarMarkers: CalendarMarkerService;
}

/**
 * A {@link UnitOfWork} for tests whose stores are the in-memory fixtures.
 *
 * There is no connection to hold a transaction on, so it runs the act and
 * **counts**: `begin`, then `commit` or `rollback`. Atomicity itself is proven
 * on real SQLite by `sqlite-unit-of-work.db.test.ts`; what a test on the
 * fixtures can still assert is that the route opened one unit of work and which
 * way it settled.
 *
 * Its scope carries no stores, and reaching for one throws by name rather than
 * answering an empty double. A batch that writes through `scope.stores` — which
 * is where D24's per-batch graph is going — must not silently write into a
 * store nothing in the test reads; on this fixture it should say so.
 */
export function countingUnitOfWork(): UnitOfWork & {
  readonly calls: ('begin' | 'commit' | 'rollback')[];
} {
  const calls: ('begin' | 'commit' | 'rollback')[] = [];
  const stores = new Proxy(
    {},
    {
      get(_target, port: string | symbol) {
        throw new Error(
          `the counting unit of work has no stores; something asked it for ${String(port)}`,
        );
      },
    },
  ) as TransactionalStores;
  return {
    calls,
    async run(act) {
      calls.push('begin');
      let decision;
      try {
        decision = await act({ stores });
      } catch (cause) {
        calls.push('rollback');
        throw cause;
      }
      calls.push(decision.commit ? 'commit' : 'rollback');
      if (!decision.commit && decision.afterRollback !== undefined) {
        await decision.afterRollback({ stores });
      }
      return decision.value;
    },
  };
}

/**
 * What `buildApp` needs to run command batches, for a test on the fixtures.
 *
 * `batch` is the service graph the runner writes through. A real source builds
 * it from each admitted scope (D20); these connectionless doubles have no store
 * graph or turn, so they deliberately ignore the scope while retaining the
 * production factory shape.
 */
export function testWrites(
  broadcast: Broadcaster = silentBroadcaster(),
  services: WritingServices = {
    workItems: testWorkItemService(),
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    projects: testProjectService(),
    steps: testStepService(),
    calendarMarkers: testCalendarMarkerService(),
  },
): {
  uow: ReturnType<typeof countingUnitOfWork>;
  batch: (scope: Scope, broadcast: Broadcaster) => WritingServices;
  announcements: Broadcaster;
} {
  return {
    uow: countingUnitOfWork(),
    // The **same** services whatever collector is handed in, because these
    // doubles were built before the runner existed and there is no store under
    // them to rebuild. What a test on the fixtures can still see is which
    // events the runner drained and when; where they were collected is
    // `announcement-ownership.db.test.ts`'s, on real services.
    batch: () => services,
    announcements: broadcast,
  };
}

/** A broadcaster for a test that does not read what was published. */
function silentBroadcaster(): Broadcaster {
  return {
    publish: () => Promise.resolve(),
    latestSeq: () => Promise.resolve(-1),
  };
}

/**
 * The batch's services over an {@link inMemoryServices} plan — the doubles a
 * runner test needs and nothing else.
 *
 * The directory is the plan's own store rather than a second double: a
 * `createPerson` command and the assignment that names them are one batch, and
 * two directories would make the person invisible to the assignment.
 */
export function batchServices(plan: InMemoryPlan): WritingServices {
  return {
    workItems: plan.service,
    directory: testDirectoryService(plan.stores.directory),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    projects: testProjectService(),
    steps: testStepService(),
    calendarMarkers: testCalendarMarkerService(),
  };
}
