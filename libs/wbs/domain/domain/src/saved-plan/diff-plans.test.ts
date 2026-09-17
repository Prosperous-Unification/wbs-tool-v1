import { describe, expect, it } from 'bun:test';

import { canonicalisePlanInput, type CanonicalPlanInput } from './canonical-plan-input';
import {
  diffPlans,
  type PlanDiffCategory,
  type PlanDifference,
  planDiffIsEmpty,
  type PlanScheduleValue,
  type PlanSide,
  type PlanSideSchedule,
} from './diff-plans';
import { planFixtureRows, reversed } from './plan-fixture';

const input = canonicalisePlanInput(planFixtureRows);

/** A stored schedule body in the shape `buildScheduleBody` writes. */
const scheduleBody: PlanScheduleValue = {
  version: 1,
  algorithmId: 'levelled-v1',
  workItems: {
    w1: { startOffset: 0, endOffset: 3, startsOn: '2026-09-07', endsOn: '2026-09-09' },
    w2: { startOffset: 3, endOffset: 5, startsOn: '2026-09-10', endsOn: '2026-09-11' },
  },
  slices: {
    'w2:s1': { startOffset: 3, endOffset: 4, startsOn: '2026-09-10', endsOn: '2026-09-10' },
  },
  waitingForPerson: 1,
  waitingForCapacity: 0,
};

const present: PlanSideSchedule = {
  present: true,
  algorithmId: 'levelled-v1',
  body: scheduleBody,
};

function side(over: CanonicalPlanInput = input, schedule: PlanSideSchedule = present): PlanSide {
  return { input: over, schedule };
}

