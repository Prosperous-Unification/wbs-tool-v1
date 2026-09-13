import { describe, expect, it } from 'vitest';

import type { PlanOptimizationView } from '@/lib/wbs-api';

import { cueReading } from './optimization-cue-reading';

/**
 * The suggestion rule and the words, asserted where they are decided.
 *
 * Pure arithmetic over the three finishes one plan read carries, so it is
 * tested here rather than through a rendered pill: the component's own suite
 * asserts that these words reach a control and that the control acts.
 */

const BASE: PlanOptimizationView = {
  enabled: true,
  engine: 'fast',
  objective: 'pri',
  inputHash: 'hash-a',
  generation: 7,
  contractVersion: '1.5+test',
  budgetMs: 60_000,
  displayed: 'fast',
  variants: { pri: { state: 'ready', proof: 'proven' }, time: { state: 'ready', proof: 'proven' } },
  finishDays: { fast: 10, pri: 10, time: 10 },
  sameOrderAsFast: { pri: true, time: true },
};

const reading = (over: Partial<PlanOptimizationView>, stale = false) =>
  cueReading({ ...BASE, ...over }, stale);

const wordsFor = (view: ReturnType<typeof reading>, which: 'fast' | 'pri' | 'time') =>
  view.rows.find((row) => row.which === which)?.comparedWithFast;

describe('what the cue suggests', () => {
  /**
   * Proof: with the rule loosened to "any difference" — `finish < onScreen`
   * replaced by "outside the drift **or** reordered against Fast" — five cases
   * failed: `expected 'pri' to be null` for the reordered variant, `expected
   * 'time' to be null` for the one that finishes later than the schedule on
   * screen, and the three sentence assertions that go with them. Watched
   * 2026-09-08. Both are differences a reader can read and neither is a gain:
   * an earlier project deadline is the only thing worth being nudged about.
   */
  it.each([
    ['an earlier finish is suggested', { pri: 7 }, { pri: true }, 'pri', 'Pri 3 days earlier'],
    ['the same finish reordered is not', { pri: 10 }, { pri: false }, null, null],
    ['the same finish in the same order is not', { pri: 10 }, { pri: true }, null, null],
    ['a later finish is not', { pri: 12 }, { pri: true }, null, null],
  ] as const)('%s', (_what, finishes, orders, suggestion, suggestionWords) => {
    const view = reading({
      finishDays: { fast: 10, ...finishes },
      sameOrderAsFast: { ...orders },
      // One variant at a time: the other has no schedule, which is what a plan
      // mid-solve really looks like and keeps this case about the one finish it
      // names.
      variants: { pri: { state: 'ready', proof: 'proven' }, time: { state: 'pending' } },
    });
    expect(view.suggestion).toBe(suggestion);
    expect(view.suggestionWords).toBe(suggestionWords);
  });

  it.each([
    [
      'the same finish reordered',
      { pri: 10 },
      { pri: false },
      'Same project deadline + reordered',
      'Priority-first: Same project deadline + reordered',
    ],
    [
      'a later finish',
      { pri: 12 },
      { pri: true },
      'Later project deadline by 2 days',
      'Priority-first: Later project deadline by 2 days',
    ],
    [
      'an earlier finish',
      { pri: 7 },
      { pri: true },
      'Earlier project deadline by 3 days',
      'Priority-first finishes 3 days earlier',
    ],
  ] as const)(
    'reads %s out whether or not it suggests it',
    (_what, finishes, orders, expected, inTheSentence) => {
      const view = reading({
        finishDays: { fast: 10, ...finishes },
        sameOrderAsFast: { ...orders },
        variants: { pri: { state: 'ready', proof: 'proven' }, time: { state: 'pending' } },
      });
      expect(wordsFor(view, 'pri')).toBe(expected);
      // The sentence names a suggested variant by its saving and every other
      // variant by its comparison, so the suggested one is not said twice.
      expect(view.sentence).toContain(inTheSentence);
    },
  );

  /**
   * The whole reason a suggestion is decided against the **active** schedule
   * and not against Fast, and the case that would be wrong under either
   * simpler rule.
   */
  it('does not offer a variant that is earlier than Fast but later than what is on screen', () => {
    const view = reading({
      engine: 'optimized',
      displayed: 'pri',
      finishDays: { fast: 10, pri: 7, time: 9 },
    });
    expect(view.suggestion).toBeNull();
    // And the reader is still told what Time would do, measured against Fast
    // like every other row.
    expect(wordsFor(view, 'time')).toBe('Earlier project deadline by 1 day');
  });

  it('offers the earlier of two candidates', () => {
    const view = reading({ finishDays: { fast: 10, pri: 8, time: 6 } });
    expect(view.suggestion).toBe('time');
    expect(view.suggestionWords).toBe('Time 4 days earlier');
  });

  it('never offers the schedule already on screen', () => {
    const view = reading({
      engine: 'optimized',
      displayed: 'time',
      finishDays: { fast: 10, time: 6, pri: 6 },
    });
    expect(view.suggestion).toBeNull();
  });

  it('never offers a variant whose state is not ready, whatever figure arrived with it', () => {
    // A finish beside a `pending` state is a payload be-01 does not produce.
    // The rule reads the state anyway, because "ready" is the claim that the
    // schedule behind the figure exists.
    const view = reading({
      variants: { pri: { state: 'pending' }, time: { state: 'ready', proof: 'proven' } },
      finishDays: { fast: 10, pri: 2, time: 10 },
      sameOrderAsFast: { pri: true, time: true },
    });
    expect(view.suggestion).toBeNull();
  });

  it.each([
    [-Number.EPSILON, 'Same project deadline + same order', null],
    [-0.001, 'Earlier project deadline by <0.01 day', 'Pri <0.01 day earlier'],
    [-1 / 48, 'Earlier project deadline by 0.02 days', 'Pri 0.02 days earlier'],
  ] as const)('takes a %s difference through the workday drift', (delta, expected, suggested) => {
    const view = reading({
      finishDays: { fast: 10, pri: 10 + delta },
      sameOrderAsFast: { pri: true },
      variants: { pri: { state: 'ready', proof: 'proven' }, time: { state: 'pending' } },
    });
    expect(wordsFor(view, 'pri')).toBe(expected);
    expect(view.suggestionWords).toBe(suggested);
  });
});

