import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import {
  completeOidcLogin,
  httpShapes,
  logoutOidcSession,
  refreshOidcSession,
  type RequestPolicy,
  startOidcLogin,
} from '@wbs/contracts';
import { describe, expect, it, spyOn } from 'bun:test';

import type { AppOptions } from './app';
import { buildApp, mountedEndpoints } from './app';
import { bunPasswordHasher, joseTokenCodec } from './runtime/bun-runtime';
import { AuthService } from './service/auth.service';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from './testing/auth-fixture';
import { testCalendarMarkerService } from './testing/calendar-marker-fixture';
import { testCapacityService } from './testing/capacity-fixture';
import { testClock } from './testing/clock-fixture';
import { testDirectoryService } from './testing/directory-fixture';
import { testHistoryService } from './testing/history-fixture';
import { testLoginThrottle } from './testing/login-throttle-fixture';
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
    loginThrottle: testLoginThrottle(),
    clock: testClock,
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

async function sendRawHttp(port: number, request: string): Promise<string> {
  let response = '';
  const completed = Promise.withResolvers<string>();
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(peer) {
        peer.write(request);
      },
      data(_peer, bytes) {
        response += bytes.toString();
      },
      close() {
        completed.resolve(response);
      },
      error(_peer, error) {
        completed.reject(error);
      },
    },
  });
  try {
    return await completed.promise;
  } finally {
    socket.end();
  }
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
  postApiProjectsByIdOptimizationRetry: { objective: 'pri', inputHash: 'route-probe' },
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
const PUBLIC_OPERATIONS = [
  'getApiAuthLogin',
  'getApiAuthMe',
  'getApiAuthOktaCallback',
  'getHealth',
  'getMetrics',
  'postApiAuthLogin',
  'postApiAuthLogout',
  'postApiAuthRefresh',
  'postApiAuthRegister',
  'postApiSmokeEcho',
] as const;
const SIGNED_IN_OPERATIONS = [
  'getApiExternal-systems',
  'getApiPeople',
  'getApiProjects',
  'getApiProjectsById',
  'getApiProjectsByIdCalendar-markers',
  'getApiProjectsByIdHistory',
  'getApiProjectsByIdSaved-plans',
  'getApiProjectsByIdSaved-plansCompare',
  'getApiProjectsByIdWork-items',
  'getApiSaved-plansById',
  'getApiServices',
  'getApiTags',
  'getApiTeams',
  'getApiWork-item-types',
] as const;
const READ_SCOPE_OPERATIONS = ['getApiProjectsByIdExport', 'getPlansBy-solutionBySlug'] as const;
const WRITE_SCOPE_OPERATIONS = [
  'deleteApiProjectsByIdCalendar-markersByMarkerId',
  'deleteApiProjectsByIdStepsByStepId',
  'deleteApiSaved-plansById',
  'patchApiProjectsById',
  'patchApiProjectsByIdCalendar-markersByMarkerId',
  'patchApiProjectsByIdStepsByStepId',
  'patchApiSaved-plansById',
  'postApiDirectoryCommands',
  'postApiProjects',
  'postApiProjectsByIdCalendar-markers',
  'postApiProjectsByIdCommands',
  'postApiProjectsByIdOpened',
  'postApiProjectsByIdOptimizationRetry',
  'postApiProjectsByIdRedo',
  'postApiProjectsByIdSaved-plans',
  'postApiProjectsByIdSteps',
  'postApiProjectsByIdUndo',
] as const;
const INTERNAL_OPERATIONS = ['postInternalForward', 'postInternalResume'] as const;
const ALWAYS_ORIGIN_OPERATIONS = ['postApiAuthLogin', 'postApiAuthRegister'] as const;
const COOKIE_ORIGIN_OPERATIONS = [
  'deleteApiProjectsByIdCalendar-markersByMarkerId',
  'deleteApiProjectsByIdStepsByStepId',
  'deleteApiSaved-plansById',
  'getApiProjectsByIdHistory',
  'patchApiProjectsById',
  'patchApiProjectsByIdCalendar-markersByMarkerId',
  'patchApiProjectsByIdStepsByStepId',
  'patchApiSaved-plansById',
  'postApiAuthLogout',
  'postApiAuthRefresh',
  'postApiDirectoryCommands',
  'postApiProjects',
  'postApiProjectsByIdCalendar-markers',
  'postApiProjectsByIdCommands',
  'postApiProjectsByIdOpened',
  'postApiProjectsByIdOptimizationRetry',
  'postApiProjectsByIdRedo',
  'postApiProjectsByIdSaved-plans',
  'postApiProjectsByIdSteps',
  'postApiProjectsByIdUndo',
  'postApiSmokeEcho',
] as const;
const NO_ORIGIN_OPERATIONS = [
  'getApiAuthLogin',
  'getApiAuthMe',
  'getApiAuthOktaCallback',
  'getApiExternal-systems',
  'getApiPeople',
  'getApiProjects',
  'getApiProjectsById',
  'getApiProjectsByIdCalendar-markers',
  'getApiProjectsByIdExport',
  'getApiProjectsByIdSaved-plans',
  'getApiProjectsByIdSaved-plansCompare',
  'getApiProjectsByIdWork-items',
  'getApiSaved-plansById',
  'getApiServices',
  'getApiTags',
  'getApiTeams',
  'getApiWork-item-types',
  'getHealth',
  'getMetrics',
  'getPlansBy-solutionBySlug',
  'postInternalForward',
  'postInternalResume',
] as const;

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
    clock: testClock,
    users,
    identities: users,
    tokens: joseTokenCodec(TEST_JWT_KEY),
    passwords: bunPasswordHasher,
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

