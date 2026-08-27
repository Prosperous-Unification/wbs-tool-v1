import type { Color, Tier } from './state';

/**
 * Pure command builders and output parsers for the Docker/Compose side of a
 * swap. Everything here is a string in, string(s) out — no subprocess, no
 * filesystem. `swap.ts` is the thin IO shell that actually runs these.
 */

// The environment seam lives in ./env so that tool-deploy, on the other side
// of the SSH boundary, can import the same table rather than keeping a second
// copy of these paths. Re-exported here because this module was where callers
// have always found ROOT and NETWORK.
export {
  CURRENT_ENV,
  EDGE_CONTAINER,
  ENV_NAMES,
  type EnvLayout,
  envLayout,
  type EnvName,
} from './env';

import { CURRENT_ENV, type EnvLayout } from './env';

export const NETWORK = CURRENT_ENV.network;

export const ROOT = CURRENT_ENV.root;

export const BE_ALIAS = 'be-01.internal';

const APP: Record<Tier, string> = { be: 'be-01', gw: 'gw-01', fe: 'fe-01' };

const IMAGE_NAME: Record<Tier, string> = {
  be: 'wbs-be-01',
  gw: 'wbs-gw-01',
  fe: 'wbs-fe-01',
};

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function isDigest(v: string): boolean {
  return DIGEST_RE.test(v);
}

/**
 * The container name for a tier's colour in THIS environment. The prefix is
 * empty for prod, so prod names (`be-01-blue`) are exactly what they were
 * before environments existed; dev's are `dev-be-01-blue`. Two environments
 * cannot collide here, which matters because container names are unique per
 * daemon, not per network.
 */
export function containerName(tier: Tier, color: Color, layout: EnvLayout = CURRENT_ENV): string {
  return `${layout.containerPrefix}${APP[tier]}-${color}`;
}

/** The app name a tier is known by (`be-01`), independent of colour. */
export function appName(tier: Tier): string {
  return APP[tier];
}

/**
 * The port each tier's app listens on inside its container. Shared between
 * `swap.ts`'s health-gate (direct container-IP fetch) and `lib/site.ts`'s
 * rendered `reverse_proxy` targets, so the two can never drift apart.
 */
export const PORT: Record<Tier, number> = { be: 3100, gw: 3200, fe: 80 };

/** Where the per-colour compose override for this tier is rendered to. */
export function tierComposeFile(tier: Tier, color: Color): string {
  return `${ROOT}/compose/${containerName(tier, color)}.yml`;
}

const DIGEST_PINNED_REF_RE =
  /^(?<registry>[^/\s]+)\/(?<name>[^@\s]+)@(?<digest>sha256:[0-9a-f]{64})$/;

/**
 * Validates the image ref this swap was handed, and returns it unchanged.
 *
 * This process deliberately does NOT know the registry address. It used to:
 * there was a `REGISTRY` default here and a second one in `tool-dagger`, each
 * rebuilding the ref from its own copy, with `tool-deploy` passing only the
 * bare digest between them and no `ssh` env passthrough to reconcile the two.
 * The addresses were free to diverge, and did — every live swap so far only
 * worked because a human exported `REGISTRY=127.0.0.1:5000` in the shell that
 * ran it. The publish address now travels with the digest as one string
 * (`ReleaseEntry.image`, rendered by `tool-dagger`), so there is exactly one
 * place the address is decided.
 *
 * What is checked here is what a receiver can check without owning the
 * address: that the ref is pinned by digest rather than by a movable tag
 * (design decision 4), and that its image name is the one this tier expects —
 * which catches a mis-wired `--image` handing `be` the gateway's image, the
 * one mistake this indirection newly makes possible.
 */
export function assertDigestPinnedRef(ref: string, tier: Tier): string {
  const m = DIGEST_PINNED_REF_RE.exec(ref);
  if (!m?.groups) {
    throw new Error(
      `--image must be a digest-pinned ref (<registry>/<name>@sha256:<64 hex>), got: ${ref || '(missing)'}`,
    );
  }
  const name = m.groups['name'] ?? '';
  if (name !== IMAGE_NAME[tier]) {
    throw new Error(
      `--image names "${name}" but tier "${tier}" deploys "${IMAGE_NAME[tier]}": ${ref}`,
    );
  }
  return ref;
}

