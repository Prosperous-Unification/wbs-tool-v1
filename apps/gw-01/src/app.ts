import { InternalResumeResponse } from '@wbs/contracts';
import { createLogger } from '@wbs/observability';
import { observabilityPlugin } from '@wbs/observability/server';
import { parseOrThrow } from '@wbs/validation';
import { Elysia } from 'elysia';

import { internalController, type SocketLike } from './controller/internal.controller';
import { handleWsMessage, projectIdOf } from './controller/ws.controller';
import { ForwardClient } from './service/forward-client';
import { GatewayMetrics } from './service/gateway-metrics';
import { JwtVerifier, type TokenVerifier } from './service/jwt-auth';
import { Presence } from './service/presence';
import { SubscriptionMap } from './service/subscription-map';

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
  fetchImpl?: typeof fetch;
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
  const forwarder = new ForwardClient({
    beUrl: opts.beUrl,
    secret: opts.internalAuthSecret,
    fetchImpl: opts.fetchImpl,
  });
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return (
    new Elysia()
      .use(observabilityPlugin({ service: 'gw-01' }))
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
      .get('/metrics/snapshot', () => metrics.counters)
      .ws('/ws', {
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
          // One wrapper per connection, kept for its whole life. It used to be
          // allocated per inbound message, so the object `subscribe` stored was
          // one no later code could produce again — leaving every disconnected
          // socket in the map forever, counted in the fan-out and sent to.
          conn.socket = { send: (payload) => ws.send(payload) };
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
              // A join puts the connection in no project — it has not said which
              // one it is looking at yet, and until it subscribes it belongs to
              // nothing (see {@link Presence}). The broadcast is what hands the
              // newcomer its own empty roster; every other socket's is unchanged
              // by a join, and only `onSubscribed` below moves anybody's.
              presence.join(conn.connectionId, username, { send: (s) => ws.send(s) });
              presence.broadcast();
            } catch {
              // beforeHandle already rejected invalid tokens; nothing to add.
            }
          })();
          await conn.joined;
        },
        async message(ws, data) {
          const conn = ws.data as unknown as WsConnection;
          // Before anything reads presence: a `subscribe` that overtook the
          // join found no connection to move and was silently dropped.
          await conn.joined;
          const clientId = presence.usernameOf(conn.connectionId) ?? 'anon';
          const socket = conn.socket;
          await handleWsMessage({
            data: typeof data === 'string' ? data : JSON.stringify(data),
            socket,
            subs,
            connectionId: conn.connectionId,
            clientId,
            forward: (m) =>
              forwarder.forward(m, {
                clientId,
                connectionId: conn.connectionId,
                traceId: crypto.randomUUID(),
              }),
            resume: async (points) => {
              const res = await fetchImpl(`${opts.beUrl}/internal/resume`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-internal-auth': opts.internalAuthSecret,
                  'x-client-id': clientId,
                  'x-connection-id': conn.connectionId,
                },
                body: JSON.stringify({ resume_points: points, trace_id: crypto.randomUUID() }),
              });
              // Parsed against the shared contract rather than cast. A be-01 that
              // answered with the old count-only shape would otherwise reach the
              // socket as a replay of `undefined` events and throw mid-frame,
              // after the client had already been told to expect them.
              return parseOrThrow(InternalResumeResponse, await res.json());
            },
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
              presence.enterProject(conn.connectionId, projectId);
              presence.broadcast();
            },
            onUnsubscribed: (subscription) => {
              const projectId = projectIdOf(subscription);
              if (projectId === null) return;
              presence.leaveProject(conn.connectionId, projectId);
              presence.broadcast();
            },
            roster: () => presence.rosterFor(conn.connectionId),
          });
        },
        async close(ws) {
          metrics.connectionClosed();
          const conn = ws.data as unknown as WsConnection;
          // A close that overtook the join deleted nothing and let the join
          // that followed it re-add the connection — a socket nobody holds,
          // left in whatever roster the `subscribe` behind it had put it in.
          await conn.joined;
          // Subscriptions first: a socket left in the map is pushed to forever,
          // counted in `delivered_to_sockets`, and joined again by the same
          // browser on its next reconnect.
          subs.removeAll(conn.socket);
          presence.leave(conn.connectionId);
          // Broadcast after the removal, so the roster the survivors receive is
          // the one that excludes the socket that just went away.
          presence.broadcast();
        },
      })
  );
}
