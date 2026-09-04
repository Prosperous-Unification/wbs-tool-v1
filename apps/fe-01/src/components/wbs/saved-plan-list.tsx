import type { SavedPlanListEntryView } from '../../lib/saved-plan-api';

/**
 * What the shelf can be showing, as one value.
 *
 * A union rather than three booleans beside an array, because the states are
 * genuinely exclusive and the interesting one — `unavailable` — is not a
 * failure. A node without the routes is a healthy node that cannot answer this
 * question, and modelling it as `error` with a special code would put it one
 * `if` away from being rendered as a fault the reader is asked to retry.
 */
export type SavedPlanListState =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'ready'; readonly rows: readonly SavedPlanListEntryView[] };

/** 6.4's sentence, in one place so the test and the surface cannot drift apart. */
export const SAVED_PLANS_UNAVAILABLE = 'Saved plans are not available on this node yet.';

/**
 * What a row says about its schedule.
 *
 * Three answers and not two. A saved plan either carries a schedule, or carries
 * a recorded reason it does not, or carries neither — and the third is a row
 * saved by a be-01 whose reasons this build has never heard of, which the API
 * layer deliberately passes through rather than narrowing. Saying "no schedule
 * was saved" for it would be true; saying it *without* the reason throws away
 * the only thing distinguishing an infeasible plan from one saved on purpose
 * without its dates.
 */
export function scheduleWords(row: SavedPlanListEntryView): string {
  if (row.scheduleBytes !== null) return 'with its schedule';
  return row.scheduleAbsentReason === null
    ? 'no schedule was saved'
    : `no schedule was saved (${row.scheduleAbsentReason})`;
}

/**
 * A project's saved plans, newest first as be-01 orders them.
 *
 * Presentational: it is handed a state and renders it. The read, the broadcast
 * refresh and the save action are the caller's, which is what lets every branch
 * below — including the two nobody can reach by clicking — be a case.
 */
export function SavedPlanList({ state }: { state: SavedPlanListState }) {
  if (state.kind === 'unavailable') {
    return <p className="saved-plan-list__note">{SAVED_PLANS_UNAVAILABLE}</p>;
  }
  if (state.kind === 'loading') {
    return (
      <p className="saved-plan-list__note" role="status">
        Loading saved plans…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p className="saved-plan-list__note" role="alert">
        Saved plans could not be read ({state.code}).
      </p>
    );
  }
  if (state.rows.length === 0) {
    return <p className="saved-plan-list__note">No plans saved yet.</p>;
  }
  return (
    <ol className="saved-plan-list" aria-label="Saved plans">
      {state.rows.map((row) => (
        <li key={row.id} className="saved-plan-list__row">
          <span className="saved-plan-list__name">{row.name}</span>{' '}
          {/*
            The machine-readable instant is the assertion, and the visible text
            is `toLocaleString`'s — deliberately. A saved plan's timestamp is
            be-01's clock, and the reader is entitled to see it in their own zone
            and their own conventions; a fixed English rendering would be the
            same wrong string for everybody outside one locale. So the fact goes
            in `dateTime` where a case can hold it steady, and the words are the
            browser's.
          */}
          <time className="saved-plan-list__when" dateTime={new Date(row.createdAt).toISOString()}>
            {new Date(row.createdAt).toLocaleString()}
          </time>{' '}
          <span className="saved-plan-list__who">saved by {row.createdBy}</span>{' '}
          <span className="saved-plan-list__schedule">{scheduleWords(row)}</span>
        </li>
      ))}
    </ol>
  );
}
