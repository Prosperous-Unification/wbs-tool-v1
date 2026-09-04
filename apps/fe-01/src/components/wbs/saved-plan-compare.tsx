import type {
  PlanDifferenceView,
  PlanDiffView,
  SavedPlanListEntryView,
  SavedPlanSideRef,
} from '../../lib/saved-plan-api';
import type { SideSchedules } from '../../lib/saved-plan-compare';
import {
  COMPARE_SAME_SIDE,
  diffIsEmpty,
  groupByCategory,
  sideScheduleWords,
} from '../../lib/saved-plan-compare';

/** The value a picker holds, as a `<select>` can carry it. */
export const CURRENT_OPTION = 'current';

/** A side reference, from the string a `<select>` gives back. */
export const sideOf = (value: string): SavedPlanSideRef =>
  value === CURRENT_OPTION ? 'current' : { saved: value };

/** The string form of a side reference, for a `<select>`'s `value`. */
export const valueOf = (side: SavedPlanSideRef): string =>
  side === CURRENT_OPTION ? CURRENT_OPTION : side.saved;

/** How a side is named in a heading. `current` has no row and no name of its own. */
export function sideLabel(side: SavedPlanSideRef, rows: readonly SavedPlanListEntryView[]): string {
  if (side === 'current') return 'the current plan';
  return rows.find((row) => row.id === side.saved)?.name ?? side.saved;
}

/**
 * One picker: the live plan, then the shelf newest first as be-01 orders it.
 *
 * `current` is listed **first and always**, including on an empty shelf. It is
 * not one of the saved plans and its position should not move when somebody
 * else saves one; a picker whose first entry changes under the reader is a
 * picker they have to re-read every time the broadcast lands.
 */
export function SavedPlanSidePicker({
  label,
  value,
  rows,
  onChange,
}: {
  label: string;
  value: SavedPlanSideRef;
  rows: readonly SavedPlanListEntryView[];
  onChange: (side: SavedPlanSideRef) => void;
}) {
  return (
    <label className="saved-plan-compare__picker">
      {label}{' '}
      <select value={valueOf(value)} onChange={(event) => onChange(sideOf(event.target.value))}>
        <option value={CURRENT_OPTION}>the current plan</option>
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * What a comparison can be showing.
 *
 * `refused` is separate from `error` for the shelf's reason one module over: two
 * pickers on the same plan is a question this surface declines to ask, not a
 * request that failed. Rendering it as an error would offer a retry for
 * something no retry changes.
 */
export type SavedPlanComparisonState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'refused'; readonly reason: 'same_side' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: string }
  | {
      readonly kind: 'ready';
      readonly left: SavedPlanSideRef;
      readonly right: SavedPlanSideRef;
      readonly diff: PlanDiffView;
      readonly schedules: SideSchedules;
      readonly rows: readonly SavedPlanListEntryView[];
    };

/** One side's heading and, when it has one, its own absence sentence. */
function SideSummary({
  side,
  schedule,
  rows,
  which,
}: {
  side: SavedPlanSideRef;
  schedule: SideSchedules['left'];
  rows: readonly SavedPlanListEntryView[];
  which: 'left' | 'right';
}) {
  const words = sideScheduleWords(side, schedule);
  return (
    <div className={`saved-plan-compare__side saved-plan-compare__side--${which}`}>
      <span className="saved-plan-compare__side-name">{sideLabel(side, rows)}</span>
      {/*
        Rendered only when there is something to say. A side WITH a schedule
        gets no sentence rather than "has a schedule": the comparison below
        already reports every way the two schedules differ, and a line
        confirming the ordinary case on both sides would push the differences
        off the top of the panel.
      */}
      {words === null ? null : <span className="saved-plan-compare__absent">{words}</span>}
    </div>
  );
}

/** One half of the diff, by category, or nothing when the half is empty. */
function DiffHalf({
  title,
  differences,
}: {
  title: string;
  differences: readonly PlanDifferenceView[];
}) {
  if (differences.length === 0) return null;
  return (
    <section className="saved-plan-compare__half" aria-label={title}>
      <h4>{title}</h4>
      {groupByCategory(differences).map((group) => (
        <div key={group.category} className="saved-plan-compare__group">
          <h5>{group.category}</h5>
          <ul>
            {group.differences.map((difference) => (
              <li key={difference.path} className="saved-plan-compare__difference">
                {difference.path}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * A comparison of two plans, rendered.
 *
 * Presentational, like {@link SavedPlanList}: it is handed a state and draws it,
 * which is what lets the branches nobody can reach by clicking — `refused` on a
 * pair the pickers will not offer, an `unknown` schedule on a stale shelf — be
 * cases rather than reasoning.
 *
 * The two halves are kept apart because they are bounded apart upstream
 * (`PlanDiff`'s own note): the input half by `CanonicalPlanInput`'s field list,
 * the schedule half by the stored schedule's field set. Concatenating them here
 * would report a changed estimate and a changed start date as one list, which is
 * the distinction a reader opens this panel to make.
 */
export function SavedPlanComparison({ state }: { state: SavedPlanComparisonState }) {
  if (state.kind === 'idle') {
    return <p className="saved-plan-compare__note">Pick two plans to compare.</p>;
  }
  if (state.kind === 'refused') {
    return <p className="saved-plan-compare__note">{COMPARE_SAME_SIDE}</p>;
  }
  if (state.kind === 'loading') {
    return (
      <p className="saved-plan-compare__note" role="status">
        Comparing…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p className="saved-plan-compare__note" role="alert">
        The comparison could not be read ({state.code}).
      </p>
    );
  }
  return (
    <div className="saved-plan-compare">
      <div className="saved-plan-compare__sides">
        <SideSummary
          which="left"
          side={state.left}
          schedule={state.schedules.left}
          rows={state.rows}
        />
        <SideSummary
          which="right"
          side={state.right}
          schedule={state.schedules.right}
          rows={state.rows}
        />
      </div>
      {/*
        "Nothing changed" is a real answer and one of the two the reader came
        for, so it is said rather than left as an empty panel they cannot tell
        from a comparison that failed to draw.
      */}
      {diffIsEmpty(state.diff) ? (
        <p className="saved-plan-compare__note">No differences.</p>
      ) : (
        <>
          <DiffHalf title="The plan" differences={state.diff.input} />
          <DiffHalf title="The schedule" differences={state.diff.schedule} />
        </>
      )}
    </div>
  );
}
