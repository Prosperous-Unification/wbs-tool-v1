/**
 * How far apart two edges may be before the difference is a layout fault
 * rather than the browser's own rounding, in CSS pixels.
 *
 * Half a pixel. `getBoundingClientRect` reports layout units (a 64th of a
 * pixel) and a cell's border can land either side of a whole pixel, so exact
 * equality would fail on a correct paint. Nothing this file guards against is
 * subtle: the fault class it exists for — a column laid out at one width while
 * the offsets were summed from another — moves things by tens of pixels.
 */
export const EDGE_TOLERANCE = 0.5;

/** A box on the horizontal axis, named so a failure says which one moved. */
export interface Box {
  id: string;
  x: number;
  width: number;
}

/** Two boxes that are on top of each other, in the order they were measured. */
export interface Overlap<T extends Box> {
  previous: T;
  box: T;
}

const rightOf = (box: Box): number => box.x + box.width;

/**
 * The first pair of boxes in this list that are on top of each other, or
 * nothing when every box starts at or after the end of the one before it.
 *
 * For a row of cells measured in DOM order, and only while the table is not
 * scrolled sideways. Sticky columns make this the wrong question once it is:
 * a pinned cell holding its place while the rest of the row slides *behind*
 * it is the intended paint, and an adjacent-pair sweep would read it as an
 * overlap. {@link Box.id} is carried through so the failure names the columns
 * rather than printing two anonymous rectangles.
 *
 * Proof: `EDGE_TOLERANCE` dropped from the comparison, `forgives a half-pixel,
 * which is a border rounding and not an overlap` failed; the walk changed to
 * keep the first box rather than the previous one, `reports the first offending
 * pair rather than the last` failed. Both watched, 2026-08-07.
 */
export function findOverlap<T extends Box>(boxes: readonly T[]): Overlap<T> | undefined {
  let previous: T | undefined = undefined;
  for (const box of boxes) {
    if (previous !== undefined && box.x + EDGE_TOLERANCE < rightOf(previous)) {
      return { previous, box };
    }
    previous = box;
  }
  return undefined;
}

/**
 * Which edge of its cell a control has run past, or nothing when it sits
 * inside.
 *
 * The half of the geometry jsdom cannot see. Every control in the table is
 * sized `width: 100%` of a cell whose width the `<colgroup>` declares, and a
 * control that asserts a width of its own — the `22em` name textarea this
 * change removed — overruns the column it is in. The cell clips the paint, so
 * the overrun is invisible; the layout box still reports it, which is what
 * makes this checkable at all.
 *
 * The left edge is reported first when a control overruns both, because one
 * edge is enough to fail on and the left one is where a reader starts.
 *
 * Proof: the right-edge branch replaced by `return undefined`, `says which edge
 * a control ran past on the right` failed; `EDGE_TOLERANCE` dropped from the
 * left-edge branch, `forgives a half-pixel on either edge` failed. Both
 * watched, 2026-08-07.
 */
export function findOverrun(cell: Box, control: Box): 'left' | 'right' | undefined {
  if (control.x < cell.x - EDGE_TOLERANCE) return 'left';
  if (rightOf(control) > rightOf(cell) + EDGE_TOLERANCE) return 'right';
  return undefined;
}
