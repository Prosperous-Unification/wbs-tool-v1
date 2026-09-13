import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SignJWT } from 'jose';

import { buildApp } from './app';
import { loadConfig } from './config';
import { type JwtClaims, JwtVerifier, type TokenVerifier } from './service/jwt-auth';

const JWT_KEY = 'k'.repeat(32);
const INTERNAL_SECRET = 's'.repeat(32);
const APP_ORIGIN = 'https://dev.wbs.test';
const key = new TextEncoder().encode(JWT_KEY);

let port: number;
let stop: () => void;

beforeAll(() => {
  const cfg = (
    loadConfig as unknown as (
      env: Record<string, string>,
      oidcVerifierFromEnv: () => { verify(token: string): Promise<{ sub: string }> },
    ) => ReturnType<typeof loadConfig>
  )(
    {
      AUTH_AUDIENCE: 'wbs-api',
      AUTH_CLIENT_ID: 'client',
      AUTH_CLIENT_SECRET: 'secret',
      AUTH_ISSUER_DISCOVERY_URL: 'https://idp.invalid',
      AUTH_MODE: 'oidc',
      AUTH_REDIRECT_URI: `${APP_ORIGIN}/api/auth/okta/callback`,
      BE_URL: 'http://be.invalid',
      INTERNAL_AUTH_SECRET: INTERNAL_SECRET,
      JWT_SIGNING_KEY_CURRENT: JWT_KEY,
      LOG_LEVEL: 'info',
      PORT: '0',
    },
    () => ({ verify: () => Promise.reject(new Error('not an OIDC token')) }),
  );
  const app = buildApp({
    beUrl: cfg.BE_URL,
    internalAuthSecret: cfg.INTERNAL_AUTH_SECRET,
    jwtKey: cfg.JWT_SIGNING_KEY_CURRENT,
    previousJwtKey: cfg.JWT_SIGNING_KEY_PREVIOUS,
    ...cfg.wsAuth,
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

async function tokenFor(username: string, expiresAt?: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`user-${username}`)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt ?? now + 3600)
    .sign(key);
}

function openSocket(headers: Record<string, string>, path = '/ws'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${String(port)}${path}`, {
      headers,
    });
    socket.addEventListener(
      'open',
      () => {
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        reject(new Error('WebSocket upgrade was refused'));
      },
      { once: true },
    );
  });
}

function expectRefused(headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${String(port)}/ws`, {
      headers,
    });
    socket.addEventListener(
      'open',
      () => {
        socket.close();
        reject(new Error('WebSocket upgrade unexpectedly opened'));
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function expectUrlRefused(url: string, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.addEventListener(
      'open',
      () => {
        socket.close();
        reject(new Error('WebSocket upgrade unexpectedly opened'));
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

describe('WebSocket query authentication', () => {
  it('refuses a valid session JWT carried in the production OIDC URL', async () => {
    const token = await tokenFor('ada');

    await expectUrlRefused(`ws://localhost:${String(port)}/ws?token=${encodeURIComponent(token)}`, {
      origin: APP_ORIGIN,
    });
  });

  it('refuses an upgrade when WebSocket authentication is not configured', async () => {
    const app = buildApp({
      beUrl: 'http://be.invalid',
      internalAuthSecret: INTERNAL_SECRET,
      jwtKey: JWT_KEY,
    });
    app.listen(0);
    try {
      const response = await fetch(`http://localhost:${String(app.server?.port ?? 0)}/ws`, {
        headers: {
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          upgrade: 'websocket',
        },
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'websocket auth not configured' });
    } finally {
      await app.stop();
    }
  });
});

/**
 * The browser handshake boundary, not cookie parsing in isolation.
 *
 * A browser cannot set the old query token once the front end moves to an
 * httpOnly cookie. This real upgrade proves the cookie reaches the verifier
 * and produces a usable authenticated socket.
 */
describe('OIDC WebSocket authentication', () => {
  it('accepts the hardened access cookie from the application origin', async () => {
    // Proof: without the cookie token source in the production beforeHandle,
    // this upgrade is refused as `missing token`. Watched 2026-08-24.
    const token = await tokenFor('ada');
    const socket = await openSocket(
      {
        cookie: `__Host-wbs_access=${token}`,
        origin: APP_ORIGIN,
      },
      '/ws?localIdentity=mallory',
    );

    const received: unknown[] = [];
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      received.push(JSON.parse(event.data));
    });
    socket.send(
      JSON.stringify({ type: 'subscribe', subscription: `project:${crypto.randomUUID()}` }),
    );
    const deadline = Date.now() + 3_000;
    for (;;) {
      const roster = received
        .filter((frame) => (frame as { type?: string }).type === 'presence')
        .at(-1) as { users?: string[] } | undefined;
      if (roster?.users?.includes('ada') === true) break;
      if (Date.now() > deadline) {
        throw new Error(`authenticated roster never named ada: ${JSON.stringify(received)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(
      received.filter((frame) => (frame as { type?: string }).type === 'presence').at(-1),
    ).toEqual({ type: 'presence', users: ['ada'] });
    socket.close();
  });

  it('refuses a valid cookie presented by a foreign origin', async () => {
    // Proof: with the Origin comparison removed from the production upgrade,
    // this socket opens. Watched 2026-08-24.
    const token = await tokenFor('mallory');

    await expectRefused({
      cookie: `__Host-wbs_access=${token}`,
      origin: 'https://evil.test',
    });
  });

  it('refuses an expired access cookie during the upgrade', async () => {
    // Proof: bypassing `verifier.verify` in the production beforeHandle makes
    // this real socket open. Watched 2026-08-24.
    const now = Math.floor(Date.now() / 1000);
    const token = await tokenFor('ada', now - 60);

    await expectRefused({
      cookie: `__Host-wbs_access=${token}`,
      origin: APP_ORIGIN,
    });
  });
});

/**
 * The gap between the two hooks, not cookie parsing.
 *
 * `beforeHandle` verifies the cookie and `open` verifies it a second time,
 * because Elysia gives the two hooks separate contexts and `open` will not
 * trust a username it never saw. A token that expires in that window — or an
 * Elysia release that stops sharing the query object — makes the second
 * verification fail after the upgrade has already been accepted. What must not
 * happen then is that the socket stays open and serves project data under a
 * fallback identity.
 */
describe('WebSocket identity after the upgrade', () => {
  /** Accepts the upgrade, then fails the recheck — a token expiring mid-handshake. */
  function verifierThatExpiresAfterTheUpgrade(): TokenVerifier {
    const real = new JwtVerifier({ current: key });
    let calls = 0;
    return {
      async verify(token: string): Promise<JwtClaims> {
        calls += 1;
        if (calls > 1) throw new Error('token expired between the upgrade and the join');
        return real.verify(token);
      },
    };
  }

  function verifierThatExpiresDuringAnInFlightFrame(): TokenVerifier {
    const real = new JwtVerifier({ current: key });
    let calls = 0;
    return {
      async verify(token: string): Promise<JwtClaims> {
        calls += 1;
        if (calls === 1) return real.verify(token);
        // A browser's `open` event fires while Bun is still awaiting this
        // handler, so the frame sent there reaches `message` before rejection.
        await Bun.sleep(100);
        throw new Error('token expired while a frame was in flight');
      },
    };
  }

  it('closes a socket whose identity fails the recheck instead of serving it as anon', async () => {
    const app = buildApp({
      appOrigin: APP_ORIGIN,
      beUrl: 'http://be.invalid',
      internalAuthSecret: INTERNAL_SECRET,
      jwtKey: JWT_KEY,
      verifier: verifierThatExpiresAfterTheUpgrade(),
    });
    app.listen(0);
    const livePort = app.server?.port ?? 0;
    try {
      const token = await tokenFor('ada');
      const socket = new WebSocket(`ws://localhost:${String(livePort)}/ws`, {
        headers: { cookie: `__Host-wbs_access=${token}`, origin: APP_ORIGIN },
      });
      const received: unknown[] = [];
      socket.addEventListener('message', (event: MessageEvent<string>) => {
        received.push(JSON.parse(event.data));
      });

      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const closed = await new Promise<{ code: number }>((resolve, reject) => {
        socket.addEventListener('close', (event: CloseEvent) => {
          resolve({ code: event.code });
        });
        giveUp = setTimeout(() => {
          reject(new Error('socket stayed open without an identity'));
        }, 2_000);
      });
      clearTimeout(giveUp);

      // 1008 is "policy violation": the handshake was accepted and then the
      // identity behind it stopped being true.
      expect(closed.code).toBe(1008);
      expect(received).toEqual([]);
    } finally {
      void app.stop();
    }
  });

  it('drops a frame already in flight when the identity recheck fails', async () => {
    let forwards = 0;
    const app = buildApp({
      appOrigin: APP_ORIGIN,
      beUrl: 'http://be.invalid',
      internalAuthSecret: INTERNAL_SECRET,
      jwtKey: JWT_KEY,
      verifier: verifierThatExpiresDuringAnInFlightFrame(),
      fetchImpl: () => {
        forwards += 1;
        return Promise.resolve(new Response(JSON.stringify({ ack: true }), { status: 200 }));
      },
    });
    app.listen(0);
    const livePort = app.server?.port ?? 0;
    try {
      const token = await tokenFor('ada');
      const socket = new WebSocket(`ws://localhost:${String(livePort)}/ws`, {
        headers: { cookie: `__Host-wbs_access=${token}`, origin: APP_ORIGIN },
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
            reject(new Error('upgrade failed'));
          },
          { once: true },
        );
      });

      const closedPromise = new Promise<{ code: number }>((resolve, reject) => {
        const giveUp = setTimeout(() => {
          reject(new Error('identity-less socket stayed open'));
        }, 2_000);
        socket.addEventListener(
          'close',
          (event: CloseEvent) => {
            clearTimeout(giveUp);
            resolve({ code: event.code });
          },
          { once: true },
        );
      });

      socket.send(
        JSON.stringify({
          subscription: 'project:00000000-0000-4000-8000-000000000001',
          message: { type: 'changed' },
        }),
      );

      const closed = await closedPromise;

      expect(closed.code).toBe(1008);
      expect(forwards).toBe(0);
    } finally {
      void app.stop();
    }
  });
});
