/**
 * What an environment IS, in one table.
 *
 * This module is imported by both sides of the SSH boundary — `swap.js` on the
 * server and `tool-deploy` on the build host — deliberately. The alternative,
 * each side holding its own copy of the paths, is the exact shape of the
 * `REGISTRY` defect documented in `docker.ts`'s `assertDigestPinnedRef`: two
 * defaults free to diverge, with every live deploy accidentally papering over
 * the gap. One table, imported twice.
 *
 * Pure data and one pure function, so both a Bun bundle for the server and a
 * build-host CLI can take it without dragging in anything else.
 */

/** The environments this pipeline knows how to deploy. */
export type EnvName = 'prod' | 'dev';

/**
 * Everything that differs between one environment and another on a single
 * host. This is the whole seam: no other module may read `WBS_ENV`, and no
 * environment-varying path or name may be spelled out anywhere else.
 */
export interface EnvLayout {
  readonly env: EnvName;
  readonly root: string;
  readonly network: string;
  /** Prepended to every container name. Empty for prod, so prod names are unchanged. */
  readonly containerPrefix: string;
  readonly sharedEnvPath: string;
  /** Shared OIDC provider settings for app tiers, or null when this environment has none. */
  readonly oidcEnvPath: string | null;
  readonly stateDir: string;
  readonly siteCaddyPath: string;
  /** The public address Caddy serves this environment at. */
  readonly siteAddress: string;
}

// Roots live under puni1's home, not /srv: `/srv` is root-owned, so every new
// environment would need an interactive sudo on a box with no passwordless
// sudo. `/home/puni1` is owned by the deploy user, so provisioning a new
// environment needs no privilege at all. The trade — service data outside the
// FHS location for it — was made deliberately; see docs/adr/0002.
//
// deploy/compose/base.yml pins `networks.wbs-net.name: wbs-net`, so the prod
// network is literally `wbs-net` — verified live with `ssh h2puni 'docker
// network ls'` (Task 6's plan draft used `wbs_wbs-net`, which is wrong). dev's
// network is separate and not optional: `BE_ALIAS` in docker.ts is a
// network-global alias, so two environments sharing a network would let gw in
// one environment resolve be in the other.
const LAYOUTS: Readonly<Record<EnvName, EnvLayout>> = {
  prod: {
    env: 'prod',
    root: '/home/puni1/wbs',
    network: 'wbs-net',
    containerPrefix: '',
    sharedEnvPath: '/home/puni1/wbs/.env',
    oidcEnvPath: null,
    stateDir: '/home/puni1/wbs/state',
    siteCaddyPath: '/home/puni1/wbs/caddy/site.caddy',
    siteAddress: 'wbs.bulletpoints.club',
  },
  dev: {
    env: 'dev',
    root: '/home/puni1/wbs-dev',
    network: 'wbs-dev-net',
    containerPrefix: 'dev-',
    sharedEnvPath: '/home/puni1/wbs-dev/.env',
    oidcEnvPath: '/home/puni1/wbs-dev/oidc-dev.env',
    stateDir: '/home/puni1/wbs-dev/state',
    // Not under dev's own root, deliberately: prod's caddy directory is the
    // single one the one edge container mounts (deploy/compose/base.yml), so a
    // site file anywhere else is a file Caddy cannot read.
    siteCaddyPath: '/home/puni1/wbs/caddy/site-dev.caddy',
    siteAddress: 'dev.wbs.bulletpoints.club',
  },
};

/**
 * Resolves an environment name to its layout. Unset or empty means `prod`, so
 * every invocation that predates `WBS_ENV` keeps its exact behaviour.
 *
 * Throws on anything else (R5). Falling back to prod here would mean a typo in
 * a unit file deploys a dev commit onto the live site, and inventing a root
 * from the string would silently create a third environment nobody
 * provisioned. `hasOwnProperty` rather than a bare index so that `constructor`
 * and friends cannot resolve to something off Object's prototype.
 */
export function envLayout(env: string | undefined): EnvLayout {
  const name = env === undefined || env === '' ? 'prod' : env;
  if (!Object.prototype.hasOwnProperty.call(LAYOUTS, name)) {
    throw new Error(
      `unknown WBS_ENV "${name}" — known environments are ${Object.keys(LAYOUTS).join(', ')}. ` +
        'Refusing to guess: an unrecognised environment must not fall back to prod.',
    );
  }
  return LAYOUTS[name as EnvName];
}

/**
 * The one edge container, addressed by name rather than by Compose service.
 *
 * It is NOT per-environment: a single Caddy terminates TLS for every
 * environment (base.yml's caddy is on both networks). `compose exec caddy`
 * cannot reach it from dev, because dev's base.yml declares no caddy service —
 * dev does not own the edge. Resolving it through dev's Compose project fails
 * with `service "caddy" is not running`, which is how the first dev deploy
 * aborted: correctly, at the design-decision-6 guard, rather than swapping
 * against a routing state it could not read.
 *
 * The name is Compose's own (`<project>-<service>-<index>`) for prod's `wbs`
 * project, verified live on h2puni.
 */
export const EDGE_CONTAINER = 'wbs-caddy-1';

/** Every environment name, for CLI validation and error messages. */
export const ENV_NAMES: readonly EnvName[] = Object.keys(LAYOUTS) as EnvName[];

/**
 * The layout this process is running as. THE one read of `WBS_ENV` in this
 * repo — see `envLayout`'s contract. Resolved at import so a bad value fails
 * before any command is built rather than part-way through a swap.
 */
export const CURRENT_ENV: EnvLayout = envLayout(process.env['WBS_ENV']);
