import type { MeasureMetric } from '@wbs/domain';
import {
  agree,
  type EstimateRule,
  finalDays,
  NOT_STARTED,
  stateOf,
  type WorkItemState,
} from '@wbs/domain';

import type { StoredActual } from '../ports/actual-store';
import type { StoredEstimate } from '../ports/estimate-store';
import type { StoredMeasure } from '../ports/measure-store';
import type { StoredProgress } from '../ports/progress-store';
import type { WorkItem } from '../ports/work-item-store';
import type { Days } from './numbered-work-item';

const add = (a: Days, b: Days): Days => ({
  optimistic: a.optimistic + b.optimistic,
  realistic: a.realistic + b.realistic,
  pessimistic: a.pessimistic + b.pessimistic,
});

/**
 * The one traversal both roll-ups are: a leaf's own figures, a parent's the sum
 * of its descendants', and a step nobody has a figure for **absent** rather
 * than zero.
 *
 * Generic over the figure, and it is generic for one reason rather than for
 * elegance. Estimates and actuals share every structural rule — the same key,
 * leaves only, absence meaning "nobody has said" — and a second hand-written
 * fold beside this one is how the two come to disagree about a case neither
 * author was thinking about: an empty parent, a step held by one child of three,
 * a branch nested four deep. There is one recursion and it is tested once.
 *
 * `held` is read into a per-item map first, so an item that holds rows for two
 * steps is one entry with two keys — and so a row naming a work item that is not
 * in `rows` is ignored rather than throwing, which is what a stale read looks
 * like.
 */
function foldByStep<T>(
  rows: readonly WorkItem[],
  held: ReadonlyMap<string, ReadonlyMap<string, T>>,
  combine: (a: T, b: T) => T,
): Map<string, Map<string, T>> {
  const childrenOf = new Map<string | null, WorkItem[]>();
  for (const row of rows) {
    const group = childrenOf.get(row.parentId) ?? [];
    group.push(row);
    childrenOf.set(row.parentId, group);
  }

  const totals = new Map<string, Map<string, T>>();
  const totalFor = (id: string): Map<string, T> => {
    const cached = totals.get(id);
    if (cached !== undefined) return cached;

    const children = childrenOf.get(id) ?? [];
    const total = new Map<string, T>();
    if (children.length === 0) {
      for (const [stepId, figure] of held.get(id) ?? []) total.set(stepId, figure);
    } else {
      for (const child of children) {
        for (const [stepId, figure] of totalFor(child.id)) {
          const running = total.get(stepId);
          total.set(stepId, running === undefined ? figure : combine(running, figure));
        }
      }
    }
    totals.set(id, total);
    return total;
  };

  for (const row of rows) totalFor(row.id);
  return totals;
}

/**
 * Every work item's estimates by step: its own if it is a leaf, the sum of its
 * descendants' otherwise.
 *
 * A step no descendant estimated is **absent** from the map rather than zero.
 * The two look identical in a spreadsheet and mean opposite things — "this needs
 * no QA" against "nobody has looked at the QA yet" — and only one of them is a
 * plan you can commit to.
 *
 * Computed on read and never stored, so there is no second copy to fall out of
 * date with the estimates it came from.
 */
export function rollUp(
  rows: readonly WorkItem[],
  estimates: readonly StoredEstimate[],
): Map<string, Map<string, Days>> {
  const ownOf = new Map<string, Map<string, Days>>();
  for (const held of estimates) {
    const byStep = ownOf.get(held.workItemId) ?? new Map<string, Days>();
    byStep.set(held.stepId, {
      optimistic: held.optimistic,
      realistic: held.realistic,
      pessimistic: held.pessimistic,
    });
    ownOf.set(held.workItemId, byStep);
  }
  return foldByStep(rows, ownOf, add);
}

/**
 * Every work item's **charged** days by step: a leaf's own estimate combined and
 * rounded by `rule`, and a parent's the sum of its descendants' **rounded**
 * figures.
 *
 * The order is the product decision and the reason this is not derived from
 * {@link rollUp}: each step is rounded where it is estimated, and the sums are
 * taken over whole days afterwards. Rolling the triples up first and rounding
 * the parent's combined figure once — which is what `finalsOf` did until
 * `estimate-weights-and-rounding` — charges two children holding half a day
 * each as **one** day while the two rows beneath show one day apiece and the
 * chart draws two. See
 * `docs/adr/0011-final-days-are-whole-days-rounded-per-step.md`.
 *
 * A parent's rolled-up **estimate** is still the sum of the triples
 * ({@link rollUp}); this is what the plan charges rather than what its rows
 * said, and the two are allowed to differ now.
 *
 * A step no descendant estimated is absent here as it is everywhere else — a
 * zero would say somebody costed it at nothing.
 */
