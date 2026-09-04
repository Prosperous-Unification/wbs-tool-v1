import { useEffect, useState } from 'react';

import type {
  SavedPlanApi,
  SavedPlanListEntryView,
  SavedPlanSideRef,
} from '../../lib/saved-plan-api';
import { httpSavedPlanApi } from '../../lib/saved-plan-api';
import { compareRefusal, resolveSideSchedules } from '../../lib/saved-plan-compare';
import type { SaveDeps, SavedPlanSaveState } from '../../lib/saved-plan-save';
import { browserSaveDeps, useSavedPlanSave } from '../../lib/saved-plan-save';
import type { ShelfWatchDeps } from '../../lib/saved-plan-shelf';
import { browserShelfDeps, useSavedPlanShelf } from '../../lib/saved-plan-shelf';
import type { SavedPlanComparisonState } from './saved-plan-compare';
import { SavedPlanComparison, SavedPlanSidePicker } from './saved-plan-compare';
import { SavedPlanList } from './saved-plan-list';

/**
 * Everything the panel asks of the outside world, as one object.
 *
 * One object and not three props because the caller has to hold its identity
 * anyway — {@link useSavedPlanShelf} and {@link useSavedPlanSave} both have
 * their deps in a dependency array — and three memoised objects is three chances
 * to forget one. A single `useMemo` over {@link browserSavedPlansDeps} is the
 * whole contract.
 */
export interface SavedPlansPanelDeps extends ShelfWatchDeps, SaveDeps {
  compare: SavedPlanApi['compare'];
}

/**
 * The three real answers, composed from the two factories that already exist.
 *
 * A factory for their reason — every one of them needs the token — and the
 * caller memoises the result, because it lands in two dependency arrays. Built
 * by spreading rather than by hand so that a fourth dependency added to either
 * hook arrives here without this file being edited to notice.
 */
export const browserSavedPlansDeps = (token: string): SavedPlansPanelDeps => ({
  ...browserShelfDeps(token),
  ...browserSaveDeps(token),
  compare: (projectId, left, right) => httpSavedPlanApi(token).compare(projectId, left, right),
});

/** 8.5's copy for the save half, in one place so the surface and its cases cannot drift. */
export const SAVE_BUSY = 'This plan is being written to. Press Save again in a moment.';

/**
 * What the Save button's status line says, or `null` when it has nothing to say.
 *
 * A function rather than four branches inside the render, because the two
 * refusals are the interesting half of 8.5 and a case can hold this against its
 * input without a renderer. `saving` says nothing on purpose: the button is
 * already disabled and labelled, and a second "saving…" beside it is noise on
 * the fastest path.
 */
export function saveWords(state: SavedPlanSaveState): string | null {
  if (state.kind === 'saved') {
    // AC #1's "authoritative timestamp": be-01's own `created_at`, which is also
    // where the record's name came from. Rendered from the response rather than
    // re-read from the shelf — the answer is already in hand, and a confirmation
    // that waits for a second request is a slower one for no new fact.
    return `Saved ${state.savedPlan.name} at ${new Date(state.savedPlan.createdAt).toLocaleString()}.`;
  }
  if (state.kind === 'busy') return SAVE_BUSY;
  // Named rather than retried: `quota` carries be-01's sentence about the limit
  // that was reached, and inviting a retry would send the user at a button that
  // cannot work until they delete something.
  if (state.kind === 'quota') return state.refusal;
  if (state.kind === 'error') return `The plan could not be saved (${state.code}).`;
  return null;
}

/**
 * The shelf, the Save action and the comparison, wired into one mountable thing.
 *
 * **This is the component that makes slice 8 reachable.** Every part below was
 * built and gated on its own — `SavedPlanList`, `useSavedPlanSave`,
 * `useSavedPlanShelf`, `SavedPlanComparison` — and until this file existed no
 * screen rendered any of them, so every one of those green suites was a suite
 * over a feature no user could get to.
 *
 * **A successful save refreshes the shelf, and that is a hole in the broadcast
 * rather than belt-and-braces.** `saved-plan.controller.ts` publishes nothing on
 * save, so the stream `useSavedPlanShelf` listens to is the *plan's*: the user's
 * own checkpoint is the single change that never arrives on it. Without the
 * effect below, pressing Save leaves the new row invisible until somebody edits
 * the project.
 */
