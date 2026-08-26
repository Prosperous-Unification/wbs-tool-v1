import { describe, expect, it } from 'bun:test';

import {
  assertDigestPinnedRef,
  assertTierEnvAllowed,
  composeUpArgs,
  containerName,
  deriveTierSecrets,
  envKeysOf,
  envLayout,
  grantAliasCommands,
  isDigest,
  manifestInspectArgs,
  migrateDownCommand,
  migrateStatusCommand,
  NETWORK,
  psColorsFrom,
  revokeAliasCommands,
  ROOT,
  SHARED_ENV_PATH,
  tierComposeContext,
  tierComposeFile,
  tierEnvFiles,
  tierHasSecrets,
  tierSecretsFile,
} from './docker';

const DIGEST = 'sha256:' + 'a'.repeat(64);

/**
 * The prod layout is not "whatever envLayout returns for prod" — it is the set
 * of literals that were hardcoded in this module before `WBS_ENV` existed. A
 * deploy to prod must be byte-identical after the parameterisation, so these
 * are written out longhand rather than derived: a test that asks the code what
 * it thinks prod is would pass no matter what the code broke.
 */
describe('envLayout', () => {
  it('defaults to prod when WBS_ENV is unset', () => {
    expect(envLayout(undefined)).toEqual({
      env: 'prod',
      root: '/home/puni1/wbs',
      network: 'wbs-net',
      containerPrefix: '',
      sharedEnvPath: '/home/puni1/wbs/.env',
      stateDir: '/home/puni1/wbs/state',
      siteCaddyPath: '/home/puni1/wbs/caddy/site.caddy',
      siteAddress: 'wbs.bulletpoints.club',
    });
  });

  it('treats an empty WBS_ENV as unset', () => {
    expect(envLayout('')).toEqual(envLayout(undefined));
  });

  it('gives prod the values that were hardcoded before WBS_ENV existed', () => {
    expect(envLayout('prod')).toEqual(envLayout(undefined));
    expect(ROOT).toBe('/home/puni1/wbs');
    expect(NETWORK).toBe('wbs-net');
    expect(SHARED_ENV_PATH).toBe('/home/puni1/wbs/.env');
    expect(containerName('be', 'blue')).toBe('be-01-blue');
  });

  it('gives dev a layout disjoint from prod, except the mounted caddy dir', () => {
    expect(envLayout('dev')).toEqual({
      env: 'dev',
      root: '/home/puni1/wbs-dev',
      network: 'wbs-dev-net',
      containerPrefix: 'dev-',
      sharedEnvPath: '/home/puni1/wbs-dev/.env',
      stateDir: '/home/puni1/wbs-dev/state',
      // Deliberately under prod's root: that caddy directory is the one the
      // single edge container mounts, so dev's site file has to live there.
      siteCaddyPath: '/home/puni1/wbs/caddy/site-dev.caddy',
      siteAddress: 'dev.wbs.bulletpoints.club',
    });
  });

  it('gives the two environments different public addresses', () => {
    expect(envLayout('dev').siteAddress).not.toBe(envLayout('prod').siteAddress);
  });

  it('shares no path or name between the two environments except the caddy dir', () => {
    const prod = envLayout('prod');
    const dev = envLayout('dev');
    expect(dev.root).not.toBe(prod.root);
    expect(dev.network).not.toBe(prod.network);
    expect(dev.sharedEnvPath).not.toBe(prod.sharedEnvPath);
    expect(dev.stateDir).not.toBe(prod.stateDir);
    expect(dev.siteCaddyPath).not.toBe(prod.siteCaddyPath);
  });

  /**
   * R5: unknown is not OK. An unrecognised WBS_ENV must not fall through to
   * prod (which would deploy a dev commit onto the live site) and must not
   * resolve to nothing.
   *
   * Proof: with the `hasOwnProperty` guard and its `throw` deleted from
   * `envLayout`, both tests below fail — `envLayout('staging')` returns
   * `undefined` rather than throwing. Worse, and the reason the guard sits at
   * resolve time rather than at use time: importing the module at all under
   * `WBS_ENV=staging` then dies with `TypeError: undefined is not an object
   * (evaluating 'CURRENT_ENV.network')` at docker.ts:80 — a stack trace with
   * no mention of the environment name that caused it. Both observed, guard
   * removed, on 2026-08-04.
   */
  it('refuses an environment it does not know', () => {
    expect(() => envLayout('staging')).toThrow(/staging/);
  });

  it('refuses an unknown environment by name, not by falling back to prod', () => {
    let layout: unknown = null;
    try {
      layout = envLayout('staging');
    } catch {
      layout = 'threw';
    }
    expect(layout).toBe('threw');
  });
});

