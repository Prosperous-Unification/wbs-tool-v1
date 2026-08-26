import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SignJWT } from 'jose';

import { buildApp } from './app';

const JWT_KEY = 'k'.repeat(32);
const INTERNAL_SECRET = 's'.repeat(32);
const APP_ORIGIN = 'https://wbs.test';
const key = new TextEncoder().encode(JWT_KEY);

let port: number;
let stop: () => void;

beforeAll(() => {
  const app = buildApp({
    beUrl: 'http://be.invalid',
    internalAuthSecret: INTERNAL_SECRET,
    jwtKey: JWT_KEY,
    appOrigin: APP_ORIGIN,
  });
  app.listen(0);
  port = app.server?.port ?? 0;
  stop = () => {
    void app.stop();
  };
});

afterAll(() => {
  stop();
});

async function tokenFor(username: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`user-${username}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

/** A connected socket, subscribed to `subscription`, collecting what it receives. */
async function connect(username: string, subscription: string) {
  const token = await tokenFor(username);
  const socket = new WebSocket(`ws://localhost:${String(port)}/ws`, {
    headers: {
      cookie: `__Host-wbs_access=${token}`,
      origin: APP_ORIGIN,
    },
  });
  const received: unknown[] = [];
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    received.push(JSON.parse(event.data));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error(`${username} could not connect`));
    });
  });
  socket.send(JSON.stringify({ type: 'subscribe', subscription }));
  return { socket, received };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function push(subscription: string, message: unknown): Promise<Response> {
  return fetch(`http://localhost:${String(port)}/internal/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-auth': INTERNAL_SECRET },
    body: JSON.stringify({ subscription, seq: 1, message }),
  });
}

/**
 * The fan-out with real sockets rather than `app.handle`.
 *
 * be-01's half of the path — recording to the event log, then `PushClient` —
 * has its own tests; what those cannot show is that a socket which asked for a
 * project actually receives what arrives on `/internal/push`, and that one which
 * asked for a different project does not.
 */
describe('project events reach the sockets that asked for them', () => {
  it('delivers to every subscriber of that project and nobody else', async () => {
    const projectId = crypto.randomUUID();
    const subscription = `project:${projectId}`;
    const ada = await connect('ada', subscription);
    const grace = await connect('grace', subscription);
    const linus = await connect('linus', `project:${crypto.randomUUID()}`);
    await settle();

    const res = await push(subscription, {
      type: 'work_items_changed',
      workItems: [{ id: 'w1', number: '010', name: 'Strip' }],
    });

    expect(res.status).toBe(202);
    expect((await res.json()) as { delivered_to_sockets: number }).toEqual({
      delivered_to_sockets: 2,
    });
    await settle();

    const changed = (socket: { received: unknown[] }) =>
      socket.received.filter((m) => (m as { subscription?: string }).subscription === subscription);
    expect(changed(ada)).toHaveLength(1);
    expect(changed(grace)).toHaveLength(1);
    // The one watching another project must not see it — the subscription is a
    // filter, not a formality.
    expect(changed(linus)).toHaveLength(0);

    for (const s of [ada, grace, linus]) s.socket.close();
  });

  it('refuses a socket that asks for an unknown subscription', async () => {
    const stranger = await connect('mallory', 'internal:push');
    await settle();

    const errors = stranger.received.filter(
      (m) => (m as { code?: string }).code === 'unknown_subscription',
    );
    expect(errors).toHaveLength(1);

    // And it received nothing when that channel was pushed to. Asserted against
    // that subscription specifically: the socket is still a live connection and
    // still gets presence, which is not what this is about.
    await push('internal:push', { type: 'tree_replaced', workItems: [] });
    await settle();
    // `code === undefined` excludes the refusal frame, which names the same
    // subscription it is refusing — counting that as a delivery is how this
    // assertion first failed.
    expect(
      stranger.received.filter((m) => {
        const frame = m as { subscription?: string; code?: string };
        return frame.subscription === 'internal:push' && frame.code === undefined;
      }),
    ).toHaveLength(0);

    stranger.socket.close();
  });
});

/** The users named by the last `presence` frame a socket received. */
function rosterSeenBy(client: { received: unknown[] }): string[] {
  const frames = client.received.filter((m) => (m as { type?: string }).type === 'presence');
  return (frames.at(-1) as { users?: string[] } | undefined)?.users ?? [];
}

/**
 * Waits until every socket named has been told a roster of that size, then
 * lets the assertions say what is in it.
 *
 * `settle`'s fixed 60ms is not a fact about the network: a roster arrives one
 * broadcast after the `subscribe` that caused it, and waiting a set number of
 * milliseconds for it is a guess. Bounded, then thrown rather than passed
 * (AGENTS.md, R5): a roster that never arrives is a failure, and it says which
 * socket was still waiting.
 *
 * The wait was read as the whole story once, and it was not: these tests still
 * failed at 19 runs in 45 with three suites running at once, because the
 * `subscribe` was being dropped rather than delayed — no wait of any length
 * would have caught up with it. See `presence-race.integration.test.ts` and
 * `WsConnection.joined` in `app.ts` for what it was. A deadline of 3s against a
 * broadcast that follows in single-digit milliseconds is generous on purpose:
 * what it is here to catch is the frame that never comes.
 *
 * @throws When a roster of that size has not arrived within the deadline.
 */
async function untilRostered(expected: Record<string, [{ received: unknown[] }, number]>) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const waiting = Object.entries(expected).filter(
      ([, [client, size]]) => rosterSeenBy(client).length !== size,
    );
    if (waiting.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `no roster arrived for ${waiting.map(([who]) => who).join(', ')}; ` +
          waiting
            .map(([who, [client]]) => `${who} has [${rosterSeenBy(client).join()}]`)
            .join('; '),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The roster, through `buildApp` and real sockets rather than `Presence` alone.
 *
 * F4, observed live 2026-08-09: a project one second old listed every account
 * with a socket open on this gateway. `presence.test.ts` proves the filter; this
 * proves the production wiring that reaches it — the `subscribe` frame arriving
 * on the ws route, `onSubscribed` resolving the project id, and the broadcast
 * that follows it.
 */
describe('the presence roster is a project’s, not the gateway’s', () => {
  it('shows each socket only the names in the project it subscribed to', async () => {
    // Proof, twice. `onSubscribed` struck from the `handleWsMessage` call in
    // `app.ts`, so nothing ever entered a project: this test failed on
    // `no roster arrived for ada, grace, linus; ada has []; grace has [];
    // linus has []`, together with the other two here. Then the
    // `projectId` filter struck from
    // `Presence.list`, which is the live bug itself: it failed on
    // `no roster arrived for ada, grace, linus; ada has
    // [ada,grace,linus,mallory]` — every account on the gateway, in a project
    // two of them had never opened. Watched 2026-08-09.
    const hull = `project:${crypto.randomUUID()}`;
    const keel = `project:${crypto.randomUUID()}`;
    const ada = await connect('ada', hull);
    const grace = await connect('grace', hull);
    const linus = await connect('linus', keel);
    // Named no project at all: `presence` is a known subscription and is not a
    // project, so this socket is in nobody's roster and sees nobody.
    const lurker = await connect('mallory', 'presence');
    await untilRostered({ ada: [ada, 2], grace: [grace, 2], linus: [linus, 1] });

    expect(rosterSeenBy(ada)).toEqual(['ada', 'grace']);
    expect(rosterSeenBy(grace)).toEqual(['ada', 'grace']);
    expect(rosterSeenBy(linus)).toEqual(['linus']);
    expect(rosterSeenBy(lurker)).toEqual([]);

    for (const s of [ada, grace, linus, lurker]) s.socket.close();
  });

  it('answers `who` with the asking socket’s own project', async () => {
    const hull = `project:${crypto.randomUUID()}`;
    const ada = await connect('ada', hull);
    const linus = await connect('linus', `project:${crypto.randomUUID()}`);
    await untilRostered({ ada: [ada, 1], linus: [linus, 1] });

    ada.received.length = 0;
    ada.socket.send(JSON.stringify({ type: 'who' }));
    await untilRostered({ 'ada, asking who': [ada, 1] });

    expect(rosterSeenBy(ada)).toEqual(['ada']);

    for (const s of [ada, linus]) s.socket.close();
  });

  it('moves a socket that switches project, and tells both rosters', async () => {
    const hull = `project:${crypto.randomUUID()}`;
    const keel = `project:${crypto.randomUUID()}`;
    const ada = await connect('ada', hull);
    const linus = await connect('linus', keel);
    await untilRostered({ ada: [ada, 1], linus: [linus, 1] });

    linus.socket.send(JSON.stringify({ type: 'subscribe', subscription: hull }));
    await untilRostered({ ada: [ada, 2], linus: [linus, 2] });

    expect(rosterSeenBy(linus)).toEqual(['ada', 'linus']);
    // And the people already in the project were told, rather than left showing
    // a roster that is one person short until somebody else joins.
    expect(rosterSeenBy(ada)).toEqual(['ada', 'linus']);

    for (const s of [ada, linus]) s.socket.close();
  });
});

describe('a closed socket leaves the subscription it joined', () => {
  it('is not counted in the fan-out after it disconnects', async () => {
    // codex, high. `close` removed the connection from presence and left it in
    // the subscription map, and every inbound message allocated a fresh wrapper
    // so there was nothing to remove it by. Each reconnect added another dead
    // socket, and `delivered_to_sockets` counted them all.
    const projectId = crypto.randomUUID();
    const subscription = `project:${projectId}`;

    const first = await connect('ada', subscription);
    await settle();
    first.socket.close();
    await settle();

    const second = await connect('ada', subscription);
    await settle();

    const res = await push(subscription, { type: 'tree_replaced', workItems: [] });
    expect((await res.json()) as { delivered_to_sockets: number }).toEqual({
      delivered_to_sockets: 1,
    });

    second.socket.close();
  });
});
