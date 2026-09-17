export interface ViewportEntry {
  id: string;
  index: number;
  startPx: number;
  sizePx: number;
}

export interface ViewportSlice {
  beforePx: number;
  afterPx: number;
  entries: ViewportEntry[];
  totalPx: number;
}

interface RowViewportInput {
  rowIds: readonly string[];
  heights: ReadonlyMap<string, number>;
  estimatedHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscanPx: number;
  pinnedIds?: ReadonlySet<string>;
}

export interface ViewportColumn {
  id: string;
  widthPx: number;
  pinned: boolean;
}

interface ColumnViewportInput {
  columns: readonly ViewportColumn[];
  scrollLeft: number;
  viewportWidth: number;
  overscanPx: number;
  pinnedIds?: ReadonlySet<string>;
}

function intersecting(entries: readonly ViewportEntry[], startPx: number, endPx: number) {
  return entries.filter((entry) => entry.startPx < endPx && entry.startPx + entry.sizePx > startPx);
}

/** Places every logical row from measured heights and the declared initial estimate. */
export function placeRows(
  rowIds: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimatedHeight: number,
): ViewportEntry[] {
  let startPx = 0;
  return rowIds.map((id, index) => {
    const sizePx = heights.get(id) ?? estimatedHeight;
    const entry = { id, index, startPx, sizePx };
    startPx += sizePx;
    return entry;
  });
}

/**
 * Resolves the mounted row interval from measured heights and one explicit estimate.
 * Unmeasured rows are a modeled state; malformed measurements are not.
 */
export function viewportRows({
  rowIds,
  heights,
  estimatedHeight,
  scrollTop,
  viewportHeight,
  overscanPx,
  pinnedIds,
}: RowViewportInput): ViewportSlice {
  const all = placeRows(rowIds, heights, estimatedHeight);
  const totalPx = all.at(-1)?.startPx ?? 0;
  const lastSizePx = all.at(-1)?.sizePx ?? 0;
  const windowed = new Set(
    intersecting(
      all,
      Math.max(0, scrollTop - overscanPx),
      scrollTop + viewportHeight + overscanPx,
    ).map(({ id }) => id),
  );
  // Proof: omitting the pinned-id union, `retains an explicitly pinned row
  // outside the ordinary interval` failed on `expected [ 'd' ] to deeply equal
  // [ 'a', 'd' ]`. Watched, 2026-09-08.
  const entries = all.filter(({ id }) => windowed.has(id) || pinnedIds?.has(id) === true);
  const first = entries.at(0);
  const last = entries.at(-1);
  return {
    beforePx: first?.startPx ?? 0,
    afterPx:
      last === undefined ? totalPx + lastSizePx : totalPx + lastSizePx - last.startPx - last.sizePx,
    entries,
    totalPx: totalPx + lastSizePx,
  };
}

/** Resolves scrolling columns while retaining every pinned identity column. */
export function viewportColumns({
  columns,
  scrollLeft,
  viewportWidth,
  overscanPx,
  pinnedIds,
}: ColumnViewportInput): ViewportSlice {
  let startPx = 0;
  const all = columns.map(({ id, widthPx, pinned }, index) => {
    const entry = { id, index, startPx, sizePx: widthPx, pinned };
    startPx += widthPx;
    return entry;
  });
  const windowed = new Set(
    intersecting(
      all,
      Math.max(0, scrollLeft - overscanPx),
      scrollLeft + viewportWidth + overscanPx,
    ).map(({ id }) => id),
  );
  const entries = all
    .filter(({ id, pinned }) => pinned || windowed.has(id) || pinnedIds?.has(id) === true)
    .map(({ id, index, startPx: columnStartPx, sizePx }) => ({
      id,
      index,
      startPx: columnStartPx,
      sizePx,
    }));
  // A pinned active column is mounted scrolling content, not empty space.
  // Proof: omitting the pinned-id clause, `does not count an offscreen active
  // column as omitted space` failed on `afterPx: expected 100, received 200`.
  // Watched, 2026-09-08.
  const omitted = all.filter(
    ({ pinned, id }) => !pinned && !windowed.has(id) && pinnedIds?.has(id) !== true,
  );
  const firstMountedScrolling = all.find(
    ({ pinned, id }) => !pinned && (windowed.has(id) || pinnedIds?.has(id) === true),
  );
  const beforePx = omitted
    .filter(
      ({ index }) => firstMountedScrolling !== undefined && index < firstMountedScrolling.index,
    )
    .reduce((sum, { sizePx }) => sum + sizePx, 0);
  const afterPx = omitted.reduce((sum, { sizePx }) => sum + sizePx, 0) - beforePx;
  return { beforePx, afterPx, entries, totalPx: startPx };
}
