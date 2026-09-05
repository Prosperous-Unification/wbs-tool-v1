import { describe, expect, it } from 'bun:test';

import { buildApp } from './app';
import type { AuthService } from './service/auth.service';
import { inMemoryUsers, testAuthService } from './testing/auth-fixture';
import { testCalendarMarkerService } from './testing/calendar-marker-fixture';
import { testCapacityService } from './testing/capacity-fixture';
import { testDirectoryService } from './testing/directory-fixture';
import { testHistoryService } from './testing/history-fixture';
import { testPriorityBandService } from './testing/priority-band-fixture';
import { testProjectService } from './testing/project-fixture';
import { testReplay } from './testing/replay-fixture';
import { testSavedPlanService } from './testing/saved-plan-fixture';
import { testStepService } from './testing/step-fixture';
import { testWorkItemService } from './testing/work-item-fixture';
import { testWrites } from './testing/writes-fixture';

const TEST_SECRET = 'x'.repeat(32);
const PROBE_PASSWORD = 'a-password-long-enough';

/**
 * A real signed session, plus counters on the two things authenticating one
 * costs: the token verify and the account lookup it cannot skip.
 *
 * The token has to be genuine. `authenticate(null)` returns at its first line,
 * so a request carrying no token would leave both counters at zero whatever the
 * app does with it, and the check would pass over the behaviour it is about.
 */
async function signedInProbe(): Promise<{
  auth: AuthService;
  token: string;
  counts: { authenticated: number; lookedUp: number };
}> {
  const counts = { authenticated: 0, lookedUp: 0 };
  const users = inMemoryUsers();
  const findById = users.findById.bind(users);
  users.findById = (id) => {
    counts.lookedUp += 1;
    return findById(id);
  };

  const auth = testAuthService(users);
  const registered = await auth.register('probe', PROBE_PASSWORD);
  if (!registered.ok) throw new Error('the probe account could not be registered');
  const session = await auth.login('probe', PROBE_PASSWORD);
  if (!session.ok) throw new Error('the probe account could not sign in');

  const authenticate = auth.authenticate.bind(auth);
  auth.authenticate = (token) => {
    counts.authenticated += 1;
    return authenticate(token);
  };

  counts.authenticated = 0;
  counts.lookedUp = 0;
  return { auth, token: session.value.token, counts };
}

function appWith(auth: AuthService): ReturnType<typeof buildApp> {
  return buildApp({
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    calendarMarkers: testCalendarMarkerService(),
    auth,
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
}

describe('what a request costs before it reaches a handler', () => {
  /**
   * The app used to resolve an identity for **every** request through a
   * `.derive()`, and nothing read the value: the write-scope pre-filter above it
   * computed its own, and each of the 23 handlers computes its own again. So a
   * liveness probe — polled by the deploy poller through a whole blue/green
   * swap, and carrying a session cookie whenever a browser is the caller — paid
   * a `jwtVerify` and a `users.findById` to produce a value that was discarded.
   *
   * Proof: with `.derive(async ({ headers }) => ({ requestIdentity: await
   * userFromHeaders(opts.auth, headers) }))` restored to `app.ts`, watched
   * failing on `Expected: 0 · Received: 1` here, and on `Expected: 1 ·
   * Received: 2` in the case below (2026-09-02).
   */
  it('authenticates nobody to answer a liveness probe', async () => {
    const { auth, token, counts } = await signedInProbe();
    const res = await appWith(auth).handle(
      new Request('http://localhost/health', { headers: { authorization: `Bearer ${token}` } }),
    );

    expect(res.status).toBe(200);
    expect(counts.authenticated).toBe(0);
    expect(counts.lookedUp).toBe(0);
  });

  /**
   * The same rule stated where it has teeth for a route that *does* need an
   * identity: one read, one resolution. This is what stops the deleted derive
   * being reintroduced in another shape — a route handler already asks, so
   * anything asking on its behalf beforehand is asking twice.
   */
  it('resolves the caller once for a route that needs one', async () => {
    const { auth, token, counts } = await signedInProbe();
    const res = await appWith(auth).handle(
      new Request('http://localhost/api/projects', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect(res.status).toBe(200);
    expect(counts.authenticated).toBe(1);
  });
});
