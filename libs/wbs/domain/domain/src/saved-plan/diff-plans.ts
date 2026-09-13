import type { CanonicalPlanInput } from './canonical-plan-input';

/**
 * One side of a comparison: a canonical plan input, **its** schedule, and the
 * algorithm identity that schedule was produced under.
 *
 * A side is not a plan input. `openspec/changes/saved-plans/design.md`
 * ("Comparison") is explicit about why: the stored schedule is not a field of
 * `CanonicalPlanInput`, and `scheduler_algorithm_id` is a `saved_plan` *header*
 * column rather than a key of the schedule body, so a signature taking two
 * inputs cannot see a date at all. Two saves whose input bodies are
 * byte-identical and whose dates differ — which is exactly what a `schedule()`
 * semantics change produces — must not compare as unchanged.
 *
 * On the `current` side these three come from `projectCurrentPlan()` (tasks 7.3
 * and 7.3a), never from a stored record. Snapshot↔snapshot and
 * snapshot↔`current` are one code path.
 */
export interface PlanSide {
  readonly input: CanonicalPlanInput;
  readonly schedule: PlanSideSchedule;
}

/**
 * A side's schedule: the stored body under its algorithm identity, or the
 * recorded reason there is none.
 *
 * The body is typed as an opaque JSON value on purpose. It is written by
 * `buildScheduleBody` in `apps/be-01`, which copies whatever `schedule()`
 * returned rather than a field list (`saved-plan-schedule-body.ts`), and the
 * comparison's coverage bound is the *stored value*, not an enumeration. A
 * structural type here would be a second field list to forget to update — the
 * failure task 7.2c exists to catch — and `libs/domain` cannot import an app
 * type in any case.
 */
export type PlanSideSchedule =
  | { readonly present: true; readonly algorithmId: string; readonly body: PlanScheduleValue }
  | { readonly present: false; readonly absentReason: string };

/** Any JSON value a stored schedule body can hold. */
export type PlanScheduleValue =
  | string
  | number
  | boolean
  | null
  | readonly PlanScheduleValue[]
  | { readonly [key: string]: PlanScheduleValue };

/**
 * How a difference is grouped for a reader.
 *
 * **Presentation, not coverage** — spec is explicit
 * (`specs/wbs-domain/spec.md`, "A comparison is one diff over two sides"): the
 * coverage bound is `CanonicalPlanInput`'s field list and the stored schedule's
 * field set, and a differing field with no listed category is still reported,
 * under `other`, naming the field. Adding a field to the capture therefore
 * cannot make it invisible here; at worst it lands in `other`.
 */
export type PlanDiffCategory =
  | 'added'
  | 'removed'
  | 'renamed'
  | 'reparented'
  | 'reordered'
  | 'estimates'
  | 'uncertainty'
  | 'actuals'
  | 'progress'
  | 'measures'
  | 'ownership'
  | 'dependencies'
  | 'settings'
  | 'freeze'
  | 'type'
  | 'tags'
  | 'external-references'
  | 'notes'
  | 'priority'
  | 'max-parallel'
  | 'service-assignment'
  | 'start-no-earlier-than'
  | 'priority-bands'
  | 'capacity'
  | 'registry'
  | 'dates'
  | 'other';

/** One reported difference. `path` is derived from the value, never written out. */
export interface PlanDifference {
  readonly category: PlanDiffCategory;
  /** Dotted path into the side, e.g. `workItems[w1].name` or `slices[w1:s2].startsOn`. */
  readonly path: string;
  readonly left: unknown;
  readonly right: unknown;
}

/**
 * The two halves are reported separately because they are bounded separately:
 * the input half by `CanonicalPlanInput`'s field list, the schedule half by the
 * stored schedule's own field set plus the algorithm identity and the absent
 * reason. A caller that wants one list concatenates them.
 */
export interface PlanDiff {
  readonly input: readonly PlanDifference[];
  readonly schedule: readonly PlanDifference[];
}

