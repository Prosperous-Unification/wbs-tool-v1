import type { StepView, WorkItemView } from '@/lib/wbs-api';

/**
 * One leaf work item and the steps it holds no estimate for.
 *
 * `rowId` rather than `workItemId` because this is what a {@link CellRef} is
 * built from: the badge's job is to put the focus in a cell, and the two names
 * would have to be kept in step for no gain.
 */
export interface LeafGap {
  rowId: string;
  /** In the step list's order, so the first one is the leftmost column. */
  missingStepIds: readonly string[];
}

/** How many leaves hold no estimate for one step. */
export interface StepGap {
  stepId: string;
  stepName: string;
  count: number;
}

/**
 * What a plan is still short of, counted two ways that must not be confused.
 *
 * `leaves` is work items — one entry however many steps it is missing, which
 * is what "3 unestimated" means. `perStep` is step-sized gaps, which is what
 * "2 missing Dev, 3 missing QA" means. Summing `perStep` would double-count a
 * work item nobody has costed at all, and that number would be larger than the
 * number of rows a reader can go and fix.
 */
export interface EstimateGaps {
  /** In the order the work items were given, which is the order on screen. */
  leaves: readonly LeafGap[];
  /** In the step list's order. A step nobody is missing is absent, not zero. */
  perStep: readonly StepGap[];
}

/**
 * The leaves this plan cannot be scheduled from, per step.
 *
 * Plan completeness, not a filter: the question is "is this plan ready?" the
 * day before a review, and today a leaf with no estimate contributes zero days
 * in silence — its row's finish shows `?` and the total below it is simply
 * wrong by however long that work takes.
 *
 * Two rules, both load-bearing:
 *
 * 1. **Leaves only.** A work item with children owns no estimates of its own
 *    (`CONTEXT.md`, "Estimate"); its figures are a roll-up. Counting it would
 *    report a gap with nothing to type into, and count the child that is the
 *    real gap twice.
 * 2. **Per step.** A leaf costed for Dev and not for QA is incomplete. Whether
 *    an estimate exists is `Object.hasOwn`, not a truthiness test: a stored
 *    `0 / 0 / 0` is somebody saying this costs nothing, which is an answer.
 *
 * Leaf-ness is read from `parentId` rather than from a nested `subRows`,
 * because the caller holds the flattened tree and a row's children may be
 * collapsed out of sight without ceasing to exist.
 */
export function findEstimateGaps(
  workItems: readonly Pick<WorkItemView, 'id' | 'parentId' | 'estimates'>[],
  steps: readonly StepView[],
): EstimateGaps {
  const parentIds = new Set(
    workItems.flatMap((workItem) => (workItem.parentId === null ? [] : [workItem.parentId])),
  );
  const leaves = workItems.flatMap((workItem) => {
    // Proof: replaced with `if (false)`, `never counts a parent, whose figures
    // are rolled up from below`, `counts a parent whose children are all
    // estimated as nothing at all` and the table's `opens a collapsed branch…`
    // all failed — the parent was reported as a gap of its own. Watched,
    // 2026-08-06.
    if (parentIds.has(workItem.id)) return [];
    // Proof: reduced to "has any estimate at all", five tests failed — among
    // them `judges each step separately, so Dev alone is still incomplete` and
    // the table's `lands the focus in the cell of the first step that leaf is
    // missing`, which stood in front of a Dev figure that was already there.
    // Watched, 2026-08-06.
    const missingStepIds = steps
      .filter((step) => !Object.hasOwn(workItem.estimates, step.id))
      .map((step) => step.id);
    return missingStepIds.length === 0 ? [] : [{ rowId: workItem.id, missingStepIds }];
  });
  // One counting pass rather than a filter per step. It was `steps.flatMap`
  // over `leaves.filter` over `missingStepIds.includes` — O(steps² × leaves),
  // because the inner `includes` walks a list whose length is the step count.
  // The answer is the same list in the same order: `steps` still decides the
  // order and a step nothing is missing is still dropped.
  const missingPerStep = new Map<string, number>();
  for (const leaf of leaves) {
    for (const stepId of leaf.missingStepIds) {
      // A step absent from the map has been missed by nobody yet, which is a
      // count of zero rather than an unknown.
      missingPerStep.set(stepId, (missingPerStep.get(stepId) ?? 0) + 1);
    }
  }
  const perStep = steps.flatMap((step) => {
    const count = missingPerStep.get(step.id) ?? 0;
    return count === 0 ? [] : [{ stepId: step.id, stepName: step.name, count }];
  });
  return { leaves, perStep };
}

/**
 * The per-step counts as a sentence — the readiness badge's title.
 *
 * Empty when nothing is missing, which the badge never asks for: it is not
 * rendered at all when the plan is complete. A complete plan needs no badge,
 * and a green tick that is always there is a thing to stop seeing.
 */
export function describeGaps(gaps: EstimateGaps): string {
  return gaps.perStep.map((step) => `${String(step.count)} missing ${step.stepName}`).join(', ');
}
