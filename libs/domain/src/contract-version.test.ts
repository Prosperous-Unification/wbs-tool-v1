import { describe, expect, it } from 'bun:test';

import { contractVersionOf, SCHEDULER_CONTRACT_VERSION } from './contract-version';

/**
 * Task 1.5's remaining clause: the composite is built in **one** place.
 *
 * `"<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"` was written as a template
 * literal at the request builder, and the cache key receives the same string
 * from a composition root. Two writes of one format, separated by a library
 * boundary, is a silent failure by construction: a character of difference
 * makes every cache read miss forever, nothing throws, and no test fails — the
 * plan simply never gets a cached answer and looks slow rather than broken.
 */
describe('the composite the wire carries and the cache key stores', () => {
  it('joins both halves with the single plus the wire schema allows', () => {
    expect(contractVersionOf('0.1.0')).toBe(`${String(SCHEDULER_CONTRACT_VERSION)}+0.1.0`);
    // Both golden requests are checked in carrying this prefix, and
    // `wire-contract-version.test.ts` pins the constant to it from the other
    // side — so the literal here is a second net rather than a duplicate.
    expect(contractVersionOf('0.1.0').startsWith('8+')).toBe(true);
  });

  it('never invents a solver version, however empty the one it is handed', () => {
    // Watched red: default `solverVersion` to a placeholder and this comes back
    // `'8+0.0.0'` — a cache key naming a solver that did not run, which is
    // exactly the row a release must not read.
    expect(contractVersionOf('')).toBe('8+');
  });
});
