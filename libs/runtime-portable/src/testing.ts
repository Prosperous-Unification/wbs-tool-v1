/** Deterministic timers that advance production deadline and backoff callbacks together. */
export class DeadlineClock {
  private instant = 0;
  private readonly pending = new Set<{ at: number; fire: () => void }>();
  readonly nowMs = (): number => this.instant;
  readonly schedule = (ms: number, fire: () => void): (() => void) => {
    const timer = { at: this.instant + ms, fire };
    this.pending.add(timer);
    return () => {
      this.pending.delete(timer);
    };
  };
  get active(): number {
    return this.pending.size;
  }
  async advance(ms: number): Promise<void> {
    const target = this.instant + ms;
    for (;;) {
      const next = [...this.pending].sort((a, b) => a.at - b.at).at(0);
      if (next === undefined || next.at > target) break;
      this.instant = next.at;
      this.pending.delete(next);
      next.fire();
      await this.flush();
    }
    this.instant = target;
    await this.flush();
  }
  async flush(): Promise<void> {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  }
}
