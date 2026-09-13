import { useEffect, useRef, useState } from 'react';

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
 * A row's name, and the rename that is an edit on it rather than a modal.
 *
 * 8.2's second half. The saved plan itself is immutable — `name` is the one
 * column any `UPDATE` may target, which slice 2's source check enforces — so
 * this is the only edit the shelf offers, and it is offered where the name is
 * rather than behind a dialog that would put a decision in front of the reader
 * before they had one to make.
 *
 * The idiom is `ProjectPage`'s `ProjectNameField`, one screen up, and so are its
 * two lessons. The field is a **component**, mounted on arming, so the focus and
 * the whole-draft selection happen once instead of on every keystroke — an
 * inline callback ref is a new function per render, so React reattaches it each
 * time and a `select()` there would put the draft back under the next character.
 * And a draft that trims to nothing, or to the name the row already has, is a
 * **cancel**: an empty name would leave the row unidentifiable on a shelf whose
 * whole job is telling checkpoints apart, and an unchanged one is a request that
 * changes nothing.
 */
function SavedPlanName({
  row,
  onRename,
}: {
  row: SavedPlanListEntryView;
  onRename: (savedPlanId: string, name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // Narrowing rather than a guard: this runs only while the field is mounted.
    if (draft === null || field.current === null) return;
    field.current.focus();
    field.current.select();
    // Once per arming. `draft` in the array would refocus on every keystroke;
    // the arming transition is `null` → a string and that is what is watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft === null]);

  const commit = () => {
    if (draft === null) return;
    const typed = draft.trim();
    setDraft(null);
    if (typed === '' || typed === row.name) return;
    onRename(row.id, typed);
  };

  if (draft === null) {
    return (
      <>
        <span className="saved-plan-list__name">{row.name}</span>{' '}
        <button
          type="button"
          className="saved-plan-list__rename"
          // Named for the plan it renames, because a shelf renders one of these
          // per row and `Rename` alone would give a screen reader a list of
          // identical controls.
          aria-label={`Rename ${row.name}`}
          onClick={() => {
            setDraft(row.name);
          }}
        >
          ✎
        </button>
      </>
    );
  }
  return (
    <input
      ref={field}
      className="saved-plan-list__name-field"
      aria-label="Saved plan name"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      // Blur commits, which also gives the rename a mouse exit: click anywhere
      // else and the mode resolves instead of sitting open forever.
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/**
 * A project's saved plans, newest first as be-01 orders them.
 *
 * Presentational: it is handed a state and renders it. The read, the broadcast
 * refresh and the save action are the caller's, which is what lets every branch
 * below — including the two nobody can reach by clicking — be a case.
 */
export function SavedPlanList({
  state,
  onRename,
}: {
  state: SavedPlanListState;
  /**
   * Renames a row, or absent where nothing may be renamed.
   *
   * Optional because every other branch of this component renders without one
   * and the three states above have no rows to rename. Absent, no row offers
   * the control at all — a ✎ that opens a field whose commit goes nowhere is a
   * worse surface than a name that plainly cannot be changed.
   */
  onRename?: (savedPlanId: string, name: string) => void;
}) {
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
          {onRename === undefined ? (
            <span className="saved-plan-list__name">{row.name}</span>
          ) : (
            <SavedPlanName row={row} onRename={onRename} />
          )}{' '}
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