/**
 * Least privilege for the secret material each tier's process actually
 * reads — see the authoritative list in each app's `src/config.ts`, not
 * guessed:
 *
 * - fe-01 (`apps/fe-01`) is a static `caddy:2-alpine` server with no
 *   `config.ts` at all. It needs, and gets, zero secrets.
 * - be-01 (`apps/be-01/src/config.ts`) reads `INTERNAL_AUTH_SECRET` plus the
 *   JWT signing key it uses to mint `/ws` tokens.
 * - gw-01 (`apps/gw-01/src/config.ts`) reads `INTERNAL_AUTH_SECRET` plus the
 *   JWT signing key(s) it verifies `/ws` tokens against.
 *
 * `REGISTRY_PASS` is deliberately absent from every list: it belongs to the
 * host's docker daemon (configure.sh's `docker login`) and the local build
 * client, never an app container. Before this, every tier loaded the whole
 * shared `/srv/wbs/.env` (which does carry it) — a compromise of even the
 * fully-static fe-01 meant push+delete access to an internet-facing
 * registry. See `deriveTierSecrets`.
 */
const SECRET_KEYS: Record<Tier, readonly string[]> = {
  be: ['INTERNAL_AUTH_SECRET', 'JWT_SIGNING_KEY_CURRENT'],
  gw: ['INTERNAL_AUTH_SECRET', 'JWT_SIGNING_KEY_CURRENT', 'JWT_SIGNING_KEY_PREVIOUS'],
  fe: [],
};

/**
 * Whether this tier is allowed any secret keys at all — independent of what
 * `deriveTierSecrets` happens to compute for a given `/srv/wbs/.env` snapshot.
 *
 * Exists so `swap.ts` can decide whether the derived secrets file must be
 * (re)written even when the computed content is `''` (item 3(b)): if every
 * key `SECRET_KEYS[tier]` allows has disappeared from the shared `.env`
 * (typo, accidental deletion, a bad edit), `deriveTierSecrets` correctly
 * returns `''` — but a caller that only writes when the result is non-empty
 * (the previous behaviour) then SKIPS the write, leaving whatever secrets
 * file was on disk from the last successful swap active indefinitely. A
 * secret-bearing tier's derived file must always be replaced to match the
 * current source of truth, even when that means replacing it with nothing.
 */
export function tierHasSecrets(tier: Tier): boolean {
  return SECRET_KEYS[tier].length > 0;
}

/** The single human/`configure.sh`-maintained source of truth this tier's secrets file is derived from. */
export const SHARED_ENV_PATH = `${ROOT}/.env`;

/** Where a tier's derived, filtered secrets file lives. Only referenced by `tierEnvFiles` for a tier with a non-empty `SECRET_KEYS` entry. */
export function tierSecretsFile(tier: Tier, layout: EnvLayout = CURRENT_ENV): string {
  return `${layout.root}/${APP[tier]}.secrets.env`;
}

/**
 * Filters the shared `/srv/wbs/.env` down to only the `KEY=VALUE` lines this
 * tier is allowed to see (`SECRET_KEYS`). Comments and blank lines are
 * dropped; anything that isn't `KEY=...` is ignored rather than carried
 * through blind. Pure and re-run on every `start-green` (see `swap.ts`), so
 * the derived file can never drift from `/srv/wbs/.env` by staying stale —
 * there is no hand-maintained intermediate state to go stale.
 */
export function deriveTierSecrets(tier: Tier, sharedEnvText: string): string {
  const allowed = SECRET_KEYS[tier];
  if (allowed.length === 0) return '';
  const allowedSet = new Set(allowed);
  const kept: string[] = [];
  for (const rawLine of sharedEnvText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (allowedSet.has(line.slice(0, eq))) kept.push(line);
  }
  return kept.length > 0 ? kept.join('\n') + '\n' : '';
}

/**
 * `env_file` paths for a tier's rendered compose service, in the order
 * `docker compose` applies them — LATER files win on a key collision. The
 * tier's own app-config file (`PORT`, `LOG_LEVEL`, ...) goes first and the
 * derived secrets file goes last, deliberately: a same-named key
 * accidentally added to the app-config file must never be able to silently
 * shadow the real secret for just one tier — see
 * `tools/tool-smoke/src/health.ts`'s `checkInternalForward` doc comment for
 * the real, weeks-long incident this ordering guards against. A tier with no
 * `SECRET_KEYS` entry (fe-01) gets no secrets file at all, not an empty one.
 */
