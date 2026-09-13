import { type AppOptions, buildApp } from '../app';
import { testAuthService } from './auth-fixture';
import { testCalendarMarkerService } from './calendar-marker-fixture';
import { testCapacityService } from './capacity-fixture';
import { testClock } from './clock-fixture';
import { testDirectoryService } from './directory-fixture';
import { testHistoryService } from './history-fixture';
import { testLoginThrottle } from './login-throttle-fixture';
import { testPriorityBandService } from './priority-band-fixture';
import { testProjectService } from './project-fixture';
import { testReplay } from './replay-fixture';
import { testSavedPlanService } from './saved-plan-fixture';
import { testStepService } from './step-fixture';
import { testWorkItemService } from './work-item-fixture';
import { testWrites } from './writes-fixture';

/**
 * An app on the thirteen test doubles, for the callers that want the routes
 * and none of the behaviour behind them.
 *
 * Shared fixture for route composition and generated-document publication tests.
 * The document CLI consumes shared descriptors directly and needs no app fixture.
 *
 * Route registration touches no service, which is what makes the doubles
 * honest here rather than a shortcut: a real service would mean a database
 * file, migrations and a temp directory to produce the same answer.
 *
 * `overrides` is spread last, so a caller that cares about one service — an
 * auth service that answers a particular identity, say — names that one and
 * inherits the rest.
 */
export function testApp(overrides: Partial<AppOptions> = {}): ReturnType<typeof buildApp> {
  const workItems = testWorkItemService();
  const directory = testDirectoryService();
  const capacity = testCapacityService();
  const priorityBands = testPriorityBandService();
  const projects = testProjectService();
  const steps = testStepService();
  const calendarMarkers = testCalendarMarkerService();
  return buildApp({
    appOrigin: 'http://localhost',
    loginThrottle: testLoginThrottle(),
    auth: testAuthService(),
    projects,
    workItems,
    savedPlans: testSavedPlanService(),
    steps,
    directory,
    capacity,
    priorityBands,
    history: testHistoryService(),
    calendarMarkers,
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    // The same doubles the routes were given: on the fixtures there is one set
    // of stores and no turn to hold, so the batch's graph and the routes' are
    // the same objects. See {@link testWrites}.
    writes: testWrites(undefined, {
      workItems,
      directory,
      capacity,
      priorityBands,
      projects,
      steps,
      calendarMarkers,
    }),
    migrationsApplied: true,
    ...overrides,
    clock: overrides.clock ?? testClock,
  });
}