describe('what the cue reads out', () => {
  it('names the active schedule first, in words rather than in an abbreviation', () => {
    expect(reading({ engine: 'optimized', displayed: 'time' }).sentence).toContain(
      'Finish-first is the active schedule',
    );
    expect(reading({}).sentence).toContain('Fast is the active schedule');
    expect(reading({ engine: 'optimized', displayed: 'time' }).activeLabel).toBe('Time');
    expect(reading({ engine: 'optimized', displayed: 'pri' }).activeLabel).toBe('Pri');
  });

  it('says a variant is optimizing only once something has been admitted for the plan', () => {
    const waiting = reading({ variants: { pri: { state: 'idle' }, time: { state: 'idle' } } });
    expect(waiting.sentence).toContain('Priority-first: Optimizing…');
    // No generation is what a plan with no solvable work in it reads as, and a
    // disabled project too. Promising a solve there is a promise nobody asked
    // for and nothing will keep.
    // No generation and therefore no stored variant either: the two arrive
    // together, because a figure comes from a schedule and a schedule is
    // stored under a generation.
    const nothingToDo = reading({
      generation: null,
      variants: { pri: { state: 'idle' }, time: { state: 'idle' } },
      finishDays: { fast: 10 },
      sameOrderAsFast: {},
    });
    expect(nothingToDo.sentence).toBe('Fast is the active schedule.');
  });

  /**
   * The contrast a reader actually decides on. Every figure on the card is
   * measured against Fast, which is one reference and the right one — but the
   * choice in front of them is Pri or Time, and neither of those rows says
   * anything about the other.
   *
   * The order half is derived from the two relations against Fast and says only
   * what they support; the last case is the one where they support nothing.
   */
  it.each([
    [
      'both keep Fast’s order',
      { pri: 7, time: 8 },
      { pri: true, time: true },
      'Pri against Time: Pri 1 day earlier, in the same order as each other.',
    ],
    [
      'exactly one reorders',
      { pri: 7, time: 8 },
      { pri: true, time: false },
      'Pri against Time: Pri 1 day earlier, in a different order from each other.',
    ],
    [
      'both reorder, so their order against each other is unknowable from these two facts',
      { pri: 7, time: 8 },
      { pri: false, time: false },
      'Pri against Time: Pri 1 day earlier, each in an order of its own.',
    ],
    [
      'they finish together',
      { pri: 7, time: 7 },
      { pri: true, time: true },
      'Pri against Time: the same project deadline, in the same order as each other.',
    ],
    [
      'Time is the earlier one',
      { pri: 9, time: 7 },
      { pri: true, time: true },
      'Pri against Time: Time 2 days earlier, in the same order as each other.',
    ],
  ] as const)('contrasts the two variants when %s', (_what, finishes, orders, expected) => {
    const view = reading({ finishDays: { fast: 10, ...finishes }, sameOrderAsFast: { ...orders } });
    expect(view.variantContrast).toBe(expected);
  });

  it.each([
    [
      'one is still solving',
      { pri: { state: 'ready', proof: 'proven' }, time: { state: 'pending' } } as const,
    ],
    [
      'one failed',
      {
        pri: { state: 'ready', proof: 'proven' },
        time: { state: 'failed', reason: 'oom' },
      } as const,
    ],
    [
      'one is infeasible',
      {
        pri: { state: 'ready', proof: 'proven' },
        time: { state: 'plan-infeasible', items: [] },
      } as const,
    ],
  ])('says nothing about the two variants while %s', (_what, variants) => {
    // A figure with no schedule behind it is not a comparison. The `time`
    // figure is left on the payload deliberately: the rule reads the state.
    const view = reading({
      variants,
      finishDays: { fast: 10, pri: 7, time: 8 },
      sameOrderAsFast: { pri: true, time: true },
    });
    expect(view.variantContrast).toBeNull();
  });

  it('suppresses every comparison while the plan may be stale, and suggests nothing', () => {
    const view = reading({ finishDays: { fast: 10, pri: 6, time: 6 } }, true);
    expect(view.suggestion).toBeNull();
    expect(view.suggestionWords).toBeNull();
    expect(view.rows.map((row) => row.comparedWithFast)).toEqual([null, null, null]);
    expect(view.rows.map((row) => row.finishDays)).toEqual([null, null, null]);
    expect(view.variantContrast).toBeNull();
    expect(view.sentence).toContain('Schedule comparison unavailable while this plan may be stale');
  });

  it('qualifies an affected-item list of its own while stale', () => {
    const view = reading(
      {
        variants: {
          pri: {
            state: 'plan-infeasible',
            items: [{ ownerWorkItemId: 'a', boundWorkItemId: 'b', effectiveDeadlineOffset: 4 }],
          },
          time: { state: 'ready', proof: 'proven' },
        },
      },
      true,
    );
    expect(view.sentence).toContain('This result and affected-item list may be stale');
    expect(view.rows.find((row) => row.which === 'pri')?.unmeetable).toHaveLength(1);
  });

  it.each([
    ['failed', { state: 'failed', reason: 'timeout' } as const, ['pri']],
    ['corrupt', { state: 'corrupt', message: 'bad dto' } as const, ['pri']],
    ['plan-infeasible', { state: 'plan-infeasible', items: [] } as const, []],
    ['pending', { state: 'pending' } as const, []],
    ['ready', { state: 'ready', proof: 'proven' } as const, []],
    ['idle', { state: 'idle' } as const, []],
  ])('offers a retry for %s and for nothing else', (_what, state, expected) => {
    const view = reading({ variants: { pri: state, time: { state: 'ready', proof: 'proven' } } });
    expect(view.retryable).toEqual(expected);
  });
});
