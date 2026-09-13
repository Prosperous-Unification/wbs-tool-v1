import { render } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS, PRIORITY_BAND_COUNT } from '@wbs/domain/priority-band';
import { describe, expect, it } from 'vitest';

import { priorityBandStyleOf } from './priority-band-style';
import { PRIORITY_GLYPH_COUNT, PriorityChevron } from './priority-chevron';

/**
 * The second channel the Prio cell spends, in jsdom.
 *
 * What is jsdom's here and what is not: the **shapes** are a fact about markup
 * this component writes, which is exactly what `render` can read. That a glyph
 * does not swallow the click that opens the band list is a fact about
 * hit-testing, and it lives in `e2e/priority-ramp.spec.ts` — the class R5
 * #14/#15/#18 are three separate days about.
 *
 * `openspec/changes/priority-chevron/`.
 */

/** Every polyline the glyph for one rank draws, as the attribute holds it. */
function drawnAt(rank: number): { shape: string | null; points: string[] } {
  const paint = priorityBandStyleOf(
    DEFAULT_PRIORITY_BANDS,
    DEFAULT_PRIORITY_BANDS[rank].defaultValue,
  );
  if (paint === null) throw new Error(`rank ${String(rank)} resolved to no band`);
  const { container, unmount } = render(<PriorityChevron rank={paint.rank} ink={paint.ink} />);
  const glyph = container.querySelector('[data-priority-glyph]');
  const drawn = {
    shape: glyph?.getAttribute('data-priority-glyph') ?? null,
    points: [...(glyph?.querySelectorAll('polyline') ?? [])].map(
      (line) => line.getAttribute('points') ?? '',
    ),
  };
  unmount();
  return drawn;
}

describe('the rung, drawn beside the number', () => {
  it('covers the whole ladder and no more', () => {
    // A ladder is exactly five rungs and is not configurable
    // (`priority-band.ts` names that as a refusal), so the shape table is
    // complete by construction. Asserted rather than assumed, because a sixth
    // rung would silently leave one rank with no glyph — `GLYPH_SHAPES.at`
    // answers `undefined` and the component renders nothing at all.
    expect(PRIORITY_GLYPH_COUNT).toBe(PRIORITY_BAND_COUNT);
  });

  it('gives each of the five rungs its own drawing, not just its own name', () => {
    const drawn = Array.from({ length: PRIORITY_BAND_COUNT }, (_, rank) => drawnAt(rank));

    // Five names …
    expect(new Set(drawn.map((each) => each.shape)).size).toBe(PRIORITY_BAND_COUNT);
    // … and five **drawings**. The names alone are a check that cannot fail:
    // five identical polylines under five different `data-priority-glyph`
    // values would satisfy it, and the reader would see one shape down the
    // whole column.
    //
    // Proof: every entry of `GLYPH_POINTS` set to `up`'s single polyline, the
    // names left alone. The line above stayed **green** — the names are still
    // five — and this one failed on `expected 1 to be 5`. That is the shape of
    // the vacuity, watched, 2026-08-31.
    expect(new Set(drawn.map((each) => each.points.join('|'))).size).toBe(PRIORITY_BAND_COUNT);
  });

  it('points up above the ordinary rung and down below it, doubled at the ends', () => {
    // The order every tool this audience already reads. Stated as the five
    // names rather than as five geometries: the geometry is the case above, and
    // this one is about which shape lands on which rung — a table transposed by
    // one would pass the case above and be wrong on every row.
    //
    // Proof: `GLYPH_SHAPES` reversed, watched failing on `expected [ Array(5) ]
    // to deeply equal [ 'up-double', 'up', 'level', …(2) ]` — this case alone,
    // 1 failed | 4 passed, with the geometry case above still green.
    expect(Array.from({ length: PRIORITY_BAND_COUNT }, (_, rank) => drawnAt(rank).shape)).toEqual([
      'up-double',
      'up',
      'level',
      'down',
      'down-double',
    ]);
  });

  it('is drawn in the band’s own ink and says nothing to a screen reader', () => {
    const paint = priorityBandStyleOf(
      DEFAULT_PRIORITY_BANDS,
      DEFAULT_PRIORITY_BANDS[0].defaultValue,
    );
    if (paint === null) throw new Error('rank 0 resolved to no band');
    const { container } = render(<PriorityChevron rank={paint.rank} ink={paint.ink} />);
    const glyph = container.querySelector<SVGElement>('[data-priority-glyph]');

    // The ink comes from the one resolution and is not re-picked here — see
    // `priority-band-style.ts`, which every face reads.
    expect(glyph?.style.color).toBe(paint.ink);
    // Decoration. The cell's `title` already reads `${label} — priority ${n}`,
    // and a table of forty rows announcing the glyph as well would read it
    // twice.
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    // And out of the click's way. `pointer-events` is the property; whether it
    // works is Chromium's to say.
    expect(glyph?.style.pointerEvents).toBe('none');
  });

  it('draws nothing for a rank the ladder does not have', () => {
    // Unreachable from `priorityBandStyleOf`, which answers a rank inside the
    // ladder or null. It is a render rather than a throw for `AGENTS.md`'s
    // reason — no assertions in `render` — and a chart that drew a stray glyph
    // for a rank nobody has would be the worse of the two answers.
    const { container } = render(<PriorityChevron rank={PRIORITY_BAND_COUNT} ink="red" />);
    expect(container.querySelector('[data-priority-glyph]')).toBeNull();
  });
});
