import { describe, expect, it, vi } from 'vitest';

import { workItemView } from '@/testing/views';

import { attachRowReadings } from './plan-render-rows';
import { toTree } from './wbs-rows';

describe('attachRowReadings', () => {
  it('attaches one immutable reading to every row without losing the tree', () => {
    const roots = toTree([
      workItemView({ id: 'root', parentId: null, number: '010' }),
      workItemView({ id: 'child', parentId: 'root', number: '010.1' }),
    ]);
    const read = vi.fn((row: { id: string }) => ({
      hasSchedule: true,
      finish: `${row.id}-finish`,
    }));

    const rendered = attachRowReadings(roots, read);

    expect(read.mock.calls.map(([row]) => row.id).sort()).toEqual(['child', 'root']);
    expect(rendered[0]?.number).toBe('010');
    expect(rendered[0]?.readings.finish).toBe('root-finish');
    expect(rendered[0]?.subRows[0]?.number).toBe('010.1');
    expect(rendered[0]?.subRows[0]?.readings.finish).toBe('child-finish');
  });
});
