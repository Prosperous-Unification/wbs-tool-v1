import { useCallback, useLayoutEffect, useState } from 'react';

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
 * The answer to a save that landed with nobody listening, held until somebody
 * mounts to hear it.
 *
 * A resize unmounts the shelf and mounts its replacement, and the request in
 * between belongs to neither. Without this the reader's own checkpoint stays off
 * their own shelf — be-01 broadcasts nothing on save (TASK-255), so the panel's
 * completion effect is the only thing that puts it there — and the replacement
 * can be stranded in `saving` by the same window.
 *
 * Written only when the settle finds an empty waiting set, which is exactly the
 * case where every listener has gone, and taken once.
 */
const unclaimedAnswers = new WeakMap<SaveDeps, Map<string, SavedPlanSaveState>>();

function takeUnclaimed(deps: SaveDeps, projectId: string): SavedPlanSaveState | undefined {
  const byProject = unclaimedAnswers.get(deps);
  const answer = byProject?.get(projectId);
  byProject?.delete(projectId);
  return answer;
}

function leaveUnclaimed(deps: SaveDeps, projectId: string, answer: SavedPlanSaveState): void {
  let byProject = unclaimedAnswers.get(deps);
  if (byProject === undefined) {
    byProject = new Map<string, SavedPlanSaveState>();
    unclaimedAnswers.set(deps, byProject);
  }
  byProject.set(projectId, answer);
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

  /**
   * Join a save this mount did not start, or collect the answer to one that
   * landed while nobody was mounted to hear it.
   *
   * **The `else` branch is not defensive, it is the only thing standing between
   * the seed above and a permanently disabled button** (Gemini, round 15). A
   * passive effect runs after commit and paint, so a request that settles in
   * that window finds `waiting` without this mount's `receive` in it, deletes
   * its entry, and leaves the effect looking at nothing while the state seeded
   * at render still says `saving`. Returning early there stranded the component
   * in `saving` for the rest of the session, drawing a dead Save button and
   * never running the panel's completion refresh. The settle now leaves its
   * answer behind when it has no listener, and this picks it up.
   *
   * The cleanup re-reads the entry rather than closing over the one above,
   * because this mount's own `save()` creates it *after* the effect has run —
   * without that, a component that pressed Save and then left stayed in the
   * waiting set forever, which is precisely how the answer failed to reach its
   * replacement.
   *
   * **`useLayoutEffect`, and that word is the fix for round 16's Important**
   * (Sol; found independently by reading the same sequence). A *passive* effect
   * runs after paint, so between the replacement's commit and the flush the
   * waiting set still held the departed mount's `receive` and nothing else. A
   * settle in that window found `waiting.size > 0`, skipped
   * {@link leaveUnclaimed}, and delivered the whole terminal answer —
   * `saved`, `busy`, `quota` or `error` — to a component React had already
   * unmounted, where `setState` is a no-op. The replacement then found neither a
   * running save nor an unclaimed answer and fell back to `idle`: not a dead
   * button any more, but the authoritative timestamp and every refusal message
   * silently dropped, and the panel's completion refresh never run.
   *
   * Subscribing in a *layout* effect closes that window at its source rather
   * than compensating for it. Layout cleanup and layout setup both run
   * synchronously inside the commit, so no microtask — and a settling promise is
   * one — can observe the moment between them. By the time any answer can
   * arrive, the departed mount has left the waiting set and the replacement is
   * in it. `unclaimedAnswers` then covers only what it says: a save that landed
   * with genuinely nobody mounted.
   *
   * No case can redden this word, and that is stated rather than hidden: the
   * interleaving it removes is not constructible through `renderHook`, which
   * flushes effects inside `act`. It is kept — unlike the unmount guard deleted
   * above — because it is not a guard. It is where the subscription lives, it
   * runs on every mount, and the alternative is a lost confirmation nobody can
   * see. `cell-input.tsx` picks the same hook for the same kind of reason.
   */
  useLayoutEffect(() => {
    const running = runningFor(deps, projectId);
    if (running === undefined) {
      const unclaimed = takeUnclaimed(deps, projectId);
      setState((current) => unclaimed ?? (current.kind === 'saving' ? { kind: 'idle' } : current));
    } else {
      setState({ kind: 'saving' });
      running.waiting.add(receive);
    }
    return () => {
      runningFor(deps, projectId)?.waiting.delete(receive);
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
    const held = byProject;
    byProject.set(projectId, running);
    setState({ kind: 'saving' });

    /** One exit for every way a save can end, so no path can skip the release. */
    const settle = (next: SavedPlanSaveState): void => {
      // Released before the state writes and never conditionally: the entry
      // outlives every component, so a lock left latched here is a project
      // whose Save button never works again for the rest of the session.
      held.delete(projectId);
      if (running.waiting.size === 0) {
        leaveUnclaimed(deps, projectId, next);
        return;
      }
      for (const waiting of running.waiting) waiting(next);
    };

    // `deps.save` is an injected boundary, and a synchronous throw from it used
    // to escape between the `set` above and the `.then` below — leaving the lock
    // latched with no settle to release it, which is the dead-Save-button state
    // for the rest of the session (Gemini, round 15; Sol M2, round 16). The
    // production path cannot do it (`httpSavedPlanApi.save` is `async`, so it
    // rejects instead), but the type says nothing of the sort and the cost of
    // saying so here is one `try`.
    let request: ReturnType<SaveDeps['save']>;
    try {
      request = deps.save(projectId);
    } catch (fault: unknown) {
      settle({ kind: 'error', code: codeOf(fault) });
      return;
    }
    void request
      .then((result): SavedPlanSaveState => {
        if (result.outcome === 'saved') return { kind: 'saved', savedPlan: result.savedPlan };
        if (result.outcome === 'snapshot_busy') return { kind: 'busy' };
        return { kind: 'quota', refusal: result.refusal };
      })
      .catch((fault: unknown): SavedPlanSaveState => ({ kind: 'error', code: codeOf(fault) }))
      .then(settle);
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
