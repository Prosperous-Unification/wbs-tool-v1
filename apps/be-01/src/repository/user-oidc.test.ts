import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDrizzle } from './db';
import { runMigrations } from './migrate';
import { UserRepository } from './user';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let users: UserRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-user-oidc-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  users = new UserRepository(openDrizzle(path));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const identity = {
  issuer: 'https://issuer.example',
  subject: 'subject-1',
  email: 'DANY@PUNI.SHOW',
  emailVerified: true,
};

describe('UserRepository.resolveOidcIdentity', () => {
  it('returns the issuer-subject account before considering a changed email', async () => {
    await users.create({
      id: 'existing',
      username: 'dany-oidc',
      passwordHash: null,
      email: 'old@puni.show',
      idpIssuer: identity.issuer,
      idpSub: identity.subject,
      createdAt: 1,
    });
    await users.create({
      id: 'legacy',
      username: 'dany@puni.show',
      passwordHash: 'local-hash',
      createdAt: 2,
    });

    const resolved = await users.resolveOidcIdentity(identity, { id: 'new', createdAt: 3 });

    expect(resolved?.id).toBe('existing');
    expect((await users.findById('legacy'))?.idpSub).toBeNull();
  });

  it('links a verified email-shaped legacy username without dropping its password', async () => {
    await users.create({
      id: 'legacy',
      username: 'dany@puni.show',
      passwordHash: 'local-hash',
      createdAt: 1,
    });

    const resolved = await users.resolveOidcIdentity(identity, { id: 'new', createdAt: 2 });

    expect(resolved).toMatchObject({
      id: 'legacy',
      username: 'dany@puni.show',
      passwordHash: 'local-hash',
      email: 'dany@puni.show',
      idpIssuer: identity.issuer,
      idpSub: identity.subject,
    });
  });

  it('does not let an unverified email capture a legacy account', async () => {
    await users.create({
      id: 'legacy',
      username: 'dany@puni.show',
      passwordHash: 'local-hash',
      createdAt: 1,
    });

    const resolved = await users.resolveOidcIdentity(
      { ...identity, emailVerified: false },
      { id: 'new', createdAt: 2 },
    );

    expect(resolved).toMatchObject({ id: 'new', passwordHash: null, email: null });
    expect(resolved?.username).toMatch(/^dany-[a-f0-9]+$/);
    expect((await users.findById('legacy'))?.idpSub).toBeNull();
  });

  it('leaves non-email legacy usernames local and creates a deterministic OIDC username', async () => {
    await users.create({
      id: 'legacy',
      username: 'dany',
      passwordHash: 'local-hash',
      createdAt: 1,
    });

    const first = await users.resolveOidcIdentity(identity, { id: 'new', createdAt: 2 });
    const again = await users.resolveOidcIdentity(identity, { id: 'other', createdAt: 3 });

    expect(first).toMatchObject({ id: 'new', email: 'dany@puni.show', passwordHash: null });
    expect(first?.username).toMatch(/^dany-[a-f0-9]+$/);
    expect(again).toEqual(first);
    expect((await users.findById('legacy'))?.idpSub).toBeNull();
  });

  it('refuses to reassign a verified email already owned by another OIDC identity', async () => {
    await users.create({
      id: 'existing',
      username: 'other-oidc',
      passwordHash: null,
      email: 'dany@puni.show',
      idpIssuer: 'https://other-issuer.example',
      idpSub: 'other-subject',
      createdAt: 1,
    });

    expect(await users.resolveOidcIdentity(identity, { id: 'new', createdAt: 2 })).toBeNull();
    expect(await users.findById('new')).toBeNull();
  });
});
