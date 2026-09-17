import { describe, expect, it } from 'vitest';

import { EDGE_TOLERANCE, findOverlap, findOverrun } from './box-geometry';

/** A box at `x` that is `width` wide, named so a failure says which one moved. */
const box = (id: string, x: number, width: number) => ({ id, x, width });

describe('findOverlap', () => {
  it('is content with cells that meet exactly', () => {
    expect(findOverlap([box('drag', 0, 28), box('number', 28, 168), box('name', 196, 360)])).toBe(
      undefined,
    );
  });

  it('is content with a gap between two cells', () => {
    expect(findOverlap([box('number', 28, 168), box('name', 200, 360)])).toBe(undefined);
  });

  it('names both cells when one starts inside the one before it', () => {
    // The bug this whole change exists for: a pinned Name painting over
    // "Depends on" because the offsets were summed from widths the browser
    // never laid out.
    const name = box('name', 196, 360);
    const depends = box('depends', 544, 220);
    expect(findOverlap([name, depends])).toEqual({ previous: name, box: depends });
  });

  it('forgives a half-pixel, which is a border rounding and not an overlap', () => {
    const meeting = [box('number', 28, 168), box('name', 196 - EDGE_TOLERANCE, 360)];
    expect(findOverlap(meeting)).toBe(undefined);
  });

  it('reports more than a half-pixel, so the tolerance cannot swallow a real overlap', () => {
    const previous = box('number', 28, 168);
    const over = box('name', 196 - EDGE_TOLERANCE - 0.1, 360);
    expect(findOverlap([previous, over])).toEqual({ previous, box: over });
  });

  it('reports the first offending pair rather than the last', () => {
    const first = box('number', 28, 168);
    const second = box('name', 100, 360);
    expect(findOverlap([box('drag', 0, 28), first, second, box('depends', 0, 220)])).toEqual({
      previous: first,
      box: second,
    });
  });

  it('has nothing to say about a row of one cell, or of none', () => {
    expect(findOverlap([box('drag', 0, 28)])).toBe(undefined);
    expect(findOverlap([])).toBe(undefined);
  });
});

describe('findOverrun', () => {
  const cell = box('name', 196, 360);

  it('is content with a control inside its cell', () => {
    expect(findOverrun(cell, box('name input', 200, 352))).toBe(undefined);
  });

  it('is content with a control filling its cell exactly', () => {
    expect(findOverrun(cell, box('name input', 196, 360))).toBe(undefined);
  });

  it('says which edge a control ran past on the right', () => {
    // A `22em` textarea in a 100px column — the fault the browser gate is
    // there to see, and the one jsdom cannot.
    expect(findOverrun(box('name', 196, 100), box('name input', 200, 352))).toBe('right');
  });

  it('says which edge a control ran past on the left', () => {
    expect(findOverrun(cell, box('name input', 180, 100))).toBe('left');
  });

  it('forgives a half-pixel on either edge', () => {
    expect(findOverrun(cell, box('name input', 196 - EDGE_TOLERANCE, 360 + EDGE_TOLERANCE))).toBe(
      undefined,
    );
  });

  it('reports the left edge first when a control overruns both, because it is the one printed', () => {
    expect(findOverrun(cell, box('name input', 100, 800))).toBe('left');
  });
});
