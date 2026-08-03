import { describe, expect, it } from 'bun:test';

import { materialize, parseDeployArgs, type Tier } from './affected';
import {
  buildDeployPlan,
  buildSmokeCommand,
  type DeployPlanDeps,
  parseSha256sumOutput,
  type ReleaseRecord,
} from './deploy';
import { parseRemoteStateOutput, type RemoteTierState } from './remote-state';
import { buildScpInvocation, buildSshInvocation } from './ssh';

describe('parseDeployArgs', () => {
  it('defaults to affected + dry-run', () => {
    const a = parseDeployArgs([]);
    expect(a.tiers).toBe('affected');
    expect(a.dryRun).toBe(true);
    expect(a.withMigrations).toBe(false);
    expect(a.stopTheWorld).toBe(false);
  });

  it('parses --all', () => {
    expect(parseDeployArgs(['--all']).tiers).toBe('all');
  });

  it('parses positional tier list', () => {
    expect(parseDeployArgs(['be', 'gw']).tiers).toEqual(['be', 'gw']);
  });

  it('rejects unknown tier', () => {
    expect(() => parseDeployArgs(['xx'])).toThrow(/unknown tier/);
  });

  it('parses --host, --version, --execute', () => {
    const a = parseDeployArgs(['--host=example', '--version=abc1234', '--execute']);
    expect(a.host).toBe('example');
    expect(a.version).toBe('abc1234');
    expect(a.dryRun).toBe(false);
  });

  it('parses --with-migrations', () => {
    expect(parseDeployArgs(['--with-migrations']).withMigrations).toBe(true);
  });

  it('parses --stop-the-world', () => {
    expect(parseDeployArgs(['--stop-the-world']).stopTheWorld).toBe(true);
  });
});

// Finding-driven (retire-systemd): the bundle-freshness gate that stops a
// deploy from running against a stale bin/swap.js / bin/smoke.js parses
// coreutils sha256sum output; this is the pure part of it.
describe('parseSha256sumOutput', () => {
  it('parses coreutils sha256sum lines into a path -> hash map', () => {
    const out = 'aaaa111  /srv/wbs/bin/swap.js\nbbbb222  /srv/wbs/bin/smoke.js\n';
    expect(parseSha256sumOutput(out)).toEqual({
      '/srv/wbs/bin/swap.js': 'aaaa111',
      '/srv/wbs/bin/smoke.js': 'bbbb222',
    });
  });

  it('ignores blank lines', () => {
    expect(parseSha256sumOutput('\n\n')).toEqual({});
  });
});

describe('materialize', () => {
  const base = { dryRun: true, skipBuild: false, withMigrations: false, stopTheWorld: false };

  it('expands all to three tiers', () => {
    expect(materialize({ tiers: 'all', ...base }, [])).toEqual(['be', 'gw', 'fe']);
  });

  it('uses affected when tiers is "affected"', () => {
    expect(materialize({ tiers: 'affected', ...base }, ['gw'])).toEqual(['gw']);
  });
});

describe('ssh helpers', () => {
  it('quotes remote cmd correctly', () => {
    const s = buildSshInvocation({ host: 'h', user: 'u' }, 'bun run thing');
    expect(s).toBe('ssh u@h "bun run thing"');
  });

  it('formats scp command', () => {
    expect(buildScpInvocation({ host: 'h', user: 'u' }, 'a.tar.gz', '/tmp/')).toBe(
      'scp a.tar.gz u@h:/tmp/',
    );
  });
});

const HEAD = 'abc1234';

function entry(tier: 'be' | 'gw' | 'fe', sha = HEAD) {
  const digest = `sha256:${tier}`.padEnd(71, '0');
  return {
    sha,
    digest,
    ref: `registry.infra.bulletpoints.club/wbs-${tier}-01:${sha}`,
    image: `registry.infra.bulletpoints.club/wbs-${tier}-01@${digest}`,
  };
}

const RELEASE: ReleaseRecord = { be: entry('be'), gw: entry('gw'), fe: entry('fe') };

function fakeDeps(overrides: Partial<DeployPlanDeps> = {}): DeployPlanDeps {
  return {
    readRemoteState: () => Promise.resolve({} as Partial<Record<Tier, RemoteTierState>>),
    listMigrations: () => ['0001_init'],
    readRelease: () => Promise.resolve(RELEASE),
    dirtyPaths: () => [],
    ...overrides,
  };
}

