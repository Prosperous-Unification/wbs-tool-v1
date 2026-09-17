import { describe, expect, it } from 'bun:test';

import { parseOrThrow, type, ValidationError } from './core';

describe('@shared/validation core', () => {
  it('re-exports ArkType type function that validates objects', () => {
    const Person = type({ name: 'string', age: 'number>0' });
    const result = Person({ name: 'Ada', age: 36 });
    expect(result).toEqual({ name: 'Ada', age: 36 });
  });

  it('parseOrThrow returns parsed value on success', () => {
    const Email = type('string.email');
    expect(parseOrThrow(Email, 'ada@example.com')).toBe('ada@example.com');
  });

  it('parseOrThrow throws ValidationError on failure, embedding the offending value', () => {
    const Email = type('string.email');
    const bad = 'not-an-email';
    expect(() => parseOrThrow(Email, bad)).toThrow(ValidationError);
    try {
      parseOrThrow(Email, bad);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).message).toContain('not-an-email');
    }
  });
});
