import { Counter } from '@wbs/observability';

import type { GatewayMetrics } from './gateway-metrics';

/**
 * Whatever a frame can be written to — Bun's `ServerWebSocket`, or a fake.
 *
 * `send` answers a **number** on Bun, and nothing in gw-01 read it until
 * 2026-09-02: `0` for a frame that was dropped because the socket is not open,
 * `-1` for one enqueued behind backpressure, and the byte count for one that
 * went. The `undefined` arm is for the fakes that answer nothing, and it counts
 * as **sent** — a test double that returns nothing is not reporting a drop.
 */
export interface WsSink {
  send(payload: string): number | undefined;
}

/** What a socket did with a frame, as {@link socketWriter} reads Bun's answer. */
export type FrameOutcome = 'sent' | 'backpressured' | 'dropped';

/**
 * Counted in the process **and** exported, which is why there are two of each.
 *
 * The in-memory `GatewayCounters` are what `/metrics/snapshot` answers, and the
 * blue/green swap polls that endpoint to drain sockets before it stops the old
 * colour. These two are the OpenTelemetry side, and they are `libs/observability`
 * `Counter`'s **first callers** — a metric class nothing increments is a
 * dashboard that reads zero and means "not wired".
 */
const droppedFrames = new Counter(
  'gw01_dropped_frames_total',
  'Frames a socket refused because it was not open',
);
const backpressuredFrames = new Counter(
  'gw01_backpressured_frames_total',
  'Frames enqueued behind backpressure rather than written',
);

/**
 * The one place a frame is written to a socket.
 *
 * Twelve call sites sent frames — the control answers, the replay, the fan-out,
 * the presence broadcast — and none of them looked at what the socket said
 * about it. A dropped frame was indistinguishable from a delivered one, which
 * matters most for exactly the frames that are hardest to notice missing: a
 * `resume_ack` a client is waiting on, or a roster nobody sees change.
 *
 * They all still send through `conn.socket`, so this is one wrapper per
 * connection built at `open` rather than twelve edits: the object the
 * subscription map holds and the object the presence roster holds are this.
 *
 * A throw is a **drop**, not a crash: a socket closed between a map lookup and
 * the write is the ordinary race here (`leave` arrives on the close handler
 * afterwards), and one dead connection must not stop the rest of a fan-out.
 */
export function socketWriter(
  sink: WsSink,
  metrics: Pick<GatewayMetrics, 'frameDropped' | 'frameBackpressured'>,
): { send: (payload: string) => FrameOutcome } {
  return {
    send: (payload) => {
      let answered: number | undefined;
      try {
        answered = sink.send(payload);
      } catch {
        metrics.frameDropped();
        droppedFrames.inc();
        return 'dropped';
      }
      if (answered === 0) {
        metrics.frameDropped();
        droppedFrames.inc();
        return 'dropped';
      }
      if (answered === -1) {
        metrics.frameBackpressured();
        backpressuredFrames.inc();
        return 'backpressured';
      }
      return 'sent';
    },
  };
}