describe('buildDeployPlan', () => {
  it('emits a per-tier plan with --all, defaulting to the h2puni host', async () => {
    const p = await buildDeployPlan(['--all'], [], HEAD, fakeDeps());
    expect(p.tiers).toEqual(['be', 'gw', 'fe']);
    expect(p.dryRun).toBe(true);
    expect(p.host).toBe('h2puni');
    // One invocation for the whole run — see the I1 test below.
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0]).toContain('bin/swap.js be,gw,fe');
    expect(p.commands[0]).not.toContain('--execute');
  });

  // C1: the publish address used to stop at tool-deploy. Only --digest and
  // --sha crossed the SSH boundary, with no env passthrough, so the server
  // rebuilt the ref from its own REGISTRY default and could not be told
  // otherwise.
  it('passes the whole digest-pinned ref through to swap.js, registry address included', async () => {
    const p = await buildDeployPlan(['--all'], [], HEAD, fakeDeps());
    expect(p.commands[0]).toContain(
      `--image-be=registry.infra.bulletpoints.club/wbs-be-01@${entry('be').digest}`,
    );
    expect(p.commands[0]).toContain('--image-gw=registry.infra.bulletpoints.club/wbs-gw-01@');
    expect(p.commands[0]).toContain('--image-fe=registry.infra.bulletpoints.club/wbs-fe-01@');
    expect(p.commands[0]).not.toContain('--digest=');
  });

  // Decision 10: a registry problem must abort before the FIRST tier moves,
  // not between tiers.
  it('preflights every tier before any of them swaps, without --execute', async () => {
    const p = await buildDeployPlan(['--all', '--execute'], [], HEAD, fakeDeps());
    expect(p.preflightCommands).toHaveLength(1);
    const cmd = p.preflightCommands[0];
    expect(cmd).toContain('--preflight');
    expect(cmd).toContain('--image-be=');
    expect(cmd).toContain('--image-gw=');
    expect(cmd).toContain('--image-fe=');
    expect(cmd).not.toContain('--execute');
  });

  // I1: the deploy lock lives inside swap.js, so one SSH invocation per tier
  // meant the lock was released between tiers and two concurrent --all runs
  // could interleave. The whole run is now a single invocation, which is what
  // makes the existing single lock cover it.
  it('drives every tier from one swap.js invocation so the lock spans the run', async () => {
    const p = await buildDeployPlan(['--all', '--execute'], [], HEAD, fakeDeps());
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0]).toContain('bin/swap.js be,gw,fe');
    expect(p.commands[0]).toContain('--execute');
  });

  it('names only the selected tiers in that one invocation', async () => {
    const p = await buildDeployPlan(['be', 'fe', '--execute'], [], HEAD, fakeDeps());
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0]).toContain('bin/swap.js be,fe');
    expect(p.commands[0]).toContain('--image-be=');
    expect(p.commands[0]).toContain('--image-fe=');
    expect(p.commands[0]).not.toContain('--image-gw=');
  });

  // I3: the gate diffs migrations in git at HEAD, which describes the image
  // only if the image was built from HEAD.
  it('refuses a release built at a different commit than HEAD', async () => {
    const deps = fakeDeps({
      readRelease: () => Promise.resolve({ be: entry('be', 'some-other-sha') }),
    });
    let message = '';
    try {
      await buildDeployPlan(['be'], [], HEAD, deps);
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/built at some-other-sha but HEAD is abc1234/);
  });

  // I4: the installed-bundle gate (assertBundleInstalled) only proves the
  // remote bin/ matches the local dist/. Both can be stale together, so it
  // never establishes that the orchestrator about to drive the swap is the
  // one at HEAD. `deploy`'s dependsOn rebuilds dist/ from the worktree, so
  // the one remaining link is worktree == HEAD — which is exactly what a
  // dirty tree breaks. Refusing here supplies that link; the chain is then
  // clean tree -> dist built from HEAD -> remote bundle == dist == HEAD.
  it('refuses to plan a deploy from a dirty worktree', async () => {
    const deps = fakeDeps({
      dirtyPaths: () => ['tools/tool-remote-scripts/src/swap.ts'],
    });
    let message = '';
    try {
      await buildDeployPlan(['be'], [], HEAD, deps);
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/uncommitted/);
    expect(message).toContain('tools/tool-remote-scripts/src/swap.ts');
  });

  // The refusal has to land before anything reaches the network, like the
  // migration gate and --stop-the-world — including on a dry run, so the
  // operator learns about it before typing --execute rather than after.
  it('refuses a dirty worktree on a dry run too, before reading remote state', async () => {
    let readRemote = false;
    const deps = fakeDeps({
      dirtyPaths: () => ['apps/be-01/src/main.ts'],
      readRemoteState: () => {
        readRemote = true;
        return Promise.resolve({});
      },
    });
    let message = '';
    try {
      await buildDeployPlan(['--all'], [], HEAD, deps);
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/uncommitted/);
    expect(readRemote).toBe(false);
  });

  it('plans normally when the worktree is clean', async () => {
    const p = await buildDeployPlan(['be'], [], HEAD, fakeDeps({ dirtyPaths: () => [] }));
    expect(p.tiers).toEqual(['be']);
  });

  it('honors an explicit --host', async () => {
    const p = await buildDeployPlan(['be', '--host=other'], [], HEAD, fakeDeps());
    expect(p.host).toBe('other');
    expect(p.steps.some((s) => s.includes('ssh other'))).toBe(true);
  });

  it('appends --execute to the remote command when not a dry run', async () => {
    const p = await buildDeployPlan(['be', '--execute'], [], HEAD, fakeDeps());
    expect(p.commands[0]).toContain('--execute');
  });

  it('reports "(never deployed)" for a tier with no remote state', async () => {
    const p = await buildDeployPlan(['be'], [], HEAD, fakeDeps());
    expect(p.steps.some((s) => s.includes('(never deployed)'))).toBe(true);
  });

  it('is silent about migrations when the deployed and head sets match', async () => {
    const deps = fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'deployed-sha' },
        }),
      listMigrations: () => ['0001_init'],
    });
    const p = await buildDeployPlan(['be'], [], HEAD, deps);
    expect(p.steps.some((s) => s.includes('new migrations'))).toBe(false);
  });

  it('throws and never reaches ssh when a new migration lacks an override flag', async () => {
    const deps = fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'deployed-sha' },
        }),
      listMigrations: (sha) => (sha === 'deployed-sha' ? ['0001_init'] : ['0001_init', '0002_new']),
    });
    let message = '';
    try {
      await buildDeployPlan(['be'], [], HEAD, deps);
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/--with-migrations/);
  });

  it('proceeds when --with-migrations acknowledges the new migration', async () => {
    const deps = fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'deployed-sha' },
        }),
      listMigrations: (sha) => (sha === 'deployed-sha' ? ['0001_init'] : ['0001_init', '0002_new']),
    });
    const p = await buildDeployPlan(['be', '--with-migrations'], [], HEAD, deps);
    expect(p.steps.some((s) => s.includes('new migrations present'))).toBe(true);
  });

  // Item 1 fix: --stop-the-world used to bypass the migration gate and then
  // silently produce the exact same blue/green swap command as a normal
  // deploy — the flag is now rejected outright, unconditionally, before any
  // tier (or its migration state) is even examined.
  it('refuses --stop-the-world outright, even with a new migration present', async () => {
    const deps = fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'deployed-sha' },
        }),
      listMigrations: (sha) => (sha === 'deployed-sha' ? ['0001_init'] : ['0001_init', '0002_new']),
    });
    let message = '';
    try {
      await buildDeployPlan(['be', '--stop-the-world'], [], HEAD, deps);
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/not implemented/);
  });

  it('refuses --stop-the-world even when there is no migration to gate', async () => {
    let message = '';
    try {
      await buildDeployPlan(['be', '--stop-the-world'], [], HEAD, fakeDeps());
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/not implemented/);
  });

  it('never gates a first-ever deploy (no baseline) even with new migration files', async () => {
    const deps = fakeDeps({
      readRemoteState: () => Promise.resolve({} as Partial<Record<Tier, RemoteTierState>>),
      listMigrations: () => ['0001_init', '0002_new'],
    });
    const p = await buildDeployPlan(['be'], [], HEAD, deps);
    expect(p.steps.some((s) => s.includes('new migrations'))).toBe(false);
  });

  it('throws a clear error when the release manifest has no entry for a tier', async () => {
    const deps = fakeDeps({ readRelease: () => Promise.resolve({}) });
    let message = '';
    try {
      await buildDeployPlan(['be'], [], HEAD, deps);
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/no release entry for tier "be"/);
  });

  it('uses affected tiers when none are given positionally', async () => {
    const p = await buildDeployPlan([], ['gw'], HEAD, fakeDeps());
    expect(p.tiers).toEqual(['gw']);
  });
});

