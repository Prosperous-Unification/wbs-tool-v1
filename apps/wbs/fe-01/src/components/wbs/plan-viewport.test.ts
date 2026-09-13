import { describe, expect, it } from 'vitest';

import { viewportColumns, viewportRows } from './plan-viewport';

describe('plan viewport', () => {
  it('slices measured variable-height rows by viewport and overscan', () => {
    expect(
      viewportRows({
        rowIds: ['a', 'b', 'c', 'd'],
        heights: new Map([
          ['a', 20],
          ['b', 40],
          ['c', 30],
          ['d', 50],
        ]),
        estimatedHeight: 28,
        scrollTop: 45,
        viewportHeight: 30,
        overscanPx: 10,
      }),
    ).toEqual({
      beforePx: 20,
      afterPx: 50,
      entries: [
        { id: 'b', index: 1, startPx: 20, sizePx: 40 },
        { id: 'c', index: 2, startPx: 60, sizePx: 30 },
      ],
      totalPx: 140,
    });
  });

  it('uses the declared estimate only until a row has been measured', () => {
    expect(
      viewportRows({
        rowIds: ['a', 'b', 'c'],
        heights: new Map([['a', 60]]),
        estimatedHeight: 25,
        scrollTop: 50,
        viewportHeight: 20,
        overscanPx: 0,
      }).entries.map(({ id, sizePx }) => ({ id, sizePx })),
    ).toEqual([
      { id: 'a', sizePx: 60 },
      { id: 'b', sizePx: 25 },
    ]);
  });

  it('retains an explicitly pinned row outside the ordinary interval', () => {
    expect(
      viewportRows({
        rowIds: ['a', 'b', 'c', 'd', 'e'],
        heights: new Map(),
        estimatedHeight: 20,
        scrollTop: 60,
        viewportHeight: 20,
        overscanPx: 0,
        pinnedIds: new Set(['a']),
      }).entries.map(({ id }) => id),
    ).toEqual(['a', 'd']);
  });

  it('keeps pinned columns and slices the scrolling columns independently', () => {
    expect(
      viewportColumns({
        columns: [
          { id: 'number', widthPx: 50, pinned: true },
          { id: 'name', widthPx: 120, pinned: true },
          { id: 'team', widthPx: 100, pinned: false },
          { id: 'start', widthPx: 80, pinned: false },
          { id: 'finish', widthPx: 90, pinned: false },
          { id: 'depends', widthPx: 100, pinned: false },
          { id: 'assignees', widthPx: 100, pinned: false },
        ],
        scrollLeft: 230,
        viewportWidth: 180,
        overscanPx: 20,
      }),
    ).toEqual({
      beforePx: 0,
      afterPx: 200,
      entries: [
        { id: 'number', index: 0, startPx: 0, sizePx: 50 },
        { id: 'name', index: 1, startPx: 50, sizePx: 120 },
        { id: 'team', index: 2, startPx: 170, sizePx: 100 },
        { id: 'start', index: 3, startPx: 270, sizePx: 80 },
        { id: 'finish', index: 4, startPx: 350, sizePx: 90 },
      ],
      totalPx: 640,
    });
  });

  it('does not count an offscreen active column as omitted space', () => {
    expect(
      viewportColumns({
        columns: [
          { id: 'name', widthPx: 120, pinned: true },
          { id: 'team', widthPx: 100, pinned: false },
          { id: 'depends', widthPx: 100, pinned: false },
          { id: 'assignees', widthPx: 100, pinned: false },
        ],
        scrollLeft: 120,
        viewportWidth: 100,
        overscanPx: 0,
        pinnedIds: new Set(['assignees']),
      }),
    ).toEqual({
      beforePx: 0,
      afterPx: 100,
      entries: [
        { id: 'name', index: 0, startPx: 0, sizePx: 120 },
        { id: 'team', index: 1, startPx: 120, sizePx: 100 },
        { id: 'assignees', index: 3, startPx: 320, sizePx: 100 },
      ],
      totalPx: 420,
    });
  });
});
