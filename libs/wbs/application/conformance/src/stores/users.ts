import type { User } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

function withoutUsername(user: User | null): Omit<User, 'username'> | null {
  if (user === null) return null;
  const { username: _username, ...account } = user;
  return account;
}

/** The shared account-store cases for local and federated identity semantics. */
export function userRegistrations(open: OpenCase<'users'>): readonly CaseRegistration[] {
  return [
    storeCase('users', 'users.create:unique-name', open, async ({ port, seed }) => {
      const original = {
        id: 'user-created',
        username: 'created-account',
        passwordHash: 'created-hash',
        email: null,
        idpIssuer: null,
        idpSub: null,
        createdAt: 300,
      } satisfies User;
      const expectedOriginal = structuredClone(original);
      const replacement = { ...original, id: 'user-duplicate', createdAt: 301 };

      expect(await port.create(original, { at: 300, by: seed.ownerIds[0] })).toEqual(original);
      const duplicate = await port.create(replacement, { at: 301, by: seed.ownerIds[1] });
      // Proof: `reinjects account uniqueness, read-shape, issuer, and
      // verified-email faults` overwrote the real source's existing account;
      // `duplicate` received `user-duplicate` and the original no longer matched.
      expect({
        duplicate,
        original: await port.findById(expectedOriginal.id),
        replacement: await port.findById(replacement.id),
      }).toEqual({ duplicate: null, original: expectedOriginal, replacement: null });
    }),
    storeCase('users', 'users.find:identity', open, async ({ port, seed }) => {
      const account = {
        id: 'user-find',
        username: 'find-account',
        passwordHash: null,
        email: null,
        idpIssuer: null,
        idpSub: null,
        createdAt: 310,
      } satisfies User;
      await port.create(account, { at: 310, by: seed.ownerIds[0] });

      // Proof: the same source fault removed `passwordHash` from both actual
      // reads; Bun reported both expected `passwordHash: null` fields absent.
      expect({
        byId: await port.findById(account.id),
        byUsername: await port.findByUsername(account.username),
        missingId: await port.findById('user-missing'),
        missingUsername: await port.findByUsername('missing-account'),
      }).toEqual({ byId: account, byUsername: account, missingId: null, missingUsername: null });
    }),
    storeCase('users', 'users.resolveOidcIdentity:issuer-subject', open, async ({ port }) => {
      const identity = {
        issuer: 'https://issuer-a.example',
        subject: 'shared-subject',
        email: 'issuer-a@example.test',
        emailVerified: true,
      };
      const first = await port.resolveOidcIdentity(
        identity,
        { id: 'oidc-primary' },
        {
          at: 320,
          by: 'oidc-primary',
        },
      );
      const repeated = await port.resolveOidcIdentity(
        identity,
        { id: 'oidc-replacement' },
        {
          at: 321,
          by: 'oidc-replacement',
        },
      );
      const otherIssuer = await port.resolveOidcIdentity(
        {
          ...identity,
          issuer: 'https://issuer-b.example',
          email: 'issuer-b@example.test',
        },
        { id: 'oidc-other' },
        { at: 322, by: 'oidc-other' },
      );

      // Proof: keying only by subject made `otherIssuer` receive the complete
      // `oidc-primary` account instead of `oidc-other`; `otherStored` was null.
      expect({
        first: withoutUsername(first),
        repeated: withoutUsername(repeated),
        replacement: await port.findById('oidc-replacement'),
        otherIssuer: withoutUsername(otherIssuer),
        firstStored: withoutUsername(await port.findById('oidc-primary')),
        otherStored: withoutUsername(await port.findById('oidc-other')),
      }).toEqual({
        first: {
          id: 'oidc-primary',
          passwordHash: null,
          email: 'issuer-a@example.test',
          idpIssuer: 'https://issuer-a.example',
          idpSub: 'shared-subject',
          createdAt: 320,
        },
        repeated: {
          id: 'oidc-primary',
          passwordHash: null,
          email: 'issuer-a@example.test',
          idpIssuer: 'https://issuer-a.example',
          idpSub: 'shared-subject',
          createdAt: 320,
        },
        replacement: null,
        otherIssuer: {
          id: 'oidc-other',
          passwordHash: null,
          email: 'issuer-b@example.test',
          idpIssuer: 'https://issuer-b.example',
          idpSub: 'shared-subject',
          createdAt: 322,
        },
        firstStored: {
          id: 'oidc-primary',
          passwordHash: null,
          email: 'issuer-a@example.test',
          idpIssuer: 'https://issuer-a.example',
          idpSub: 'shared-subject',
          createdAt: 320,
        },
        otherStored: {
          id: 'oidc-other',
          passwordHash: null,
          email: 'issuer-b@example.test',
          idpIssuer: 'https://issuer-b.example',
          idpSub: 'shared-subject',
          createdAt: 322,
        },
      });
    }),
    storeCase('users', 'users.resolveOidcIdentity:verified-conflict', open, async ({ port }) => {
      const first = await port.resolveOidcIdentity(
        {
          issuer: 'https://claimed-issuer.example',
          subject: 'claimed-subject',
          email: 'Claimed@Example.test',
          emailVerified: true,
        },
        { id: 'oidc-claimed' },
        { at: 330, by: 'oidc-claimed' },
      );
      const expectedClaimed = {
        id: 'oidc-claimed',
        passwordHash: null,
        email: 'claimed@example.test',
        idpIssuer: 'https://claimed-issuer.example',
        idpSub: 'claimed-subject',
        createdAt: 330,
      } satisfies Omit<User, 'username'>;
      const conflict = await port.resolveOidcIdentity(
        {
          issuer: 'https://conflicting-issuer.example',
          subject: 'conflicting-subject',
          email: 'claimed@example.test',
          emailVerified: true,
        },
        { id: 'oidc-conflict' },
        { at: 331, by: 'oidc-conflict' },
      );

      // Proof: bypassing the verified-email collision made `conflict` and
      // `conflicting` both receive the newly stored `oidc-conflict` account.
      expect({
        firstId: first?.id,
        conflict,
        claimed: withoutUsername(await port.findById('oidc-claimed')),
        conflicting: await port.findById('oidc-conflict'),
      }).toEqual({
        firstId: 'oidc-claimed',
        conflict: null,
        claimed: expectedClaimed,
        conflicting: null,
      });
    }),
  ];
}
