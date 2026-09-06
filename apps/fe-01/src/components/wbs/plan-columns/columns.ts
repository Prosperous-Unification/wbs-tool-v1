import { type StepView } from '@/lib/wbs-api';

import type { PlanLive } from '../plan-live';
import { createActionsColumn } from './actions';
import { createDeadlineColumn } from './deadline';
import { createDependsColumn } from './depends';
import { createDragColumn } from './drag';
import { createEstimatesColumns } from './estimates';
import { createFinalTotalColumn } from './final-total';
import { createFinishColumn } from './finish';
import { createFloatColumn } from './float';
import { createInParallelColumn } from './in-parallel';
import { createNameColumn } from './name';
import { createNotBeforeColumn } from './not-before';
import { createNumberColumn } from './number';
import { createPriorityColumn } from './priority';
import { createRefsColumn } from './refs';
import { createServiceColumn } from './service';
import { createStartColumn } from './start';
import { createTagColumn } from './tag';
import { createTeamColumn } from './team';
import { createTypeColumn } from './type';

/** The column registry. Called only for steps, unfoldedSteps and hiddenColumnIds changes. */
export function createPlanColumns(
  steps: StepView[],
  unfoldedSteps: readonly string[],
  hiddenColumnIds: readonly string[],
  live: PlanLive,
) {
  return (
    [
      createDragColumn({ live }),
      createNumberColumn({ live }),
      createRefsColumn({ live }),
      createNameColumn({ live }),
      createDependsColumn({ live }),
      createPriorityColumn({ live }),
      createTeamColumn({ live }),
      createTagColumn({ live }),
      createServiceColumn({ live }),
      createTypeColumn({ live }),
      createInParallelColumn({ live }),
      ...createEstimatesColumns({ steps, unfoldedSteps, live }),
      createFinalTotalColumn(),
      createNotBeforeColumn({ live }),
      createDeadlineColumn({ live }),
      createStartColumn({ live }),
      createFinishColumn({ live }),
      createFloatColumn({ live }),
      createActionsColumn({ live }),
    ]
      // **A hidden column is not in the table model at all.** Not merely
      // unrendered: absent, so the keyboard grid, the hover cards and the
      // drag geometry never learn it was declared. Fixed columns go by their
      // own id; a hidden step takes every column named after it — folded,
      // unfolded and assignee — while the step itself stays in `steps`, so
      // its estimates still reach the total and the dates be-01 computed.
      //
      // Until `configurable-columns` two filters here rendered Tags and
      // Services only where the directory held one. The default column set
      // is data-independent now — `DEFAULT_HIDDEN_COLUMNS` in
      // `table-frame.ts` says which columns start hidden and why.
      .filter((each) => {
        // Every column above declares an id; one without is a definition this
        // filter cannot judge, and hiding it by accident would be silent.
        if (each.id === undefined) throw new Error('a column definition has no id');
        const id = each.id;
        return !hiddenColumnIds.some((hidden) => id === hidden || id.startsWith(`${hidden}-`));
      })
  );
}
