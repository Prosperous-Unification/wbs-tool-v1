import { describe, expect, it } from 'vitest';

import { logicalGrid } from './logical-grid';

describe('logicalGrid', () => {
  it('orders editable cells by shown row and visible column, including ragged gaps', () => {
    const rows = [
      { id: 'parent', leaf: false },
      { id: 'child', leaf: true },
    ];
    const cells = logicalGrid(rows, [
      { id: 'number' },
      { id: 'name', isEditable: () => true },
      { id: 'estimate', isEditable: (row) => row.leaf },
      { id: 'hidden-step' },
      { id: 'assignee', isEditable: () => true },
    ]);

    expect(cells).toEqual([
      { rowId: 'parent', columnId: 'name' },
      { rowId: 'parent', columnId: 'assignee' },
      { rowId: 'child', columnId: 'name' },
      { rowId: 'child', columnId: 'estimate' },
      { rowId: 'child', columnId: 'assignee' },
    ]);
  });
});
