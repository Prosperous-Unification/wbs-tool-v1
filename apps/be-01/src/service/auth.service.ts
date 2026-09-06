import {
  type OidcIdentity,
  oidcIdentityFromClaims,
  type OidcIdentityOptions,
  type TokenVerifier,
  type WbsScope,
} from '@wbs/auth';
import { errors, type JWTPayload, jwtVerify, SignJWT } from 'jose';

import type { OidcIdentityStore, User, UserStore } from '../repository';
import { type Clock, clockOf } from './clock';

export const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface SignedIn {
  token: string;
  user: { id: string; username: string };
}

export type RegisterOutcome =
  | { ok: true; value: SignedIn }
  | { ok: false; reason: 'taken' | 'invalid' };

export type LoginOutcome = { ok: true; value: SignedIn } | { ok: false; reason: 'invalid' };

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
  /** The instant every write is dated from and the ids it mints — see {@link Clock}. */
  clock?: Clock;
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

/**
 * Registration and sign-in.
 *
 * The only service whose acts create the account they are the act **of**: both
 * `register` and the first OIDC login pass the id they are about to mint as the
 * stamp's actor, so the account is its own author. Every other service is
 * handed an actor by its controller.
 */
export class AuthService {
  private readonly key: Uint8Array;
  private readonly clock: Clock;
  private readonly verifyPassword: (password: string, hash: string) => Promise<boolean>;

  constructor(private readonly opts: AuthServiceOptions) {
    this.key = new TextEncoder().encode(opts.jwtKey);
    this.clock = opts.clock ?? clockOf();
    this.verifyPassword =
      opts.verifyPassword ?? ((password, hash) => Bun.password.verify(password, hash));
  }

  async register(username: string, password: string): Promise<RegisterOutcome> {
    if (!USERNAME.test(username) || password.length < MIN_PASSWORD) {
      return { ok: false, reason: 'invalid' };
    }
    if (password.length > MAX_PASSWORD) return { ok: false, reason: 'invalid' };
    const passwordHash = await Bun.password.hash(password);
    // The act begins here, after every refusal and after the hash: argon2id
    // takes long enough that a stamp taken before it would date the row from
    // when the request arrived rather than from when the row was made.
    const id = this.clock.newId();
    const stamp = this.clock.stampFor(id);
    const user: User = { id, username, passwordHash, createdAt: stamp.at };
    const created = await this.opts.users.create(user, stamp);
    if (created === null) return { ok: false, reason: 'taken' };
    return { ok: true, value: await this.issue(created) };
  }

  /** Invalid credentials return a refusal; unexpected store/verifier failures propagate. */
  async login(username: string, password: string): Promise<LoginOutcome> {
    const user = await this.opts.users.findByUsername(username);
    const passwordHash = user?.passwordHash ?? null;
    const hasUsableCredential = passwordHash !== null && password.length <= MAX_PASSWORD;
    const hash = hasUsableCredential ? passwordHash : DUMMY_HASH;
    // Proof: restoring catch(() => false) makes "releases capacity after error" answer 401, not 500.
    const matches = await this.verifyPassword(password.slice(0, MAX_PASSWORD), hash);
    if (!matches || user === null || passwordHash === null || password.length > MAX_PASSWORD) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, value: await this.issue(user) };
  }

  /**
   * Verifies credentials, then resolves their account outside the credential catch.
   * Unexpected verifier and account-store failures propagate to the server boundary.
   *
   * Proof: restoring the broad catches makes the mounted password lookup and OIDC
   * resolution failure tests receive 401 instead of the expected 500 (R3).
   */
  async authenticate(token: string | null): Promise<AuthenticatedUser | null> {
    if (this.opts.localIdentity !== undefined) return this.opts.localIdentity;
    if (token === null) return null;
    if (this.opts.oidc !== undefined) {
      let identity: OidcIdentity | undefined;
      try {
        identity = oidcIdentityFromClaims(
          await this.opts.oidc.verifier.verify(token),
          this.opts.oidc,
        );
      } catch (cause) {
        // Proof: removing this rethrow makes the mounted unexpected-verifier
        // regression receive 401 rather than 500. The real boot outage cases also
        // receive 401 (password login off) and 200 (on), rather than 500.
        if (!isInvalidCredential(cause)) throw cause;
        if (this.opts.passwordSessions !== true) return null;
      }
      if (identity !== undefined) {
        const user = await this.resolveOidcIdentity(identity);
        if (user === null) return null;
        return { id: user.id, username: user.username, scopes: identity.scopes };
      }
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.key));
    } catch (cause) {
      if (!isInvalidCredential(cause)) throw cause;
      return null;
    }
    const sub = payload.sub;
    if (typeof sub !== 'string') return null;
    const user = await this.opts.users.findById(sub);
    // A valid signature cannot keep a deleted account authenticated.
    if (user === null) return null;
    return { id: user.id, username: user.username, scopes: ['read', 'write', 'editor'] };
  }

  /**
   * The account behind one verified OIDC token, minting it on a first login.
   *
   * The stamp is built for the id this login *would* mint, because that is the
   * only actor the act can name: on the branch that writes a new row the row is
   * its own author, and on the branch that links an existing password account
   * the store deliberately moves only `updatedAt` — see
   * {@link OidcIdentityStore.resolveOidcIdentity}. Most calls here resolve an
   * account that already exists and write nothing at all, so the id and the
   * stamp are both spent only on the branch that does write.
   */
  async resolveOidcIdentity(identity: OidcIdentity): Promise<User | null> {
    if (this.opts.identities === undefined) {
      throw new Error('OIDC identity store is not configured');
    }
    const id = this.clock.newId();
    const stamp = this.clock.stampFor(id);
    return this.opts.identities.resolveOidcIdentity(identity, { id }, stamp);
  }

  private async issue(user: User): Promise<SignedIn> {
    const issuedAt = Math.floor(this.clock.now() / 1000);
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

/** Credential failures only; malformed JWKS, discovery and network faults propagate. */
function isInvalidCredential(cause: unknown): boolean {
  return (
    cause instanceof errors.JWTClaimValidationFailed ||
    cause instanceof errors.JWTExpired ||
    cause instanceof errors.JWTInvalid ||
    cause instanceof errors.JWSInvalid ||
    cause instanceof errors.JWSSignatureVerificationFailed ||
    cause instanceof errors.JOSEAlgNotAllowed ||
    cause instanceof errors.JWKSNoMatchingKey
  );
}
