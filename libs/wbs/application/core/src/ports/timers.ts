/** Monotonic scheduling capability supplied by the composition root. */
export interface Timers {
  nowMs(): number;
  schedule(ms: number, fire: () => void): () => void;
}

/** Repeating work supplied by the runtime that owns its timer handles. */
export interface Intervals {
  every(milliseconds: number, callback: () => void): () => void;
}
