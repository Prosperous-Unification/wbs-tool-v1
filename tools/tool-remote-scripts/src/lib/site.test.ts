import { renderTemplate, siteCaddyTmpl } from '@wbs/tool-compose';
import { describe, expect, it } from 'bun:test';

import { routedColorFor, routedColorFromAdminConfig, siteContext } from './site';

describe('routedColorFor', () => {
  const rendered = [
    'wbs.bulletpoints.club {',
    '  reverse_proxy gw-01-blue:3200',
    '  reverse_proxy be-01-green:3100',
    '  reverse_proxy fe-01-green:80',
    '}',
  ].join('\n');

  it('reads the colour a tier is actually routed to out of a rendered site.caddy', () => {
    expect(routedColorFor('be', rendered)).toBe('green');
    expect(routedColorFor('gw', rendered)).toBe('blue');
    expect(routedColorFor('fe', rendered)).toBe('green');
  });

  it('returns null when the file is empty or the tier is not mentioned', () => {
    expect(routedColorFor('be', '')).toBeNull();
    expect(routedColorFor('be', 'reverse_proxy gw-01-blue:3200')).toBeNull();
  });

  it('never matches another tier by substring', () => {
    // "gw-01-green" must not make routedColorFor('be', ...) match.
    expect(routedColorFor('be', 'reverse_proxy gw-01-green:3200')).toBeNull();
  });
});

describe('siteContext', () => {
  it('builds the exact placeholder set site.caddy.tmpl requires', () => {
    const ctx = siteContext({ be: 'green', gw: 'blue', fe: 'green' }, 'wbs.bulletpoints.club');
    expect(ctx['SITE_ADDRESS']).toBe('wbs.bulletpoints.club');
    expect(ctx['BE_ROUTE']).toBe('reverse_proxy be-01-green:3100');
    expect(ctx['GW_ROUTE']).toContain('reverse_proxy gw-01-blue:3200 {');
    expect(ctx['GW_ROUTE']).toContain('stream_close_delay 310s');
    expect(ctx['FE_ROUTE']).toBe('reverse_proxy fe-01-green:80');
  });

  // Bug found in the Task 12 rehearsal: a tier with no observed colour used
  // to default to 'blue', which got written into site.caddy as if it were
  // real routing state, then read back as ground truth by the NEXT tier's
  // own first deploy — turning a fresh deploy into a bogus "swap" that
  // failed at stop-blue against a container that never existed. `null`
  // must render as an honest "not deployed" response, never a guessed colour.
  it('renders a never-deployed tier (null colour) as an honest 503, not a guessed colour', () => {
    const ctx = siteContext({ be: null, gw: 'blue', fe: null }, 'wbs.bulletpoints.club');
    expect(ctx['BE_ROUTE']).toBe('respond "be-01 not yet deployed" 503');
    expect(ctx['FE_ROUTE']).toBe('respond "fe-01 not yet deployed" 503');
    expect(ctx['BE_ROUTE']).not.toContain('blue');
    expect(ctx['BE_ROUTE']).not.toContain('green');
    // routedColorFor must read this back as null, not as some colour —
    // this is the actual property the bug broke.
    const rendered = `handle /api/* {\n\t\t${ctx['BE_ROUTE']}\n\t}`;
    expect(routedColorFor('be', rendered)).toBeNull();
  });
});

describe('routedColorFor, against a live Caddy admin dump', () => {
  // The reload check used to be `liveConfig.includes(greenName)`. These are the
  // shapes where that answers yes and the tier is not actually routed there.
  const upstream = (name: string) => `{"dial":"${name}:3100"}`;

  it('reads the upstream, not a mention somewhere else in the dump', () => {
    // A stale reference in another environment's block: the substring check
    // cannot fail while any occurrence of the name survives anywhere.
    const config = `{"prod":${upstream('be-01-blue')},"dev-notes":"migrated off be-01-green"}`;
    expect(config.includes('be-01-green')).toBe(true);
    expect(routedColorFor('be', config)).toBe('blue');
  });

  it('is null when the tier is not routed at all', () => {
    expect(routedColorFor('be', '{"gw":{"dial":"gw-01-green:3200"}}')).toBeNull();
  });

  it('does not confuse one tier for another', () => {
    const config = `{"a":${upstream('gw-01-green')},"b":${upstream('be-01-blue')}}`;
    expect(routedColorFor('be', config)).toBe('blue');
    expect(routedColorFor('gw', config)).toBe('green');
  });
});