/** Deep clone through JSON — the values are already JSON by construction. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Every leaf path of a value, **derived from the value**.
 *
 * This is the whole point of tasks 7.2b and 7.2c: an enumerated field list here
 * stays green for every field the capture gains later, which is how a changed
 * tag, external reference, note or `start_no_earlier_than` would come to
 * compare as "no change" while being faithfully stored.
 */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leafPaths(v, `${prefix}[${String(i)}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) =>
      leafPaths(v, prefix === '' ? k : `${prefix}.${k}`),
    );
  }
  return [prefix];
}

/** Read a leaf by the path {@link leafPaths} produced. */
function segments(path: string): (string | number)[] {
  return path
    .split(/[.[\]]/)
    .filter((s) => s !== '')
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** Return a copy with one leaf changed to a value it certainly did not hold. */
function mutateAt<T>(root: T, path: string): T {
  const copy = clone(root);
  const segs = segments(path);
  const last = segs[segs.length - 1];
  const parent = segs
    .slice(0, -1)
    .reduce<unknown>(
      (node, seg) => (node as Record<string | number, unknown>)[seg],
      copy,
    ) as Record<string | number, unknown>;
  const before = parent[last];
  parent[last] =
    typeof before === 'number'
      ? before + 1
      : typeof before === 'boolean'
        ? !before
        : typeof before === 'string'
          ? `${before}~changed`
          : 'was-null';
  return copy;
}

/** The named (non-bracketed) segments of a path: `workItems[w1].name` → `workItems.name`. */
function namedSegments(path: string): string[] {
  return path
    .replace(/\[[^\]]*\]/g, '')
    .split('.')
    .filter((s) => s !== '');
}

/** The last named segment — the field a difference is about. */
function fieldOf(path: string): string {
  const named = namedSegments(path);
  return named[named.length - 1] ?? path;
}

function names(differences: readonly PlanDifference[], field: string): boolean {
  return differences.some((d) => fieldOf(d.path) === field);
}

/**
 * Does any reported difference **cover** the mutated leaf?
 *
 * Cover, not equal, and the distinction is the finding of this property rather
 * than a loosening of it. Two honest reports do not name the leaf verbatim:
 *
 * - Mutating a **key** field (`workItems[…].id`, `stepValues[…].stepId`) makes
 *   the row a different row, so the diff reports it removed and re-added — the
 *   truthful reading, and the one that keeps a large plan legible.
 * - A difference inside a **nested array** (`typeIds[0]`,
 *   `externalRefs[1].url`) is reported at the field that holds it, because the
 *   field of `CanonicalWorkItem` is `typeIds`, not `typeIds[0]`, and the
 *   coverage bound spec names is that field list.
 *
 * So the rule is: some difference's named-segment chain is a prefix of the
 * mutated leaf's. A field the comparison drops entirely produces no such
 * difference at all, which is what the two watched negatives below prove.
 */
function covers(differences: readonly PlanDifference[], mutated: string): boolean {
  const target = namedSegments(mutated);
  return differences.some((d) => {
    const reported = namedSegments(d.path);
    return reported.length <= target.length && reported.every((seg, i) => seg === target[i]);
  });
}

describe('diffPlans — 7.1, the two sides', () => {
  it('reports nothing when a plan is re-serialized unchanged', () => {
    expect(planDiffIsEmpty(diffPlans(side(), side()))).toBe(true);
  });

  it('reports nothing when the same plan arrives in the opposite row order', () => {
    const other = canonicalisePlanInput(reversed(planFixtureRows));

    expect(planDiffIsEmpty(diffPlans(side(), side(other)))).toBe(true);
  });

  it('is one function in both directions: swapping the sides swaps left and right', () => {
    const changed = mutateAt(input, 'project.name');
    const forward = diffPlans(side(), side(changed)).input;
    const back = diffPlans(side(changed), side()).input;

    expect(back.map((d) => d.path)).toEqual(forward.map((d) => d.path));
    expect(back.map((d) => [d.left, d.right])).toEqual(forward.map((d) => [d.right, d.left]));
  });
});

describe('diffPlans — 7.2, the presentation categories', () => {
  function inputDiff(next: CanonicalPlanInput): readonly PlanDifference[] {
    return diffPlans(side(), side(next)).input;
  }

  it('reports an added and a removed work item as added and removed, not as changed', () => {
    const added: CanonicalPlanInput = {
      ...input,
      workItems: [...input.workItems, { ...input.workItems[0], id: 'w9', name: 'New work' }],
    };

    const forward = inputDiff(added);
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({ category: 'added', path: 'workItems[w9]' });

    const back = diffPlans(side(added), side()).input;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ category: 'removed', path: 'workItems[w9]' });
  });

  it('separates renamed, reparented and reordered', () => {
    const [first] = input.workItems;
    const moved: CanonicalPlanInput = {
      ...input,
      workItems: input.workItems.map((row) =>
        row.id === first.id
          ? { ...row, name: `${row.name} v2`, parentId: 'w-elsewhere', position: row.position + 5 }
          : row,
      ),
    };

    const byCategory = new Map(inputDiff(moved).map((d) => [d.category, d.path]));
    expect(byCategory.get('renamed')).toBe(`workItems[${first.id}].name`);
    expect(byCategory.get('reparented')).toBe(`workItems[${first.id}].parentId`);
    expect(byCategory.get('reordered')).toBe(`workItems[${first.id}].position`);
  });

  it('reports freeze, which the category list omitted until spec named it', () => {
    const [first] = input.workItems;
    const withFreeze = (value: string | null): CanonicalPlanInput => ({
      ...input,
      workItems: input.workItems.map((row) =>
        row.id === first.id ? { ...row, frozenNumber: value } : row,
      ),
    });

    // set, cleared, and changed — all three the spec names.
    for (const [left, right] of [
      [withFreeze(null), withFreeze('7')],
      [withFreeze('7'), withFreeze(null)],
      [withFreeze('7'), withFreeze('8')],
    ] as const) {
      const differences = diffPlans(side(left), side(right)).input;
      expect(differences).toHaveLength(1);
      expect(differences[0].category).toBe('freeze');
    }
  });

  /**
   * Every category the spec's list names, reached by mutating one field.
   *
   * The list is presentation, so this is a legibility guard rather than the
   * coverage bound — 7.2b is the coverage bound. It exists because a category
   * nothing can reach is a heading a reader never sees, and because the table
   * mapping fields to categories is the one enumeration in this module and the
   * only thing that can silently drift from the spec's wording.
   */
  it('reaches every category the spec names, one field at a time', () => {
    const cases: readonly (readonly [PlanDiffCategory, string])[] = [
      ['renamed', 'workItems[0].name'],
      ['reparented', 'workItems[1].parentId'],
      ['reordered', 'workItems[0].position'],
      ['notes', 'workItems[0].notes'],
      ['type', 'workItems[1].typeIds[0]'],
      ['tags', 'workItems[1].tagIds[0]'],
      ['external-references', 'workItems[1].externalRefs[0].url'],
      ['priority', 'workItems[1].priority'],
      ['max-parallel', 'workItems[0].maxParallel'],
      ['freeze', 'workItems[0].frozenNumber'],
      ['service-assignment', 'workItems[0].serviceTeamId'],
      ['start-no-earlier-than', 'workItems[0].startNoEarlierThan'],
      ['uncertainty', 'stepValues[0].optimistic'],
      ['estimates', 'stepValues[0].derived'],
      ['actuals', 'stepValues[0].actual'],
      ['progress', 'stepValues[0].progress'],
      ['measures', 'measures[0].value'],
      ['settings', 'project.estimateMethod'],
      ['ownership', 'project.ownerId'],
      ['priority-bands', 'priorityBands[0].label'],
      ['capacity', 'capacity[0].people'],
      ['registry', 'tags[0].name'],
    ];

    for (const [category, path] of cases) {
      const differences = inputDiff(mutateAt(input, path));
      expect({ path, categories: differences.map((d) => d.category) }).toEqual({
        path,
        categories: [category],
      });
    }
  });

  it('groups dependency and assignment changes as themselves', () => {
    const noDeps: CanonicalPlanInput = { ...input, dependencies: [] };
    const noAssignments: CanonicalPlanInput = { ...input, assignments: [] };

    expect(diffPlans(side(), side(noDeps)).input.map((d) => d.category)).toEqual(
      input.dependencies.map(() => 'dependencies'),
    );
    expect(
      diffPlans(side(), side(noAssignments)).input.every((d) => d.category === 'ownership'),
    ).toBe(true);
  });

  /**
   * The only shape a relationship edit can take. Every field of a
   * `dependencies`, `assignments` or `workItemServices` row is part of its key
   * (see `ROW_KEYS`), so *changing* an edge is necessarily one row gone and one
   * row arrived — never a changed field. If row presence reported the generic
   * `added`/`removed` the spec reserves for work items, the `dependencies`,
   * `ownership` and `service-assignment` headings would be unreachable for the
   * only operation those collections have, and a rewired dependency would file
   * under the same heading as a new work item.
   */
  it('files a rewired relationship under its own heading on both sides', () => {
    const rewired: CanonicalPlanInput = canonicalisePlanInput({
      ...planFixtureRows,
      dependencies: [
        { predecessorId: 'w2', successorId: 'w1' },
        // was w1 → w2
        { predecessorId: 'w1', successorId: 'w3' },
      ],
      workItemServices: [
        { workItemId: 'w2', serviceId: 'svc-1' }, // was svc-2
        { workItemId: 'w1', serviceId: 'svc-1' },
      ],
    });
    const differences = diffPlans(side(), side(rewired)).input;
    const categoriesFor = (collection: string): string[] =>
      differences.filter((d) => d.path.startsWith(`${collection}[`)).map((d) => d.category);

    expect(categoriesFor('dependencies').sort()).toEqual(['dependencies', 'dependencies']);
    // Ownership, not `service-assignment`: the capture files `work_item_service`
    // under ownership, and `service-assignment` is the narrower thing — the
    // work-item fields `service_team_id` and `service_id`.
    expect(categoriesFor('workItemServices').sort()).toEqual(['ownership', 'ownership']);
    expect(differences.some((d) => d.category === 'added' || d.category === 'removed')).toBe(false);
  });

  /**
   * A registry row arriving or leaving is a change to the registry, not to the
   * work-item field that resolves through it. `tags[t1].name` is `registry`
   * already; `workItems[w1].tagIds` is `tags`. Presence follows the row.
   */
  it('files a registry row that arrived or left under registry', () => {
    for (const collection of ['tags', 'workItemTypes', 'externalSystems'] as const) {
      const emptied: CanonicalPlanInput = { ...input, [collection]: [] };
      const categories = diffPlans(side(), side(emptied))
        .input.filter((d) => d.path.startsWith(`${collection}[`))
        .map((d) => d.category);

      expect({ collection, categories }).toEqual({
        collection,
        categories: input[collection].map(() => 'registry'),
      });
    }
  });
});

describe('diffPlans — 7.2b, the diff-completeness property', () => {
  /**
   * Mutate **any single field** of the canonical plan input in turn and require
   * the diff to be non-empty and to name that field. The field set is read off
   * the value, so a capture field added later is covered without an edit here.
   */
  it('names every field of the canonical plan input that can differ', () => {
    const paths = leafPaths(input);
    expect(paths.length).toBeGreaterThan(80);

    const missed: string[] = [];
    for (const path of paths) {
      const differences = diffPlans(side(), side(mutateAt(input, path))).input;
      if (differences.length === 0 || !covers(differences, path)) missed.push(path);
    }

    expect(missed).toEqual([]);
  });

  it('covers the registry rows a label resolves through', () => {
    expect(leafPaths(input).some((p) => p.startsWith('tags['))).toBe(true);
    expect(leafPaths(input).some((p) => p.startsWith('workItemTypes['))).toBe(true);
    expect(leafPaths(input).some((p) => p.startsWith('externalSystems['))).toBe(true);
  });

  it('reports a changed row identity as removed and re-added, not as a changed id', () => {
    const differences = diffPlans(side(), side(mutateAt(input, 'workItems[0].id'))).input;

    expect(differences.map((d) => d.category).sort()).toEqual(['added', 'removed']);
  });

  /**
   * The watched negatives 7.2b names. Both drop a field from the comparison and
   * the property must catch each one — otherwise it is decoration.
   */
  it('catches a comparison that drops freeze, and one that drops a tag id', () => {
    for (const dropped of ['frozenNumber', 'tagIds'] as const) {
      // The mutant: a diff that skips one field. Building it here rather than
      // editing `diffPlans` keeps the negative in the suite permanently.
      const blind = (l: CanonicalPlanInput, r: CanonicalPlanInput): PlanDifference[] =>
        diffPlans(side(l), side(r)).input.filter((d) => fieldOf(d.path) !== dropped);

      const path = leafPaths(input).find((p) => namedSegments(p).includes(dropped));
      expect(path).toBeDefined();

      const differences = blind(input, mutateAt(input, path!));
      expect(covers(differences, path!)).toBe(false);
    }
  });
});

describe('diffPlans — 7.2c, the schedule side', () => {
  /**
   * The motivating case: two saves whose **input bodies are byte-identical**
   * and whose schedules differ because `schedule()`'s semantics changed. An
   * input-only diff reports "no change" here, which is the feature's own
   * question answered wrongly.
   */
  it('reports differing dates between byte-identical inputs', () => {
    const later: PlanSideSchedule = {
      present: true,
      algorithmId: 'levelled-v2',
      body: mutateAt(scheduleBody, 'workItems.w1.endsOn'),
    };

    const diff = diffPlans(side(), side(input, later));

    expect(diff.input).toEqual([]);
    expect(names(diff.schedule, 'endsOn')).toBe(true);
    expect(names(diff.schedule, 'algorithmId')).toBe(true);
  });

  it('names every field of the stored schedule body that can differ', () => {
    const paths = leafPaths(scheduleBody);
    const missed: string[] = [];
    for (const path of paths) {
      const mutated: PlanSideSchedule = {
        present: true,
        algorithmId: 'levelled-v1',
        body: mutateAt(scheduleBody, path),
      };
      const differences = diffPlans(side(), side(input, mutated)).schedule;
      if (differences.length === 0 || !covers(differences, `schedule.body.${path}`))
        missed.push(path);
    }

    expect(missed).toEqual([]);
  });

  it('reports the algorithm identity, which is a header column and not a body key', () => {
    const other: PlanSideSchedule = { ...present, algorithmId: 'levelled-v2' };
    const diff = diffPlans(side(), side(input, other));

    expect(diff.schedule.map((d) => d.path)).toEqual(['schedule.algorithmId']);
  });

  it('reports absence and its reason per side', () => {
    const absent: PlanSideSchedule = { present: false, absentReason: 'pending' };
    const infeasible: PlanSideSchedule = { present: false, absentReason: 'infeasible' };

    const againstPresent = diffPlans(side(), side(input, absent)).schedule;
    expect(names(againstPresent, 'present')).toBe(true);
    expect(names(againstPresent, 'absentReason')).toBe(true);

    const betweenReasons = diffPlans(side(input, absent), side(input, infeasible)).schedule;
    expect(betweenReasons.map((d) => d.path)).toEqual(['schedule.absentReason']);
    expect(betweenReasons[0]).toMatchObject({ left: 'pending', right: 'infeasible' });
  });

  it('reports nothing on the schedule half when both sides are absent for the same reason', () => {
    const absent: PlanSideSchedule = { present: false, absentReason: 'pending' };

    expect(diffPlans(side(input, absent), side(input, absent)).schedule).toEqual([]);
  });
});

describe('diffPlans — the catch-all', () => {
  /**
   * A field with no listed category is still reported, under `other`, naming
   * the field. This is what keeps the category table presentation rather than
   * coverage: a capture field added later cannot become invisible.
   */
  it('reports an unlisted field under other, naming it', () => {
    const withNewField = {
      ...input,
      project: { ...input.project, someLaterField: 'a' },
    } as unknown as CanonicalPlanInput;
    const changed = {
      ...input,
      project: { ...input.project, someLaterField: 'b' },
    } as unknown as CanonicalPlanInput;

    const differences = diffPlans(side(withNewField), side(changed)).input;

    expect(differences).toHaveLength(1);
    expect(differences[0].path).toBe('project.someLaterField');
  });

  it('reports a whole collection the field list gains later', () => {
    const withCollection = (rows: unknown[]): CanonicalPlanInput =>
      ({ ...input, laterCollection: rows }) as unknown as CanonicalPlanInput;

    const differences = diffPlans(
      side(withCollection([{ id: 'x', value: 1 }])),
      side(withCollection([{ id: 'x', value: 2 }])),
    ).input;

    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ category: 'other', path: 'laterCollection[#0].value' });
  });
});
