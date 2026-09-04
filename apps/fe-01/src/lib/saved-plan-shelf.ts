import { useCallback, useEffect, useRef, useState } from 'react';

import type { SavedPlanListState } from '../components/wbs/saved-plan-list';
import { subscribeToProject } from './project-stream';
import type { SavedPlanApi } from './saved-plan-api';
import { httpSavedPlanApi, savedPlansAvailable } from './saved-plan-api';

/**
 * The two questions a shelf read is made of, injected rather than imported.
 *
 * `savedPlansAvailable` is a free function and `list` hangs off the API object,
 * so a caller that wanted to fake one would otherwise have to stub `fetch` for
 * both and lose the ability to say "the probe said no and the list was never
 * asked" — which is the assertion this whole file exists for.
 */
export interface ShelfDeps {
  available(): Promise<boolean>;
  list: SavedPlanApi['list'];
}

/**
 * One read of a project's shelf, from the capability question to the rows.
 *
 * **The order is the point, and it is the half of 6.4 that neither the probe nor
 * the surface can hold on its own.** `savedPlansAvailable()` and the
 * "not available on this node yet" sentence were both written before this
 * function and each is asserted against its own input; a build in which the
 * probe is never invoked passed every one of those cases. What closes 6.4 is
 * that the list is **not asked** when the answer is no, and that is asserted
 * here directly rather than inferred from a rendered string.
 *
 * A failed probe and a failed read are both `error` and carry the code, because
 * by then the reader has a fault to report rather than a node to upgrade.
 */
export async function readShelf(deps: ShelfDeps, projectId: string): Promise<SavedPlanListState> {
  let available: boolean;
  try {
    available = await deps.available();
  } catch (fault) {
    return { kind: 'error', code: codeOf(fault) };
  }
  // Not a guard clause folded into the try above: a *refused* probe and a probe
  // that answered "no" are different states, and one try block covering both
  // would make the second reachable only by accident.
  if (!available) return { kind: 'unavailable' };
  try {
    return { kind: 'ready', rows: await deps.list(projectId) };
  } catch (fault) {
    return { kind: 'error', code: codeOf(fault) };
  }
}

/**
 * The thrown code, or the thing itself when something threw a non-Error.
 *
 * `String(fault)` rather than a fixed `'unknown'`: every throw in this client's
 * API layer is an `Error` carrying be-01's own code, and on the day one is not,
 * showing whatever arrived beats erasing it.
 */
const codeOf = (fault: unknown): string => (fault instanceof Error ? fault.message : String(fault));

/**
 * The broadcast, narrowed to the two things a shelf watch uses.
 *
 * `subscribeToProject` takes an options object and hands back a stream with
 * `seen` as well as `unsubscribe`; sequence reporting belongs to whoever reads
 * the *plan*, not to this. Naming only what is used keeps the fake in the cases
 * two lines long and keeps this file from acquiring an opinion about sequences.
 */
export interface ShelfWatchDeps extends ShelfDeps {
  subscribe(projectId: string, onChange: () => void): { unsubscribe(): void };
}

/**
 * A project's shelf, read now and re-read whenever the project changes.
 *
 * **The payload is ignored, exactly as `subscribeToProject` ignores it.** A
 * saved plan is immutable, but the *list* is not: another collaborator saving or
 * deleting one changes it, and re-reading is one request and always right.
 *
 * **A node that cannot answer is never subscribed to.** Same reasoning as
 * `readShelf`'s own order, one level up: there is no point listening for changes
 * to a list this node has no route to return, and a socket opened for a shelf
 * that can never render is a reconnect loop nobody can see.
 *
 * Returns the stop. Call it and no further state arrives — including from a read
 * already in flight, which is the trap `project-stream.ts` names in its own
 * `unsubscribe`: the loop that outlived its subscriber.
 *
 * **It also returns `refresh`, and the reason is a hole in the broadcast rather
 * than a convenience.** `saved-plan.controller.ts` publishes nothing: not on
 * save, not on rename, not on delete. The broadcast this watch listens to belongs
 * to the plan, so a collaborator editing the plan re-reads the shelf and the
 * user's own checkpoint does not. Without a caller-driven read, pressing Save leaves
 * the new row invisible until somebody edits the project — the one moment the
 * shelf is most obviously wrong. `refresh` is `read` itself, so the guard
 * against a superseded answer covers a refresh racing a broadcast for free.
 */
