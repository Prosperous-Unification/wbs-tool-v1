import { describe, expect, it } from 'vitest';

import type {
  PlanDifferenceView,
  PlanDiffView,
  SavedPlanListEntryView,
  SavedPlanSideRef,
} from './saved-plan-api';
import {
  CATEGORY_ORDER,
  COMPARE_SAME_SIDE,
  compareRefusal,
  diffIsEmpty,
  groupByCategory,
  resolveSideSchedules,
  sameSide,
  sideScheduleWords,
} from './saved-plan-compare';

const row = (over: Partial<SavedPlanListEntryView> = {}): SavedPlanListEntryView => ({
  id: 'sp1',
  name: 'before the re-plan',
  createdBy: 'ada',
  createdAt: 1_788_501_600_000,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
  ...over,
});

const NO_SCHEDULE = row({ scheduleBytes: null, scheduleAbsentReason: 'infeasible' });
const SAVED: SavedPlanSideRef = { saved: 'sp1' };
const diff = (
  schedule: PlanDifferenceView[] = [],
  input: PlanDifferenceView[] = [],
): PlanDiffView => ({ input, schedule });
const dates = (path: string, left: unknown, right: unknown): PlanDifferenceView => ({
  category: 'dates',
  path,
  left,
  right,
});

describe('what the pickers may ask for', () => {
  it('refuses two sides that name the same plan', () => {
    expect(compareRefusal('current', 'current')).toBe('same_side');
    expect(compareRefusal(SAVED, { saved: 'sp1' })).toBe('same_side');
    expect(COMPARE_SAME_SIDE).toContain('two different');
  });

  it('allows a saved plan against the live one, in either order', () => {
    expect(compareRefusal(SAVED, 'current')).toBeNull();
    expect(compareRefusal('current', SAVED)).toBeNull();
    expect(compareRefusal(SAVED, { saved: 'sp2' })).toBeNull();
    expect(sameSide(SAVED, 'current')).toBe(false);
  });
});

describe('each side’s schedule state', () => {
  it('reports both sides absent when the diff reports nothing at all', () => {
    // **The case this module exists for.** `diffSchedule` emits
    // `schedule.present` only when the sides disagree and `schedule.absentReason`
    // only when the reasons differ, so a saved plan with no schedule compared
    // against a live plan that also has none produces an EMPTY schedule half.
    // A build that read state off the diff would render both sides as scheduled.
    //
    // Negative, MEASURED on h2puni and reverted with dirty=0 re-asserted: make
    // `presence()` return `null` when there is no `schedule.present` row —
    // i.e. drop the shelf fallback — and this file is 8 pass / 1 fail, this
    // case, `{ kind: 'unknown' }` where `{ kind: 'absent' }` was expected.
    const resolved = resolveSideSchedules(SAVED, 'current', diff(), [NO_SCHEDULE]);
    expect(resolved).toEqual({
      left: { kind: 'absent', reason: 'infeasible' },
      right: { kind: 'absent', reason: 'infeasible' },
    });
  });

  it('lets a schedule.present row settle both sides, whichever way round', () => {
    const rows = [row()];
    expect(
      resolveSideSchedules(
        SAVED,
        'current',
        diff([
          dates('schedule.present', true, false),
          dates('schedule.absentReason', undefined, 'infeasible'),
        ]),
        rows,
      ),
    ).toEqual({ left: { kind: 'present' }, right: { kind: 'absent', reason: 'infeasible' } });

    expect(
      resolveSideSchedules(
        'current',
        SAVED,
        diff([
          dates('schedule.present', false, true),
          dates('schedule.absentReason', 'infeasible', undefined),
        ]),
        rows,
      ),
    ).toEqual({ left: { kind: 'absent', reason: 'infeasible' }, right: { kind: 'present' } });
  });

  it('gives each absent side its own reason when the two differ', () => {
    const resolved = resolveSideSchedules(
      SAVED,
      'current',
      diff([dates('schedule.absentReason', 'not_requested', 'infeasible')]),
      [NO_SCHEDULE],
    );
    expect(resolved).toEqual({
      left: { kind: 'absent', reason: 'not_requested' },
      right: { kind: 'absent', reason: 'infeasible' },
    });
  });

  it('reads presence off the shelf row of whichever side has one', () => {
    // The saved side is on the right here, so the fallback cannot be reaching
    // for `left` and getting lucky.
    expect(resolveSideSchedules('current', SAVED, diff(), [row()])).toEqual({
      left: { kind: 'present' },
      right: { kind: 'present' },
    });
  });

  it('says unknown rather than inventing a state it cannot read', () => {
    // A saved side the loaded shelf does not carry — deleted by a collaborator,
    // or a comparison opened before the list resolved — and no diff row to fall
    // back on. `compareRefusal` makes the current/current half of this
    // unreachable; what is left is honestly unknown.
    expect(resolveSideSchedules({ saved: 'sp9' }, 'current', diff(), [row()])).toEqual({
      left: { kind: 'unknown' },
      right: { kind: 'unknown' },
    });
  });

  it('keeps a null recorded reason null instead of borrowing one', () => {
    const unlabelled = row({ id: 'sp2', scheduleBytes: null, scheduleAbsentReason: null });
    expect(resolveSideSchedules({ saved: 'sp2' }, 'current', diff(), [unlabelled])).toEqual({
      left: { kind: 'absent', reason: null },
      right: { kind: 'absent', reason: null },
    });
  });
});

