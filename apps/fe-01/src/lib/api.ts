export interface SessionUser {
  id: string;
  username: string;
}

export interface Session {
  token: string;
  user: SessionUser;
}

/** The site gate rejected us; the app was never reached. */
export const EDGE_UNAUTHORIZED = 'edge_unauthorized';

/**
 * Same-origin paths, never an absolute URL. The edge serves the app and
 * proxies `/api/*` and `/ws` on the same host, so a configured base URL would
 * be a second source of truth that is wrong on exactly one environment.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // A 401 from an EDGE and a 401 from the APP mean opposite things, and the
    // user can only fix one of them. Dev used to sit behind HTTP Basic auth, and
    // a rejected site password produced a 401 that never reached be-01 — which
    // the old code reported as `http_401`, rendered as "Something went wrong
    // (http_401)". Indistinguishable from a wrong account password, and it sent
    // a real person hunting through the app for a fault one layer above it.
    //
    // **Dev has had no edge password since 2026-08-06, so this branch is not
    // reachable there today.** It is kept rather than deleted: any proxy in
    // front of any environment can challenge, and the cost of being wrong about
    // that again is an afternoon. `WWW-Authenticate` is the discriminator — an
    // edge sets it on its challenge and this API never does.
    if (res.status === 401 && res.headers.get('www-authenticate') !== null) {
      throw new Error(EDGE_UNAUTHORIZED);
    }
    // Otherwise the server's own error code is surfaced rather than a generic
    // message: "taken" and "invalid_credentials" need different words.
    let code = `http_${String(res.status)}`;
    try {
      code = (JSON.parse(text) as { error?: string }).error ?? code;
    } catch {
      // Non-JSON body (a proxy error page, say) — keep the status code.
    }
    throw new Error(code);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 that is not our JSON came from something between here and be-01.
    // Throwing a named code beats a raw SyntaxError surfacing as the message.
    throw new Error('unexpected_response');
  }
}

export const register = (username: string, password: string): Promise<Session> =>
  post<Session>('/api/auth/register', { username, password });

export const login = (username: string, password: string): Promise<Session> =>
  post<Session>('/api/auth/login', { username, password });

/** Resolves the httpOnly browser session without exposing its token to JavaScript. */
export async function me(): Promise<SessionUser | null> {
  // `x-wbs-token`, never `Authorization`. Dev's edge requires an
  // `Authorization: Basic` credential on /api, and a Bearer header from here
  // would overwrite the one the browser attaches — turning every authenticated
  // request into a 401 from Caddy that looks like an expired app token.
  const res = await fetch('/api/auth/me');
  if (!res.ok) return null;
  return ((await res.json()) as { user: SessionUser }).user;
}

/**
 * The gateway takes the token in the query string, not a header: a browser
 * cannot set Authorization on a WebSocket handshake. That is also why the
 * edge exempts `/ws` from basic auth — gw-01 rejects a missing or invalid
 * token itself.
 */
export function websocketUrl(token?: string): string {
  void token;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}
