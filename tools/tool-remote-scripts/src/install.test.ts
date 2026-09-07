import { describe, expect, it } from 'bun:test';

import { buildInstallPlan, parseInstallArgs, parseSha256sumOutput } from './install';
import { BUNDLE_FILES, bundleFilesFor } from './lib/deploy-contract';
import { envLayout } from './lib/env';
import {
  assertSolverSupervisorBunVersion,
  SOLVER_SUPERVISOR_BUN,
  SOLVER_SUPERVISOR_BUN_VERSIONS,
  SOLVER_SUPERVISOR_BUNDLE,
  SOLVER_SUPERVISOR_CONFIG,
  SOLVER_SUPERVISOR_RUNTIME_DIRECTORY,
} from './lib/solver-supervisor-install-contract';

/** Prod's absolute bundle paths, which is what `WBS_ENV` unset resolves to. */
const prodFiles = bundleFilesFor(envLayout('prod').root);

describe('parseInstallArgs', () => {
  it('defaults to h2puni, dry-run, and the environment WBS_ENV names', () => {
    const a = parseInstallArgs([]);
    expect(a.host).toBe('h2puni');
    expect(a.execute).toBe(false);
    // Unset in a test run, and `envLayout` resolves that to prod — so the
    // default is exactly what every invocation predating `--env` did.
    expect(a.layout.env).toBe('prod');
  });

  it('writes the environment --env names, not the one WBS_ENV does', () => {
    // The fault this flag exists for: `deploy.ts`'s stale-bundle message told
    // an operator deploying dev to run the installer with no environment on
    // it, which installs into **prod's** root — prod's `swap.js` overwritten
    // underneath a running prod deploy, dev's left as stale as it was.
    //
    // Proof: the `--env` arm removed from `parseInstallArgs`, this failed on
    // `expect(received).toBe(expected) · Expected: "dev" · Received: "prod"`,
    // and the plan below on the two prod paths. Watched 2026-09-02.
    const a = parseInstallArgs(['--env=dev']);

    expect(a.layout.env).toBe('dev');
    expect(a.layout.root).toBe('/home/puni1/wbs-dev');
    expect(
      buildInstallPlan(a.host, bundleFilesFor(a.layout.root)).map((s) => s.description),
    ).toEqual([
      'scp dist/tool-remote-scripts/swap.js -> h2puni:/home/puni1/wbs-dev/bin/swap.js.tmp',
      'install /home/puni1/wbs-dev/bin/swap.js (chmod 0755 + atomic rename)',
      'scp dist/tool-smoke/smoke.js -> h2puni:/home/puni1/wbs-dev/bin/smoke.js.tmp',
      'install /home/puni1/wbs-dev/bin/smoke.js (chmod 0755 + atomic rename)',
    ]);
  });

  it('refuses an environment nobody provisioned rather than taking prod', () => {
    // `envLayout`'s contract, reached through the flag: a typo must not install
    // into the live site's `bin/`.
    expect(() => parseInstallArgs(['--env=prd'])).toThrow(/unknown WBS_ENV "prd"/);
  });

  it('accepts --host and --execute', () => {
    const a = parseInstallArgs(['--host=example', '--execute']);
    expect(a.host).toBe('example');
    expect(a.execute).toBe(true);
  });

  it('--dry-run overrides a preceding --execute', () => {
    const a = parseInstallArgs(['--execute', '--dry-run']);
    expect(a.execute).toBe(false);
  });
});

describe('buildInstallPlan', () => {
  it('emits an scp-to-temp + chmod-and-rename pair per file', () => {
    const steps = buildInstallPlan('h2puni', [
      { local: 'dist/a.js', remote: '/home/puni1/wbs/bin/a.js' },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0].argv).toEqual(['scp', 'dist/a.js', 'h2puni:/home/puni1/wbs/bin/a.js.tmp']);
    expect(steps[1].argv).toEqual([
      'ssh',
      'h2puni',
      'chmod 0755 /home/puni1/wbs/bin/a.js.tmp && mv /home/puni1/wbs/bin/a.js.tmp /home/puni1/wbs/bin/a.js',
    ]);
  });

  it('never leaves a step that writes directly to the final path', () => {
    for (const step of buildInstallPlan('h2puni', prodFiles)) {
      if (step.argv[0] === 'scp') {
        expect(step.argv[2]).toMatch(/\.tmp$/);
      }
    }
  });

  it('covers both the swap executor and the smoke bundle', () => {
    expect(prodFiles.map((file) => file.remote)).toEqual([
      '/home/puni1/wbs/bin/swap.js',
      '/home/puni1/wbs/bin/smoke.js',
    ]);
  });
});

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

