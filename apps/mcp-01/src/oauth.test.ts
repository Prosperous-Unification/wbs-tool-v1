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
      now: () => 1_700_000_000_000,
      random: () => values.shift() ?? 'random-exhausted',
    }),
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
});
