/**
 * Task 8.3's comparison model: what the two pickers may ask for, and what the
 * answer means *per side*.
 *
 * Pure and rendererless on purpose. Everything below is a fact about a diff, a
 * pair of side references and a shelf — none of it needs a DOM, and keeping it
 * here is what lets the underdetermined case (see {@link resolveSideSchedules})
 * be a measured case rather than a paragraph.
 */

import type {
  PlanDiffCategoryView,
  PlanDifferenceView,
  PlanDiffView,
  SavedPlanListEntryView,
  SavedPlanSideRef,
} from './saved-plan-api';

/** Whether two picker selections name the same plan. */
export function sameSide(left: SavedPlanSideRef, right: SavedPlanSideRef): boolean {
  if (left === 'current' || right === 'current') return left === right;
  return left.saved === right.saved;
}

/**
 * Why a comparison must not be requested, or `null` when it may be.
 *
 * One reason, and it exists because of what the *wire* allows: the compare
 * route takes two side strings and validates each one alone, so
 * `left=current&right=current` is a well-formed request that be-01 answers with
 * an empty diff. An empty diff from two identical sides is indistinguishable
 * from an empty diff between two genuinely equal plans, and the surface would
 * report "no differences" about a question nobody asked.
 *
 * It is also the one case {@link resolveSideSchedules} cannot resolve: with no
 * saved side there is no shelf row to read a shared absence off, so a
 * `current`/`current` pair whose schedule is missing would render nothing about
 * a plan that has no dates. Refusing the request closes both at the source.
 */
export function compareRefusal(
  left: SavedPlanSideRef,
  right: SavedPlanSideRef,
): 'same_side' | null {
  return sameSide(left, right) ? 'same_side' : null;
}

/** 8.3's copy for {@link compareRefusal}, in one place so surface and case cannot drift. */
export const COMPARE_SAME_SIDE = 'Pick two different plans to compare.';

/**
 * One side's schedule, as the surface has to say it.
 *
 * `unknown` is a real third answer rather than a defensive default: a saved
 * side whose row is not on the loaded shelf — deleted by a collaborator, or a
 * comparison opened before the list resolved — is a side this client genuinely
 * cannot describe, and saying "no schedule was saved" about it would be a
 * sentence invented from a missing lookup.
 */
export type SideScheduleView =
  | { readonly kind: 'present' }
  | { readonly kind: 'absent'; readonly reason: string | null }
  | { readonly kind: 'unknown' };

/** Both sides of {@link resolveSideSchedules}, in picker order. */
export interface SideSchedules {
  readonly left: SideScheduleView;
  readonly right: SideScheduleView;
}

/** The `schedule.present` and `schedule.absentReason` rows, or `undefined`. */
const rowAt = (differences: readonly PlanDifferenceView[], path: string) =>
  differences.find((difference) => difference.path === path);

/** A shelf row's own schedule state — authoritative, and the only one that is. */
function shelfSchedule(row: SavedPlanListEntryView): SideScheduleView {
  return row.scheduleBytes !== null
    ? { kind: 'present' }
    : { kind: 'absent', reason: row.scheduleAbsentReason };
}

/**
 * Each side's schedule state, from the shelf where it is recorded and from the
 * diff where it is not.
 *
 * **The diff reports difference, never state**, and that is the whole shape of
 * this function. `diffSchedule` in `libs/domain` emits `schedule.present` only
 * when the two sides disagree about presence and `schedule.absentReason` only
 * when the two reasons differ, so two sides that are *both* absent for the
 * same reason produce neither row. Reading state straight off the diff would
 * therefore render "both schedules present" for a pair of plans neither of
 * which has one.
 *
 * So presence is established in this order:
 *
 * 1. A `schedule.present` row settles both sides outright — it carries one
 *    boolean per side and only exists when they differ.
 * 2. With no such row the two sides *agree*, whatever they agree on, and a
 *    saved side's shelf row says which. Either side's row will do; the left is
 *    tried first only because something has to be.
 * 3. With no row and no shelf entry for either side, the state is `unknown` on
 *    both. {@link compareRefusal} makes the `current`/`current` half of that
 *    unreachable; what is left is a shelf that has not loaded or no longer
 *    carries the plan, which is honestly unknown.
 *
 * Reasons follow the same shape one level down, and only for a side already
 * known absent: an `absentReason` row carries this side's own reason, and its
 * absence means the reasons are equal, so a saved side's shelf row supplies it.
 *
 * The `current` side never has a shelf row of its own — nothing about the live
 * plan was ever saved — so every fact about it comes from the diff or from what
 * the diff's silence implies about the saved side beside it.
 */
