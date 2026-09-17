import { describe, expect, it } from 'bun:test';

import { GatewayMetrics } from './gateway-metrics';
import { socketWriter, type WsSink } from './socket-writer';

/** A socket that answers whatever Bun would answer. */
const answering = (answer: number | undefined | (() => never)): WsSink => ({
  send: () => {
    if (typeof answer === 'function') return answer();
    return answer;
  },
});

/**
 * What a socket did with a frame, which nothing in gw-01 asked until
 * 2026-09-02.
 *
 * Twelve call sites wrote to a socket — the control answers, the replay, the
 * fan-out, the presence broadcast — and every one of them ignored the number
 * Bun's `send` answers with. A dropped frame was indistinguishable from a
 * delivered one, which matters most for the frames hardest to notice missing: a
 * `resume_ack` a client is waiting on, or a roster nobody sees change.
 *
 * This is the plan's own probe, and it was **inexpressible** before the seam
 * existed: there was no object to hand a fake socket to.
 *
 * Proof that each arm is load-bearing: `answered === 0` changed to
 * `answered === undefined`, watched failing on `expected 1 to be 0` for
 * `droppedFramesTotal` — a `void` sink counted as a drop, so every fake in the
 * suite would have reported one; and the `-1` arm deleted, on `expected 0 to be
 * 1` for `backpressuredFramesTotal`. Observed 2026-09-02.
 */
describe('what a socket did with a frame', () => {
  it('counts a frame the socket refused because it was not open', () => {
    const metrics = new GatewayMetrics();
    const writer = socketWriter(answering(0), metrics);

    expect(writer.send('{}')).toBe('dropped');
    expect(metrics.counters.droppedFramesTotal).toBe(1);
    expect(metrics.counters.backpressuredFramesTotal).toBe(0);
  });

  it('counts a frame enqueued behind backpressure, and does not call it dropped', () => {
    // `-1` means Bun took it and will write it later. It is not a loss, and
    // counting it as one would make a busy client look like a broken socket.
    const metrics = new GatewayMetrics();
    const writer = socketWriter(answering(-1), metrics);

    expect(writer.send('{}')).toBe('backpressured');
    expect(metrics.counters.backpressuredFramesTotal).toBe(1);
    expect(metrics.counters.droppedFramesTotal).toBe(0);
  });

  it('counts nothing for a frame that went', () => {
    const metrics = new GatewayMetrics();
    const writer = socketWriter(answering(42), metrics);

    expect(writer.send('{}')).toBe('sent');
    expect(metrics.counters.droppedFramesTotal).toBe(0);
    expect(metrics.counters.backpressuredFramesTotal).toBe(0);
  });

  it('reads a sink that answers nothing as sent', () => {
    // Every fake in this suite is one, and a test double that returns nothing
    // is not reporting a drop.
    const metrics = new GatewayMetrics();
    const writer = socketWriter(answering(undefined), metrics);

    expect(writer.send('{}')).toBe('sent');
    expect(metrics.counters.droppedFramesTotal).toBe(0);
  });

  it('reads a throwing socket as dropped, and does not rethrow', () => {
    // A socket closed between a map lookup and the write is the ordinary race
    // here — `leave` arrives on the close handler afterwards — and one dead
    // connection must not stop the rest of a fan-out.
    const metrics = new GatewayMetrics();
    const writer = socketWriter(
      answering(() => {
        throw new Error('closed');
      }),
      metrics,
    );

    expect(writer.send('{}')).toBe('dropped');
    expect(metrics.counters.droppedFramesTotal).toBe(1);
  });
});