// Finding I5(b): tool-deploy is now what actually invokes smoke, passing
// each tier's real post-swap colour rather than requiring an operator to
// export SMOKE_COLOR by hand.
describe('buildSmokeCommand', () => {
  function state(
    overrides: Partial<Record<Tier, RemoteTierState>>,
  ): Partial<Record<Tier, RemoteTierState>> {
    return overrides;
  }

  it('passes each tier a URL built from its OWN colour, not a single shared one', () => {
    const cmd = buildSmokeCommand(
      state({
        be: { tier: 'be', activeColor: 'green', lastDeployedSha: 'x' },
        gw: { tier: 'gw', activeColor: 'green', lastDeployedSha: 'x' },
        // Real live state on h2puni mid-branch: fe stayed blue while be/gw
        // were both green. A single global SMOKE_COLOR could not express
        // this; per-tier overrides can.
        fe: { tier: 'fe', activeColor: 'blue', lastDeployedSha: 'x' },
      }),
    );
    expect(cmd).toContain('-e SMOKE_BE_URL=http://be-01-green:3100/health');
    expect(cmd).toContain('-e SMOKE_GW_URL=http://gw-01-green:3200/health');
    expect(cmd).toContain('-e SMOKE_FE_URL=http://fe-01-blue:80/');
    expect(cmd).toContain('-e SMOKE_INTERNAL_URL=http://be-01-green:3100/internal/forward');
  });

  it('never puts SMOKE_COLOR, INTERNAL_AUTH_SECRET, or a JWT key on the command line', () => {
    const cmd = buildSmokeCommand(
      state({ be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'x' } }),
    );
    expect(cmd).not.toContain('SMOKE_COLOR');
    expect(cmd).not.toContain('INTERNAL_AUTH_SECRET');
    expect(cmd).not.toContain('JWT_SIGNING_KEY');
  });

  // Secrets reach the container via the server-side env-file, never a value
  // this (locally-run) process ever holds.
  it('supplies secrets only via the server-side gw-01.secrets.env, never inline', () => {
    const cmd = buildSmokeCommand(state({}));
    expect(cmd).toContain('--env-file /srv/wbs/gw-01.secrets.env');
  });

  it('runs the bundled single-file smoke.js, not a $PWD-mounted checkout', () => {
    const cmd = buildSmokeCommand(state({}));
    expect(cmd).toContain('-v /srv/wbs/bin/smoke.js:/smoke.js:ro');
    expect(cmd).not.toContain('$PWD');
  });

  it('omits an override for a tier with no recorded state rather than guessing a colour', () => {
    const cmd = buildSmokeCommand(
      state({ be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'x' } }),
    );
    expect(cmd).not.toContain('SMOKE_GW_URL');
    expect(cmd).not.toContain('SMOKE_FE_URL');
  });
});

