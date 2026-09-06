/**
 * What two clips of the same strip disagree about, in columns.
 *
 * Slice 8.2a's browser tier compares screenshots: the rule is a hairline, and
 * the only oracle that can tell one CSS pixel from a whole day is the run of
 * painted columns it leaves. The clips are taken in Playwright and decoded in
 * the page; the arithmetic between them is here.
 *
 * Kept out of `gantt.spec.ts` for the reason `marker-rule-density.ts` is kept
 * out of `gantt-panel.tsx`: every way this can be wrong is arithmetic, and
 * arithmetic proved through a browser is proved once every CI pixels job and
 * its faults cannot be watched at all on a box that may not run browsers. Here
 * each fault is a one-line injection against a fast-tier case. What the spec
 * still owes is everything this cannot see — that the clips are of the right
 * strip, taken at the right rung, with the right element hidden.
 */

/**
 * One decoded clip: `getImageData`'s own shape, and nothing more of it than
 * this module reads.
 *
 * `data` is RGBA, four entries per pixel, row-major — the layout
 * `CanvasRenderingContext2D.getImageData` returns. `ImageData` itself is a DOM
 * type and this module is collected by the fast tier, where constructing one
 * would need a canvas; the structural type takes both the real thing and a
 * plain object.
 */
export interface ClipPixels {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/**
 * The columns in which two clips of the same strip differ.
 *
 * A column differs **iff at least one pixel in it has any RGBA channel unequal
 * to the corresponding baseline pixel** — all four channels, alpha included.
 * Comparing only RGB is the fault that reads a stroke painted at partial
 * coverage over an identical colour as no change at all, which is exactly what
 * an anti-aliased hairline is at the edges of its run.
 *
 * @throws If the clips are not the same size. Both clips come from one `strip`
 * object, so a mismatch means the page reflowed between them or a canvas was
 * left at its default 300×150 — a measurement that did not happen, and a
 * measurement that did not happen must never read as an empty difference.
 */
export function differingColumns(baseline: ClipPixels, after: ClipPixels): number[] {
  if (baseline.width !== after.width || baseline.height !== after.height) {
    throw new Error(
      `clips are ${String(baseline.width)}×${String(baseline.height)} and ` +
        `${String(after.width)}×${String(after.height)}; ` +
        'the same strip decoded twice cannot change size',
    );
  }
  const columns: number[] = [];
  for (let x = 0; x < baseline.width; x += 1) {
    for (let y = 0; y < baseline.height; y += 1) {
      const at = (y * baseline.width + x) * 4;
      if (
        baseline.data[at] !== after.data[at] ||
        baseline.data[at + 1] !== after.data[at + 1] ||
        baseline.data[at + 2] !== after.data[at + 2] ||
        baseline.data[at + 3] !== after.data[at + 3]
      ) {
        columns.push(x);
        break;
      }
    }
  }
  return columns;
}

/**
 * Whether the differing columns are one run with no gap in it.
 *
 * A vertical hairline paints one run. Two hairlines a column apart paint two
 * columns and are still contiguous — that hole is closed by
 * {@link sameColumns}, not here — but a rule in one place and stray ink in
 * another paint two runs, and a bound on the *count* alone would accept them.
 *
 * The empty set is **not** contiguous: a rule that never painted has no run,
 * and reading "no gaps" off zero columns is how the lower half of the 1-or-2
 * bound gets lost.
 */
export function isContiguousRun(columns: readonly number[]): boolean {
  if (columns.length === 0) return false;
  const sorted = [...columns].sort((a, b) => a - b);
  return sorted[sorted.length - 1] - sorted[0] === sorted.length - 1;
}

/**
 * Whether two column sets are the same set.
 *
 * An equality, not a containment: 8.2a's binding is that the ink the marker
 * adds and the ink the queried rule adds are the *same* columns, and a
 * one-directional check passes the very renderer the assertion exists to
 * catch — an untagged line one column over makes the marker's ink a strict
 * superset of the rule's, and `ruleInk ⊆ totalInk` is true of it.
 *
 * Order and repeats do not count; the sets come from independent scans.
 */
export function sameColumns(left: readonly number[], right: readonly number[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size !== b.size) return false;
  for (const column of a) {
    if (!b.has(column)) return false;
  }
  return true;
}
