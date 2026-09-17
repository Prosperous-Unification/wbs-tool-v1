import { describe, expect, it } from 'bun:test';

import { SubscriptionMap } from '../service/subscription-map';
import { handleWsMessage, isKnownSubscription, type WsSocket } from './ws.controller';

function makeSocket(): { sock: WsSocket; sent: string[] } {
  const sent: string[] = [];
  return { sock: { send: (s) => sent.push(s) }, sent };
}

describe('handleWsMessage', () => {
  it('responds to ping with pong', async () => {
    const { sock, sent } = makeSocket();
    const subs = new SubscriptionMap<WsSocket>();
    await handleWsMessage({
      frame: { type: 'ping' },
      socket: sock,
      subs,
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: () => Promise.resolve({ ack: true }),
      resume: () => Promise.resolve({}),
    });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ type: 'pong' });
  });

  it('forwards non-control frames to backend', async () => {
    const { sock } = makeSocket();
    const subs = new SubscriptionMap<WsSocket>();
    let captured: unknown;
    await handleWsMessage({
      frame: { subscription: 'presence', message: { hi: true } },
      socket: sock,
      subs,
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: (m) => {
        captured = m;
        return Promise.resolve({ ack: true });
      },
      resume: () => Promise.resolve({}),
    });
    expect(captured).toEqual({ subscription: 'presence', message: { hi: true } });
  });

  it('responds to resume with the replayed events, then resume_ack', async () => {
    const { sock, sent } = makeSocket();
    const subs = new SubscriptionMap<WsSocket>();
    await handleWsMessage({
      frame: { type: 'resume', resume_points: { presence: 5, 'doc:b': 7 } },
      socket: sock,
      subs,
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: () => Promise.resolve({ ack: true }),
      resume: () =>
        Promise.resolve({
          presence: {
            status: 'replaying',
            events: [
              { seq: 6, message: { a: 1 } },
              { seq: 7, message: { a: 2 } },
            ],
          },
          'doc:b': { status: 'denied', reason: 'out_of_range' },
        }),
    });
    const frames = sent.map((s) => JSON.parse(s) as Record<string, unknown>);

    expect(frames.filter((f) => f['type'] === 'resume_denied')).toEqual([
      { type: 'resume_denied', subscription: 'doc:b', reason: 'out_of_range' },
    ]);
    // The events carry the same shape as a live push, so the client needs no
    // replay branch — and they arrive before the acknowledgement that counts them.
    expect(frames.filter((f) => f['seq'] !== undefined)).toEqual([
      { subscription: 'presence', seq: 6, message: { a: 1 } },
      { subscription: 'presence', seq: 7, message: { a: 2 } },
    ]);
    expect(frames.at(-1)).toEqual({ type: 'resume_ack', replayed: { presence: 2 } });
  });

  it('replays only to the socket that asked', async () => {
    // `/internal/push` fans out to every socket on the subscription. Replay must
    // not: one laptop waking from sleep would make every other open browser
    // refetch once per event it had missed.
    const asking = makeSocket();
    const bystander = makeSocket();
    const subs = new SubscriptionMap<WsSocket>();
    subs.subscribe('doc:a', asking.sock);
    subs.subscribe('doc:a', bystander.sock);

    await handleWsMessage({
      frame: { type: 'resume', resume_points: { 'doc:a': 0 } },
      socket: asking.sock,
      subs,
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: () => Promise.resolve({ ack: true }),
      resume: () =>
        Promise.resolve({
          'doc:a': { status: 'replaying', events: [{ seq: 1, message: { a: 1 } }] },
        }),
    });

    expect(asking.sent).toHaveLength(2);
    expect(bystander.sent).toEqual([]);
  });

  it('emits backend_unavailable error when forward throws', async () => {
    const { sock, sent } = makeSocket();
    const subs = new SubscriptionMap<WsSocket>();
    await handleWsMessage({
      frame: { subscription: 'presence', message: {} },
      socket: sock,
      subs,
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: () => Promise.reject(new Error('nope')),
      resume: () => Promise.resolve({}),
    });
    expect(JSON.parse(sent[0])).toEqual({
      type: 'error',
      code: 'backend_unavailable',
      retry_after: 5,
    });
  });

  it('honours subscribe/unsubscribe control frames', async () => {
    const { sock } = makeSocket();
    const subs = new SubscriptionMap<WsSocket>();
    await handleWsMessage({
      frame: { type: 'subscribe', subscription: 'presence' },
      socket: sock,
      subs,
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: () => Promise.resolve({ ack: true }),
      resume: () => Promise.resolve({}),
    });
    expect(subs.socketsFor('presence').has(sock)).toBe(true);

    await handleWsMessage({
      frame: { type: 'unsubscribe', subscription: 'presence' },
      socket: sock,
      subs,
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: () => Promise.resolve({ ack: true }),
      resume: () => Promise.resolve({}),
    });
    expect(subs.socketsFor('presence').size).toBe(0);
  });
});

