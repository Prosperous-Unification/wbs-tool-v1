import { POINTS } from './estimate-draft';

/**
 * What every column's heading says about itself when a reader rests on it.
 *
 * Dany, 2026-08-23: *"add explaining what WBS columns do in the table in the
 * hints; keep hints as short as possible, but make sure to explain their effect
 * on the plan in general."* So a hint here is **not** a definition of the cell:
 * it answers *what happens to the plan if I change this*, because a reader who
 * can already see the values does not need them named a second time. The
 * in-parallel column's own sentence — what it is, what it compresses, when it
 * is ignored —
 * is the shape the rest were written to, and it is the ceiling on length rather
 * than a floor to beat.
 *
 * A lookup beside the render rather than a field on each column definition, and
 * that is the one place this file disagrees with {@link ColumnMeta}: a
 * definition that changes remounts every cell in the table (landmine #1 in
 * `wbs-table.tsx`), so the schedule columns' hint — which moves the day the
 * project gets a start date — would be a remount of the whole grid on the one
 * edit most likely to be made while somebody is reading it. It is also how the
 * copy stays one voice: fifteen sentences written in one file read as a set,
 * and fifteen written beside fifteen `cell:` renderers do not.
 *
 * Every rendered column has one, enforced rather than intended:
 * {@link hintFor} throws on an id it has never heard of, exactly as
 * `defaultWidthFor` does, so a column added without a sentence fails a test
 * rather than shipping silent.
 */

/** Every fact about the plan a hint is allowed to depend on. */
export interface ColumnHintState {
  /**
   * Whether the project is on a calendar.
   *
   * The one fact a hint bends for, and for the reason `startDateHint` was
   * written in `wbs-table.tsx` before it moved here: without a project start
   * date the schedule columns hold day numbers counted from day zero, so a bare
   * `2.5` under **Start** reads as a date that failed to load. This is where
   * that is answered.
   */
  hasProjectStartDate: boolean;
}

/**
 * What a work item's Due date does to the plan — the column's hint, and the
 * same sentence on the four cell-level surfaces that also say it.
 *
 * **Exported, and one literal, because five faces make this claim.** The
 * heading's hint said *"It constrains nothing on its own — the plan is built
 * the same way"* while the table cell, its `title`, the mobile card's trigger
 * and the card sheet's description all said *"It does not move the plan"*, and
 * every one of those was false on the day it was written. Five copies of a
 * claim about the scheduler are five chances to be wrong about it separately,
 * which is `deadline-impossible.ts`'s reason for existing applied to the copy
 * rather than to the predicate.
 *
 * **Both shipped engines are named, because both read the date and they read
 * it differently.** Fast's comparator (`libs/domain/src/schedule.ts`) asks
 * `slack` — the deadline minus the placement it would get with no deadline —
 * and then the effective deadline itself, *before* `priority`, so a date
 * reorders who takes a free person first. It decides an order and never a date:
 * a slice is still placed at the latest of its own floors, so a deadline cannot
 * pull work in front of its dependencies. The optimizing engines turn the same
 * date into `start + max(duration, 1) <= deadline`
 * (`libs/solver-py/src/wbs_solver/model.py`), a CP-SAT constraint whose
 * violation is a typed `plan-infeasible` the reader is shown by name —
 * `optimization-indicator.tsx`'s *"Plan infeasible · N Work item deadlines"*.
 * Neither is a promise about something unshipped: the three choices are the
 * radios in `optimization-settings.tsx`, and the date reaches the solver
 * through `buildSolverSlices`' `deadlineUnits`.
 *
 * **"Reported late" survives the rewrite** because it was the one true half of
 * the old sentence: lateness is be-01's number and the view never recomputes
 * it (slice 9.2), and a plan refused as infeasible falls back to Fast, where a
 * missed date is reported exactly this way.
 *
 * It names no bare *deadline* — `deadline-copy.test.ts` would refuse one, and
 * the sentence has no room to say *work item* four times.
 */
export const DEADLINE_EFFECT_HINT =
  'The last day this work item may finish on. The work closest to missing is scheduled first; ' +
  'an optimized plan is refused where it cannot make the date, and a row that misses is ' +
  'reported late.';

/**
 * The columns whose hint is the same sentence whatever the plan holds.
 *
 * A `Map` rather than an object literal for {@link COLUMN_WIDTHS}' reason: the
 * id being looked up is a column id from the table model, not a key known here,
 * and a `Record<string, string>` would type every miss as a `string` and the
 * refusal below as dead code.
 */
