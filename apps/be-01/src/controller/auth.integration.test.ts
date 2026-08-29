import { describe, expect, it } from 'bun:test';
import { jwtVerify, SignJWT } from 'jose';

import { buildApp } from '../app';
import { AuthService } from '../service/auth.service';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from '../testing/auth-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testProjectService } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testRoleService } from '../testing/role-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import { testWrites } from '../testing/writes-fixture';

const TEST_SECRET = 'x'.repeat(32);

function app() {
  return buildApp({
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    auth: testAuthService(),
    projects: testProjectService(),
    workItems: testWorkItemService(),
    roles: testRoleService(),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: TEST_SECRET,
    writes: testWrites(),
    migrationsApplied: true,
  });
}

const json = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/register', () => {
  it('issues a token gw-01 can verify with the shared key', async () => {
    const res = await app().handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { username: string } };
    expect(body.user.username).toBe('ada');

    // The point of the assertion: the token is verifiable by exactly the
    // procedure gw-01 runs on the WebSocket handshake. A token be-01 accepts
    // but gw-01 rejects would still pass a be-01-only test.
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(TEST_JWT_KEY));
    expect(payload['username']).toBe('ada');
    expect(typeof payload.sub).toBe('string');
  });

  it('rejects a duplicate username with 409', async () => {
    const a = app();
    await a.handle(json('/api/auth/register', { username: 'ada', password: 'lovelace99' }));
    const res = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'different1' }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('taken');
  });

  it('rejects a short password with 400', async () => {
    const res = await app().handle(
      json('/api/auth/register', { username: 'ada', password: 'short' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token for correct credentials', async () => {
    const a = app();
    await a.handle(json('/api/auth/register', { username: 'grace', password: 'hopper2026' }));
    const res = await a.handle(
      json('/api/auth/login', { username: 'grace', password: 'hopper2026' }),
    );
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { token: string }).token).toBe('string');
  });

  it('returns 401 for a wrong password', async () => {
    const a = app();
    await a.handle(json('/api/auth/register', { username: 'grace', password: 'hopper2026' }));
    const res = await a.handle(
      json('/api/auth/login', { username: 'grace', password: 'wrongpassword' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown user, with the same body as a wrong password', async () => {
    const res = await app().handle(
      json('/api/auth/login', { username: 'nobody', password: 'whatever12' }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_credentials');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the fixed development identity without a token in local mode', async () => {
    const users = inMemoryUsers();
    const local = new AuthService({
      users,
      identities: users,
      jwtKey: TEST_JWT_KEY,
      localIdentity: {
        id: 'local-dev',
        username: 'local-dev',
        scopes: ['read', 'write', 'editor'],
      },
    });
    const res = await buildApp({
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      auth: local,
      projects: testProjectService(),
      workItems: testWorkItemService(),
      roles: testRoleService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: TEST_SECRET,
      writes: testWrites(),
      migrationsApplied: true,
    }).handle(new Request('http://localhost/api/auth/me'));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { username: string } }).user.username).toBe('local-dev');
  });

  it('resolves the caller from a bearer token', async () => {
    const a = app();
    const reg = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    const { token } = (await reg.json()) as { token: string };
    const res = await a.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { username: string } }).user.username).toBe('ada');
  });

  it('rejects a token signed with a different key', async () => {
    const a = app();
    const reg = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    const { token } = (await reg.json()) as { token: string };
    const sub = (await jwtVerify(token, new TextEncoder().encode(TEST_JWT_KEY))).payload.sub;

    // Signed with a different key, not mutated.
    //
    // The previous version replaced the last character of the signature with
    // 'a'. An HS256 signature is 32 bytes, which base64url-encodes to 43
    // characters whose final one carries only 4 significant bits and 2 spare
    // ones — so it is drawn from `048AEIMQUYcgkosw`, and any two characters
    // sharing `index >> 2` decode to identical bytes. 'a' is index 26; 'Y' is
    // 24; both give 6. A signature ending in 'Y' therefore "tampered" into the
    // byte-identical original, and the assertion that tokens are *verified*
    // rather than decoded passed a genuinely valid token. Roughly one run in
    // sixteen: it survived nine CI runs and failed the tenth with 200.
    const forged = await new SignJWT({ username: 'ada' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub ?? 'unknown')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-different-key-of-at-least-32-chars!'));

    const res = await a.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${forged}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a token whose signature bytes have been altered', async () => {
    const a = app();
    const reg = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    const { token } = (await reg.json()) as { token: string };

    // Deterministic: the FIRST character of the signature carries six
    // significant bits, so changing it always changes the decoded bytes —
    // unlike the last character, which has two spare ones.
    const [header, payload, signature] = token.split('.');
    const first = signature.startsWith('A') ? 'B' : 'A';
    const tampered = `${header}.${payload}.${first}${signature.slice(1)}`;

    const res = await a.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${tampered}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects the retired x-wbs-token header', async () => {
    const a = app();
    const reg = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    const { token } = (await reg.json()) as { token: string };
    // Proof: restoring the x-wbs-token branch in tokenFromHeaders makes this
    // request authenticate and changes the expected 401 into 200.
    const res = await a.handle(
      new Request('http://localhost/api/auth/me', { headers: { 'x-wbs-token': token } }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a missing header', async () => {
    const res = await app().handle(new Request('http://localhost/api/auth/me'));
    expect(res.status).toBe(401);
  });
});
