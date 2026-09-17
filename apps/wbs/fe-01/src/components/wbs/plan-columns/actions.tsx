import { SETTABLE_STATUSES } from '@wbs/domain/progress';

import { ActionsMenu } from '../actions-menu';
import { isoToday } from '../gantt-panel';
import type { PlanLive } from '../plan-live';
import { STATUS_LABEL } from '../status-cell';
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
          // The status entries first — every settable status but the one the
          // row reads, so a row in progress offers both — then Duplicate, then
          // Unfreeze where it applies, and Delete last in the destructive tint
          // (Dany, 2026-09-13: "Set status * … Duplicate … Delete in the end").
          // `Set status to Done` asks for the days through the completion
          // prompt exactly as the cell does; `In progress` is a step's statement
          // and is not offered. The status word is drawn as the status card
          // draws it — bold, `Done` in green — so a status is said one way
          // everywhere.
          ...SETTABLE_STATUSES.filter((status) => status !== row.original.status).map((status) => ({
            id: `set-${status}`,
            label: `Set status to ${STATUS_LABEL[status]}`,
            lead: {
              word: STATUS_LABEL[status],
              ...(status === 'done' ? { tone: 'done' as const } : {}),
            },
            run: () => {
              if (status === 'done') {
                live.current.openCompletionPrompt(row.original.id);
                return;
              }
              void live.current.setStatus(row.original.id, status, isoToday(new Date()));
            },
          })),
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
                    void live.current.run((write) =>
                      write.perform(['tree'], () =>
                        live.current.api.unfreezeWorkItem(row.original.id),
                      ),
                    );
                  },
                },
              ]),
          {
            id: 'delete',
            label: 'Delete',
            destructive: true,
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
