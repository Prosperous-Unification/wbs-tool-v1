import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import {
  completeOidcLogin,
  httpShapes,
  logoutOidcSession,
  refreshOidcSession,
  startOidcLogin,
} from '@wbs/contracts';
import { describe, expect, it, spyOn } from 'bun:test';

import type { AppOptions } from './app';
import { buildApp, mountedEndpoints } from './app';
import { AuthService } from './service/auth.service';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from './testing/auth-fixture';
import { testCalendarMarkerService } from './testing/calendar-marker-fixture';
import { testCapacityService } from './testing/capacity-fixture';
import { testDirectoryService } from './testing/directory-fixture';
import { testHistoryService } from './testing/history-fixture';
import { testPriorityBandService } from './testing/priority-band-fixture';
import { inMemoryProjects, testProjectService } from './testing/project-fixture';
import { testReplay } from './testing/replay-fixture';
import { testSavedPlanService } from './testing/saved-plan-fixture';
import { testStepService } from './testing/step-fixture';
import { testWorkItemService } from './testing/work-item-fixture';
import { testWrites } from './testing/writes-fixture';

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

const ORIGIN = 'https://app.test';
const ROUTE_ID = '00000000-0000-4000-8000-000000000001';
const ROUTE_MARKER_ID = '00000000-0000-4000-8000-000000000002';
const INTERNAL_SECRET = 'x'.repeat(32);
const OIDC_SHAPES = new Set<(typeof httpShapes)[number]>([
  startOidcLogin,
  completeOidcLogin,
  refreshOidcSession,
  logoutOidcSession,
]);
const REQUEST_BODIES: Readonly<Record<string, unknown>> = {
  postApiAuthRegister: { username: 'route-probe', password: 'valid-password' },
  postApiAuthLogin: { username: 'route-probe', password: 'valid-password' },
  postApiSmokeEcho: { text: 'reachable' },
  postApiProjectsByIdSteps: { name: 'Reachable step' },
  patchApiProjectsByIdStepsByStepId: { name: 'Renamed step' },
  postApiProjects: { name: 'Reachable plan' },
  patchApiProjectsById: {
    pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
  },
  postApiProjectsByIdCommands: {
    commands: [
      {
        kind: 'patchWorkItem',
        workItemId: ROUTE_ID,
        patch: {
          externalRefs: [{ systemId: ROUTE_ID, url: 'https://example.test/work/1' }],
          teamIds: [],
        },
      },
    ],
  },
  postApiDirectoryCommands: {
    commands: [{ kind: 'createPerson', name: 'Route probe', teamIds: [] }],
  },
  'postApiProjectsByIdCalendar-markers': {
    markerId: ROUTE_MARKER_ID,
    date: '2026-09-06',
    name: 'Route probe',
  },
  'patchApiProjectsByIdCalendar-markersByMarkerId': { name: 'Renamed route probe' },
  'postApiProjectsByIdSaved-plans': {},
  'patchApiSaved-plansById': { name: 'Renamed snapshot' },
  postInternalForward: { message: { kind: 'route-probe' }, trace_id: 'route-probe' },
  postInternalResume: { resume_points: { subscription: -1 }, trace_id: 'route-probe' },
};
const REQUEST_QUERIES: Readonly<Partial<Record<string, Readonly<Record<string, string>>>>> = {
  getApiAuthOktaCallback: { state: 'route-probe', error: 'access_denied' },
  getApiProjectsByIdExport: { format: 'json' },
  'getApiProjectsByIdSaved-plansCompare': { left: 'current', right: 'current' },
};
const REQUEST_BOUNDARY_ERRORS = new Set([
  'invalid_body',
  'invalid_json',
  'invalid_params',
  'invalid_query',
  'invalid_origin',
  'unauthenticated',
  'unauthorized',
  'insufficient_scope',
]);

async function reachabilityOptions(
  mode: 'local' | 'oidc',
): Promise<{ options: AppOptions; shapes: readonly (typeof httpShapes)[number][] }> {
  const users = inMemoryUsers();
  await users.create(
    {
      id: 'route-owner',
      username: 'route-owner',
      passwordHash: null,
      createdAt: 1,
    },
    { at: 1, by: 'route-owner' },
  );
  const projects = inMemoryProjects(users);
  const savedPlans = testSavedPlanService();
  spyOn(savedPlans, 'read').mockResolvedValue({ outcome: 'not_found' });
  spyOn(savedPlans, 'rename').mockResolvedValue({ outcome: 'not_found' });
  spyOn(savedPlans, 'delete').mockResolvedValue({ outcome: 'not_found' });
  const auth = new AuthService({
    users,
    identities: users,
    jwtKey: TEST_JWT_KEY,
    localIdentity: {
      id: 'route-owner',
      username: 'route-owner',
      scopes: ['read', 'write', 'editor'],
    },
  });
  const oidc = mode === 'oidc' ? reachabilityOidcOptions() : undefined;
  return {
    options: {
      ...options(),
      appOrigin: ORIGIN,
      auth,
      projects: testProjectService(projects),
      savedPlans,
      internalAuthSecret: INTERNAL_SECRET,
      oidc,
    },
    shapes: mode === 'oidc' ? httpShapes : httpShapes.filter((shape) => !OIDC_SHAPES.has(shape)),
  };
}

