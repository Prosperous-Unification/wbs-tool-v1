import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const PREFLIGHT = join(import.meta.dir, '../../../bin/dev-mcp-preflight.sh');
const VALID_ENV = [
  'PORT=3300',
  'MCP_AUTH_MODE=standalone',
  'WBS_API_URL=http://localhost:3100',
  'MCP_PUBLIC_URL=https://dev.wbs.bulletpoints.club/mcp',
].join('\n');

async function runPreflight(
  envContents: string | undefined,
  exposureContents?: string,
): Promise<{ exitCode: number; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'wbs-mcp-preflight-'));
  const envPath = join(directory, '.env');
  const exposurePath = join(directory, 'exposure');
  if (envContents !== undefined) {
    await writeFile(envPath, envContents, { mode: 0o600 });
  }
  if (exposureContents !== undefined) {
    await writeFile(exposurePath, exposureContents, { mode: 0o600 });
  }
  const child = Bun.spawn(['bash', PREFLIGHT, envPath, exposurePath], {
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

describe('dev MCP preflight', () => {
  // Proof: omitting this pre-snapshot check lets the first deployment copy an
  // old sync.ts that knows nothing about mcp-01, then move the checkout.
  it('refuses a missing or incomplete MCP environment before deployment', async () => {
    const missing = await runPreflight(undefined);
    const incomplete = await runPreflight(
      'PORT=3300\nMCP_AUTH_MODE=standalone\nWBS_API_URL=http://localhost:3100\n',
    );

    expect(missing.exitCode).not.toBe(0);
    expect(missing.output).toContain('missing MCP environment');
    expect(incomplete.exitCode).not.toBe(0);
    expect(incomplete.output).toContain('missing required MCP_PUBLIC_URL');
  });

  it('refuses an MCP environment whose permissions expose deployment settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wbs-mcp-mode-'));
    const envPath = join(directory, '.env');
    const exposurePath = join(directory, 'exposure');
    await writeFile(envPath, VALID_ENV);
    await chmod(envPath, 0o644);
    const child = Bun.spawn(['bash', PREFLIGHT, envPath, exposurePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('mode 600');
  });

  // Proof: treating a missing marker as the permanent default makes every
  // post-cutover deploy skip MCP while still reporting the environment healthy.
  it('prints persistent exposure state and refuses malformed state', async () => {
    const beforeCutover = await runPreflight(VALID_ENV);
    const afterCutover = await runPreflight(VALID_ENV, 'enabled\n');
    const malformed = await runPreflight(VALID_ENV, 'maybe\n');

    expect(beforeCutover).toEqual({ exitCode: 0, output: '0\n' });
    expect(afterCutover).toEqual({ exitCode: 0, output: '1\n' });
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.output).toContain('malformed MCP exposure state');
  });
});
