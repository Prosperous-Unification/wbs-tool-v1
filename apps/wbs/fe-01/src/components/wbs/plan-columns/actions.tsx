import { ActionsMenu } from '../actions-menu';
import type { PlanLive } from '../plan-live';
import { column } from './column';

/** Builds the actions column family against the stable live cell contract. */
export function createActionsColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'actions',
    header: () => <span aria-label="Row actions" />,
    cell: ({ row }) => (
      <ActionsMenu
        number={row.original.number}
        // Menu state follows the PlanLive contract, so opening one preserves cells.
        open={row.original.readings.actionsOpen}
        busy={row.original.readings.busy}
        onOpen={() => {
          live.current.setOpenMenuRowId(row.original.id);
        }}
        onClose={() => {
          // Only this row's own menu, so a menu that has already been
          // replaced by another row's cannot close the new one on its way
          // out.
          live.current.setOpenMenuRowId((current) =>
            current === row.original.id ? null : current,
          );
        }}
        actions={[
          {
            id: 'duplicate',
            // Offered on a frozen row as well, unlike Delete and unlike
            // moving one: a freeze pins the number a row left the tool
            // under, and the copy is given none. Copying is not moving.
            label: 'Duplicate',
            run: () => {
              void live.current.duplicateRow(row.original.id);
            },
          },
          ...(row.original.frozenNumber === null
            ? []
            : [
                {
                  id: 'unfreeze',
                  label: 'Unfreeze',
                  run: () => {
                    void live.current.run(() => live.current.api.unfreezeWorkItem(row.original.id));
                  },
                },
              ]),
          {
            id: 'delete',
            label: 'Delete',
            // Present and refused on a frozen row rather than absent, and
            // it carries the real `run` deliberately: an item whose action
            // was stubbed out could not tell a working guard from a
            // missing one. {@link MenuAction.refusedBecause} is what stops
            // it, and the test that watches it stop is the proof.
            ...(row.original.frozenNumber === null
              ? {}
              : { refusedBecause: 'Frozen — unfreeze this row before deleting it' }),
            run: () => {
              void live.current.deleteRow(row.original);
            },
          },
        ]}
      />
    ),
  });
}