function reachabilityOidcOptions(): NonNullable<AppOptions['oidc']> {
  const tokens = new InMemoryTokenStore();
  tokens.save({
    expiresAt: Date.now() + 60_000,
    refreshToken: 'route-refresh',
    sessionCorrelation: 'route-session',
  });
  return {
    appOrigin: ORIGIN,
    client: {
      authorizationUrl: () => Promise.resolve(new URL('https://provider.test/login')),
      exchange: () => Promise.reject(new Error('route probe exchange refusal')),
      refresh: () =>
        Promise.resolve({
          accessToken: 'route-access',
          expiresIn: 60,
          refreshToken: 'route-refresh',
        }),
      revoke: () => Promise.resolve(),
    },
    groupPrefix: 'test',
    groupsClaim: 'groups',
    mode: 'oidc',
    now: Date.now,
    random: () => 'route-probe',
    redirectUri: `${ORIGIN}/api/auth/okta/callback`,
    tokens,
    transactions: new InMemoryOidcTransactionStore({ ttlMs: 300_000 }),
    verifier: {
      verify: () => Promise.reject(new Error('route probe verifier refusal')),
    },
  };
}

function requestFor(shape: (typeof httpShapes)[number]): Request {
  const path = shape.path
    .replace(':markerId', ROUTE_MARKER_ID)
    .replace(':stepId', ROUTE_ID)
    .replace(':slug', 'route-probe')
    .replace(':id', ROUTE_ID);
  const url = new URL(path, ORIGIN);
  const query = REQUEST_QUERIES[shape.operationId];
  if (query !== undefined) url.search = new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN });
  if (shape.path.startsWith('/internal/')) headers.set('x-internal-auth', INTERNAL_SECRET);
  if (shape.operationId === 'getApiAuthOktaCallback') {
    headers.set('cookie', '__Host-wbs_oidc=route-probe');
  }
  if (shape.operationId === 'postApiAuthRefresh' || shape.operationId === 'postApiAuthLogout') {
    headers.set('cookie', '__Host-wbs_session=route-session');
  }
  const body = REQUEST_BODIES[shape.operationId];
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(url, {
    method: shape.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface WireReply {
  status: number;
  contentType: string | null;
  body: string;
}

async function wireReply(response: Response): Promise<WireReply> {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}

function boundaryError(reply: WireReply): string | undefined {
  if (!reply.contentType?.includes('application/json') || reply.body === '') return undefined;
  const decoded: unknown = JSON.parse(reply.body);
  if (typeof decoded !== 'object' || decoded === null || !('error' in decoded)) return undefined;
  return typeof decoded.error === 'string' ? decoded.error : undefined;
}

/** Complements actual wire requests: each composition binds its exact shared shape set once. */
it('binds each shared HTTP shape once in every configuration that owns it', () => {
  const localShapes = httpShapes.filter((shape) => !OIDC_SHAPES.has(shape));
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

describe('shared HTTP shape reachability through the production app', () => {
  for (const mode of ['local', 'oidc'] as const) {
    it(`reaches every ${mode} path and method with structurally valid input`, async () => {
      const composition = await reachabilityOptions(mode);
      const app = buildApp(composition.options);
      const routerMiss = await wireReply(
        await app.handle(new Request(`${ORIGIN}/__shared_shape_router_miss__`)),
      );
      expect(routerMiss.status).toBe(404);
      let modeledNotFoundCount = 0;

      for (const shape of composition.shapes) {
        const reply = await wireReply(await app.handle(requestFor(shape)));
        const refusal = boundaryError(reply);
        expect({
          operationId: shape.operationId,
          boundaryError:
            refusal !== undefined && REQUEST_BOUNDARY_ERRORS.has(refusal) ? refusal : null,
        }).toEqual({ operationId: shape.operationId, boundaryError: null });
        expect({ operationId: shape.operationId, reply }).not.toEqual({
          operationId: shape.operationId,
          reply: routerMiss,
        });
        expect({
          operationId: shape.operationId,
          serverError: reply.status >= 500 ? reply.status : null,
        }).toEqual({ operationId: shape.operationId, serverError: null });
        if (reply.status === 404 && refusal === 'not_found') modeledNotFoundCount += 1;
      }

      expect(modeledNotFoundCount).toBeGreaterThan(0);
    });
  }
});
