import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import { SCHEDULER_CONTRACT_VERSION } from './contract-version';
import {
  computeFastGoldenCorpus,
  FAST_GOLDEN_CASES,
  serializeSchedule,
} from './fast-golden-corpus';
import { schedule, ScheduleInvalidOptimizedStartError } from './schedule';

/**
 * Task 1.6(a): the guard that makes the optimized cache key honest.
 *
 * A cached optimized result is keyed on `SCHEDULER_CONTRACT_VERSION`, so a
 * change to Fast's semantics without a bump leaves every stale row matching its
 * key for ever. Nothing enforced that until this file: measured at `09e9ccd7`,
 * moving `ASSUMED_SLICE_WORKDAYS` from 2 to 3 with the version left at 7 gave
 * domain 356/19 and contracts 167/0, and every one of those 19 was a
 * hand-written date assertion — precisely the set a developer updates on
 * purpose when changing the constant. Update them and the suite is green again
 * with the version still 7, and nothing anywhere says "now bump it".
 *
 * The two assertions below close that in both directions. The bytes moving
 * without a bump fails the second; a bump whose bytes were not regenerated
 * fails the first.
 *
 * **What they do not close, and where that is closed instead.** Both compare
 * this tree's fixture against this tree's computation, and
 * `write-fast-golden-corpus.ts` writes the current constant beside the current
 * cases — so regenerating after a semantic change, with the version left where
 * it is, is green here. TASK-338 added CI's `Corpus version lint`
 * (`tools/tool-git-hooks/src/hooks/corpus-version-lint.ts`), which reads this
 * fixture at the change's base revision and at its head and refuses `cases`
 * that moved while `SCHEDULER_CONTRACT_VERSION` did not increase. It is a CI
 * step and not a case here because the question is about two commits and this
 * suite's subject is one tree. It proves the two moved together and not that
 * the bump was made *because* of the change.
 *
 * **What this guard is, and it is narrower than the paragraph above sounds.**
 * It is a value guard over the eight named plans in `FAST_GOLDEN_CASES` **as
 * `schedule()` renders them** — the comparison is `toEqual` over parsed JSON,
 * so what is enforced is every stored value; whitespace and object-key order
 * are deliberately outside this corpus's invariant. File layout is enforced
 * separately by `bunx nx format:check --all` in CI, which does not cover key order
 * because Prettier preserves JSON object-key order. The one case below that
 * genuinely is a string comparison says so in its own name and comment — it
 * stringifies both sides in `FAST_GOLDEN_CASES` order, which is a different
 * check from this one and stays what it was. It reddens a semantic change
 * if and only if that change moves one of those eight schedules. It is not a net
 * under Fast's semantics, and two consequences follow that a reader must not
 * have to derive:
 *
 * - A change that moves an input class the eight plans do not contain is
 *   invisible here. Eight fixed points cannot cover an input space, and adding
 *   a ninth does not change the kind of thing this file is.
 * - **A constant on `contract-version.ts`'s bump list can sit on a code path
 *   this file does not execute at all**, and `SOLVER_QUANTUM` does.
 *   `schedule.ts` does not import `solver-quantum` (its only mentions are prose
 *   at `:583` and `:1271`), so `quantise`/`durationUnits` are unreachable from
 *   every case here. Measured on PR 281 (`c1d9a40d`, TASK-302), which changed
 *   `quantise` so a duration inside `(W, W + DRIFT)` yields one fewer
 *   `durationUnits`: this corpus stayed **green** through it, and would have
 *   stayed green with an in-window fixture too. The bump that change owed was
 *   demanded by a human reading the constant's doc, not by this file.
 *   That guard belongs beside `quantise` itself, keyed on the version the same
 *   way; it does not belong here, because this file cannot see the function.
 *
 * So cache-key honesty for changes this corpus cannot see stays a **human**
 * obligation, documented at `contract-version.ts`. This file is evidence for
 * eight plans, not enforcement for Fast.
 */

interface StoredCorpus {
  readonly contractVersion: number;
  readonly cases: Record<string, unknown>;
}

const STORED = JSON.parse(
  readFileSync(new URL('../fixtures/fast-golden-corpus.json', import.meta.url), 'utf8'),
) as StoredCorpus;

describe('the Fast golden corpus keys itself on the contract version', () => {
  it('was produced under the version this tree declares', () => {
    expect(STORED.contractVersion).toBe(SCHEDULER_CONTRACT_VERSION);
  });

  it('reproduces every stored schedule value for value', () => {
    expect(computeFastGoldenCorpus().cases).toEqual(STORED.cases);
  });

  it('stores exactly the cases this tree defines, so a new case cannot skip the file', () => {
    expect(Object.keys(STORED.cases).sort()).toEqual(
      FAST_GOLDEN_CASES.map((each) => each.name).sort(),
    );
  });
});

/**
 * The corpus is only a guard if it stored something. `Schedule` holds `Map`s and
 * `JSON.stringify` renders a `Map` as `{}`, so a serializer that forgot them
 * would check in four empty objects and pass against every possible engine —
 * the check-that-cannot-fail failure AGENTS.md R5 names. These read the values
 * the guard actually depends on rather than trusting the shape.
 */
