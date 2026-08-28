import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const SCRIPT = join(import.meta.dir, '../../../bin/with-heavy-lock.sh');
const LOCK_LIB = join(import.meta.dir, '../../../bin/heavy-lock-lib.sh');
const roots: string[] = [];

function runWithTestLock(lock: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([
    'bash',
    '-c',
    'source "$1"; shift; with_heavy_lock "$@"',
    'with-heavy-lock-test',
    LOCK_LIB,
    lock,
    '--',
    'bash',
    '-c',
    'exit 0',
  ]);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('with-heavy-lock', () => {
  it('uses one canonical production lock even when callers set different overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-'));
    roots.push(root);
    const fakeBin = join(root, 'bin');
    const capture = join(root, 'flock-argv');
    Bun.spawnSync(['mkdir', '-p', fakeBin]);
    const fakeFlock = join(fakeBin, 'flock');
    writeFileSync(fakeFlock, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$FLOCK_CAPTURE"\n');
    chmodSync(fakeFlock, 0o700);

    const run = Bun.spawnSync(['bash', SCRIPT, '--', 'bash', '-c', 'exit 0'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
        FLOCK_CAPTURE: capture,
        WBS_HEAVY_LOCK: join(root, 'caller-selected.lock'),
      },
    });

    expect(run.exitCode).toBe(0);
    expect(readFileSync(capture, 'utf8').split('\n')).toContain(
      '/home/puni1/.cache/wbs-heavy-work.lock',
    );
    expect(readFileSync(capture, 'utf8')).not.toContain('caller-selected.lock');
  });

  it('runs the requested command while the lock is free', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-'));
    roots.push(root);
    const run = runWithTestLock(join(root, 'heavy.lock'));
    expect(run.exitCode).toBe(0);
  });

  it('refuses immediately with exit 75 while another heavy operation owns the lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-'));
    roots.push(root);
    const lock = join(root, 'heavy.lock');
    const holder = Bun.spawn(['flock', '--exclusive', lock, 'sleep', '2']);
    await Bun.sleep(100);

    const refused = runWithTestLock(lock);
    holder.kill();
    await holder.exited;

    // Proof: this reaches the production wrapper and distinguishes contention
    // from command failure by its dedicated conflict exit code.
    expect(refused.exitCode).toBe(75);
  });
});
