/**
 * The {@link Write lock}: one be-01 write at a time, in arrival order.
 *
 * be-01 holds one `bun:sqlite` connection and a {@link Command batch} keeps a
 * transaction open on it across `await`s. A write from another request landing
 * in that window would sit inside the batch's transaction and be rolled back
 * with it — so every batch, and every undo, runs through here (ADR 0007). Reads
 * never take it.
 *
 * A promise chain rather than a semaphore: the next holder starts when the
 * previous settles, whether it resolved or threw, and nothing is ever left
 * holding it.
 */
export class WriteLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
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
