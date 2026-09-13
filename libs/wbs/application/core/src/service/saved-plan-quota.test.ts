import { describe, expect, it } from 'bun:test';

import {
  bodyBytesRefusal,
  DEFAULT_SAVED_PLAN_QUOTA,
  holdingRefusal,
  type SavedPlanQuota,
} from './saved-plan-quota';

/**
 * Small numbers, so a boundary is one unit away rather than a megabyte away and
 * the assertions say which side of it they are on. The shipped values get their
 * own test at the bottom; everything between here and there is about the rule.
 */
const small: SavedPlanQuota = {
  mostBytesPerBody: 100,
  mostPlansPerProject: 3,
  mostBytesPerProject: 1000,
};

describe('bodyBytesRefusal', () => {
  it('admits a body exactly at the limit and refuses the next byte', () => {
    expect(bodyBytesRefusal({ input: 100, schedule: null }, small)).toBeNull();
    expect(bodyBytesRefusal({ input: 101, schedule: null }, small)).toEqual({
      limit: 'body_bytes',
      asked: 101,
      allowed: 100,
    });
  });

  it('checks the schedule side too', () => {
    expect(bodyBytesRefusal({ input: 10, schedule: 101 }, small)).toEqual({
      limit: 'body_bytes',
      asked: 101,
      allowed: 100,
    });
  });

  /** An absent schedule is not a body, so there is nothing to measure. */
  it('does not treat an absent schedule as a zero-byte one to check', () => {
    expect(bodyBytesRefusal({ input: 100, schedule: null }, small)).toBeNull();
  });

  /**
   * Both over is still one refusal, and it names the side the plan cannot be
   * saved without.
   */
  it('names the input when both sides are over', () => {
    expect(bodyBytesRefusal({ input: 400, schedule: 900 }, small)?.asked).toBe(400);
  });

  /**
   * The limits are per body, not on their sum: two legal bodies stay legal
   * however close to the limit each of them is.
   */
  it('does not add the two sides together', () => {
    expect(bodyBytesRefusal({ input: 100, schedule: 100 }, small)).toBeNull();
  });
});

describe('holdingRefusal', () => {
  /**
   * "A project **already holding** 100 saved plans is refused another", so the
   * comparison is against the count after this save. At `mostPlansPerProject`
   * of 3: two held admits the third, three held refuses the fourth.
   */
  it('admits the last plan the limit allows and refuses the one after it', () => {
    expect(holdingRefusal({ plans: 2, bytes: 0 }, 10, small)).toBeNull();
    expect(holdingRefusal({ plans: 3, bytes: 0 }, 10, small)).toEqual({
      limit: 'plan_count',
      asked: 4,
      allowed: 3,
    });
  });

  /**
   * The byte bound is on the total the project would hold, which is the whole
   * point of passing the incoming bytes: a check written against `holding.bytes`
   * alone admits a body of any size onto a project one byte under the limit.
   */
  it('counts the incoming bytes into the total before comparing', () => {
    expect(holdingRefusal({ plans: 0, bytes: 999 }, 1, small)).toBeNull();
    expect(holdingRefusal({ plans: 0, bytes: 999 }, 2, small)).toEqual({
      limit: 'project_bytes',
      asked: 1001,
      allowed: 1000,
    });
  });

  /** Deleting one plan clears the count; it may not clear the bytes. */
  it('names the count when a project is at both bounds', () => {
    expect(holdingRefusal({ plans: 3, bytes: 1000 }, 1, small)?.limit).toBe('plan_count');
  });

  it('admits an ordinary save on an empty project', () => {
    expect(holdingRefusal({ plans: 0, bytes: 0 }, 42, small)).toBeNull();
  });
});

/**
 * The shipped numbers are the spec's, asserted as arithmetic rather than as
 * decimal literals so this test says the same thing the spec does.
 */
describe('the shipped quota', () => {
  it('is 8 MiB per body, 100 plans and 64 MiB per project', () => {
    expect(DEFAULT_SAVED_PLAN_QUOTA).toEqual({
      mostBytesPerBody: 8 * 1024 * 1024,
      mostPlansPerProject: 100,
      mostBytesPerProject: 64 * 1024 * 1024,
    });
  });

  /** Both checks default to it, so a caller that passes no quota gets the bounds. */
  it('is what both checks use when none is passed', () => {
    expect(bodyBytesRefusal({ input: 8 * 1024 * 1024 + 1, schedule: null })?.limit).toBe(
      'body_bytes',
    );
    expect(holdingRefusal({ plans: 100, bytes: 0 }, 1)?.limit).toBe('plan_count');
  });
});
