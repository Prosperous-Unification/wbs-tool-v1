import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { testAuthService } from '../testing/auth-fixture';
import { testCalendarMarkerService } from '../testing/calendar-marker-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testProjectService } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testSavedPlanService } from '../testing/saved-plan-fixture';
import { testStepService } from '../testing/step-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import { testWrites } from '../testing/writes-fixture';

const TEST_SECRET = 'x'.repeat(32);

describe('POST /api/smoke/echo', () => {
  it('returns the validated message', async () => {
    const app = buildApp({
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      calendarMarkers: testCalendarMarkerService(),
      auth: testAuthService(),
      projects: testProjectService(),
      workItems: testWorkItemService(),
      savedPlans: testSavedPlanService(),
      steps: testStepService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: TEST_SECRET,
      writes: testWrites(),
      migrationsApplied: true,
    });
    const res = await app.handle(
      new Request('http://localhost/api/smoke/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echoed: string };
    expect(body.echoed).toBe('hi');
  });

  it('rejects invalid body with 400', async () => {
    const app = buildApp({
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      calendarMarkers: testCalendarMarkerService(),
      auth: testAuthService(),
      projects: testProjectService(),
      workItems: testWorkItemService(),
      savedPlans: testSavedPlanService(),
      steps: testStepService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: TEST_SECRET,
      writes: testWrites(),
      migrationsApplied: true,
    });
    const res = await app.handle(
      new Request('http://localhost/api/smoke/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wrong: true }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
