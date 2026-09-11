import type { OidcIdentity } from '@wbs/contracts';

import type { WriteStamp } from './write-stamp';

export interface User {
  id: string;
  username: string;
  passwordHash: string | null;
  email?: string | null;
  idpIssuer?: string | null;
  idpSub?: string | null;
  createdAt: number;
}

export interface UserStore {
  /** Returns null when the username is already taken. */
  create(user: User, stamp: WriteStamp): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
}

export interface OidcIdentityStore {
  /** Returns null when an existing email belongs to a different federated identity. */
  /**
   * `create` carries the id a first login would mint and **not** its instant:
   * that comes off the stamp, so one act cannot date the account one way and its
   * audit columns another. It used to be `{ id, createdAt }`, which was two
   * sources for one value.
   */
  resolveOidcIdentity(
    identity: Pick<OidcIdentity, 'issuer' | 'subject' | 'email' | 'emailVerified'>,
    create: { id: string },
    stamp: WriteStamp,
  ): Promise<User | null>;
}
