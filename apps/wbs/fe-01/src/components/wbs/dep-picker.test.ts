import { describe, expect, it } from 'vitest';

import { type PickableRow, pickerEntries } from './dep-picker';

const row = (
  id: string,
  number: string,
  name: string,
  parentId: string | null = null,
  dependsOn: readonly string[] = [],
): PickableRow => ({ id, parentId, number, name, dependsOn, status: 'unknown' });

const rows = [
  row('a', '010', 'Design API'),
  row('b', '020', 'Build gateway'),
  row('c', '030', 'Smoke test'),
  row('d', '030.1', 'Forward probe', 'c'),
];

describe('pickerEntries', () => {
  it('carries each row’s status onto its entry, so a finished predecessor can be marked', () => {
    const finished = [
      { ...row('a', '010', 'Design API'), status: 'done' as const },
      row('b', '020', 'Build gateway'),
      row('c', '030', 'Smoke test'),
    ];
    const offered = pickerEntries(finished, { id: 'b', dependsOn: [] }, '');
    expect(offered.map((r) => [r.id, r.status])).toEqual([
      ['a', 'done'],
      ['c', 'unknown'],
    ]);
  });

  it('offers every other row when nothing is typed', () => {
    const offered = pickerEntries(rows, { id: 'b', dependsOn: [] }, '');
    expect(offered.map((r) => r.id)).toEqual(['a', 'c', 'd']);
  });

  it('filters by number substring', () => {
    const offered = pickerEntries(rows, { id: 'b', dependsOn: [] }, '030');
    expect(offered.map((r) => r.number)).toEqual(['030', '030.1']);
  });

  it('filters by name, case-insensitively', () => {
    const offered = pickerEntries(rows, { id: 'b', dependsOn: [] }, 'des');
    expect(offered.map((r) => r.name)).toEqual(['Design API']);
  });

  it('never offers the row itself or its existing predecessors', () => {
    const offered = pickerEntries(rows, { id: 'b', dependsOn: ['a'] }, '');
    expect(offered.map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('offers nothing when nothing matches', () => {
    expect(pickerEntries(rows, { id: 'b', dependsOn: [] }, 'zzz')).toEqual([]);
  });

  it('ignores surrounding whitespace in the filter', () => {
    const offered = pickerEntries(rows, { id: 'b', dependsOn: [] }, '  smoke ');
    expect(offered.map((r) => r.id)).toEqual(['c']);
  });

  it('leaves an edge be-01 would write unmarked', () => {
    const offered = pickerEntries(rows, { id: 'b', dependsOn: [] }, '');
    expect(offered.map((r) => r.refusal)).toEqual([undefined, undefined, undefined]);
  });
});

describe('pickerEntries — the rows be-01 would refuse', () => {
  it('marks the row this one sits inside', () => {
    // `030.1` waiting for `030` is a child waiting for the branch that contains
    // it, which is the branch waiting for itself.
    const offered = pickerEntries(rows, { id: 'd', dependsOn: [] }, '');
    expect(offered.map((r) => [r.number, r.refusal])).toEqual([
      ['010', undefined],
      ['020', undefined],
      ['030', 'ancestor'],
    ]);
  });

  it('marks the row that sits inside this one', () => {
    const offered = pickerEntries(rows, { id: 'c', dependsOn: [] }, '');
    expect(offered.map((r) => [r.number, r.refusal])).toEqual([
      ['010', undefined],
      ['020', undefined],
      ['030.1', 'descendant'],
    ]);
  });

  it('marks the row that would close a loop, through the tree', () => {
    // `030` waits for `020`, so it waits for everything beneath it — `030.1`
    // included. Offering `020` the leaf under `030` closes the loop.
    const looped = [
      row('a', '010', 'Design API'),
      row('b', '020', 'Build gateway'),
      row('c', '030', 'Smoke test', null, ['b']),
      row('d', '030.1', 'Forward probe', 'c'),
    ];
    const offered = pickerEntries(looped, { id: 'b', dependsOn: [] }, '');
    expect(offered.map((r) => [r.number, r.refusal])).toEqual([
      ['010', undefined],
      ['030', 'cycle'],
      ['030.1', 'cycle'],
    ]);
  });

  it('still offers the marked rows rather than hiding them', () => {
    // The whole point of the mark. A row that vanishes from a list reads as a
    // bug in the tool; a row that is visibly refused, with the reason beside
    // it, teaches the shape of the plan.
    const offered = pickerEntries(rows, { id: 'd', dependsOn: [] }, '030');
    expect(offered.map((r) => r.number)).toEqual(['030']);
  });
});
