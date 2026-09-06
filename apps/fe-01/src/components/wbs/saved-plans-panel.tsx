import { useEffect, useMemo, useState } from 'react';

import { unreachable } from '../../lib/http';
import type {
  SavedPlanApi,
  SavedPlanListEntryView,
  SavedPlanRenameReply,
  SavedPlanSideRef,
} from '../../lib/saved-plan-api';
import { httpSavedPlanApi, savedPlanFailureCode } from '../../lib/saved-plan-api';
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
  rename: SavedPlanApi['rename'];
}

/**
 * The three real answers, composed from the two factories that already exist.
 *
 * A factory gives the caller one memoised identity for two dependency arrays. Built
 * by spreading rather than by hand so that a fourth dependency added to either
 * hook arrives here without this file being edited to notice.
 */
export const browserSavedPlansDeps = (): SavedPlansPanelDeps => ({
  ...browserShelfDeps(),
  ...browserSaveDeps(),
  compare: (projectId, left, right) => httpSavedPlanApi().compare(projectId, left, right),
  rename: (savedPlanId, name) => httpSavedPlanApi().rename(savedPlanId, name),
});

/** One frozen empty shelf, so "no rows" has a stable identity. */
const EMPTY_ROWS: readonly SavedPlanListEntryView[] = [];

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
  if (state.kind === 'quota') {
    const { allowed, asked, limit } = state.refusal;
    switch (limit) {
      case 'body_bytes':
        return `This checkpoint needs ${String(asked)} bytes; the saved-body limit is ${String(allowed)} bytes.`;
      case 'plan_count':
        return `This would create ${String(asked)} saved plans; this project allows ${String(allowed)}.`;
      case 'project_bytes':
        return `This project would hold ${String(asked)} saved bytes; the project limit is ${String(allowed)}.`;
      default:
        return unreachable(limit);
    }
  }
  if (state.kind === 'error') return `The plan could not be saved (${state.code}).`;
  return null;
}

/**
 * What a rename that did not simply work has to say, or `null` when it worked.
 *
 * 8.2's second half read the same way 8.5 reads the save half: each typed
 * refusal keeps its type all the way to the sentence. Success says nothing —
 * the new name is on the row, which is the confirmation.
 *
 * `not_found` is the shelf being stale rather than the reader being wrong: the
 * plan was deleted between the ✎ and the Enter, so the sentence says so and the
 * refresh that follows takes the row away.
 */
