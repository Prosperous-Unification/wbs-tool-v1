import { createHash } from 'node:crypto';

import { normalizeEmail, type OidcIdentity } from '@wbs/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnCreateBesidesCreatedAt, auditOnUpdate } from './audit';
import { isUniqueViolation, UNIQUE_INDEXES } from './constraint';
import type { Gate } from './gate';
import type { User, UserStore, WriteStamp } from './index';
import { users } from './schema';

/**
 * SQLite reports a uniqueness violation as a message, not a typed error, so
 * `create` translates it into a `null` return the caller can branch on. The
 * alternative — checking for an existing row first — is a race: two
 * registrations of the same username both see it free.
 */
/**
 * The columns a {@link User} is, named once because seven reads in this file want
 * exactly them.
 *
 * Spelled out rather than left to `select()`, and every read that crosses this
 * class's boundary uses it: the audit columns are **recorded, not published**, so
 * a bare select would hand `updated_at` and `created_by` to every caller of
 * `findById` and into the HTTP payload behind it. It also keeps
 * `resolveOidcIdentity` to one shape — that method returns a stored row on one
 * path and a constructed object on another, and without this the two differed by
 * three fields.
 *
 * The declared return types are what check the list is complete: drop a column
 * and `tsc` refuses the assignment to `User`.
 */
const USER_COLUMNS = {
  id: users.id,
  username: users.username,
  passwordHash: users.passwordHash,
  email: users.email,
  idpIssuer: users.idpIssuer,
  idpSub: users.idpSub,
  createdAt: users.createdAt,
};

export class UserRepository implements UserStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * Makes the fixed local-mode identity a real owner before any project write
   * can use it.
   *
   * Takes its own stamp rather than reading a clock here, which is the rule the
   * whole folder keeps: every instant the repository stores arrived in a
   * {@link WriteStamp}. The account creates itself, so `by` is its own id — the
   * one row in the schema whose author is the row.
   */
  ensureLocalIdentity(identity: Pick<User, 'id' | 'username'>, stamp: WriteStamp): void {
    const byId = this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.id, identity.id))
      .limit(1)
      .all()
      .at(0);
    const byUsername = this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.username, identity.username))
      .limit(1)
      .all()
      .at(0);
    if (byId === undefined && byUsername === undefined) {
      this.db
        .insert(users)
        .values({
          ...identity,
          passwordHash: null,
          email: null,
          idpIssuer: null,
          idpSub: null,
          createdAt: stamp.at,
          ...auditOnCreateBesidesCreatedAt(stamp),
        })
        .run();
      return;
    }
    if (byId?.username !== identity.username || byUsername?.id !== identity.id) {
      throw new Error('local identity conflicts with an existing account');
    }
  }

  async create(user: User, stamp: WriteStamp): Promise<User | null> {
    return await this.gate.enter(async () => {
      try {
        await this.db.insert(users).values({ ...user, ...auditOnCreateBesidesCreatedAt(stamp) });
        return user;
      } catch (err) {
        if (isUniqueViolation(err, UNIQUE_INDEXES.username)) return null;
        throw err;
      }
    });
  }

  async findByUsername(username: string): Promise<User | null> {
    const rows = await this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const rows = await this.db.select(USER_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves one first login under a single SQLite transaction. Subject wins
   * over email, and email can only attach to a password account whose legacy
   * username is that verified address. `null` is an identity collision, not
   * "not found": the caller must stop rather than silently reassign it.
   */
  async resolveOidcIdentity(
    identity: Pick<OidcIdentity, 'issuer' | 'subject' | 'email' | 'emailVerified'>,
    create: { id: string },
    stamp: WriteStamp,
  ): Promise<User | null> {
    return await this.gate.enter(async () => {
      return Promise.resolve(
        this.db.transaction((tx) => {
          const subject = tx
            .select(USER_COLUMNS)
            .from(users)
            .where(and(eq(users.idpIssuer, identity.issuer), eq(users.idpSub, identity.subject)))
            .limit(1)
            .all();
          const subjectAccount = subject.at(0) ?? null;
          if (subjectAccount !== null) return subjectAccount;

          const normalizedEmail = identity.email === null ? null : normalizeEmail(identity.email);
          const trustedEmail = identity.emailVerified ? normalizedEmail : null;
          if (trustedEmail !== null) {
            const emailOwner = tx
              .select(USER_COLUMNS)
              .from(users)
              .where(sql`lower(${users.email}) = ${trustedEmail}`)
              .limit(1)
              .all();
            if ((emailOwner.at(0) ?? null) !== null) return null;

            const legacy = tx
              .select(USER_COLUMNS)
              .from(users)
              .where(sql`lower(${users.username}) = ${trustedEmail}`)
              .limit(1)
              .all();
            const candidate = legacy.at(0) ?? null;
            if (
              candidate?.idpIssuer === null &&
              candidate.idpSub === null &&
              looksLikeEmail(candidate.username)
            ) {
              const linked = tx
                .update(users)
                .set({
                  email: trustedEmail,
                  idpIssuer: identity.issuer,
                  idpSub: identity.subject,
                  // Only the update clock moves: this row's author is whoever
                  // registered the password account, and a first OIDC login
                  // linking to it is not that act. The stamp's `by` names the id
                  // this login would have minted, which is deliberately not
                  // written anywhere here.
                  ...auditOnUpdate(stamp),
                })
                .where(eq(users.id, candidate.id))
                .returning(USER_COLUMNS)
                .all();
              return linked[0] ?? null;
            }
          }

          const username = availableOidcUsername(tx, identity);
          const created: User = {
            id: create.id,
            username,
            passwordHash: null,
            email: trustedEmail,
            idpIssuer: identity.issuer,
            idpSub: identity.subject,
            createdAt: stamp.at,
          };
          tx.insert(users)
            .values({ ...created, ...auditOnCreateBesidesCreatedAt(stamp) })
            .run();
          return created;
        }),
      );
    });
  }
}

type Transaction = Parameters<Parameters<SQLiteBunDatabase['transaction']>[0]>[0];

function availableOidcUsername(
  tx: Transaction,
  identity: Pick<OidcIdentity, 'issuer' | 'subject' | 'email'>,
): string {
  const local = identity.email
    ?.split('@', 1)[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  const base = local !== undefined && local.length >= 3 ? local : 'oidc';
  const digest = createHash('sha256')
    .update(identity.issuer)
    .update('\0')
    .update(identity.subject)
    .digest('hex');
  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? digest.slice(0, 12) : `${digest.slice(0, 9)}-${String(attempt)}`;
    const username = `${base.slice(0, 31 - suffix.length)}-${suffix}`;
    const taken = tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1)
      .all();
    if (taken.length === 0) return username;
  }
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