describe('the install target must build what it ships', () => {
  // Observed on 2026-08-05: the install target shipped a bundle built two
  // commits earlier, because it had no dependsOn and copied whatever was left
  // in dist/. It then reported "checksums verified against the local build" —
  // true, and about the stale file it had just installed. The installed
  // swap.js was missing a function its source had held since the last merge.
  //
  // Asserted against the project config rather than trusted, because the whole
  // failure was a configuration gap that no code path could reveal.
  it('declares a build dependency for every artifact it copies', async () => {
    const root = new URL('../../../', import.meta.url).pathname;
    const config = (await Bun.file(`${root}tools/tool-remote-scripts/project.json`).json()) as {
      targets: Record<string, { dependsOn?: string[] }>;
    };
    const dependsOn = config.targets['install'].dependsOn ?? [];

    expect(dependsOn).toContain('build');
    // smoke.js comes from a different project, so `^build` would not cover it.
    expect(dependsOn).toContain('tool-smoke:build');
    // Every file the installer ships must be produced by one of those builds.
    expect(BUNDLE_FILES.map((file) => file.local).sort()).toEqual([
      'dist/tool-remote-scripts/swap.js',
      'dist/tool-smoke/smoke.js',
    ]);
  });
});

describe('host-wide solver supervisor contract', () => {
  it('keeps the singleton artifact and config outside both environment roots', () => {
    for (const layout of [envLayout('prod'), envLayout('dev')]) {
      expect(SOLVER_SUPERVISOR_BUNDLE.remote).not.toStartWith(`${layout.root}/`);
      expect(SOLVER_SUPERVISOR_CONFIG).not.toStartWith(`${layout.root}/`);
    }
  });

  it('refuses any host Bun outside the measured-compatible set', () => {
    // Every listed version is one somebody ran the bundle under on h2puni; an
    // unlisted one is refused precisely because nobody has.
    for (const version of SOLVER_SUPERVISOR_BUN_VERSIONS) {
      assertSolverSupervisorBunVersion(`${version}\n`);
    }
    expect(() => {
      assertSolverSupervisorBunVersion('1.3.14\n');
    }).toThrow(SOLVER_SUPERVISOR_BUN_VERSIONS.join(', '));
    expect(() => {
      assertSolverSupervisorBunVersion('');
    }).toThrow('(missing)');
    expect(() => {
      assertSolverSupervisorBunVersion('1.2.20-next');
    }).toThrow('1.2.20-next');
  });

  it('builds the exact host artifact and pins the restart-always user unit', async () => {
    const root = new URL('../../../', import.meta.url).pathname;
    const config = (await Bun.file(`${root}tools/tool-remote-scripts/project.json`).json()) as {
      targets: Record<string, { options: { commands: string[] } }>;
    };
    expect(config.targets['build'].options.commands).toContain(
      `bun build tools/tool-remote-scripts/src/solver-supervisor.ts --target=bun --outfile ${SOLVER_SUPERVISOR_BUNDLE.local}`,
    );

    const unit = await Bun.file(
      `${root}deploy/solver-supervisor/wbs-solver-supervisor.service`,
    ).text();
    expect(unit).toContain(
      `ExecStart=${SOLVER_SUPERVISOR_BUN} ${SOLVER_SUPERVISOR_BUNDLE.remote} --config=${SOLVER_SUPERVISOR_CONFIG}`,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain(`RuntimeDirectory=${SOLVER_SUPERVISOR_RUNTIME_DIRECTORY}`);
    expect(unit).not.toContain('/home/puni1/wbs/');
    expect(unit).not.toContain('/home/puni1/wbs-dev/');
  });
});
