import { envLayout } from '@wbs/tool-env';
import { describe, expect, it } from 'bun:test';

import { materialize, parseDeployArgs, type Tier } from './affected';
import {
  buildDeployPlan,
  buildSmokeCommand,
  type DeployPlanDeps,
  installCommandFor,
  parseSha256sumOutput,
  prodSolverSupervisorPreflightCommand,
  type ReleaseRecord,
} from './deploy';
import { parseRemoteStateOutput, type RemoteTierState } from './remote-state';

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

  it('parses --host and --execute', () => {
    const a = parseDeployArgs(['--host=example', '--execute']);
    expect(a.host).toBe('example');
    expect(a.dryRun).toBe(false);
  });

  // These were accepted and read by nothing. `--version=v1.2.3` reads as a
  // rollback and deployed HEAD instead, which is the most expensive way for a
  // flag to be a no-op.
  for (const flag of ['--since=abc', '--version=v1', '--skip-build']) {
    it(`refuses ${flag}, which was previously ignored`, () => {
      expect(() => parseDeployArgs([flag])).toThrow(/not implemented/);
    });
  }

  // A mistyped flag used to be skipped, and envLayout defaults to prod: the
  // typo deployed to the live site under the operator's belief it had not.
  it('refuses a mistyped flag rather than defaulting to prod', () => {
    expect(() => parseDeployArgs(['--envv=dev'])).toThrow(/unrecognised flag/);
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
    const out = 'aaaa111  /home/puni1/wbs/bin/swap.js\nbbbb222  /home/puni1/wbs/bin/smoke.js\n';
    expect(parseSha256sumOutput(out)).toEqual({
      '/home/puni1/wbs/bin/swap.js': 'aaaa111',
      '/home/puni1/wbs/bin/smoke.js': 'bbbb222',
    });
  });

  it('ignores blank lines', () => {
    expect(parseSha256sumOutput('\n\n')).toEqual({});
  });
});

describe('materialize', () => {
  const base = {
    dryRun: true,
    skipBuild: false,
    withMigrations: false,
    stopTheWorld: false,
    layout: envLayout('dev'),
  };

  it('expands all to three tiers', () => {
    expect(materialize({ tiers: 'all', ...base }, [])).toEqual(['be', 'gw', 'fe']);
  });

  it('uses affected when tiers is "affected"', () => {
    expect(materialize({ tiers: 'affected', ...base }, ['gw'])).toEqual(['gw']);
  });
});

const HEAD = 'abc1234';

