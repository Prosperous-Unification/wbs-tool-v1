import {
  deadlineOffsetsOf,
  effectiveTeamsOf,
  type EstimateRule,
  type IsoDate,
  type Schedule,
  schedule,
  type Slice,
  workdaysBetween,
} from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';

import type { PlanInputReads, SavedPlanCaptureStore } from '../ports/saved-plan-capture-store';
import { NO_DEADLINES, slicesOf } from './work-item.service';

/**
 * The dates a captured plan has, computed from the captured values alone.
 *
 * Every argument `schedule()` takes is derived here from {@link PlanInputReads}
 * and from nothing else: no store, no connection, no second read. That is the
 * whole point of slice 3 and the reason {@link PlanInputReads} is kept apart
 * from `PlanInputRows` — a scheduling pass is the most expensive thing this
 * feature does, and running it inside the capture's read transaction would hold
 * a WAL reader open for the length of a levelling run on somebody else's
 * database.
 *
 * The derivation mirrors the live projection's (`work-item.service.ts`
 * `:1320-1448`) and shares its `slicesOf`, so a saved plan and the live plan
 * schedule the same numbers the same way. What it deliberately does **not**
 * mirror is the projection's `try`/`catch`: a plan with a dependency cycle
 * throws out of here. Turning that into a typed absent schedule is 5.4's row
 * (`pending`, and the other reasons), and swallowing it now would leave that
 * row nothing to test.
 */
export function scheduleInputOfCaptured(reads: PlanInputReads): ScheduleInput {
  const rows = reads.workItems;
  const rule: EstimateRule = {
    method: reads.project.estimateMethod,
    pertWeights: reads.project.pertWeights,
    rounding: reads.project.estimateRounding,
  };
  const hasChildren = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  // The same fold the projection does over its own `assignmentsOf` read: one
  // entry per work item, step id to person id.
  const assigneesOf = new Map<string, Record<string, string>>();
  for (const each of reads.assignments) {
    assigneesOf.set(each.workItemId, {
      ...(assigneesOf.get(each.workItemId) ?? {}),
      [each.stepId]: each.personId,
    });
  }
  const slices: Slice[] = slicesOf(
    rows,
    reads.estimates,
    hasChildren,
    reads.steps.map((each) => each.id),
    rule,
    assigneesOf,
    effectiveTeamsOf(rows),
    reads.capacity,
  );
  // A manual date is an offset before the pass, exactly as in the projection:
  // the engine never sees a calendar, so weekends are counted in one place.
  // Without a project start date there is nothing to count from and the
  // constraints are simply not applied.
  const notBefore = new Map<string, number>();
  if (reads.project.startDate !== null) {
    for (const row of rows) {
      if (row.startNoEarlierThan === null) continue;
      notBefore.set(row.id, workdaysBetween(reads.project.startDate, row.startNoEarlierThan));
    }
  }
  // The seventh argument, folded exactly as the live projection folds it
  // (`work-item.service.ts` `:418-428`) and keyed **as authored** — parents
  // included, not pre-expanded to leaves, because `leafDeadlinesOf` inside
  // `schedule()` owns the expansion and doing it twice is how the hash and the
  // fold come to disagree. `NO_DEADLINES` is imported from the projection
  // rather than declared again here: the empty case is one frozen map, so a
  // capture cannot be handed a map somebody later writes into.
  //
  // Without a project start date there is nothing to count an offset from, the
  // same reason `notBefore` above is left empty — and the same branch the
  // projection takes, so the two agree about a project that has no start.
  const deadlines =
    reads.project.startDate === null
      ? NO_DEADLINES
      : deadlineOffsetsOf(
          reads.project.startDate,
          new Map(
            rows
              .filter((row): row is typeof row & { deadline: IsoDate } => row.deadline !== null)
              .map((row) => [row.id, row.deadline]),
          ),
        );
  return {
    rows,
    edges: reads.dependencies,
    slices,
    notBefore,
    poolSizes: reads.capacity,
    reach: reads.project.depReach,
    deadlines,
  };
}

/** Schedules the canonical seven-field input derived from detached capture reads. */
export function schedulePlanInput(reads: PlanInputReads): Schedule {
  const input = scheduleInputOfCaptured(reads);
  return schedule(
    input.rows,
    input.edges,
    input.slices,
    input.notBefore,
    input.poolSizes,
    input.reach,
    input.deadlines,
  );
}

/** One project's captured plan input and the dates computed from it. */
export interface CapturedPlan {
  readonly reads: PlanInputReads;
  readonly planned: Schedule;
}

/**
 * Capture a project's plan input, then schedule it — in that order, with the
 * read snapshot released in between.
 *
 * The ordering is the guarantee, so it is written as two statements rather than
 * as one expression: {@link SavedPlanCaptureRepository.readPlanInput} commits
 * its transaction and closes its connection before it returns, and only then
 * does anything schedule. No database handle this call opened is live while
 * {@link schedulePlanInput} runs.
 *
 * `schedulePlan` is injected for the same reason `openConnection` is injected
 * into the capture: it is the seam a test observes the *instant* of the
 * scheduling call through. A test that only checks the connection count before
 * and after would stay green if a later edit moved the scheduling inside the
 * transaction, which is the one thing this row exists to forbid.
 */
export async function captureAndSchedulePlan(
  capture: SavedPlanCaptureStore,
  projectId: string,
  schedulePlan: (reads: PlanInputReads) => Schedule = schedulePlanInput,
): Promise<CapturedPlan | null> {
  const reads = await capture.readPlanInput(projectId);
  if (reads === null) return null;
  return { reads, planned: schedulePlan(reads) };
}
