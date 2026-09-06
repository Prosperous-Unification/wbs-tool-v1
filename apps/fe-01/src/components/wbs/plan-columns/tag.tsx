import { cellKey } from '../editable-grid';
import type { PlanLive } from '../plan-live';
import { ReferenceSetStrip } from '../reference-set-field';
import { column } from './column';

/** Builds the tag column family against the stable live cell contract. */
export function createTagColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'tag',
    header: 'Tags',
    cell: ({ row }) => {
      // **Not** the reading the Team cell makes. A row with no tags of its
      // own still *is* whatever an ancestor said it was — and since ADR
      // 0008 so is a row that has tags of its own, because a tag says what
      // kind of thing the work is and adding one adds a word rather than
      // replacing the sentence. Adding `Ready` to 010.1 and watching
      // `Risk` and `Review` disappear from the cell was the 2026-08-29
      // report.
      //
      // So the inheritance is drawn as **chips** here, where the team's is
      // a placeholder: a placeholder is only visible on an empty box, and
      // this cell is not empty in the case the report is about. The chips
      // wear `↳` and no ✕ — see `REFERENCE_SET_INHERITED_CHIP_CLASS` — and
      // `inheritedLabel` is deliberately not passed beside them, or the
      // same claim would be on screen twice.
      const tagging = live.current.effectiveTagLabelOf(row.original);
      const own = row.original.tagIds;
      return (
        <ReferenceSetStrip
          label={`Tags for ${row.original.number}`}
          addLabel={`Add a tag to ${row.original.number}`}
          removeLabel={(entry) => `Remove ${entry.name} from ${row.original.number}`}
          placeholder={own.length > 0 || tagging.inherited.length > 0 ? 'add' : 'search'}
          data-fact={
            tagging.inherited.length === 0
              ? undefined
              : tagging.inherited
                  .map((each) => `${each.name} — inherited from ${each.fromRow}. Remove it there.`)
                  .join('\n')
          }
          adapter={{
            kind: 'tag',
            entries: live.current.tags,
            ownIds: own,
            inheritedEntries: tagging.inherited,
            replace: (tagIds) => live.current.setTagsOf(row.original.id, tagIds),
            create: (name, current) => live.current.createTagFor(row.original.id, name, current),
          }}
          gridCell={{
            dataCell: cellKey(row.original.id, 'tag'),
            onTabKey: (e) => {
              live.current.onTabKey(e, row.original.id, 'tag');
            },
            onCommandKey: (e) => {
              live.current.onCommandKey(e, row.original, 'tag');
            },
            onAltMove: (e) => {
              live.current.onAltMove(e, row.original, 'tag');
            },
          }}
        />
      );
    },
  });
}
