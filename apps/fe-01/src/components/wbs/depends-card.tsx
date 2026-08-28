import { useEffect, useRef } from 'react';

import { HoverCard } from './hover-card';

/** One work item another waits for, as the chips have it. */
export interface DependsEntry {
  id: string;
  number: string;
  name: string;
}

/**
 * One dependency as it is written wherever this list appears: `010 - Strip the
 * hull`, the same shape the dependency picker uses.
 *
 * A function rather than two spellings, because the card is not the only place
 * this list is read: the cell's box points `aria-describedby` at an off-screen
 * copy for readers with no pointer, and a card and a description that disagreed
 * about one row's dependencies would be worse than either.
 */
export const dependsLine = (entry: DependsEntry): string => `${entry.number} - ${entry.name}`;

/** The four edges used by the state-only pointer bridge. */
export interface PointerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type DependencyPointerRegion =
  | { kind: 'owner' }
  | { kind: 'corridor' }
  | { kind: 'row'; id: string }
  | { kind: 'outside' };

const containsPoint = (point: { x: number; y: number }, box: PointerRect): boolean =>
  point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;

/**
 * Read one pointer position against the owner, live row targets and the
 * straight rectangle joining them. The corridor changes state only: it is not
 * an element and therefore cannot intercept a click through passive padding.
 */
export function dependencyPointerRegion(
  point: { x: number; y: number },
  owner: PointerRect,
  rows: readonly { id: string; rect: PointerRect }[],
): DependencyPointerRegion {
  if (containsPoint(point, owner)) return { kind: 'owner' };
  const row = rows.find(({ rect }) => containsPoint(point, rect));
  if (row !== undefined) return { kind: 'row', id: row.id };
  if (rows.length === 0) return { kind: 'outside' };

  const first = rows[0];
  const union = rows.slice(1).reduce<PointerRect>(
    (box, current) => ({
      left: Math.min(box.left, current.rect.left),
      top: Math.min(box.top, current.rect.top),
      right: Math.max(box.right, current.rect.right),
      bottom: Math.max(box.bottom, current.rect.bottom),
    }),
    {
      left: first.rect.left,
      top: first.rect.top,
      right: first.rect.right,
      bottom: first.rect.bottom,
    },
  );
  const corridor = {
    left: Math.min(owner.left, union.left),
    top: Math.min(owner.top, union.top),
    right: Math.max(owner.right, union.right),
    bottom: Math.max(owner.bottom, union.bottom),
  };
  return containsPoint(point, corridor) ? { kind: 'corridor' } : { kind: 'outside' };
}

export interface DependsCardProps {
  /** The waiting work item's number, so the card says whose list this is. */
  number: string;
  /** At least one: a cell with nothing in it opens no card. */
  entries: readonly DependsEntry[];
  /**
   * The entry whose pill the pointer is on, or null while the pointer is on
   * the cell's input area — where the whole list is the answer and no line is
   * singled out.
   *
   * Emphasised as a background swatch in the same tint the table lights the
   * entry's row with, so the card and the grid say "this one" in the same
   * voice. Not bold: a bold line among plain ones reads as a heading over the
   * list, not as a highlight in it.
   *
   * `--card-dep-lit` and not `--grid-dep-lit`, which is the same tint and not
   * the same colour: both are the same dose of `--ring` into the surface they
   * land on, and this card's surface is `--popover` where the rows' is
   * `--background`. In the dark palette those two greys sit either side of one
   * absolute mix, so a single token moved the rows lighter and this line darker
   * — see the tokens' own note in `styles.css`. In light they coincide, which
   * is why the fault only ever showed on a dark page.
   */
  emphasisedId: string | null;
  /** Narrow or widen the table/card tint as the document pointer moves. */
  onPointEntry: (entryId: string | null) => void;
  /** Clear the owner and every tint once the pointer leaves the bridge. */
  onPointerOutside: () => void;
}

/**
 * What a row is waiting for, by name.
 *
 * The cell shows `010 ✕ 030 ✕` — numbers, because a chip has room for one and
 * because the number is what somebody types to add a dependency. A number is
 * not what anyone remembers a work item by, though, and following one means
 * scrolling to that row and reading its name. This card is that trip.
 *
 * `010 - Strip the hull`, the same shape the dependency picker's list uses,
 * with the dash: a space alone let a number and a name that starts with a digit
 * run together.
 */
export function DependsCard({
  number,
  entries,
  emphasisedId,
  onPointEntry,
  onPointerOutside,
}: DependsCardProps) {
  const targets = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    const clear = () => {
      onPointerOutside();
    };
    const move = (event: PointerEvent) => {
      const first = targets.current.values().next().value;
      const owner = first?.closest('td');
      if (!(owner instanceof HTMLElement)) return;
      const rows = entries.flatMap((entry) => {
        const target = targets.current.get(entry.id);
        return target === undefined ? [] : [{ id: entry.id, rect: target.getBoundingClientRect() }];
      });
      const region = dependencyPointerRegion(
        { x: event.clientX, y: event.clientY },
        owner.getBoundingClientRect(),
        rows,
      );
      if (region.kind === 'owner') onPointEntry(null);
      else if (region.kind === 'row') onPointEntry(region.id);
      else if (region.kind === 'outside') onPointerOutside();
    };
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointercancel', clear, { passive: true });
    window.addEventListener('scroll', clear, { passive: true, capture: true });
    window.addEventListener('resize', clear, { passive: true });
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointercancel', clear);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
    };
  }, [entries, onPointEntry, onPointerOutside]);

  return (
    <HoverCard label={`What ${number} waits for`}>
      {entries.map((entry) => (
        <div
          key={entry.id}
          ref={(target) => {
            if (target === null) targets.current.delete(entry.id);
            else targets.current.set(entry.id, target);
          }}
          data-testid="depends-card-target"
          data-depends-card-target={entry.id}
          onPointerEnter={() => {
            onPointEntry(entry.id);
          }}
          onPointerLeave={(event) => {
            const owner = event.currentTarget.closest('td');
            if (owner?.contains(event.relatedTarget as Node)) onPointEntry(null);
          }}
          style={
            entry.id === emphasisedId
              ? // The row tint on *this* surface — see
                // {@link DependsCardProps.emphasisedId}. The token rather than a
                // literal, for `MATCH_TINT`'s reason: `.dark` re-points the
                // palette and a literal would not follow.
                //
                // Inset, and the inset given straight back as negative margin:
                // a swatch with no padding is a box the exact shape of the
                // glyphs, whose rounded corners cut into the first and last
                // letter and read as a rendering fault rather than as a
                // highlight. The margin is what keeps the emphasis from
                // *moving* the line it emphasises — padding alone would shift
                // this line's text 4px right of every other line's and reflow
                // the card as the pointer walked the pills.
                {
                  pointerEvents: 'auto',
                  background: 'var(--card-dep-lit)',
                  borderRadius: 4,
                  padding: '1px 4px',
                  margin: '-1px -4px',
                }
              : { pointerEvents: 'auto' }
          }
        >
          {dependsLine(entry)}
        </div>
      ))}
    </HoverCard>
  );
}
