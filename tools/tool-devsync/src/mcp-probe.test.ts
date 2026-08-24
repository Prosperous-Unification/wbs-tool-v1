import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const PROBE = join(import.meta.dir, '../../../bin/dev-mcp-probe.sh');
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop(true)));
});

function metadataServer(challengeResource = 'correct'): Bun.Server<undefined> {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname === '/.well-known/oauth-protected-resource') {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/mcp/oauth`],
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server/mcp/oauth') {
        return Response.json({
          issuer: `${origin}/mcp/oauth`,
          authorization_endpoint: `${origin}/mcp/oauth/authorize`,
          token_endpoint: `${origin}/mcp/oauth/token`,
          registration_endpoint: `${origin}/mcp/oauth/register`,
          jwks_uri: `${origin}/mcp/oauth/jwks`,
        });
      }
      if (url.pathname === '/mcp' && request.method === 'POST') {
        const resource =
          challengeResource === 'correct'
            ? `${origin}/.well-known/oauth-protected-resource`
            : `${origin}/wrong`;
        return new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resource}"` },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return server;
}

async function runProbe(origin: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bash', PROBE, origin], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

describe('dev MCP deployment probe', () => {
  it('accepts exact metadata and the canonical unauthenticated challenge', async () => {
    const server = metadataServer();
    const result = await runProbe(`http://127.0.0.1:${String(server.port)}`);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('MCP discovery and challenge');
  });

  it('rejects a 401 challenge that names the wrong metadata resource', async () => {
    const server = metadataServer('wrong');
    const result = await runProbe(`http://127.0.0.1:${String(server.port)}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('unexpected MCP challenge');
  });
});