const COLUMN_HINTS = new Map<string, string>([
  [
    'drag',
    'Drag a row to move it in the outline. Where a row sits decides its number, ' +
      'which parent adds it up, and the team, services and tags it inherits while its own are blank.',
  ],
  [
    'number',
    'This row’s place in the outline. A row indented under another is part of it: ' +
      'the parent’s days and dates are its children’s, added up. A locked number is one ' +
      'the plan was published under and it no longer moves.',
  ],
  [
    'name',
    'What this work item is called — what the waiting sentences, the chart and every export ' +
      'call it, and where its notes are typed. It moves no dates.',
  ],
  [
    'refs',
    // The hint names what the column does **not** do, which for this one is the
    // load-bearing half: a dot beside a row looks like a status, and nothing
    // here is fetched — a ref is a link and nothing more (the proposal's first
    // non-goal). Nothing about a ref reaches a date, a roll-up or a person.
    'Where this work also exists — a Jira issue, a pull request, a page. One dot per system, ' +
      'never one per link. Nothing is fetched and nothing here changes the plan.',
  ],
  [
    'depends',
    'The rows this one waits for. It starts after each named row’s first estimated step ' +
      'rather than after that row finishes, so pushing a row you depend on pushes this one too.',
  ],
  [
    'priority',
    'How important this work is: 1 upward, smaller first. It decides who gets a shared ' +
      'person first — never who skips their dependencies.',
  ],
  [
    'team',
    'The team whose people do this work. The plan’s dates are worked out against that team’s ' +
      'capacity, so a busy team is what a row waits on when nothing else holds it. ' +
      'Blank inherits the nearest team above.',
  ],
  [
    'tag',
    'Labels to narrow the plan by — the table, the chart and the cards filter to them together. ' +
      'Blank inherits the tags above. Tags move no dates.',
  ],
  [
    'service',
    'What this work delivers. A row built by a team that does not own the service is marked, ' +
      'not refused — services move no dates. Blank inherits the services above.',
  ],
  [
    'type',
    'What kind of work this is — Story, Bug, Spike. Unlike teams, tags and services, a blank ' +
      'inherits nothing: a row carries only the types somebody put on it. Types move no dates.',
  ],
  [
    'in-parallel',
    'How many people may work on this item at once. Blank means one at a time. It compresses ' +
      'the item’s own effort across that many of its team’s people — never past the team’s size, ' +
      'and never where somebody is named on the work.',
  ],
  [
    'final-total',
    'Every step’s final figure for this work item, added up — and the length of its bar. ' +
      'Computed: change an estimate, or how many work on it at once, and this moves with it.',
  ],
  [
    'not-before',
    'The earliest day this work item may start. It is a floor and not a date: ' +
      'its dependencies and its team can still push it later, never earlier.',
  ],
  ['deadline', DEADLINE_EFFECT_HINT],
  [
    'float',
    'Days this work item can slip before the plan’s end moves. A row marked critical has none: ' +
      'it is what sets the plan’s finish.',
  ],
  [
    'actions',
    'Duplicate this row, or delete it and every row under it. A row whose number is locked ' +
      'must be unfrozen before it can be deleted.',
  ],
]);

/**
 * What the schedule columns say, which turns on whether the plan is on a
 * calendar.
 *
 * Both ends of a row take the same sentence with the end's own name in it, so
 * the pair cannot drift apart — the fault the single `startDateHint` this
 * replaces was already written to avoid.
 */
function scheduleHint(what: string, state: ColumnHintState): string {
  const computed =
    `Computed, not typed: this work item’s ${what}, worked out from its dependencies, ` +
    'its earliest start and when its team has people free.';
  return state.hasProjectStartDate
    ? computed
    : `${computed} In days from the start of the plan until the project has a start date.`;
}

/**
 * What one of a step's three estimate boxes says.
 *
 * The word is the first thing in it because the heading is a single letter —
 * `o`, `r`, `p` — and 44px of column is why. A hint that opened with the effect
 * would be the only one in the table whose column the reader still could not
 * name.
 */
function pointHint(point: string): string {
  const opening: Record<string, string> = {
    optimistic: 'Optimistic: days for this step if nothing gets in the way.',
    realistic: 'Realistic: days for this step as it usually goes.',
    pessimistic: 'Pessimistic: days for this step if it goes badly.',
  };
  return (
    `${opening[point] ?? ''} The three combine as (o + 4r + p) ÷ 6 into the step’s figure, ` +
    'which is what its bar and every date after it are built from.'
  );
}

/**
 * What a step's folded column says.
 *
 * A named export because the fold button in that heading opens with it — the
 * button covers most of the cell, so the `<th>`'s own `title` would be
 * unreachable there — and a column definition may not read the hint state:
 * `columns` is a `useMemo` whose dependencies are the steps alone, and anything
 * else it closed over would be stale by a render (landmine #1). Constant for
 * exactly that reason: this sentence turns on nothing about the plan.
 */
export const STEP_FINAL_HINT =
  'This step’s days for the work item, from its three points. Steps on one item run ' +
  'in order, so this one waits for the step before it.';

/** An id no sentence was written for — a typo, or a new column nobody explained. */
export class UnexplainedColumnError extends Error {
  constructor(columnId: string) {
    super(
      `No hint for column "${columnId}". Every rendered column must carry one: ` +
        `a heading with nothing behind it is a column whose effect on the plan the reader ` +
        `has to guess, which is the whole of what wbs-column-hints was filed for.`,
    );
    this.name = 'UnexplainedColumnError';
  }
}

/**
 * The sentence the heading with this id carries, for this plan.
 *
 * Step columns are matched by suffix and named by kind rather than by step,
 * exactly as {@link defaultWidthFor} sizes them: a step is created at runtime,
 * so the step half of the id is whatever the project called it. The step's own
 * name is already the heading the reader is resting on.
 *
 * @throws {UnexplainedColumnError} when nothing explains that id.
 */
export function hintFor(columnId: string, state: ColumnHintState): string {
  const declared = COLUMN_HINTS.get(columnId);
  if (declared !== undefined) return declared;
  if (columnId === 'start') return scheduleHint('earliest start', state);
  if (columnId === 'finish') return scheduleHint('earliest finish', state);
  if (columnId.includes('-')) {
    if (columnId.endsWith('-final')) return STEP_FINAL_HINT;
    if (columnId.endsWith('-assignee')) {
      return (
        'Who does this step. A named person does one thing at a time, so their next item waits ' +
        'for their last — and naming somebody switches off this item’s people-at-once compression.'
      );
    }
    const point = columnId.slice(columnId.lastIndexOf('-') + 1);
    if ((POINTS as readonly string[]).includes(point)) return pointHint(point);
  }
  throw new UnexplainedColumnError(columnId);
}
