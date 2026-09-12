import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSync } from '@wbs/tool-test-scratch';
import { afterEach, describe, expect, it } from 'bun:test';

const GATE = join(import.meta.dir, '../../../bin/assert-no-prod-release.sh');
const trees: string[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) {
    // Restore anything a case made unreadable, or the cleanup cannot descend.
    try {
      chmodSync(tree, 0o755);
      chmodSync(join(tree, 'state'), 0o755);
    } catch {
      // The case may not have created a state dir at all; the rm below is what
      // has to succeed, and it reports its own failure.
    }
    rmSync(tree, { recursive: true, force: true });
  }
});

/** A fresh tree with a `state` directory, plus whatever tier files are asked for. */
function stateDir(files: Record<string, string> = {}): string {
  const tree = scratchSync('prod-release-gate-');
  trees.push(tree);
  const dir = join(tree, 'state');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

async function runGate(dir: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bash', GATE, dir], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

const DEPLOYED_BE = JSON.stringify({
  tier: 'be',
  activeColor: 'blue',
  lastDeployedSha: 'abc1234',
});

describe('assert-no-prod-release', () => {
  it('passes on a never-deployed state', async () => {
    const result = await runGate(stateDir());

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('nothing is deployed');
  });

  // Proof: the `for tier` loop's `printf`/`exit 1` replaced by a `continue`,
  // watched failing here on `expected 0 not to be 0` — the gate passed with
  // `be.json` naming blue. Observed 2026-08-31.
  it('refuses a recorded colour', async () => {
    const result = await runGate(stateDir({ 'be.json': DEPLOYED_BE }));

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('records a deployed release');
    // The refusal has to name the change that IS safe, or the operator's only
    // options are to guess or to force it.
    expect(result.output).toContain('expand');
    expect(result.output).toContain('contract');
  });

  // The tier the swap touches last must not be a blind spot: the loop refuses
  // on any of the three, not only on `be`.
  it('refuses a recorded colour on a tier other than be', async () => {
    const result = await runGate(
      stateDir({ 'fe.json': JSON.stringify({ tier: 'fe', activeColor: 'green' }) }),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('fe.json');
  });

  // Proof: R5's exact recurring fault. The `[ ! -r "$state_file" ]` arm
  // replaced by `state=$(cat "$state_file" 2>/dev/null || echo '')` and a skip
  // on an empty read, watched failing here on `expected 0 not to be 0` — an
  // unreadable state file passed the gate as never-deployed, which is what
  // `swap.js`'s `readRecordedColor` shipped on 2026-08-05. Observed 2026-08-31.
  it('refuses an unreadable state file', async () => {
    const dir = stateDir({ 'be.json': DEPLOYED_BE });
    chmodSync(join(dir, 'be.json'), 0o000);

    const result = await runGate(dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('could not be read');
    expect(result.output).not.toContain('nothing is deployed');
  });

  // Proof: `[ ! -d "$STATE_DIR" ]` replaced by an `exit 0`, watched failing
  // here on `expected 0 not to be 0`. A path that does not exist is evidence
  // the gate was pointed somewhere wrong, never evidence that prod is empty.
  it('refuses a missing state directory', async () => {
    const dir = join(stateDir(), 'not-here');

    const result = await runGate(dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('not a readable state directory');
  });

  it('refuses a state directory it cannot list', async () => {
    const dir = stateDir({ 'be.json': DEPLOYED_BE });
    chmodSync(dir, 0o000);

    const result = await runGate(dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain('nothing is deployed');
  });

  it('refuses when no state directory is named at all', async () => {
    const child = Bun.spawn(['bash', GATE], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('usage');
  });
});
