import { useCardOpenOn } from '../cell-card-store';
import { cellKey } from '../editable-grid';
import { MARK_BOX_PX, markStyle, refMarksOf, refMarksSentence } from '../external-ref-marks';
import { ExternalRefsCard } from '../external-refs-card';
import type { PlanLive } from '../plan-live';
import { LinkIcon } from '../toolbar-icons';
import { column } from './column';

/** Builds the refs column family against the stable live cell contract. */
export function createRefsColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'refs',
    // **A drawn link, not the word.** `Prio`'s bargain — five characters
    // at the header's 10px all-caps inside a 32px envelope — does not
    // survive here: `LINKS` ran under the `NAME` heading beside it, which
    // Dany photographed on 2026-08-31. A shape has no such width.
    //
    // The `sr-only` word is not decoration. {@link LinkIcon} is
    // `aria-hidden` like every icon in that file, so without it this
    // column heading announces nothing at all — and a heading is what a
    // screen reader names every cell under it by.
    header: () => (
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <LinkIcon />
        <span className="sr-only">Links</span>
      </span>
    ),
    cell: ({ row }) => {
      // A subscription and not a reading off `live`: this cell is a component,
      // so it can be told about its own card without the table rendering.
      // First, and unconditionally, because it is a hook.
      // `flexRender` builds this with `React.createElement`, so it **is** a
      // component and the hook below is legal; the rule reads the property
      // name `cell` and cannot see the call site.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const cardOpen = useCardOpenOn(live.current.cellCards, cellKey(row.original.id, 'refs'));
      // The vocabulary is the immutable directory reading for this render.
      const marks = refMarksOf(row.original.externalRefs, row.original.readings.externalSystems);
      const refsCell = cellKey(row.original.id, 'refs');
      const carded = marks.length > 0 && cardOpen;
      const sentenceId = `refs-${row.original.id}`;
      return (
        <span
          // The positioned ancestor the card opens from, and — the Name
          // cell's arrangement, for the Name cell's reason — the element
          // that **closes** it: this span holds the marks *and* the card,
          // so `mouseleave` fires only once the pointer is outside both and
          // the trip from a 6px dot down to a link on the card never
          // unmounts what it is travelling to.
          //
          // **Absolute, filling the `<td>`, because the card is armed by the
          // whole cell** since 2026-09-09. Dany, that day: _"i want hover over
          // the whole cell surface to trigger the tooltip"_ — the hover target
          // had been a 28×12 box inside a 40×26 cell, so a pointer resting
          // anywhere else in the column got nothing.
          //
          // `position: relative` with `height: '100%'` was the first attempt and
          // **does not work**: a percentage height on a child of a `table-cell`
          // is undefined in the spec and Chromium does not resolve it, so the
          // box fell back to its content's 12px and the cell's bottom-right
          // corner still armed nothing (watched: `the bottom right of the cell
          // opened no card`). An absolutely positioned box resolves `inset`
          // against the **padding box of the nearest positioned ancestor**,
          // which here is the `<td>` itself — every cell in this column is
          // `position: sticky`, and sticky is positioned. So `inset: 0` is
          // exactly the cell's own rectangle, padding included, and
          // `e2e/external-refs.spec.ts` asserts the two boxes match rather than
          // trusting that sentence.
          //
          // Out of flow, so this cell contributes no height at all to its row —
          // which strengthens design D2's "the dots never change the row's
          // height" rather than weakening it: the row is the Name cell's, as it
          // already was.
          style={{ position: 'absolute', inset: 0, display: 'block' }}
          onMouseLeave={() => {
            // Cleared the instant the pointer leaves, with no grace period —
            // **and a grace period was written, measured and deleted.** It
            // existed because a card *under* this 40px cell is reached by a path
            // that leaves the cell sideways first, so the card closed under the
            // hand reaching for it. Opening the card **beside** the cell removed
            // the gap instead of covering it: the card's left edge is the cell's
            // right edge, so the pointer crosses straight onto it and then walks
            // down the list without ever leaving this wrapper. With the card
            // beside the cell the whole timer could be taken out and
            // `e2e/external-refs.spec.ts`'s walk still passed, which is the one
            // reason to delete a guard rather than keep it.
            //
            // The same-cell guard stays: a leave fires after the enter of
            // whatever the pointer moved on to.
            live.current.cellCards.updateHovered((current) =>
              current === refsCell ? null : current,
            );
          }}
        >
          <button
            type="button"
            data-refs-cell={row.original.id}
            aria-label={`Links for ${row.original.number}`}
            // The whole cell in one sentence for a reader with no pointer
            // — the card's content, which a pointer is the only other way
            // to reach. Absent on a row with no links, so nothing is
            // announced about a cell that says nothing.
            aria-describedby={marks.length === 0 ? undefined : sentenceId}
            onMouseEnter={() => {
              live.current.cellCards.updateHovered(() => refsCell);
            }}
            onClick={() => {
              live.current.setRefsEditing(row.original.id);
            }}
            // **The whole cell, and the marks centred in it.** The button is
            // the hover and click surface and it fills the `<td>`; the 12px box
            // inside it is where the marks are placed. Two boxes rather than
            // one because they answer different questions — how much of the
            // column a pointer may rest on, and where the dots sit — and until
            // 2026-09-09 one box answered both, at 28×12 in a 40×26 cell.
            //
            // The reset in `styles.css` stops at `[data-grid]`, so a
            // `<button>` in here keeps the platform's border, background
            // and padding unless it is told not to. All three are told.
            style={{
              display: 'flex',
              alignItems: 'center',
              // The whole of the span above, which is the whole of the cell.
              // Percentages resolve here because the span has a definite size —
              // it is absolutely positioned with `inset: 0`.
              width: '100%',
              height: '100%',
              // The 4px `CELL` gives every `<td>` horizontally, put back where
              // the marks are drawn rather than where the pointer is read: the
              // span above covers the padding so a hover lands anywhere in the
              // column, and this keeps the dots at the same x they have always
              // been drawn at.
              padding: '0 4px',
              margin: 0,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <span
              // The fixed-height box the marks are placed inside, and the
              // whole of design D2's "the dots never change the row's
              // height": every mark is out of flow **inside this**, so a row
              // wired to four systems and a row wired to none lay out
              // identically and the claim is one Chromium can measure (jsdom
              // lays nothing out — `e2e/external-refs.spec.ts` is the oracle,
              // and it measures the marks against *this* box rather than
              // against the button, which now fills the cell and would contain
              // them however they were placed).
              data-ref-marks-box
              style={{
                position: 'relative',
                display: 'block',
                width: '100%',
                height: MARK_BOX_PX,
                flexShrink: 0,
              }}
            >
              {marks.map((mark, at) => (
                <span
                  key={mark.kind}
                  role="img"
                  // Design D3's third channel: the column is readable with
                  // no colour at all, because every mark says what it stands
                  // for and how many links it covers.
                  aria-label={mark.label}
                  data-ref-mark={mark.kind}
                  style={markStyle(mark.kind, at)}
                >
                  {mark.kind === 'overflow' ? '+' : null}
                </span>
              ))}
            </span>
          </button>
          {marks.length > 0 && (
            <span id={sentenceId} hidden>
              {refMarksSentence(marks)}
            </span>
          )}
          {carded && (
            <ExternalRefsCard
              number={row.original.number}
              refs={row.original.externalRefs}
              systems={row.original.readings.externalSystems}
            />
          )}
        </span>
      );
    },
  });
}
