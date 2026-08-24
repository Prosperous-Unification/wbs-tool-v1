import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { type JwtClaims, oidcIdentityFromClaims, type TokenVerifier } from '@wbs/auth';
import { decodeJwt } from 'jose';

import type { McpConfig } from './config';

interface DownstreamTokenResolver {
  upstreamTokenFor(token: string, verified?: JwtClaims): Promise<string>;
}

function resolvesDownstreamToken(
  verifier: TokenVerifier,
): verifier is TokenVerifier & DownstreamTokenResolver {
  return 'upstreamTokenFor' in verifier && typeof verifier.upstreamTokenFor === 'function';
}

/** Authenticates one MCP HTTP request and preserves its caller token for be-01. */
export async function authenticateCaller(
  authorization: string | null,
  mode: McpConfig['MCP_AUTH_MODE'],
  verifier: TokenVerifier,
  groupPrefix: string,
  groupsClaim: string,
): Promise<AuthInfo> {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
  if (match?.[1] === undefined) throw new Error('Authorization: Bearer token is required');
  const token = match[1];
  const claims = mode === 'standalone' ? await verifier.verify(token) : decodeJwt(token);
  const identity = oidcIdentityFromClaims(claims, { groupPrefix, groupsClaim });
  const forwardedToken =
    mode === 'standalone' && resolvesDownstreamToken(verifier)
      ? await verifier.upstreamTokenFor(token, claims as JwtClaims)
      : token;
  return {
    token: forwardedToken,
    clientId: identity.subject,
    scopes: [...identity.scopes],
    extra: { issuer: identity.issuer, subject: identity.subject },
  };
}
