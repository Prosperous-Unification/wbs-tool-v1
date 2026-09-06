import type { Schedule } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { schedulesHaveSameOrder } from './work-item.service';

const scheduleAt = (starts: Readonly<Record<string, number>>): Schedule =>
  ({
    slices: new Map(Object.entries(starts).map(([key, earliestStart]) => [key, { earliestStart }])),
  }) as Schedule;

describe('materialised schedule order comparison', () => {
  it('is blind to a uniform two-day shift', () => {
    expect(schedulesHaveSameOrder(scheduleAt({ a: 0, b: 1 }), scheduleAt({ a: 2, b: 3 }))).toBe(
      true,
    );
  });

  it('treats a broken tie as reordered', () => {
    expect(schedulesHaveSameOrder(scheduleAt({ a: 0, b: 0 }), scheduleAt({ a: 0, b: 1 }))).toBe(
      false,
    );
  });

  it('treats a created tie as reordered', () => {
    expect(schedulesHaveSameOrder(scheduleAt({ a: 0, b: 1 }), scheduleAt({ a: 0, b: 0 }))).toBe(
      false,
    );
  });

  it('observes a zero-duration slice moving across another start', () => {
    expect(
      schedulesHaveSameOrder(
        scheduleAt({ instant: 0, work: 1 }),
        scheduleAt({ instant: 2, work: 1 }),
      ),
    ).toBe(false);
  });

  it('compares fractional workdays without collapsing them to solver units', () => {
    // Quantising the left pair onto the 1/48 solver grid ties it while the
    // right pair remains ordered. Real-domain signs agree, which is the wire's
    // answer and the only way this case can stay `true`.
    expect(
      schedulesHaveSameOrder(scheduleAt({ a: 0, b: 1 / 96 }), scheduleAt({ a: 0, b: 1 / 48 })),
    ).toBe(true);
  });
});
