import { expect, it } from 'bun:test';

import { SubscriptionMap } from '../service/subscription-map';
import { handleWsMessage } from './ws.controller';

for (const kind of ['forward', 'resume'] as const) {
  it(`closed connection suppresses ${kind} failure frames and metrics`, async () => {
    const cancellation = new AbortController();
    const sent: string[] = [];
    let failures = 0;
    let rejectRequest: (error: Error) => void = () => {
      throw new Error('request not started');
    };
    const pending = new Promise<never>((_resolve, reject) => {
      rejectRequest = reject;
    });
    const handling = handleWsMessage({
      frame:
        kind === 'forward'
          ? { subscription: 'presence', message: { write: true } }
          : { type: 'resume', resume_points: { presence: 0 } },
      socket: {
        send: (frame) => {
          sent.push(frame);
        },
      },
      subs: new SubscriptionMap(),
      clientId: 'u',
      connectionId: 'c',
      forward: () => pending,
      resume: () => pending,
      signal: cancellation.signal,
      onBackendUnavailable: () => {
        failures++;
      },
    });
    cancellation.abort();
    rejectRequest(new Error('connection closed'));
    await handling;
    expect(sent).toEqual([]);
    expect(failures).toBe(0);
  });
}
it('closed connection suppresses a late successful replay', async () => {
  const cancellation = new AbortController();
  const sent: string[] = [];
  let resolveRequest: (
    reply: Record<string, { status: 'replaying'; events: { seq: number; message: unknown }[] }>,
  ) => void = () => {
    throw new Error('request not started');
  };
  const pending = new Promise<
    Record<string, { status: 'replaying'; events: { seq: number; message: unknown }[] }>
  >((resolve) => {
    resolveRequest = resolve;
  });
  const handling = handleWsMessage({
    frame: { type: 'resume', resume_points: { presence: 0 } },
    socket: {
      send: (frame) => {
        sent.push(frame);
      },
    },
    subs: new SubscriptionMap(),
    clientId: 'u',
    connectionId: 'c',
    forward: () => Promise.resolve({ ack: true }),
    resume: () => pending,
    signal: cancellation.signal,
  });
  cancellation.abort();
  resolveRequest({
    presence: { status: 'replaying', events: [{ seq: 1, message: { late: true } }] },
  });
  await handling;
  expect(sent).toEqual([]);
});