export function tierEnvFiles(tier: Tier, layout: EnvLayout = CURRENT_ENV): string[] {
  const files = [`${layout.root}/${APP[tier]}.env`];
  if (layout.oidcEnvPath !== null && (tier === 'be' || tier === 'gw')) {
    files.push(layout.oidcEnvPath);
  }
  if (SECRET_KEYS[tier].length > 0) files.push(tierSecretsFile(tier, layout));
  return files;
}

/**
 * Strict per-tier allowlist for `/srv/wbs/<app>.env` — the FIRST file
 * `envFilesBlock` lists (see `tierEnvFiles`'s ordering comment), and,
 * unlike the derived secrets file, one this process never writes: an
 * operator or a provisioning script (`tools/tool-bootstrap/src/configure.sh`)
 * authors it directly. Nothing before this stopped a disallowed key —
 * most dangerously `REGISTRY_PASS` — from being added straight to that file,
 * which bypasses `SECRET_KEYS`'s scoping entirely: the whole point of
 * deriving `fe-01`/`gw-01`/`be-01` secrets files from an allowlist is moot if
 * a key can just be handed to a tier through its OTHER env_file instead.
 * Matches each tier's real `apps/<app>/src/config.ts` required keys, minus
 * the ones `SECRET_KEYS` already covers (those belong ONLY in the derived
 * file — see `tierEnvFiles`'s doc comment on why the derived file is listed
 * last, so a same-named key here could never win a collision even before
 * this check existed).
 */
const APP_ENV_ALLOWED_KEYS: Record<Tier, readonly string[]> = {
  be: ['PORT', 'LOG_LEVEL', 'GW_URL', 'DB_PATH', 'AUTH_MODE'],
  gw: ['PORT', 'LOG_LEVEL', 'BE_URL', 'AUTH_MODE'],
  fe: [],
};

/** Parses `KEY=VALUE` lines (same shape/skip rules as `deriveTierSecrets`) into just the key names, in file order. */
export function envKeysOf(envText: string): string[] {
  const keys: string[] = [];
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    keys.push(line.slice(0, eq));
  }
  return keys;
}

/**
 * Throws — naming every disallowed key found, never a value — if a tier's
 * `/srv/wbs/<app>.env` carries anything outside `APP_ENV_ALLOWED_KEYS`.
 * `swap.ts` calls this as the first action of every `start-green` step, so a
 * bad file fails the swap loudly before anything else happens, rather than
 * quietly riding along into the container via `env_file` merge.
 */
export function assertTierEnvAllowed(tier: Tier, envText: string): void {
  const allowed = new Set(APP_ENV_ALLOWED_KEYS[tier]);
  const bad = envKeysOf(envText).filter((k) => !allowed.has(k));
  if (bad.length > 0) {
    const allowedList = APP_ENV_ALLOWED_KEYS[tier];
    throw new Error(
      `${ROOT}/${APP[tier]}.env carries key(s) outside tier "${tier}"'s allowlist: ${bad.join(', ')}. ` +
        `Only ${allowedList.length > 0 ? allowedList.join(', ') : '(no keys — fe-01 needs none)'} ` +
        'may appear in this file — secrets belong in /srv/wbs/.env (and its per-tier derived ' +
        'files), never here.',
    );
  }
}

function envFilesBlock(tier: Tier, layout: EnvLayout = CURRENT_ENV): string {
  const lines = tierEnvFiles(tier, layout).map((f) => `      - ${f}`);
  return `    env_file:\n${lines.join('\n')}\n`;
}

/** Only be-01 (`apps/be-01/src/repository/db.ts`) opens a SQLite file off `/data` — see `tierComposeContext`'s doc comment. */
const DATA_VOLUME_TIERS: ReadonlySet<Tier> = new Set<Tier>(['be']);

function volumesBlock(tier: Tier, layout: EnvLayout = CURRENT_ENV): string {
  if (!DATA_VOLUME_TIERS.has(tier)) return '';
  return `    volumes:\n      - ${layout.root}/data:/data\n`;
}

