import { createHash } from 'node:crypto';

import type { BrowserOidcClient } from '@wbs/auth';
import { describe, expect, it } from 'bun:test';

import type { McpConfig } from './config';
import { InMemoryMcpOAuth } from './oauth';

const CONFIG: McpConfig = {
  MCP_AUTH_MODE: 'standalone',
  MCP_PUBLIC_URL: 'https://dev.wbs.bulletpoints.club/mcp',
  WBS_API_URL: 'https://dev.wbs.bulletpoints.club',
};
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function fixture(
  limits: {
    clientLimit?: number;
    clientSourceLimit?: number;
    clientTtlMs?: number;
    activeClientTtlMs?: number;
    grantLimit?: number;
    provenClientSourceLimit?: number;
    sessionLimit?: number;
    transactionLimit?: number;
    transactionLimitPerClient?: number;
  } = {},
) {
  let now = 1_700_000_000_000;
  const values = Array.from({ length: 20 }, (_, index) => `random-${String(index + 1)}`);
  const authorizationCalls: unknown[] = [];
  const exchangeCalls: unknown[] = [];
  const provider: Pick<BrowserOidcClient, 'authorizationUrl' | 'exchange'> = {
    authorizationUrl: (input) => {
      authorizationCalls.push(input);
      return Promise.resolve(new URL(`https://idp.example/authorize?state=${input.state}`));
    },
    exchange: (request, checks) => {
      exchangeCalls.push({ request, checks });
      return Promise.resolve({ accessToken: 'upstream-okta-token', expiresIn: 300 });
    },
  };
  return {
    authorizationCalls,
    exchangeCalls,
    oauth: new InMemoryMcpOAuth(CONFIG, provider, {
      groupsClaim: 'wbs_groups',
      groupPrefix: 'dev',
      now: () => now,
      random: () => values.shift() ?? 'random-exhausted',
      verifyUpstream: (token) =>
        token === 'upstream-okta-token'
          ? Promise.resolve({
              iss: 'https://idp.example',
              sub: 'person-1',
              wbs_groups: ['dev:wbs:read', 'dev:wbs:write'],
            })
          : Promise.reject(new Error('not an upstream token')),
      ...limits,
    }),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function register(oauth: InMemoryMcpOAuth): Promise<string> {
  const response = await oauth.response(
    new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/register', {
      body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  );
  expect(response?.status).toBe(201);
  if (response === undefined) throw new Error('DCR endpoint did not handle the request');
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function registrationResponse(
  oauth: InMemoryMcpOAuth,
  redirectUris: readonly string[],
  source = '203.0.113.1',
): Promise<Response> {
  const response = await oauth.response(
    new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/register', {
      body: JSON.stringify({ redirect_uris: redirectUris, token_endpoint_auth_method: 'none' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': source },
      method: 'POST',
    }),
  );
  if (response === undefined) throw new Error('DCR endpoint did not handle the request');
  return response;
}

function authorizeUrl(clientId: string, redirectUri = CALLBACK): URL {
  const url = new URL('https://dev.wbs.bulletpoints.club/mcp/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'wbs:read wbs:write',
    state: 'claude-state',
  }).toString();
  return url;
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function completedAuthorization(
  oauth: InMemoryMcpOAuth,
  verifier: string,
  registeredClientId?: string,
): Promise<{ clientId: string; response: Response }> {
  const clientId = registeredClientId ?? (await register(oauth));
  const url = authorizeUrl(clientId);
  url.searchParams.set('code_challenge', challengeOf(verifier));
  const started = await oauth.response(new Request(url));
  const binding = started?.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const upstream = new URL(started?.headers.get('location') ?? 'https://invalid');
  const response = await oauth.response(
    new Request(
      `https://dev.wbs.bulletpoints.club/mcp/oauth/callback?code=upstream&state=${String(upstream.searchParams.get('state'))}`,
      { headers: { cookie: binding } },
    ),
  );
  if (response === undefined) throw new Error('callback endpoint did not handle the request');
  return { clientId, response };
}

async function authorizationCode(oauth: InMemoryMcpOAuth, verifier: string): Promise<string> {
  const { response } = await completedAuthorization(oauth, verifier);
  return (
    new URL(response.headers.get('location') ?? 'https://invalid').searchParams.get('code') ?? ''
  );
}

async function tokenResponse(
  oauth: InMemoryMcpOAuth,
  clientId: string,
  code: string,
  verifier: string,
): Promise<Response> {
  const response = await oauth.response(
    new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/token', {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: CALLBACK,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    }),
  );
  if (response === undefined) throw new Error('token endpoint did not handle the request');
  return response;
}

async function promoteClient(oauth: InMemoryMcpOAuth, source: string): Promise<string> {
  const registration = await registrationResponse(oauth, [CALLBACK], source);
  expect(registration.status).toBe(201);
  const clientId = ((await registration.json()) as { client_id: string }).client_id;
  const verifier = 'v'.repeat(43);
  const url = authorizeUrl(clientId);
  url.searchParams.set('code_challenge', challengeOf(verifier));
  const started = await oauth.response(new Request(url));
  const binding = started?.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const upstream = new URL(started?.headers.get('location') ?? 'https://invalid');
  const completed = await oauth.response(
    new Request(
      `https://dev.wbs.bulletpoints.club/mcp/oauth/callback?code=upstream&state=${String(upstream.searchParams.get('state'))}`,
      { headers: { cookie: binding } },
    ),
  );
  const code = new URL(completed?.headers.get('location') ?? 'https://invalid').searchParams.get(
    'code',
  );
  const token = await oauth.response(
    new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/token', {
      body: new URLSearchParams({
        client_id: clientId,
        code: code ?? '',
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: CALLBACK,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    }),
  );
  expect(token?.status).toBe(200);
  return clientId;
}

describe('InMemoryMcpOAuth', () => {
  // Break caught: accepting an arbitrary HTTPS callback lets an attacker
  // register their origin and exfiltrate a signed-in user's authorization code.
  it('limits dynamic registration to the real connector and loopback clients', async () => {
    const { oauth } = fixture();

    expect((await registrationResponse(oauth, ['https://evil.example/callback'])).status).toBe(400);
    expect(
      (await registrationResponse(oauth, ['https://claude.ai/api/mcp/auth_callback'])).status,
    ).toBe(201);
    expect(
      (await registrationResponse(oauth, ['http://127.0.0.1:6274/oauth/callback'])).status,
    ).toBe(201);
  });

  // Proof: omitting cleanup before the capacity check leaves an expired client
  // occupying the only slot and rejects a replacement connector forever.
  it('expires dynamic clients and frees their capacity', async () => {
    const expiring = fixture({ clientLimit: 1, clientTtlMs: 1_000 });
    const clientId = await register(expiring.oauth);
    expect((await registrationResponse(expiring.oauth, [CALLBACK])).status).toBe(429);
    expiring.advance(1_001);
    expect((await registrationResponse(expiring.oauth, [CALLBACK])).status).toBe(201);
    expect((await expiring.oauth.response(new Request(authorizeUrl(clientId))))?.status).toBe(400);
  });

  // Proof: a 24-hour anonymous registration lifetime lets an attacker keep all
  // slots occupied by refreshing the registry less than once per day.
  it('discloses a short expiry for unproven dynamic clients', async () => {
    const { advance, oauth } = fixture({ clientLimit: 1 });
    const response = await registrationResponse(oauth, [CALLBACK]);
    const body = (await response.json()) as {
      client_id_expires_at: number;
      client_id_issued_at: number;
    };

    expect(body.client_id_expires_at - body.client_id_issued_at).toBe(600);
    advance(600_001);
    expect((await registrationResponse(oauth, [CALLBACK])).status).toBe(201);
  });

  // Proof: leaving every registration short-lived makes a legitimate connector
  // lose its client id soon after completing the authenticated token exchange.
  it('promotes a client only after a successful token exchange', async () => {
    const { advance, oauth } = fixture({ clientLimit: 1 });
    const verifier = 'v'.repeat(43);
    const code = await authorizationCode(oauth, verifier);
    const response = await oauth.response(
      new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/token', {
        body: new URLSearchParams({
          client_id: 'random-1',
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }),
    );

    expect(response?.status).toBe(200);
    advance(600_001);
    expect((await registrationResponse(oauth, [CALLBACK])).status).toBe(429);
    expect((await oauth.response(new Request(authorizeUrl('random-1'))))?.status).toBe(302);
  });

  // Proof: leaving the client on its original DCR expiry lets unrelated
  // cleanup delete it after Auth0 has issued a valid local authorization code.
  it('keeps an unproven client alive through its active authorization flow', async () => {
    const { advance, oauth } = fixture({ clientLimit: 3 });
    const verifier = 'v'.repeat(43);
    const clientId = await register(oauth);
    advance(400_000);
    const url = authorizeUrl(clientId);
    url.searchParams.set('code_challenge', challengeOf(verifier));
    const started = await oauth.response(new Request(url));
    const binding = started?.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const upstream = new URL(started?.headers.get('location') ?? 'https://invalid');
    advance(290_000);
    const completed = await oauth.response(
      new Request(
        `https://dev.wbs.bulletpoints.club/mcp/oauth/callback?code=upstream&state=${String(upstream.searchParams.get('state'))}`,
        { headers: { cookie: binding } },
      ),
    );
    const code = new URL(completed?.headers.get('location') ?? 'https://invalid').searchParams.get(
      'code',
    );
    expect((await registrationResponse(oauth, [CALLBACK], '203.0.113.2')).status).toBe(201);

    const token = await oauth.response(
      new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/token', {
        body: new URLSearchParams({
          client_id: clientId,
          code: code ?? '',
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }),
    );
    expect(token?.status).toBe(200);
  });

  // Proof: extending expiry from the current time on every authorize lets a
  // registered but unauthenticated client renew itself forever without login.
  it('caps repeated authorization extensions at an absolute unproven lifetime', async () => {
    const { advance, oauth } = fixture();
    const clientId = await register(oauth);

    advance(400_000);
    expect((await oauth.response(new Request(authorizeUrl(clientId))))?.status).toBe(302);
    advance(200_000);
    expect((await oauth.response(new Request(authorizeUrl(clientId))))?.status).toBe(302);
    advance(600_001);
    expect((await oauth.response(new Request(authorizeUrl(clientId))))?.status).toBe(400);
  });

  // Proof: starting after the remaining absolute lifetime falls below the
  // browser-plus-code window mints a grant whose client expires before token.
  it('refuses an unproven authorization too late to complete token exchange', async () => {
    const { advance, oauth } = fixture();
    const clientId = await register(oauth);

    advance(400_000);
    expect((await oauth.response(new Request(authorizeUrl(clientId))))?.status).toBe(302);
    advance(200_001);
    expect((await oauth.response(new Request(authorizeUrl(clientId))))?.status).toBe(429);
  });

  // Proof: a global-only cap lets one source refill all expired anonymous
  // registrations forever and prevent a new connector from registering.
  it('partitions anonymous registration capacity by forwarding source', async () => {
    const { oauth } = fixture({ clientLimit: 2, clientSourceLimit: 1 });

    expect((await registrationResponse(oauth, [CALLBACK], '203.0.113.1')).status).toBe(201);
    expect((await registrationResponse(oauth, [CALLBACK], '203.0.113.1')).status).toBe(429);
    expect((await registrationResponse(oauth, [CALLBACK], '203.0.113.2')).status).toBe(201);
  });

  // Proof: counting promoted clients in the source bucket makes shared
  // connector egress hit the anonymous cap for up to 24 hours.
  it('removes a proven client from its anonymous source partition', async () => {
    const { oauth } = fixture({ clientLimit: 2, clientSourceLimit: 1 });
    const verifier = 'v'.repeat(43);
    const code = await authorizationCode(oauth, verifier);
    const token = await oauth.response(
      new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/token', {
        body: new URLSearchParams({
          client_id: 'random-1',
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }),
    );

    expect(token?.status).toBe(200);
    expect((await registrationResponse(oauth, [CALLBACK], '')).status).toBe(201);
  });

  // Proof: leaving promoted clients under only the global cap lets one source
  // complete scripted logins until every registration slot is unavailable.
  it('partitions proven registration capacity by forwarding source', async () => {
    const { oauth } = fixture({
      clientLimit: 4,
      clientSourceLimit: 1,
      provenClientSourceLimit: 2,
    });

    await promoteClient(oauth, '203.0.113.1');
    await promoteClient(oauth, '203.0.113.1');

    expect((await registrationResponse(oauth, [CALLBACK], '203.0.113.1')).status).toBe(429);
    expect((await registrationResponse(oauth, [CALLBACK], '203.0.113.2')).status).toBe(201);
  });

  // Proof: checking the proven-source cap only during registration admits two
  // anonymous clients, then lets both promote and exceed the authenticated cap.
  it('reserves proven-source capacity before consuming a token grant', async () => {
    const { advance, oauth } = fixture({
      activeClientTtlMs: 1_000,
      clientLimit: 3,
      clientSourceLimit: 2,
      provenClientSourceLimit: 1,
    });
    const verifier = 'v'.repeat(43);
    const firstRegistration = await registrationResponse(oauth, [CALLBACK], '203.0.113.1');
    const secondRegistration = await registrationResponse(oauth, [CALLBACK], '203.0.113.1');
    const firstClientId = ((await firstRegistration.json()) as { client_id: string }).client_id;
    const secondClientId = ((await secondRegistration.json()) as { client_id: string }).client_id;
    const firstAuthorization = await completedAuthorization(oauth, verifier, firstClientId);
    const secondAuthorization = await completedAuthorization(oauth, verifier, secondClientId);
    const firstCode = new URL(
      firstAuthorization.response.headers.get('location') ?? '',
    ).searchParams.get('code');
    const secondCode = new URL(
      secondAuthorization.response.headers.get('location') ?? '',
    ).searchParams.get('code');

    expect((await tokenResponse(oauth, firstClientId, firstCode ?? '', verifier)).status).toBe(200);
    const refused = await tokenResponse(oauth, secondClientId, secondCode ?? '', verifier);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'temporarily_unavailable' });

    advance(1_001);
    expect((await tokenResponse(oauth, secondClientId, secondCode ?? '', verifier)).status).toBe(
      200,
    );
  });

  // Proof: checking only the already-proven count lets concurrent signing
  // requests both observe a free slot and promote past the source cap.
  it('reserves proven-source capacity across concurrent token signing', async () => {
    const { oauth } = fixture({
      clientLimit: 3,
      clientSourceLimit: 2,
      provenClientSourceLimit: 1,
    });
    const verifier = 'v'.repeat(43);
    const firstRegistration = await registrationResponse(oauth, [CALLBACK], '203.0.113.1');
    const secondRegistration = await registrationResponse(oauth, [CALLBACK], '203.0.113.1');
    const firstClientId = ((await firstRegistration.json()) as { client_id: string }).client_id;
    const secondClientId = ((await secondRegistration.json()) as { client_id: string }).client_id;
    const firstAuthorization = await completedAuthorization(oauth, verifier, firstClientId);
    const secondAuthorization = await completedAuthorization(oauth, verifier, secondClientId);
    const firstCode = new URL(
      firstAuthorization.response.headers.get('location') ?? '',
    ).searchParams.get('code');
    const secondCode = new URL(
      secondAuthorization.response.headers.get('location') ?? '',
    ).searchParams.get('code');

    const responses = await Promise.all([
      tokenResponse(oauth, firstClientId, firstCode ?? '', verifier),
      tokenResponse(oauth, secondClientId, secondCode ?? '', verifier),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 429]);
  });

  // Proof: replacing capacity refusal with FIFO eviction makes the first
  // registered connector fail authorization after an anonymous registration.
  it('refuses registration at capacity without evicting a live connector', async () => {
    const { oauth } = fixture({ clientLimit: 1 });
    const first = await register(oauth);

    expect((await registrationResponse(oauth, [CALLBACK])).status).toBe(429);
    expect((await oauth.response(new Request(authorizeUrl(first))))?.status).toBe(302);
  });

  // Proof: evicting the oldest transaction lets anonymous authorize traffic
  // cancel a signed-in connector's in-flight callback.
  it('refuses authorization at capacity without evicting an in-flight login', async () => {
    const { exchangeCalls, oauth } = fixture({ transactionLimit: 1 });
    const clientId = await register(oauth);
    const first = await oauth.response(new Request(authorizeUrl(clientId)));
    const firstState = new URL(
      first?.headers.get('location') ?? 'https://invalid',
    ).searchParams.get('state');
    const firstCookie = first?.headers.get('set-cookie')?.split(';', 1)[0] ?? '';

    expect((await oauth.response(new Request(authorizeUrl(clientId))))?.status).toBe(429);
    const callback = await oauth.response(
      new Request(
        `https://dev.wbs.bulletpoints.club/mcp/oauth/callback?code=upstream&state=${String(firstState)}`,
        { headers: { cookie: firstCookie } },
      ),
    );
    expect(callback?.status).toBe(302);
    expect(exchangeCalls).toHaveLength(1);
  });

  // Proof: a global-only transaction cap lets one registered client deny
  // authorization to every other connector for the full transaction TTL.
  it('partitions pending authorization capacity by client', async () => {
    const { oauth } = fixture({ transactionLimit: 2, transactionLimitPerClient: 1 });
    const first = await register(oauth);
    const second = await register(oauth);

    expect((await oauth.response(new Request(authorizeUrl(first))))?.status).toBe(302);
    expect((await oauth.response(new Request(authorizeUrl(first))))?.status).toBe(429);
    expect((await oauth.response(new Request(authorizeUrl(second))))?.status).toBe(302);
  });

  // Proof: allowing callbacks to append authorization grants without a bound
  // lets completed Auth0 flows retain arbitrary upstream access tokens.
  it('refuses a callback at grant capacity without evicting a live grant', async () => {
    const { oauth } = fixture({ grantLimit: 1 });
    const verifier = 'v'.repeat(43);
    const firstCode = await authorizationCode(oauth, verifier);
    const second = await completedAuthorization(oauth, verifier);

    expect(firstCode).toBe('random-6');
    expect(second.response.status).toBe(429);
    expect(await second.response.json()).toEqual({ error: 'temporarily_unavailable' });
    expect((await tokenResponse(oauth, 'random-1', firstCode, verifier)).status).toBe(200);
  });

  // Proof: allowing token exchanges to append sessions without a bound keeps
  // arbitrary upstream access tokens live until every local token expires.
  it('refuses token exchange at session capacity and preserves the retryable grant', async () => {
    const { oauth } = fixture({ sessionLimit: 1 });
    const verifier = 'v'.repeat(43);
    const firstCode = await authorizationCode(oauth, verifier);
    const secondCode = await authorizationCode(oauth, verifier);
    const first = await tokenResponse(oauth, 'random-1', firstCode, verifier);
    const firstToken = ((await first.json()) as { access_token: string }).access_token;

    expect((await tokenResponse(oauth, 'random-7', secondCode, verifier)).status).toBe(429);
    expect(await oauth.verify(firstToken)).toMatchObject({ sub: 'person-1' });
    await oauth.response(
      new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/revoke', {
        body: new URLSearchParams({ token: firstToken }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }),
    );
    expect((await tokenResponse(oauth, 'random-7', secondCode, verifier)).status).toBe(200);
  });

  // Proof: removing the byte and multiplicity checks retains attacker-chosen
  // query material in a pending transaction.
  it('rejects oversized or repeated authorization query fields', async () => {
    const { oauth } = fixture();
    const clientId = await register(oauth);
    const oversizedState = authorizeUrl(clientId);
    oversizedState.searchParams.set('state', 'Д'.repeat(257));
    const repeatedScope = authorizeUrl(clientId);
    repeatedScope.searchParams.append('scope', 'wbs:read');

    expect((await oauth.response(new Request(oversizedState)))?.status).toBe(400);
    expect((await oauth.response(new Request(repeatedScope)))?.status).toBe(400);
  });

  // Proof: allowing unbounded redirect metadata retains arbitrary query bytes
  // for every dynamic client and broadens the exact Claude callback boundary.
  it('bounds stored redirects and rejects query-bearing Claude callbacks', async () => {
    const { oauth } = fixture();
    const tooMany = Array.from(
      { length: 11 },
      (_, port) => `http://127.0.0.1:${String(6000 + port)}/oauth/callback`,
    );

    expect((await registrationResponse(oauth, tooMany)).status).toBe(400);
    expect(
      (await registrationResponse(oauth, [`${CALLBACK}?retained=${'x'.repeat(20)}`])).status,
    ).toBe(400);
  });

  // Proof: weakening exact membership to same-origin lets this unregistered
  // path become an authorization-code exfiltration redirect.
  it('registers a public client and refuses an unregistered redirect URI', async () => {
    const { oauth } = fixture();
    const clientId = await register(oauth);
    const rejected = await oauth.response(
      new Request(authorizeUrl(clientId, 'https://claude.ai/steal')),
    );

    expect(rejected?.status).toBe(400);
    expect(await rejected?.json()).toEqual({ error: 'invalid_request' });
  });

  // Proof: retaining the upstream transaction after callback makes the same
  // provider response mint a second local authorization code.
  it('binds PKCE to a one-use upstream browser round trip', async () => {
    const { authorizationCalls, exchangeCalls, oauth } = fixture();
    const clientId = await register(oauth);
    const started = await oauth.response(new Request(authorizeUrl(clientId)));
    const cookie = started?.headers.get('set-cookie')?.split(';', 1)[0];

    expect(started?.status).toBe(302);
    expect(started?.headers.get('location')).toBe('https://idp.example/authorize?state=random-3');
    expect(authorizationCalls).toEqual([
      {
        nonce: 'random-4',
        redirectUri: 'https://dev.wbs.bulletpoints.club/mcp/oauth/callback',
        state: 'random-3',
        verifier: 'random-5',
      },
    ]);

    const callback = new Request(
      'https://dev.wbs.bulletpoints.club/mcp/oauth/callback?code=upstream&state=random-3',
      { headers: { cookie: cookie ?? '' } },
    );
    const completed = await oauth.response(callback);
    const redirect = new URL(completed?.headers.get('location') ?? 'https://invalid');

    expect(completed?.status).toBe(302);
    expect(redirect.origin + redirect.pathname).toBe(CALLBACK);
    expect(redirect.searchParams.get('state')).toBe('claude-state');
    const code = redirect.searchParams.get('code');
    expect(code).toBe('random-6');
    expect(oauth.readGrant(code ?? '')).toMatchObject({
      clientId,
      codeChallenge: 'A'.repeat(43),
      upstreamAccessToken: 'upstream-okta-token',
    });
    expect(exchangeCalls).toHaveLength(1);
    expect((await oauth.response(callback))?.status).toBe(400);
    expect(exchangeCalls).toHaveLength(1);
  });

  // Break caught: forwarding the local MCP token or omitting its audience/JTI
  // makes this end-to-end trust trace fail before be-01 receives the Okta token.
  it('exchanges one authorization code for an audience-bound local token and retains the upstream token server-side', async () => {
    const { oauth } = fixture();
    const verifier = 'v'.repeat(43);
    const code = await authorizationCode(oauth, verifier);
    const clientId = 'random-1';
    const exchange = () =>
      oauth.response(
        new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/token', {
          body: new URLSearchParams({
            client_id: clientId,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: CALLBACK,
          }),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          method: 'POST',
        }),
      );

    const response = await exchange();
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      access_token: string;
      expires_in: number;
      scope: string;
      token_type: string;
    };
    expect(body).toMatchObject({
      expires_in: 300,
      scope: 'wbs:read wbs:write',
      token_type: 'Bearer',
    });
    expect(oauth.verify(body.access_token)).resolves.toMatchObject({
      aud: 'https://dev.wbs.bulletpoints.club/mcp',
      iss: 'https://dev.wbs.bulletpoints.club/mcp/oauth',
      jti: 'random-7',
      sub: 'person-1',
    });
    expect(oauth.upstreamTokenFor(body.access_token)).resolves.toBe('upstream-okta-token');
    expect((await exchange())?.status).toBe(400);
  });

  // Break caught: replacing the original standalone JWKS verifier with only
  // the fronting-AS key would reject clients that already present Okta tokens.
  it('keeps verified upstream Bearer tokens valid in standalone mode', () => {
    const { oauth } = fixture();
    expect(oauth.verify('upstream-okta-token')).resolves.toMatchObject({ sub: 'person-1' });
    expect(oauth.upstreamTokenFor('upstream-okta-token')).resolves.toBe('upstream-okta-token');
  });

  // Break caught: signature-only verification would keep accepting a session
  // after its server-side mapping expires or is explicitly revoked.
  it('refuses expired and revoked local sessions', async () => {
    const { advance, oauth } = fixture();
    const verifier = 'v'.repeat(43);
    const code = await authorizationCode(oauth, verifier);
    const tokenResponse = await oauth.response(
      new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/token', {
        body: new URLSearchParams({
          client_id: 'random-1',
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }),
    );
    const token = ((await tokenResponse?.json()) as { access_token: string }).access_token;

    const revoked = await oauth.response(
      new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/revoke', {
        body: new URLSearchParams({ token }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }),
    );
    expect(revoked?.status).toBe(200);
    expect(oauth.verify(token)).rejects.toThrow();

    const secondCode = await authorizationCode(oauth, verifier);
    const secondResponse = await oauth.response(
      new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/token', {
        body: new URLSearchParams({
          client_id: 'random-8',
          code: secondCode,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }),
    );
    const secondToken = ((await secondResponse?.json()) as { access_token: string }).access_token;
    advance(300_001);
    expect(oauth.verify(secondToken)).rejects.toThrow();
  });
});
