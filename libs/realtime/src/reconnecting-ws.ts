import type { WsControlFrame, WsFrame } from '@wbs/contracts';
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

export interface ReconnectingWsHandle {
  send(frame: { subscription: string; message: unknown }): void;
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
      ws.send(JSON.stringify({ type: 'ping' }));
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
      socket.send(JSON.stringify({ type: 'resume', resume_points: opts.subscriptions.snapshot() }));
      startHeartbeat();
    };

    socket.onmessage = (ev: MessageEvent<string>): void => {
      const parsed = parseOrThrow(EnvelopeGuard, JSON.parse(ev.data)) as
        | WsFrame
        | (WsControlFrame & Record<string, unknown>);
      if ('subscription' in parsed && 'seq' in parsed && 'message' in parsed) {
        opts.subscriptions.update(parsed.subscription, parsed.seq);
        opts.onFrame(parsed);
      } else {
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
    close() {
      closed = true;
      clearHeartbeat();
      ws?.close();
    },
  };
}