describe('isDigest', () => {
  it('accepts a well-formed sha256 digest', () => {
    expect(isDigest('sha256:' + 'a'.repeat(64))).toBe(true);
  });

  it('rejects tags, short hashes, and empty strings', () => {
    expect(isDigest('abc1234')).toBe(false);
    expect(isDigest('sha256:tooshort')).toBe(false);
    expect(isDigest('')).toBe(false);
  });
});

describe('containerName', () => {
  it('names containers <tier>-<color>', () => {
    expect(containerName('be', 'green')).toBe('be-01-green');
    expect(containerName('gw', 'blue')).toBe('gw-01-blue');
    expect(containerName('fe', 'blue')).toBe('fe-01-blue');
  });
});

describe('assertDigestPinnedRef', () => {
  it('passes a well-formed digest-pinned ref straight through, address and all', () => {
    const ref = `registry.infra.bulletpoints.club/wbs-be-01@${DIGEST}`;
    expect(assertDigestPinnedRef(ref, 'be')).toBe(ref);
  });

  it('accepts a registry address carrying a port', () => {
    const ref = `127.0.0.1:5000/wbs-gw-01@${DIGEST}`;
    expect(assertDigestPinnedRef(ref, 'gw')).toBe(ref);
  });

  // Design decision 4: a rebuild on another host can move a tag, never a digest.
  it('rejects a tagged ref rather than deploying something movable', () => {
    expect(() => assertDigestPinnedRef('r.example.com/wbs-be-01:abc1234', 'be')).toThrow(
      /digest-pinned/,
    );
  });

  it('rejects a bare digest with no registry address', () => {
    expect(() => assertDigestPinnedRef(DIGEST, 'be')).toThrow(/digest-pinned/);
  });

  it('rejects a malformed digest', () => {
    expect(() => assertDigestPinnedRef('r.example.com/wbs-be-01@sha256:short', 'be')).toThrow(
      /digest-pinned/,
    );
  });

  it('rejects an empty ref, naming what was missing', () => {
    expect(() => assertDigestPinnedRef('', 'be')).toThrow(/missing/);
  });

  // The one mistake carrying the whole ref across the wire newly makes
  // possible: handing a tier some other tier's image.
  it("rejects another tier's image", () => {
    expect(() => assertDigestPinnedRef(`r.example.com/wbs-gw-01@${DIGEST}`, 'be')).toThrow(
      /tier "be" deploys "wbs-be-01"/,
    );
  });
});

describe('manifestInspectArgs', () => {
  it('checks the registry without downloading layers', () => {
    const ref = `registry.infra.bulletpoints.club/wbs-be-01@${DIGEST}`;
    expect(manifestInspectArgs(ref)).toEqual(['manifest', 'inspect', ref]);
  });
});

describe('tierComposeFile', () => {
  it('places the rendered per-colour compose file under ROOT/compose', () => {
    expect(tierComposeFile('be', 'green')).toBe(`${ROOT}/compose/be-01-green.yml`);
  });
});

describe('tierComposeContext', () => {
  it('uses the app name (be-01), not the short tier code, so the container name and the', () => {
    // existing per-app env file (/srv/wbs/be-01.env, per deploy.sh) line up.
    const ctx = tierComposeContext(
      'be',
      'green',
      `registry.infra.bulletpoints.club/wbs-be-01@${DIGEST}`,
    );
    expect(ctx['CONTAINER']).toBe('be-01-green');
    expect(ctx['NETWORK']).toBe('wbs-net');
  });

  // The C1 regression: this file used to rebuild the ref from its own
  // REGISTRY default, so the address the image was actually published to
  // never reached the pull.
  it('renders the image ref it was given, without reconstructing the address', () => {
    const ref = `some-other-registry.example.com:5000/wbs-fe-01@${DIGEST}`;
    expect(tierComposeContext('fe', 'blue', ref)['IMAGE']).toBe(ref);
  });

  it('refuses a ref that is not digest-pinned', () => {
    expect(() => tierComposeContext('be', 'blue', 'r.example.com/wbs-be-01:abc')).toThrow(
      /digest-pinned/,
    );
  });

  // Finding I7 (secrets over-distribution): fe-01 is a static Caddy server
  // and must get neither a secrets env_file nor a data mount at all — not
  // even an empty one.
  it('gives fe-01 only its own app-config env file, no secrets file and no volumes', () => {
    const ctx = tierComposeContext(
      'fe',
      'blue',
      `registry.infra.bulletpoints.club/wbs-fe-01@${DIGEST}`,
    );
    expect(ctx['ENV_FILES']).toBe(`    env_file:\n      - ${ROOT}/fe-01.env\n`);
    expect(ctx['VOLUMES']).toBe('');
  });

  it('gives gw-01 its app-config file plus its own derived secrets file, no data volume', () => {
    const ctx = tierComposeContext(
      'gw',
      'blue',
      `registry.infra.bulletpoints.club/wbs-gw-01@${DIGEST}`,
    );
    expect(ctx['ENV_FILES']).toBe(
      `    env_file:\n      - ${ROOT}/gw-01.env\n      - ${ROOT}/gw-01.secrets.env\n`,
    );
    expect(ctx['VOLUMES']).toBe('');
  });

  it('gives be-01 its app-config file, its own secrets file, and the data volume', () => {
    const ctx = tierComposeContext(
      'be',
      'blue',
      `registry.infra.bulletpoints.club/wbs-be-01@${DIGEST}`,
    );
    expect(ctx['ENV_FILES']).toBe(
      `    env_file:\n      - ${ROOT}/be-01.env\n      - ${ROOT}/be-01.secrets.env\n`,
    );
    expect(ctx['VOLUMES']).toBe(`    volumes:\n      - ${ROOT}/data:/data\n`);
  });
});

