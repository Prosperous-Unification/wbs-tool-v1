import { WriteCoordinator } from '../repository/gate';
import { type Broadcaster, DeferringBroadcaster } from '../service/broadcast';
import type { OuterTransaction } from '../service/outer-transaction';
import type { WritingServices } from '../services';
import { testCalendarMarkerService } from './calendar-marker-fixture';
import { testCapacityService } from './capacity-fixture';
import { testDirectoryService } from './directory-fixture';
import { testPriorityBandService } from './priority-band-fixture';
import { testProjectService } from './project-fixture';
import { testStepService } from './step-fixture';
import { testWorkItemService } from './work-item-fixture';

/**
 * An {@link OuterTransaction} for tests whose stores are the in-memory
 * fixtures: there is no connection to hold a transaction on, so the three calls
 * only count. Atomicity itself is proven on real SQLite in
 * `plan-commands.test.ts`; what a test on the fixtures can still assert is that
 * the runner opened, and committed or rolled back, exactly once.
 */
export function countingOuterTransaction(): OuterTransaction & {
  readonly calls: ('begin' | 'commit' | 'rollback')[];
} {
  const calls: ('begin' | 'commit' | 'rollback')[] = [];
  return {
    calls,
    begin() {
      calls.push('begin');
    },
    commit() {
      calls.push('commit');
    },
    rollback() {
      calls.push('rollback');
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
  transactions: ReturnType<typeof countingOuterTransaction>;
  gate: WriteCoordinator;
  batch: WritingServices;
  announcements: DeferringBroadcaster;
} {
  return {
    transactions: countingOuterTransaction(),
    gate: new WriteCoordinator(),
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
