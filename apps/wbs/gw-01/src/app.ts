import { PROMETHEUS_CONTENT_TYPE } from '@wbs/contracts';
import { createLogger, type MetricsScrape, scrapeMetrics } from '@wbs/observability';
import { systemTimers, type Timers } from '@wbs/runtime-portable';
import { Elysia } from 'elysia';

import { internalController, type SocketLike } from './controller/internal.controller';
import { handleWsMessage, projectIdOf } from './controller/ws.controller';
import { type FetchLike, ForwardClient } from './service/forward-client';
import { GatewayMetrics } from './service/gateway-metrics';
import { JwtVerifier, type TokenVerifier } from './service/jwt-auth';
import { Presence } from './service/presence';
import { ResumeClient } from './service/resume-client';
import { socketWriter } from './service/socket-writer';
import { SubscriptionMap } from './service/subscription-map';
import { decodeWireFrame, gatewayAdapter } from './ws-wire';

/** Short: `/health` is polled, and a slow answer is as useless as no answer. */
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const LOCAL_IDENTITY = Symbol('local websocket identity');
const VERIFIED_TOKEN = Symbol('verified websocket token');

interface WsAuthCarrier {
  [LOCAL_IDENTITY]?: string;
  [VERIFIED_TOKEN]?: string;
}

