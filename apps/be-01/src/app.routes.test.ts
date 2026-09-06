import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import {
  completeOidcLogin,
  httpShapes,
  logoutOidcSession,
  refreshOidcSession,
  startOidcLogin,
} from '@wbs/contracts';
import { describe, expect, it } from 'bun:test';

import type { AppOptions } from './app';
import { buildApp, mountedEndpoints, mountedRouteLists } from './app';
import type { Route } from './http/route';
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

/**
 * Properties of the mounted route list itself, rather than of any answer it
 * gives — which is why they are here and not in `http/binder.contract.test.ts`.
 * That suite may not import `controller/`; the whole claim of the refactor is
 * that `http/` names no controller and no framework.
 */

function options(): AppOptions {
  return {
    appOrigin: 'http://localhost',
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    calendarMarkers: testCalendarMarkerService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    auth: testAuthService(inMemoryUsers()),
    projects: testProjectService(),
    workItems: testWorkItemService(),
    savedPlans: testSavedPlanService(),
    steps: testStepService(),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    writes: testWrites(),
    migrationsApplied: true,
  };
}

function assembled(): readonly Route[] {
  return mountedRouteLists().flat();
}

function oidcOptions(): NonNullable<AppOptions['oidc']> {
  return {
    appOrigin: 'https://app.test',
    client: {
      authorizationUrl: () => Promise.resolve(new URL('https://provider.test')),
      exchange: () => Promise.reject(new Error('OIDC exchange fixture was not expected')),
      refresh: () => Promise.reject(new Error('OIDC refresh fixture was not expected')),
      revoke: () => Promise.reject(new Error('OIDC revoke fixture was not expected')),
    },
    groupPrefix: 'test',
    groupsClaim: 'groups',
    mode: 'oidc',
    redirectUri: 'https://app.test/api/auth/okta/callback',
    tokens: new InMemoryTokenStore(),
    transactions: new InMemoryOidcTransactionStore({ ttlMs: 300_000 }),
    verifier: {
      verify: () => Promise.reject(new Error('OIDC verifier fixture was not expected')),
    },
  };
}

describe('the mounted route list', () => {
  /**
   * The paths that reach the app **without** passing through
   * `mountedRouteLists`, which is the only thing the clause above cannot speak
   * for. Elysia's route table is built from what was actually registered,
   * including through `.use()`, so a route that reaches the app by any path
   * shows up here. Three do not come from a list, and they are **named** rather
   * than filtered by shape, because a filter is one more thing that can quietly
   * widen: `/health` is attached to the instance directly, and `/metrics` and
   * `/api/openapi.json` are mounted by `observabilityPlugin` and
   * `openApiPlugin`. Finding those is what this clause is for — no route list
   * mentions them, so nothing else in the suite would have said they exist.
   *
   * **It is not an independent witness that every controller is mounted, and an
   * earlier version of this note claimed it was.** `buildApp` registers routes
   * by calling `mountedRouteLists` (`app.ts`), and `assembled()` below calls the
   * same function, so a controller factory dropped from that array leaves both
   * sides of this equality together and the test stays green. What catches that
   * omission is each controller's own route tests, not this assertion.
   */
  it('covers every path the app actually mounts', () => {
    const mounted = (
      buildApp(options()) as unknown as { routes: readonly { method: string; path: string }[] }
    ).routes
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const declared = [
      ...assembled().map((route) => `${route.method} ${route.path}`),
      ...mountedEndpoints(options()).map(({ shape }) => `${shape.method} ${shape.path}`),
      'GET /health',
      'GET /metrics',
      'GET /api/openapi.json',
    ].sort();

    expect(mounted).toEqual(declared);
  });
});

/** Complements actual wire requests: each composition binds its exact shared shape set once. */
it('binds each shared HTTP shape once in every configuration that owns it', () => {
  const oidcShapes = new Set<(typeof httpShapes)[number]>([
    startOidcLogin,
    completeOidcLogin,
    refreshOidcSession,
    logoutOidcSession,
  ]);
  const localShapes = httpShapes.filter((shape) => !oidcShapes.has(shape));
  const compositions = [
    { endpoints: mountedEndpoints(options()), shapes: localShapes },
    {
      endpoints: mountedEndpoints({ ...options(), oidc: oidcOptions() }),
      shapes: httpShapes,
    },
  ];
  for (const { endpoints, shapes } of compositions) {
    expect(endpoints).toHaveLength(shapes.length);
    for (const shape of shapes) {
      expect(endpoints.filter((endpoint) => endpoint.shape === shape)).toHaveLength(1);
    }
  }
});