describe('tierSecretsFile', () => {
  it('names the derived secrets file after the app name', () => {
    expect(tierSecretsFile('gw')).toBe(`${ROOT}/gw-01.secrets.env`);
  });
});

describe('tierEnvFiles', () => {
  it('fe-01 gets only its app-config file', () => {
    expect(tierEnvFiles('fe')).toEqual([`${ROOT}/fe-01.env`]);
  });

  it('be-01 and gw-01 get their app-config file then their secrets file, in that order', () => {
    expect(tierEnvFiles('be')).toEqual([`${ROOT}/be-01.env`, `${ROOT}/be-01.secrets.env`]);
    expect(tierEnvFiles('gw')).toEqual([`${ROOT}/gw-01.env`, `${ROOT}/gw-01.secrets.env`]);
  });
});

describe('deriveTierSecrets', () => {
  const SHARED =
    'INTERNAL_AUTH_SECRET=shared-secret-32-characters-long\n' +
    'JWT_SIGNING_KEY_CURRENT=jwt-current-secret-is-at-least-32-chars!\n' +
    'REGISTRY_PASS=super-secret-registry-password\n';

  it('gives be-01 INTERNAL_AUTH_SECRET and the JWT signing key, but never REGISTRY_PASS', () => {
    expect(deriveTierSecrets('be', SHARED)).toBe(
      'INTERNAL_AUTH_SECRET=shared-secret-32-characters-long\n' +
        'JWT_SIGNING_KEY_CURRENT=jwt-current-secret-is-at-least-32-chars!\n',
    );
  });

  it('gives gw-01 INTERNAL_AUTH_SECRET and the JWT signing key, but never REGISTRY_PASS', () => {
    const out = deriveTierSecrets('gw', SHARED);
    expect(out).toContain('INTERNAL_AUTH_SECRET=shared-secret-32-characters-long');
    expect(out).toContain('JWT_SIGNING_KEY_CURRENT=jwt-current-secret-is-at-least-32-chars!');
    expect(out).not.toContain('REGISTRY_PASS');
  });

  // The finding this whole change fixes, stated as a direct assertion: no
  // tier's allowlist can ever produce a file containing REGISTRY_PASS — it
  // belongs to the host docker daemon and the build client only.
  it('never emits REGISTRY_PASS for any tier, including fe-01', () => {
    expect(deriveTierSecrets('be', SHARED)).not.toContain('REGISTRY_PASS');
    expect(deriveTierSecrets('gw', SHARED)).not.toContain('REGISTRY_PASS');
    expect(deriveTierSecrets('fe', SHARED)).not.toContain('REGISTRY_PASS');
  });

  it('fe-01 gets an empty string — no secrets file is written for it at all', () => {
    expect(deriveTierSecrets('fe', SHARED)).toBe('');
  });

  it('ignores comments and blank lines in the shared file', () => {
    const shared = '# a comment\n\nINTERNAL_AUTH_SECRET=x-32-characters-long-enough-ok\n';
    expect(deriveTierSecrets('be', shared)).toBe(
      'INTERNAL_AUTH_SECRET=x-32-characters-long-enough-ok\n',
    );
  });

  it('omits an optional key the shared file does not carry (JWT_SIGNING_KEY_PREVIOUS)', () => {
    expect(deriveTierSecrets('gw', SHARED)).not.toContain('JWT_SIGNING_KEY_PREVIOUS');
  });

  it("constructs a complete BeConfig from app config plus be's derived shared secrets", async () => {
    // This is deliberately a runtime cross-project contract check. A static
    // infra -> app import would make the deploy library depend on an app;
    // the computed specifier keeps that exception inside this test only.
    const beModule: unknown = await import(['../../../..', 'apps/be-01/src/config'].join('/'));
    if (
      typeof beModule !== 'object' ||
      beModule === null ||
      !('BeConfig' in beModule) ||
      typeof beModule.BeConfig !== 'function'
    ) {
      throw new Error('apps/be-01/src/config does not export BeConfig');
    }
    const validateBeConfig = beModule.BeConfig as (env: Record<string, string>) => unknown;
    const derived = Object.fromEntries(
      deriveTierSecrets('be', SHARED)
        .trimEnd()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

    expect(
      validateBeConfig({
        PORT: '3100',
        LOG_LEVEL: 'info',
        GW_URL: 'http://gw-01:3200',
        DB_PATH: '/data/wbs.db',
        AUTH_MODE: 'oidc',
        ...derived,
      }),
    ).not.toHaveProperty('summary');
  });
});

describe('tierHasSecrets', () => {
  it('is true for be and gw, false for fe', () => {
    expect(tierHasSecrets('be')).toBe(true);
    expect(tierHasSecrets('gw')).toBe(true);
    expect(tierHasSecrets('fe')).toBe(false);
  });
});

// Item 3(c): the app-config env file (/srv/wbs/<app>.env) is authored by an
// operator/configure.sh, not derived by this codebase — nothing previously
// stopped a disallowed key (most dangerously REGISTRY_PASS) from being put
// there directly, bypassing SECRET_KEYS's allowlist entirely.
describe('envKeysOf', () => {
  it('extracts key names, ignoring comments and blank lines', () => {
    expect(envKeysOf('# comment\n\nPORT=3100\nLOG_LEVEL=info\n')).toEqual(['PORT', 'LOG_LEVEL']);
  });

  it('returns an empty list for a comment-only file (fe-01.env)', () => {
    expect(envKeysOf('# fe-01 needs no env vars\n')).toEqual([]);
  });
});

describe('assertTierEnvAllowed', () => {
  it('passes be-01.env carrying only its allowed keys', () => {
    expect(() => {
      assertTierEnvAllowed(
        'be',
        'PORT=3100\nLOG_LEVEL=info\nGW_URL=x\nDB_PATH=/data/wbs.db\nAUTH_MODE=oidc\n',
      );
    }).not.toThrow();
  });

  it('passes gw-01.env carrying only its allowed keys', () => {
    expect(() => {
      assertTierEnvAllowed('gw', 'PORT=3200\nLOG_LEVEL=info\nBE_URL=x\nAUTH_MODE=oidc\n');
    }).not.toThrow();
  });

  it('passes a comment-only fe-01.env', () => {
    expect(() => {
      assertTierEnvAllowed('fe', '# fe-01 needs no env vars\n');
    }).not.toThrow();
  });

  // The exact defect item 3(c) fixes: REGISTRY_PASS put directly in a
  // tier's app-config file bypasses SECRET_KEYS entirely.
  it('rejects REGISTRY_PASS in be-01.env, naming the key but never a value', () => {
    let message = '';
    try {
      assertTierEnvAllowed(
        'be',
        'PORT=3100\nLOG_LEVEL=info\nGW_URL=x\nDB_PATH=x\nREGISTRY_PASS=hunter2\n',
      );
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('REGISTRY_PASS');
    expect(message).not.toContain('hunter2');
  });

  it('rejects any key outside the allowlist for fe-01, which allows none', () => {
    expect(() => {
      assertTierEnvAllowed('fe', 'PORT=80\n');
    }).toThrow(/PORT/);
  });

  it('rejects a secret key placed in the app-config file instead of the derived secrets file', () => {
    expect(() => {
      assertTierEnvAllowed(
        'gw',
        'PORT=3200\nLOG_LEVEL=info\nBE_URL=x\nJWT_SIGNING_KEY_CURRENT=x\n',
      );
    }).toThrow(/JWT_SIGNING_KEY_CURRENT/);
  });
});

describe('composeUpArgs', () => {
  it('merges base.yml with the rendered per-colour file and starts only that service', () => {
    const args = composeUpArgs('be', 'green');
    expect(args).toEqual([
      'compose',
      '-f',
      `${ROOT}/base.yml`,
      '-f',
      `${ROOT}/compose/be-01-green.yml`,
      'up',
      '-d',
      '--pull',
      'always',
      'be-01-green',
    ]);
  });
});

describe('psColorsFrom', () => {
  it('extracts running colours from `docker ps` output', () => {
    const out = 'be-01-blue\nbe-01-green\ngw-01-blue\n';
    expect(psColorsFrom(out, 'be')).toEqual(['blue', 'green']);
  });

  it('returns an empty list when the tier has nothing running', () => {
    expect(psColorsFrom('gw-01-blue\n', 'fe')).toEqual([]);
  });

  it('ignores container names that merely contain the target as a substring', () => {
    // e.g. some other tier's or project's container should never false-match.
    expect(psColorsFrom('xbe-01-blue\n', 'be')).toEqual([]);
  });
});

describe('grantAliasCommands', () => {
  it('disconnects the incoming colour then reconnects it with both its own alias and BE_ALIAS', () => {
    const [disconnect, connect] = grantAliasCommands('green');
    expect(disconnect).toEqual(['network', 'disconnect', NETWORK, 'be-01-green']);
    expect(connect).toEqual([
      'network',
      'connect',
      '--alias',
      'be-01-green',
      '--alias',
      'be-01.internal',
      NETWORK,
      'be-01-green',
    ]);
  });

  // Always required, first deploy or not: tier.compose.tmpl attaches every
  // colour to wbs-net at `docker compose up` time, so the container always
  // already has an endpoint here — `network connect` would fail outright
  // without the disconnect first, regardless of deploy history.
  it('disconnects unconditionally even for what would be a first-ever deploy', () => {
    const [disconnect] = grantAliasCommands('blue');
    expect(disconnect).toEqual(['network', 'disconnect', NETWORK, 'be-01-blue']);
  });
});

describe('revokeAliasCommands', () => {
  it('disconnects the outgoing colour then restores only its own alias, dropping BE_ALIAS', () => {
    const [disconnect, connect] = revokeAliasCommands('blue');
    expect(disconnect).toEqual(['network', 'disconnect', NETWORK, 'be-01-blue']);
    expect(connect).toEqual(['network', 'connect', '--alias', 'be-01-blue', NETWORK, 'be-01-blue']);
    expect(connect.join(' ')).not.toContain('be-01.internal');
  });
});

/**
 * The rendered per-tier compose file is where an environment either stays in
 * its own lane or does not. Before this, the template hardcoded `wbs-net` and
 * built the container name from tier+colour alone, so a dev swap would have
 * attached dev's container to PROD's network under prod's container name —
 * the one failure mode the whole separate-network decision exists to prevent.
 */
describe('tierComposeContext across environments', () => {
  const IMG = 'registry.infra.bulletpoints.club/wbs-be-01@sha256:' + 'a'.repeat(64);

  it('names prod’s container and network exactly as before', () => {
    const ctx = tierComposeContext('be', 'green', IMG, envLayout('prod'));
    expect(ctx['CONTAINER']).toBe('be-01-green');
    expect(ctx['NETWORK']).toBe('wbs-net');
  });

  it('gives dev its own container name and network', () => {
    const ctx = tierComposeContext('be', 'green', IMG, envLayout('dev'));
    expect(ctx['CONTAINER']).toBe('dev-be-01-green');
    expect(ctx['NETWORK']).toBe('wbs-dev-net');
  });

  it('never renders prod’s network into a dev compose file', () => {
    const ctx = tierComposeContext('gw', 'blue', IMG.replace('be-01', 'gw-01'), envLayout('dev'));
    expect(ctx['NETWORK']).not.toBe('wbs-net');
    expect(ctx['ENV_FILES']).not.toContain('/home/puni1/wbs/');
  });
});

describe('migration rollback commands', () => {
  it('reads the applied set from the container that is about to migrate', () => {
    // Not from the outgoing colour: it runs the old code, which need not have
    // the status CLI at all.
    expect(migrateStatusCommand('be-01-green')).toEqual([
      'exec',
      'be-01-green',
      'bun',
      'run',
      'src/migrate-status-cli.ts',
    ]);
  });

  it('names the baseline to return to rather than a number of steps', () => {
    expect(migrateDownCommand('be-01-green', '20260426171432_init')).toEqual([
      'exec',
      'be-01-green',
      'bun',
      'run',
      'src/migrate-down-cli.ts',
      '--to=20260426171432_init',
    ]);
  });

  it('passes "none" through, which means the database had no migrations applied', () => {
    expect(migrateDownCommand('be-01-green', 'none').at(-1)).toBe('--to=none');
  });

  it('refuses an empty baseline instead of rolling back an unknown amount', () => {
    expect(() => migrateDownCommand('be-01-green', '')).toThrow(/needs a baseline/);
  });
});