/** True when neither half reported anything. */
export function planDiffIsEmpty(diff: PlanDiff): boolean {
  return diff.input.length === 0 && diff.schedule.length === 0;
}

/**
 * Which fields identify a row inside a collection, so that an added row is
 * reported as *added* rather than shifting every later row into "changed".
 *
 * This is a collection→key map, **not** a field list: the fields compared
 * within a row are still read off the values, so a new field on
 * `CanonicalWorkItem` is compared without touching this table. A collection
 * with no entry falls back to positional comparison, which still reports every
 * difference — coverage never depends on this map, only presentation does.
 */
const ROW_KEYS: Readonly<Record<string, readonly string[] | undefined>> = {
  workItems: ['id'],
  steps: ['id'],
  stepValues: ['workItemId', 'stepId'],
  measures: ['workItemId', 'stepId', 'metric'],
  dependencies: ['predecessorId', 'successorId'],
  assignments: ['workItemId', 'stepId', 'personId'],
  people: ['id'],
  teams: ['id'],
  services: ['id'],
  personTeams: ['personId', 'teamId'],
  teamServices: ['teamId', 'serviceId'],
  workItemTeams: ['workItemId', 'teamId'],
  workItemServices: ['workItemId', 'serviceId'],
  priorityBands: ['startsAt'],
  capacity: ['teamId'],
  tags: ['id'],
  workItemTypes: ['id'],
  externalSystems: ['id'],
};

/** Per-collection field→category table. Presentation only; see {@link PlanDiffCategory}. */
const FIELD_CATEGORIES: Readonly<
  Record<string, Readonly<Record<string, PlanDiffCategory | undefined>> | undefined>
> = {
  project: {
    name: 'renamed',
    ownerId: 'ownership',
  },
  workItems: {
    name: 'renamed',
    parentId: 'reparented',
    position: 'reordered',
    notes: 'notes',
    typeIds: 'type',
    tagIds: 'tags',
    externalRefs: 'external-references',
    priority: 'priority',
    maxParallel: 'max-parallel',
    frozenNumber: 'freeze',
    serviceTeamId: 'service-assignment',
    serviceId: 'service-assignment',
    startNoEarlierThan: 'start-no-earlier-than',
    startNoEarlierThanReason: 'start-no-earlier-than',
  },
  steps: { name: 'renamed', position: 'reordered' },
  stepValues: {
    optimistic: 'uncertainty',
    realistic: 'uncertainty',
    pessimistic: 'uncertainty',
    derived: 'estimates',
    actual: 'actuals',
    progress: 'progress',
  },
  people: { name: 'renamed' },
  teams: { name: 'renamed' },
  services: { name: 'renamed' },
  tags: { name: 'registry' },
  workItemTypes: { name: 'registry' },
  externalSystems: { name: 'registry' },
};

/** Per-collection fallback when the field itself has no entry above. */
const COLLECTION_CATEGORIES: Readonly<Record<string, PlanDiffCategory | undefined>> = {
  project: 'settings',
  measures: 'measures',
  dependencies: 'dependencies',
  assignments: 'ownership',
  personTeams: 'ownership',
  teamServices: 'ownership',
  workItemTeams: 'ownership',
  workItemServices: 'service-assignment',
  priorityBands: 'priority-bands',
  capacity: 'capacity',
  people: 'ownership',
  teams: 'ownership',
  services: 'ownership',
  tags: 'tags',
  workItemTypes: 'type',
  externalSystems: 'external-references',
};

/**
 * Compare two plan sides. One function, both directions: swapping the arguments
 * swaps every `left`/`right` and reports the same paths.
 *
 * Coverage is derived from the values on both halves — any field either side
 * carries is walked, so a field the capture gains later is compared without an
 * edit here. Grouping is presentation and falls back to `other`.
 */
