import type { OptimizationVariantState, OptimizedScheduleRead, ScheduleAsk } from '@wbs/core';
import { type Schedule, ScheduleCycleError } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import { createScheduler } from './scheduler';

const INPUT: ScheduleInput = {
  rows: [{ id: 'leaf', parentId: null, position: 10, frozenNumber: null, priority: 7 }],
  edges: [{ predecessorId: 'before', successorId: 'leaf' }],
  slices: [
    {
      workItemId: 'leaf',
      stepId: 'dev',
      days: 3,
      personId: 'person',
      width: 2,
      poolIds: ['team'],
    },
  ],
  notBefore: new Map([['leaf', 4]]),
  poolSizes: new Map([['team', 2]]),
  reach: 'whole-item',
  deadlines: new Map([['leaf', 9]]),
};

function scheduleAt(day: number): Schedule {
  return {
    slices: new Map(),
    workItems: new Map([
      [
        'leaf',
        {
          duration: 1,
          estimated: true,
          earliestStart: day,
          earliestFinish: day + 1,
          latestStart: day,
          latestFinish: day + 1,
          float: 0,
          critical: true,
        },
      ],
    ]),
    waitingForPerson: 0,
    waitingForCapacity: 0,
    eventsVisited: day,
  };
}

const FAST = scheduleAt(1);
const PRI = scheduleAt(2);
const TIME = scheduleAt(3);

function ask(overrides: Partial<ScheduleAsk> = {}): ScheduleAsk {
  return {
    projectId: 'project',
    input: INPUT,
    engine: 'fast',
    objective: 'pri',
    enabled: true,
    mode: 'live',
    ...overrides,
  };
}

function optimizedRead(
  pri: OptimizationVariantState = { state: 'ready', proof: 'proven' },
  time: OptimizationVariantState = { state: 'ready', proof: 'proven' },
): OptimizedScheduleRead {
  return {
    inputHash: 'input-hash',
    generation: 4,
    contractVersion: '8+test',
    budgetMs: 60_000,
    variants: { pri, time },
    schedules: {
      pri: pri.state === 'ready' ? PRI : null,
      time: time.state === 'ready' ? TIME : null,
    },
  };
}

describe('createScheduler', () => {
  it('reports installed capabilities and refuses a selected missing adapter before Fast runs', () => {
    let fastCalls = 0;
    const scheduler = createScheduler(() => {
      fastCalls += 1;
      return FAST;
    });

    expect(scheduler.supports('fast')).toBe(true);
    expect(scheduler.supports('optimized')).toBe(false);
    expect(scheduler.read(ask({ engine: 'optimized' }))).toEqual({
      kind: 'engine_unavailable',
      error: 'engine_unavailable',
      engine: 'optimized',
    });
    expect(fastCalls).toBe(0);
    expect(scheduler.read(ask({ engine: 'optimized', enabled: false }))).toEqual({
      kind: 'scheduled',
      fast: FAST,
      optimization: null,
    });
    expect(fastCalls).toBe(1);
  });

  it('forwards all seven Fast arguments and selects the live or captured optimized reader', () => {
    const fastCalls: unknown[][] = [];
    const liveAsks: unknown[] = [];
    const capturedAsks: unknown[] = [];
    const optimization = optimizedRead();
    const scheduler = createScheduler(
      (...args) => {
        fastCalls.push(args);
        return FAST;
      },
      {
        readLive: (optimizationAsk) => {
          liveAsks.push(optimizationAsk);
          return optimization;
        },
        readCaptured: (optimizationAsk) => {
          capturedAsks.push(optimizationAsk);
          return optimization;
        },
      },
    );

    expect(scheduler.supports('optimized')).toBe(true);
    expect(scheduler.read(ask({ engine: 'fast', objective: 'pri' }))).toEqual({
      kind: 'scheduled',
      fast: FAST,
      optimization,
    });
    expect(
      scheduler.read(ask({ engine: 'optimized', objective: 'time', mode: 'capture' })),
    ).toEqual({ kind: 'scheduled', fast: FAST, optimization });
    expect(scheduler.read(ask({ engine: 'optimized', objective: 'time', enabled: false }))).toEqual(
      { kind: 'scheduled', fast: FAST, optimization },
    );
    expect(fastCalls).toEqual([
      [
        INPUT.rows,
        INPUT.edges,
        INPUT.slices,
        INPUT.notBefore,
        INPUT.poolSizes,
        INPUT.reach,
        INPUT.deadlines,
      ],
      [
        INPUT.rows,
        INPUT.edges,
        INPUT.slices,
        INPUT.notBefore,
        INPUT.poolSizes,
        INPUT.reach,
        INPUT.deadlines,
      ],
      [
        INPUT.rows,
        INPUT.edges,
        INPUT.slices,
        INPUT.notBefore,
        INPUT.poolSizes,
        INPUT.reach,
        INPUT.deadlines,
      ],
    ]);
    expect(liveAsks).toEqual([
      { projectId: 'project', input: INPUT, objective: 'pri', enabled: true },
      { projectId: 'project', input: INPUT, objective: 'time', enabled: false },
    ]);
    expect(capturedAsks).toEqual([
      { projectId: 'project', input: INPUT, objective: 'time', enabled: true },
    ]);
  });

  const states: OptimizationVariantState[] = [
    { state: 'ready', proof: 'proven' },
    { state: 'pending' },
    { state: 'retrying' },
    { state: 'failed', reason: 'timeout' },
    { state: 'corrupt', message: 'bad payload' },
    { state: 'plan-infeasible', items: [] },
    { state: 'idle' },
  ];

  it.each(states)('retains the installed selected variant state %#', (state) => {
    const optimization = optimizedRead(state);
    const scheduler = createScheduler(() => FAST, {
      readLive: () => optimization,
      readCaptured: () => optimization,
    });
    expect(scheduler.read(ask({ engine: 'optimized' }))).toEqual({
      kind: 'scheduled',
      fast: FAST,
      optimization,
    });
  });

  it('throws when a ready optimized variant carries no schedule', () => {
    const malformed = { ...optimizedRead(), schedules: { pri: null, time: TIME } };
    const scheduler = createScheduler(() => FAST, {
      readLive: () => malformed,
      readCaptured: () => malformed,
    });
    expect(() => scheduler.read(ask({ engine: 'optimized' }))).toThrow(
      'optimized scheduler reported ready without a pri schedule',
    );
  });

  it('preserves unexpected adapter failures and domain cycles', () => {
    const outage = new Error('cache unavailable');
    const broken = createScheduler(() => FAST, {
      readLive: () => {
        throw outage;
      },
      readCaptured: () => optimizedRead(),
    });
    expect(() => broken.read(ask())).toThrow(outage);

    const cycle = new ScheduleCycleError();
    const cyclic = createScheduler(() => {
      throw cycle;
    });
    expect(() => cyclic.read(ask())).toThrow(cycle);
  });
});
