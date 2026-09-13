import { describe, expect, it } from 'vitest';

import { type NumberedRow, parseDependencies, unknownMessage } from './depends-input';

const ROWS: NumberedRow[] = [
  { id: 'a', number: '010' },
  { id: 'b', number: '010.1' },
  { id: 'c', number: '020' },
  { id: 'd', number: '030' },
];

const parse = (typed: string) => parseDependencies(typed, ROWS);

describe('parseDependencies', () => {
  it('takes one number, as it always did', () => {
    expect(parse('020')).toEqual({ found: [{ id: 'c', number: '020' }], unknown: [] });
  });

  it('takes several separated by commas', () => {
    expect(parse('010,020,030').found.map((r) => r.id)).toEqual(['a', 'c', 'd']);
  });

  it('takes several separated by spaces', () => {
    expect(parse('010 020 030').found.map((r) => r.id)).toEqual(['a', 'c', 'd']);
  });

  it('takes a mixture, with whatever spacing someone types', () => {
    expect(parse('  010,  020   030 , ').found.map((r) => r.id)).toEqual(['a', 'c', 'd']);
  });

  it('keeps the order they were typed in', () => {
    expect(parse('030 010').found.map((r) => r.number)).toEqual(['030', '010']);
  });

  it('matches a nested number without splitting on its dot', () => {
    expect(parse('010.1').found.map((r) => r.id)).toEqual(['b']);
  });

  it('collapses a repeat rather than making it an error', () => {
    // Asked for twice is asked for once. be-01's unique pair would ignore the
    // second anyway, so interrupting someone over it would be noise.
    expect(parse('020 020').found.map((r) => r.id)).toEqual(['c']);
  });

  it('keeps the good numbers when one in the middle is a typo', () => {
    // Discarding four correct numbers because the fifth was wrong is the kind of
    // all-or-nothing that makes people stop using a field.
    const parsed = parse('010 999 030');

    expect(parsed.found.map((r) => r.id)).toEqual(['a', 'd']);
    expect(parsed.unknown).toEqual(['999']);
  });

  it('reports every unknown token, not just the first', () => {
    expect(parse('999 888').unknown).toEqual(['999', '888']);
  });

  it('finds nothing in an empty field', () => {
    expect(parse('   ')).toEqual({ found: [], unknown: [] });
  });
});

describe('unknownMessage', () => {
  it('says nothing when everything resolved', () => {
    expect(unknownMessage([])).toBeNull();
  });

  it('names one', () => {
    expect(unknownMessage(['999'])).toBe('No work item numbered 999.');
  });

  it('names several, in the singular or plural as it should be', () => {
    expect(unknownMessage(['999', '888'])).toBe('No work items numbered 999, 888.');
  });
});
