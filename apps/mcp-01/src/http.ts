import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { TokenVerifier } from '@wbs/auth';

import { authenticateCaller } from './caller-auth';
import type { McpConfig } from './config';

const HEALTH_PATHS = new Set(['/health/liveness', '/health/readiness', '/health/alb-readiness']);

export function healthResponse(url: URL): Response | undefined {
  return HEALTH_PATHS.has(url.pathname) ? Response.json({ status: 'ok' }) : undefined;
}

/** Connects the MCP server to a stateless Streamable HTTP endpoint. */
export async function startHttpServer(
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level Server preserves OpenAPI-derived schemas; see createServer.
  server: Server,
  config: McpConfig,
  verifier: TokenVerifier,
  env: Readonly<Record<string, string | undefined>> = process.env,
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
  const groupPrefix = env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
  const groupsClaim = env['AUTH_GROUPS_CLAIM'] ?? 'wbs_groups';
  return Bun.serve({
    port,
    fetch: async (request) => {
      const url = new URL(request.url);
      const health = healthResponse(url);
      if (health !== undefined) return health;
      if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
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
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return await transport.handleRequest(request, { authInfo });
    },
  });
}
