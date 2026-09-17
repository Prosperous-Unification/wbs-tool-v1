export interface BufferEntry {
  seq: number;
  message: unknown;
  at: number;
}

export interface ReplayBufferOptions {
  maxPerSubscription: number;
  maxAgeMs: number;
  // Proof: removing `now: clock.now` from the production composition failed
  // be-01:typecheck with TS2741 at its ReplayBuffer construction (2026-09-09).
  now: () => number;
}

export class ReplayBuffer {
  private readonly store = new Map<string, BufferEntry[]>();
  private readonly now: () => number;

  constructor(private readonly opts: ReplayBufferOptions) {
    this.now = opts.now;
  }

  record(subscription: string, seq: number, message: unknown): void {
    const at = this.now();
    const list = this.store.get(subscription) ?? [];
    list.push({ seq, message, at });
    this.evict(list);
    this.store.set(subscription, list);
    this.sweepOneOther(subscription);
  }

  since(subscription: string, sinceSeq: number): BufferEntry[] {
    const list = this.store.get(subscription);
    if (!list) return [];
    this.evict(list);
    return list.filter((e) => e.seq > sinceSeq);
  }

  /**
   * Whether the buffer still holds `fromSeq` and so can serve a replay starting
   * there.
   *
   * Asked instead of `oldestSeq() === null`, because an empty buffer is not
   * evidence: a process that started a second ago has one, and so does a
   * subscription nobody has edited. Only the oldest sequence distinguishes
   * "starts too late" from "holds nothing yet".
   */
  covers(subscription: string, fromSeq: number): boolean {
    const list = this.store.get(subscription);
    // Coverage describes unexpired entries, even though the orchestrator can
    // recover from an incomplete buffer answer by falling back to the log.
    // Proof: removing this eviction made `reports expired coverage as absent
    // before reading replay events` receive true where false was expected.
    if (list !== undefined) this.evict(list);
    const oldest = this.oldestSeq(subscription);
    return oldest !== null && oldest <= fromSeq;
  }

  oldestSeq(subscription: string): number | null {
    const list = this.store.get(subscription);
    if (!list || list.length === 0) return null;
    return list[0]?.seq ?? null;
  }

  /** A retained cursor follows insertions and deletions without rebuilding the key set. */
  private sweep = this.store.entries();

  /**
   * Evicts one subscription **other** than the one just written to, and drops
   * it when nothing is left.
   *
   * **Eviction was only ever lazy, and lazy means never for an abandoned key.**
   * `record`, `since` and `covers` each evict the subscription they are about,
   * so a project that is edited a thousand times and then closed keeps a
   * thousand `tree_replaced` entries — whole plans, hundreds of rows each —
   * with every one of them long past `maxAgeMs` and nothing left that would
   * ever ask about them again. The map kept the name too.
   *
   * One key per write, selected by at most three iterator advances: one entry,
   * possibly a wrap, and possibly the just-written key. A sweep visits every
   * subscription once per K writes across K live subscriptions. An abandoned
   * project therefore drains within one lap of whatever traffic is left, rather
   * than never.
   *
   * Proof: restoring the key-array sweep made `bounds record iterator work`
   * fail at 101, 1,001 and 10,001 advances, expected at most 3. Resetting the
   * cursor every record made `advances past an earlier subscription that
   * remains unexpired` keep sequence 0 instead of releasing the abandoned key.
   * Removing the exhausted-cursor reset made `reaches subscriptions added after
   * a completed sweep lap` retain sequence 0, expected null.
   *
   * It changes no answer. `since` and `covers` already evict before answering,
   * and `oldestSeq` has no production caller — so what this releases is memory
   * that no reader could reach.
   */
  private sweepOneOther(justWritten: string): void {
    // One advance for an entry, plus at most a wrap and the just-written key.
    // A lone current subscription can consume all three without another entry.
    for (let advances = 0; advances < 3; advances += 1) {
      const next = this.sweep.next();
      if (next.done) {
        this.sweep = this.store.entries();
        continue;
      }
      const [subscription, list] = next.value;
      if (subscription === justWritten) continue;
      this.evict(list);
      if (list.length === 0) this.store.delete(subscription);
      return;
    }
  }

  private evict(list: BufferEntry[]): void {
    const cutoff = this.now() - this.opts.maxAgeMs;
    while (list.length > 0 && list[0].at < cutoff) list.shift();
    while (list.length > this.opts.maxPerSubscription) list.shift();
  }
}
