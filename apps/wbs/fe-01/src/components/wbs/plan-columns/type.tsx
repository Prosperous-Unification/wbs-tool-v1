import { cellKey } from '../editable-grid';
import type { PlanLive } from '../plan-live';
import { ReferenceSetStrip } from '../reference-set-field';
import { column } from './column';

/** Builds the type column family against the stable live cell contract. */
export function createTypeColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'type',
    meta: { isEditable: () => true },
    header: 'Types',
    cell: ({ row }) => {
      // The reference family's fourth cell, and the shortest of them,
      // because everything the other three do about inheritance is absent
      // here by design.
      //
      // No `inherited` read, no `↳` placeholder, no `title` explaining an
      // ancestor: a work item type does not inherit, so a blank cell means
      // "nobody has said" and nothing else
      // (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`). The
      // three cells above all have to distinguish "states none of its own"
      // from "has none at all"; this one does not, and the missing lines
      // are the difference.
      //
      // Every chip is removable for the same reason — nothing drawn here
      // was stated somewhere else, so there is no chip that would need its
      // ✕ withheld the way an inherited tag's does.
      const own = row.original.typeIds;
      return (
        <ReferenceSetStrip
          label={`Types for ${row.original.number}`}
          addLabel={`Add a type to ${row.original.number}`}
          removeLabel={(entry) => `Remove ${entry.name} from ${row.original.number}`}
          placeholder={own.length > 0 ? 'add' : 'search'}
          adapter={{
            kind: 'type',
            entries: row.original.readings.workItemTypes,
            ownIds: own,
            replace: (typeIds) => live.current.setTypesOf(row.original.id, typeIds),
            create: (name, current) => live.current.createTypeFor(row.original.id, name, current),
          }}
          gridCell={{
            dataCell: cellKey(row.original.id, 'type'),
            onTabKey: (e) => {
              live.current.onTabKey(e, row.original.id, 'type');
            },
            onCommandKey: (e) => {
              live.current.onCommandKey(e, row.original, 'type');
            },
            onAltMove: (e) => {
              live.current.onAltMove(e, row.original, 'type');
            },
          }}
        />
      );
    },
  });
}