describe('subscription names', () => {
  it('accepts presence and a project subscription', () => {
    expect(isKnownSubscription('presence')).toBe(true);
    expect(isKnownSubscription(`project:${crypto.randomUUID()}`)).toBe(true);
  });

  it('refuses anything else', () => {
    // `internal:` is the shape that matters: registering it would hand a client
    // a channel it was never meant to reach.
    expect(isKnownSubscription('internal:push')).toBe(false);
    expect(isKnownSubscription('project:not-a-uuid')).toBe(false);
    expect(isKnownSubscription('')).toBe(false);
  });

  it('does not register a socket for an unknown subscription, and says so', async () => {
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };
    const subs = new SubscriptionMap<typeof socket>();

    await handleWsMessage({
      frame: { type: 'subscribe', subscription: 'internal:push' },
      socket,
      subs,
      connectionId: 'c1',
      clientId: 'someone',
      forward: () => Promise.resolve({ ack: true }),
      resume: () => Promise.resolve({}),
    });

    expect(subs.activeCount()).toBe(0);
    expect(sent.map((s) => JSON.parse(s) as { code?: string })[0]?.code).toBe(
      'unknown_subscription',
    );
  });
});

describe('handleWsMessage — cross-review findings', () => {
  it('tells the client when it could not serve the resume at all', async () => {
    // codex, high. A resume that throws — be-01 unreachable, a non-2xx, a body
    // that does not match the contract — used to send the client nothing. The
    // socket stayed open and the browser sat on stale rows believing it was
    // live, which is the exact failure resume exists to prevent.
    const { sock, sent } = makeSocket();
    const subs = new SubscriptionMap<WsSocket>();

    await handleWsMessage({
      frame: {
        type: 'resume',
        resume_points: { 'doc:a': 1, 'doc:b': 2 },
      },
      socket: sock,
      subs,
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: () => Promise.resolve({ ack: true }),
      resume: () => Promise.reject(new Error('be-01 unreachable')),
    });

    const frames = sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames).toEqual([
      { type: 'resume_denied', subscription: 'doc:a', reason: 'unavailable' },
      { type: 'resume_denied', subscription: 'doc:b', reason: 'unavailable' },
      { type: 'resume_ack', replayed: {} },
    ]);
  });
});

describe('client frame validation before dispatch', () => {
  const malformed = [
    'not json',
    'null',
    '42',
    '"text"',
    'true',
    '[]',
    '[1]',
    '{}',
    '{"type":42,"subscription":"presence","message":{}}',
    '{"subscription":42,"message":{}}',
    '{"subscription":"presence"}',
    '{"type":"subscribe","subscription":42,"message":{}}',
    '{"type":"unsubscribe","subscription":null,"message":{}}',
    '{"type":"resume","message":{},"subscription":"presence"}',
    '{"type":"resume","resume_points":null}',
    '{"type":"resume","resume_points":[]}',
    '{"type":"resume","resume_points":[1]}',
    '{"type":"resume","resume_points":{"presence":"1"}}',
    '{"type":"resume","resume_points":{"presence":null}}',
    '{"type":"resume","resume_points":{"presence":-2}}',
    '{"type":"resume","resume_points":{"presence":1.5}}',
    '{"type":"resume","resume_points":{"presence":1e999}}',
    '{"type":"resume","resume_points":{"presence":9007199254740992}}',
  ];
  for (const frame of malformed) {
    it(`refuses ${frame} before dispatch`, async () => {
      const { sock, sent } = makeSocket();
      const subs = new SubscriptionMap<WsSocket>();
      let dispatched = 0;
      await handleWsMessage({
        frame: frame === 'not json' ? frame : JSON.parse(frame),
        socket: sock,
        subs,
        connectionId: 'c-1',
        clientId: 'u-1',
        forward: () => {
          dispatched += 1;
          return Promise.resolve({ ack: true });
        },
        resume: () => {
          dispatched += 1;
          return Promise.resolve({});
        },
        onInbound: () => {
          dispatched += 1;
        },
        onReconnect: () => {
          dispatched += 1;
        },
        onSubscribed: () => {
          dispatched += 1;
        },
        onUnsubscribed: () => {
          dispatched += 1;
        },
      });
      expect(sent.map((frame): unknown => JSON.parse(frame))).toEqual([
        { type: 'error', code: 'invalid_payload' },
      ]);
      expect(dispatched).toBe(0);
      expect(subs.activeCount()).toBe(0);
    });
  }

  it('keeps an unrecognized string tag on a supported forwarded message', async () => {
    const { sock } = makeSocket();
    const frame = { type: 'extension', subscription: 'presence', message: null, extra: 'kept' };
    let forwarded: unknown;
    await handleWsMessage({
      frame: frame,
      socket: sock,
      subs: new SubscriptionMap<WsSocket>(),
      connectionId: 'c-1',
      clientId: 'u-1',
      forward: (message) => {
        forwarded = message;
        return Promise.resolve({ ack: true });
      },
      resume: () => Promise.resolve({}),
    });
    expect(forwarded).toEqual(frame);
  });
});
