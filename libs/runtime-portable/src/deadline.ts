import type { Timers } from '@wbs/core';

export type { Timers } from '@wbs/core';
export { DeadlineExceeded, delay, untilAborted, withinDeadline } from '@wbs/core';

/** Monotonic timers over standard runtime APIs; composition supplies this adapter. */
export const systemTimers: Timers = {
  nowMs: () => performance.now(),
  schedule: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};
