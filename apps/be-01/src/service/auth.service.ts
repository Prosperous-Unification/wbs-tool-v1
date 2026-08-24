import {
  type OidcIdentity,
  oidcIdentityFromClaims,
  type OidcIdentityOptions,
  type TokenVerifier,
  type WbsScope,
} from '@wbs/auth';
import { jwtVerify, SignJWT } from 'jose';

import type { OidcIdentityStore, User, UserStore } from '../repository';

export const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface AuthResult {
  token: string;
  user: { id: string; username: string };
}

export type RegisterOutcome =
  | { ok: true; result: AuthResult }
  | { ok: false; reason: 'taken' | 'invalid' };

export type LoginOutcome = { ok: true; result: AuthResult } | { ok: false; reason: 'invalid' };

export interface AuthServiceOptions {
  users: UserStore;
  identities?: OidcIdentityStore;
  oidc?: OidcIdentityOptions & { verifier: TokenVerifier };
  /** Accept locally issued password sessions after OIDC verification fails. */
  passwordSessions?: boolean;
  /** Fixed cookie-free identity used only by explicit non-production local mode. */
  localIdentity?: AuthenticatedUser;
  /**
   * The same string gw-01 loads as JWT_SIGNING_KEY_CURRENT. Both sides encode
   * it with TextEncoder, so a token signed here verifies there; if the two
   * values diverge the failure is a 401 on the WebSocket only, which reads as
   * a gateway bug rather than a configuration mismatch.
   */
  jwtKey: string;
  now?: () => number;
  newId?: () => string;
  verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  scopes: readonly WbsScope[];
}

/** Usernames are the WebSocket presence identity, so they are constrained here. */
const USERNAME = /^[a-zA-Z0-9_-]{3,32}$/;
const MIN_PASSWORD = 8;
// argon2id hashes whatever it is given; an unbounded password is a cheap way
// to make registration expensive for everyone else.
const MAX_PASSWORD = 200;

export class AuthService {
  private readonly key: Uint8Array;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly verifyPassword: (password: string, hash: string) => Promise<boolean>;

  constructor(private readonly opts: AuthServiceOptions) {
    this.key = new TextEncoder().encode(opts.jwtKey);
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.verifyPassword =
      opts.verifyPassword ?? ((password, hash) => Bun.password.verify(password, hash));
  }

  async register(username: string, password: string): Promise<RegisterOutcome> {
    if (!USERNAME.test(username) || password.length < MIN_PASSWORD) {
      return { ok: false, reason: 'invalid' };
    }
    if (password.length > MAX_PASSWORD) return { ok: false, reason: 'invalid' };
    const user: User = {
      id: this.newId(),
      username,
      passwordHash: await Bun.password.hash(password),
      createdAt: this.now(),
    };
    const created = await this.opts.users.create(user);
    if (created === null) return { ok: false, reason: 'taken' };
    return { ok: true, result: await this.issue(created) };
  }

  async login(username: string, password: string): Promise<LoginOutcome> {
    const user = await this.opts.users.findByUsername(username);
    const passwordHash = user?.passwordHash ?? null;
    const hasUsableCredential = passwordHash !== null && password.length <= MAX_PASSWORD;
    const hash = hasUsableCredential ? passwordHash : DUMMY_HASH;
    const matches = await this.verifyPassword(password.slice(0, MAX_PASSWORD), hash).catch(
      () => false,
    );
    if (!matches || user === null || passwordHash === null || password.length > MAX_PASSWORD) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, result: await this.issue(user) };
  }

  /** Verifies a bearer token and resolves the user it names. */
  async authenticate(token: string | null): Promise<AuthenticatedUser | null> {
    if (this.opts.localIdentity !== undefined) return this.opts.localIdentity;
    if (token === null) return null;
    if (this.opts.oidc !== undefined) {
      try {
        const identity = oidcIdentityFromClaims(
          await this.opts.oidc.verifier.verify(token),
          this.opts.oidc,
        );
        const user = await this.resolveOidcIdentity(identity);
        if (user === null) return null;
        return { id: user.id, username: user.username, scopes: identity.scopes };
      } catch {
        if (this.opts.passwordSessions !== true) return null;
      }
    }

    try {
      const { payload } = await jwtVerify(token, this.key);
      const sub = payload.sub;
      if (typeof sub !== 'string') return null;
      const user = await this.opts.users.findById(sub);
      // A token whose subject has been deleted must not authenticate: the
      // signature is still valid, so only the lookup can reject it.
      if (user === null) return null;
      return { id: user.id, username: user.username, scopes: ['read', 'write', 'editor'] };
    } catch {
      // A browser OIDC access token is RS256 and intentionally cannot pass the
      // legacy HS256 verifier. Fall through only when OIDC is configured.
    }

    return null;
  }

  async resolveOidcIdentity(identity: OidcIdentity): Promise<User | null> {
    if (this.opts.identities === undefined) {
      throw new Error('OIDC identity store is not configured');
    }
    return this.opts.identities.resolveOidcIdentity(identity, {
      id: this.newId(),
      createdAt: this.now(),
    });
  }

  private async issue(user: User): Promise<AuthResult> {
    const issuedAt = Math.floor(this.now() / 1000);
    const token = await new SignJWT({ username: user.username })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + TOKEN_TTL_SECONDS)
      .sign(this.key);
    return { token, user: { id: user.id, username: user.username } };
  }
}

/**
 * A real argon2id digest of a value no one can supply. Unknown users,
 * OIDC-only users, and oversized inputs all take this bounded verifier path.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$0RTS8ZC+9Bfl7Bx4rvGIYYqEs0mfOB5+3H4mPa0BvXk';