export function diffPlans(left: PlanSide, right: PlanSide): PlanDiff {
  return {
    input: diffInput(left.input, right.input),
    schedule: diffSchedule(left.schedule, right.schedule),
  };
}

function diffInput(left: CanonicalPlanInput, right: CanonicalPlanInput): PlanDifference[] {
  const out: PlanDifference[] = [];
  for (const key of unionKeys(left, right)) {
    const l = (left as unknown as Record<string, unknown>)[key];
    const r = (right as unknown as Record<string, unknown>)[key];
    if (Array.isArray(l) || Array.isArray(r)) {
      diffCollection(key, asRows(l), asRows(r), out);
    } else if (isRecord(l) && isRecord(r)) {
      diffRowFields(key, key, l, r, out);
    } else if (!deepEqual(l, r)) {
      out.push({ category: categoryFor(key, key), path: key, left: l, right: r });
    }
  }
  return out;
}

function diffCollection(
  collection: string,
  left: readonly unknown[],
  right: readonly unknown[],
  out: PlanDifference[],
): void {
  const keyFields = ROW_KEYS[collection];
  const leftById = indexRows(collection, left, keyFields);
  const rightById = indexRows(collection, right, keyFields);
  for (const id of unionKeys(leftById, rightById)) {
    const l = leftById[id];
    const r = rightById[id];
    const path = `${collection}[${id}]`;
    if (l === undefined) {
      out.push({
        category: presenceCategory(collection, 'added'),
        path,
        left: undefined,
        right: r,
      });
    } else if (r === undefined) {
      out.push({
        category: presenceCategory(collection, 'removed'),
        path,
        left: l,
        right: undefined,
      });
    } else if (isRecord(l) && isRecord(r)) {
      diffRowFields(collection, path, l, r, out);
    } else if (!deepEqual(l, r)) {
      out.push({ category: categoryFor(collection, collection), path, left: l, right: r });
    }
  }
}

function diffRowFields(
  collection: string,
  path: string,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  out: PlanDifference[],
): void {
  for (const field of unionKeys(left, right)) {
    if (deepEqual(left[field], right[field])) continue;
    out.push({
      category: categoryFor(collection, field),
      path: `${path}.${field}`,
      left: left[field],
      right: right[field],
    });
  }
}

/**
 * The schedule half. Absence, the reason, the algorithm identity and every key
 * of the stored body are all reported; the body is walked structurally so the
 * field set comes from the value, exactly as `buildScheduleBody` writes it.
 */
function diffSchedule(left: PlanSideSchedule, right: PlanSideSchedule): PlanDifference[] {
  const out: PlanDifference[] = [];
  if (left.present !== right.present) {
    out.push({
      category: 'dates',
      path: 'schedule.present',
      left: left.present,
      right: right.present,
    });
  }
  const leftReason = left.present ? undefined : left.absentReason;
  const rightReason = right.present ? undefined : right.absentReason;
  if (leftReason !== rightReason) {
    out.push({
      category: 'dates',
      path: 'schedule.absentReason',
      left: leftReason,
      right: rightReason,
    });
  }
  const leftAlgorithm = left.present ? left.algorithmId : undefined;
  const rightAlgorithm = right.present ? right.algorithmId : undefined;
  if (leftAlgorithm !== rightAlgorithm) {
    out.push({
      category: 'dates',
      path: 'schedule.algorithmId',
      left: leftAlgorithm,
      right: rightAlgorithm,
    });
  }
  diffValue(
    'schedule.body',
    left.present ? left.body : undefined,
    right.present ? right.body : undefined,
    out,
  );
  return out;
}

/** A structural walk. Every leaf that differs is one difference naming its path. */
function diffValue(path: string, left: unknown, right: unknown, out: PlanDifference[]): void {
  if (deepEqual(left, right)) return;
  if (isRecord(left) && isRecord(right)) {
    for (const key of unionKeys(left, right)) {
      diffValue(`${path}.${key}`, left[key], right[key], out);
    }
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      diffValue(`${path}[${String(i)}]`, left[i], right[i], out);
    }
    return;
  }
  out.push({ category: 'dates', path, left, right });
}

