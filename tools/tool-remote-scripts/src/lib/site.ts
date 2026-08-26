import { appName, containerName, PORT } from './docker';
import type { Color, Tier } from './state';

const DEV_MCP_ROUTES = `\thandle /mcp* {
\t\trequest_body {
\t\t\tmax_size 64KB
\t\t}
\t\treverse_proxy wbs-dev-src:3300 {
\t\t\theader_up X-Forwarded-For {remote_host}
\t\t}
\t}

\thandle /.well-known/oauth-protected-resource {
\t\treverse_proxy wbs-dev-src:3300
\t}

\thandle /.well-known/oauth-protected-resource/mcp {
\t\treverse_proxy wbs-dev-src:3300
\t}

\thandle /.well-known/oauth-authorization-server/mcp/oauth {
\t\treverse_proxy wbs-dev-src:3300
\t}
`;

/**
 * Pure helpers for the single rendered `site.caddy` — the routing source of
 * truth (design decision 6): a deploy killed between `caddy reload` and the
 * state-file write leaves the file saying one colour while Caddy actually
 * routes to the other, so `observe()` must read the rendered config rather
 * than trust the cache.
 */

/**
 * Which colour of `tier` the rendered site config currently routes to, or
 * `null` if that tier isn't mentioned at all (a fresh/empty file, OR a tier
 * that has never been deployed and so gets `routeBlock`'s honest
 * "not yet deployed" `respond`, which mentions neither colour). Matches on
 * the exact container name as a whole word, so e.g. `gw-01-green` can never
 * be mistaken for `be-01-green`.
 */
export function routedColorFor(tier: Tier, siteCaddyText: string): Color | null {
  const blue = containerName(tier, 'blue');
  const green = containerName(tier, 'green');
  const re = new RegExp(`\\b(${blue}|${green})\\b`);
  const m = re.exec(siteCaddyText);
  if (m?.[1] === undefined) return null;
  return m[1] === green ? 'green' : 'blue';
}

/**
 * The content of one tier's `handle { ... }` block in `site.caddy.tmpl`.
 *
 * `color === null` means "genuinely never deployed" — NOT "assume blue".
 * Guessing a colour here used to be the bug: the very first render for any
 * tier defaulted every OTHER, not-yet-deployed tier to `'blue'` too, and
 * that guess got written into the file as if it were real routing state.
 * The next tier's own first deploy then read that guess back via
 * `routedColorFor` — which has no way to distinguish "genuinely routed to
 * blue" from "defaulted to blue" — and planned a bogus colour *swap*
 * instead of a fresh deploy, failing later at `stop-blue` against a
 * container that never existed.
 *
 * Rendering an honest `respond ... 503` instead keeps that guarantee intact
 * two ways at once: a real client hitting an undeployed route gets a clear,
 * true answer instead of a proxy pointed at a container that was never
 * started; and `routedColorFor` naturally returns `null` for it on the next
 * observe (the block contains neither `<tier>-01-blue` nor `-green`), so
 * the next deploy correctly plans a fresh `from: null` deploy rather than a
 * swap.
 */
function routeBlock(tier: Tier, color: Color | null): string {
  if (color === null) {
    return `respond "${appName(tier)} not yet deployed" 503`;
  }
  const target = `${containerName(tier, color)}:${String(PORT[tier])}`;
  if (tier === 'gw') {
    return [
      `reverse_proxy ${target} {`,
      '\t\t\t# Without this, a config reload severs every live WebSocket',
      '\t\t\t# immediately and the drain loop below has nothing left to drain.',
      '\t\t\tstream_close_delay 310s',
      '\t\t}',
    ].join('\n');
  }
  return `reverse_proxy ${target}`;
}

