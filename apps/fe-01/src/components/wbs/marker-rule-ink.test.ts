import { describe, expect, it } from 'vitest';

import {
  differingColumns,
  greatestChannelDelta,
  isContiguousRun,
  sameColumns,
} from './marker-rule-ink';

/**
 * Slice 8.2a's column arithmetic, on the functions that own it.
 *
 * The browser tier's job is the strip, the rung and the hidden element; this
 * file's job is what the numbers between two clips mean. Everything here is a
 * hand-written strip a few pixels wide, because a clip's *size* is never the
 * question — the question is which columns changed and whether that shape is a
 * rule.
 */

/** A strip of solid white, `width × height`, as `getImageData` lays it out. */
const blankStrip = (width: number, height: number) => ({
  width,
  height,
  data: new Array<number>(width * height * 4).fill(255),
});

describe('how far a raster channel moved', () => {
  it('measures a tiny anti-alias wobble without calling it opaque ink', () => {
    expect(greatestChannelDelta(blankStrip(5, 3), painted(5, 3, [2], { value: 249 }))).toBe(6);
  });

  it('keeps an opaque auxiliary mark far outside the raster-jitter allowance', () => {
    // This is the controlled fault for the whole-body browser oracle: changing
    // a white channel to black is 255, so an 8-value allowance cannot hide an
    // extra rule even if it is only one pixel.
    expect(greatestChannelDelta(blankStrip(5, 3), painted(5, 3, [2]))).toBe(255);
  });

  it('refuses differently sized clips rather than measuring their shared prefix', () => {
    expect(() => greatestChannelDelta(blankStrip(5, 3), blankStrip(5, 4))).toThrow(
      /cannot change size/,
    );
  });
});

/**
 * The same strip with some columns painted through, top to bottom.
 *
 * `channel` says which of RGBA moves, so a case can paint a column that differs
 * in alpha **only** — the anti-aliased edge of a hairline, and the one a
 * three-channel comparison cannot see.
 */
const painted = (
  width: number,
  height: number,
  columns: readonly number[],
  { channel = 0, value = 0 }: { channel?: number; value?: number } = {},
) => {
  const strip = blankStrip(width, height);
  for (const x of columns) {
    for (let y = 0; y < height; y += 1) {
      strip.data[(y * width + x) * 4 + channel] = value;
    }
  }
  return strip;
};

describe('what two clips of one strip disagree about', () => {
  it('names the columns a hairline painted, and nothing either side of them', () => {
    // The shape of every browser assertion in 8.2a: a baseline with no marker,
    // a clip with one, and a run in the middle.
    expect(differingColumns(blankStrip(8, 4), painted(8, 4, [3, 4]))).toEqual([3, 4]);
  });

  it('reads one changed pixel in a column as the whole column changed', () => {
    // A vertical rule crossed by a row line, a gridline or a chip does not
    // paint every pixel of its column, and the run is still the run. So the
    // predicate is "at least one pixel", not "every pixel".
    const after = blankStrip(6, 5);
    after.data[(2 * 6 + 4) * 4] = 0;

    expect(differingColumns(blankStrip(6, 5), after)).toEqual([4]);
  });

  it('sees a column that moved in alpha alone', () => {
    // **All four channels, and this is the case that says so.** A hairline
    // centred on a pixel boundary is painted at partial coverage into the two
    // columns it straddles, so its edges can differ from the ground in alpha
    // while RGB stays where it was. A three-channel comparison reads such a
    // column as unchanged and shrinks a 2-column run to 1 — inside the
    // 1-or-2 bound, and so silently.
    expect(
      differingColumns(blankStrip(5, 3), painted(5, 3, [2], { channel: 3, value: 128 })),
    ).toEqual([2]);
  });

  it('finds nothing between a clip and itself', () => {
    // The lower half of the bound depends on this reading empty rather than
    // throwing or guessing: hiding the queried rule and seeing **zero**
    // columns move is how the coincident untagged line is caught.
    expect(differingColumns(blankStrip(4, 4), blankStrip(4, 4))).toEqual([]);
  });

  it('refuses two clips of different sizes rather than comparing them', () => {
    // A fresh `<canvas>` is 300×150 and would crop a wider clip and pad a
    // narrower one. Both clips come from one `strip` object, so a mismatch is
    // a measurement that did not happen — and a measurement that did not
    // happen must not read as an empty difference, which is a pass.
    expect(() => differingColumns(blankStrip(8, 4), blankStrip(8, 5))).toThrow(
      /cannot change size/,
    );
  });
});

describe('whether the differing columns are a rule', () => {
  it('accepts one column and two abutting ones', () => {
    // The two widths a correct 1px non-scaling stroke can leave: on a pixel,
    // or straddling a boundary at partial coverage into both sides.
    expect(isContiguousRun([7])).toBe(true);
    expect(isContiguousRun([7, 8])).toBe(true);
  });

  it('rejects a gap, however small', () => {
    // A rule in one place and stray ink in another. A bound on the count alone
    // accepts this — two columns is two columns — which is why contiguity is
    // asserted beside it and not instead of it.
    expect(isContiguousRun([7, 9])).toBe(false);
  });

  it('rejects nothing at all', () => {
    // "At most 2" is satisfied by zero, and a rule that never painted would
    // pass it. The empty set is not a run.
    expect(isContiguousRun([])).toBe(false);
  });

  it('does not care what order the scan produced', () => {
    // The sets come from independent scans and nothing promises they arrive
    // sorted; a run is a property of the columns, not of the array.
    expect(isContiguousRun([9, 7, 8])).toBe(true);
  });
});

describe('whether the marker’s ink and the rule’s ink are the same ink', () => {
  it('holds when the queried rule is everything the marker drew', () => {
    expect(sameColumns([3, 4], [4, 3])).toBe(true);
  });

  it('fails when the marker painted a column the rule did not', () => {
    // **The binding, and the reason this is an equality.** An untagged 1px
    // line one column over makes the marker's ink `[3, 4]` and the queried
    // rule's `[3]` — a contiguous run of 1, inside the bound, with the tag,
    // both width assertions and 8.2's count all green. Containment would pass
    // it; a set equality does not.
    expect(sameColumns([3, 4], [3])).toBe(false);
  });

  it('fails when the rule painted a column the marker did not', () => {
    // The other direction, which a one-sided `every` would miss. It should not
    // be reachable — the rule is part of the marker — so a true here would be
    // the clips having come from different states.
    expect(sameColumns([3], [3, 4])).toBe(false);
  });

  it('fails an empty set against a painted one', () => {
    // The coincident untagged line: hiding the tagged rule changes nothing, so
    // its ink is empty while the marker's is not.
    expect(sameColumns([3, 4], [])).toBe(false);
  });
});
