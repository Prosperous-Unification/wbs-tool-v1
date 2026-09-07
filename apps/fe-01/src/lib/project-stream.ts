import { wsResume, wsSubscribe, wsWho } from '@wbs/contracts/ws-frames';

import { websocketUrl } from './api';

export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: () => void;
}

export interface StreamSocket {
  send(data: string): void;
  close(): void;
}

/**
 * Opens a socket and wires it to `handlers`.
 *
 * Handlers are passed in rather than a `WebSocket`-shaped object being returned,
 * so a test can supply a socket without emulating `EventTarget` — and so nothing
 * here has to cast a fake into a `WebSocket`.
 */
export type OpenSocket = (url: string, handlers: SocketHandlers) => StreamSocket;

export interface ProjectStreamDeps {
  openSocket: OpenSocket;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  random: () => number;
}

export interface ProjectStreamOptions {
  projectId: string;
  /** Where the caller's last read of this project left off; `-1` for none. */
  sinceSeq: number;
  /**
   * Something changed on the server — refetch.
   *
   * The argument is what the frame said changed: be-01's `ProjectEvent.type`,
   * which gw-01 forwards verbatim as the frame's `message`. It is `null`
   * whenever this side cannot say — a control frame that means "read again"
   * (`resume_ack` with no replay count, `resume_denied`), a `message` that is
   * not an object, or a `type` that is not a string. Optional as well as
   * nullable, so a caller that does not care reads as one that cannot say: a
   * `() => void` is still a valid handler, and `readScopeFor` treats an absent
   * argument exactly as it treats `null`.
   *
   * It is a `string` and not a union on purpose. The union lives in be-01
   * (`service/broadcast.ts`) and is not shared, so what arrives here is an
   * unvalidated word off a socket; a caller that narrows on it must treat an
   * unrecognised one exactly as it treats `null`. R5: unknown is not OK, and
   * the honest answer to an unknown event is the full read.
   */
  onChange: (changed?: string | null) => void;
  /** Whether a socket is currently open, so the caller can say so on screen. */
  onConnectionChange?: (connected: boolean) => void;
  /**
   * Who else is in this project, whenever gw-01 says.
   *
   * **On this socket, which is the point.** The presence panel opened a second
   * WebSocket per project until 2026-09-02 — two connections per browser, two
   * `subscribe` frames, two entries in the gateway's fan-out — to be told the
   * same thing by the same gateway. The roster arrives on the frames this
   * socket is already receiving.
   *
   * It also fixes what that panel's own JSDoc called a caveat: its socket did
   * not reconnect, so a dropped connection froze the roster at whoever was
   * there and only a reload started another. This one reconnects, resubscribes
   * and asks again, so the roster comes back.
   */
  onPresence?: (users: readonly string[]) => void;
}

export interface ProjectStream {
  /**
   * The sequence a fresh read of the project happened at.
   *
   * The caller reports it because the caller is the one doing the reading. After
   * a refused resume the stream has no idea where the stream now is; without
   * this it would ask for the same dropped range on every reconnect and be
   * refused every time.
   */
  seen(seq: number): void;
  unsubscribe(): void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

const browserDeps: ProjectStreamDeps = {
  openSocket: (url, handlers) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => {
      handlers.onOpen();
    });
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      handlers.onMessage(event.data);
    });
    socket.addEventListener('close', () => {
      handlers.onClose();
    });
    return {
      send: (data) => {
        socket.send(data);
      },
      close: () => {
        socket.close();
      },
    };
  },
  schedule: (fn, ms) => setTimeout(fn, ms),
  // The handle is opaque to callers by design — only this pairing of `schedule`
  // and `cancel` knows it came from `setTimeout`.
  cancel: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  random: Math.random,
};