function categoryFor(collection: string, field: string): PlanDiffCategory {
  return FIELD_CATEGORIES[collection]?.[field] ?? COLLECTION_CATEGORIES[collection] ?? 'other';
}

/**
 * The four collections whose *presence* heading is not their *field* heading.
 *
 * `COLLECTION_CATEGORIES` answers "a field of this row changed"; a row arriving
 * or leaving is a different question and the spec answers it differently in
 * exactly these cases (Sol, round 15):
 *
 * - `workItemServices` is a junction row, and the capture text files
 *   `work_item_service` under **ownership** (`specs/wbs-domain/spec.md:25-29`).
 *   `service-assignment` is defined narrowly, as the work-item fields
 *   `service_team_id` and `service_id` (`:299-302`) — which is what the
 *   `workItems` field table already sends there.
 * - `tags`, `workItemTypes` and `externalSystems` are "the registry rows a label
 *   resolves through" (`:303`). A tag *applied to a work item* changing is
 *   `tags`; the tag row itself arriving or leaving is `registry`, which is
 *   already how the field table treats a registry row's `name`.
 */
const PRESENCE_CATEGORIES: Readonly<Record<string, PlanDiffCategory | undefined>> = {
  workItemServices: 'ownership',
  tags: 'registry',
  workItemTypes: 'registry',
  externalSystems: 'registry',
};

/**
 * How a row present on only one side is grouped.
 *
 * The spec reserves `added` and `removed` for **work items** and gives every
 * other named collection its own heading, and that distinction is load-bearing
 * rather than cosmetic: in a relationship collection — `dependencies`,
 * `assignments`, `personTeams`, `teamServices`, `workItemTeams`,
 * `workItemServices` — every field is part of the row key, so *changing* an
 * edge is necessarily one row gone and one row arrived and can never surface as
 * a changed field. Hard-coding the generic pair here therefore left
 * `dependencies`, `ownership` and `service-assignment` unreachable for the only
 * operation those rows have, and filed a rewired dependency under the same
 * heading as a new work item.
 *
 * A collection with no heading of its own keeps the generic pair: `workItems`,
 * which is what the spec names, and `steps`/`stepValues`, which are work-item
 * structure rather than a domain of their own.
 *
 * {@link PRESENCE_CATEGORIES} comes first, for the four rows whose presence and
 * whose fields are filed in different places.
 */
function presenceCategory(collection: string, generic: 'added' | 'removed'): PlanDiffCategory {
  return PRESENCE_CATEGORIES[collection] ?? COLLECTION_CATEGORIES[collection] ?? generic;
}

/**
 * Key a collection's rows. Rows without the declared key fields, and
 * collections with no declared key, fall back to their index — which reports
 * every difference, just less legibly.
 */
function indexRows(
  collection: string,
  rows: readonly unknown[],
  keyFields: readonly string[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  rows.forEach((row, index) => {
    out[rowKey(collection, row, keyFields, index)] = row;
  });
  return out;
}

function rowKey(
  collection: string,
  row: unknown,
  keyFields: readonly string[] | undefined,
  index: number,
): string {
  if (keyFields && isRecord(row)) {
    const parts = keyFields.map((f) => row[f]);
    if (parts.every((p) => p !== undefined)) return parts.map(String).join(':');
  }
  if (isRecord(row) || Array.isArray(row)) return `#${String(index)}`;
  // Scalar rows (none today) key by their own value, so a reordered list of
  // scalars is not read as every element changing.
  return `=${String(row)}`;
}

function asRows(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function unionKeys(left: object, right: object): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((v, i) => deepEqual(v, right[i]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = unionKeys(left, right);
    return keys.every((k) => deepEqual(left[k], right[k]));
  }
  return false;
}
