import { showDay } from '../plan-number-format';
import { column } from './column';

/** Builds the float column from the immutable reading attached to each row. */
export function createFloatColumn() {
  return column.display({
    id: 'float',
    header: () => <span>Slack</span>,
    cell: ({ row }) => {
      // A critical row has no slack to print, and the word that replaces
      // the figure is not a figure: the attribute is what lets `styles.css`
      // set it as a tag rather than as a number in the column's own type.
      // One word, not the `— critical` it was: the column is 56px and the
      // tag has to fit inside it, which the dash and the space did not.
      // `plan-export.ts` has printed the bare word since it was written.
      if (!row.original.readings.hasSchedule) {
        return (
          <span
            data-float
            data-fact="No schedule could be worked out, so there is no slack to show."
          >
            —
          </span>
        );
      }
      if (row.original.schedule.critical) {
        return (
          <span
            data-float
            data-critical="true"
            data-fact="On the critical path: any delay here moves the whole plan’s finish."
          >
            critical
          </span>
        );
      }
      const days = showDay(row.original.schedule.float);
      return (
        <span
          data-float
          data-fact={`This work item can slip ${days} workday${days === '1' ? '' : 's'} before the plan finishes later.`}
        >
          {days}
        </span>
      );
    },
  });
}