describe('routedColorFromAdminConfig', () => {
  // Shaped like the real admin dump: every site on the host in one document,
  // each route matched by host, upstreams as "<container>:<port>".
  const dump = (prodBe: string, devBe: string) =>
    JSON.stringify({
      apps: {
        http: {
          servers: {
            srv0: {
              routes: [
                {
                  match: [{ host: ['dev.wbs.bulletpoints.club'] }],
                  handle: [
                    {
                      handler: 'subroute',
                      routes: [
                        { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: devBe }] }] },
                      ],
                    },
                  ],
                },
                {
                  match: [{ host: ['wbs.bulletpoints.club'] }],
                  handle: [
                    {
                      handler: 'subroute',
                      routes: [
                        { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: prodBe }] }] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    });

  it('reads the route for the requested host, not the whole document', () => {
    // Verified against this host on 2026-08-04: prod was on green while dev's
    // old image-based containers were named dev-be-01-blue, and `\b` treats the
    // hyphen as a boundary — so a text search for `be-01-blue` matched INSIDE
    // the dev container name and reported prod's be as blue. A deploy planned
    // from that reading swaps the wrong way.
    const config = dump('be-01-green:3100', 'dev-be-01-blue:3100');
    expect(/\bbe-01-blue\b/.test('dev-be-01-blue')).toBe(true);
    expect(routedColorFor('be', config)).toBe('blue');
    expect(routedColorFromAdminConfig('be', 'wbs.bulletpoints.club', config)).toBe('green');
  });

  it('is null for a tier with no upstream under that host', () => {
    const config = dump('be-01-green:3100', 'wbs-dev-src:3100');
    expect(routedColorFromAdminConfig('be', 'dev.wbs.bulletpoints.club', config)).toBeNull();
  });

  it('ignores an upstream on another tier port', () => {
    const config = dump('be-01-green:3100', 'wbs-dev-src:3100');
    expect(routedColorFromAdminConfig('gw', 'wbs.bulletpoints.club', config)).toBeNull();
  });

  it('refuses a host routing one tier to both colours at once', () => {
    const config = JSON.stringify({
      apps: {
        http: {
          servers: {
            srv0: {
              routes: [
                {
                  match: [{ host: ['wbs.bulletpoints.club'] }],
                  handle: [
                    {
                      handler: 'reverse_proxy',
                      upstreams: [{ dial: 'be-01-blue:3100' }, { dial: 'be-01-green:3100' }],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    });
    expect(() => routedColorFromAdminConfig('be', 'wbs.bulletpoints.club', config)).toThrow(
      /both colours/,
    );
  });

  it('refuses a config it cannot parse rather than reporting no route', () => {
    expect(() => routedColorFromAdminConfig('be', 'wbs.bulletpoints.club', 'not json')).toThrow(
      /not valid JSON/,
    );
  });
});

// TASK-160. `siteContext` feeds `site.caddy.tmpl`, and the result is what a
// swap writes over /home/puni1/wbs/caddy/site{,-dev}.caddy. Asserting on the
// fully rendered text — not on the template file — is what catches a log block
// arriving from either side of the render.
describe('rendered site.caddy access logging', () => {
  const rendered = renderTemplate(
    siteCaddyTmpl,
    siteContext({ be: 'green', gw: 'blue', fe: null }, 'dev.wbs.bulletpoints.club'),
  );

  it('imports the shared, query-redacting access-log snippet', () => {
    expect(rendered).toContain('import access-log');
  });

  it('carries no access-log output block of its own', () => {
    expect(rendered).not.toContain('output file /var/log/caddy');
  });
});