export function rollUpFinals(
  rows: readonly WorkItem[],
  estimates: readonly StoredEstimate[],
  rule: EstimateRule,
): Map<string, Map<string, number>> {
  const ownOf = new Map<string, Map<string, number>>();
  for (const held of estimates) {
    const byStep = ownOf.get(held.workItemId) ?? new Map<string, number>();
    byStep.set(held.stepId, finalDays(held, rule));
    ownOf.set(held.workItemId, byStep);
  }
  return foldByStep(rows, ownOf, (a, b) => a + b);
}

/**
 * Every work item's **recorded** days by step, folded exactly as the estimates
 * are: its own if it is a leaf, the sum of its descendants' otherwise.
 *
 * A step nobody has recorded days against is **absent**, never zero — the rule
 * this whole table is built on. A parent whose children hold no actuals at all
 * therefore comes back with an empty map, which reads as "nobody has recorded
 * anything under here" and not as "no days were spent on it".
 *
 * Note what this deliberately does not do: it never mixes in an estimate. A
 * branch where one child of three has an actual reports that child's days and
 * nothing else, so the number is the sum of what was recorded rather than a
 * projection of what the rest might take. Reading the two side by side is the
 * point, and it only works while each is what it says it is.
 */
export function rollUpActuals(
  rows: readonly WorkItem[],
  actuals: readonly StoredActual[],
): Map<string, Map<string, number>> {
  const ownOf = new Map<string, Map<string, number>>();
  for (const held of actuals) {
    const byStep = ownOf.get(held.workItemId) ?? new Map<string, number>();
    byStep.set(held.stepId, held.days);
    ownOf.set(held.workItemId, byStep);
  }
  return foldByStep(rows, ownOf, (a, b) => a + b);
}

/**
 * Every work item's recorded figures **in one metric**, by step, folded exactly
 * as the days are: its own if it is a leaf, the sum of its descendants'
 * otherwise.
 *
 * **One metric per call, and that is the decision.** `measures` is the whole
 * project's rows in all three units, and folding them together would mean
 * either three parallel maps threaded through one recursion or a fold whose
 * combine has to know which unit each pair of numbers is in. Both are ways of
 * writing "add tokens to hours" and having it typecheck. Filtering to a metric
 * first makes the figures inside the fold commensurable by construction — the
 * only reason adding them is meaningful at all — and the caller pays three
 * traversals of a tree it already has in memory.
 *
 * A step nobody has recorded this metric for is **absent**, never zero, and
 * absence is per metric: a pair holding a `token_actual` and nothing else is
 * absent from `hours_actual` while being present here. That is the primary key's
 * shape arriving at the read path — see `StoredMeasure` and design.md D1.
 *
 * A **recorded** zero is kept and summed, exactly as {@link rollUpActuals} keeps
 * one: "this cost nothing" is a statement somebody made, and it is not the same
 * fact as nobody having said.
 */
export function rollUpMeasures(
  rows: readonly WorkItem[],
  measures: readonly StoredMeasure[],
  metric: MeasureMetric,
): Map<string, Map<string, number>> {
  const ownOf = new Map<string, Map<string, number>>();
  for (const held of measures) {
    if (held.metric !== metric) continue;
    const byStep = ownOf.get(held.workItemId) ?? new Map<string, number>();
    byStep.set(held.stepId, held.value);
    ownOf.set(held.workItemId, byStep);
  }
  return foldByStep(rows, ownOf, (a, b) => a + b);
}

/** The pair every figure and every statement in this tool is keyed by. */
interface Keyed {
  workItemId: string;
  stepId: string;
}

/**
 * Which steps have work on each work item: the ones with an estimate, the ones
 * with a recorded day, and the ones somebody has already spoken about.
 *
 * The candidate set {@link rollUpProgress} folds over, and the reason it is
 * built from all three lists rather than from the statements alone is argued
 * there: a step with an estimate and no statement is a step that has **not
 * started**, and a fold that cannot see it reports finished items that are not.
 */
export function workedStepsOf(
  estimates: readonly Keyed[],
  actuals: readonly Keyed[],
  stated: readonly Keyed[],
): Map<string, Set<string>> {
  const worked = new Map<string, Set<string>>();
  for (const each of [...estimates, ...actuals, ...stated]) {
    const steps = worked.get(each.workItemId) ?? new Set<string>();
    steps.add(each.stepId);
    worked.set(each.workItemId, steps);
  }
  return worked;
}

