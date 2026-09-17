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
  diffValueWords,
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
      <select
        value={valueOf(value)}
        onChange={(event) => {
          onChange(sideOf(event.target.value));
        }}
      >
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
  /**
   * be-01 has no such saved plan. The id is `null` when the refusal named no
   * plan — the project itself was the thing not found — and that is a different
   * sentence rather than the same one with a gap in it.
   *
   * A state of its own and not `error` with a code in it (8.5). A refusal the
   * API layer already typed, flattened back into a string for the renderer to
   * print in brackets, is a design that spent be-01's work on nothing: the
   * reader gets `not_found (sp1)` where they could have been told the plan was
   * deleted and that picking another is what to do next.
   */
  | { readonly kind: 'gone'; readonly savedPlanId: string | null }
  /**
   * The stored plan is there and cannot be read. `refusal` is be-01's own word
   * for why, kept verbatim because it is the only thing that distinguishes one
   * unreadable plan from another when somebody comes to look at the row.
   */
  | { readonly kind: 'unreadable'; readonly savedPlanId: string; readonly refusal: string }
  /** A fault rather than a refusal: the request did not complete. */
  | { readonly kind: 'error'; readonly code: string }
  | {
      readonly kind: 'ready';
      readonly left: SavedPlanSideRef;
      readonly right: SavedPlanSideRef;
      readonly diff: PlanDiffView;
      readonly schedules: SideSchedules;
      readonly rows: readonly SavedPlanListEntryView[];
    };

/**
 * 8.5's sentence for a saved plan be-01 no longer has.
 *
 * Two sentences and not one with a hole in it. With an id, the plan named on a
 * picker is the thing that went — deleted by a collaborator between the pick
 * and the compare — and the next move is to pick another. With no id, be-01
 * refused the *project*, which no choice on this panel can fix, so offering one
 * would send the reader round a loop.
 *
 * A function so both branches can be held against their input without a
 * renderer, and exported because a case that retypes the copy is a case that
 * goes green while the surface says something else.
 */
export function compareGoneWords(savedPlanId: string | null): string {
  if (savedPlanId === null) return 'This project no longer has any saved plans to compare.';
  return `That saved plan (${savedPlanId}) is no longer here — it has been deleted. Pick another to compare.`;
}

/**
 * 8.5's sentence for a stored plan that cannot be read.
 *
 * The id and be-01's own refusal, both. With two pickers on screen a refusal
 * naming no plan leaves the reader unable to tell which side holds the damaged
 * one — be-01's reason for putting `savedPlanId` on its 422 — and the refusal
 * word is the only thing that tells one unreadable plan from another when
 * somebody comes to look at the row. Deliberately **not** an invitation to
 * retry: rereading a stored plan gives the same bytes and the same answer.
 */
export function compareUnreadableWords(savedPlanId: string, refusal: string): string {
  return `That saved plan (${savedPlanId}) cannot be read (${refusal}), so it cannot be compared. Pick another.`;
}

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

/**
 * One difference: what it is, and what it went from and to.
 *
 * The path alone was the whole line until now, and a path is not an answer —
 * `workItems[w1].name` says a name changed and refuses to say to what, which is
 * the one thing a reader opens a comparison to learn. Both sides come down the
 * wire on every difference; be-01 computed them and this surface was dropping
 * them on the floor.
 *
 * The left and right sides are separate elements rather than one formatted
 * string so the arrow between them is a sibling, not a delimiter inside a value:
 * a stored string containing `→` would otherwise be indistinguishable from the
 * separator when anything reads the line back.
 */
function Difference({ difference }: { difference: PlanDifferenceView }) {
  return (
    <li className="saved-plan-compare__difference">
      <span className="saved-plan-compare__path">{difference.path}</span>{' '}
      <span className="saved-plan-compare__change">
        <span className="saved-plan-compare__value saved-plan-compare__value--left">
          {diffValueWords(difference.left)}
        </span>
        {' → '}
        <span className="saved-plan-compare__value saved-plan-compare__value--right">
          {diffValueWords(difference.right)}
        </span>
      </span>
    </li>
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
              <Difference key={difference.path} difference={difference} />
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
  if (state.kind === 'gone') {
    return (
      <p className="saved-plan-compare__note" role="alert">
        {compareGoneWords(state.savedPlanId)}
      </p>
    );
  }
  if (state.kind === 'unreadable') {
    return (
      <p className="saved-plan-compare__note" role="alert">
        {compareUnreadableWords(state.savedPlanId, state.refusal)}
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
