import { describe, expect, it } from 'vitest';

import { composeNameCell, normalizeNewlines, splitNameCell } from './name-notes';

describe('composeNameCell', () => {
  it('is the name alone when there are no notes', () => {
    expect(composeNameCell('Strip the old wiring', '')).toBe('Strip the old wiring');
  });

  it('never invents a trailing newline', () => {
    // The separator is a separator, not a terminator. An invented one would
    // come back from `splitNameCell` as notes of `''` — round-tripping — while
    // every cell in the table grew a blank second line nobody typed.
    expect(composeNameCell('Strip', '').endsWith('\n')).toBe(false);
    expect(composeNameCell('', '')).toBe('');
  });

  it('puts the notes under the name, separated by one newline', () => {
    expect(composeNameCell('Strip', 'measure twice')).toBe('Strip\nmeasure twice');
  });

  it('keeps the notes’ own newlines', () => {
    expect(composeNameCell('Strip', '## Risks\n\n- the fuse box is old')).toBe(
      'Strip\n## Risks\n\n- the fuse box is old',
    );
  });

  it('shows notes on an unnamed work item, under an empty first line', () => {
    // The completeness checker is what says a work item has no name; the cell
    // is not going to hide the notes to make the gap less visible.
    expect(composeNameCell('', 'measure twice')).toBe('\nmeasure twice');
  });
});

describe('splitNameCell', () => {
  it('takes everything before the first newline as the name', () => {
    expect(splitNameCell('Strip\nmeasure twice')).toEqual({
      name: 'Strip',
      notes: 'measure twice',
    });
  });

  it('keeps every newline after the first inside the notes', () => {
    expect(splitNameCell('Strip\n## Risks\n\n- old')).toEqual({
      name: 'Strip',
      notes: '## Risks\n\n- old',
    });
  });

  it('reads a text with no newline as a name and no notes', () => {
    expect(splitNameCell('Strip')).toEqual({ name: 'Strip', notes: '' });
    expect(splitNameCell('')).toEqual({ name: '', notes: '' });
  });

  it('reads a trailing newline as no notes at all', () => {
    // `'Strip\n'` is what pressing Enter at the end of a name leaves behind
    // before anything is typed under it. Notes of `'\n'`-and-nothing would be
    // a note whose whole content is a blank line, saved on every such pause.
    expect(splitNameCell('Strip\n')).toEqual({ name: 'Strip', notes: '' });
  });

  it('keeps a blank line that has something under it', () => {
    // The other side of the rule above, and the reason it is `''` rather than
    // "strip trailing whitespace": markdown needs the blank line between a
    // heading and its list, and this one is inside the notes rather than after
    // them.
    expect(splitNameCell('Strip\n\n- old')).toEqual({ name: 'Strip', notes: '\n- old' });
  });

  it('reads an empty first line as an unnamed work item that has notes', () => {
    // Explicit product semantics, not an accident to guard against: one merged
    // field means what it says, and the completeness checker already reports a
    // work item with no name. Cmd+Z is the way back.
    expect(splitNameCell('\nmeasure twice')).toEqual({ name: '', notes: 'measure twice' });
  });

  it('renames the work item when the first line is deleted', () => {
    // The edit this whole design has to be honest about. `Strip / measure
    // twice` with line one deleted is `measure twice`, and that text is the
    // name now. Pinned here deliberately — a guard that refused it would make
    // one field behave like two.
    const afterDeletingLineOne = splitNameCell('measure twice\nand again');

    expect(afterDeletingLineOne).toEqual({ name: 'measure twice', notes: 'and again' });
  });

  it('makes one line out of a deleted separator', () => {
    expect(splitNameCell('Stripmeasure twice')).toEqual({
      name: 'Stripmeasure twice',
      notes: '',
    });
  });

  it('reads a stored name that already holds a newline as a name and notes', () => {
    // be-01 takes a name with a newline in it, and this cell cannot show one
    // without reading the second line as a note. Stated as behaviour rather
    // than thrown on: the first edit of such a row commits that reading, which
    // is the same rule as every other line in this box.
    expect(splitNameCell(composeNameCell('two\nlines', ''))).toEqual({
      name: 'two',
      notes: 'lines',
    });
  });
});

describe('the round trip', () => {
  it('gives back what it was given', () => {
    const pairs = [
      ['Strip', ''],
      ['Strip', 'measure twice'],
      ['Strip', '## Risks\n\n- old'],
      ['', 'measure twice'],
      ['', ''],
      ['Strip', '\n- old'],
    ] as const;

    for (const [name, notes] of pairs) {
      expect(splitNameCell(composeNameCell(name, notes))).toEqual({ name, notes });
    }
  });
});

describe('normalizeNewlines', () => {
  it('turns a pasted CRLF into one newline', () => {
    // Paste is the vector: a note copied out of Windows Notepad or an email
    // arrives with `\r\n`, and an unnormalised `\r` would be stored, compared
    // against and re-sent forever as a difference nobody can see.
    expect(normalizeNewlines('Strip\r\nmeasure twice')).toBe('Strip\nmeasure twice');
  });

  it('turns a lone carriage return into one too', () => {
    expect(normalizeNewlines('Strip\rmeasure twice')).toBe('Strip\nmeasure twice');
  });

  it('leaves a text that has none alone', () => {
    expect(normalizeNewlines('Strip\nmeasure twice')).toBe('Strip\nmeasure twice');
    expect(normalizeNewlines('')).toBe('');
  });

  it('is what makes a pasted note split at the right place', () => {
    expect(splitNameCell(normalizeNewlines('Strip\r\nmeasure twice'))).toEqual({
      name: 'Strip',
      notes: 'measure twice',
    });
  });
});