// Codex P0: readRemoteState used `cat ... 2>/dev/null || true`, which
// swallows EVERY failure, not just "file missing". An unreadable state file
// therefore parsed as "this tier was never deployed", and a never-deployed
// tier makes hasNewMigrations return false — which silently disables the
// --with-migrations acknowledgment gate. Break: `chmod 000
// /srv/wbs/state/be.json`, then deploy a destructive migration with no flag.
describe('parseRemoteStateOutput', () => {
  const present = (tier: string, sha: string) =>
    `== ${tier} present\n{"tier":"${tier}","activeColor":"blue","lastDeployedSha":"${sha}"}\n`;

  it('parses every present tier', () => {
    const out = present('be', 'a') + present('gw', 'b') + present('fe', 'c');
    const state = parseRemoteStateOutput(out);
    expect(state.be?.lastDeployedSha).toBe('a');
    expect(state.gw?.lastDeployedSha).toBe('b');
    expect(state.fe?.lastDeployedSha).toBe('c');
  });

  // The one case this is genuinely meant to tolerate: a fresh host that has
  // never deployed that tier. There is no previous release to be
  // backward-compatible with, so absent really does mean absent.
  it('treats a genuinely absent state file as "never deployed"', () => {
    const out = `== be absent\n${present('gw', 'b')}== fe absent\n`;
    const state = parseRemoteStateOutput(out);
    expect(state.be).toBeUndefined();
    expect(state.fe).toBeUndefined();
    expect(state.gw?.lastDeployedSha).toBe('b');
  });

  it('refuses an unreadable state file instead of calling it never-deployed', () => {
    const out = `== be unreadable\n${present('gw', 'b')}== fe absent\n`;
    expect(() => parseRemoteStateOutput(out)).toThrow(/be/);
    expect(() => parseRemoteStateOutput(out)).toThrow(/could not be read/);
  });

  it('refuses a state file whose contents are not valid JSON', () => {
    const out = '== be present\nnot json at all\n';
    expect(() => parseRemoteStateOutput(out)).toThrow(/be/);
  });

  // A present-but-empty file is corruption, not absence: something wrote it.
  it('refuses a present but empty state file', () => {
    const out = '== be present\n\n== gw absent\n== fe absent\n';
    expect(() => parseRemoteStateOutput(out)).toThrow(/be/);
  });

  // Truncated ssh output must not read as "all three tiers never deployed".
  it('refuses output that does not report all three tiers', () => {
    expect(() => parseRemoteStateOutput('== be absent\n')).toThrow(/gw|fe/);
  });
});

describe('parseRemoteStateOutput header handling', () => {
  it('refuses a header missing its status word rather than reading it as a tier', () => {
    expect(() => parseRemoteStateOutput('== be\n')).toThrow(/unreadable header/);
  });
});
