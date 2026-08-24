import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { TokenVerifier } from '@wbs/auth';

import { authenticateCaller } from './caller-auth';
import type { McpConfig } from './config';

const HEALTH_PATHS = new Set(['/health/liveness', '/health/readiness', '/health/alb-readiness']);
const MCP_SCOPES = ['wbs:read', 'wbs:write', 'wbs:editor'] as const;

export function healthResponse(url: URL): Response | undefined {
  return HEALTH_PATHS.has(url.pathname) ? Response.json({ status: 'ok' }) : undefined;
}

/**
 * Public RFC 9728 resource metadata and RFC 8414 authorization-server metadata.
 *
 * The URLs derive only from `MCP_PUBLIC_URL`, never the request Host: reverse
 * proxies are allowed to rewrite Host and an attacker-controlled value must not
 * become an advertised OAuth issuer. Both RFC 9728 discovery locations are
 * served because MCP clients may begin with the origin or the `/mcp` resource.
 */
export function oauthMetadataResponse(url: URL, config: McpConfig): Response | undefined {
  const resource = new URL(config.MCP_PUBLIC_URL);
  const resourcePath = resource.pathname.replace(/\/$/, '');
  const resourceUrl = `${resource.origin}${resourcePath}`;
  const issuer = `${resourceUrl}/oauth`;
  const protectedResourcePaths = new Set([
    '/.well-known/oauth-protected-resource',
    `/.well-known/oauth-protected-resource${resourcePath}`,
  ]);

  if (protectedResourcePaths.has(url.pathname)) {
    return Response.json({
      resource: resourceUrl,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: MCP_SCOPES,
    });
  }

  if (url.pathname === `/.well-known/oauth-authorization-server${resourcePath}/oauth`) {
    return Response.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      registration_endpoint: `${issuer}/register`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: MCP_SCOPES,
    });
  }

  return undefined;
}

interface HttpTransport {
  handleRequest(request: Request, options: { readonly authInfo: AuthInfo }): Promise<Response>;
}

export interface McpOAuthHandler {
  response(request: Request): Promise<Response | undefined>;
}

/** Handles one public mcp-01 HTTP request before Bun owns the socket. */
export async function mcpHttpResponse(
  request: Request,
  config: McpConfig,
  verifier: TokenVerifier,
  transport: HttpTransport,
  env: Readonly<Record<string, string | undefined>> = process.env,
  oauth?: McpOAuthHandler,
): Promise<Response> {
  const url = new URL(request.url);
  const metadata = oauthMetadataResponse(url, config);
  if (metadata !== undefined) return metadata;
  const health = healthResponse(url);
  if (health !== undefined) return health;
  const oauthResponse = await oauth?.response(request);
  if (oauthResponse !== undefined) return oauthResponse;
  if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });

  const groupPrefix = env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
  const groupsClaim = env['AUTH_GROUPS_CLAIM'] ?? 'wbs_groups';
  let authInfo;
  try {
    authInfo = await authenticateCaller(
      request.headers.get('authorization'),
      config.MCP_AUTH_MODE,
      verifier,
      groupPrefix,
      groupsClaim,
    );
  } catch {
    const resource = new URL(config.MCP_PUBLIC_URL);
    const resourceMetadata = new URL('/.well-known/oauth-protected-resource', resource);
    return Response.json(
      { error: 'unauthorized' },
      {
        status: 401,
        headers: {
          'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata.href}"`,
        },
      },
    );
  }
  return await transport.handleRequest(request, { authInfo });
}

/** Connects the MCP server to a stateless Streamable HTTP endpoint. */
export async function startHttpServer(
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level Server preserves OpenAPI-derived schemas; see createServer.
  server: Server,
  config: McpConfig,
  verifier: TokenVerifier,
  env: Readonly<Record<string, string | undefined>> = process.env,
  oauth?: McpOAuthHandler,
): Promise<ReturnType<typeof Bun.serve>> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  const port = Number(env['PORT'] ?? '3300');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return Bun.serve({
    port,
    fetch: (request) => mcpHttpResponse(request, config, verifier, transport, env, oauth),
  });
}
