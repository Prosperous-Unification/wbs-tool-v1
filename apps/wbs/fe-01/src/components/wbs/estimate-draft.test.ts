import { describe, expect, it } from 'vitest';

import type { Days } from '@/lib/wbs-api';

import {
  isTrioEmpty,
  parseTrioShorthand,
  sendableTrio,
  showTrio,
  trioProblem,
  type TypedTrio,
} from './estimate-draft';

const trio = (optimistic: string, realistic: string, pessimistic: string): TypedTrio => ({
  optimistic,
  realistic,
  pessimistic,
});

describe('trioProblem', () => {
  it('says nothing about a row nobody has estimated', () => {
    expect(trioProblem(trio('', '', ''))).toBeNull();
    expect(trioProblem(trio('  ', '', ' '))).toBeNull();
  });

  it('says nothing about an ordered trio, including equal figures', () => {
    expect(trioProblem(trio('1', '2', '3'))).toBeNull();
    expect(trioProblem(trio('5', '5', '5'))).toBeNull();
    expect(trioProblem(trio('0.5', '1.5', '2'))).toBeNull();
  });

  it('names both members of the pair that breaks the order', () => {
    // Which single box is wrong in 5/3/10 is not answerable — the pair is.
    expect(trioProblem(trio('5', '3', '10'))?.points).toEqual(['optimistic', 'realistic']);
    expect(trioProblem(trio('1', '9', '3'))?.points).toEqual(['realistic', 'pessimistic']);
    expect(trioProblem(trio('9', '5', '1'))?.points).toEqual([
      'optimistic',
      'realistic',
      'pessimistic',
    ]);
  });

  it('names the empty boxes of a half-filled trio', () => {
    // be-01 stores a trio or nothing, so this saves nothing — and an unsaved
    // estimate that looks saved is worse than a visible complaint.
    expect(trioProblem(trio('5', '', ''))?.points).toEqual(['realistic', 'pessimistic']);
    expect(trioProblem(trio('1', '2', ''))?.message).toContain('not saved');
  });

  it('names what cannot be a number of days', () => {
    expect(trioProblem(trio('two', '3', '4'))?.points).toEqual(['optimistic']);
    expect(trioProblem(trio('1', '-2', '4'))?.points).toEqual(['realistic']);
  });
});

describe('sendableTrio', () => {
  it('sends exactly what was typed, unrepaired', () => {
    expect(sendableTrio(trio('1', '2', '3'))).toEqual({
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });
  });

  it('sends nothing for an empty trio', () => {
    expect(sendableTrio(trio('', '', ''))).toBeNull();
  });

  it('sends nothing rather than repairing a broken one', () => {
    // The old `keepOrdered` turned 5/0/0 into 5/5/5 and sent it. The number a
    // person did not type must never become the number the plan carries.
    expect(sendableTrio(trio('5', '0', '0'))).toBeNull();
    expect(sendableTrio(trio('5', '', ''))).toBeNull();
    expect(sendableTrio(trio('5', '3', '10'))).toBeNull();
  });
});

describe('parseTrioShorthand', () => {
  const days = (optimistic: number, realistic: number, pessimistic: number) => ({
    kind: 'trio',
    days: { optimistic, realistic, pessimistic },
  });

  /** The sentence a refused entry carries, or null when it was not refused. */
  const refusal = (typed: string): string | null => {
    const parsed = parseTrioShorthand(typed);
    return parsed.kind === 'problem' ? parsed.message : null;
  };

  it('reads three numbers off one line', () => {
    expect(parseTrioShorthand('2/3/8')).toEqual(days(2, 3, 8));
  });

  it('takes the spaces a person leaves around the numbers', () => {
    expect(parseTrioShorthand(' 2 / 3 / 8 ')).toEqual(days(2, 3, 8));
    expect(parseTrioShorthand('2/ 3/8')).toEqual(days(2, 3, 8));
  });

  it('takes decimals, because half a day is a real estimate', () => {
    expect(parseTrioShorthand('0.5/1/2')).toEqual(days(0.5, 1, 2));
  });

  it('takes zero, which is an estimate rather than the absence of one', () => {
    expect(parseTrioShorthand('0/0/0')).toEqual(days(0, 0, 0));
  });

  it('reads one number as the estimator typing all three the same', () => {
    // Not the tool inventing two figures: `5` is one keystroke sequence that
    // means one trio, said by the person typing it. The distinction matters —
    // the old `keepOrdered` invented the two nobody typed, and this must not
    // be read as its return.
    expect(parseTrioShorthand('5')).toEqual(days(5, 5, 5));
    expect(parseTrioShorthand(' 0.5 ')).toEqual(days(0.5, 0.5, 0.5));
  });

  it('says an empty cell is empty rather than wrong', () => {
    // The caller turns this into a clear or into nothing at all; a complaint
    // here would make an unestimated row glow red for being unestimated.
    expect(parseTrioShorthand('')).toEqual({ kind: 'empty' });
    expect(parseTrioShorthand('   ')).toEqual({ kind: 'empty' });
  });

  it('refuses a count that is neither one number nor three', () => {
    expect(refusal('2/3')).toContain('three');
    expect(refusal('1/2/3/4')).toContain('three');
  });

  it('refuses a figure missing between two slashes', () => {
    // `Number('')` is 0, so this is the case that would silently become a
    // zero somebody never typed.
    expect(refusal('1//3')).toContain('number');
  });

  it('refuses what cannot be a number of days', () => {
    expect(parseTrioShorthand('garbage').kind).toBe('problem');
    expect(parseTrioShorthand('two/3/4').kind).toBe('problem');
    expect(parseTrioShorthand('-1/2/3').kind).toBe('problem');
    expect(parseTrioShorthand('-5').kind).toBe('problem');
    expect(parseTrioShorthand('2 3 8').kind).toBe('problem');
  });

  it('complains about an out-of-order trio instead of sorting it', () => {
    // Proof: making this reorder `8/3/2` into `2/3/8` fails this test — the
    // whole of "estimates are never edited for you", in one line. Watched
    // failing, 2026-08-06; see `combined-trio-entry/verify.md`.
    expect(refusal('8/3/2')).toContain('optimistic');
    expect(refusal('3/2/1')).toContain('optimistic');
    expect(refusal('1/9/3')).toContain('optimistic');
  });

  it('agrees with the three boxes, trio for trio', () => {
    // The property this whole change rests on: one cell and three boxes are
    // two ways of typing the same estimate, so they must produce the same
    // request or the shorthand is a second, quieter estimator.
    const cases: [string, string, string][] = [
      ['0', '0', '0'],
      ['1', '2', '3'],
      ['5', '5', '5'],
      ['0.5', '1.5', '2'],
      ['2', '3', '10'],
      ['10', '20', '30'],
      ['0', '0.1', '100'],
    ];
    for (const [optimistic, realistic, pessimistic] of cases) {
      const boxes = sendableTrio(trio(optimistic, realistic, pessimistic));
      expect(parseTrioShorthand(`${optimistic}/${realistic}/${pessimistic}`)).toEqual({
        kind: 'trio',
        days: boxes,
      });
    }
  });

  it('refuses exactly what the three boxes refuse', () => {
    const refused: [string, string, string][] = [
      ['5', '3', '10'],
      ['9', '5', '1'],
      ['two', '3', '4'],
      ['1', '-2', '4'],
    ];
    for (const [optimistic, realistic, pessimistic] of refused) {
      expect(sendableTrio(trio(optimistic, realistic, pessimistic))).toBeNull();
      expect(parseTrioShorthand(`${optimistic}/${realistic}/${pessimistic}`).kind).toBe('problem');
    }
  });
});