export function resolveSideSchedules(
  left: SavedPlanSideRef,
  right: SavedPlanSideRef,
  diff: PlanDiffView,
  rows: readonly SavedPlanListEntryView[],
): SideSchedules {
  const shelfOf = (side: SavedPlanSideRef): SideScheduleView | null => {
    if (side === 'current') return null;
    const row = rows.find((candidate) => candidate.id === side.saved);
    return row === undefined ? null : shelfSchedule(row);
  };
  const leftShelf = shelfOf(left);
  const rightShelf = shelfOf(right);
  const agreed = leftShelf ?? rightShelf;

  const presentRow = rowAt(diff.schedule, 'schedule.present');
  const presence = (side: 'left' | 'right'): boolean | null => {
    const reported = presentRow?.[side];
    if (typeof reported === 'boolean') return reported;
    // No row: the sides agree. `agreed` is whichever saved side we could read.
    if (agreed === null || agreed.kind === 'unknown') return null;
    return agreed.kind === 'present';
  };

  const reasonRow = rowAt(diff.schedule, 'schedule.absentReason');
  const reason = (side: 'left' | 'right', shelf: SideScheduleView | null): string | null => {
    // A side that is present contributes `undefined` to the reason row, so a
    // string there is this side's own recorded reason and nothing else's.
    const reported = reasonRow?.[side];
    if (typeof reported === 'string') return reported;
    if (reasonRow !== undefined) return null;
    // No row: the reasons are equal. This side's own shelf row first, then the
    // other side's, because equal is equal.
    const known = shelf ?? agreed;
    return known !== null && known.kind === 'absent' ? known.reason : null;
  };

  const view = (side: 'left' | 'right', shelf: SideScheduleView | null): SideScheduleView => {
    const present = presence(side);
    if (present === null) return { kind: 'unknown' };
    return present ? { kind: 'present' } : { kind: 'absent', reason: reason(side, shelf) };
  };

  return { left: view('left', leftShelf), right: view('right', rightShelf) };
}

/**
 * What a side says about its own missing schedule.
 *
 * **The two sentences are different facts and 8.3 names why.** A saved side with
 * no body was saved that way: "no schedule was saved" is a statement about a
 * write that happened. Nothing about `current` was ever saved, so the same words
 * on the live side would claim a save that never occurred — for a cyclic plan
 * the truth is that it *cannot be scheduled*, now, which is a property of the
 * plan rather than of anybody's checkpoint.
 *
 * The recorded reason is appended rather than translated, exactly as
 * `scheduleWords` appends it on the shelf: this build passes through reasons it
 * has never heard of instead of narrowing them away.
 */
export function sideScheduleWords(ref: SavedPlanSideRef, view: SideScheduleView): string | null {
  if (view.kind !== 'absent') return null;
  const base = ref === 'current' ? 'the live plan cannot be scheduled' : 'no schedule was saved';
  return view.reason === null ? base : `${base} (${view.reason})`;
}

/**
 * Where a category sits in the rendered list.
 *
 * A `Record` over the union rather than an array, so a category added to
 * `PlanDiffCategory` in `libs/domain` is a **type error here** rather than a
 * difference that silently sorts to the end. The order is structure first
 * (what rows exist, then how they are arranged), then the numbers, then the
 * labels, then everything a plan carries about who and when, with `other` last
 * because it is the one bucket whose contents are not known in advance.
 */
const CATEGORY_RANK: Record<PlanDiffCategoryView, number> = {
  added: 0,
  removed: 1,
  renamed: 2,
  reparented: 3,
  reordered: 4,
  estimates: 5,
  uncertainty: 6,
  actuals: 7,
  progress: 8,
  measures: 9,
  dates: 10,
  dependencies: 11,
  'max-parallel': 12,
  'start-no-earlier-than': 13,
  freeze: 14,
  priority: 15,
  'priority-bands': 16,
  ownership: 17,
  'service-assignment': 18,
  capacity: 19,
  type: 20,
  tags: 21,
  registry: 22,
  settings: 23,
  'external-references': 24,
  notes: 25,
  other: 26,
};

