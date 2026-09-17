import { join } from 'node:path';

import { expect, test } from 'bun:test';

const PRELOAD = join(import.meta.dir, 'oauth-timing-safe.preload.ts');
const PROOF = join(import.meta.dir, 'oauth-timing-safe.proof.ts');

// Proof: replacing shared sameSecret with direct equality leaves the child's
// wrong-state control green but reports zero primitive calls instead of two.
test('isolated Bun process observes MCP state comparisons at the crypto primitive', async () => {
  const child = Bun.spawn([process.execPath, 'test', '--preload', PRELOAD, PROOF], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  const output = `${await stdout}${await stderr}`;
  if (exitCode !== 0) throw new Error(`isolated timingSafeEqual proof failed:\n${output}`);

  expect(output).toContain('real MCP callbacks compare equal-length state digests');
  expect(output).toContain('2 pass');
});
