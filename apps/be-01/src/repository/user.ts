import { createHash } from 'node:crypto';

import { normalizeEmail, type OidcIdentity } from '@wbs/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import type { User, UserStore } from './index';
import { users } from './schema';

/**
 * SQLite reports a uniqueness violation as a message, not a typed error, so
 * `create` translates it into a `null` return the caller can branch on. The
 * alternative — checking for an existing row first — is a race: two
 * registrations of the same username both see it free.
 */
export class UserRepository implements UserStore {
  constructor(private readonly db: SQLiteBunDatabase) {}

  /** Makes the fixed local-mode identity a real owner before any project write can use it. */
  ensureLocalIdentity(identity: Pick<User, 'id' | 'username'>): void {
    const byId = this.db.select().from(users).where(eq(users.id, identity.id)).limit(1).all().at(0);
    const byUsername = this.db
      .select()
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
          createdAt: Date.now(),
        })
        .run();
      return;
    }
    if (byId?.username !== identity.username || byUsername?.id !== identity.id) {
      throw new Error('local identity conflicts with an existing account');
    }
  }

  async create(user: User): Promise<User | null> {
    try {
      await this.db.insert(users).values(user);
      return user;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('UNIQUE constraint failed: users.username')
      ) {
        return null;
      }
      throw err;
    }
  }

  async findByUsername(username: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves one first login under a single SQLite transaction. Subject wins
   * over email, and email can only attach to a password account whose legacy
   * username is that verified address. `null` is an identity collision, not
   * "not found": the caller must stop rather than silently reassign it.
   */
  resolveOidcIdentity(
    identity: Pick<OidcIdentity, 'issuer' | 'subject' | 'email' | 'emailVerified'>,
    create: { id: string; createdAt: number },
  ): Promise<User | null> {
    return Promise.resolve(
      this.db.transaction((tx) => {
        const subject = tx
          .select()
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
            .select()
            .from(users)
            .where(sql`lower(${users.email}) = ${trustedEmail}`)
            .limit(1)
            .all();
          if ((emailOwner.at(0) ?? null) !== null) return null;

          const legacy = tx
            .select()
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
              })
              .where(eq(users.id, candidate.id))
              .returning()
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
          createdAt: create.createdAt,
        };
        tx.insert(users).values(created).run();
        return created;
      }),
    );
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
