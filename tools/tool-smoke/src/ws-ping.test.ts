import { describe, expect, it } from 'bun:test';

import { caddyUpgradeRequest, runBackendHopSmoke, runPingSmoke, type SocketLike } from './ws-ping';

describe('caddyUpgradeRequest', () => {
  it('authenticates in headers and keeps the session credential out of the request target', () => {
    const request = caddyUpgradeRequest(
      {
        host: 'caddy',
        port: 443,
        path: '/ws',
        siteAddress: 'wbs.test',
        rejectUnauthorized: true,
        token: 'header.payload.signature',
      },
      'websocket-key',
    );

    expect(request).toContain('GET /ws HTTP/1.1\r\n');
    expect(request).toContain('Origin: https://wbs.test\r\n');
    expect(request).toContain('Cookie: __Host-wbs_access=header.payload.signature\r\n');
    expect(request).not.toContain('?token=');
  });
});

describe('runPingSmoke', () => {
  it('reports ok when the socket echoes a pong', async () => {
    const fake = {
      send: () => undefined,
      close: () => undefined,
      addEventListener: (ev: string, cb: (e: { data: string }) => void) => {
        if (ev === 'message')
          setTimeout(() => {
            cb({ data: '{"type":"pong"}' });
          }, 0);
        if (ev === 'open')
          setTimeout(() => {
            cb({ data: '' });
          }, 0);
      },
    };
    const res = await runPingSmoke({ connect: () => fake, timeoutMs: 100 });
    expect(res.ok).toBe(true);
  });

  it('ignores presence before the pong response', async () => {
    const presenceThenPong = scriptedGateway([
      '{"type":"presence","users":["smoke"]}',
      '{"type":"pong"}',
    ]);

    const res = await runPingSmoke({ connect: () => presenceThenPong, timeoutMs: 100 });

    expect(res).toEqual({ ok: true, detail: '{"type":"pong"}' });
  });

  it('reports failure when nothing answers before the timeout', async () => {
    const silent = {
      send: () => undefined,
      close: () => undefined,
      addEventListener: (ev: string, cb: (e: { data: string }) => void) => {
        if (ev === 'open')
          setTimeout(() => {
            cb({ data: '' });
          }, 0);
      },
    };
    const res = await runPingSmoke({ connect: () => silent, timeoutMs: 50 });
    expect(res.ok).toBe(false);
  });

  it('reports failure when the socket replies with something other than pong', async () => {
    const wrongReply = {
      send: () => undefined,
      close: () => undefined,
      addEventListener: (ev: string, cb: (e: { data: string }) => void) => {
        if (ev === 'message')
          setTimeout(() => {
            cb({ data: '{"type":"error","code":"invalid_payload"}' });
          }, 0);
        if (ev === 'open')
          setTimeout(() => {
            cb({ data: '' });
          }, 0);
      },
    };
    const res = await runPingSmoke({ connect: () => wrongReply, timeoutMs: 100 });
    expect(res.ok).toBe(false);
  });

  it('reports malformed response data instead of waiting for timeout', async () => {
    const malformed = scriptedGateway(['not-json']);

    const res = await runPingSmoke({ connect: () => malformed, timeoutMs: 100 });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain('not JSON');
  });
});

/**
 * A gw-01 that answers the probe with a fixed script of frames.
 *
 * Records what was sent, because "the probe asked the right question" is half of
 * what makes its answer mean anything: a run that never sent the resume would
 * see no denial either.
 */
function scriptedGateway(replies: readonly string[]): SocketLike & { sent: string[] } {
  const sent: string[] = [];
  const listeners: {
    open: ((e: { data: string }) => void)[];
    message: ((e: { data: string }) => void)[];
  } = { open: [], message: [] };
  return {
    sent,
    send: (data) => {
      sent.push(data);
    },
    close: () => undefined,
    addEventListener: (ev, cb) => {
      if (ev === 'open') listeners.open.push(cb);
      if (ev !== 'message') return;
      listeners.message.push(cb);
      // Queued once both listeners are attached — `runBackendHopSmoke` adds
      // `open` first, and the open handler is what sends the probe.
      setTimeout(() => {
        for (const open of listeners.open) open({ data: '' });
        for (const reply of replies) {
          for (const message of listeners.message) message({ data: reply });
        }
      }, 0);
    },
  };
}

describe('runBackendHopSmoke', () => {
  it('asks be-01 something only be-01 can answer', async () => {
    const gw = scriptedGateway([
      '{"type":"resume_denied","subscription":"project:00000000-0000-0000-0000-000000000000","reason":"out_of_range"}',
      '{"type":"resume_ack","replayed":{}}',
    ]);
    const res = await runBackendHopSmoke({ connect: () => gw, timeoutMs: 2000 });

    expect(res.ok).toBe(true);
    // The forward envelope first, then the resume. Without the first there is
    // nothing exercising gw-01's ForwardClient at all, which is the finding this
    // check exists for.
    expect(gw.sent[0]).toContain('"subscription"');
    expect(gw.sent[0]).toContain('"message"');
    expect(gw.sent[1]).toContain('"type":"resume"');
  });

  it('fails when gw-01 could not reach be-01 to resume', async () => {
    // `unavailable` is gw-01's own catch — an unreachable be-01, a non-2xx, or a
    // rejected internal secret. `out_of_range` above is be-01's answer and can
    // only come from a call that arrived. That is the whole distinction the
    // check rests on.
    const gw = scriptedGateway([
      '{"type":"resume_denied","subscription":"project:00000000-0000-0000-0000-000000000000","reason":"unavailable"}',
      '{"type":"resume_ack","replayed":{}}',
    ]);
    const res = await runBackendHopSmoke({ connect: () => gw, timeoutMs: 2000 });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain('could not reach be-01');
  });

  it('fails when the forward is refused', async () => {
    const gw = scriptedGateway(['{"type":"error","code":"backend_unavailable","retry_after":5}']);
    const res = await runBackendHopSmoke({ connect: () => gw, timeoutMs: 2000 });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain('could not forward');
  });

  it('fails when the forward error arrives after the resume settled', async () => {
    // The forward and the resume are independent HTTP calls and gw-01 does not
    // serialise them, so the error frame can land after `resume_ack`. The drain
    // window is what catches it; without one this run would report ok.
    const gw = scriptedGateway([
      '{"type":"resume_denied","subscription":"project:00000000-0000-0000-0000-000000000000","reason":"out_of_range"}',
      '{"type":"resume_ack","replayed":{}}',
      '{"type":"error","code":"backend_unavailable","retry_after":5}',
    ]);
    const res = await runBackendHopSmoke({ connect: () => gw, timeoutMs: 2000 });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain('could not forward');
  });

  it('fails when nothing answers at all', async () => {
    const silent = scriptedGateway([]);
    const res = await runBackendHopSmoke({ connect: () => silent, timeoutMs: 100 });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain('no resume_ack');
  });
});
