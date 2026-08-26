import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const CANDIDATE = join(import.meta.dir, '../../../deploy/compose/site-dev.caddy.candidate');
const source = existsSync(CANDIDATE) ? readFileSync(CANDIDATE, 'utf8') : '';
const MCP_ROUTES = [
  '/mcp*',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server/mcp/oauth',
];

function mcpRouteBlocks(candidate: string): string[] {
  return [...candidate.matchAll(/^\s*handle\s+(\S+)\s*\{/gm)]
    .map((match) => match[1])
    .filter((route) => route === '/mcp*' || route.startsWith('/.well-known/'));
}

function hasUnsafeMcpMatcher(candidate: string): boolean {
  return (
    /^\s*handle_path\s+\/mcp/m.test(candidate) ||
    /^\s*handle(?:_path)?\s+\/\.well-known\/\*/m.test(candidate)
  );
}

function preservesExistingDevSurface(candidate: string): boolean {
  return (
    /handle\s+\/ws\*\s*\{[\s\S]*?reverse_proxy\s+wbs-dev-src:3200/.test(candidate) &&
    /stream_close_delay\s+310s/.test(candidate) &&
    /handle\s+\/api\/\*\s*\{[\s\S]*?reverse_proxy\s+wbs-dev-src:3100/.test(candidate) &&
    /handle\s*\{\s*reverse_proxy\s+wbs-dev-src:4200/.test(candidate) &&
    /^\s*import\s+access-log\s*$/m.test(candidate)
  );
}

describe('dev MCP Caddy candidate', () => {
  it('routes the MCP resource plus exactly the three RFC discovery paths', () => {
    expect(mcpRouteBlocks(source)).toEqual(MCP_ROUTES);
    for (const route of MCP_ROUTES) {
      if (route === '/mcp*') continue;
      const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(source).toMatch(
        new RegExp(`handle\\s+${escaped}\\s*\\{\\s*reverse_proxy\\s+wbs-dev-src:3300`),
      );
    }
    expect(source).toMatch(
      /handle\s+\/mcp\*\s*\{[\s\S]*?request_body\s*\{\s*max_size\s+64KB\s*\}[\s\S]*?reverse_proxy\s+wbs-dev-src:3300/,
    );
  });

  it('rejects path stripping and blanket well-known ownership', () => {
    expect(hasUnsafeMcpMatcher(source)).toBeFalse();
    expect(hasUnsafeMcpMatcher(source.replace('handle /mcp*', 'handle_path /mcp*'))).toBeTrue();
    expect(
      hasUnsafeMcpMatcher(
        source.replace('handle /.well-known/oauth-protected-resource', 'handle /.well-known/*'),
      ),
    ).toBeTrue();
  });

  // Proof: trusting a caller-supplied first X-Forwarded-For hop lets one
  // source evade both OAuth registration partitions by inventing source IPs.
  it('overwrites the MCP forwarding source at the public edge', () => {
    expect(source).toMatch(
      /handle\s+\/mcp\*\s*\{[\s\S]*?reverse_proxy\s+wbs-dev-src:3300\s*\{[\s\S]*?header_up\s+X-Forwarded-For\s+\{remote_host\}/,
    );
  });

  // Proof: replacing any existing upstream while adding MCP would cut off the
  // app, API, WebSocket drain contract, or redacted access log during public
  // exposure.
  it('preserves the existing app, API, WebSocket, and redacted-logging surface', () => {
    expect(preservesExistingDevSurface(source)).toBeTrue();
    for (const fault of [
      source.replace('wbs-dev-src:3200', 'wbs-dev-src:3300'),
      source.replace('stream_close_delay 310s', ''),
      source.replace('wbs-dev-src:3100', 'wbs-dev-src:3300'),
      source.replace('wbs-dev-src:4200', 'wbs-dev-src:3300'),
      // The fault is the one that actually happened: a vhost going back to
      // defining its own log output, which silently bypasses the redaction
      // filter every other vhost shares.
      source.replace('import access-log', 'log {\n\t\toutput file /var/log/caddy/access.log\n\t}'),
    ]) {
      expect(preservesExistingDevSurface(fault)).toBeFalse();
    }
  });
});
