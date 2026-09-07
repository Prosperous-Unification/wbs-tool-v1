import type { TransactionalStores } from '../repository';
import { type Broadcaster, DeferringBroadcaster } from '../service/broadcast';
import type { UnitOfWork } from '../service/unit-of-work';
import type { WritingServices } from '../services';
import { testCalendarMarkerService } from './calendar-marker-fixture';
import { testCapacityService } from './capacity-fixture';
import { testDirectoryService } from './directory-fixture';
import { testPriorityBandService } from './priority-band-fixture';
import { testProjectService } from './project-fixture';
import { testStepService } from './step-fixture';
import { testWorkItemService } from './work-item-fixture';

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
 * `batch` is the service graph the runner writes through. On real SQLite these
 * are built over admitted stores while the routes' are built over gated ones
 * (D20); on the in-memory fixtures there is one connectionless set of stores
 * and no turn to hold, so the same doubles serve both and the distinction is
 * the composition root's to make, not this fixture's to imitate.
 */
export function testWrites(
  broadcast: Broadcaster = silentBroadcaster(),
  batch: WritingServices = {
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
  batch: WritingServices;
  announcements: DeferringBroadcaster;
} {
  return {
    uow: countingUnitOfWork(),
    batch,
    // Wrapping the broadcaster the services were built with is the whole
    // contract: a second one would hold nothing, and the runner would drain an
    // empty queue while the services published straight through it.
    announcements: new DeferringBroadcaster(broadcast),
  };
}

/** A broadcaster for a test that does not read what was published. */
function silentBroadcaster(): Broadcaster {
  return {
    publish: () => Promise.resolve(),
    latestSeq: () => Promise.resolve(-1),
  };
}
