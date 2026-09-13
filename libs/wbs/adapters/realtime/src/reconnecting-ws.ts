import { type WsControlFrame, type WsFrame, wsPing, wsResume } from '@wbs/contracts';
import { parseOrThrow, type } from '@wbs/validation';

import type { SubscriptionTracker } from './subscription-tracker';

export type ConnectionState = 'open' | 'reconnecting' | 'denied' | 'closed';

export interface ReconnectingWsOptions {
  url: string;
  onFrame: (frame: WsFrame) => void;
  onControl?: (control: WsControlFrame) => void;
  onStateChange: (state: ConnectionState) => void;
  subscriptions: SubscriptionTracker;
  websocketFactory?: (url: string, protocols?: string | string[]) => WebSocket;
  random?: () => number;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  ceilingMs?: number;
}

const INITIAL_BACKOFF_MS = 500;
const BACKOFF_CAP_MS = 30_000;

export function computeBackoff(attempt: number, random: () => number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, BACKOFF_CAP_MS);
  const jitter = 0.2 * base * (random() * 2 - 1);
  return Math.round(base + jitter);
}

const EnvelopeGuard = type({
  subscription: 'string',
  seq: 'number',
  message: 'unknown',
}).or(type({ type: 'string', '[string]': 'unknown' }));

/**
 * A data frame is the arm carrying a subscription's payload. `EnvelopeGuard`'s
 * other arm is `{ type: string }` with an open index signature — deliberately
 * wider than {@link WsControlFrame}, so a control type this build does not know
 * reaches `onControl` instead of throwing — and an index signature defeats `in`
 * narrowing, which is why this reads the values rather than the keys.
 */
function isDataFrame(frame: typeof EnvelopeGuard.infer): frame is WsFrame {
  const fields = frame as Record<string, unknown>;
  return (
    typeof fields['subscription'] === 'string' &&
    typeof fields['seq'] === 'number' &&
    'message' in frame
  );
}

export interface ReconnectingWsHandle {
  send(frame: { subscription: string; message: unknown }): void;
  /**
   * The sequence a caller has **read** one subscription up to, which is what a
   * later resume asks from.
   *
   * The caller reports it because the caller is the one doing the reading, and
   * this socket advanced the tracker **on the frame** until 2026-09-02 —
   * contradicting the rule fe-01's live `project-stream.ts` states and proves:
   * "`onChange` may fail — the table swallows a failed refetch on purpose, to
   * keep the last good tree on screen — and a stream that advanced on the frame
   * rather than on the read would then resume past an edit nobody ever saw."
   * Two clients, one rule, and this was the copy that had it wrong.
   */
  seen(subscription: string, seq: number): void;
  close(): void;
}

export function createReconnectingWs(opts: ReconnectingWsOptions): ReconnectingWsHandle {
  const random = opts.random ?? Math.random;
  const wsf = opts.websocketFactory ?? ((u, p) => new WebSocket(u, p));
  const heartbeatMs = opts.heartbeatIntervalMs ?? 25_000;
  const pongMs = opts.pongTimeoutMs ?? 10_000;
  const ceilingMs = opts.ceilingMs ?? 60 * 60 * 1000;

  let ws: WebSocket | null = null;
  let attempt = 0;
  let attemptStart = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const setState = (s: ConnectionState): void => {
    opts.onStateChange(s);
  };

  function clearHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    if (pongTimer) clearTimeout(pongTimer);
    heartbeat = null;
    pongTimer = null;
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeat = setInterval(() => {
      if (ws?.readyState !== 1) return;
      ws.send(wsPing());
      pongTimer = setTimeout(() => ws?.close(), pongMs);
    }, heartbeatMs);
  }

  function connect(): void {
    if (closed) return;
    if (Date.now() - attemptStart > ceilingMs) {
      setState('closed');
      return;
    }
    const socket = wsf(opts.url);
    ws = socket;

    socket.onopen = (): void => {
      attempt = 0;
      attemptStart = Date.now();
      setState('open');
      socket.send(wsResume(opts.subscriptions.snapshot()));
      startHeartbeat();
    };

    socket.onmessage = (ev: MessageEvent<string>): void => {
      const parsed = parseOrThrow(EnvelopeGuard, JSON.parse(ev.data));
      if (isDataFrame(parsed)) {
        // The tracker is **not** advanced here — see {@link
        // ReconnectingWsHandle.seen}. The frame is handed on; what the caller
        // does with it decides where the stream has got to.
        opts.onFrame(parsed);
      } else {
        // The guard admits any `{ type: string }`, so this narrows to the union
        // of control frames this build knows; `onControl` reads `type` and the
        // arms it does not recognise fall through it untouched.
        const control = parsed as WsControlFrame;
        if (control.type === 'pong' && pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
        opts.onControl?.(control);
      }
    };

    socket.onclose = (): void => {
      clearHeartbeat();
      if (closed) return;
      setState('reconnecting');
      const delay = computeBackoff(attempt++, random);
      setTimeout(() => {
        connect();
      }, delay);
    };

    socket.onerror = (): void => {
      socket.close();
    };
  }

  connect();

  return {
    send(frame) {
      if (ws?.readyState === 1) ws.send(JSON.stringify(frame));
    },
    seen(subscription, seq) {
      opts.subscriptions.update(subscription, seq);
    },
    close() {
      closed = true;
      clearHeartbeat();
      ws?.close();
    },
  };
}