function policyOperations(kind: 'identity' | 'origin', requirement: string): string[] {
  return httpShapes
    .filter((shape) =>
      shape.policies.some((policy) =>
        policy.kind === kind
          ? (policy.kind === 'identity' ? policy.require : policy.when) === requirement
          : false,
      ),
    )
    .map((shape) => shape.operationId)
    .sort();
}

function expectedPolicies(operationId: string): RequestPolicy[] {
  const policies: RequestPolicy[] = [];
  if (includesOperation(ALWAYS_ORIGIN_OPERATIONS, operationId))
    policies.push({ kind: 'origin', when: 'always' });
  if (includesOperation(COOKIE_ORIGIN_OPERATIONS, operationId))
    policies.push({ kind: 'origin', when: 'always-unsafe-with-session-cookie' });
  if (includesOperation(SIGNED_IN_OPERATIONS, operationId))
    policies.push({ kind: 'identity', require: 'signed-in' });
  if (includesOperation(READ_SCOPE_OPERATIONS, operationId))
    policies.push({ kind: 'identity', require: 'read-scope' });
  if (includesOperation(WRITE_SCOPE_OPERATIONS, operationId))
    policies.push({ kind: 'identity', require: 'write-scope' });
  if (includesOperation(INTERNAL_OPERATIONS, operationId))
    policies.push({ kind: 'identity', require: 'internal' });
  return policies;
}

function includesOperation(operations: readonly string[], operationId: string): boolean {
  return operations.includes(operationId);
}

