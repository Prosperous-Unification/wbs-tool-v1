import { describe, expect, it } from 'vitest';

import { initialsOf } from './initials';

describe('an assignee is named in two characters', () => {
  it('names a one-word assignee by its first two letters', () => {
    // One letter is not enough: `vadym` and `vitalii` are both `V`, and two
    // people who read identically is the fault the initials replace rather than
    // a smaller version of it.
    //
    // Proof: the single-word branch's `.slice(0, 2)` made `.slice(0, 1)` —
    // failed on `expected 'V' to be 'VA'`. Watched 2026-08-12.
    expect(initialsOf('vadym')).toBe('VA');
  });

  it('takes one letter from each of a two-word name', () => {
    // Proof: the two-word branch replaced with the one-word one — failed on
    // `expected 'KA' to be 'KN'`, which is Kat Nowak reading as Kat Adams.
    // Watched 2026-08-12.
    expect(initialsOf('Kat Nowak')).toBe('KN');
  });

  it('ignores everything after the second word', () => {
    expect(initialsOf('Anna Maria Rossi')).toBe('AM');
  });

  it('answers a one-character name with that character', () => {
    // Not padded and not refused: `K` is what there is, and a badge invented
    // around it would say something the directory does not.
    expect(initialsOf('K')).toBe('K');
  });

  it('upper-cases what it takes', () => {
    // Proof: `.toLocaleUpperCase()` dropped — failed on `expected 'va' to be
    // 'VA'`. Watched 2026-08-12.
    expect(initialsOf('vadym')).toBe('VA');
    expect(initialsOf('kat nowak')).toBe('KN');
  });

  it('reads a name padded with spaces as the name', () => {
    // A `.trim()` was written for this and deleted: with it removed this test
    // was watched **passing**, because splitting on `/\s+/` puts an empty
    // string at each end and `filter(Boolean)` drops them either way. The
    // filter is what the padding is actually handled by, so that is what this
    // watches.
    //
    // Proof: `.filter(Boolean)` dropped — failed on `expected 'V' to be 'VA'`,
    // the leading empty segment taken as the first word and `vadym` as the
    // second. Watched 2026-08-12.
    expect(initialsOf('  vadym  ')).toBe('VA');
    expect(initialsOf('Kat\tNowak')).toBe('KN');
  });

  it('refuses a name with nothing in it', () => {
    // R5: the caller prints an assignee it has, so a blank here is state
    // nothing can account for rather than a person with a short name. A `''`
    // returned instead would print `· ` and read as an assignee whose name the
    // table lost.
    //
    // Proof: the throw replaced with `return ''` — failed on `expected
    // [Function] to throw an error`. Watched 2026-08-12.
    expect(() => initialsOf('')).toThrow();
    expect(() => initialsOf('   ')).toThrow();
  });
});
