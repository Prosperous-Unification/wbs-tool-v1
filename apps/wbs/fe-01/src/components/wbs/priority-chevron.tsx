/**
 * How wide and tall the glyph is drawn, in CSS pixels.
 *
 * Square, and small: the Prio column is 48px (`table-frame.ts`) and has to keep
 * holding two digits, so the glyph is given the least room a chevron reads in.
 * The same number is the `viewBox`'s extent, so the coordinates below are
 * pixels and nothing has to be scaled in the head to check them.
 */
export const PRIORITY_GLYPH_PX = 8;

/**
 * How much room the digits leave for the glyph on their leading edge — the
 * glyph's own width and **no gap beyond it**.
 *
 * A 2px gap was written here first, and the column could not pay for it. The
 * Prio column is 48px and `table-frame.ts` budgets it as "four digits and the
 * 8px of padding"; with 10px taken off the leading edge, `9999` was watched
 * clipping by 1px in Chromium (`Expected: <= 0 · Received: 1`). The column does
 * not grow to pay for a glyph — Dany's compaction of 2026-08-08 — so the gap
 * went instead.
 *
 * Nothing is lost, and that is why this is the right side to cut. The digits are
 * **right-aligned**, so at every width but the widest they supply far more air
 * than 2px on their own; and the `viewBox` insets its own polylines by one unit
 * on each side, so the drawn chevron is never flush against anything even at
 * four digits.
 *
 * Exported so the cell's `padding-left` and the glyph's width are one number: a
 * cell reserving less than the glyph draws would have the digits run over it.
 */
export const PRIORITY_GLYPH_ROOM_PX = PRIORITY_GLYPH_PX;

/**
 * The name of the shape one rank is drawn as — the attribute a reader's eye and
 * a test both find the glyph by.
 *
 * Named for the **shape**, not the rung: a rung is renameable (`Critical` may be
 * `Blocker`) and `priority-band-style.ts` already refuses to key anything on the
 * word for that reason. What this says is "two chevrons, pointing up", which is
 * a fact about the drawing and stays true whatever the project calls rank 0.
 */
export type PriorityGlyphShape = 'up-double' | 'up' | 'level' | 'down' | 'down-double';

/**
 * The five shapes, most important first, keyed on **rank** exactly as the inks
 * are.
 *
 * A ladder is exactly `PRIORITY_BAND_COUNT` rungs and is not configurable
 * (`priority-band.ts` names that as a refusal), so five entries is the whole set
 * and no shape has to be interpolated for a sixth.
 *
 * The order is the one every tool this audience already reads: more important
 * points up, the middle rung is level, less important points down, and the two
 * extremes double the chevron rather than changing its direction. It is the
 * same divergence around `ORDINARY_BAND_RANK` the colour ramp makes —
 * colour as distance from ordinary, and now direction as which side of it.
 */
const GLYPH_SHAPES: readonly PriorityGlyphShape[] = [
  'up-double',
  'up',
  'level',
  'down',
  'down-double',
];

/**
 * The polylines one shape is drawn from, in the `viewBox`'s own units.
 *
 * Two lines for a doubled chevron and one for everything else, which is what
 * makes the five distinguishable by geometry rather than only by the attribute
 * naming them — see `priority-chevron.test.tsx`, which asserts the points and
 * not just the names, because five identical drawings under five different
 * labels would satisfy a check that only read the labels.
 */
const GLYPH_POINTS: Readonly<Record<PriorityGlyphShape, readonly string[]>> = {
  'up-double': ['1,4 4,1.5 7,4', '1,6.5 4,4 7,6.5'],
  up: ['1,5.5 4,2.5 7,5.5'],
  // A bar rather than a chevron: the middle rung is the one that points nowhere,
  // and it is the commonest value on any screen since `priority-default-medium`
  // stamped it on every created row. A shape that leaned either way would say
  // something about the ordinary case that is not true of it.
  level: ['1,4 7,4'],
  down: ['1,2.5 4,5.5 7,2.5'],
  'down-double': ['1,1.5 4,4 7,1.5', '1,4 4,6.5 7,4'],
};

export interface PriorityChevronProps {
  /** The rung, 0 (most important) to 4 — `PriorityBandStyle.rank`. */
  rank: number;
  /**
   * The band's own ink, which the glyph is drawn in.
   *
   * Passed rather than resolved here, so the one resolution in
   * `priority-band-style.ts` stays the only one — every face reads it and none
   * has a colour opinion of its own.
   */
  ink: string;
}

/**
 * The rung a priority falls in, drawn as a chevron beside its number.
 *
 * **Why a second channel at all** (Dany, 2026-08-31 — _"priority cells want a
 * Jira-style chevron beside the numeric value"_). The cell spent colour and
 * nothing else, and colour is the wrong channel to spend alone here: the ramp
 * diverges around rank 2 by *chroma* at one lightness band, on purpose, so the
 * three cool rungs differ in saturation and in almost nothing else — the shape
 * colour vision deficiency reads worst. And a number is not a rung: `30` is High
 * only if you know this project's ladder, and two projects may cut it
 * differently.
 *
 * **Absolutely positioned, and that is a layout decision with a reason.** The
 * box beside it is a real `<input>` filling the 48px column with right-aligned
 * digits; putting the glyph in the flow would mean the input shares the width
 * with a sibling and the column's compaction (Dany, 2026-08-08) pays for the
 * glyph. Instead the glyph stands on the cell's leading edge, out of the flow,
 * and the input carries a `padding-left` the digits will not run under. The
 * positioned ancestor is the wrapper `PriorityCell` already renders for its
 * picker list.
 *
 * **It takes no pointer.** A click anywhere in this cell opens the band list,
 * and a glyph that hit-tested would be a hole in the middle of that target —
 * `e2e/priority-ramp.spec.ts` clicks the glyph's own pixels and asserts the list
 * opens, because whether an overlay swallows a click is a fact only a browser
 * has (R5 #14/#15/#18).
 *
 * **It says nothing to a screen reader.** The cell's `title` already reads
 * `${label} — priority ${n}`, which is the whole of what the glyph means; a
 * second reading of it is noise on a table of forty rows.
 *
 * Draws the glyph, or nothing at all for a rank outside the ladder — which
 * `priorityBandStyleOf` cannot answer, and is a render rather than a place to
 * throw (`AGENTS.md`, "no assertions in `render`").
 */
export function PriorityChevron({ rank, ink }: PriorityChevronProps) {
  const shape = GLYPH_SHAPES.at(rank);
  if (shape === undefined) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-priority-glyph={shape}
      width={PRIORITY_GLYPH_PX}
      height={PRIORITY_GLYPH_PX}
      viewBox={`0 0 ${String(PRIORITY_GLYPH_PX)} ${String(PRIORITY_GLYPH_PX)}`}
      style={{
        position: 'absolute',
        left: 0,
        // Centred on the box's own line rather than on the cell: the digits and
        // the glyph are read as one value.
        top: '50%',
        transform: 'translateY(-50%)',
        // The click belongs to the cell underneath — see the component's notes.
        pointerEvents: 'none',
        color: ink,
      }}
    >
      {GLYPH_POINTS[shape].map((points) => (
        <polyline
          key={points}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

/** How many shapes there are, so a test can say the set covers the ladder. */
export const PRIORITY_GLYPH_COUNT = GLYPH_SHAPES.length;
