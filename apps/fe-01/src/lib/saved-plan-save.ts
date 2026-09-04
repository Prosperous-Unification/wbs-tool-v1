import { useCallback, useEffect, useState } from 'react';

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

/** A save that has been issued and has not landed yet, and who is waiting on it. */
interface RunningSave {
  readonly waiting: Set<(next: SavedPlanSaveState) => void>;
}

/**
 * The saves currently in flight, keyed by the API they went through and then by
 * project — **outside any component**, which is the whole point.
 *
 * A save's owner is the *project*, not the mount that pressed the button. The
 * guard used to be a `useRef` and `ProjectPage` moves one `SavedPlanShelf`
 * between the app-header row and the cards renderer's toolbar sheet, so crossing
 * 768px wide or 500px tall replaces the shelf with a fresh instance holding a
 * fresh open lock. Two things then went wrong at once, both deterministic rather
 * than racy: a second press wrote a second immutable checkpoint for one user
 * action, and the first request settled into a component nobody was rendering,
 * so `SavedPlansPanel`'s save-completion refresh never ran — and with be-01
 * broadcasting nothing on save (TASK-255) that refresh is the only thing that
 * puts the reader's own checkpoint on their own shelf.
 *
 * **Keyed by `deps` rather than module-global**, which is a test property as
 * much as a design one: `SaveDeps` is the injected API, so two suites, two
 * fakes, or two tokens never share a lock, and a case cannot leak one into the
 * next through module state that outlives it. A `WeakMap` because the key is an
 * object nobody here should keep alive.
 */
const runningSaves = new WeakMap<SaveDeps, Map<string, RunningSave>>();

function runningFor(deps: SaveDeps, projectId: string): RunningSave | undefined {
  return runningSaves.get(deps)?.get(projectId);
}

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
 * **There is deliberately no unmount guard**, and that is a measurement rather
 * than an oversight — see the run 7 chunk 3 log. A first draft carried a
 * `mounted` ref checked before `setState`, with a case asserting nothing was
 * written after `unmount()`. Deleting the ref left that case **green**: React 18
 * removed the setState-on-unmounted warning and makes the call a no-op, so
 * nothing outside the component can observe the difference. A guard no case can
 * redden is a line that will be maintained forever on the strength of a comment,
 * so it is gone. {@link runningSaves} is released unconditionally, which is the
 * part that does have consequences — and it now outlives the mount, so a
 * component that leaves mid-save is joined by whoever replaces it rather than
 * taking the lock and the answer with it.
 */
export function useSavedPlanSave(
  deps: SaveDeps,
  projectId: string,
): { readonly state: SavedPlanSaveState; readonly save: () => void } {
  // Seeded rather than always `idle`: a shelf mounted while its project's save
  // is still running must draw the same disabled button the departed one drew,
  // from its very first paint.
  const [state, setState] = useState<SavedPlanSaveState>(() =>
    runningFor(deps, projectId) === undefined ? { kind: 'idle' } : { kind: 'saving' },
  );
  const receive = useCallback((next: SavedPlanSaveState) => {
    setState(next);
  }, []);

  // Join a save this mount did not start. The subscription is dropped on the way
  // out so a replaced instance stops being written to; the *request* is never
  // touched, because a plan the user asked to save is not un-saved by a resize.
  useEffect(() => {
    const running = runningFor(deps, projectId);
    if (running === undefined) return;
    setState({ kind: 'saving' });
    running.waiting.add(receive);
    return () => {
      running.waiting.delete(receive);
    };
  }, [deps, projectId, receive]);

  const save = useCallback(() => {
    // The lock is a map entry and not the `state` above, because two presses in
    // one React batch both read the same rendered state and would both pass a
    // `state.kind !== 'saving'` test. The entry is written before the await and
    // read synchronously, which is the only ordering that makes the guard true.
    let byProject = runningSaves.get(deps);
    if (byProject === undefined) {
      byProject = new Map<string, RunningSave>();
      runningSaves.set(deps, byProject);
    }
    if (byProject.has(projectId)) return;
    const running: RunningSave = { waiting: new Set([receive]) };
    byProject.set(projectId, running);
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
        // Released before the state writes and never conditionally: the entry
        // outlives every component, so a lock left latched here is a project
        // whose Save button never works again for the rest of the session.
        byProject.delete(projectId);
        for (const waiting of running.waiting) waiting(next);
      });
  }, [deps, projectId, receive]);

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
