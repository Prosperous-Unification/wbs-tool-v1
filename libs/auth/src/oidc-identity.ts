export type WbsScope = 'read' | 'write' | 'editor';

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  scopes: readonly WbsScope[];
}

export interface OidcIdentityOptions {
  groupPrefix: string;
  groupsClaim: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCOPES: readonly WbsScope[] = ['read', 'write', 'editor'];

/**
 * Turns already-verified OIDC claims into the one identity shape every WBS
 * transport uses. The environment prefix is part of the match: a dev token
 * carrying a production group (or the reverse) grants nothing by accident.
 */
export function oidcIdentityFromClaims(
  claims: Readonly<Record<string, unknown>>,
  options: OidcIdentityOptions,
): OidcIdentity {
  const issuer = claims['iss'];
  const subject = claims['sub'];
  if (typeof issuer !== 'string' || typeof subject !== 'string') {
    throw new Error('OIDC claims require string iss and sub');
  }

  const rawEmail = claims['email'];
  const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : null;
  const groups = claims[options.groupsClaim];
  const granted = new Set<WbsScope>();
  if (Array.isArray(groups)) {
    for (const scope of SCOPES) {
      if (groups.includes(`${options.groupPrefix}:wbs:${scope}`)) granted.add(scope);
    }
  }

  return {
    issuer,
    subject,
    email,
    emailVerified: claims['email_verified'] === true,
    scopes: SCOPES.filter((scope) => granted.has(scope)),
  };
}

export function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return EMAIL.test(normalized) ? normalized : null;
}
