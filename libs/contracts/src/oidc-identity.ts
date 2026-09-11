export type WbsScope = 'read' | 'write' | 'editor';

/** Identity established from a verified upstream OIDC credential. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  scopes: readonly WbsScope[];
}
