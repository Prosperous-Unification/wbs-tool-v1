import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import { SCHEDULER_CONTRACT_VERSION } from './contract-version';
import { durationOf } from './schedule';
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
 * **It is not a second copy of `solver-quantum.test.ts`.** That file asserts
 * what `quantise` does, including TASK-302's watched reds on this same
 * `1.0000000005` input, and under the replay below two of its cases go red
 * alongside the corpus. The difference is what a *deliberate* change costs. A
 * commit that means to change `quantise` edits those assertions to the new
 * numbers and the suite is green — correctly, because that is how a behaviour
 * test is changed. Here the only route to green is to run
 * `write-solver-quantum-golden-corpus.ts` and read a diff of the numbers that
 * moved, next to a stored `contractVersion` the change is supposed to move too.
 *
 * **That is a forced reading, not a forced bump, and the difference matters
 * enough to say** (peer review `queue/reviews/t323-r2-sol.md`, Critical 1). The
 * writer emits the *current* constant beside the *current* cases, so
 * regenerating without bumping is green. `fast-golden-corpus.ts` has the same
 * limit. What both files buy is that the change cannot be silent; the bump
 * itself is still the human obligation `contract-version.ts` documents, and a
 * mechanical version of it needs a check against the merge base, filed
 * separately.
 *
 * **What separates this from hashing the source**, which was the rejected
 * alternative, and it is measured rather than asserted because no test inside a
 * suite can edit its own file's comments. NEGATIVE CONTROL, h2puni at
 * `e38a775a`: two comment lines added to `solver-quantum.ts` above
 * `SOLVER_QUANTUM` — `git diff --stat` 1 file, 2 insertions, no other line —
 * and domain came back **581 pass / 0 fail**, identical to the untouched
 * baseline. A source hash reddens there, and the only repair for that red is
 * regeneration, which is how a golden corpus stops being evidence. These bytes
 * are what the function *did*, not what it looks like.
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
   * **WATCHED RED, MEASURED on h2puni at `e38a775a`, not argued.** Replay PR
   * 281 by dropping the inner snap — `snapWorkdays(durationOf(slice) *
   * SOLVER_QUANTUM)`, the arrangement that shipped before `c1d9a40d` — and
   * `drift-above-a-whole-workday` moves from `{ units: 48, rounded: false }` to
   * `{ units: 49, rounded: true }`. Domain goes **577 pass / 4 fail**: this
   * describe block's two, plus TASK-302's own two in `solver-quantum.test.ts`.
   *
   * **`the Fast golden corpus … reproduces every stored schedule byte for byte`
   * is NOT among them**, and that absence is the measurement this file exists
   * for. Green baseline at the same head with the fixture in place: 581 pass /
   * 0 fail.
   *
   * The other direction is proved too: with `SCHEDULER_CONTRACT_VERSION` moved
   * to 9 and the fixture left alone, `was produced under the version this tree
   * declares` fails here and in the Fast corpus (577/4 again, the other two
   * being `contractVersionOf`'s). So a bump cannot land without regenerating,
   * and a behaviour change cannot land without somebody running the writer.
   * Neither red forces the bump itself — see the header.
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
   * offset strictly below `DRIFT / SOLVER_QUANTUM` is cleaned by the surviving
   * post-multiplication snap even without the inner one, and an offset at or
   * above `DRIFT` is cleaned by neither. The interval is therefore CLOSED at its
   * lower end — `snapWorkdays` compares with a strict `<`, so an offset of
   * exactly `DRIFT / SOLVER_QUANTUM` multiplies to a distance of exactly `DRIFT`
   * and is not cleaned — and open at its upper. The first draft had both ends
   * the other way round (peer review, Important 2).
   *
   * `DRIFT` is private to `workday.ts`, so its value is restated as a literal
   * rather than imported — which is the right way round here. A band computed
   * from the constant it is testing would follow that constant if somebody
   * widened it, and this assertion would go on passing while the case below it
   * quietly stopped being a red.
   */
  it('keeps that input inside the band between the two snaps, or the red above is not a red', () => {
    const DRIFT = 1e-9;
    const drift = QUANTUM_GOLDEN_CASES[0];
    expect(drift.name).toBe('drift-above-a-whole-workday');

    // Read the duration `quantise` actually receives, NOT `slice.days`. They
    // are equal here only because this case's width is 1, and reading `days`
    // was a real hole: widen the width to `1 + BELOW_DRIFT` and the real
    // duration becomes exactly 1, so old and new `quantise` agree and the
    // fixture stops moving — while a `days`-based check would go on passing and
    // report a red that no longer exists (peer review, Important 1).
    const workdays = durationOf(drift.slice);
    const offset = workdays - Math.round(workdays);
    expect(offset).toBeGreaterThanOrEqual(DRIFT / SOLVER_QUANTUM);
    expect(offset).toBeLessThan(DRIFT);

    // And the arrangement PR 281 removed — the surviving outer snap applied to
    // the product, which is all the old code did — does land one unit higher,
    // so the stored 48 is a choice this tree made rather than the only number
    // the input could produce.
    const product = workdays * SOLVER_QUANTUM;
    const outerSnapAlone =
      Math.abs(product - Math.round(product)) < DRIFT ? Math.round(product) : product;
    expect(Math.ceil(outerSnapAlone)).toBe(SOLVER_QUANTUM + 1);
    expect(durationUnits(drift.slice)).toBe(SOLVER_QUANTUM);
    expect(durationRoundedUp(drift.slice)).toBe(false);
  });
});
