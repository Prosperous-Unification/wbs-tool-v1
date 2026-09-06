import { type AppOptions, buildApp } from '../app';
import { testAuthService } from './auth-fixture';
import { testCalendarMarkerService } from './calendar-marker-fixture';
import { testCapacityService } from './capacity-fixture';
import { testDirectoryService } from './directory-fixture';
import { testHistoryService } from './history-fixture';
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
  return buildApp({
    appOrigin: 'http://localhost',
    auth: testAuthService(),
    projects: testProjectService(),
    workItems: testWorkItemService(),
    savedPlans: testSavedPlanService(),
    steps: testStepService(),
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    calendarMarkers: testCalendarMarkerService(),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    writes: testWrites(),
    migrationsApplied: true,
    ...overrides,
  });
}
