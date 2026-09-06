import { defineEndpointShape, responseSchema } from '@wbs/contracts';
import { type } from 'arktype';
import { expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import { jwtVerify, SignJWT } from 'jose';

import { AuthService } from '../../service/auth.service';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from '../../testing/auth-fixture';
import { bind } from '../endpoint';
import { identityResolver } from '../identity';
import { mountEndpoints } from './mount';

const internalSecret = 'identity-test-internal-secret';
const refusals = [
  { status: 401, schema: responseSchema(type({ error: "'unauthenticated' | 'unauthorized'" })) },
  { status: 403, schema: responseSchema(type({ error: "'insufficient_scope'" })) },
] as const;

function userApp(auth: AuthService, requirement: 'signed-in' | 'read-scope' | 'write-scope') {
  const shape = defineEndpointShape({
    method: 'GET',
    path: '/identity',
    operationId: 'userIdentity',
    policies: [{ kind: 'identity', require: requirement }],
    responses: [
      {
        kind: 'json',
        status: 200,
        schema: responseSchema(type({ id: 'string', username: 'string' })),
      },
    ],
    refusals,
    document: { summary: 'Resolve user identity' },
  });
  return new Elysia().use(
    mountEndpoints(
      [
        bind(shape, ({ principal }) =>
          Promise.resolve({
            ok: true,
            status: 200,
            body: { id: principal.id, username: principal.username },
          }),
        ),
      ],
      { appOrigin: 'https://app.example', resolveIdentity: identityResolver(auth, internalSecret) },
    ),
  );
}

function internalApp(auth: AuthService) {
  const shape = defineEndpointShape({
    method: 'GET',
    path: '/identity',
    operationId: 'internalIdentity',
    policies: [{ kind: 'identity', require: 'internal' }],
    responses: [
      { kind: 'json', status: 200, schema: responseSchema(type({ kind: "'internal'" })) },
    ],
    refusals,
    document: { summary: 'Resolve internal identity' },
  });
  return new Elysia().use(
    mountEndpoints(
      [bind(shape, ({ principal }) => Promise.resolve({ ok: true, status: 200, body: principal }))],
      { appOrigin: 'https://app.example', resolveIdentity: identityResolver(auth, internalSecret) },
    ),
  );
}

function request(headers: HeadersInit = {}) {
  return new Request('https://backend.example/identity', { headers });
}

async function passwordFixture() {
  const users = inMemoryUsers();
  const auth = testAuthService(users);
  const registered = await auth.register('ada', 'lovelace99');
  if (!registered.ok) throw new Error('identity fixture registration refused');
  return { users, auth, ...registered.value };
}

async function scopedFixture(scopes: readonly string[]) {
  const key = new TextEncoder().encode(TEST_JWT_KEY);
  const users = inMemoryUsers();
  const auth = testAuthService(users, {
    groupPrefix: 'dev',
    groupsClaim: 'groups',
    verifier: {
      async verify(token) {
        const { payload } = await jwtVerify(token, key, { issuer: 'https://issuer.example' });
        if (typeof payload.sub !== 'string') throw new Error('signed fixture lacks subject');
        return { ...payload, sub: payload.sub };
      },
    },
  });
  const token = await new SignJWT({ groups: scopes.map((scope) => `dev:wbs:${scope}`) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://issuer.example')
    .setSubject('scoped-account')
    .setExpirationTime('1h')
    .sign(key);
  const user = await auth.authenticate(token);
  if (user === null) throw new Error('signed scoped fixture could not resolve its account');
  return { users, auth, token, user };
}

test('resolves the actual password account once for each user requirement', async () => {
  const fixture = await passwordFixture();
  const authenticate = spyOn(fixture.auth, 'authenticate');
  try {
    for (const requirement of ['signed-in', 'read-scope', 'write-scope'] as const) {
      authenticate.mockClear();
      const reply = await userApp(fixture.auth, requirement).handle(
        request({ authorization: `Bearer ${fixture.token}` }),
      );
      expect(reply.status).toBe(200);
      expect(await reply.json()).toEqual(fixture.user);
      expect(authenticate).toHaveBeenCalledTimes(1);
    }
  } finally {
    authenticate.mockRestore();
  }
});

test('requires the requested scope while signed-in accepts an account with no scopes', async () => {
  for (const scopes of [[], ['read'], ['write']] as const) {
    const fixture = await scopedFixture(scopes);
    for (const [requirement, allowed] of [
      ['signed-in', true],
      ['read-scope', scopes.some((scope) => scope === 'read')],
      ['write-scope', scopes.some((scope) => scope === 'write')],
    ] as const) {
      const authenticate = spyOn(fixture.auth, 'authenticate');
      try {
        const reply = await userApp(fixture.auth, requirement).handle(
          request({ authorization: `Bearer ${fixture.token}` }),
        );
        expect(reply.status).toBe(allowed ? 200 : 403);
        expect(await reply.json()).toEqual(
          allowed
            ? { id: fixture.user.id, username: fixture.user.username }
            : { error: 'insufficient_scope' },
        );
        expect(authenticate).toHaveBeenCalledTimes(1);
      } finally {
        authenticate.mockRestore();
      }
    }
  }
});

test('preserves cookie precedence, decoding and malformed-cookie Bearer fallback', async () => {
  const fixture = await passwordFixture();
  const second = await fixture.auth.register('grace', 'hopper2026');
  if (!second.ok) throw new Error('second identity fixture registration refused');
  const app = userApp(fixture.auth, 'signed-in');
  const cookieWins = await app.handle(
    request({
      cookie: `__Host-wbs_access=${fixture.token.replaceAll('.', '%2E')}`,
      authorization: `Bearer ${second.value.token}`,
    }),
  );
  expect(cookieWins.status).toBe(200);
  expect(await cookieWins.json()).toEqual(fixture.user);
  const fallback = await app.handle(
    request({
      cookie: '__Host-wbs_access=%',
      authorization: `Bearer ${second.value.token}`,
    }),
  );
  expect(fallback.status).toBe(200);
  expect(await fallback.json()).toEqual(second.value.user);
  const invalidCookie = await app.handle(
    request({
      cookie: '__Host-wbs_access=invalid',
      authorization: `Bearer ${second.value.token}`,
    }),
  );
  expect(invalidCookie.status).toBe(401);
  expect(await invalidCookie.json()).toEqual({ error: 'unauthenticated' });
});

test('refuses absent, invalid and retired credentials without inventing an account', async () => {
  const fixture = await passwordFixture();
  const credentialHeaders: HeadersInit[] = [
    {},
    { authorization: 'Bearer invalid' },
    { 'x-wbs-token': fixture.token },
  ];
  for (const headers of credentialHeaders) {
    const reply = await userApp(fixture.auth, 'signed-in').handle(request(headers));
    expect(reply.status).toBe(401);
    expect(await reply.json()).toEqual({ error: 'unauthenticated' });
  }
});

test('resolves only the internal secret as internal without authenticating a user', async () => {
  const fixture = await passwordFixture();
  const authenticate = spyOn(fixture.auth, 'authenticate');
  try {
    const app = internalApp(fixture.auth);
    const refusedHeaders: HeadersInit[] = [
      {},
      { 'x-internal-auth': 'wrong' },
      { authorization: `Bearer ${fixture.token}` },
    ];
    for (const headers of refusedHeaders) {
      const reply = await app.handle(request(headers));
      expect(reply.status).toBe(401);
      expect(await reply.json()).toEqual({ error: 'unauthorized' });
    }
    const reply = await app.handle(request({ 'X-Internal-Auth': internalSecret }));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ kind: 'internal' });
    expect(authenticate).toHaveBeenCalledTimes(0);
  } finally {
    authenticate.mockRestore();
  }
});

test('keeps password account-store failures unknown at the mounted boundary', async () => {
  const fixture = await passwordFixture();
  const failure = spyOn(fixture.users, 'findById').mockRejectedValue(
    new Error('account store unavailable'),
  );
  try {
    const reply = await userApp(fixture.auth, 'signed-in').handle(
      request({ authorization: `Bearer ${fixture.token}` }),
    );
    expect(reply.status).toBe(500);
    expect(await reply.text()).toBe('Internal Server Error');
    expect(failure).toHaveBeenCalledTimes(1);
  } finally {
    failure.mockRestore();
  }
});

test('keeps OIDC account resolution failures unknown at the mounted boundary', async () => {
  const fixture = await scopedFixture(['read']);
  const failure = spyOn(fixture.users, 'resolveOidcIdentity').mockRejectedValue(
    new Error('identity store unavailable'),
  );
  try {
    const reply = await userApp(fixture.auth, 'read-scope').handle(
      request({ authorization: `Bearer ${fixture.token}` }),
    );
    expect(reply.status).toBe(500);
    expect(await reply.text()).toBe('Internal Server Error');
    expect(failure).toHaveBeenCalledTimes(1);
  } finally {
    failure.mockRestore();
  }
});

test('preserves an explicitly composed local identity without credentials', async () => {
  const users = inMemoryUsers();
  const auth = new AuthService({
    users,
    identities: users,
    jwtKey: TEST_JWT_KEY,
    localIdentity: { id: 'local-account', username: 'local', scopes: ['read', 'write'] },
  });
  const reply = await userApp(auth, 'write-scope').handle(request());
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({ id: 'local-account', username: 'local' });
});
