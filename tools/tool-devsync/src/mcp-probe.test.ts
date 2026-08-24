import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const PROBE = join(import.meta.dir, '../../../bin/dev-mcp-probe.sh');
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop(true)));
});

function metadataServer(
  challengeResource = 'correct',
  nestedResource = 'correct',
  rootFailures = 0,
  authorizationCapabilities = 'correct',
): Bun.Server<undefined> {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      if (
        url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp'
      ) {
        if (url.pathname === '/.well-known/oauth-protected-resource' && rootFailures > 0) {
          rootFailures -= 1;
          return new Response('restarting', { status: 503 });
        }
        return Response.json({
          resource:
            url.pathname.endsWith('/mcp') && nestedResource === 'wrong'
              ? `${origin}/wrong`
              : `${origin}/mcp`,
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
          token_endpoint_auth_methods_supported:
            authorizationCapabilities === 'wrong' ? ['client_secret_basic'] : ['none'],
          code_challenge_methods_supported:
            authorizationCapabilities === 'wrong' ? ['plain'] : ['S256'],
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

async function runProbe(
  origin: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bash', PROBE, origin], {
    env: {
      ...process.env,
      MCP_EXPOSURE_EXPECTED: '1',
      MCP_PROBE_DEADLINE_SECONDS: '0',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
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

  it('rejects a wrong resource at the path-qualified RFC 9728 location', async () => {
    const server = metadataServer('correct', 'wrong');
    const result = await runProbe(`http://127.0.0.1:${String(server.port)}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('unexpected MCP resource');
  });

  it('skips MCP checks until public exposure is explicitly expected', async () => {
    const result = await runProbe('http://127.0.0.1:1', { MCP_EXPOSURE_EXPECTED: '0' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('MCP exposure not expected');
  });

  it('retries the semantic probe within the deployment restart deadline', async () => {
    const server = metadataServer('correct', 'correct', 1);
    const result = await runProbe(`http://127.0.0.1:${String(server.port)}`, {
      MCP_PROBE_DEADLINE_SECONDS: '3',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('MCP discovery and challenge');
  });

  it('rejects authorization metadata that weakens public-client PKCE', async () => {
    const server = metadataServer('correct', 'correct', 0, 'wrong');
    const result = await runProbe(`http://127.0.0.1:${String(server.port)}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('token_endpoint_auth_methods_supported');
  });
});
