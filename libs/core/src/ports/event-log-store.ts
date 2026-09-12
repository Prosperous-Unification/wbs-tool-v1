/** One durable subscription event, with its monotonic sequence. */
export interface RecordedEvent {
  readonly subscription: string;
  readonly seq: number;
  readonly message: unknown;
  readonly createdAt: number;
}

/** The source-neutral event history used by replay and retention. */
export interface EventLogStore {
  // Proof: adding `recordEventIn` here failed the source-neutral consumer on
  // TS2741, missing `recordEventIn` from its adapter-free fixture (2026-09-09).
  recordEvent(subscription: string, message: unknown, createdAt: number): Promise<RecordedEvent>;
  rangeSince(subscription: string, sinceSeq: number): Promise<readonly RecordedEvent[]>;
  oldestSeq(subscription: string): Promise<number | null>;
  /** The latest sequence, or `-1` when the subscription has recorded none. */
  latestSeq(subscription: string): Promise<number>;
  pruneBeyond(maxPerSubscription: number): Promise<number>;
}