/**
 * Subscribes to a project's edits and calls `onChange` when any arrive, across
 * as many sockets as it takes.
 *
 * The payload is deliberately ignored. be-01 sends either the changed work items
 * or the whole tree, and applying either one locally would be a second
 * implementation of the numbering and the roll-up — the two things most likely
 * to disagree with the server. Refetching is always right, which is also why a
 * replayed event and a live one need no distinguishing here.
 *
 * **It is not one request, and calling it that is what made the cost invisible.**
 * The caller decides how much to read, and `readScopeFor` in `wbs-table.tsx`
 * answers `'all'` for every event this side does not recognise — nine requests,
 * the plan and the steps and six vocabularies and the markers. That is the
 * honest price of ignoring the payload, and an optimizer outcome pays it
 * (TASK-324). The scope narrows per event where be-01 guarantees it can; the
 * default stays the full read because an unknown event has no such guarantee.
 *
 * Reconnect lives in this function rather than in the component that calls it: a
 * component would restart the backoff on any render that changed the closure,
 * which is how reconnect storms get written by accident.
 *
 * **This is the live client, and `libs/realtime`'s `createReconnectingWs` is
 * not.** The two are not a duplication to collapse: that one is the generic
 * scaffold — a heartbeat, a `SubscriptionTracker` in storage, an attempt
 * ceiling — and this one is what the plan page actually uses, which is why the
 * rules a reader needs are written here. What they must not do is disagree, and
 * they did until 2026-09-02: that client advanced the sequence **on the frame**,
 * which is the mistake the paragraph in `receive` explains. It takes a `seen`
 * from its caller now, as this does.
 *
 * The frames both of them send come from `@wbs/contracts/ws-frames`, so gw-01
 * cannot be handed a field name only one of them knows.
 */
