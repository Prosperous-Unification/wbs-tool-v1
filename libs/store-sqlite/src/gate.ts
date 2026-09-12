/**
 * A turn at the source's writing lane.
 *
 * be-01 holds one `bun:sqlite` connection and a {@link Command batch} keeps a
 * transaction open on it across `await`s, so a write from another request that
 * lands in that window sits **inside** the batch's transaction and is rolled
 * back with it. ADR 0007 says every write waits; this is the object that makes
 * that true rather than intended, and every mutating store method asks it for a
 * turn before it writes. Reads never ask.
 *
 * It is a port because the answer is the source's, not SQLite's: the key is
 * process-wide for a one-connection SQLite file, per project for a Postgres
 * advisory lock, and nothing at all where every transaction has its own
 * connection (`docs/2026-09-05-ports-and-adapters-plan.md` §3.2, ADR 0015).
 *
 * There is **no re-entrancy**: nothing that already holds a turn ever asks for
 * one. A caller that holds a turn hands its callee stores built over
 * {@link OPEN} instead, which is what a batch's `Scope` is for.
 */
export interface Gate {
  /** Waits for a turn, runs `work`, and releases the turn however `work` settles. */
  enter<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * The gate for a store whose caller **already holds the turn** — a batch's own
 * stores, and nothing else.
 *
 * Not "a lock that happens to be free": it is a claim made by whoever
 * constructed the store, and the claim is what makes the batch's first write
 * possible at all. A store built over the real coordinator inside a batch waits
 * for the turn its own batch is holding, which is a deadlock rather than a slow
 * write — the case that watches it is `unit-of-work.db.test.ts`'s (h).
 */
export const OPEN: Gate = {
  enter: (work) => work(),
};

/**
 * The SQLite source's write coordinator: one be-01 write at a time, in arrival
 * order, process-wide.
 *
 * Process-wide because the thing being taken turns at is the process's one
 * connection. A second instance would look healthy and exclude nothing, which
 * is why `boot.ts` builds exactly one and hands it to every store —
 * `boot.db.test.ts` reads the object off the graph rather than trusting the
 * wiring.
 *
 * A promise chain rather than a semaphore: the next holder starts when the
 * previous settles, whether it resolved or threw, and nothing is ever left
 * holding it.
 */
export class WriteCoordinator implements Gate {
  private tail: Promise<unknown> = Promise.resolve();

  enter<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.tail.then(work, work);
    // The chain must never reject, or every later holder would be refused by
    // an error that was not theirs.
    this.tail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}