export function SavedPlansPanel({
  projectId,
  deps,
}: {
  projectId: string;
  deps: SavedPlansPanelDeps;
}) {
  const shelf = useSavedPlanShelf(deps, projectId);
  const { state: saveState, save } = useSavedPlanSave(deps, projectId);
  const rows: readonly SavedPlanListEntryView[] =
    shelf.state.kind === 'ready' ? shelf.state.rows : [];

  const { refresh } = shelf;
  useEffect(() => {
    if (saveState.kind !== 'saved') return;
    refresh();
    // `saveState` and not `saveState.kind`: the hook writes a fresh object per
    // save, so a second save of the same project re-runs this. Keyed on the kind
    // alone, saving twice would refresh once and leave the second checkpoint off
    // the shelf — the exact bug this effect exists to prevent, in its rarer form.
  }, [saveState, refresh]);

  /**
   * The chosen sides, `null` until the reader picks or the shelf supplies a
   * default.
   *
   * The default is `the newest saved plan` against `current` — the question
   * somebody opening this panel is nearly always asking — and it is pinned once,
   * by the effect below, rather than derived from `rows[0]` on every render. A
   * derived default would follow the shelf: a collaborator saving a plan would
   * silently re-point a picker the reader had left alone and swap the comparison
   * under them, which is precisely what AC #4 forbids.
   */
  const [left, setLeft] = useState<SavedPlanSideRef | null>(null);
  const [right, setRight] = useState<SavedPlanSideRef>('current');
  useEffect(() => {
    if (left !== null || rows.length === 0) return;
    setLeft({ saved: rows[0].id });
  }, [left, rows]);

  const [comparison, setComparison] = useState<SavedPlanComparisonState>({ kind: 'idle' });
  useEffect(() => {
    if (left === null) return;
    const refusal = compareRefusal(left, right);
    if (refusal !== null) {
      setComparison({ kind: 'refused', reason: refusal });
      return;
    }
    // The same superseded-answer guard `watchShelf` carries, for the same
    // reason: changing a picker twice leaves two requests in flight and the
    // slower one is the older answer roughly half the time.
    let cancelled = false;
    setComparison({ kind: 'loading' });
    void deps
      .compare(projectId, left, right)
      .then((result): SavedPlanComparisonState => {
        if (result.outcome === 'compared') {
          return {
            kind: 'ready',
            left,
            right,
            diff: result.diff,
            schedules: resolveSideSchedules(left, right, result.diff, rows),
            rows,
          };
        }
        // `corrupt` names its side and `not_found` names it when it has one:
        // with two pickers on screen, a refusal naming no plan leaves the reader
        // unable to tell which of them holds the damaged one.
        if (result.outcome === 'corrupt') {
          return { kind: 'error', code: `${result.refusal} (${result.savedPlanId})` };
        }
        return {
          kind: 'error',
          code: result.savedPlanId === null ? 'not_found' : `not_found (${result.savedPlanId})`,
        };
      })
      .catch((fault: unknown): SavedPlanComparisonState => ({
        kind: 'error',
        code: fault instanceof Error ? fault.message : String(fault),
      }))
      .then((next) => {
        if (!cancelled) setComparison(next);
      });
    return () => {
      cancelled = true;
    };
    // `rows` is deliberately absent. It is read for the schedule fallback and
    // the side names, and a broadcast that changes it must not re-run a
    // comparison the reader is looking at (AC #4, and 8.4's refresh affordance
    // is what will offer them the newer one). The pair and the project are the
    // whole question this effect asks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps, projectId, left, right]);

  const words = saveWords(saveState);
  return (
    /*
      Deliberately unnamed, with a heading instead. `SavedPlanList` already
      labels its own `<ol>` "Saved plans", and an `aria-label` here would make
      the region and the list inside it two landmarks of one name — the reader
      hears the same words twice and cannot tell which one they have landed on.
      An unnamed `<section>` is generic rather than a landmark, so the heading
      is what carries the navigation and nothing is said twice.
    */
    <section className="saved-plans-panel">
      <h3 className="saved-plans-panel__heading">Saved plans</h3>
      <div className="saved-plans-panel__actions">
        <button type="button" onClick={save} disabled={saveState.kind === 'saving'}>
          Save plan
        </button>
        {/*
          `status` and not `alert`: a save that was refused is still a refusal of
          something the reader just asked for and is looking at, and an assertive
          live region would interrupt a screen reader mid-sentence to say so.
          AC #1's "without blocking continued planning" is about the editor, and
          this is the same principle one control down.
        */}
        {words !== null && (
          <p className="saved-plans-panel__save-status" role="status">
            {words}
          </p>
        )}
      </div>
      <SavedPlanList state={shelf.state} />
      {/*
        No shelf, no comparison. Two pickers whose only option is `the current
        plan` can ask exactly one question, and that question is the one
        `compareRefusal` declines — so an empty shelf would render a refusal
        sentence for a choice the reader was never offered.
      */}
      {rows.length > 0 && left !== null && (
        <div className="saved-plans-panel__compare">
          <SavedPlanSidePicker label="Compare" value={left} rows={rows} onChange={setLeft} />
          <SavedPlanSidePicker label="with" value={right} rows={rows} onChange={setRight} />
          <SavedPlanComparison state={comparison} />
        </div>
      )}
    </section>
  );
}
