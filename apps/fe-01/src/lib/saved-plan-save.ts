import { useCallback, useEffect, useRef, useState } from 'react';

import type { SavedPlanApi, SavedPlanListEntryView } from './saved-plan-api';
import { httpSavedPlanApi } from './saved-plan-api';

/**
 * The one question a save is made of, injected for {@link ShelfDeps}'s reason.
 *
 * Narrower than {@link SavedPlanApi} on purpose: a fake for these cases is one
 * line, and this hook cannot grow an opinion about listing or comparing without
 * the signature changing to say so.
 */
export interface SaveDeps {
  save: SavedPlanApi['save'];
}

/**
 * Where one save has got to.
 *
 * `saved` carries the record rather than a bare flag because AC #1 asks the
 * surface to confirm success *with the authoritative timestamp* — which only
 * be-01 knows, and which arrives in this response. Re-reading the shelf to find
 * out what was just written would be a second request for an answer already in
 * hand, and a slower confirmation than the user deserves.
 *
 * The two refusals stay separate for `SavedPlanSaveResult`'s reason: they are
 * said in different words. `busy` is "somebody else is writing, press it again";
 * `quota` names a limit and is not retryable, so a surface that merged them
 * would invite the user to hammer a button that cannot work.
 */
export type SavedPlanSaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly savedPlan: SavedPlanListEntryView }
  | { readonly kind: 'busy' }
  | { readonly kind: 'quota'; readonly refusal: string }
  | { readonly kind: 'error'; readonly code: string };

/** {@link readShelf}'s rule, for the same reason: show what arrived, never erase it. */
const codeOf = (fault: unknown): string => (fault instanceof Error ? fault.message : String(fault));

/**
 * The Save plan action: one deliberate press, one immutable checkpoint.
 *
 * **The name is not this hook's to supply, and it does not have one to pass.**
 * `save(projectId)` is called with a single argument — assumption A-1, closed in
 * be-01 at `defaultSavedPlanName`. The record is named from the same
 * `created_at` it is stamped with, so the name and the timestamp beside it on
 * the shelf are one value rendered twice and cannot drift apart. Naming is an
 * edit afterwards (the rename route), not a modal in front of the button.
 *
 * **A press while a save is in flight is ignored, and that is the difference
 * between one checkpoint and two.** A saved plan is immutable and every save
 * writes a new row, so a double-click on a slow connection leaves two
 * indistinguishable rows a second apart, both correct and one of them
 * meaningless. AC #1's "confirms success without blocking continued planning" is
 * about the *plan*, not about the button: nothing here freezes the editor, and
 * the guard covers only the request.
 *
 * **State never lands after unmount.** The mounted ref is checked on the way
 * back, not merely on the way in, because the whole point of the in-flight
 * window is that the component can leave during it.
 */
export function useSavedPlanSave(
  deps: SaveDeps,
  projectId: string,
): { readonly state: SavedPlanSaveState; readonly save: () => void } {
  const [state, setState] = useState<SavedPlanSaveState>({ kind: 'idle' });
  const mounted = useRef(true);
  // The in-flight flag is a ref and not the `state` above, because two presses
  // in one React batch both read the same rendered state and would both pass a
  // `state.kind !== 'saving'` test. A ref is written before the await and read
  // synchronously, which is the only ordering that makes the guard true.
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const save = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: 'saving' });
    void deps
      .save(projectId)
      .then((result): SavedPlanSaveState => {
        if (result.outcome === 'saved') return { kind: 'saved', savedPlan: result.savedPlan };
        if (result.outcome === 'snapshot_busy') return { kind: 'busy' };
        return { kind: 'quota', refusal: result.refusal };
      })
      .catch((fault: unknown): SavedPlanSaveState => ({ kind: 'error', code: codeOf(fault) }))
      .then((next) => {
        // Cleared even when nobody is listening: a component that unmounts
        // mid-save and is mounted again from the same `deps` would otherwise
        // hold a ref that says a request is running which finished long ago,
        // and its Save button would never work again.
        inFlight.current = false;
        if (mounted.current) setState(next);
      });
  }, [deps, projectId]);

  return { state, save };
}

/**
 * The real answer, wired to the module that gives it.
 *
 * A factory for {@link browserShelfDeps}'s reason — `save` needs the token — and
 * the caller holds its identity, because it is in this hook's dependency array.
 */
export const browserSaveDeps = (token: string): SaveDeps => ({
  save: (projectId, name) => httpSavedPlanApi(token).save(projectId, name),
});
