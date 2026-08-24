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
});