export function renameWords(
  refusal: Extract<SavedPlanRenameReply, { kind: 'refusal' }>['body'],
): string {
  switch (refusal.error) {
    case 'not_found':
      // Proof: replacing this sentence with the generic refusal made the
      // rendered panel test unable to find the deleted-plan sentence and show
      // `The rename was refused (not_found).` instead.
      return 'That saved plan has been deleted, so it could not be renamed.';
    case 'forbidden':
      return 'You cannot rename this saved plan.';
    case 'snapshot_busy':
      return 'This plan is being written to. Try renaming again in a moment.';
    case 'invalid_params':
    case 'unauthenticated':
    case 'unsupported_body_version':
    case 'invalid_query':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'invalid_json':
    case 'invalid_body':
      return `The rename was refused (${refusal.error}).`;
    default:
      return unreachable(refusal);
  }
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
 * **A successful save refreshes the shelf as the actor's fast path.** The
 * controller publishes `saved_plans_changed`, which refreshes collaborators,
 * but making the saver wait for their own event's round trip through the gateway
 * would delay the row they just created. The effect below starts that read as
 * soon as the save answers; the shelf's generation guard already makes its race
 * with the broadcast safe.
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
  /**
   * The last rows the shelf actually delivered, kept across a shelf that stops
   * being `ready`.
   *
   * **A failed list read must not destroy an open comparison** (Sol I5). Every
   * non-`ready` state used to map straight to `EMPTY_ROWS`, and the pickers,
   * the stale affordance and the comparison all render only when `rows` is
   * non-empty — so one transient error on a background refresh unmounted a diff
   * the reader was in the middle of reading and took their picker selections
   * with it. The refresh is triggered by a collaborator's broadcast, not by the
   * reader, which makes the loss arrive unprompted.
   *
   * Retained rather than refetched: the rows are a *list of checkpoints*, and
   * the previous list is the right thing to keep offering while the next read is
   * failing or in flight. `SavedPlanList` above still renders `shelf.state`
   * directly, so the failure itself is on screen — this keeps the comparison,
   * it does not hide the error.
   *
   * The retained value is only ever READ in a non-`ready` state, and it is
   * written by an effect that runs on every `ready` one, so there is no lag:
   * whenever it matters it holds the rows of the last `ready` render.
   *
   * Referential stability is load-bearing, which is why this is not `[]` inline.
   * `rows` is in the dependency array of the default-side effect below, and the
   * derived-default draft of `left` put a fresh object in this same position:
   * the render loop it caused never terminated, so the case measuring it could
   * not be run at all.
   */
  const [lastReadyRows, setLastReadyRows] = useState<readonly SavedPlanListEntryView[]>(EMPTY_ROWS);
  useEffect(() => {
    if (shelf.state.kind === 'ready') setLastReadyRows(shelf.state.rows);
  }, [shelf.state]);
  const rows: readonly SavedPlanListEntryView[] = useMemo(
    () => (shelf.state.kind === 'ready' ? shelf.state.rows : lastReadyRows),
    [shelf.state, lastReadyRows],
  );

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
  /**
   * How many times the reader has asked for the comparison to be brought up to
   * date — and the **only** thing that re-runs one they are already reading.
   *
   * A counter rather than a boolean, so two refreshes in a row are two runs: a
   * flag would flip true, re-run, flip false, and a second click while the
   * first request was in flight would change nothing. It is in the compare
   * effect's dependency array beside the pair, which is what makes 8.4's
   * "does not change until it is used" a fact about the code rather than a
   * promise about the shelf.
   */
  const [asked, setAsked] = useState(0);
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
      .then((reply): SavedPlanComparisonState => {
        switch (reply.kind) {
          case 'success':
            return {
              kind: 'ready',
              left,
              right,
              diff: reply.body.diff,
              schedules: resolveSideSchedules(left, right, reply.body.diff, rows),
              rows,
            };
          case 'failure':
            return { kind: 'error', code: savedPlanFailureCode(reply.failure) };
          case 'refusal':
            // Proof: mapping corrupt to the generic error state rendered
            // `The comparison could not be read (corrupt).`; the panel test
            // expected the saved id and `body_missing` integrity reason.
            switch (reply.body.error) {
              case 'corrupt':
                return {
                  kind: 'unreadable',
                  savedPlanId: reply.body.savedPlanId,
                  refusal: reply.body.refusal.reason,
                };
              case 'not_found':
                return { kind: 'gone', savedPlanId: reply.body.savedPlanId ?? null };
              case 'invalid_params':
              case 'unauthenticated':
              case 'unsupported_body_version':
              case 'invalid_body':
              case 'invalid_query':
                return { kind: 'error', code: reply.body.error };
              default:
                return unreachable(reply.body);
            }
          default:
            return unreachable(reply);
        }
      })
      .catch(
        (fault: unknown): SavedPlanComparisonState => ({
          kind: 'error',
          code: fault instanceof Error ? fault.message : String(fault),
        }),
      )
      .then((next) => {
        if (!cancelled) setComparison(next);
      });
    return () => {
      cancelled = true;
    };
    // `rows` is deliberately absent. It is read for the schedule fallback and
    // the side names, and a broadcast that changes it must not re-run a
    // comparison the reader is looking at (AC #4). `asked` is how they get the
    // newer one: the affordance below bumps it, this effect re-runs, and the
    // `rows` it closes over are that render's — which is to say, current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps, projectId, left, right, asked]);

  /**
   * Whether the shelf has moved under a comparison that is on screen.
   *
   * Identity and not contents, and that is the honest test rather than a lazy
   * one: `rows` is a fresh array per read, and the shelf reads exactly when
   * something happened to it — on mount, on a project change, on a broadcast,
   * and on the refresh a save or a rename triggers. Comparing ids instead would
   * call a broadcast "nothing changed" whenever the *list* was untouched, and
   * that is wrong because the list is not the only side of the comparison that
   * can move: `right` is usually `current`, so an ordinary plan broadcast leaves
   * every saved-plan id unchanged while the live side moves out from under the
   * comparison on screen. (A `saved_plans_changed` broadcast from a save or a
   * delete changes the id set, so ids would have caught those two; a rename does
   * not, and neither does the case above. Identity catches all of them.)
   *
   * Only over `ready`. There is nothing to leave alone while a comparison is
   * loading, refused or failed, and offering to refresh one of those would be
   * a second control for what the pickers already do.
   */
  const stale = comparison.kind === 'ready' && comparison.rows !== rows;

  /**
   * What the last rename said, or `null` while none has anything to say.
   *
   * Held here rather than per row: one rename is armed at a time, and a refusal
   * belongs beside the shelf it is about rather than inside a row that the
   * refresh is about to replace.
   */
  const [renameRefusal, setRenameRefusal] = useState<string | null>(null);
  const rename = (savedPlanId: string, name: string) => {
    setRenameRefusal(null);
    void deps
      .rename(savedPlanId, name)
      .then((reply) => {
        switch (reply.kind) {
          case 'success':
            setRenameRefusal(null);
            break;
          case 'failure':
            setRenameRefusal(
              `The rename could not be sent (${savedPlanFailureCode(reply.failure)}).`,
            );
            break;
          case 'refusal':
            setRenameRefusal(renameWords(reply.body));
            break;
          default:
            unreachable(reply);
        }
        // On every reply, not only on success. `not_found` means the shelf is
        // showing a row be-01 no longer has, which is exactly when a re-read is
        // worth making. A successful rename also broadcasts, but this local
        // refresh avoids waiting for the actor's own gateway round trip; the
        // shelf's generation guard makes the two reads safe together.
        refresh();
      })
      .catch((fault: unknown) => {
        setRenameRefusal(
          `The rename could not be sent (${fault instanceof Error ? fault.message : String(fault)}).`,
        );
      });
  };

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
      <SavedPlanList state={shelf.state} onRename={rename} />
      {/*
        `status` and not `alert`, for the same reason the save line is: a refused
        rename is a refusal of something the reader just asked for and is looking
        at, and an assertive region would interrupt a screen reader mid-sentence.
      */}
      {renameRefusal !== null && (
        <p className="saved-plans-panel__rename-status" role="status">
          {renameRefusal}
        </p>
      )}
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
          {/*
            8.4's affordance, and it is an offer rather than a replacement. The
            comparison below is still the one the reader asked for; this says
            the plan moved and hands them the button. Swapping it for them is
            what AC #4 forbids — somebody reading a diff would lose their place
            to a collaborator's save.

            `status` and not `alert`: nothing is wrong, and an assertive region
            would interrupt a screen reader mid-diff to say so. The sentence and
            the button are siblings so the live region announces the fact rather
            than reading out a control the reader has not reached yet.
          */}
          {stale && (
            <div className="saved-plans-panel__stale">
              <p role="status">This plan has changed since the comparison below was made.</p>
              <button
                type="button"
                onClick={() => {
                  setAsked((n) => n + 1);
                }}
              >
                Compare again
              </button>
            </div>
          )}
          <SavedPlanComparison state={comparison} />
        </div>
      )}
    </section>
  );
}
