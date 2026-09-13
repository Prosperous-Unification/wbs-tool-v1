import type { Step, StepRemoved, StepStore, StepUsageRows } from '@wbs/core';
import { STEP_POSITION_STEP } from '@wbs/domain';

/**
 * A `Step` row carrying every field the schema requires.
 *
 * `position` is `STEP_POSITION_STEP`, the spacing `add` gives a project's first
 * step, so a row this builds sorts where production would put it.
 */
export function stepRow(overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    projectId: 'project',
    name: 'Build',
    position: STEP_POSITION_STEP,
    ...overrides,
  };
}

/**
 * A StepStore backed by an array, for tests that only need `buildApp` to be
 * constructible.
 *
 * It keeps the one rule a caller branches on — a name a project already holds
 * is refused — because a fixture laxer than production lets a test pass against
 * behaviour that does not exist.
 *
 * **What it deliberately does not model** is everything the removal is: the
 * revisions, and the fact that the deletes and the bumps are one transaction.
 * An array has no statement to put them in, so claiming them here would be a
 * second implementation of the rule under test. `remove` therefore reports what
 * it took and nothing else, and every behavioural claim about a removal is
 * asserted against real SQLite in `repository/step.test.ts` and
 * `service/step.service.test.ts` — the same call `subtree-fixture.ts` makes,
 * for the same reason.
 */
export interface MemoryStepTable {
  readonly rows: Step[];
}

export function memoryStepTable(seed: readonly Step[] = []): MemoryStepTable {
  return { rows: structuredClone([...seed]) };
}

export function inMemorySteps(
  seed: readonly Step[] = [],
  table: MemoryStepTable = memoryStepTable(seed),
): StepStore & { readonly rows: Step[] } {
  const { rows } = table;
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */
  return {
    rows,
    listByProject(projectId) {
      // Sorted, because production is: without the `ORDER BY` SQLite answers
      // this from the name index, and a fixture that happened to return
      // insertion order would let a test pass against an order production does
      // not produce.
      return Promise.resolve(
        rows
          .filter((each) => each.projectId === projectId)
          .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)),
      );
    },
    findById(stepId) {
      return Promise.resolve(rows.find((each) => each.id === stepId) ?? null);
    },
    add(toAdd, _stamp) {
      const held = rows.filter((each) => each.projectId === toAdd.projectId);
      if (held.some((each) => each.name === toAdd.name)) {
        return Promise.resolve({ ok: false, reason: 'taken' });
      }
      const written: Step = {
        ...toAdd,
        position: Math.max(0, ...held.map((each) => each.position)) + STEP_POSITION_STEP,
      };
      rows.push(written);
      return Promise.resolve({ ok: true, step: written });
    },
    rename(stepId, name, _stamp) {
      const found = rows.find((each) => each.id === stepId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      const taken = rows.some(
        (each) => each.projectId === found.projectId && each.name === name && each.id !== stepId,
      );
      if (taken) return Promise.resolve({ ok: false, reason: 'taken' });
      found.name = name;
      return Promise.resolve({ ok: true, step: found });
    },
    usageOf(): Promise<StepUsageRows> {
      // Nothing points at a step here: this fixture holds no estimates, no
      // actuals, no stated progress, no figures and no assignments to point
      // with.
      return Promise.resolve({
        estimates: 0,
        actuals: 0,
        progress: 0,
        measures: 0,
        assignments: [],
      });
    },
    remove(projectId, stepId, _cascade, _stamp): Promise<StepRemoved> {
      const found = rows.findIndex((each) => each.id === stepId && each.projectId === projectId);
      // The one thing this can model of the real removal: a step that is not
      // this project's, or is already gone, is `not_found` and writes nothing.
      // The refusal-when-used branch is unreachable here because nothing can
      // point at a step in an array with no estimates in it — which is also why
      // `cascade` is named and never read: there is nothing pointing at the step
      // for it to decide about.
      if (found < 0) return Promise.resolve({ ok: false, reason: 'not_found' });
      rows.splice(found, 1);
      return Promise.resolve({
        ok: true,
        removal: {
          estimates: 0,
          actuals: 0,
          progress: 0,
          measures: 0,
          assignments: 0,
          workItemIds: [],
        },
      });
    },
  };
}