/** The exact placeholder set `site.caddy.tmpl` requires from `renderTemplate`. */
export function siteContext(
  colors: Record<Tier, Color | null>,
  siteAddress: string,
  mcpExposed = false,
): Record<string, string> {
  return {
    SITE_ADDRESS: siteAddress,
    MCP_ROUTES: mcpExposed ? DEV_MCP_ROUTES : '',
    BE_ROUTE: routeBlock('be', colors.be),
    GW_ROUTE: routeBlock('gw', colors.gw),
    FE_ROUTE: routeBlock('fe', colors.fe),
  };
}

/**
 * The persistent marker is the cutover decision. Missing means the reviewed
 * public surface has not been enabled yet; any other present value is corrupt
 * state and must stop a swap before it rewrites the vhost.
 */
export function mcpExposureEnabled(raw: string | null): boolean {
  if (raw === null) return false;
  if (raw.replace(/\n+$/, '') === 'enabled') return true;
  throw new Error('malformed MCP exposure state — expected exactly "enabled"');
}

/**
 * Which colour Caddy's LIVE admin config actually routes `tier` to for
 * `siteAddress`, by reading the route rather than searching the text.
 *
 * `routedColorFor` above matches a container name anywhere in what it is
 * given. That is right for the rendered `site.caddy`, which contains one
 * environment's blocks and nothing else. It is wrong for the admin API dump:
 * that is every site on the host at once — prod, dev, the registry — plus
 * headers, log config and error bodies. A name occurring somewhere in it is
 * not evidence that this tier's public route points there, and first-match
 * order across a JSON dump is not something to depend on.
 *
 * So: find the route matching this host, collect the reverse_proxy upstreams
 * under it, and read the one on this tier's port. Returns null when the tier
 * has no upstream in that site — a never-deployed tier renders an honest 503
 * with no proxy at all.
 *
 * Throws when the config cannot be parsed, or when one tier's port has
 * upstreams of both colours under the same host: an ambiguous answer here
 * would be read as a successful route change.
 */
export function routedColorFromAdminConfig(
  tier: Tier,
  siteAddress: string,
  rawConfig: string,
): Color | null {
  let config: unknown;
  try {
    config = JSON.parse(rawConfig);
  } catch (e: unknown) {
    throw new Error(
      `Caddy's live admin config is not valid JSON (${e instanceof Error ? e.message : String(e)}), ` +
        'so the colour actually being served cannot be determined',
    );
  }

  const dials = new Set<string>();
  // The admin dump nests routes inside subroutes to arbitrary depth, so the
  // upstreams are collected by walking rather than by a fixed path — a fixed
  // path breaks the first time a directive adds a wrapper.
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj['handler'] === 'reverse_proxy' && Array.isArray(obj['upstreams'])) {
      for (const up of obj['upstreams']) {
        const dial = (up as { dial?: unknown }).dial;
        if (typeof dial === 'string') dials.add(dial);
      }
    }
    for (const value of Object.values(obj)) collect(value);
  };

  const matchesHost = (route: Record<string, unknown>): boolean => {
    const match = route['match'];
    if (!Array.isArray(match)) return false;
    return match.some((m) => {
      const hosts = (m as { host?: unknown }).host;
      return Array.isArray(hosts) && hosts.includes(siteAddress);
    });
  };

  const servers = (config as { apps?: { http?: { servers?: Record<string, unknown> } } }).apps?.http
    ?.servers;
  for (const server of Object.values(servers ?? {})) {
    const routes = (server as { routes?: unknown }).routes;
    if (!Array.isArray(routes)) continue;
    for (const route of routes) {
      if (matchesHost(route as Record<string, unknown>)) collect(route);
    }
  }

  const suffix = `:${String(PORT[tier])}`;
  const found = new Set<Color>();
  for (const dial of dials) {
    if (!dial.endsWith(suffix)) continue;
    const host = dial.slice(0, -suffix.length);
    if (host === containerName(tier, 'blue')) found.add('blue');
    if (host === containerName(tier, 'green')) found.add('green');
  }

  if (found.size > 1) {
    throw new Error(
      `${siteAddress} routes ${tier} to both colours at once — refusing to report ` +
        'either as the live one',
    );
  }
  return [...found][0] ?? null;
}
