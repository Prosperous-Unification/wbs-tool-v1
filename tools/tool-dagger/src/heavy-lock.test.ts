import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const SCRIPT = join(import.meta.dir, '../../../bin/with-heavy-lock.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('with-heavy-lock', () => {
  it('runs the requested command while the lock is free', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-'));
    roots.push(root);
    const run = Bun.spawnSync(['bash', SCRIPT, '--', 'bash', '-c', 'exit 0'], {
      env: { ...process.env, WBS_HEAVY_LOCK: join(root, 'heavy.lock') },
    });
    expect(run.exitCode).toBe(0);
  });

  it('refuses immediately with exit 75 while another heavy operation owns the lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-'));
    roots.push(root);
    const lock = join(root, 'heavy.lock');
    const holder = Bun.spawn(['flock', '--exclusive', lock, 'sleep', '2']);
    await Bun.sleep(100);

    const refused = Bun.spawnSync(['bash', SCRIPT, '--', 'bash', '-c', 'exit 0'], {
      env: { ...process.env, WBS_HEAVY_LOCK: lock },
    });
    holder.kill();
    await holder.exited;

    // Proof: this reaches the production wrapper and distinguishes contention
    // from command failure by its dedicated conflict exit code.
    expect(refused.exitCode).toBe(75);
  });
});
