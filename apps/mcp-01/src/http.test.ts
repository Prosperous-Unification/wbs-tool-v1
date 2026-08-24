import { describe, expect, it } from 'bun:test';

import type { McpConfig } from './config';
import { healthResponse, mcpHttpResponse, oauthMetadataResponse } from './http';

describe('healthResponse', () => {
  // Proof: deleting any probe branch made its expected response undefined.
  it('exposes liveness, readiness, and ALB readiness separately', async () => {
    for (const path of ['/health/liveness', '/health/readiness', '/health/alb-readiness']) {
      const response = healthResponse(new URL(`https://mcp.example${path}`));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ status: 'ok' });
    }
    expect(healthResponse(new URL('https://mcp.example/mcp'))).toBeUndefined();
  });
});

const CONFIG: McpConfig = {
  MCP_AUTH_MODE: 'standalone',
  WBS_API_URL: 'https://dev.wbs.bulletpoints.club',
  MCP_PUBLIC_URL: 'https://dev.wbs.bulletpoints.club/mcp',
};

describe('oauthMetadataResponse', () => {
  // Proof: removing either metadata route makes the corresponding response
  // undefined, so an MCP client cannot discover the authorization flow.
  it('publishes RFC 9728 protected-resource metadata at the MCP discovery path', async () => {
    const response = oauthMetadataResponse(
      new URL('https://dev.wbs.bulletpoints.club/.well-known/oauth-protected-resource'),
      CONFIG,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      resource: 'https://dev.wbs.bulletpoints.club/mcp',
      authorization_servers: ['https://dev.wbs.bulletpoints.club/mcp/oauth'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['wbs:read', 'wbs:write', 'wbs:editor'],
    });
  });

  it('publishes RFC 8414 metadata for a PKCE authorization-code server', async () => {
    const response = oauthMetadataResponse(
      new URL('https://dev.wbs.bulletpoints.club/.well-known/oauth-authorization-server/mcp/oauth'),
      CONFIG,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      issuer: 'https://dev.wbs.bulletpoints.club/mcp/oauth',
      authorization_endpoint: 'https://dev.wbs.bulletpoints.club/mcp/oauth/authorize',
      token_endpoint: 'https://dev.wbs.bulletpoints.club/mcp/oauth/token',
      revocation_endpoint: 'https://dev.wbs.bulletpoints.club/mcp/oauth/revoke',
      registration_endpoint: 'https://dev.wbs.bulletpoints.club/mcp/oauth/register',
      jwks_uri: 'https://dev.wbs.bulletpoints.club/mcp/oauth/jwks',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['wbs:read', 'wbs:write', 'wbs:editor'],
    });
  });

  it('does not answer metadata on a lookalike path', () => {
    expect(
      oauthMetadataResponse(
        new URL('https://dev.wbs.bulletpoints.club/.well-known/oauth-protected-resource.evil'),
        CONFIG,
      ),
    ).toBeUndefined();
  });
});

describe('mcpHttpResponse', () => {
  // Proof: returning the old bare 401 from the production handler removes this
  // header and prevents an MCP client from locating resource metadata.
  it('challenges an unauthenticated MCP caller with the RFC 9728 metadata URL', async () => {
    const response = await mcpHttpResponse(
      new Request('https://dev.wbs.bulletpoints.club/mcp'),
      CONFIG,
      { verify: () => Promise.reject(new Error('must not verify a missing credential')) },
      { handleRequest: () => Promise.reject(new Error('must not reach the transport')) },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://dev.wbs.bulletpoints.club/.well-known/oauth-protected-resource"',
    );
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  // Proof: omitting OAuth endpoint dispatch leaves DCR at the old 404 boundary.
  it('dispatches fronting authorization-server requests before MCP auth', async () => {
    const response = await mcpHttpResponse(
      new Request('https://dev.wbs.bulletpoints.club/mcp/oauth/register', { method: 'POST' }),
      CONFIG,
      { verify: () => Promise.reject(new Error('must not verify a DCR request')) },
      { handleRequest: () => Promise.reject(new Error('must not reach the transport')) },
      process.env,
      {
        response: () =>
          Promise.resolve(Response.json({ client_id: 'dynamic-client' }, { status: 201 })),
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ client_id: 'dynamic-client' });
  });
});
