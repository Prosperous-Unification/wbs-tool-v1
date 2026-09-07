import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import { SCHEDULER_CONTRACT_VERSION } from './contract-version';
import { durationRoundedUp, durationUnits, SOLVER_QUANTUM } from './solver-quantum';
import {
  computeQuantumGoldenCorpus,
  QUANTUM_GOLDEN_CASES,
  type QuantumGoldenResult,
} from './solver-quantum-golden-corpus';

/**
 * The guard `fast-golden-corpus.test.ts` cannot be, for the constant it cannot
 * reach.
 *
 * `SCHEDULER_CONTRACT_VERSION` covers `SOLVER_QUANTUM`, and a change to Fast's
 * semantics without a bump leaves every stale row matching its key for ever.
 * The Fast corpus enforces that for the eight plans it holds **as `schedule()`
 * renders them** — and `schedule.ts` does not import `solver-quantum`, so no
 * case there, existing or added, executes `quantise` at all. Measured: PR 281
 * (`c1d9a40d`, TASK-302) changed `quantise`'s body and the Fast corpus stayed
 * green through it.
 *
 * This file closes that specific gap and claims nothing wider. It is a byte
 * guard over six named slices as `durationUnits` and `durationRoundedUp` render
 * them, and it reddens on a semantic change if and only if that change moves
 * one of the six. Cache-key honesty for anything else stays a human obligation
 * at `contract-version.ts`, exactly as it does next door.
 *
 * **What separates this from hashing the source**, which was the rejected
 * alternative: the last case below is a negative control. A comment-only edit
 * to `solver-quantum.ts` moves no byte here, because these bytes are what the
 * function *did*, not what it looks like. A source hash cannot tell those
 * apart, and a guard that reddens for comments is repaired by regenerating it
 * — which is how a golden corpus stops being evidence.
 */

interface StoredCorpus {
  readonly contractVersion: number;
  readonly cases: Record<string, QuantumGoldenResult>;
}

const STORED = JSON.parse(
  readFileSync(new URL('../fixtures/solver-quantum-golden-corpus.json', import.meta.url), 'utf8'),
) as StoredCorpus;

describe('the quantum golden corpus keys itself on the contract version', () => {
  it('was produced under the version this tree declares', () => {
    expect(STORED.contractVersion).toBe(SCHEDULER_CONTRACT_VERSION);
  });

  it('reproduces every stored quantisation byte for byte', () => {
    expect(computeQuantumGoldenCorpus().cases).toEqual(STORED.cases);
  });

  it('stores exactly the cases this tree defines, so a new case cannot skip the file', () => {
    expect(Object.keys(STORED.cases).sort()).toEqual(
      QUANTUM_GOLDEN_CASES.map((each) => each.name).sort(),
    );
  });
});

/**
 * The corpus is only a guard if it stored something. A serializer that wrote
 * six empty objects would satisfy `toEqual` against a compute function with the
 * same bug and pass against every possible `quantise` — the
 * check-that-cannot-fail failure AGENTS.md R5 names. These read the values the
 * guard depends on rather than trusting the shape.
 */
describe('the stored bytes are the quantisation, not an empty object', () => {
  it('carries a finite unit count and a rounding flag for every case', () => {
    expect(Object.keys(STORED.cases)).toHaveLength(6);
    for (const stored of Object.values(STORED.cases)) {
      expect(Number.isInteger(stored.units)).toBe(true);
      expect(typeof stored.rounded).toBe('boolean');
    }
  });

  /**
   * WATCHED RED, and it is the one this whole file was filed for. Replay PR
   * 281 by dropping the inner snap — `snapWorkdays(durationOf(slice) *
   * SOLVER_QUANTUM)`, the arrangement that shipped before `c1d9a40d` — and
   * `drift-above-a-whole-workday` moves from `{ units: 48, rounded: false }` to
   * `{ units: 49, rounded: true }`, so `reproduces every stored quantisation
   * byte for byte` fails. Under the same edit the Fast corpus stays green, and
   * that is the measured contrast the two files exist to draw.
   *
   * The numbers are asserted here as well as stored, so the red names the
   * behaviour rather than only reporting that two objects differ.
   */
  it('pins the drift case at a whole day, which is what PR 281 changed', () => {
    expect(STORED.cases['drift-above-a-whole-workday']).toEqual({
      units: SOLVER_QUANTUM,
      rounded: false,
    });
  });

  /**
   * The input has to stay inside the band or the case above proves nothing: an
   * offset at or below `DRIFT / SOLVER_QUANTUM` is cleaned by the surviving
   * post-multiplication snap even without the inner one, and an offset at or
   * above `DRIFT` is not cleaned by either. Only strictly between them do the
   * two arrangements of `quantise` disagree.
   *
   * `DRIFT` is private to `workday.ts`, so its value is restated as a literal
   * rather than imported — which is the right way round here. A band computed
   * from the constant it is testing would follow that constant if somebody
   * widened it, and this assertion would go on passing while the case below it
   * quietly stopped being a red.
   */
  it('keeps that input strictly between the two snaps, or the red above is not a red', () => {
    const DRIFT = 1e-9;
    const drift = QUANTUM_GOLDEN_CASES[0];
    expect(drift.name).toBe('drift-above-a-whole-workday');

    const days = drift.slice.days ?? 0;
    const offset = days - Math.round(days);
    expect(offset).toBeGreaterThan(DRIFT / SOLVER_QUANTUM);
    expect(offset).toBeLessThan(DRIFT);

    // And the arrangement PR 281 removed, computed inline, does land one unit
    // higher — so the stored 48 is a choice this tree made rather than the only
    // number the input could produce.
    const withoutTheInnerSnap = days * SOLVER_QUANTUM;
    expect(Math.ceil(withoutTheInnerSnap)).toBe(SOLVER_QUANTUM + 1);
    expect(durationUnits(drift.slice)).toBe(SOLVER_QUANTUM);
    expect(durationRoundedUp(drift.slice)).toBe(false);
  });
});