export function subscribeToProject(
  options: ProjectStreamOptions,
  deps: ProjectStreamDeps = browserDeps,
): ProjectStream {
  const subscription = `project:${options.projectId}`;
  let sinceSeq = options.sinceSeq;
  let attempt = 0;
  let unsubscribed = false;
  let socket: StreamSocket | null = null;
  let pendingReconnect: unknown = null;

  /** `500ms · 2ⁿ`, capped, then jittered down by up to half. */
  function delayFor(attemptIndex: number): number {
    const uncapped = BASE_DELAY_MS * 2 ** attemptIndex;
    const capped = Math.min(uncapped, MAX_DELAY_MS);
    return Math.round(capped * (0.5 + deps.random() * 0.5));
  }

  /**
   * What a data frame says changed, or `null` when it does not say.
   *
   * The one place this side reads `message`, and it reads exactly one field of
   * it. Everything else in the payload is be-01's business — a `tree_replaced`
   * carries every row, and reconciling those against a tree this client has not
   * fetched is the mistake `ProjectEvent`'s own JSDoc argues against.
   *
   * Returns `null` rather than throwing for a `message` that is absent, not an
   * object, or carrying a non-string `type`: a frame this side cannot read is a
   * reason to read everything, not a reason to fail. That is the modelled
   * condition, not an invariant — the caller's default is the safe one.
   */
  function changedFactOf(message: unknown): string | null {
    if (typeof message !== 'object' || message === null) return null;
    const said = (message as { type?: unknown }).type;
    return typeof said === 'string' ? said : null;
  }

  function receive(raw: string): void {
    let frame: {
      subscription?: string;
      seq?: number;
      type?: string;
      replayed?: Record<string, number>;
      users?: string[];
      // be-01's `ProjectEvent`, forwarded whole by gw-01 (`wsData`, and
      // `internal.controller.ts` inline). Typed `unknown` because nothing on
      // this side validates it: only its `type` is read, and only as a hint
      // about which reads are needed.
      message?: unknown;
    };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      // gw-01 also carries presence and control frames; anything unparseable is
      // not this subscription's business.
      return;
    }

    // Push-only after the first frame: gw-01 broadcasts the roster whenever
    // anybody joins or leaves, and the `who` sent on open is what a client
    // entering a quiet room is answered with.
    if (frame.type === 'presence') {
      if (Array.isArray(frame.users)) options.onPresence?.(frame.users);
      return;
    }

    if (frame.type === 'resume_ack') {
      // Silence is not an answer. A gateway from before replay existed sends an
      // empty `replayed` map — it read a `count` that no longer exists, and JSON
      // drops the undefined — and treating that as "you missed nothing" is the
      // silent divergence this whole module is here to prevent.
      if (typeof frame.replayed?.[subscription] !== 'number') options.onChange(null);
      settle();
      return;
    }

    if (frame.subscription !== subscription) return;

    if (frame.type === 'resume_denied') {
      // The server cannot say what was missed, so the only honest answer is to
      // read the whole project again — and the caller reports the sequence that
      // read landed at through `seen`.
      options.onChange(null);
      settle();
      return;
    }

    // The sequence is deliberately NOT advanced here. `onChange` may fail — the
    // table swallows a failed refetch on purpose, to keep the last good tree on
    // screen — and a stream that advanced on the frame rather than on the read
    // would then resume past an edit nobody ever saw. `seen` is the only way
    // forward, and it is called by whoever actually installed the new rows.
    if (typeof frame.seq !== 'number') return;
    options.onChange(changedFactOf(frame.message));
  }

  /**
   * The socket is synchronised: the server has answered the resume.
   *
   * Both the backoff reset and the "live" report hang off this rather than off
   * `onOpen`. An open socket is not a synchronised one, and a gateway that
   * accepts the handshake and drops the socket — an expired token, a restart —
   * would otherwise reset the backoff on every attempt and reconnect every
   * 300ms from every open browser, forever.
   */
  function settle(): void {
    attempt = 0;
    options.onConnectionChange?.(true);
  }

  function connect(): void {
    // `cancel` cannot unfire a callback the event loop has already picked up, so
    // the flag is read here too.
    if (unsubscribed) return;
    pendingReconnect = null;
    socket = deps.openSocket(websocketUrl(), {
      onOpen: () => {
        socket?.send(wsSubscribe(subscription));
        // Subscribe first, then ask: `who` is answered with **this
        // connection's** project, so a `who` that overtook the subscribe would
        // be answered with nobody and the roster would sit empty until the next
        // join. Asked only when somebody is listening, so a page with no
        // presence on screen sends one frame fewer.
        if (options.onPresence !== undefined) socket?.send(wsWho());

        // Nothing to resume from. Resuming at -1 asks for the whole stream, and
        // on a project with any history that is either a refusal or a frame per
        // recorded event, each one making the caller refetch — on every first
        // load, to establish a baseline the caller's own read is about to give
        // us through `seen`. So: subscribe, and call it synchronised.
        if (sinceSeq < 0) {
          settle();
          return;
        }

        // Subscribe first, resume second. The other order leaves a window in
        // which the replay has been sent and a live edit arriving behind it has
        // no socket registered to receive it.
        socket?.send(wsResume({ [subscription]: sinceSeq }));
      },
      onMessage: receive,
      onClose: () => {
        options.onConnectionChange?.(false);
        if (unsubscribed) return;
        pendingReconnect = deps.schedule(connect, delayFor(attempt));
        attempt += 1;
      },
    });
  }

  connect();

  return {
    seen(seq) {
      sinceSeq = Math.max(sinceSeq, seq);
    },
    unsubscribe() {
      // Set before closing: `close()` runs the close handler synchronously on a
      // fake socket and on some real ones, and an unset flag there schedules a
      // reconnect for a subscription nobody is watching any more.
      //
      // Proof: this assignment deleted, and both "stops reconnecting once the
      // caller unsubscribes" and "opens nothing when a reconnect fires after the
      // caller unsubscribed" failed — the loop outlived its subscriber.
      unsubscribed = true;
      if (pendingReconnect !== null) deps.cancel(pendingReconnect);
      socket?.close();
    },
  };
}
