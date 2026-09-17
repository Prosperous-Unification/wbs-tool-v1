import type { BrowserOidcClient } from '@wbs/auth';
import { beforeAll, expect, test } from 'bun:test';

import type { McpConfig } from './config';
import { InMemoryMcpOAuth } from './oauth';

interface TimingSafeEqualCall {
  leftBytes: number;
  rightBytes: number;
}

declare global {
  var timingSafeEqualCalls: TimingSafeEqualCall[];
}

const CONFIG: McpConfig = {
  MCP_AUTH_MODE: 'standalone',
  MCP_PUBLIC_URL: 'https://dev.wbs.bulletpoints.club/mcp',
  WBS_API_URL: 'https://dev.wbs.bulletpoints.club',
};

let wrongStatus: number | undefined;
let wrongSetCookie: string | null | undefined;
let honestStatus: number | undefined;
let exchangeCount = 0;

beforeAll(async () => {
  const values = ['client-1', 'binding-1', 'upstream-state', 'nonce-1', 'verifier-1', 'grant-1'];
  const exchanges: unknown[] = [];
  const provider: Pick<BrowserOidcClient, 'authorizationUrl' | 'exchange'> = {
    authorizationUrl: ({ state }) =>
      Promise.resolve(new URL(`https://idp.example/authorize?state=${state}`)),
    exchange: (request, checks) => {
      exchanges.push({ checks, request });
      return Promise.resolve({ accessToken: 'upstream-token', expiresIn: 300 });
    },
  };
  const oauth = new InMemoryMcpOAuth(CONFIG, provider, {
    now: () => 1_700_000_000_000,
    random: () => values.shift() ?? 'exhausted',
    verifyUpstream: () =>
      Promise.resolve({
        iss: 'https://idp.example',
        sub: 'person-1',
        wbs_groups: ['dev:wbs:read'],
      }),
  });
  const registration = await oauth.response(
    new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/register', {
      body: JSON.stringify({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  );
  const clientId = ((await registration?.json()) as { client_id: string }).client_id;
  const authorization = new URL('https://dev.wbs.bulletpoints.club/mcp/oauth/authorize');
  authorization.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    response_type: 'code',
    scope: 'wbs:read',
    state: 'downstream-state',
  }).toString();
  const started = await oauth.response(new Request(authorization));
  const cookie = started?.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const wrong = await oauth.response(
    new Request(
      'https://dev.wbs.bulletpoints.club/mcp/oauth/callback?code=forged&state=wrong-state',
      { headers: { cookie } },
    ),
  );
  const honest = await oauth.response(
    new Request(
      'https://dev.wbs.bulletpoints.club/mcp/oauth/callback?code=upstream&state=upstream-state',
      { headers: { cookie } },
    ),
  );

  wrongStatus = wrong?.status;
  wrongSetCookie = wrong?.headers.get('set-cookie');
  honestStatus = honest?.status;
  exchangeCount = exchanges.length;
});

test('real MCP wrong-state refusal preserves the honest callback', () => {
  expect(wrongStatus).toBe(400);
  expect(wrongSetCookie).toBeNull();
  expect(honestStatus).toBe(302);
  expect(exchangeCount).toBe(1);
});

test('real MCP callbacks compare equal-length state digests with timingSafeEqual', () => {
  expect(globalThis.timingSafeEqualCalls).toEqual([
    { leftBytes: 64, rightBytes: 64 },
    { leftBytes: 64, rightBytes: 64 },
  ]);
});
