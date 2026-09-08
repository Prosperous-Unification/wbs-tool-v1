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
}

function intersecting(entries: readonly ViewportEntry[], startPx: number, endPx: number) {
  return entries.filter((entry) => entry.startPx < endPx && entry.startPx + entry.sizePx > startPx);
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
}: RowViewportInput): ViewportSlice {
  let startPx = 0;
  const all = rowIds.map((id, index) => {
    const measured = heights.get(id);
    const sizePx = measured ?? estimatedHeight;
    const entry = { id, index, startPx, sizePx };
    startPx += sizePx;
    return entry;
  });
  const entries = intersecting(
    all,
    Math.max(0, scrollTop - overscanPx),
    scrollTop + viewportHeight + overscanPx,
  );
  const first = entries.at(0);
  const last = entries.at(-1);
  return {
    beforePx: first?.startPx ?? 0,
    afterPx: last === undefined ? startPx : startPx - last.startPx - last.sizePx,
    entries,
    totalPx: startPx,
  };
}

/** Resolves scrolling columns while retaining every pinned identity column. */
export function viewportColumns({
  columns,
  scrollLeft,
  viewportWidth,
  overscanPx,
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
    .filter(({ id, pinned }) => pinned || windowed.has(id))
    .map(({ id, index, startPx: columnStartPx, sizePx }) => ({
      id,
      index,
      startPx: columnStartPx,
      sizePx,
    }));
  const omitted = all.filter(({ pinned, id }) => !pinned && !windowed.has(id));
  const firstMountedScrolling = all.find(({ pinned, id }) => !pinned && windowed.has(id));
  const beforePx = omitted
    .filter(
      ({ index }) => firstMountedScrolling !== undefined && index < firstMountedScrolling.index,
    )
    .reduce((sum, { sizePx }) => sum + sizePx, 0);
  const afterPx = omitted.reduce((sum, { sizePx }) => sum + sizePx, 0) - beforePx;
  return { beforePx, afterPx, entries, totalPx: startPx };
}
