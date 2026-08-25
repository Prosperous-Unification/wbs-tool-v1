import { createHash, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';

import {
  type BrowserOidcClient,
  browserOidcClientFromEnv,
  type JwtClaims,
  oidcIdentityFromClaims,
  oidcTokenVerifierFromEnv,
  type TokenVerifier,
} from '@wbs/auth';
import { type JWTPayload, jwtVerify, SignJWT } from 'jose';

import type { McpConfig } from './config';
import type { McpOAuthHandler } from './http';

const SCOPES = new Set(['wbs:read', 'wbs:write', 'wbs:editor']);
const COOKIE = '__Host-wbs_mcp_oauth';
const TTL_MS = 300_000;
const UNPROVEN_CLIENT_TTL_MS = 600_000;
const ACTIVE_CLIENT_TTL_MS = 86_400_000;
const MAX_AUTHORIZATION_QUERY_BYTES = 2_048;
const MAX_STATE_BYTES = 512;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_BYTES = 512;

interface ClientRecord {
  proven: boolean;
  promotionReserved: boolean;
  redirectUris: readonly string[];
  source: string;
  expiresAt: number;
  unprovenExpiresAt: number;
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
  scopes: readonly string[];
  subject: string;
  upstreamAccessToken: string;
}

interface McpSession {
  expiresAt: number;
  upstreamAccessToken: string;
}

interface Options {
  groupsClaim?: string;
  groupPrefix?: string;
  now?: () => number;
  random?: () => string;
  signingKeys?: { privateKey: KeyObject; publicKey: KeyObject };
  verifyUpstream?: TokenVerifier['verify'];
  clientLimit?: number;
  clientSourceLimit?: number;
  provenClientSourceLimit?: number;
  clientTtlMs?: number;
  grantLimit?: number;
  activeClientTtlMs?: number;
  sessionLimit?: number;
  transactionLimit?: number;
  transactionLimitPerClient?: number;
}

type UpstreamClient = Pick<BrowserOidcClient, 'authorizationUrl' | 'exchange'>;

/** In-memory public-client registration plus the browser half of the fronting AS. */
export class InMemoryMcpOAuth implements McpOAuthHandler {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly grants = new Map<string, McpAuthorizationGrant>();
  private readonly sessions = new Map<string, McpSession>();
  private readonly transactions = new Map<string, Transaction>();
  private readonly now: () => number;
  private readonly random: () => string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly callbackUrl: string;
  private readonly groupsClaim: string;
  private readonly groupPrefix: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly verifyUpstream: TokenVerifier['verify'];

  private readonly clientLimit: number;
  private readonly clientSourceLimit: number;
  private readonly provenClientSourceLimit: number;
  private readonly clientTtlMs: number;
  private readonly activeClientTtlMs: number;
  private readonly grantLimit: number;
  private readonly sessionLimit: number;
  private readonly transactionLimit: number;
  private readonly transactionLimitPerClient: number;
  constructor(
    config: Pick<McpConfig, 'MCP_PUBLIC_URL'>,
    private readonly upstream: UpstreamClient,
    options: Options = {},
  ) {
    const resource = new URL(config.MCP_PUBLIC_URL);
    this.audience = `${resource.origin}${resource.pathname.replace(/\/$/, '')}`;
    this.issuer = `${this.audience}/oauth`;
    this.callbackUrl = `${this.issuer}/callback`;
    this.groupsClaim = options.groupsClaim ?? 'wbs_groups';
    this.groupPrefix = options.groupPrefix ?? 'dev';
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (() => randomBytes(32).toString('base64url'));
    const keys = options.signingKeys ?? generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    this.verifyUpstream =
      options.verifyUpstream ?? (() => Promise.reject(new Error('upstream verifier is required')));
    this.clientLimit = Math.max(1, options.clientLimit ?? 1_000);
    this.clientSourceLimit = Math.max(1, options.clientSourceLimit ?? 20);
    this.provenClientSourceLimit = Math.max(1, options.provenClientSourceLimit ?? 100);
    this.clientTtlMs = Math.max(1, options.clientTtlMs ?? UNPROVEN_CLIENT_TTL_MS);
    this.activeClientTtlMs = Math.max(1, options.activeClientTtlMs ?? ACTIVE_CLIENT_TTL_MS);
    this.grantLimit = Math.max(1, options.grantLimit ?? 1_000);
    this.sessionLimit = Math.max(1, options.sessionLimit ?? 1_000);
    this.transactionLimit = Math.max(1, options.transactionLimit ?? 1_000);
    this.transactionLimitPerClient = Math.max(1, options.transactionLimitPerClient ?? 5);
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
    if (url.pathname === new URL(`${this.issuer}/token`).pathname && request.method === 'POST') {
      return await this.token(request);
    }
    if (url.pathname === new URL(`${this.issuer}/revoke`).pathname && request.method === 'POST') {
      return await this.revoke(request);
    }
    if (url.pathname === new URL(`${this.issuer}/jwks`).pathname && request.method === 'GET') {
      return Response.json({ keys: [this.publicJwk()] });
    }
    return undefined;
  }

  async verify(token: string): Promise<JwtClaims> {
    try {
      return await this.verifyLocal(token);
    } catch {
      return await this.verifyUpstream(token);
    }
  }

  async upstreamTokenFor(token: string): Promise<string> {
    try {
      const payload = await this.verifyLocal(token);
      const session = this.sessionOf(payload);
      return session.upstreamAccessToken;
    } catch {
      await this.verifyUpstream(token);
      return token;
    }
  }

  private async verifyLocal(token: string): Promise<JwtClaims> {
    const payload = await this.verifySignature(token);
    this.sessionOf(payload);
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new Error('verified MCP token has no subject');
    }
    return { ...payload, sub: payload.sub };
  }

  private sessionOf(payload: JWTPayload): McpSession {
    const jti = payload.jti;
    const session = typeof jti === 'string' ? this.sessions.get(jti) : undefined;
    if (session === undefined || session.expiresAt <= this.now()) {
      if (typeof jti === 'string') this.sessions.delete(jti);
      throw new Error('MCP OAuth session is missing, expired, or revoked');
    }
    return session;
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
      redirectUris.length > MAX_REDIRECT_URIS ||
      redirectUris.some(
        (value) => typeof value !== 'string' || bytes(value) > MAX_REDIRECT_URI_BYTES,
      ) ||
      !redirectUris.every(isRedirect)
    ) {
      return oauthError('invalid_redirect_uri');
    }
    this.cleanup();
    const source = sourceOf(request);
    const sourceClients = [...this.clients.values()].filter(
      (client) => client.source === source && !client.proven && !client.promotionReserved,
    );
    const provenSourceClients = [...this.clients.values()].filter(
      (client) => client.source === source && (client.proven || client.promotionReserved),
    );
    if (
      this.clients.size >= this.clientLimit ||
      sourceClients.length >= this.clientSourceLimit ||
      provenSourceClients.length >= this.provenClientSourceLimit
    ) {
      return oauthError('temporarily_unavailable', undefined, 429);
    }
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.clientTtlMs;
    const clientId = this.random();
    this.clients.set(clientId, {
      proven: false,
      promotionReserved: false,
      redirectUris,
      source,
      expiresAt,
      unprovenExpiresAt: issuedAt + this.clientTtlMs * 2,
    });
    return Response.json(
      {
        client_id: clientId,
        client_id_expires_at: Math.floor(expiresAt / 1000),
        client_id_issued_at: Math.floor(issuedAt / 1000),
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
    this.cleanup();
    const client = this.clients.get(clientId);
    const scope = params.get('scope') ?? 'wbs:read';
    const scopes = scope.split(' ').filter(Boolean);
    const state = params.get('state');
    if (
      bytes(url.search) > MAX_AUTHORIZATION_QUERY_BYTES ||
      params.getAll('scope').length > 1 ||
      params.getAll('state').length > 1 ||
      (state !== null && bytes(state) > MAX_STATE_BYTES) ||
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
      scopes.length === 0 ||
      scopes.some((value) => !SCOPES.has(value)) ||
      !client?.redirectUris.includes(redirectUri)
    ) {
      return oauthError('invalid_request');
    }

    if (!client.proven && this.now() + TTL_MS * 2 > client.unprovenExpiresAt) {
      return oauthError('temporarily_unavailable', undefined, 429);
    }

    const browserBinding = this.random();
    const upstreamState = this.random();
    const nonce = this.random();
    const verifier = this.random();
    const clientTransactions = [...this.transactions.values()].filter(
      (transaction) => transaction.clientId === clientId,
    );
    if (
      this.transactions.size >= this.transactionLimit ||
      clientTransactions.length >= this.transactionLimitPerClient
    ) {
      return oauthError('temporarily_unavailable', undefined, 429);
    }
    const activeFlowExpiry = Math.max(client.expiresAt, this.now() + TTL_MS * 2);
    client.expiresAt = client.proven
      ? activeFlowExpiry
      : Math.min(activeFlowExpiry, client.unprovenExpiresAt);
    this.transactions.set(browserBinding, {
      browserBinding,
      clientId,
      codeChallenge: challenge,
      expiresAt: this.now() + TTL_MS,
      nonce,
      redirectUri,
      scope,
      state: state ?? undefined,
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
    const upstreamClaims = await this.verifyUpstream(tokens.accessToken);
    const identity = oidcIdentityFromClaims(upstreamClaims, {
      groupPrefix: this.groupPrefix,
      groupsClaim: this.groupsClaim,
    });
    const requested = new Set(transaction.scope.split(' ').filter(Boolean));
    const scopes = [...identity.scopes]
      .map((scope) => `wbs:${scope}`)
      .filter((scope) => requested.has(scope));
    if (!scopes.includes('wbs:read')) return oauthError('access_denied', clearCookie());
    this.cleanup();
    if (this.grants.size >= this.grantLimit) {
      return oauthError('temporarily_unavailable', clearCookie(), 429);
    }
    const code = this.random();
    this.grants.set(code, {
      clientId: transaction.clientId,
      codeChallenge: transaction.codeChallenge,
      expiresAt: this.now() + TTL_MS,
      redirectUri: transaction.redirectUri,
      scope: scopes.join(' '),
      scopes,
      subject: identity.subject,
      upstreamAccessToken: tokens.accessToken,
    });
    const target = new URL(transaction.redirectUri);
    target.searchParams.set('code', code);
    if (transaction.state !== undefined) target.searchParams.set('state', transaction.state);
    return redirect(target.href, clearCookie());
  }

  private async token(request: Request): Promise<Response> {
    const form = await request.formData();
    const code = stringField(form, 'code');
    this.cleanup();
    const grant = code === undefined ? undefined : this.grants.get(code);
    const client = grant === undefined ? undefined : this.clients.get(grant.clientId);
    const verifier = stringField(form, 'code_verifier');
    if (
      code === undefined ||
      grant === undefined ||
      client === undefined ||
      grant.expiresAt <= this.now() ||
      form.get('grant_type') !== 'authorization_code' ||
      stringField(form, 'client_id') !== grant.clientId ||
      stringField(form, 'redirect_uri') !== grant.redirectUri ||
      verifier === undefined ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      challengeOf(verifier) !== grant.codeChallenge
    ) {
      if (code !== undefined) this.grants.delete(code);
      return oauthError('invalid_grant');
    }

    if (this.sessions.size >= this.sessionLimit) {
      return oauthError('temporarily_unavailable', undefined, 429);
    }

    let reservedPromotion = false;
    if (!client.proven) {
      const provenSourceClients = [...this.clients.values()].filter(
        (candidate) =>
          candidate.source === client.source && (candidate.proven || candidate.promotionReserved),
      );
      if (client.promotionReserved || provenSourceClients.length >= this.provenClientSourceLimit) {
        return oauthError('temporarily_unavailable', undefined, 429);
      }
      client.promotionReserved = true;
      reservedPromotion = true;
    }

    const jti = this.random();
    const expiresAt = this.now() + TTL_MS;
    this.grants.delete(code);
    this.sessions.set(jti, {
      expiresAt,
      upstreamAccessToken: grant.upstreamAccessToken,
    });
    let token: string;
    try {
      token = await new SignJWT({
        [this.groupsClaim]: grant.scopes.map((scope) => `${this.groupPrefix}:${scope}`),
        scope: grant.scope,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'mcp-01-ephemeral', typ: 'JWT' })
        .setIssuer(this.issuer)
        .setAudience(this.audience)
        .setSubject(grant.subject)
        .setJti(jti)
        .setIssuedAt(Math.floor(this.now() / 1000))
        .setExpirationTime(Math.floor(expiresAt / 1000))
        .sign(this.privateKey);
    } catch (error) {
      this.sessions.delete(jti);
      this.grants.set(code, grant);
      if (reservedPromotion) client.promotionReserved = false;
      throw error;
    }
    client.proven = true;
    client.promotionReserved = false;
    client.expiresAt = this.now() + this.activeClientTtlMs;
    return Response.json({
      access_token: token,
      expires_in: TTL_MS / 1000,
      scope: grant.scope,
      token_type: 'Bearer',
    });
  }

  private async revoke(request: Request): Promise<Response> {
    const token = stringField(await request.formData(), 'token');
    if (token !== undefined) {
      try {
        const payload = await this.verifySignature(token);
        if (payload.jti !== undefined) this.sessions.delete(payload.jti);
      } catch {
        // RFC 7009 does not reveal whether the presented token was valid.
      }
    }
    return new Response(null, { status: 200 });
  }

  private async verifySignature(token: string): Promise<JWTPayload> {
    const result = await jwtVerify(token, this.publicKey, {
      algorithms: ['RS256'],
      audience: this.audience,
      currentDate: new Date(this.now()),
      issuer: this.issuer,
    });
    return result.payload;
  }

  private publicJwk(): JsonWebKey & { alg: string; kid: string; use: string } {
    return {
      ...(this.publicKey.export({ format: 'jwk' }) as JsonWebKey),
      alg: 'RS256',
      kid: 'mcp-01-ephemeral',
      use: 'sig',
    };
  }

  private cleanup(): void {
    const now = this.now();
    for (const [binding, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(binding);
    }
    for (const [clientId, client] of this.clients) {
      if (client.expiresAt <= now) this.clients.delete(clientId);
    }
    for (const [code, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(code);
    }
    for (const [jti, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(jti);
    }
  }
}

export function mcpOAuthFromEnv(
  config: Pick<McpConfig, 'MCP_PUBLIC_URL'>,
  env: Readonly<Record<string, string | undefined>>,
): InMemoryMcpOAuth {
  let client: BrowserOidcClient | undefined;
  const get = () => (client ??= browserOidcClientFromEnv(env));
  let upstreamVerifier: TokenVerifier | undefined;
  const verifyUpstream = (token: string) =>
    (upstreamVerifier ??= oidcTokenVerifierFromEnv(env)).verify(token);
  return new InMemoryMcpOAuth(
    config,
    {
      authorizationUrl: (input) => get().authorizationUrl(input),
      exchange: (request, checks) => get().exchange(request, checks),
    },
    {
      groupsClaim: env['AUTH_GROUPS_CLAIM'] ?? 'wbs_groups',
      groupPrefix: env['NODE_ENV'] === 'production' ? 'prod' : 'dev',
      verifyUpstream,
    },
  );
}

function stringField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
    const isClaudeConnector =
      url.protocol === 'https:' &&
      url.port === '' &&
      (url.hostname === 'claude.ai' || url.hostname === 'claude.com') &&
      url.pathname === '/api/mcp/auth_callback' &&
      url.search === '';
    const isLoopback =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    return isClaudeConnector || isLoopback;
  } catch {
    return false;
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sourceOf(request: Request): string {
  const source = request.headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim();
  return source === undefined || source === '' ? 'unknown' : source;
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

function oauthError(error: string, setCookie?: string, status = 400): Response {
  return Response.json(
    { error },
    { headers: setCookie === undefined ? undefined : { 'set-cookie': setCookie }, status },
  );
}