/**
 * Every work item's state **by step**, folded through the same traversal the
 * two figures are — with `agree` as the combine rather than addition.
 *
 * The one thing this does that neither figure roll-up does: a leaf's map is
 * filled out over **every step that has work on that row**, not only the steps
 * somebody has stated. `worked` is that set — the steps with an estimate, an
 * actual or a statement — and a step in it that nobody has spoken about reads as
 * {@link NOT_STARTED}.
 *
 * That is what makes `done` mean something. Without it, a leaf where Dev says
 * done and QA has an estimate and has said nothing would fold to `{dev: done}`
 * and read as a **finished** work item, because the only voice in the fold
 * agreed with itself. With it the fold is `{dev: done, qa: not_started}`, and
 * the item reads as in progress — which is the true sentence about that row.
 *
 * Parents fold from their children exactly as the figures do. `agree` is
 * associative, so folding a branch from its children's states and folding it
 * from every step beneath it reach the same answer, and there is no traversal of
 * the tree that changes what a branch reads as.
 *
 * Proof: `worked` replaced by the stated steps alone and `is in progress when
 * one step is done and another has said nothing` fails with `done` where
 * `in_progress` is owed — an item claiming to be finished over untested work;
 * watched 2026-08-18.
 */
export function rollUpProgress(
  rows: readonly WorkItem[],
  stated: readonly StoredProgress[],
  worked: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Map<string, WorkItemState>> {
  const ownOf = new Map<string, Map<string, WorkItemState>>();
  for (const [workItemId, stepIds] of worked) {
    const byStep = new Map<string, WorkItemState>();
    for (const stepId of stepIds) byStep.set(stepId, NOT_STARTED);
    ownOf.set(workItemId, byStep);
  }
  for (const said of stated) {
    // Every stated row's own work item is in `worked` by construction — the
    // caller builds that set from the states as well as the figures — so this
    // never invents an entry. Written defensively anyway: a stale read that
    // dropped one would otherwise silently lose the statement rather than the
    // row, and losing a `done` is the direction that lies.
    const byStep = ownOf.get(said.workItemId) ?? new Map<string, WorkItemState>();
    byStep.set(said.stepId, said.state);
    ownOf.set(said.workItemId, byStep);
  }
  return foldByStep(rows, ownOf, agree);
}

/**
 * What each work item reads as: a leaf, {@link stateOf} across the steps it
 * holds work for; a parent, {@link stateOf} across its **children's** readings.
 *
 * Derived here and **never stored**, which is the decision the whole change
 * rests on. A stored item state beside per-step states is two sources of truth
 * about one subject, and the disagreement it produces is exactly the one this
 * feature exists to remove: the item saying done while a step on it has said
 * nothing.
 *
 * **Over the children rather than over the parent's own rolled-up step map**,
 * and the difference is a real one rather than a refactor. `foldByStep` only
 * combines the steps its children actually hold, so a child with no estimate, no
 * recorded day and nothing said contributes no key at all — and a branch of two
 * whose first child is finished and whose second is empty would fold to
 * `{dev: done}` and read as **done**. That is a claim about the empty child that
 * nobody made. Counting every child, an empty one included, is the same rule the
 * step level already follows: silence keeps the thing in progress.
 *
 * The consequence is worth stating because it looks like an inconsistency and is
 * not: such a branch reports `progress: {dev: done}` and `state: in_progress` at
 * once. Both are true — Dev has finished everywhere Dev has work, and the branch
 * is not finished because one of its rows has never been spoken about.
 *
 * Proof: folded from the parent's own step map instead of from its children, and
 * `a branch is not done while one of its rows has never been spoken about` fails
 * with `done` — a finished branch over an untouched row; watched 2026-08-18.
 */
export function rollUpWorkItemStates(
  rows: readonly WorkItem[],
  byStep: ReadonlyMap<string, ReadonlyMap<string, WorkItemState>>,
): Map<string, WorkItemState> {
  const childrenOf = new Map<string | null, WorkItem[]>();
  for (const row of rows) {
    const group = childrenOf.get(row.parentId) ?? [];
    group.push(row);
    childrenOf.set(row.parentId, group);
  }
  const answers = new Map<string, WorkItemState>();
  const stateFor = (id: string): WorkItemState => {
    const cached = answers.get(id);
    if (cached !== undefined) return cached;
    const children = childrenOf.get(id) ?? [];
    const answer =
      children.length === 0
        ? stateOf(byStep.get(id)?.values() ?? [])
        : stateOf(children.map((child) => stateFor(child.id)));
    answers.set(id, answer);
    return answer;
  };
  for (const row of rows) stateFor(row.id);
  return answers;
}
export type { Days } from './numbered-work-item';
