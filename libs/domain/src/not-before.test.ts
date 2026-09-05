import { describe, expect, it } from 'bun:test';

import { isOrphanedNotBeforeReason, LONGEST_NOT_BEFORE_REASON } from './not-before';

describe('isOrphanedNotBeforeReason', () => {
  it('is the one pair a row may not be in: words with no date to be words about', () => {
    expect(isOrphanedNotBeforeReason(null, 'waiting on client sign-off')).toBe(true);
  });

  it('holds the three pairs that are real states, the empty one included', () => {
    // Neither: every row nobody has held back. A date alone: every not-before
    // written before this column existed, and every one whose reason needs no
    // saying. Both: what this feature is.
    expect(isOrphanedNotBeforeReason(null, null)).toBe(false);
    expect(isOrphanedNotBeforeReason('2026-09-12', null)).toBe(false);
    expect(isOrphanedNotBeforeReason('2026-09-12', 'waiting on client sign-off')).toBe(false);
  });

  it('reads the date and not the reason as the thing that may be missing', () => {
    // The asymmetry is the rule. A reason is meaningless without a date; a date
    // is complete without a reason, and always has been — every row on the live
    // server has one of those and none has the other.
    //
    // Proof: the predicate written as `(reason === null) !== (date === null)` —
    // the symmetric reading, which is what "these two go together" turns into
    // if nobody writes down which one leads. **76 pass, 2 fail**: this case and
    // `holds the three pairs that are real states`, both on `Expected: false /
    // Received: true` for a date with no reason — every not-before on every plan
    // that existed before this change, refused at its next edit. Watched
    // 2026-08-18.
    expect(isOrphanedNotBeforeReason('2026-09-12', null)).toBe(false);
  });

  it('is a rule about absence, never about emptiness', () => {
    // An empty string is not how "no reason" is spelled — the controller turns
    // a blank into `null` before this is ever asked, so a `''` arriving here is
    // a reason that happens to have no characters, and it still needs a date.
    // One spelling per fact, which is the doctrine `step_progress` states as
    // "not started is the absence of a row".
    expect(isOrphanedNotBeforeReason(null, '')).toBe(true);
  });
});

describe('LONGEST_NOT_BEFORE_REASON', () => {
  it('is a sentence rather than a paragraph', () => {
    // The bound is read by `work-item.routes.ts` and by nothing else, so
    // the number is asserted where it is stated: a change to it is a change to
    // what a hover card can carry, and it should have to be typed twice.
    expect(LONGEST_NOT_BEFORE_REASON).toBe(200);
  });
});
