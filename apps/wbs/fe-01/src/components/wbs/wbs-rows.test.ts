import { describe, expect, it } from 'vitest';

import type { WorkItemView } from '@/lib/wbs-api';
import { workItemView } from '@/testing/views';

import { toTree } from './wbs-rows';

const item = (id: string, parentId: string | null, number: string): WorkItemView =>
  workItemView({ id, parentId, number, name: id });

describe('toTree', () => {
  it('attaches children to their parents', () => {
    const roots = toTree([
      item('a', null, '010'),
      item('a1', 'a', '010.1'),
      item('a1x', 'a1', '010.1.1'),
      item('b', null, '020'),
    ]);

    expect(roots.map((r) => r.id)).toEqual(['a', 'b']);
    expect(roots[0]?.subRows.map((r) => r.id)).toEqual(['a1']);
    expect(roots[0]?.subRows[0]?.subRows.map((r) => r.id)).toEqual(['a1x']);
  });

  it('keeps the order the server sent', () => {
    const roots = toTree([
      item('a', null, '010'),
      item('a1', 'a', '010.1'),
      item('a2', 'a', '010.2'),
    ]);

    expect(roots[0]?.subRows.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('keeps a work item whose parent is absent rather than dropping it', () => {
    // Losing a row without a word is worse than showing it in the wrong place:
    // one is visible and fixable, the other is work that silently disappeared.
    const roots = toTree([item('orphan', 'gone', '010')]);

    expect(roots.map((r) => r.id)).toEqual(['orphan']);
  });
});
