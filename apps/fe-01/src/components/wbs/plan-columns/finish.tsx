import type { PlanLive } from '../plan-live';
import { column } from './column';

/** Builds the finish column family against the stable live cell contract. */
export function createFinishColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'finish',
    header: () => <span>End</span>,
    cell: ({ row }) => {
      const finish = live.current.spanOf(row.original).finish;
      // Both facts in one `title`, because a cell has one: the day in full,
      // and — where the figure is a guess — what the marker beside it means.
      const said = [finish.iso, row.original.schedule.estimated ? null : 'No estimate yet']
        .filter((part) => part !== null)
        .join(' — ');
      return (
        <span data-finish data-fact={said === '' ? undefined : said}>
          {finish.text}
          {live.current.hasSchedule() && !row.original.schedule.estimated ? ' ?' : ''}
        </span>
      );
    },
  });
}
