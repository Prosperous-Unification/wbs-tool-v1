import { describe, expect, it } from 'bun:test';

import { agree, isSettableStatus, isStepState, statusOf, UNKNOWN } from './progress';

describe('agree', () => {
  it('answers the status both readings hold', () => {
    expect(agree('done', 'done')).toBe('done');
    expect(agree('in_progress', 'in_progress')).toBe('in_progress');
    expect(agree(UNKNOWN, UNKNOWN)).toBe(UNKNOWN);
  });

  it('answers in progress for every disagreement, including finished against untouched', () => {
    // The rule the whole module is: Dev finished and QA silent is neither a
    // finished item nor an untouched one.
    //
    // Proof: `agree` written as `a === 'done' || b === 'done' ? 'done' : …` and
    // this case fails with `done` where `in_progress` is owed — a plan
    // reporting work as finished that nobody has tested; watched 2026-08-18.
    expect(agree('done', UNKNOWN)).toBe('in_progress');
    expect(agree(UNKNOWN, 'done')).toBe('in_progress');
    expect(agree('done', 'in_progress')).toBe('in_progress');
    expect(agree(UNKNOWN, 'in_progress')).toBe('in_progress');
  });

  it('is associative, which is what lets a branch be folded from its children', () => {
    // A parent folded from its children's states and the same parent folded
    // from every step beneath it must answer the same thing, or the tree has
    // two readings and the one on screen depends on the traversal.
    const statuses = [UNKNOWN, 'in_progress', 'done'] as const;
    for (const a of statuses) {
      for (const b of statuses) {
        for (const c of statuses) {
          expect(agree(agree(a, b), c)).toBe(agree(a, agree(b, c)));
          expect(agree(a, b)).toBe(agree(b, a));
        }
      }
    }
  });
});

describe('statusOf', () => {
  it('reads an empty collection as unknown, never as vacuously done', () => {
    // An item with no steps, a branch with no leaves, a plan on its first day.
    // Proof: `answer ?? 'done'` and this fails with `done` — every empty branch
    // in a fresh plan reporting finished work; watched 2026-08-18.
    expect(statusOf([])).toBe(UNKNOWN);
  });

  it('is done only when every reading is', () => {
    expect(statusOf(['done', 'done', 'done'])).toBe('done');
    expect(statusOf(['done', 'done', UNKNOWN])).toBe('in_progress');
    expect(statusOf(['done', 'in_progress'])).toBe('in_progress');
  });

  it('is unknown only when nothing has been said at all', () => {
    expect(statusOf([UNKNOWN, UNKNOWN])).toBe(UNKNOWN);
    expect(statusOf([UNKNOWN, 'in_progress'])).toBe('in_progress');
  });

  it('carries one reading through unchanged', () => {
    expect(statusOf(['done'])).toBe('done');
    expect(statusOf(['in_progress'])).toBe('in_progress');
    expect(statusOf([UNKNOWN])).toBe(UNKNOWN);
  });
});

describe('isStepState', () => {
  it('admits the two states a step may be stored in and nothing else', () => {
    expect(isStepState('in_progress')).toBe(true);
    expect(isStepState('done')).toBe(true);
    // The absence of a row is how "not started" is spelled, so it is not a
    // value anybody may write — see `StepState`.
    expect(isStepState('not_started')).toBe(false);
    expect(isStepState('unknown')).toBe(false);
    expect(isStepState('blocked')).toBe(false);
    expect(isStepState('')).toBe(false);
    expect(isStepState(null)).toBe(false);
    expect(isStepState(1)).toBe(false);
  });
});

describe('isSettableStatus', () => {
  it('admits the two statuses a row may be set to and nothing else', () => {
    expect(isSettableStatus('unknown')).toBe(true);
    expect(isSettableStatus('done')).toBe(true);
    // A step's statement, never a row's: the row reads it off the fold and the
    // cell shows it, but nobody sets it there — see `SETTABLE_STATUSES`.
    expect(isSettableStatus('in_progress')).toBe(false);
    expect(isSettableStatus('not_started')).toBe(false);
    expect(isSettableStatus(null)).toBe(false);
  });
});
