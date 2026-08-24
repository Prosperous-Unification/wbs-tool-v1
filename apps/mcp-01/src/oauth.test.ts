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

function fixture() {
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

async function authorizationCode(oauth: InMemoryMcpOAuth, verifier: string): Promise<string> {
  const clientId = await register(oauth);
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
  return (
    new URL(completed?.headers.get('location') ?? 'https://invalid').searchParams.get('code') ?? ''
  );
}

describe('InMemoryMcpOAuth', () => {
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