describe('what an absent side says', () => {
  it('says different things about a saved side and the live one', () => {
    // 8.3, and the reason it is spelled out there: nothing about `current` was
    // ever saved, so the saved-side words would state the wrong fact about a
    // cyclic live plan.
    //
    // Negative, MEASURED on h2puni and reverted with dirty=0 re-asserted: drop
    // the `ref === 'current'` branch so both sides share one sentence and this
    // file is 8 pass / 1 fail, this case, `no schedule was saved (infeasible)`
    // where `the live plan cannot be scheduled (infeasible)` was expected.
    const absent = { kind: 'absent', reason: 'infeasible' } as const;
    expect(sideScheduleWords(SAVED, absent)).toBe('no schedule was saved (infeasible)');
    expect(sideScheduleWords('current', absent)).toBe(
      'the live plan cannot be scheduled (infeasible)',
    );
  });

  it('drops the parenthesis when nothing was recorded, and says nothing at all otherwise', () => {
    expect(sideScheduleWords('current', { kind: 'absent', reason: null })).toBe(
      'the live plan cannot be scheduled',
    );
    expect(sideScheduleWords(SAVED, { kind: 'present' })).toBeNull();
    expect(sideScheduleWords(SAVED, { kind: 'unknown' })).toBeNull();
  });
});

describe('the diff, by category', () => {
  it('covers every category be-01 can emit, exactly once', () => {
    // A ratchet, like the schema checks upstream: the count moves only when
    // somebody means it to. `CATEGORY_RANK` is a `Record` over the union, so a
    // category added in `libs/domain` is a typecheck failure here rather than a
    // difference that silently sorts to the end.
    expect(CATEGORY_ORDER).toHaveLength(27);
    expect(new Set(CATEGORY_ORDER).size).toBe(27);
    expect(CATEGORY_ORDER[0]).toBe('added');
    expect(CATEGORY_ORDER.at(-1)).toBe('other');
  });

  it('renders in category order and drops the categories nothing landed in', () => {
    const notes: PlanDifferenceView = { category: 'notes', path: 'a', left: 1, right: 2 };
    const added: PlanDifferenceView = { category: 'added', path: 'b', left: null, right: {} };
    const groups = groupByCategory([notes, added]);
    expect(groups.map((group) => group.category)).toEqual(['added', 'notes']);
    expect(groups).toHaveLength(2);
  });

  it('keeps the diff’s own order inside a group', () => {
    const first: PlanDifferenceView = { category: 'estimates', path: 'w1', left: 1, right: 2 };
    const second: PlanDifferenceView = { category: 'estimates', path: 'w2', left: 3, right: 4 };
    expect(groupByCategory([first, second])[0]?.differences).toEqual([first, second]);
  });

  it('files an unrecognised category under other rather than ahead of everything', () => {
    // Unreachable through be-01, which emits the union. It is asserted because
    // the natural implementation — rank lookup with `?? -1` — sorts an unknown
    // category to the FRONT of the list, which is the loudest possible place
    // for the one heading this build cannot explain.
    const rogue = {
      category: 'sideways',
      path: 'x',
      left: 1,
      right: 2,
    } as unknown as PlanDifferenceView;
    const known: PlanDifferenceView = { category: 'notes', path: 'y', left: 1, right: 2 };
    expect(groupByCategory([rogue, known]).map((group) => group.category)).toEqual([
      'notes',
      'other',
    ]);
  });

  it('reports an empty comparison from both halves, not one', () => {
    expect(diffIsEmpty(diff())).toBe(true);
    expect(diffIsEmpty(diff([dates('schedule.present', true, false)]))).toBe(false);
    expect(diffIsEmpty(diff([], [{ category: 'notes', path: 'a', left: 1, right: 2 }]))).toBe(
      false,
    );
  });
});
