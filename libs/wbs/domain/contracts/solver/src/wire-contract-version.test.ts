import { readFileSync } from 'node:fs';

import { SCHEDULER_CONTRACT_VERSION } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import type { SolverRequest } from './wire-types';

/**
 * The pin between `SCHEDULER_CONTRACT_VERSION` and the corpus that already
 * spends it.
 *
 * Both request fixtures carry `"9+0.1.3"`, so a domain or solver bump that
 * forgets the corpus makes every one of them wrong. They were checked in at
 * `"7+0.1.0"` before the constant existed, and this test is what has moved them
 * with it since. Written as a
 * test rather than as a comment in either file because the two are edited by
 * different chunks for different reasons: a bump that forgets the corpus, or a
 * corpus rewritten against a remembered number, are the same defect and neither
 * is visible from inside the file that changed.
 *
 * It is a **prefix** check, deliberately. The suffix is `solverVersion`, which
 * is the Python package's and moves on its own; asserting the whole string would
 * make every solver release a domain test failure.
 *
 * What this does NOT check: that a change to Fast semantics was accompanied by a
 * bump. Nothing here can see `ASSUMED_SLICE_WORKDAYS` move. That is task 1.6's
 * corpus re-key, and reading this test as that guard is the mistake worth
 * naming.
 */
const requestFixtures = ['valid-two-slices.json', 'valid-quantised-baseline.json'];

describe('SCHEDULER_CONTRACT_VERSION and the golden requests', () => {
  it('enumerates fixtures that exist', () => {
    // A pin whose subjects were renamed away would otherwise pass silently.
    expect(requestFixtures.length).toBeGreaterThan(1);
  });

  for (const file of requestFixtures) {
    it(`prefixes ${file}'s contractVersion`, () => {
      const request = JSON.parse(
        readFileSync(new URL(`../fixtures/request/${file}`, import.meta.url), 'utf8'),
      ) as SolverRequest;
      expect(request.contractVersion.startsWith(`${String(SCHEDULER_CONTRACT_VERSION)}+`)).toBe(
        true,
      );
      // And the suffix is a solver version rather than an empty tail: a
      // `startsWith` alone accepts `"7+"`, which names no solver at all.
      const suffix = request.contractVersion.slice(`${String(SCHEDULER_CONTRACT_VERSION)}+`.length);
      expect(suffix).not.toBe('');
    });
  }
});
