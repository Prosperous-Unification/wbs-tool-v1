import { randomBytes } from 'node:crypto';

import { type BrowserOidcClient, browserOidcClientFromEnv } from '@wbs/auth';

import type { McpConfig } from './config';
import type { McpOAuthHandler } from './http';

const SCOPES = new Set(['wbs:read', 'wbs:write', 'wbs:editor']);
const COOKIE = '__Host-wbs_mcp_oauth';
const TTL_MS = 300_000;

interface ClientRecord {
  redirectUris: readonly string[];
}

interface Transaction {
  browserBinding: string;
  clientId: string;
  codeChallenge: string;
  expiresAt: number;
  nonce: string;
  redirectUri: string;
  scope: string;
  state?: string;
  upstreamState: string;
  verifier: string;
}

export interface McpAuthorizationGrant {
  clientId: string;
  codeChallenge: string;
  expiresAt: number;
  redirectUri: string;
  scope: string;
  upstreamAccessToken: string;
}

interface Options {
  now?: () => number;
  random?: () => string;
}

type UpstreamClient = Pick<BrowserOidcClient, 'authorizationUrl' | 'exchange'>;

/** In-memory public-client registration plus the browser half of the fronting AS. */
export class InMemoryMcpOAuth implements McpOAuthHandler {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly grants = new Map<string, McpAuthorizationGrant>();
  private readonly transactions = new Map<string, Transaction>();
  private readonly now: () => number;
  private readonly random: () => string;
  private readonly issuer: string;
  private readonly callbackUrl: string;

  constructor(
    config: Pick<McpConfig, 'MCP_PUBLIC_URL'>,
    private readonly upstream: UpstreamClient,
    options: Options = {},
  ) {
    const resource = new URL(config.MCP_PUBLIC_URL);
    this.issuer = `${resource.origin}${resource.pathname.replace(/\/$/, '')}/oauth`;
    this.callbackUrl = `${this.issuer}/callback`;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (() => randomBytes(32).toString('base64url'));
  }

  async response(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === new URL(`${this.issuer}/register`).pathname && request.method === 'POST') {
      return await this.register(request);
    }
    if (url.pathname === new URL(`${this.issuer}/authorize`).pathname && request.method === 'GET') {
      return await this.authorize(url);
    }
    if (url.pathname === new URL(this.callbackUrl).pathname && request.method === 'GET') {
      return await this.callback(request, url);
    }
    return undefined;
  }

  readGrant(code: string): McpAuthorizationGrant | null {
    const grant = this.grants.get(code);
    if (grant === undefined) return null;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(code);
      return null;
    }
    return grant;
  }

  private async register(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return oauthError('invalid_client_metadata');
    }
    if (!isObject(body) || body['token_endpoint_auth_method'] !== 'none') {
      return oauthError('invalid_client_metadata');
    }
    const redirectUris = body['redirect_uris'];
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every(isRedirect)
    ) {
      return oauthError('invalid_redirect_uri');
    }
    const clientId = this.random();
    this.clients.set(clientId, { redirectUris });
    return Response.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(this.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
      },
      { status: 201 },
    );
  }

  private async authorize(url: URL): Promise<Response> {
    const params = url.searchParams;
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const challenge = params.get('code_challenge') ?? '';
    const scope = params.get('scope') ?? 'wbs:read';
    const scopes = scope.split(' ').filter(Boolean);
    if (
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
      scopes.length === 0 ||
      scopes.some((value) => !SCOPES.has(value)) ||
      !this.clients.get(clientId)?.redirectUris.includes(redirectUri)
    ) {
      return oauthError('invalid_request');
    }

    this.cleanup();
    const browserBinding = this.random();
    const upstreamState = this.random();
    const nonce = this.random();
    const verifier = this.random();
    this.transactions.set(browserBinding, {
      browserBinding,
      clientId,
      codeChallenge: challenge,
      expiresAt: this.now() + TTL_MS,
      nonce,
      redirectUri,
      scope,
      state: params.get('state') ?? undefined,
      upstreamState,
      verifier,
    });
    const location = await this.upstream.authorizationUrl({
      nonce,
      redirectUri: this.callbackUrl,
      state: upstreamState,
      verifier,
    });
    return redirect(location.href, cookie(browserBinding));
  }

  private async callback(request: Request, url: URL): Promise<Response> {
    const binding = cookieOf(request, COOKIE);
    const state = url.searchParams.get('state');
    const transaction = binding === undefined ? undefined : this.transactions.get(binding);
    if (binding !== undefined) this.transactions.delete(binding);
    if (
      transaction === undefined ||
      transaction.expiresAt <= this.now() ||
      state !== transaction.upstreamState
    ) {
      return oauthError('invalid_request', clearCookie());
    }

    const callback = new URL(this.callbackUrl);
    callback.search = url.search;
    const tokens = await this.upstream.exchange(
      new Request(callback, { headers: request.headers }),
      {
        nonce: transaction.nonce,
        state: transaction.upstreamState,
        verifier: transaction.verifier,
      },
    );
    const code = this.random();
    this.grants.set(code, {
      clientId: transaction.clientId,
      codeChallenge: transaction.codeChallenge,
      expiresAt: this.now() + TTL_MS,
      redirectUri: transaction.redirectUri,
      scope: transaction.scope,
      upstreamAccessToken: tokens.accessToken,
    });
    const target = new URL(transaction.redirectUri);
    target.searchParams.set('code', code);
    if (transaction.state !== undefined) target.searchParams.set('state', transaction.state);
    return redirect(target.href, clearCookie());
  }

  private cleanup(): void {
    const now = this.now();
    for (const [binding, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(binding);
    }
    for (const [code, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(code);
    }
  }
}

export function mcpOAuthFromEnv(
  config: Pick<McpConfig, 'MCP_PUBLIC_URL'>,
  env: Readonly<Record<string, string | undefined>>,
): InMemoryMcpOAuth {
  let client: BrowserOidcClient | undefined;
  const get = () => (client ??= browserOidcClientFromEnv(env));
  return new InMemoryMcpOAuth(config, {
    authorizationUrl: (input) => get().authorizationUrl(input),
    exchange: (request, checks) => get().exchange(request, checks),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
    );
  } catch {
    return false;
  }
}

function cookieOf(request: Request, name: string): string | undefined {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];
}

function cookie(value: string): string {
  return `${COOKIE}=${value}; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(): string {
  return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(location: string, setCookie: string): Response {
  return new Response(null, { headers: { location, 'set-cookie': setCookie }, status: 302 });
}

function oauthError(error: string, setCookie?: string): Response {
  return Response.json(
    { error },
    { headers: setCookie === undefined ? undefined : { 'set-cookie': setCookie }, status: 400 },
  );
}
