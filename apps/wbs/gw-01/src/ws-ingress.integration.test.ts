import { expect, it } from 'bun:test';

import { buildApp } from './app';

async function connect(firstEvent = false) {
  const forwarded: unknown[] = [];
  const resumed: unknown[] = [];
  const app = buildApp({
    beUrl: 'http://be.invalid',
    internalAuthSecret: 's'.repeat(32),
    jwtKey: 'k'.repeat(32),
    localIdentity: 'ingress-test',
    fetchImpl: (url, init) => {
      if (typeof init?.body !== 'string') throw new Error('backend request has no JSON body');
      const request = JSON.parse(init.body) as { message?: unknown; resume_points?: unknown };
      if (url.endsWith('/internal/forward')) {
        forwarded.push(request.message);
        return Promise.resolve(Response.json({ ack: true }));
      }
      if (url.endsWith('/internal/resume')) {
        resumed.push(request.resume_points);
        return Promise.resolve(
          Response.json({
            presence: {
              status: 'replaying',
              events: [{ seq: firstEvent ? 0 : 6, message: { kept: true } }],
            },
          }),
        );
      }
      throw new Error('unexpected backend route');
    },
  });
  app.listen(0);
  const port = app.server?.port;
  if (port === undefined) throw new Error('gateway did not start');
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const received: unknown[] = [];
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    const frame = JSON.parse(event.data) as { type?: string };
    if (frame.type !== 'presence') received.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      'open',
      () => {
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        reject(new Error('gateway socket failed'));
      },
      {
        once: true,
      },
    );
  });
  const until = async (ready: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!ready()) {
      if (Date.now() >= deadline)
        throw new Error(`expected socket frames did not arrive: ${JSON.stringify(received)}`);
      await Bun.sleep(1);
    }
  };
  const ping = async (): Promise<void> => {
    socket.send('{"type":"ping"}');
    await until(() => received.some((frame) => (frame as { type?: string }).type === 'pong'));
  };
  const close = async (): Promise<void> => {
    socket.close();
    await app.stop(true);
  };
  return { socket, received, forwarded, resumed, until, ping, close };
}

it('refuses malformed decoded frames and still pings on the same real socket', async () => {
  const client = await connect();
  const malformed = [
    'null',
    '42',
    '"text"',
    'true',
    '[]',
    '[1]',
    'not json',
    new TextEncoder().encode('{"type":"ping"}'),
    '"{\\"type\\":\\"ping\\"}"',
    '{"type":"subscribe","subscription":42,"message":{}}',
    '{"type":"unsubscribe","subscription":null,"message":{}}',
    '{"type":"resume","subscription":"presence","message":{}}',
    '{"type":"resume","resume_points":[]}',
    '{"type":"resume","resume_points":{"presence":"5"}}',
    '{"type":"resume","resume_points":{"presence":1e999}}',
  ];
  try {
    for (const frame of malformed) {
      client.received.length = 0;
      client.socket.send(frame);
      await client.ping();
      expect(client.received).toEqual([
        { type: 'error', code: 'invalid_payload' },
        { type: 'pong' },
      ]);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      expect(client.forwarded).toEqual([]);
      expect(client.resumed).toEqual([]);
    }
  } finally {
    await client.close();
  }
});

it('keeps supported forwarding and resume maps through the real socket boundary', async () => {
  const client = await connect();
  const frames = [
    { subscription: 'presence', message: { hi: true } },
    { type: 'extension', subscription: 'presence', message: null, extra: 'kept' },
  ];
  try {
    for (const frame of frames) client.socket.send(JSON.stringify(frame));
    client.socket.send('{"type":"resume","resume_points":{"presence":5}}');
    await client.until(() =>
      client.received.some((frame) => (frame as { type?: string }).type === 'resume_ack'),
    );
    expect(client.forwarded).toEqual(frames);
    expect(client.resumed).toEqual([{ presence: 5 }]);
    expect(client.received).toEqual([
      { subscription: 'presence', seq: 6, message: { kept: true } },
      { type: 'resume_ack', replayed: { presence: 1 } },
    ]);
  } finally {
    await client.close();
  }
});

for (const [name, prefix] of [
  ['space', ' '],
  ['tab', '\t'],
  ['newline', '\n'],
] as const) {
  it(`decodes ${name}-prefixed controls, forwarding and resume without reinterpreting strings`, async () => {
    const client = await connect();
    const forwarded = { subscription: 'presence', message: { formatted: true } };
    try {
      client.socket.send(`${prefix}{"type":"ping"}`);
      await client.until(() => client.received.length > 0);
      expect(client.received).toEqual([{ type: 'pong' }]);
      client.received.length = 0;
      client.socket.send(prefix + JSON.stringify(forwarded));
      client.socket.send(`${prefix}{"type":"resume","resume_points":{"presence":5}}`);
      await client.until(() =>
        client.received.some((frame) => (frame as { type?: string }).type === 'resume_ack'),
      );
      expect(client.forwarded).toEqual([forwarded]);
      expect(client.resumed).toEqual([{ presence: 5 }]);
      expect(client.received).toEqual([
        { subscription: 'presence', seq: 6, message: { kept: true } },
        { type: 'resume_ack', replayed: { presence: 1 } },
      ]);
      client.received.length = 0;
      client.socket.send(prefix + JSON.stringify('{"type":"ping"}'));
      await client.ping();
      expect(client.received).toEqual([
        { type: 'error', code: 'invalid_payload' },
        { type: 'pong' },
      ]);
    } finally {
      await client.close();
    }
  });
}

it('replays event zero from the covered empty-history cursor on a real socket', async () => {
  const client = await connect(true);
  try {
    client.socket.send('{"type":"resume","resume_points":{"presence":-1}}');
    await client.ping();
    await client.until(() =>
      client.received.some((frame) => (frame as { type?: string }).type === 'resume_ack'),
    );
    expect(client.resumed).toEqual([{ presence: -1 }]);
    expect(client.received).toContainEqual({
      subscription: 'presence',
      seq: 0,
      message: { kept: true },
    });
    client.received.length = 0;
    client.socket.send('{"type":"resume","resume_points":{"presence":-2}}');
    await client.ping();
    expect(client.received).toEqual([{ type: 'error', code: 'invalid_payload' }, { type: 'pong' }]);
  } finally {
    await client.close();
  }
});
