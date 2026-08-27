import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const PROBE = join(import.meta.dir, '../../../bin/dev-be-probe.sh');
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop(true)));
});

function authServer(body: unknown): Bun.Server<undefined> {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/api/auth/me') {
        return Response.json(body, { status: 401 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return server;
}

async function runProbe(origin: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bash', PROBE, origin], {
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

describe('dev be deployment probe', () => {
  it('accepts the canonical anonymous auth response', async () => {
    const server = authServer({ error: 'invalid_token' });

    const result = await runProbe(`http://127.0.0.1:${String(server.port)}`);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('be (auth routes mounted)');
  });

  it('rejects a response that does not match the auth controller contract', async () => {
    const server = authServer({ error: 'missing_token' });

    const result = await runProbe(`http://127.0.0.1:${String(server.port)}`);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL');
  });
});
