import { type TreeRow } from './wbs-rows';

/**
 * Every row on the plan by id, built once per tree rather than once per lookup.
 *
 * `dependenciesOf` scanned `flat` for each id it was handed, and every Depends
 * on cell calls it once per render: on a thousand-row plan whose rows wait for
 * eight others that is eight million comparisons to draw one column. Rebuilt
 * whenever `flat` is, which is every tree read, so it cannot name a row the
 * plan no longer holds.
 */
export function indexRowsById(rows: readonly TreeRow[]): ReadonlyMap<string, TreeRow> {
  const byId = new Map<string, TreeRow>();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

/**
 * Any directory vocabulary as a lookup by id.
 *
 * The label and assignee readings asked `teams.find(...)`, `services.find(...)`
 * and `people.find(...)` **per row**, so naming a plan's labels was
 * O(rows × directory) once per vocabulary. A directory changes when its own read
 * lands, which is rarely, so the index is memoised on the list it indexes.
 */
export function indexById<T extends { id: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/** Which steps somebody on the plan is named for. */
export interface AssignedSteps {
  /**
   * True when some row names one person for **every** step it has
   * (`doesEveryStep`), which staffs a step no row lists by id.
   */
  everyStep: boolean;
  /** The steps at least one row names somebody for by id. */
  named: ReadonlySet<string>;
}

/**
 * One pass over the plan for `anyAssigneeOn`.
 *
 * That question is asked by **every folded step cell**, so answering it with a
 * scan of `flat` cost rows × steps × rows comparisons per render — a quarter of
 * a million on a five-hundred-row plan with two steps, to decide whether the
 * column reserves an assignee slot. Read over `flat` rather than over the whole
 * tree, so a filter that hides the only assigned row takes the slot with it,
 * which is the behaviour the callback already had.
 */
export function assignedSteps(rows: readonly TreeRow[]): AssignedSteps {
  const named = new Set<string>();
  let everyStep = false;
  for (const row of rows) {
    if (row.doesEveryStep !== null) everyStep = true;
    for (const stepId of Object.keys(row.assignees)) {
      if (row.assignees[stepId] !== undefined) named.add(stepId);
    }
  }
  return { everyStep, named };
}
