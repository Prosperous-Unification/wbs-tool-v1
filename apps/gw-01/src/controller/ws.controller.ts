import {
  WsClientFrame,
  wsData,
  wsError,
  wsPong,
  wsPresence,
  wsResumeAck,
  wsResumeDenied,
} from '@wbs/contracts';
import { type } from '@wbs/validation';

import type { SubscriptionMap } from '../service/subscription-map';

export type ResumeStatus =
  | { status: 'replaying'; events: { seq: number; message: unknown }[] }
  | { status: 'denied'; reason: 'out_of_range' };

export interface WsSocket {
  send(s: string): void;
}

export interface HandleWsMessageArgs {
  /** The wire adapter has already decoded the JSON value; strings are values, never JSON to parse again. */
  frame: unknown;
  /** Connection lifetime: cancellation suppresses late replies and failure metrics. */
  signal?: AbortSignal;
  socket: WsSocket;
  subs: SubscriptionMap<WsSocket>;
  connectionId: string;
  clientId: string;
  forward: (m: unknown) => Promise<{ ack: boolean }>;
  resume: (points: Record<string, number>) => Promise<Record<string, ResumeStatus>>;
  onInbound?: () => void;
  onReconnect?: () => void;
  onBackendUnavailable?: () => void;
  /**
   * The socket joined `subscription`, after the map accepted it.
   *
   * A callback rather than a `Presence` this module imports: what a
   * subscription means to presence is gw-01's composition to decide (`app.ts`
   * scopes the roster by it), and a controller that knew about rosters would
   * have to be handed one in every test that sends a `subscribe`.
   */
  onSubscribed?: (subscription: string) => void;
  /** The socket left `subscription`. */
  onUnsubscribed?: (subscription: string) => void;
  /**
   * The roster for **this** connection — its project's, not the gateway's — for
   * a client that asks instead of waiting.
   */
  roster?: () => string[];
}

/**
 * The subscriptions a socket may join.
 *
 * Without this, `subscribe` registers whatever string it is handed. That was
 * harmless while presence was the only channel; once a subscription names a
 * project it becomes an open door onto internal channels, and a typo becomes a
 * socket that silently receives nothing forever rather than an error.
 *
 * Project reads are open to every authenticated account by design, so this is a
 * shape check rather than an authorisation one — the socket is already
 * authenticated when it gets here.
 */
const PROJECT_SUBSCRIPTION = /^project:([0-9a-fA-F-]{36})$/;

/**
 * The project a subscription names, or null when it names none.
 *
 * The one place the `project:` prefix is taken apart, so presence scoping and
 * the shape check below cannot disagree about what counts as a project.
 */
export function projectIdOf(subscription: string): string | null {
  return PROJECT_SUBSCRIPTION.exec(subscription)?.[1] ?? null;
}

export function isKnownSubscription(subscription: string): boolean {
  return subscription === 'presence' || projectIdOf(subscription) !== null;
}

/** Validates the decoded client frame before any indexing, callback or dispatch. */
export async function handleWsMessage(args: HandleWsMessageArgs): Promise<void> {
  // Proof: bypassing this schema with the unchecked cast makes "refuses null before dispatch"
  // throw TypeError; the real-socket malformed-frame test receives only pong, without the refusal.
  const inbound = WsClientFrame(args.frame);
  if (inbound instanceof type.errors) {
    args.socket.send(wsError('invalid_payload'));
    return;
  }
  if (inbound.kind === 'forward') {
    args.onInbound?.();
    try {
      await args.forward(inbound.frame);
    } catch {
      // Proof: removing this guard emitted failure frames after close in
      // ws-cancellation.test.ts.
      if (args.signal?.aborted === true) return;
      args.onBackendUnavailable?.();
      args.socket.send(wsError('backend_unavailable', { retry_after: 5 }));
    }
    return;
  }
  const msg = inbound.frame;

  if (msg.type === 'ping') {
    args.socket.send(wsPong());
    return;
  }

  // A client that reconnects has missed every broadcast sent while it was
  // away, so it must be able to ask rather than wait for the next join.
  if (msg.type === 'who') {
    args.socket.send(wsPresence(args.roster?.() ?? []));
    return;
  }

  if (msg.type === 'resume') {
    args.onReconnect?.();
    const points = msg.resume_points;
    let result: Record<string, ResumeStatus>;
    try {
      result = await args.resume(points);
    } catch {
      // Proof: removing this guard emitted failure frames after close in
      // ws-cancellation.test.ts.
      if (args.signal?.aborted === true) return;
      // be-01 unreachable, a non-2xx, or a body that does not match the
      // contract — which is also what a gateway from after a partial rollout
      // sees from a backend from before it. The client is told, rather than
      // left on an open socket with stale rows and no reason to refetch.
      // `unavailable`, not `out_of_range`: nothing is known about the range.
      for (const subscription of Object.keys(points)) {
        args.socket.send(wsResumeDenied(subscription, 'unavailable'));
      }
      args.socket.send(wsResumeAck({}));
      return;
    }
    // Proof: removing this guard emitted replay data and resume_ack after close
    // in the late-success case of ws-cancellation.test.ts.
    if (args.signal?.aborted === true) return;
    const replayed: Record<string, number> = {};
    for (const [subscription, outcome] of Object.entries(result)) {
      if (outcome.status === 'denied') {
        args.socket.send(wsResumeDenied(subscription, 'out_of_range'));
        continue;
      }
      // To `args.socket`, never to `subs.socketsFor(subscription)`. The other
      // sockets on this subscription received these events when they were live;
      // sending them again is a refetch each, per event, per reconnecting peer.
      // Proof: the send below also written to every socket in
      // `subs.socketsFor(subscription)`, and only "replays only to the socket
      // that asked" failed.
      for (const event of outcome.events) {
        args.socket.send(wsData(subscription, event.seq, event.message));
      }
      replayed[subscription] = outcome.events.length;
    }
    // Last, and counted from the events actually written above: an
    // acknowledgement that arrives first would let a client advance its
    // sequence past frames it has not been handed yet.
    args.socket.send(wsResumeAck(replayed));
    return;
  }

  if (msg.type === 'subscribe') {
    if (!isKnownSubscription(msg.subscription)) {
      args.socket.send(wsError('unknown_subscription', { subscription: msg.subscription }));
      return;
    }
    args.subs.subscribe(msg.subscription, args.socket);
    // After the map accepted it, and never for a refused name: presence is
    // scoped by the subscription, so telling it about one the fan-out does not
    // hold would put a socket in a roster for a project it receives nothing on.
    args.onSubscribed?.(msg.subscription);
    return;
  }

  args.subs.unsubscribe(msg.subscription, args.socket);
  args.onUnsubscribed?.(msg.subscription);
}
