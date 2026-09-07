import type { EventLogRepo } from '../repository/event-log';
import type { ReplayBuffer } from './replay-buffer';

export interface ReplayEvent {
  seq: number;
  message: unknown;
}

export type ReplayOutcome =
  { status: 'replaying'; events: ReplayEvent[] } | { status: 'denied'; reason: 'out_of_range' };

export interface ReplayOrchestratorOptions {
  log: EventLogRepo;
  buffer: ReplayBuffer;
  /**
   * The largest replay served. Beyond it the answer is a refusal and the client
   * refetches — one request instead of dozens of frames that each make it
   * refetch anyway.
   */
  maxEvents?: number;
}

/**
 * Deliberately small, and it is a count of *payloads* rather than of bytes.
 *
 * A structural edit broadcasts `tree_replaced`, which carries the whole project,
 * so a replay is not a handful of deltas — thirty-two of them on a large
 * breakdown is already megabytes written into one socket in a tight loop. Past
 * a few dozen missed events a single refetch is both smaller and simpler, and
 * the client refetches on each frame anyway.
 */
const DEFAULT_MAX_EVENTS = 32;

/**
 * Answers a reconnecting client's `resume` from the recorded event stream.
 *
 * Buffer first, log second, refusal third: see `design.md` D2. Every answer is
 * complete or refused — a partial replay reported as success would advance the
 * client past events it never received, and it would never learn it had a hole.
 */
export class ReplayOrchestrator {
  private readonly maxEvents: number;

  constructor(private readonly opts: ReplayOrchestratorOptions) {
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  async replay(resumePoints: Record<string, number>): Promise<Record<string, ReplayOutcome>> {
    const outcomes: Record<string, ReplayOutcome> = {};
    for (const [subscription, sinceSeq] of Object.entries(resumePoints)) {
      outcomes[subscription] = await this.replayOne(subscription, sinceSeq);
    }
    return outcomes;
  }

  private async replayOne(subscription: string, sinceSeq: number): Promise<ReplayOutcome> {
    const denied = { status: 'denied', reason: 'out_of_range' } as const;

    // `latestSeq` is read once and every later decision is taken against that
    // number. An event recorded while this runs is delivered live — the client
    // subscribes before it resumes — so clipping to this ceiling keeps the
    // answer complete instead of racing the writer for its own length.
    const latestSeq = await this.opts.log.latestSeq(subscription);
    if (sinceSeq < -1 || sinceSeq > latestSeq) return denied;
    if (sinceSeq === latestSeq) return { status: 'replaying', events: [] };

    const missing = latestSeq - sinceSeq;
    // Proof: this line deleted, and only "denies a range larger than the cap
    // rather than truncating it" failed — the cap is observed here rather than
    // asserted about a constant.
    if (missing > this.maxEvents) return denied;

    let events = this.opts.buffer.covers(subscription, sinceSeq + 1)
      ? this.opts.buffer.since(subscription, sinceSeq).map(toReplayEvent)
      : [];

    // The buffer is a fast path, never the last word. It can evict between the
    // question and the answer, and the log is what the refusal is supposed to
    // be about — so an incomplete buffer answer falls through rather than
    // denying a range the log still holds.
    if (!isContiguousFrom(events, sinceSeq + 1, missing)) {
      events = (await this.opts.log.rangeSince(subscription, sinceSeq)).map(toReplayEvent);
    }

    const clipped = events.filter((event) => event.seq <= latestSeq);
    // Proof: this line deleted, and the two tests whose ranges retention had
    // eaten — "denies a range retention has already removed" and "answers each
    // subscription independently" — both reported a truncated replay as success.
    if (!isContiguousFrom(clipped, sinceSeq + 1, missing)) return denied;
    return { status: 'replaying', events: clipped };
  }
}

/**
 * Whether `events` is exactly `count` events running from `firstSeq` with no gap.
 *
 * The completeness gate. Retention can remove the head of a range and a buffer
 * can be evicted mid-answer, and both leave a plausible-looking list that starts
 * in the wrong place. Checking the shape of what was actually collected catches
 * either without trusting a second query to agree with the first.
 */
const toReplayEvent = (event: { seq: number; message: unknown }): ReplayEvent => ({
  seq: event.seq,
  message: event.message,
});

function isContiguousFrom(events: ReplayEvent[], firstSeq: number, count: number): boolean {
  if (events.length !== count) return false;
  return events.every((event, index) => event.seq === firstSeq + index);
}