function entry(tier: Tier, sha = HEAD) {
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
    expect(p.preflightCommands).toHaveLength(2);
    const cmd = p.preflightCommands[1];
    expect(cmd).toContain('--preflight');
    expect(cmd).toContain('--image-be=');
    expect(cmd).toContain('--image-gw=');
    expect(cmd).toContain('--image-fe=');
    expect(cmd).not.toContain('--execute');
  });

  it('preflights the supervisor, socket and exact next prod colour before registry access', async () => {
    const image = entry('be').image;
    const deps = fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'blue', lastDeployedSha: HEAD },
        }),
    });
    const plan = await buildDeployPlan(['be', '--execute'], [], HEAD, deps);
    expect(plan.preflightCommands[0]).toBe(prodSolverSupervisorPreflightCommand('blue', image));
    expect(plan.preflightCommands[0]).toContain('systemctl --user is-active --quiet');
    expect(plan.preflightCommands[0]).toContain(
      'test -S /run/user/1000/wbs-solver/supervisor.sock',
    );
    expect(plan.preflightCommands[0]).toContain('--caller-name=be-01-green');
    expect(plan.preflightCommands[0]).toContain(`--image=${image}`);
  });

  it('does not make non-backend deploys depend on the solver supervisor', async () => {
    const plan = await buildDeployPlan(['gw', '--execute'], [], HEAD, fakeDeps());
    expect(plan.preflightCommands).toHaveLength(1);
    expect(plan.preflightCommands[0]).not.toContain('solver-supervisor');
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

  it('names only the migrations this deploy adds, not every one at HEAD', async () => {
    // Observed against prod: the line listed the already-applied initial
    // migration next to the real one, which reads as "both are about to run".
    const deps = fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'green', lastDeployedSha: 'deployed-sha' },
        }),
      listMigrations: (sha) => (sha === 'deployed-sha' ? ['0001_init'] : ['0001_init', '0002_new']),
    });
    const p = await buildDeployPlan(['be', '--with-migrations'], [], HEAD, deps);
    const line = p.steps.find((s) => s.includes('new migrations present'));
    expect(line).toContain('0002_new');
    expect(line).not.toContain('0001_init');
  });

  it('does not gate a gw-only deploy on migrations it cannot apply', async () => {
    // Only be-01's plan carries a migrate step. The gate used to run per tier
    // against that tier's own sha, so this deploy demanded --with-migrations
    // and then applied nothing.
    const deps = fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'deployed-sha' },
          gw: { tier: 'gw', activeColor: 'blue', lastDeployedSha: 'deployed-sha' },
        }),
      listMigrations: (sha) => (sha === 'deployed-sha' ? ['0001_init'] : ['0001_init', '0002_new']),
    });
    const p = await buildDeployPlan(['gw'], [], HEAD, deps);
    expect(p.steps.some((s) => s.includes('remain unapplied'))).toBe(true);
    expect(p.steps.some((s) => s.includes('proceeding under'))).toBe(false);
  });

  it('still gates the same migration when be is in the deploy', async () => {
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
    expect(message).toMatch(/new migrations/);
  });

  it('measures migrations against be, not against the tier being deployed', async () => {
    // gw is behind and be is current: there is nothing to apply, and a per-tier
    // reading would have reported new migrations for gw anyway.
    const deps = fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'blue', lastDeployedSha: HEAD },
          gw: { tier: 'gw', activeColor: 'blue', lastDeployedSha: 'older-sha' },
        }),
      listMigrations: (sha) => (sha === 'older-sha' ? ['0001_init'] : ['0001_init', '0002_new']),
    });
    const p = await buildDeployPlan(['gw'], [], HEAD, deps);
    expect(p.steps.some((s) => s.includes('remain unapplied'))).toBe(false);
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
      envLayout('prod'),
    );
    expect(cmd).toContain('-e SMOKE_BE_URL=http://be-01-green:3100/health');
    expect(cmd).toContain('-e SMOKE_GW_URL=http://gw-01-green:3200/health');
    expect(cmd).toContain('-e SMOKE_FE_URL=http://fe-01-blue:80/');
    expect(cmd).toContain('-e SMOKE_INTERNAL_URL=http://be-01-green:3100/internal/forward');
  });

  it('never puts SMOKE_COLOR, INTERNAL_AUTH_SECRET, or a JWT key on the command line', () => {
    const cmd = buildSmokeCommand(
      state({ be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'x' } }),
      envLayout('prod'),
    );
    expect(cmd).not.toContain('SMOKE_COLOR');
    expect(cmd).not.toContain('INTERNAL_AUTH_SECRET');
    expect(cmd).not.toContain('JWT_SIGNING_KEY');
  });

  // Secrets reach the container via the server-side env-file, never a value
  // this (locally-run) process ever holds.
  it('supplies secrets only via the server-side gw-01.secrets.env, never inline', () => {
    const cmd = buildSmokeCommand(state({}), envLayout('prod'));
    expect(cmd).toContain('--env-file /home/puni1/wbs/gw-01.secrets.env');
  });

  it('runs the bundled single-file smoke.js, not a $PWD-mounted checkout', () => {
    const cmd = buildSmokeCommand(state({}), envLayout('prod'));
    expect(cmd).toContain('-v /home/puni1/wbs/bin/smoke.js:/smoke.js:ro');
    expect(cmd).not.toContain('$PWD');
  });

  it('omits an override for a tier with no recorded state rather than guessing a colour', () => {
    const cmd = buildSmokeCommand(
      state({ be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'x' } }),
      envLayout('prod'),
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
// /home/puni1/wbs/state/be.json`, then deploy a destructive migration with no flag.
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

describe('--env', () => {
  it('defaults to prod', () => {
    expect(parseDeployArgs([]).layout.env).toBe('prod');
    expect(parseDeployArgs([]).layout.root).toBe('/home/puni1/wbs');
  });

  it('parses --env=dev into dev’s layout', () => {
    const a = parseDeployArgs(['--env=dev']);
    expect(a.layout.env).toBe('dev');
    expect(a.layout.root).toBe('/home/puni1/wbs-dev');
    expect(a.layout.stateDir).toBe('/home/puni1/wbs-dev/state');
  });

  /**
   * R5. Proof: with the `hasOwnProperty` guard removed from `envLayout`,
   * `parseDeployArgs(['--env=stagign']).layout` is `undefined` rather than a
   * throw, and the first read of it fails with `TypeError: undefined is not
   * an object (evaluating 'a.layout.stateDir')` — a trace that never names
   * the typo that caused it. Both observed 2026-08-04.
   */
  it('refuses an environment nobody provisioned', () => {
    expect(() => parseDeployArgs(['--env=stagign'])).toThrow(/stagign/);
  });
});

describe('per-environment deploy plans', () => {
  it('sends prod the exact command it sent before environments existed', async () => {
    const p = await buildDeployPlan(['--all'], [], HEAD, fakeDeps());
    expect(p.commands[0]).toStartWith('cd /home/puni1/wbs && bun bin/swap.js be,gw,fe ');
    expect(p.commands[0]).not.toContain('WBS_ENV');
  });

  it('sends dev its own root and WBS_ENV', async () => {
    const p = await buildDeployPlan(['--all', '--env=dev'], [], HEAD, fakeDeps());
    expect(p.commands[0]).toStartWith(
      'cd /home/puni1/wbs-dev && WBS_ENV=dev bun bin/swap.js be,gw,fe ',
    );
  });

  /**
   * The failure this prevents is not hypothetical arithmetic: a dev deploy
   * that read prod's state would see prod's last-deployed sha, conclude dev
   * was already current, and skip — or read prod's colours and swap dev's
   * containers to match them.
   */
  it('reads the state directory of the environment being deployed, never another', async () => {
    const asked: string[] = [];
    const deps = fakeDeps({
      readRemoteState: (_host, stateDir) => {
        asked.push(stateDir);
        // A caller that leaked prod's path would get real-looking state back.
        if (stateDir === '/home/puni1/wbs/state') {
          return Promise.resolve({
            be: { tier: 'be', activeColor: 'green' as const, lastDeployedSha: HEAD },
          });
        }
        return Promise.resolve({} as Partial<Record<Tier, RemoteTierState>>);
      },
    });
    const p = await buildDeployPlan(['be', '--env=dev'], [], HEAD, deps);
    expect(asked).toEqual(['/home/puni1/wbs-dev/state']);
    expect(p.steps.some((s) => s.includes('(never deployed)'))).toBe(true);
  });

  it('smokes dev over dev’s own network, root and address', () => {
    const cmd = buildSmokeCommand(
      { be: { tier: 'be', activeColor: 'blue', lastDeployedSha: 'x' } },
      envLayout('dev'),
    );
    expect(cmd).toContain('--network wbs-dev-net');
    expect(cmd).toContain('--env-file /home/puni1/wbs-dev/gw-01.secrets.env');
    expect(cmd).toContain('-e SITE_ADDRESS=dev.wbs.bulletpoints.club');
    expect(cmd).not.toContain('/home/puni1/wbs/gw-01.secrets.env');
  });
});

describe('migration gate per environment', () => {
  function depsWithNewMigration(): DeployPlanDeps {
    return fakeDeps({
      readRemoteState: () =>
        Promise.resolve({
          be: { tier: 'be', activeColor: 'blue' as const, lastDeployedSha: 'deployed-sha' },
        }),
      listMigrations: (sha) => (sha === 'deployed-sha' ? ['0001_init'] : ['0001_init', '0002_new']),
    });
  }

  it('lets dev deploy a new migration unattended, and says so', async () => {
    const p = await buildDeployPlan(['be', '--env=dev'], [], HEAD, depsWithNewMigration());
    const line = p.steps.find((s) => s.includes('new migrations present'));
    expect(line).toContain('0002_new');
    expect(line).toContain('--env=dev');
  });

  /**
   * The negative half of the slice above: dev's bypass must be scoped to dev.
   * Proof: changing the condition to `args.withMigrations || true` — the
   * shape a "just make dev work" edit takes — makes this test fail, together
   * with the older "throws and never reaches ssh when a new migration lacks
   * an override flag". 2 failed, 62 passed. Observed 2026-08-04.
   */
  it('still refuses prod without an explicit acknowledgement', async () => {
    let message = '';
    try {
      await buildDeployPlan(['be'], [], HEAD, depsWithNewMigration());
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('new migrations');
  });

  it('still honours an explicit --with-migrations on prod', async () => {
    const p = await buildDeployPlan(['be', '--with-migrations'], [], HEAD, depsWithNewMigration());
    const line = p.steps.find((s) => s.includes('new migrations present'));
    expect(line).toContain('--with-migrations');
  });
});

describe('buildSmokeCommand across environments', () => {
  const state = {
    be: { tier: 'be' as const, activeColor: 'blue' as const, lastDeployedSha: 'x' },
    gw: { tier: 'gw' as const, activeColor: 'blue' as const, lastDeployedSha: 'x' },
    fe: { tier: 'fe' as const, activeColor: 'blue' as const, lastDeployedSha: 'x' },
  };

  it('targets prod’s container names unchanged', () => {
    const cmd = buildSmokeCommand(state, envLayout('prod'));
    expect(cmd).toContain('SMOKE_BE_URL=http://be-01-blue:3100/health');
  });

  /**
   * The first live dev deploy swapped all three tiers, then smoke reported
   * `FAIL 0 be-01 http://be-01-blue:3100/health — The operation was aborted`
   * three times: it was dialling PROD's container names on DEV's network,
   * where nothing answers to them.
   *
   * Proof the fix is load-bearing: dropping `layout.containerPrefix` from
   * tierUrl fails this test and only this one — 1 failed, 87 passed. The prod
   * test above still passes, which is exactly why the bug survived until a
   * second environment existed. Observed 2026-08-04.
   */
  it('targets dev’s prefixed container names', () => {
    const cmd = buildSmokeCommand(state, envLayout('dev'));
    expect(cmd).toContain('SMOKE_BE_URL=http://dev-be-01-blue:3100/health');
    expect(cmd).toContain('SMOKE_GW_URL=http://dev-gw-01-blue:3200/health');
    expect(cmd).toContain('SMOKE_FE_URL=http://dev-fe-01-blue:80/');
    expect(cmd).toContain('SMOKE_INTERNAL_URL=http://dev-be-01-blue:3100/internal/forward');
    expect(cmd).not.toContain('http://be-01-blue');
  });
});

describe('the installer command a stale bundle tells an operator to run', () => {
  it('names the environment the deploy is for, not the one WBS_ENV happens to be', () => {
    // The fault: both stale-bundle messages said `install --host=<host>
    // --execute`, and the installer takes its environment from `WBS_ENV` —
    // unset in an operator's shell, which resolves to prod. A dev deploy's own
    // error message therefore told the operator to overwrite **prod**'s
    // `swap.js` and `smoke.js` underneath a running prod deploy, and to leave
    // dev's bundle exactly as stale as it was.
    //
    // Proof: `--env=${layout.env}` dropped from `installCommandFor`, this
    // failed on `expect(received).toContain(expected) · Expected:
    // "--env=dev"`. Watched 2026-09-02.
    expect(installCommandFor('h2puni', envLayout('dev'))).toContain('--env=dev');
    expect(installCommandFor('h2puni', envLayout('prod'))).toContain('--env=prod');
  });

  it('is quoted and pasteable, host first', () => {
    expect(installCommandFor('h2puni', envLayout('prod'))).toBe(
      '"nx run tool-remote-scripts:install --host=h2puni --env=prod --execute"',
    );
  });
});
