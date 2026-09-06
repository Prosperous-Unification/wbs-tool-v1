import { cellKey } from '../editable-grid';
import type { PlanLive } from '../plan-live';
import { MismatchMark } from '../plan-mismatch';
import { ReferenceSetStrip } from '../reference-set-field';
import { column } from './column';

/** Builds the service column family against the stable live cell contract. */
export function createServiceColumn({ live }: { live: PlanLive }) {
  return column.display({
    // **The column id stays `service` while the header reads `Services`.**
    // The id is what `DEFAULT_HIDDEN_COLUMNS`, `cellKey`, the grid's
    // Tab/Alt/Command routing and every saved column-order key are written
    // against; renaming it would move 120px around and rewrite people's
    // stored layouts to say the same thing. The header is the word a
    // reader sees, and since task 10.4 a row can carry several.
    id: 'service',
    header: 'Services',
    cell: ({ row }) => {
      // The **tags** cell's control since task 10.4, where 7.1 built the
      // team cell's: a chip per service the row states, each with its own
      // ✕, and a picker beside them that adds one. A row that states none
      // of its own still **is** delivered by whatever an ancestor said, and
      // the placeholder says so in the box's own muted ink with `↳` for the
      // inheritance — that half is unchanged, because inheritance is per
      // dimension and blank still means inherit.
      //
      // The single-select this replaces was D2's shape: one service, one
      // nullable column. The 2026-08-21 scope change made it a set and
      // task 10.2 made the store a join table, so a single-select was by
      // then a control that could not express what the row already held.
      const inherited = live.current.effectiveServiceLabelOf(row.original);
      const own = row.original.serviceIds;
      // Task 7.2's first marker, on the cell its signal is about. The
      // **effective** reading, so a leaf inheriting a service it is not
      // owned to build is marked where the inheritance put the service —
      // which is why the note comes off `nonOwnerNoteOf` and not off
      // `own` above it, and why a row stating no service of its own can
      // still wear it.
      const nonOwner = live.current.nonOwnerNoteOf(row.original);
      return (
        // The mark and the strip share **one** line, and this is the
        // wrapper 4b found standing two lines tall.
        //
        // `ReferenceSetStrip` is a `display: flex` span, so it is
        // block-level and claims the whole line: its hypothetical size
        // beside a `flex: none` triangle is already the full width, and
        // `wrap` therefore put it under the mark **every** time the mark
        // was drawn — not in a crowded cell, in any cell with a
        // non-owner note. Every reference cell's own strip measured
        // 24.2px in Chromium while this wrapper measured 41.6 and the
        // row 43.6 (measured in Chromium, 2026-08-29). `nowrap` shares
        // the line instead: the mark keeps its size and the strip
        // shrinks past it and clips.
        //
        // Proof: `wrap` restored here, `e2e/reference-cells.spec.ts`'s
        // `three tags stand the row taller than a row with none` failed
        // on `Expected: <= 27.1875 / Received: 43.640625` — with both
        // flex containers inside the strip already saying `nowrap`,
        // which is why the jsdom style assertions on them all passed
        // while the row stood two lines tall. Watched 2026-08-29.
        <span style={{ display: 'flex', flexWrap: 'nowrap', gap: 2, minWidth: 0 }}>
          {nonOwner !== null && <MismatchMark kind="service" note={nonOwner} />}
          <ReferenceSetStrip
            label={`Services for ${row.original.number}`}
            addLabel={`Add a service to ${row.original.number}`}
            removeLabel={(entry) => `Remove ${entry.name} from ${row.original.number}`}
            placeholder={
              own.length > 0
                ? 'add'
                : inherited.state === 'inherited'
                  ? `↳ ${inherited.names.join(', ')}`
                  : 'search'
            }
            data-fact={
              own.length === 0 && inherited.state === 'inherited'
                ? `${inherited.names.join(', ')} — inherited from ${inherited.fromRow}. This row carries no service of its own.`
                : undefined
            }
            adapter={{
              kind: 'service',
              entries: live.current.services,
              ownIds: own,
              inheritedLabel:
                inherited.state === 'inherited' ? inherited.names.join(', ') : undefined,
              replace: (serviceIds) => live.current.setServicesOf(row.original.id, serviceIds),
              create: (name, current) =>
                live.current.createServiceFor(row.original.id, name, current),
            }}
            gridCell={{
              dataCell: cellKey(row.original.id, 'service'),
              onTabKey: (e) => {
                live.current.onTabKey(e, row.original.id, 'service');
              },
              onCommandKey: (e) => {
                live.current.onCommandKey(e, row.original, 'service');
              },
              onAltMove: (e) => {
                live.current.onAltMove(e, row.original, 'service');
              },
            }}
          />
        </span>
      );
    },
  });
}
