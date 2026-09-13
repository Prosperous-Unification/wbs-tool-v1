import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SignJWT } from 'jose';

import { buildApp } from './app';
import { type JwtClaims, JwtVerifier, type TokenVerifier } from './service/jwt-auth';

const JWT_KEY = 'k'.repeat(32);
const INTERNAL_SECRET = 's'.repeat(32);
const APP_ORIGIN = 'https://wbs.test';
const key = new TextEncoder().encode(JWT_KEY);

/**
 * Long enough that a frame sent the moment the socket opens lands while `open`
 * is still inside `verify`, and short enough to keep the suite quick. The race
 * this file is about is otherwise decided by whichever of a loopback round trip
 * and an HMAC verification finishes first — it went the wrong way in 2 runs of
 * 40, which is what made `fan-out.integration.test.ts` flaky rather than red.
 */
const VERIFY_MS = 50;

/** A real verifier that is still verifying when the next frame arrives. */
function slowVerifier(): TokenVerifier {
  const real = new JwtVerifier({ current: key });
  return {
    async verify(token: string): Promise<JwtClaims> {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_MS));
      return real.verify(token);
    },
  };
}

let port: number;
let stop: () => void;

beforeAll(() => {
  const app = buildApp({
    beUrl: 'http://be.invalid',
    internalAuthSecret: INTERNAL_SECRET,
    jwtKey: JWT_KEY,
    appOrigin: APP_ORIGIN,
    verifier: slowVerifier(),
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

/** A connected socket, collecting what it receives. Sends nothing on its own. */
async function connect(username: string) {
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
  return { socket, received };
}

function rosterSeenBy(client: { received: unknown[] }): string[] {
  const frames = client.received.filter((m) => (m as { type?: string }).type === 'presence');
  return (frames.at(-1) as { users?: string[] } | undefined)?.users ?? [];
}

/**
 * Waits for a roster of `size` and then for the verification window to pass, so
 * the assertion is on the roster that stands rather than one still in flight.
 *
 * @throws When no such roster arrives within the deadline.
 */
async function untilRostered(client: { received: unknown[] }, who: string, size: number) {
  const deadline = Date.now() + 3_000;
  while (rosterSeenBy(client).length !== size) {
    if (Date.now() > deadline) {
      throw new Error(
        `no roster of ${String(size)} for ${who}; it has [${rosterSeenBy(client).join()}]`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, VERIFY_MS * 2));
}

/**
 * What the `/ws` handlers do while a connection's `open` is still verifying.
 *
 * A browser sends `subscribe` the instant its socket opens, and Bun delivers
 * that frame to `message` without waiting for an `open` handler that is still
 * awaiting — so both tests here describe the ordinary case, not an exotic one.
 * `app.ts`'s `WsConnection.joined` is what makes the ordering hold.
 */
describe('a frame that arrives before the connection has joined', () => {
  it('rosters a socket whose `subscribe` overtakes its own join', async () => {
    // Proof: `await conn.joined` struck from `message` in `app.ts`, leaving the
    // handler as it was before this change — this test failed on
    // `no roster of 1 for ada; it has []`, the same sentence, and the same
    // cause, as the flake in `fan-out.integration.test.ts`. Watched 2026-08-11.
    const hull = `project:${crypto.randomUUID()}`;
    const ada = await connect('ada');

    ada.socket.send(JSON.stringify({ type: 'subscribe', subscription: hull }));
    await untilRostered(ada, 'ada', 1);

    expect(rosterSeenBy(ada)).toEqual(['ada']);

    ada.socket.close();
  });

  it('leaves no ghost behind when a socket closes before it has joined', async () => {
    // Proof: `await conn.joined` struck from `close`, so `leave` ran against a
    // connection `join` had not made yet and deleted nothing, while the
    // `subscribe` behind it entered the project after the join — this test
    // failed on `no roster of 1 for grace; it has [ada,grace]`, a roster naming
    // a socket that had been shut for three seconds. Watched 2026-08-11.
    const hull = `project:${crypto.randomUUID()}`;
    const departing = await connect('ada');
    departing.socket.send(JSON.stringify({ type: 'subscribe', subscription: hull }));
    departing.socket.close();

    const grace = await connect('grace');
    grace.socket.send(JSON.stringify({ type: 'subscribe', subscription: hull }));
    await untilRostered(grace, 'grace', 1);

    expect(rosterSeenBy(grace)).toEqual(['grace']);

    grace.socket.close();
  });
});
