import { describe, expect, it } from 'bun:test';

import { certifySourceReport, SOURCE_CONFORMANCE_CASES } from './certification';

describe('source certification coverage', () => {
  it('names the source and every missing case when a kit registration disappears', () => {
    const registered = SOURCE_CONFORMANCE_CASES.slice(3);

    // Proof: deleting the step kit registration from `sourceConformance`
    // failed the real memory-source report on `in-memory certification missing
    // cases: steps.add, steps.rename, steps.rename:unknown`.
    expect(() => {
      certifySourceReport('memory', {
        ran: [...registered],
        skipped: [],
      });
    }).toThrow('memory certification missing cases: steps.add, steps.rename, steps.rename:unknown');
  });
});