describe('isTrioEmpty', () => {
  it('is true only when every box reads empty', () => {
    expect(isTrioEmpty(trio('', '', ''))).toBe(true);
    // Whitespace is what a person leaves behind when they select-all and type
    // a space, and it is not a number of days either.
    expect(isTrioEmpty(trio('  ', '', '\t'))).toBe(true);
  });

  it('is false while any box still holds something', () => {
    // The distinction the table turns a deletion on. `5 / _ / _` is a
    // half-typed trio and must stay a complaint, not become a clear.
    expect(isTrioEmpty(trio('5', '', ''))).toBe(false);
    expect(isTrioEmpty(trio('', '', '0'))).toBe(false);
    expect(isTrioEmpty(trio('1', '2', '3'))).toBe(false);
  });
});

describe('showTrio', () => {
  it('says nothing about an estimate that does not exist', () => {
    // A step nobody has estimated is ordinary, and the cell that shows it is
    // an empty box with a placeholder — not a `0/0/0` nobody typed.
    expect(showTrio(undefined)).toBe('');
  });

  it('prints a trio as the shorthand that types it', () => {
    expect(showTrio({ optimistic: 2, realistic: 3, pessimistic: 8 })).toBe('2/3/8');
    expect(showTrio({ optimistic: 0.5, realistic: 1.5, pessimistic: 2 })).toBe('0.5/1.5/2');
    // A zero optimistic point is a number somebody typed, not an absence.
    expect(showTrio({ optimistic: 0, realistic: 1, pessimistic: 4 })).toBe('0/1/4');
  });

  it('collapses three equal points to the one number that stores them', () => {
    // `5` is what a person types to mean all three are five, and it stores
    // exactly what `5/5/5` stores. Printing the long form back would show
    // somebody a trio they did not type in place of the number they did.
    //
    // Proof: the equality branch deleted so every trio prints long, this
    // failed on `expected '5/5/5' to be '5'`. Watched 2026-08-29.
    expect(showTrio({ optimistic: 5, realistic: 5, pessimistic: 5 })).toBe('5');
    expect(showTrio({ optimistic: 0, realistic: 0, pessimistic: 0 })).toBe('0');
  });

  it('prints what the parser reads back', () => {
    // The property the folded cell rests on: its value at rest is a trio
    // shorthand this module accepts, so typing the shown value back stores the
    // estimate that is already stored. Before this change the cell showed a
    // computed figure — `2.2` for `2/2/3` — and typing that back stored
    // `2.2/2.2/2.2`, a different estimate.
    //
    // Proof: the collapse widened to the optimistic point for every trio, this
    // failed on `expected { kind: 'trio', days: { …(3) } } to deeply equal {
    // kind: 'trio', days: { …(3) } }` — received `2/2/2` where `2/3/8` was
    // stored. Watched 2026-08-29.
    const stored: Days[] = [
      { optimistic: 2, realistic: 3, pessimistic: 8 },
      { optimistic: 5, realistic: 5, pessimistic: 5 },
      { optimistic: 0, realistic: 0, pessimistic: 0 },
      { optimistic: 0.5, realistic: 1.5, pessimistic: 2 },
      { optimistic: 2, realistic: 2, pessimistic: 3 },
    ];
    for (const days of stored) {
      expect(parseTrioShorthand(showTrio(days))).toEqual({ kind: 'trio', days });
    }
  });
});
