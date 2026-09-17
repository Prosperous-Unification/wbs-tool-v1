export interface GatewayCounters {
  activeConnections: number;
  connectionsTotal: number;
  reconnectsTotal: number;
  messageFanoutTotal: number;
  inboundMessagesTotal: number;
  backendUnavailableTotal: number;
  /**
   * Frames a socket refused because it was not open, and frames enqueued behind
   * backpressure rather than written.
   *
   * Both were **unobservable** until 2026-09-02: twelve call sites wrote to a
   * socket and none of them read what Bun answered, so a dropped `resume_ack` a
   * client was waiting on looked exactly like a delivered one. See
   * {@link socketWriter}, which is the one place that reads it now.
   */
  droppedFramesTotal: number;
  backpressuredFramesTotal: number;
}

export class GatewayMetrics {
  readonly counters: GatewayCounters = {
    activeConnections: 0,
    connectionsTotal: 0,
    reconnectsTotal: 0,
    messageFanoutTotal: 0,
    inboundMessagesTotal: 0,
    backendUnavailableTotal: 0,
    droppedFramesTotal: 0,
    backpressuredFramesTotal: 0,
  };

  connectionOpened(): void {
    this.counters.connectionsTotal++;
    this.counters.activeConnections++;
  }

  connectionClosed(): void {
    if (this.counters.activeConnections > 0) this.counters.activeConnections--;
  }

  reconnect(): void {
    this.counters.reconnectsTotal++;
  }

  fanOut(n: number): void {
    this.counters.messageFanoutTotal += n;
  }

  inbound(): void {
    this.counters.inboundMessagesTotal++;
  }

  backendUnavailable(): void {
    this.counters.backendUnavailableTotal++;
  }

  frameDropped(): void {
    this.counters.droppedFramesTotal++;
  }

  frameBackpressured(): void {
    this.counters.backpressuredFramesTotal++;
  }
}

// The module-level `gwMetrics` singleton was deleted on 2026-09-02: `app.ts`
// has always built its own, so nothing imported it, and a second set of
// counters that nothing increments is a snapshot that reads zero and means
// "you are looking at the wrong object".
