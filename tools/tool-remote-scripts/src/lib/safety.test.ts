import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSync } from '@wbs/tool-test-scratch';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { writeAtomic } from './atomic';
import { describeHolder, type LockHolder, withLock } from './lock';
import { readPhase, writePhase } from './phase';

let dir: string;
beforeEach(() => {
  dir = scratchSync('wbs-safety-');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeAtomic', () => {
  it('writes the full contents', async () => {
    const p = join(dir, 'out.caddy');
    await writeAtomic(p, 'hello');
    expect(readFileSync(p, 'utf8')).toBe('hello');
  });

  it('overwrites an existing file without leaving a temp behind', async () => {
    const p = join(dir, 'out.caddy');
    await writeAtomic(p, 'first');
    await writeAtomic(p, 'second');
    expect(readFileSync(p, 'utf8')).toBe('second');
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  it('produces correct content with fsync', async () => {
    const p = join(dir, 'large.caddy');
    const content = 'x'.repeat(1000000); // 1MB of data
    await writeAtomic(p, content);
    expect(readFileSync(p, 'utf8')).toBe(content);
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  // Item 3(a): the derived secrets file (INTERNAL_AUTH_SECRET, the JWT key)
  // used to be created at the process umask's default, then chmod'd to 0600
  // only AFTER rename — world-readable for a window on every swap, and
  // permanently if the process died between the two calls. Passing `mode`
  // now sets it at the temp file's own creation, before rename, so there is
  // no window at all. A permissive umask (022, "everyone can read") is set
  // explicitly here so the test cannot pass by coincidence of the runner's
  // own umask already being restrictive.
  it('creates the file at the given mode from birth — no window at 0644, with or without a permissive umask', async () => {
    const originalUmask = process.umask(0o022);
    try {
      const p = join(dir, 'be-01.secrets.env');
      await writeAtomic(p, 'INTERNAL_AUTH_SECRET=x\n', 0o600);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(originalUmask);
    }
  });

  it('without a mode, still falls back to the process umask default — non-secret callers unaffected', async () => {
    const originalUmask = process.umask(0o022);
    try {
      const p = join(dir, 'site.caddy');
      await writeAtomic(p, 'import site.caddy\n');
      expect(statSync(p).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(originalUmask);
    }
  });

  it('cleans up temp file on rename failure', async () => {
    const p = join(dir, 'target');
    const tmpPath = `${p}.tmp`;
    // Create a non-empty directory at the destination path so rename will fail with ENOTEMPTY
    mkdirSync(p);
    writeFileSync(join(p, 'existing.txt'), 'file inside');
    // Write and fsync succeed, creating the temp file, but rename fails
    let threw = false;
    try {
      await writeAtomic(p, 'will fail on rename');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Verify temp file was cleaned up by the error handler
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe('withLock', () => {
  it('runs the callback and returns its value', async () => {
    const result = await withLock(join(dir, 'deploy.lock'), () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('refuses a second concurrent holder', async () => {
    const lockPath = join(dir, 'deploy.lock');
    let inner: unknown = null;
    await withLock(lockPath, async () => {
      try {
        await withLock(lockPath, () => Promise.resolve('should not run'));
      } catch (e: unknown) {
        inner = e instanceof Error ? e.message : String(e);
      }
    });
    expect(String(inner)).toMatch(/lock/i);
  });

  it('releases the lock even when the callback throws', async () => {
    const lockPath = join(dir, 'deploy.lock');
    let threw = false;
    try {
      await withLock(lockPath, () => Promise.reject(new Error('boom')));
    } catch (e: unknown) {
      threw = true;
      expect(e instanceof Error && e.message).toBe('boom');
    }
    expect(threw).toBe(true);
    const result = await withLock(lockPath, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  // Decision 10: "Refuse immediately, name the holder." The previous
  // implementation created the file empty, so a refusal could say only that
  // *something* held it.
  it('records the holder (pid, host, ISO timestamp) while the lock is held', async () => {
    const lockPath = join(dir, 'deploy.lock');
    let seen: LockHolder | null = null;
    await withLock(lockPath, () => {
      seen = JSON.parse(readFileSync(lockPath, 'utf8')) as LockHolder;
      return Promise.resolve();
    });
    expect(seen).not.toBeNull();
    const holder = seen as unknown as LockHolder;
    expect(holder.pid).toBe(process.pid);
    expect(holder.host.length).toBeGreaterThan(0);
    expect(new Date(holder.acquiredAt).toISOString()).toBe(holder.acquiredAt);
  });

  it('names the holder in the refusal a second deploy gets', async () => {
    const lockPath = join(dir, 'deploy.lock');
    let message = '';
    await withLock(lockPath, async () => {
      try {
        await withLock(lockPath, () => Promise.resolve('should not run'));
      } catch (e: unknown) {
        message = e instanceof Error ? e.message : String(e);
      }
    });
    expect(message).toContain(`pid ${String(process.pid)}`);
  });

  it('clears the holder record on a clean release, so a corpse is distinguishable', async () => {
    const lockPath = join(dir, 'deploy.lock');
    await withLock(lockPath, () => Promise.resolve());
    expect(readFileSync(lockPath, 'utf8')).toBe('');
  });

  // The exact regression the reviewer reproduced against the O_EXCL
  // implementation: a killed deploy left the file behind and wedged every
  // future deploy with a false "another deploy is running". A flock is owned
  // by the open file description, so the kernel drops it when the dead
  // process's descriptors are closed — including on signals no handler runs
  // for. Driven through a real subprocess because that is the only way to
  // exercise process death.
  const killReleasesLock = async (signal: 'SIGTERM' | 'SIGKILL'): Promise<void> => {
    const lockPath = join(dir, `kill-${signal}.lock`);
    const lockModule = new URL('./lock.ts', import.meta.url).href;
    const script =
      `const { withLock } = await import(${JSON.stringify(lockModule)});\n` +
      `await withLock(${JSON.stringify(lockPath)}, async () => {\n` +
      `  console.log('acquired');\n` +
      `  await new Promise(() => {});\n` +
      `});\n`;
    const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });

    // Wait for the child to actually hold the lock before signalling it.
    const reader = child.stdout.getReader();
    let announced = '';
    while (!announced.includes('acquired')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`child exited before acquiring the lock: ${announced}`);
      announced += new TextDecoder().decode(value);
    }
    // Proves the child really holds it, so the post-kill acquisition below
    // cannot pass vacuously.
    let refused = '';
    try {
      await withLock(lockPath, () => Promise.resolve('should not run'));
    } catch (e: unknown) {
      refused = e instanceof Error ? e.message : String(e);
    }
    expect(refused).toMatch(/another deploy is running/);
    expect(refused).toContain(`pid ${String(child.pid)}`);

    child.kill(signal);
    await child.exited;

    // The dead holder's record is still on disk — that is the intended
    // "this was killed, here is who died" signal — but it must not stop the
    // next deploy from taking the lock.
    expect(readFileSync(lockPath, 'utf8')).toContain(`"pid": ${String(child.pid)}`);
    expect(await withLock(lockPath, () => Promise.resolve('ok'))).toBe('ok');
  };

  it('releases the lock when the holder is killed with SIGTERM', async () => {
    await killReleasesLock('SIGTERM');
  });

  it('releases the lock when the holder is killed with SIGKILL', async () => {
    await killReleasesLock('SIGKILL');
  });
});

describe('describeHolder', () => {
  it('describes a well-formed record', () => {
    const raw = JSON.stringify({ pid: 42, host: 'h2puni', acquiredAt: '2026-08-02T00:00:00.000Z' });
    expect(describeHolder(raw)).toBe('held by pid 42 on h2puni since 2026-08-02T00:00:00.000Z');
  });

  it('stays useful for an empty file rather than throwing', () => {
    expect(describeHolder('')).toMatch(/empty/);
  });

  it('stays useful for unparseable contents rather than throwing', () => {
    expect(describeHolder('not json')).toMatch(/unrecognised/);
  });
});

describe('phase', () => {
  it('round-trips a phase', async () => {
    const p = join(dir, 'be.phase');
    await writePhase(p, 'routed');
    expect(await readPhase(p)).toBe('routed');
  });

  it('returns null for a missing marker', async () => {
    expect(await readPhase(join(dir, 'nope.phase'))).toBeNull();
  });

  it('rejects an unrecognised phase rather than guessing', async () => {
    await Bun.write(join(dir, 'bad.phase'), 'sideways');
    let threw = false;
    try {
      await readPhase(join(dir, 'bad.phase'));
    } catch (e: unknown) {
      threw = true;
      expect(e instanceof Error && e.message).toMatch(/phase/);
    }
    expect(threw).toBe(true);
  });
});
