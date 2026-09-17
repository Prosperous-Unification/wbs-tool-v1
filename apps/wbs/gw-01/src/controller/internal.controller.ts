import { InternalPushRequest } from '@wbs/contracts';
import { parseOrThrow, ValidationError } from '@wbs/validation';
import { Elysia } from 'elysia';

import type { GatewayMetrics } from '../service/gateway-metrics';
import type { SubscriptionMap } from '../service/subscription-map';

export interface SocketLike {
  send(data: string): void;
}

export interface InternalDeps {
  secret: string;
  subs: SubscriptionMap<SocketLike>;
  metrics: GatewayMetrics;
}

export const internalController = (deps: InternalDeps) =>
  new Elysia({ prefix: '/internal' }).post('/push', ({ request, body, set }) => {
    if (request.headers.get('x-internal-auth') !== deps.secret) {
      set.status = 401;
      return { error: 'unauthorized' };
    }
    try {
      const req = parseOrThrow(InternalPushRequest, body);
      const sockets = deps.subs.socketsFor(req.subscription);
      const payload = JSON.stringify({
        subscription: req.subscription,
        seq: req.seq,
        message: req.message,
      });
      for (const s of sockets) s.send(payload);
      deps.metrics.fanOut(sockets.size);
      set.status = 202;
      return { delivered_to_sockets: sockets.size };
    } catch (err) {
      if (err instanceof ValidationError) {
        set.status = 400;
        return { error: err.message };
      }
      throw err;
    }
  });
