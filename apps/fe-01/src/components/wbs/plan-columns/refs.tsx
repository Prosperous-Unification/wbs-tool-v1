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
      // The vocabulary is a mutable reading under the PlanLive contract.
      const marks = refMarksOf(row.original.externalRefs, live.current.externalSystems);
      const refsCell = cellKey(row.original.id, 'refs');
      const carded = marks.length > 0 && live.current.openCard === refsCell;
      const sentenceId = `refs-${row.original.id}`;
      return (
        <span
          // The positioned ancestor the card opens from, and — the Name
          // cell's arrangement, for the Name cell's reason — the element
          // that **closes** it: this span holds the marks *and* the card,
          // so `mouseleave` fires only once the pointer is outside both and
          // the trip from a 6px dot down to a link on the card never
          // unmounts what it is travelling to.
          style={{ position: 'relative', display: 'block' }}
          onMouseLeave={() => {
            // The same-cell guard every surface here clears with: a leave
            // fires after the enter of whatever the pointer moved on to.
            live.current.setHoveredCell((current) => (current === refsCell ? null : current));
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
              live.current.setHoveredCell(refsCell);
            }}
            onClick={() => {
              live.current.setRefsEditing(row.original.id);
            }}
            // The fixed-height box the marks are placed inside, and the
            // whole of design D2's "the dots never change the row's
            // height": every mark is out of flow, so a row wired to four
            // systems and a row wired to none lay out identically and the
            // claim is one Chromium can measure (jsdom lays nothing out —
            // `e2e/external-refs.spec.ts` is the oracle).
            //
            // The reset in `styles.css` stops at `[data-grid]`, so a
            // `<button>` in here keeps the platform's border, background
            // and padding unless it is told not to. All three are told.
            style={{
              position: 'relative',
              display: 'block',
              width: '100%',
              height: MARK_BOX_PX,
              padding: 0,
              margin: 0,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
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
              systems={live.current.externalSystems}
            />
          )}
        </span>
      );
    },
  });
}
