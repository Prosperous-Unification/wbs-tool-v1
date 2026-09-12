import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { scratchSync } from './index';

const HELPER = join(import.meta.dir, 'index.ts');
const PRELOAD = join(import.meta.dir, 'preload.ts');

function childSource(ending: 'failure' | 'signal'): string {
  const finish =
    ending === 'failure'
      ? `throw new Error('deliberate failure');`
      : `await new Promise(() => {});`;
  return `
    import { test } from 'bun:test';
    import { scratchSync } from ${JSON.stringify(HELPER)};
    test('cleanup control', async () => {
      const directory = scratchSync('cleanup-proof-');
      process.stdout.write('SCRATCH_DIRECTORY=' + directory + '\\n');
      ${finish}
    });
  `;
}

function childTest(ending: 'failure' | 'signal'): string {
  const directory = scratchSync('scratch-control-');
  const file = join(directory, `${ending}.test.ts`);
  writeFileSync(file, childSource(ending));
  return file;
}

function scratchDirectory(output: string): string {
  const match = /^SCRATCH_DIRECTORY=(.+)$/m.exec(output);
  if (match === null) throw new Error('child exited without its scratch path');
  return match[1].trim();
}

async function readScratchDirectory(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw new Error('child exited without its scratch path');
      output += decoder.decode(next.value, { stream: true });
      const match = /^SCRATCH_DIRECTORY=(.+)$/m.exec(output);
      if (match !== null) return match[1].trim();
    }
  } finally {
    reader.releaseLock();
  }
}

describe('per-process test scratch', () => {
  it('removes its root when a test process fails', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--preload', PRELOAD, childTest('failure')],
      {
        stdout: 'pipe',
        stderr: 'ignore',
      },
    );
    const output = new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0);
    const directory = scratchDirectory(await output);
    expect(existsSync(directory)).toBe(false);
  });

  it('removes its root and preserves signal termination', async () => {
    const child = Bun.spawn([process.execPath, 'test', '--preload', PRELOAD, childTest('signal')], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const directory = await readScratchDirectory(child.stdout);
    child.kill('SIGTERM');
    expect(await child.exited).not.toBe(0);
    // The signal itself, not merely a non-zero exit. `preserves signal
    // termination` is the whole claim of the handler's re-raise, and
    // `not.toBe(0)` cannot see it: replacing the re-raise with
    // `process.exit(1)` leaves the root removed and the exit non-zero, so the
    // case stayed green while the guarantee was gone. Measured: with the
    // re-raise, `{exited: 143, exitCode: null, signalCode: 'SIGTERM'}`; with
    // `process.exit(1)`, `{exited: 1, exitCode: 1, signalCode: null}`.
    // Proof: watched failing on `Expected: "SIGTERM" · Received: null`.
    expect(child.signalCode).toBe('SIGTERM');
    expect(existsSync(directory)).toBe(false);
  });

  it('removes its root from a plain Bun process, where no preload hook runs', async () => {
    // External consumers run `bun test --preload ../test/scratch/preload.ts`,
    // and that preload's `afterAll` removes the root under their gates. So
    // `process.on('exit', removeProcessRoot)` in the helper had no call path any
    // test could see: deleting it left the preload-owning cases green. This is
    // the path it is actually for — a plain `bun <script>`, no test runner and
    // no preload, which is what any future consumer that forgets the preload gets.
    // Proof: watched failing on `expect(received).toBe(expected) · Expected:
    // false · Received: true`, the root surviving, with the exit hook removed.
    const directory = scratchSync('scratch-plain-');
    const script = join(directory, 'plain.ts');
    writeFileSync(
      script,
      `
        import { scratchSync } from ${JSON.stringify(HELPER)};
        const made = scratchSync('plain-proof-');
        process.stdout.write('SCRATCH_DIRECTORY=' + made + '\\n');
        throw new Error('deliberate failure');
      `,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'ignore' });
    const output = new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0);
    expect(existsSync(scratchDirectory(await output))).toBe(false);
  });
});
