import type { SavedPlanListState } from '../components/wbs/saved-plan-list';
import type { SavedPlanApi } from './saved-plan-api';

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
 */
export function watchShelf(
  deps: ShelfWatchDeps,
  projectId: string,
  onState: (state: SavedPlanListState) => void,
): () => void {
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

  return () => {
    stopped = true;
    stream?.unsubscribe();
    stream = null;
  };
}
