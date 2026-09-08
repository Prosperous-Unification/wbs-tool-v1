import { useFilterReading } from '../plan-cell-reading-context';
import { CARET_GUTTER_PX, NUMBER_ENVELOPE, numberIndentFor } from '../table-frame';
import { column } from './column';

/** Builds the number column from its row and immutable filter reading. */
export function createNumberColumn() {
  return column.display({
    id: 'number',
    // `#`, which is what a column of work item numbers is called on every
    // spreadsheet a reader of this table has ever used — and 105px of a
    // 1280px laptop is not where the word `Number` earns its eight
    // characters. The accessible name is the word, on the glyph itself:
    // `#` is punctuation a screen reader announces as "number sign" or
    // skips outright, and the column header is read once per cell by
    // anything walking the table.
    meta: { spokenHeading: 'Number' },
    header: () => <span>#</span>,
    cell: ({ row }) => {
      // `flexRender` invokes this as a component, so the explicit cell
      // provider can be read here without teaching the row model about Find.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const { filtering } = useFilterReading();
      return (
        <span
          // The whole number, but **only when the cell is not showing it**:
          // the column is sized to `NUMBER_ENVELOPE` and there is no longest
          // number to size it to instead, so a number past the envelope is
          // clipped by {@link CELL}'s `overflow: hidden` and read here. The
          // same bargain the short dates make.
          //
          // Dany, 2026-09-01: _"also remove tooltips from # cells; why it
          // needed?"_ — and for `010` it was a card that said `010`, which
          // is a card repeating the screen on every row a cursor crosses.
          // The words are worth their interruption only where the glyphs
          // are actually missing, which is what the length compares.
          //
          // Character length rather than dotted depth, because the clip is
          // by pixels: `1000.10` is two levels and still wider than the
          // envelope it is measured against.
          //
          // Spread rather than written as `undefined`, so an ordinary row
          // carries no attribute at all for `e2e/hints.spec.ts`'s sweep to
          // find.
          // `numberIndentFor`, the capped half of the indent pair: this
          // column's declared width is what the cap protects, and the share
          // it withholds past `DEEPEST_INDENT` is carried by the Name cell
          // beside it.
          {...(row.original.number.length > NUMBER_ENVELOPE.length
            ? { 'data-fact': row.original.number }
            : {})}
          style={{ paddingLeft: numberIndentFor(row.depth), whiteSpace: 'nowrap' }}
        >
          {/*
              No triangles while a search is on. What is open during a search
              is the search's answer — every kept row, so no match can be
              hidden — and this control would have to either lie about that or
              close a branch holding a hit. Its state also lives in the
              reader's own expansion, which the search deliberately does not
              touch, so a click here would appear to do nothing.
            */}
          <span data-caret-gutter style={{ display: 'inline-block', width: CARET_GUTTER_PX }}>
            {row.getCanExpand() && !filtering ? (
              <button
                type="button"
                aria-label={`${row.getIsExpanded() ? 'Collapse' : 'Expand'} ${row.original.number}`}
                onClick={row.getToggleExpandedHandler()}
              >
                {row.getIsExpanded() ? '▾' : '▸'}
              </button>
            ) : null}
          </span>
          <span data-number>{row.original.number}</span>
          {/*
              After the number, not before it. A marker in front shifts the
              number right on the rows that have one, which is the same fault
              the gutter above exists to fix — and this one moves a row against
              its own siblings rather than against a whole depth.
            */}
          {row.original.frozenNumber !== null && <span aria-label="Number is frozen">🔒</span>}
        </span>
      );
    },
  });
}