export function watchShelf(
  deps: ShelfWatchDeps,
  projectId: string,
  onState: (state: SavedPlanListState) => void,
): { stop: () => void; refresh: () => void } {
  let stopped = false;
  let generation = 0;
  let stream: { unsubscribe(): void } | null = null;

  const read = (): void => {
    const mine = ++generation;
    void readShelf(deps, projectId).then((state) => {
      // Two guards, and they are different facts. `stopped` is "nobody is
      // listening any more"; `mine !== generation` is "somebody is, but they
      // have since asked a newer question". A broadcast that lands while the
      // first read is still in flight produces both reads, and without the
      // second guard whichever resolves last wins — which is the older answer
      // roughly as often as not.
      if (stopped || mine !== generation) return;
      onState(state);
      if (state.kind === 'unavailable') return;
      stream ??= deps.subscribe(projectId, read);
    });
  };

  read();

  return {
    stop: () => {
      stopped = true;
      stream?.unsubscribe();
      stream = null;
    },
    // Not `read` directly. `read`'s `stopped` guard already suppresses the
    // state *and* the resubscribe — it returns before both — so this changes no
    // observable state. What it stops is the pair of requests: a stopped watch
    // that is refreshed anyway asks the server the capability question and the
    // list, and throws both answers away. A `refresh` handed to a component
    // outlives that component by exactly as long as its last save takes.
    refresh: () => {
      if (!stopped) read();
    },
  };
}

/**
 * The three real answers, wired to the modules that give them.
 *
 * A factory and not a constant because `list` needs the token, which is not
 * known until somebody has logged in. The caller therefore holds the identity of
 * what it passes to {@link useSavedPlanShelf} — see that hook's dependency note.
 *
 * `sinceSeq: -1` is this subscriber's honest answer: a shelf read is a list of
 * saved plans, not a read of the project at a sequence, so there is no sequence
 * for it to resume from and nothing here ever calls `seen`. The plan client owns
 * that conversation on its own socket.
 */
export const browserShelfDeps = (token: string): ShelfWatchDeps => ({
  available: savedPlansAvailable,
  list: (projectId) => httpSavedPlanApi(token).list(projectId),
  subscribe: (projectId, onChange) => subscribeToProject({ projectId, sinceSeq: -1, onChange }),
});

/**
 * A project's shelf as React state: read on mount, re-read on the broadcast,
 * stopped on unmount.
 *
 * Thin on purpose. Everything that can be got wrong about *reading* a shelf —
 * the capability question's order, the superseded read, the single subscription
 * — is in {@link watchShelf} and asserted without a renderer. What is left here
 * is the part only a component can get wrong, and there are exactly two of them:
 *
 * 1. **The stop is returned from the effect.** Without it the subscription
 *    outlives the component and every later broadcast calls `setState` on
 *    something nobody is rendering — for a shelf reachable from more than one
 *    screen, once per visit, forever.
 * 2. **A new project shows `loading`, not the previous project's rows.** The
 *    first read of `p2` resolves a request later; leaving `p1`'s rows on screen
 *    until then states, with a timestamp and an author, that they belong to a
 *    project they were never saved in. AC #4's "non-destructive" applies to
 *    reads too: showing nothing is a worse experience and an honest one.
 *
 * **`deps` is in the dependency array, so a caller must hold its identity**
 * (`useMemo` over {@link browserShelfDeps}). Excluding it — via a ref, the usual
 * dodge — would buy immunity to a re-render loop at the price of a token change
 * that never reaches the socket, and would need `eslint-disable` to say so.
 * Keeping it honest means the linter checks this array rather than trusting it.
 */
export function useSavedPlanShelf(
  deps: ShelfWatchDeps,
  projectId: string,
): { readonly state: SavedPlanListState; readonly refresh: () => void } {
  const [state, setState] = useState<SavedPlanListState>({ kind: 'loading' });
  /**
   * The current watch's `refresh`, held in a ref so callers get one identity.
   *
   * A `refresh` that changed on every project change would go into the
   * dependency array of every effect and callback that saves, and each of those
   * would then re-run on a change it does not care about. The ref is written
   * inside the effect that creates the watch, so the stable function always
   * forwards to the live one — and to nothing at all before the first effect
   * runs, which is a press that cannot happen because nothing is rendered yet.
   */
  const live = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Re-seeded on every subscribe, not just the first: on mount this is what
    // `useState` already holds, but on a change of project it is the difference
    // between "reading p2" and "here are p1's plans, mislabelled".
    setState({ kind: 'loading' });
    const watch = watchShelf(deps, projectId, setState);
    live.current = watch.refresh;
    return () => {
      live.current = null;
      watch.stop();
    };
  }, [deps, projectId]);

  const refresh = useCallback(() => {
    live.current?.();
  }, []);

  return { state, refresh };
}