function cookieValue(raw: string | null, name: string): string | null {
  for (const part of (raw ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * What the `/ws` handlers keep on a connection for its whole life.
 *
 * Elysia hands every handler the same `ws.data`, so this is where `open` leaves
 * what `message` and `close` need. It is written by hand rather than derived:
 * the ws context type does not know about fields the route adds to it.
 */
interface WsConnection {
  connectionId: string;
  /** Aborted synchronously on close, before waiting for authentication/presence. */
  cancellation: AbortController;
  socket: SocketLike;
  /**
   * The rest of `open` — verify the token, join presence — as something the
   * later handlers can wait for.
   *
   * Bun delivers `message` and `close` as soon as the frames arrive, without
   * waiting for an `open` handler that is still awaiting. A `subscribe` that
   * won that race called `presence.enterProject` for a connection `join` had
   * not created yet: `enterProject` models an unknown connection as one that
   * never joined and does nothing, so the membership was dropped, and the
   * `join` behind it then wrote `projectId: null` over it — a socket that had
   * subscribed, in no roster, for as long as it stayed open. It was gw-01's
   * flaky test, at 2 runs in 40: `no roster arrived for ada; ada has []`.
   *
   * Never rejects: a token that fails here is already handled inside it.
   */
  joined: Promise<void>;
  query?: WsAuthCarrier;
}

export interface AppOptions {
  beUrl: string;
  internalAuthSecret: string;
  jwtKey: string;
  previousJwtKey?: string;
  version?: string;
  fetchImpl?: FetchLike;
  /** Internal request policy; health retains its separate probe budget. */
  requests?: { timers: Timers; attemptMs: number; overallMs: number };
  /**
   * The browser origin allowed to open an OIDC cookie-authenticated socket.
   *
   * Absent only in local mode, where {@link localIdentity} authenticates the
   * cookie-free development socket.
   */
  appOrigin?: string;
  /** Fixed cookie-free identity accepted only by explicit local-mode boot. */
  localIdentity?: string;
  /**
   * The token verifier, in place of the one built from `jwtKey`.
   *
   * `fetchImpl`'s counterpart, and for the same reason: {@link
   * WsConnection.joined} is an ordering guarantee, and a guarantee about what
   * happens *during* verification can only be tested by a verifier that is
   * still verifying when the next frame lands. The real keys stay the default.
   */
  verifier?: TokenVerifier;
  /** Overrides the framework-free Prometheus collector in tests. */
  metricsScrape?: () => Promise<MetricsScrape>;
}

export function buildApp(opts: AppOptions) {
  const logger = createLogger({ service: 'gw-01', version: opts.version });
  const subs = new SubscriptionMap<SocketLike>();
  const metrics = new GatewayMetrics();
  const presence = new Presence();
  const verifier: TokenVerifier =
    opts.verifier ??
    new JwtVerifier({
      current: new TextEncoder().encode(opts.jwtKey),
      previous: opts.previousJwtKey ? new TextEncoder().encode(opts.previousJwtKey) : undefined,
    });
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const requestOptions = {
    beUrl: opts.beUrl,
    secret: opts.internalAuthSecret,
    fetchImpl,
    ...(opts.requests ?? { timers: systemTimers, attemptMs: 5000, overallMs: 15000 }),
  };
  const forwarder = new ForwardClient(requestOptions);
  const resumer = new ResumeClient(requestOptions);

  return (
    new Elysia({ adapter: gatewayAdapter })
      .get('/metrics', async ({ set }) => {
        const scrape = await (opts.metricsScrape ?? (() => scrapeMetrics('gw-01')))();
        set.status = scrape.status;
        // Proof: omitting this header made integration.test.ts expect the
        // Prometheus content type and receive null from the real gateway route.
        set.headers['content-type'] = PROMETHEUS_CONTENT_TYPE;
        return scrape.text;
      })
      .decorate('logger', logger)
      .decorate('subs', subs)
      .decorate('metrics', metrics)
      .use(internalController({ secret: opts.internalAuthSecret, subs, metrics }))
      /**
       * Healthy means "can do the job", and this gateway's job is forwarding.
       *
       * It used to answer `ok` unconditionally, so a container with a wrong
       * `BE_URL` passed the deploy's health gate, took the socket traffic and
       * failed every forward — and the smoke test could not see it either, because
       * that talks to be-01 directly (open finding 4, and finding 1's other half).
       *
       * The backend's own `/health` is the probe, with a short timeout. The gate
       * polls for a minute, so a be-01 restarting inside a swap costs a retry
       * rather than a failed deploy; a be-01 that is genuinely unreachable is a
       * gateway that should not be routed to.
       */
      .get('/health', async ({ set }) => {
        try {
          const res = await fetchImpl(`${opts.beUrl}/health`, {
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
          });
          if (!res.ok) {
            set.status = 503;
            return { status: 'backend_unhealthy' as const };
          }
        } catch (err) {
          logger.error({ err, beUrl: opts.beUrl }, 'health probe could not reach be-01');
          set.status = 503;
          return { status: 'backend_unreachable' as const };
        }
        return { status: 'ok' as const };
      })
      // **Not deleted, and W2-14 asked for it to be.** The blue/green swap
      // polls this endpoint's `activeConnections` to drain WebSockets before it
      // stops the old colour (`tools/tool-remote-scripts/src/swap.ts`), so it
      // is part of the deploy contract rather than a debugging leftover. The
      // OpenTelemetry counters beside it (see {@link socketWriter}) are an
      // addition, not a replacement: a `Counter` cannot be read back in-process,
      // and the drain has to read a number here and now.
      .get('/metrics/snapshot', () => metrics.counters)
      .ws('/ws', {
        parse: (_socket, frame) => decodeWireFrame(frame),
        async beforeHandle({ query, request, set }) {
          const auth = query as WsAuthCarrier;
          if (opts.localIdentity !== undefined) {
            // Proof: without this production upgrade branch, the local-mode
            // browser gate closes /ws as `missing token` and both peer-edit
            // cases fail after their PATCH returns 200. Watched 2026-08-24.
            auth[LOCAL_IDENTITY] = opts.localIdentity;
            return undefined;
          }
          // There is deliberately no compatibility fallback to `query.token`.
          // URLs are copied into browser history, logs and pasted links; a
          // signed credential in one remains exposed until it expires.
          if (opts.appOrigin === undefined) {
            set.status = 401;
            return { error: 'websocket auth not configured' };
          }
          if (request.headers.get('origin') !== opts.appOrigin) {
            // Proof: delete this comparison and "refuses a valid cookie
            // presented by a foreign origin" opens a real socket. Watched
            // 2026-08-24.
            set.status = 403;
            return { error: 'invalid origin' };
          }

          const token = cookieValue(request.headers.get('cookie'), '__Host-wbs_access');
          if (!token) {
            set.status = 401;
            return { error: 'missing token' };
          }
          try {
            await verifier.verify(token);
          } catch {
            set.status = 401;
            return { error: 'invalid token' };
          }
          auth[VERIFIED_TOKEN] = token;
          return undefined;
        },
        async open(ws) {
          metrics.connectionOpened();
          const conn = ws.data as unknown as WsConnection;
          conn.connectionId = crypto.randomUUID();
          conn.cancellation = new AbortController();
          // One wrapper per connection, kept for its whole life. It used to be
          // allocated per inbound message, so the object `subscribe` stored was
          // one no later code could produce again — leaving every disconnected
          // socket in the map forever, counted in the fan-out and sent to.
          // One writer per connection, and the only place a frame reaches the
          // socket: the object the subscription map holds, the object the
          // presence roster holds, and the object every control answer is sent
          // through are this one. See {@link socketWriter} — twelve call sites
          // wrote to a socket and none of them read what Bun answered.
          const writer = socketWriter(ws, metrics);
          conn.socket = { send: (payload) => void writer.send(payload) };
          // Assigned before this handler's first `await`, which is the only
          // point at which `message` and `close` can start. See {@link
          // WsConnection.joined} for what happened when they did not wait.
          conn.joined = (async () => {
            try {
              let username = conn.query?.[LOCAL_IDENTITY];
              if (username === undefined) {
                const token = conn.query?.[VERIFIED_TOKEN];
                if (token === undefined) return;
                const claims = await verifier.verify(token);
                username = typeof claims['username'] === 'string' ? claims['username'] : claims.sub;
              }
              // Only an id being replaced can affect an existing project.
              // The newcomer has named no project and needs its own empty roster.
              presence.broadcast(presence.join(conn.connectionId, username, conn.socket));
              // Proof: omitting this leaves the real-socket newcomer with no initial frame.
              presence.sendRoster(conn.connectionId);
            } catch {
              // beforeHandle already rejected invalid tokens; nothing to add.
            }
          })();
          await conn.joined;
          // An upgrade that was accepted and then could not say who is behind
          // it is closed, not served. Without this the socket stayed open and
          // `message` below fell back to `'anon'`, which subscribes to any
          // project and receives its fan-out — so the cookie checked in
          // `beforeHandle` was bound to an identity only by Elysia happening
          // to share the query object between the two hooks.
          if (presence.usernameOf(conn.connectionId) === null) {
            ws.close(1008, 'unauthenticated');
          }
        },
        async message(ws, frame) {
          const conn = ws.data as unknown as WsConnection;
          // Before anything reads presence: a `subscribe` that overtook the
          // join found no connection to move and was silently dropped.
          await conn.joined;
          const clientId = presence.usernameOf(conn.connectionId);
          // Same boundary as `open`, checked again because a close is
          // asynchronous and a frame already in flight must not be served.
          if (clientId === null) {
            ws.close(1008, 'unauthenticated');
            return;
          }
          const socket = conn.socket;
          await handleWsMessage({
            // Proof: parsing string values again makes the real-socket malformed-frame test
            // receive two pongs for a quoted JSON string containing a ping object.
            frame,
            signal: conn.cancellation.signal,
            socket,
            subs,
            connectionId: conn.connectionId,
            clientId,
            forward: (m) =>
              forwarder.forward(
                m,
                {
                  clientId,
                  connectionId: conn.connectionId,
                  traceId: crypto.randomUUID(),
                },
                conn.cancellation.signal,
              ),
            resume: (points) =>
              resumer.resume(
                points,
                {
                  clientId,
                  connectionId: conn.connectionId,
                  traceId: crypto.randomUUID(),
                },
                conn.cancellation.signal,
              ),
            onInbound: () => {
              metrics.inbound();
            },
            onReconnect: () => {
              metrics.reconnect();
            },
            onBackendUnavailable: () => {
              metrics.backendUnavailable();
            },
            // A `project:` subscription is what puts this connection in a
            // roster, and the broadcast is what tells the people already in it.
            // `presence` names no project, so it moves nobody.
            onSubscribed: (subscription) => {
              const projectId = projectIdOf(subscription);
              if (projectId === null) return;
              presence.broadcast(presence.enterProject(conn.connectionId, projectId));
            },
            onUnsubscribed: (subscription) => {
              const projectId = projectIdOf(subscription);
              if (projectId === null) return;
              const affected = presence.leaveProject(conn.connectionId, projectId);
              presence.broadcast(affected);
              // Proof: omitting reset leaves no empty frame after real-socket unsubscribe;
              // removing the condition instead sends a frame during the stale-unsubscribe no-op.
              if (affected.length > 0) presence.sendRoster(conn.connectionId);
            },
            roster: () => presence.rosterFor(conn.connectionId),
          });
        },
        async close(ws) {
          metrics.connectionClosed();
          const conn = ws.data as unknown as WsConnection;
          // Proof: omitting close abort made four real socket tests time out waiting
          // for cancellation within250ms, before the independent1000ms attempt expiry.
          conn.cancellation.abort(new Error('connection closed'));
          // A close that overtook the join deleted nothing and let the join
          // that followed it re-add the connection — a socket nobody holds,
          // left in whatever roster the `subscribe` behind it had put it in.
          await conn.joined;
          // Subscriptions first: a socket left in the map is pushed to forever,
          // counted in `delivered_to_sockets`, and joined again by the same
          // browser on its next reconnect.
          subs.removeAll(conn.socket);
          // The returned project was looked up before the connection was removed.
          presence.broadcast(presence.leave(conn.connectionId));
        },
      })
  );
}
