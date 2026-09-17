import { schedule } from '@wbs/domain';

import type { Scheduler } from '../ports/scheduler';

/** Fast-only scheduler for source-neutral core service tests. */
export const fastScheduler: Scheduler = {
  supports: (engine) => engine === 'fast',
  read: (ask) => {
    if (ask.enabled && ask.engine === 'optimized') {
      return { kind: 'engine_unavailable', error: 'engine_unavailable', engine: 'optimized' };
    }
    return {
      kind: 'scheduled',
      fast: schedule(
        ask.input.rows,
        ask.input.edges,
        ask.input.slices,
        ask.input.notBefore,
        ask.input.poolSizes,
        ask.input.reach,
        ask.input.deadlines,
      ),
      optimization: null,
    };
  },
};
