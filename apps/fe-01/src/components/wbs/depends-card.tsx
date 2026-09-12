import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { DepLights } from './dep-light-store';
import { HoverCard } from './hover-card';
import { rowWords } from './work-item-words';

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
export const dependsLine = (entry: DependsEntry): string => rowWords(entry.number, entry.name);

/** The four edges used by the state-only pointer bridge. */
export interface PointerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type DependencyPointerRegion =
  { kind: 'owner' } | { kind: 'corridor' } | { kind: 'row'; id: string } | { kind: 'outside' };

const containsPoint = (point: { x: number; y: number }, box: PointerRect): boolean =>
  point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;

/**
 * Read one pointer position against the owner cell, the card's live row targets
 * and the card's own rectangle. The corridor changes state only: it is not an
 * element and therefore cannot intercept a click through passive padding.
 *
 * The corridor is **the card's own box**, and was the bounding box of the owner
 * and its lines until 2026-09-09. That shape belonged to a card standing under
 * its cell: the pointer had to cross a gap the card did not fill, so the region
 * that held the card had to be the rectangle spanning both. Since
 * the card opens **beside** its cell ({@link sidewaysPlacement})
 * there is no gap — the card's left edge is inside its `<td>` (measured 419
 * against a cell ending at 423, Chromium 2026-09-09) — and a bounding box is
 * now actively wrong: it fills the whole rectangle *below* the owner as well,
 * which is the Depends on cell of the next row down. That held the enter which
 * crosses the row boundary, so walking the pointer down the column left 020's
 * card open over 030's cell and 030 never answered for itself. Dany, that day:
 * _"i want to be able to move cursor up and down and see other hover-ons"_.
 *
 * `card` is `null` for the frame before the card has a box, which is `outside`
 * for every point that is not the owner's or a line's — the card is not on
 * screen yet, so there is nothing to hold.
 */
export function dependencyPointerRegion(
  point: { x: number; y: number },
  owner: PointerRect,
  rows: readonly { id: string; rect: PointerRect }[],
  card: PointerRect | null,
): DependencyPointerRegion {
  if (containsPoint(point, owner)) return { kind: 'owner' };
  const row = rows.find(({ rect }) => containsPoint(point, rect));
  if (row !== undefined) return { kind: 'row', id: row.id };
  if (card !== null && containsPoint(point, card)) return { kind: 'corridor' };
  return { kind: 'outside' };
}

/**
 * The open card's own rectangle, read from one of the lines inside it.
 *
 * Through the line rather than by querying for a card: the lines are the handle
 * {@link DependsCard}'s own bridge already holds, and a card found any other way
 * could be another cell's.
 */
export function cardRectOf(line: Element | undefined): PointerRect | null {
  const card = line?.closest('[role="tooltip"]') ?? null;
  return card === null ? null : card.getBoundingClientRect();
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
   *
   * **Subscribed rather than handed in** since 2026-09-02: it was a prop read
   * off `WbsTable`'s state, so moving the pointer between two entries of an
   * open card re-rendered every row and cell of the plan to move a background
   * on one line. {@link DepLights.pillFor} carries the guard the prop's own
   * caller used to — a card is only on screen for the hovered cell, but a stale
   * reading from another row would otherwise emphasise an entry here.
   */
  depLights: DepLights;
  /** Whose card this is, which is what {@link DepLights.pillFor} is asked about. */
  rowId: string;
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
  depLights,
  rowId,
  onPointEntry,
  onPointerOutside,
}: DependsCardProps) {
  const emphasisedId = useSyncExternalStore(depLights.subscribe, () => depLights.pillFor(rowId));
  const targets = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    const ownerCell = (): HTMLElement | null => {
      const first = targets.current.values().next().value;
      const owner = first?.closest('td');
      return owner instanceof HTMLElement ? owner : null;
    };
    const clear = (event: Event) => {
      // A scroll *inside* the owner cell moves nothing this card is anchored
      // to: the cell's clipped rest line is an `overflow: hidden` span, and
      // Chromium scrolls it on the card's own mount. React 18 flushed the
      // effect that attaches this listener after that scroll had passed;
      // React 19 flushes it in time to hear it, and the card closed in the
      // same gesture that opened it — logged in Chromium on 2026-09-06 as
      // `clear scroll target=SPAN inCard=false`. The page, the table and any
      // ancestor scroller still close the card, which is what this is for.
      //
      // Proof: with this return removed, `travels through passive card space
      // to the third row and leaves empty padding click-through`
      // (`e2e/hover-cards.spec.ts`) failed under React 19 on `the owner did
      // not open its dependency card · Expected: 1 · Received: 0`.
      if (
        event.type === 'scroll' &&
        event.target instanceof Node &&
        ownerCell()?.contains(event.target)
      ) {
        return;
      }
      onPointerOutside();
    };
    const move = (event: PointerEvent) => {
      // A pill under the pointer is the pill's own to report: its `mouseenter`
      // narrowed the light to one row, and the owner-cell region this listener
      // would otherwise answer with (`onPointEntry(null)`, every row lit) is
      // the cell's reading, not the pointer's. React 18 never raced this:
      // the card mounts on the cell's enter and this listener is attached
      // from an effect, which React 18 flushed after the gesture's own
      // `pointermove` had passed. React 19 flushes it in time to see that
      // very event — logged in Chromium on 2026-09-06 as settle(cell) →
      // pill enter → settle(pill) → onPointEntry(null) → settle(cell), with
      // the pointer at rest on the pill — so the listener has to know a pill
      // when it is on one.
      //
      // Proof: with this return removed, `narrows to one pill when the
      // pointer settles on it, from the cell` (`e2e/deps-cell.spec.ts`) and
      // three cases of `e2e/hover-cards.spec.ts` failed under React 19 on
      // `- Expected - 0 / + Received + 1` — `['040', '050']` where `['040']`
      // was owed; all four pass on React 18 either way.
      if (
        event.target instanceof Element &&
        event.target.closest('[data-reference-chip]') !== null
      ) {
        return;
      }
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
        cardRectOf(first),
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
    // **Beside its cell, not under it**, which is the links card's scheme and
    // for the same reason one column over. Dany, 2026-09-09: _"i want to be
    // able to move cursor up and down and see other hover-ons"_. Every line of
    // this card takes the pointer — that is how the light narrows to one row —
    // so a card standing under its cell put a pointer-taking surface over the
    // Depends on cells of the rows below: measured in Chromium on 2026-09-09,
    // walking from 020's cell down to 030's, `elementFromPoint` at 030's own
    // cell answered a `DIV` inside the card and the open card was still `What
    // 020 waits for`. Opened sideways the column below is clear and each row
    // answers for itself.
    //
    // Two guards written for the old placement went with it, both dead rather
    // than merely quiet: `entersThroughDependsCard`, which swallowed a cell's
    // or a chip's `mouseenter` that landed inside the card's passive padding
    // (no Depends on cell but this card's own is under it now), and the
    // corridor's bounding box (see {@link dependencyPointerRegion}).
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
