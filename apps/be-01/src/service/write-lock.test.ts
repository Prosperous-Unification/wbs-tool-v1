import { describe, expect, it } from 'bun:test';

import { WriteLock } from './write-lock';

const tick = (): Promise<void> => new Promise((resume) => setTimeout(resume, 0));

describe('the write lock', () => {
  it('runs one holder at a time, in the order they asked', async () => {
    // Proof: `run` reduced to `return work()`, this failed on `expected
    // [ 'a:in', 'b:in', 'b:out', 'a:out' ] to equal [ 'a:in', 'a:out', 'b:in',
    // 'b:out' ]` — the second holder inside before the first was out, which on
    // one SQLite connection is a write landing inside another's transaction.
    // Watched, 2026-08-29.
    const lock = new WriteLock();
    const trace: string[] = [];
    const holder = (name: string, ticks: number) =>
      lock.run(async () => {
        trace.push(`${name}:in`);
        for (let n = 0; n < ticks; n += 1) await tick();
        trace.push(`${name}:out`);
        return name;
      });
    const [a, b] = await Promise.all([holder('a', 3), holder('b', 0)]);
    expect([a, b]).toEqual(['a', 'b']);
    expect(trace).toEqual(['a:in', 'a:out', 'b:in', 'b:out']);
  });

  it('lets the next holder in after the previous one threw', async () => {
    const lock = new WriteLock();
    let refused: unknown = null;
    try {
      await lock.run(() => Promise.reject(new Error('refused')));
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(Error);
    expect(await lock.run(() => Promise.resolve('next'))).toBe('next');
  });
});