/**
 * Substitution context for `tier.compose.tmpl`. `{{TIER}}` is deliberately
 * the app name (`be-01`), not the short tier code (`be`): that's what makes
 * the rendered service/container name equal `containerName()`, and what
 * makes the rendered `env_file` paths (`/srv/wbs/be-01.env`, ...) line up
 * with the per-app env file naming deploy.sh already uses.
 *
 * `image` is passed straight through from `release.json` rather than
 * assembled here — see `assertDigestPinnedRef`.
 *
 * `ENV_FILES` and `VOLUMES` are whole rendered blocks (own indentation,
 * trailing newline) rather than bare values, the same pattern
 * `lib/site.ts`'s `routeBlock` uses for `site.caddy.tmpl` — that's what lets
 * a tier that needs no `volumes:` key at all (gw-01, fe-01) omit it
 * entirely, rather than the naive string-replace template having to fake
 * one with an empty list.
 */
export function tierComposeContext(
  tier: Tier,
  color: Color,
  image: string,
  layout: EnvLayout = CURRENT_ENV,
): Record<string, string> {
  return {
    // CONTAINER and NETWORK replaced the template's old {{TIER}}-{{COLOR}} and
    // its hardcoded `wbs-net`. Rendered under dev, that pair produced prod's
    // container name on prod's network — the exact collision the
    // per-environment network exists to prevent, written into the compose
    // file itself.
    CONTAINER: containerName(tier, color, layout),
    NETWORK: layout.network,
    IMAGE: assertDigestPinnedRef(image, tier),
    ENV_FILES: envFilesBlock(tier, layout),
    VOLUMES: volumesBlock(tier, layout),
  };
}

/**
 * Design decision 10: "SSH, registry, or registry auth unavailable at start —
 * abort before anything starts. Nothing changed."
 *
 * `docker manifest inspect` is the cheapest thing that exercises the whole
 * chain the swap depends on — DNS for the registry host, TLS, the credentials
 * in the host daemon's `~/.docker/config.json`, and the existence of this
 * exact digest — without downloading a single layer. Without it, the first
 * sign of a registry problem is `docker compose up --pull always` failing
 * partway through `start-green`, which is precisely the "surfaces mid-swap"
 * behaviour decision 10 exists to forbid.
 */
export function manifestInspectArgs(image: string): string[] {
  return ['manifest', 'inspect', image];
}

/**
 * `docker compose up -d <container>`, merging `base.yml` (network, volumes)
 * with the already-rendered per-colour file so both share one Compose
 * project. The digest lives in that rendered file's `image:` field, not on
 * this command line — `docker compose up` has no CLI flag to override a
 * service's image, so pinning happens at render time (`tierComposeContext`),
 * not here.
 */
export function composeUpArgs(tier: Tier, color: Color): string[] {
  return [
    'compose',
    '-f',
    `${ROOT}/base.yml`,
    '-f',
    tierComposeFile(tier, color),
    'up',
    '-d',
    '--pull',
    'always',
    containerName(tier, color),
  ];
}

/**
 * Extracts which colours of a tier have a running container, from
 * `docker ps --format {{.Names}}` output (one name per line). Matches by
 * exact line equality, never substring, so e.g. a differently-prefixed
 * container never false-positives.
 */