/** Every category this build renders, in rendered order. Derived, never written twice. */
export const CATEGORY_ORDER: readonly PlanDiffCategoryView[] = Object.keys(CATEGORY_RANK)
  .map((category) => category as PlanDiffCategoryView)
  .sort((a, b) => CATEGORY_RANK[a] - CATEGORY_RANK[b]);

/** One rendered group: a category and the differences filed under it. */
export interface DiffCategoryGroup {
  readonly category: PlanDiffCategoryView;
  readonly differences: readonly PlanDifferenceView[];
}

/**
 * The differences of one half, grouped by category in {@link CATEGORY_ORDER}.
 *
 * Empty categories are dropped rather than rendered as "no changes": a
 * comparison of two plans that differ in three fields should be three lines,
 * not three lines inside twenty-six headings. Within a group the differences
 * keep the order the diff produced them in, which is the walk order of the
 * side — stable across two calls over the same bytes.
 *
 * A category outside the union cannot occur (be-01 emits the union), but if one
 * ever did it would sort *before* `added` under a `?? -1` and lead the list. It
 * is filed under `other` instead, which is the bucket that already means "this
 * differed and we have no better heading for it".
 */
export function groupByCategory(
  differences: readonly PlanDifferenceView[],
): readonly DiffCategoryGroup[] {
  const byCategory = new Map<PlanDiffCategoryView, PlanDifferenceView[]>();
  for (const difference of differences) {
    const category = Object.hasOwn(CATEGORY_RANK, difference.category)
      ? difference.category
      : 'other';
    const bucket = byCategory.get(category);
    if (bucket === undefined) byCategory.set(category, [difference]);
    else bucket.push(difference);
  }
  return CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({
    category,
    differences: byCategory.get(category) ?? [],
  }));
}

/** True when a comparison found nothing in either half — mirrors `planDiffIsEmpty`. */
export function diffIsEmpty(diff: PlanDiffView): boolean {
  return diff.input.length === 0 && diff.schedule.length === 0;
}

/** Longest a single side's text may run before it is clipped. */
const MAX_VALUE_CHARS = 80;

const clip = (text: string): string =>
  text.length <= MAX_VALUE_CHARS ? text : `${text.slice(0, MAX_VALUE_CHARS)}…`;

/** `no fields` / `1 field` / `4 fields`, without an English plural rule at each call site. */
const countWords = (count: number, one: string, many: string): string => {
  if (count === 0) return `no ${many}`;
  return `${String(count)} ${count === 1 ? one : many}`;
};

/**
 * One side of a difference, as a phrase short enough to sit on the line beside
 * its path.
 *
 * `PlanDifference.left` and `.right` are `unknown` because `diffPlans` walks the
 * two sides structurally: a leaf is whatever the plan stored there, and an
 * `added`/`removed` row is the whole row object. So this has to answer for four
 * kinds of value, and the rule is **scalars exactly, composites by shape**.
 *
 * - A scalar is the thing the reader came for. `workItems[w1].name` is only
 *   worth rendering because `"Design" → "Design v2"` is the change; the path on
 *   its own names a field and reports nothing about it.
 * - A composite is rendered as `4 fields` / `2 entries` rather than as its JSON.
 *   A serialised work item is longer than the panel and would push every other
 *   difference off the screen, and a JSON string clipped mid-object is worse
 *   than a count: it looks like data and is not parseable as any. The category
 *   heading already says `added` or `removed` and the path already names the
 *   row, so the count is the only part not said twice. Naming a composite's own
 *   changed fields is a different feature — the walk would have to descend, and
 *   `diffPlans` deliberately does not descend into an added row.
 *
 * **`absent` and `none` are two different facts, not one hedged one.** A field
 * missing from a side reads `absent` (`undefined`: the row does not carry it,
 * which is every `added`/`removed` counterpart and every field one side never
 * had); a field the side carries with an empty value reads `none` (`null`, which
 * `scheduleAbsentReason` and friends store on purpose). Collapsing them would
 * report a deleted field and a cleared field as the same change.
 *
 * Long strings are clipped at {@link MAX_VALUE_CHARS} with an ellipsis INSIDE
 * the quotes, so a clipped note cannot be read as the whole stored note.
 */
export function diffValueWords(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'none';
  if (typeof value === 'string') return `"${clip(value)}"`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) return countWords(value.length, 'entry', 'entries');
  if (typeof value === 'object') return countWords(Object.keys(value).length, 'field', 'fields');
  // Nothing a JSON body can hold reaches here; a function or a symbol would.
  // Said rather than thrown: a comparison must still draw its other rows.
  return 'a value';
}
