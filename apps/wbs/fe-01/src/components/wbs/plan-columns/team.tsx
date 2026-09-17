import { cellKey } from '../editable-grid';
import type { PlanLive } from '../plan-live';
import { ReferenceSetStrip } from '../reference-set-field';
import { column } from './column';

/** Builds the team column family against the stable live cell contract. */
export function createTeamColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'team',
    meta: { isEditable: () => true },
    header: 'Teams',
    cell: ({ row }) => {
      // A row with no label of its own still belongs to a team, wherever an
      // ancestor named one — and the plan's dates were computed against
      // that team's people. The cell says so in the box's own muted
      // placeholder ink, which is exactly the "shown but not stored"
      // distinction a placeholder already means: it is gone the moment
      // somebody types a label of this row's own, and nothing about it is
      // sent anywhere. `↳` is the inheritance, in one glyph the 120px
      // column can afford.
      //
      // No write copies a label down. This is a reading of the tree and it
      // is recomputed from the tree every render; the day somebody moves
      // the row, its answer changes with it.
      const inherited = row.original.readings.teamLabel;
      return (
        <ReferenceSetStrip
          label={`Service or team for ${row.original.number}`}
          addLabel={`Add a team to ${row.original.number}`}
          placeholder={inherited.state === 'inherited' ? `↳ ${inherited.name}` : 'search or add'}
          data-fact={
            inherited.state === 'inherited'
              ? `${inherited.name} — inherited from ${inherited.fromRow}. This row carries no team of its own.`
              : undefined
          }
          adapter={{
            kind: 'team',
            entries: row.original.readings.teams,
            ownIds: row.original.teamIds,
            inheritedLabel: inherited.state === 'inherited' ? inherited.name : undefined,
            replace: (teamIds) => live.current.setTeamOf(row.original.id, teamIds),
            create: (name, current) => live.current.createTeamFor(row.original.id, name, current),
          }}
          gridCell={{
            dataCell: cellKey(row.original.id, 'team'),
            onTabKey: (e) => {
              live.current.onTabKey(e, row.original.id, 'team');
            },
            onCommandKey: (e) => {
              live.current.onCommandKey(e, row.original, 'team');
            },
            onAltMove: (e) => {
              live.current.onAltMove(e, row.original, 'team');
            },
          }}
        />
      );
    },
  });
}