describe('the stored bytes are the schedule, not an empty object', () => {
  interface PlacedProbe {
    readonly estimated: boolean;
    readonly earliestStart: number;
    readonly earliestFinish: number;
  }
  const unestimated = STORED.cases['unestimated-middle'] as {
    slices: [string, PlacedProbe][];
  };

  it('carries one entry per slice with its placement on it', () => {
    expect(unestimated.slices).toHaveLength(3);
    for (const [, placed] of unestimated.slices) {
      expect(typeof placed.earliestStart).toBe('number');
      expect(typeof placed.earliestFinish).toBe('number');
    }
  });

  /**
   * The case that can see `ASSUMED_SLICE_WORKDAYS` at all. `b` carries
   * `days: null`, so it reports `duration: 0` and `estimated: false` — nobody
   * has looked — while the pass still spends the assumption on it: it runs
   * 2 → 4, and `c` starts at 4 rather than at 2.
   *
   * WATCHED RED, both halves MEASURED at `112aa297` on h2puni. Move
   * `ASSUMED_SLICE_WORKDAYS` 2 → 3 and leave `SCHEDULER_CONTRACT_VERSION` at 7:
   * domain **360 pass / 20 fail**, where 19 are the pre-existing hand-written
   * date assertions and the twentieth is `reproduces every stored schedule byte
   * for byte` — the only failure in the suite that is about the *key*. Bump the
   * version to 8 without regenerating the fixture: **379 pass / 1 fail**, and
   * that one is `was produced under the version this tree declares`.
   *
   * The three numbers below do NOT fail in either red, and the first draft of
   * this comment claimed they did. They read `STORED`, which neither edit
   * touches. They are a guard on the fixture rather than on the engine: they
   * are what stops a regenerated corpus of four empty objects from satisfying
   * the byte comparison.
   */
  it('spends the assumed duration on the slice nobody estimated', () => {
    const [, b] = unestimated.slices[1];
    const [, c] = unestimated.slices[2];
    expect(b.estimated).toBe(false);
    expect(b.earliestStart).toBe(2);
    expect(b.earliestFinish).toBe(4);
    expect(c.earliestStart).toBe(4);
  });
});

/**
 * Task 4.3, and task 1.6(c) before it: **the no-op proof**. "With the seventh
 * argument defaulted to an empty map, every existing corpus case SHALL produce
 * a byte-identical schedule" — the seam must not be able to hide a placement
 * change smuggled in with it.
 *
 * Run 11 recorded that `schedule()` had six parameters, so (c) could not be run
 * at all; the seventh that arrived next was `pinnedStarts` (task 4.9's
 * optimized materialiser), not `deadlines`, and (c) was proven in the only form
 * that code admitted. **`deadlines` is now genuinely the seventh argument and
 * `pinnedStarts` the eighth**, so the plan's own sentence can finally be run
 * literally, and it is, below.
 *
 * The two arguments are deliberately not alike, and this is the file that says
 * why:
 *
 * - **`deadlines` empty is silent**, and must be: an empty map and an absent
 *   map both mean "no work item is constrained", so the default is the whole of
 *   the story and no caller can get the distinction wrong.
 * - **`pinnedStarts` empty is loud**, and must be. Measured, not assumed: an
 *   empty map is NOT a no-op for it and cannot be made one. `schedule.ts` reads
 *   `pinnedStarts === undefined` as "this is Fast" and anything else as "a
 *   solver answered", then demands a start for every node — so an empty map
 *   means "the solver returned no start for any slice" and is refused with
 *   `ScheduleInvalidOptimizedStartError`. A partial answer is an answer to a
 *   different question.
 *
 * That asymmetry is why the order matters and why the third case below exists:
 * the corpus can never be re-keyed through the optimized path by accident,
 * because the optimized path cannot be entered by accident.
 */
describe('the seventh argument did not move a corpus byte', () => {
  const stored = STORED.cases;

  const corpusUnder = (
    deadlines: ReadonlyMap<string, number> | undefined,
  ): Record<string, unknown> => {
    const cases: Record<string, unknown> = {};
    for (const each of FAST_GOLDEN_CASES) {
      cases[each.name] = serializeSchedule(
        deadlines === undefined
          ? schedule(
              each.rows,
              each.edges,
              each.slices,
              each.notBefore ?? new Map(),
              each.poolSizes ?? new Map(),
              each.reach ?? 'whole-item',
            )
          : schedule(
              each.rows,
              each.edges,
              each.slices,
              each.notBefore ?? new Map(),
              each.poolSizes ?? new Map(),
              each.reach ?? 'whole-item',
              deadlines,
            ),
      );
    }
    return cases;
  };

  /**
   * Byte-for-byte, and not `toEqual`, because that is the wording of 4.3 and
   * the two are not the same check: `toEqual` reads the structure and would
   * accept a corpus whose keys were reordered or whose numbers changed type.
   * `JSON.stringify` over both sides in `FAST_GOLDEN_CASES` order compares the
   * characters the fixture actually stores.
   */
  it('reproduces every stored schedule byte for byte with deadlines empty', () => {
    expect(FAST_GOLDEN_CASES.length).toBeGreaterThan(0);
    expect(JSON.stringify(corpusUnder(new Map()))).toBe(JSON.stringify(stored));
  });

  it('produces the same bytes whether deadlines is stated empty or defaulted', () => {
    expect(JSON.stringify(corpusUnder(new Map()))).toBe(JSON.stringify(corpusUnder(undefined)));
  });

  it('refuses an empty pinnedStarts on every case rather than treating it as Fast', () => {
    expect(FAST_GOLDEN_CASES.length).toBeGreaterThan(0);
    for (const each of FAST_GOLDEN_CASES) {
      expect(() =>
        schedule(
          each.rows,
          each.edges,
          each.slices,
          each.notBefore ?? new Map(),
          each.poolSizes ?? new Map(),
          each.reach ?? 'whole-item',
          new Map(),
          new Map(),
        ),
      ).toThrow(ScheduleInvalidOptimizedStartError);
    }
  });
});