function requestWithHeaders(shape: (typeof httpShapes)[number], changes: HeadersInit): Request {
  const request = requestFor(shape);
  const headers = new Headers(request.headers);
  for (const [name, value] of new Headers(changes)) headers.set(name, value);
  return new Request(request, { headers });
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

it('keeps OIDC health readiness live after the endpoint table is built', async () => {
  const state = { migrationsApplied: false };
  const app = buildApp({
    ...options(),
    oidc: oidcOptions(),
    get migrationsApplied() {
      return state.migrationsApplied;
    },
  });

  const pre = await app.handle(new Request(`${ORIGIN}/health`));
  expect(pre.status).toBe(503);

  state.migrationsApplied = true;
  const post = await app.handle(new Request(`${ORIGIN}/health`));
  expect(post.status).toBe(200);
});

it('enforces the complete pinned identity and origin policy inventory on the production app', async () => {
  const unauthenticated = buildApp({ ...options(), appOrigin: ORIGIN });
  // Proof: adding a signed-in policy to health made this production request
  // expect 200 and receive 500 because the public shape declares no auth refusal.
  expect(await unauthenticated.handle(new Request(`${ORIGIN}/health`))).toHaveProperty(
    'status',
    200,
  );
  for (const operationId of [
    ...SIGNED_IN_OPERATIONS,
    ...READ_SCOPE_OPERATIONS,
    ...WRITE_SCOPE_OPERATIONS,
    ...INTERNAL_OPERATIONS,
  ]) {
    const shape = httpShapes.find((candidate) => candidate.operationId === operationId);
    if (shape === undefined) throw new Error(`missing policy fixture: ${operationId}`);
    const response = await unauthenticated.handle(
      requestWithHeaders(shape, { 'x-internal-auth': '' }),
    );
    expect({ operationId, status: response.status }).toEqual({ operationId, status: 401 });
  }

  const composition = await reachabilityOptions('oidc');
  const foreignOrigin = buildApp(composition.options);
  for (const operationId of [
    ...ALWAYS_ORIGIN_OPERATIONS,
    ...COOKIE_ORIGIN_OPERATIONS.filter((candidate) => candidate !== 'getApiProjectsByIdHistory'),
  ]) {
    const shape = httpShapes.find((candidate) => candidate.operationId === operationId);
    if (shape === undefined) throw new Error(`missing origin fixture: ${operationId}`);
    const response = await foreignOrigin.handle(
      requestWithHeaders(shape, {
        origin: 'https://foreign.test',
        cookie: '__Host-wbs_access=foreign-session',
      }),
    );
    expect({ operationId, status: response.status }).toEqual({ operationId, status: 403 });
  }

  expect(policyOperations('identity', 'signed-in')).toEqual([...SIGNED_IN_OPERATIONS]);
  expect(policyOperations('identity', 'read-scope')).toEqual([...READ_SCOPE_OPERATIONS]);
  expect(policyOperations('identity', 'write-scope')).toEqual([...WRITE_SCOPE_OPERATIONS]);
  expect(policyOperations('identity', 'internal')).toEqual([...INTERNAL_OPERATIONS]);
  expect(policyOperations('origin', 'always')).toEqual([...ALWAYS_ORIGIN_OPERATIONS]);
  expect(policyOperations('origin', 'always-unsafe-with-session-cookie')).toEqual([
    ...COOKIE_ORIGIN_OPERATIONS,
  ]);
  const everyOperation = httpShapes.map((shape) => shape.operationId).sort();
  expect(
    [
      ...PUBLIC_OPERATIONS,
      ...SIGNED_IN_OPERATIONS,
      ...READ_SCOPE_OPERATIONS,
      ...WRITE_SCOPE_OPERATIONS,
      ...INTERNAL_OPERATIONS,
    ].sort(),
  ).toEqual(everyOperation);
  expect(
    [...NO_ORIGIN_OPERATIONS, ...ALWAYS_ORIGIN_OPERATIONS, ...COOKIE_ORIGIN_OPERATIONS].sort(),
  ).toEqual(everyOperation);
  for (const shape of httpShapes) {
    const actualPolicies: readonly RequestPolicy[] = shape.policies;
    expect({ operationId: shape.operationId, policies: actualPolicies }).toEqual({
      operationId: shape.operationId,
      policies: expectedPolicies(shape.operationId),
    });
  }
});

it('refuses framed GET and HEAD bodies on the production health route', async () => {
  let probes = 0;
  const app = buildApp({
    ...options(),
    probeDatabase: () => {
      probes++;
      return 'ok';
    },
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => app.handle(request),
  });
  try {
    const port = server.port;
    if (port === undefined) throw new Error('test HTTP server has no TCP port');
    const statuses: string[] = [];
    const getBodies: string[] = [];
    for (const method of ['GET', 'HEAD'] as const) {
      for (const framed of [
        'Content-Length: 2\r\n\r\n{}',
        'Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n',
        'Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      ]) {
        const response = await sendRawHttp(
          port,
          `${method} /health HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n${framed}`,
        );
        statuses.push(response.split('\r\n', 1)[0] ?? 'missing status');
        if (method === 'GET') getBodies.push(response.split('\r\n\r\n', 2)[1] ?? 'missing body');
      }
    }
    expect(statuses).toEqual([
      'HTTP/1.1 400 Bad Request',
      'HTTP/1.1 400 Bad Request',
      'HTTP/1.1 400 Bad Request',
      'HTTP/1.1 400 Bad Request',
      'HTTP/1.1 400 Bad Request',
      'HTTP/1.1 400 Bad Request',
    ]);
    expect(getBodies).toEqual([
      '{"error":"invalid_body"}',
      '{"error":"invalid_body"}',
      '{"error":"invalid_body"}',
    ]);
    expect(probes).toBe(0);
    const emptyStatuses: string[] = [];
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await sendRawHttp(
        port,
        `${method} /health HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      emptyStatuses.push(response.split('\r\n', 1)[0] ?? 'missing status');
    }
    expect(emptyStatuses).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
    expect(probes).toBe(2);
  } finally {
    await server.stop(true);
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