export function psColorsFrom(psOutput: string, tier: Tier): Color[] {
  const names = new Set(
    psOutput
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  return (['blue', 'green'] as const).filter((color) => names.has(containerName(tier, color)));
}

/**
 * gw-01 resolves BE_URL once at startup, so a be swap moves this alias
 * instead of restarting gw.
 *
 * `docker network connect --alias X net container` fails outright once a
 * container already has ANY endpoint on that network — verified live:
 * "Error response from daemon: endpoint with name be-01-blue already
 * exists in network wbs-net". `tier.compose.tmpl` always attaches every
 * colour to `wbs-net` (with its own name as an alias) the instant
 * `docker compose up` creates it, so that precondition is never true — the
 * naive one-shot connect used before this fix could never succeed, on a
 * first deploy or a real swap alike. The only Docker primitive for
 * changing an already-connected endpoint's alias set is disconnect (which
 * drops the endpoint, and every alias on it) then reconnect with the full
 * desired alias set.
 *
 * Split into two phases — `grantAliasCommands` (incoming colour, run
 * BEFORE render-route/reload) and `revokeAliasCommands` (outgoing colour,
 * run AFTER) — rather than one combined step, deliberately: at the point
 * the incoming colour is reconnected, Caddy has not been told about it yet
 * (its own `handle /api/*` route still targets the outgoing colour's own
 * name-alias), so a brief disconnect/reconnect of the incoming colour
 * disturbs nothing live. Doing the outgoing colour's disconnect/reconnect
 * at that same moment would NOT be safe — Caddy is still actively routing
 * real /api/* traffic to it by its own name-alias until reload runs later
 * in the plan, and disconnecting it (even briefly, to strip BE_ALIAS) would
 * make that in-flight traffic fail. Deferring the outgoing colour's cleanup
 * until after `reload` (once Caddy has already switched away from it)
 * removes the CLIENT-FACING half of that risk — the traffic Caddy itself
 * routes by the outgoing colour's own name-alias.
 *
 * It does NOT avoid the window entirely, and an earlier revision of this
 * comment claimed it did. `caddy reload` is graceful for HTTP: a request
 * already in flight when reload runs keeps being served by whatever
 * upstream Caddy had already picked for it, which can still be the outgoing
 * colour for up to however long that one request takes to finish. `be` has
 * no drain step (only `gw` does — see `swap.ts`'s `'drain'` case), so
 * without something between `reload` and `revoke-alias`, the outgoing
 * colour's `network disconnect` can cut a request that reload's own
 * graceful handling was still trying to let finish. `swap.ts` now holds a
 * short bounded settle before `be`'s `revoke-alias` for exactly this reason
 * — see its own comment for the residual window that remains even with the
 * settle (a fixed pause bounds it, it does not close it to zero).
 *
 * Residual property, inherent to Docker's alias model rather than fixable
 * here — and the opposite of what an even earlier revision of this comment
 * used to claim about BE_ALIAS itself (not the settle window above). An earlier
 * revision said BE_ALIAS "briefly resolves to *neither* colour" during the
 * hand-off. That is false. Reproduced on a throwaway user-defined bridge
 * network: Docker's embedded DNS permits two containers to hold the same
 * alias at once and **round-robins between them**. So between
 * `grantAliasCommands(to)` and `revokeAliasCommands(from)` — the whole
 * grant -> render-route -> reload -> (drain) -> revoke window —
 * `be-01.internal` resolves to BOTH colours, both of them running, and gw's
 * forwards are split across two releases at roughly 50/50.
 *
 * There is no blackout, so nothing here needs retry logic (and
 * apps/gw-01/src/service/forward-client.ts has none). What there IS, and what
 * the old comment hid by describing a failure mode that does not exist, is a
 * window where two be-01 releases serve gw concurrently against one shared,
 * already-migrated SQLite database, with no version negotiation between them.
 * Decision 8's "migrations must be backward-compatible with the previous
 * release" is what makes that safe; it is not incidental. See decision 7 of
 * docs/superpowers/specs/2026-08-02-compose-blue-green-deploy-design.md, which
 * records this as a property of every `be` deploy.
 *
 * Either way this touches only gw's internal be-01.internal forward path,
 * never the client-facing Caddy routes: site.caddy addresses be-01 by its own
 * colour-specific name-alias, moved separately via render-route/reload, never
 * by BE_ALIAS.
 */
export function grantAliasCommands(to: Color): string[][] {
  const toName = containerName('be', to);
  return [
    ['network', 'disconnect', NETWORK, toName],
    ['network', 'connect', '--alias', toName, '--alias', BE_ALIAS, NETWORK, toName],
  ];
}

/** Phase 2 — see `grantAliasCommands`. Must run after `reload`. */
export function revokeAliasCommands(from: Color): string[][] {
  const fromName = containerName('be', from);
  return [
    ['network', 'disconnect', NETWORK, fromName],
    ['network', 'connect', '--alias', fromName, NETWORK, fromName],
  ];
}

/**
 * Reads which migrations are already applied, from inside the container that
 * is about to apply more. Run immediately before the migrate step: its output
 * is the only thing that tells an abort how far back to unwind.
 */
export function migrateStatusCommand(container: string): string[] {
  return ['exec', container, 'bun', 'run', 'src/migrate-status-cli.ts'];
}

/**
 * Reverses every migration applied after `baseline`, using the down script
 * shipped alongside each one.
 *
 * `baseline` is passed as `--to=` rather than a count: a count means "undo two
 * migrations" and is right only if the caller and the database agree on what
 * was applied, while a name means "get back to this state" and refuses when
 * they do not. The CLI rejects an empty value for the same reason.
 */
export function migrateDownCommand(container: string, baseline: string): string[] {
  if (baseline === '') {
    throw new Error('migrateDownCommand needs a baseline migration name, or "none"');
  }
  return ['exec', container, 'bun', 'run', 'src/migrate-down-cli.ts', `--to=${baseline}`];
}
