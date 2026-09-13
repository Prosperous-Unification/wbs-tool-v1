import { readFileSync } from 'node:fs';

import type { PlannedRow, Slice } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { buildSolverRequest, type SolverRequestPlan } from './build-solver-request';
import { quantisedFastBaseline } from './quantised-baseline';
import { SOLVER_REQUEST_KEYS, SOLVER_SLICE_KEYS, type SolverRequest } from './wire-types';

/**
 * The **request** branch of the golden corpus, run against the assembly that
 * has to produce it — and enumerated out of the manifest, which nothing did.
 *
 * ## What was already checked, and what was not
 *
 * Stated precisely, because "the request branch has no consumer" was the
 * shorthand and it is not true as written. `quantised-baseline.test.ts` reads
 * `valid-quantised-baseline.json` **by name** and checks its `baselineOffsets`,
 * its `slices`, its `edges` and the three cross-field invariants JSON Schema
 * cannot state. What nothing checked is the **whole request through the
 * assembly**: `contractVersion`, `solverVersion`, `objective`, `budgetMs`,
 * `stageBudgetSplit`, `quantum`, `horizonUnits`, `pools` and `fastHint` were
 * checked in by hand and compared with nothing. That is nine of the thirteen
 * members, and it is 2.11's last clause — the request must *carry* the
 * quantised offsets, checked against the golden fixture.
 *
 * The comparison runs in the one direction that matters: the fixture is
 * **bytes on disk**, written against the design before the builder existed, so
 * a builder that agrees with it agrees with something nobody derived from it.
 * Every assertion in `build-solver-request.test.ts` is computed from the same
 * seams the builder calls; this one is not.
 *
 * ## The manifest gap, closed only halfway, and the half is named
 *
 * `parse-solver-response.test.ts` enumerates `branch === 'response'` and
 * nothing enumerated `'request'`, so adding a request fixture to the manifest
 * still got it no reader at all. The enumeration below gives every `valid`
 * request entry the structural pin. It deliberately does **not** claim the
 * `valid: false` entries: refusing them needs a request validator, the request
 * side's validator is the Python entrypoint's `jsonschema` pass (§5), and
 * asserting anything about them here would be a check that cannot fail.
 *
 * ## Why only one of the two valid request fixtures is built here
 *
 * `valid-quantised-baseline.json` is 2.11's own fixture and the manifest says
 * so. `valid-two-slices.json` is a **schema** fixture, and no plan this builder
 * can be handed produces it — measured from `priorityWeights`, not assumed. It
 * carries `priorityWeight` 2 on one slice and 0 on the other. The rank is dense
 * over the distinct priorities of the **whole** canonical input, so a weight of
 * 2 needs two distinct priorities present, while a weight of 0 is `absence`
 * from `priorityByLeaf` and not a low rank. Two leaves cannot supply both: if
 * the second leaf carried the second distinct priority its weight would be 1.
 * So the fixture implies a **third** prioritised leaf, and a third leaf with no
 * slice of its own is one `schedule()` refuses — which means it also has no
 * quantised baseline, and therefore no request. Valid against the schema, which
 * is all its manifest entry claims; not a builder output.
 */

interface ManifestEntry {
  readonly file: string;
  readonly branch: string;
  readonly valid: boolean;
}

const manifest = JSON.parse(
  readFileSync(new URL('../fixtures/manifest.json', import.meta.url), 'utf8'),
) as { readonly fixtures: readonly ManifestEntry[] };

const requestFixtures = manifest.fixtures.filter((entry) => entry.branch === 'request');

const fixture = (file: string): SolverRequest =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8'),
  ) as SolverRequest;

/**
 * 2.11's plan: one leaf, three serial steps, `days: 1` across five people.
 *
 * Real Fast finishes these at 0.6 workdays = 28.8 units, which no CP-SAT
 * variable can hold; each duration rounds up to 10 and the quantised model
 * needs 30. The fixture's `0 / 10 / 20` are the rounded model's, and that
 * difference is the whole reason the baseline is re-derived rather than
 * converted.
 */
const rows: readonly PlannedRow[] = [
  { id: 'A', parentId: null, position: 0, frozenNumber: null, priority: null },
];
const slices: readonly Slice[] = ['one', 'two', 'three'].map((stepId) => ({
  workItemId: 'A',
  stepId,
  days: 1,
  personId: null,
  width: 5,
  poolIds: [],
}));

const plan: SolverRequestPlan = {
  rows,
  edges: [],
  slices,
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
};

/** The request the coordinator would spawn with, for this plan. */
const requestOf = () => {
  const built = buildSolverRequest(plan, 'pri', {
    baselineOffsets: quantisedFastBaseline(
      plan.rows,
      plan.edges,
      plan.slices,
      plan.notBefore,
      plan.poolSizes,
      plan.reach,
    ),
    solverVersion: '0.1.3',
    budgetMs: 30_000,
  });
  if (!built.ok) throw new Error(`expected a request, got ${built.failure}: ${built.detail}`);
  return built.request;
};

describe('the golden request corpus', () => {
  it('is what buildSolverRequest produces, field for field', () => {
    // Deep equality against the file, not against a field list: a builder that
    // dropped `fastHint`, quantised a duration downwards, or wrote real Fast's
    // 9.6 into an offset all fail here, and each of them passes a key-set pin.
    expect(requestOf()).toEqual(fixture('request/valid-quantised-baseline.json'));
  });

  it('rounds the durations up, so the offsets are the model the solver receives', () => {
    // Stated separately from the deep equality because it is the ONE number the
    // fixture exists to hold: real Fast's 9.6 and 19.2 are not values any
    // variable in the request's own model can take.
    const request = requestOf();
    expect(Object.values(request.baselineOffsets)).toEqual([0, 10, 20]);
    expect(request.horizonUnits).toBe(30);
  });

  it('gives every valid request entry a reader, which the manifest did not have', () => {
    // The structural pin only — `SOLVER_REQUEST_KEYS` and `SOLVER_SLICE_KEYS`
    // are what `wire-types.test.ts` holds against the schema member for member.
    // It catches a fixture that has drifted from the request's shape; it does
    // not catch one that has drifted from its value ranges, and the invalid
    // entries are not touched at all, because refusing them needs the Python
    // side's validator.
    const valid = requestFixtures.filter((entry) => entry.valid);
    expect(valid.length).toBeGreaterThan(0);
    for (const entry of valid) {
      const request = fixture(entry.file);
      expect(Object.keys(request).sort()).toEqual([...SOLVER_REQUEST_KEYS].sort());
      for (const slice of request.slices) {
        expect(Object.keys(slice).sort()).toEqual([...SOLVER_SLICE_KEYS].sort());
      }
    }
  });
});
