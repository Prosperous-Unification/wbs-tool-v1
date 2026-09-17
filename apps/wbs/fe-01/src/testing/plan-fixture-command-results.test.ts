import { describe, expect, it } from 'vitest';

import { assertCommandResults } from '../../e2e/plan-fixture';

describe('plan fixture command result correlation', () => {
  const authored = [{ kind: 'setEstimate' }, { kind: 'patchWorkItem' }] as const;

  it('accepts one ordered result for every non-identity command', () => {
    expect(() =>
      assertCommandResults('authored', authored, [{ index: 0 }, { index: 1 }]),
    ).not.toThrow();
  });

  it.each([
    ['empty', []],
    ['missing', [{ index: 0 }]],
    ['wrong', [{ index: 999 }, { index: 1 }]],
    ['duplicate', [{ index: 0 }, { index: 0 }]],
  ])('refuses %s authored results', (_, results) => {
    expect(() => assertCommandResults('authored', authored, results)).toThrow(
      /authored returned|authored result at/,
    );
  });

  it('requires a submitted creation ref and its produced id', () => {
    const command = [{ kind: 'createWorkItem', ref: 'row' }] as const;
    expect(() =>
      assertCommandResults('create', command, [{ index: 0, ref: 'other', id: 'r' }]),
    ).toThrow('create result at 0 has ref other, expected row');
    expect(() => assertCommandResults('create', command, [{ index: 0, ref: 'row' }])).toThrow(
      'create result at 0 has no id for row',
    );
  });
});
