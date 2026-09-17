import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { hashBytes } from '../evidence/content-manifest';
import { verifyActivation } from './activation';
import { prepareToolkitActivation } from './prepare-activation-cli';
import { planToolkit, toolkitRoles } from './release';
import { releaseToolkit } from './release-cli';
import {
  auditReview,
  candidateIdentityAt,
  createRelocationCandidate,
  disposeRelocationFixtures,
  encodeJson,
  fixtureMapping,
  write,
} from './relocation-fixtures';
import {
  buildValidatorBundle,
  copyTrustedModules,
  hashTrustedModules,
  trustedModuleNames,
  writeBytes,
} from './trusted-modules';

const workspace = resolve(import.meta.dir, '..', '..', '..', '..', '..');
const scratchPaths: string[] = [];

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

function git(repository: string, argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    throw new Error(`git ${argv.join(' ')}: ${invocation.stderr.toString('utf8')}`);
  }
  return invocation.stdout.toString('utf8').trim();
}

/**
 * A checkout with this repository's release layout: the four role sources the target reads, a
 * pinned `.bun-version`, and a `node_modules/typescript` the trusted closure walks. The TypeScript
 * stand-in keeps the 24 MB real closure out of every case that only measures the descriptors.
 */
function releaseCheckout(): { repository: string; destinationParent: string } {
  const parent = scratch('tool-wiki-release-');
  const repository = join(parent, 'checkout');
  mkdirSync(repository, { recursive: true });
  git(repository, ['init', '--initial-branch=main']);
  git(repository, ['config', 'user.email', 'release@example.test']);
  git(repository, ['config', 'user.name', 'Release Fixture']);
  write(join(repository, '.gitignore'), 'node_modules\n');
  write(join(repository, '.bun-version'), `${Bun.version}\n`);
  cpSync(join(workspace, 'bin', 'tool-wiki-lint.sh'), join(repository, 'bin/tool-wiki-lint.sh'));
  cpSync(
    join(workspace, 'apps/wiki/cli/src/policy/snapshot-validator.ts'),
    join(repository, 'apps/wiki/cli/src/policy/snapshot-validator.ts'),
  );
  write(
    join(repository, 'apps/wiki/cli/src/cli.ts'),
    'process.stdout.write(`${JSON.stringify({ argv: process.argv.slice(2) })}\\n`);\n',
  );
  write(
    join(repository, 'apps/wiki/cli/src/policy/prepare-activation-cli.ts'),
    'process.stdout.write("prepare\\n");\n',
  );
  write(
    join(repository, 'package.json'),
    `${JSON.stringify({ name: 'release-fixture', private: true, devDependencies: { typescript: 'npm:@typescript/typescript6@6.0.2' } })}\n`,
  );
  write(
    join(repository, 'node_modules/typescript/package.json'),
    '{"name":"@typescript/typescript6","version":"6.0.2"}\n',
  );
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--message', 'release layout']);
  return { repository, destinationParent: join(parent, 'out') };
}

function tarMembers(path: string): string[] {
  const listed = Bun.spawnSync(['tar', '--list', '--file', path], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString('utf8'));
  return listed.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Runs an action that must refuse and returns its message, so cases assert the exact text. */
async function refusalMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error('expected a refusal, but the action resolved');
}

afterAll(() => {
  disposeRelocationFixtures();
  for (const path of scratchPaths.splice(0)) {
    Bun.spawnSync(['rm', '-rf', '--', path], { stderr: 'pipe', stdout: 'pipe' });
  }
});

describe('wiki-cli release target', () => {
  test('packs exactly the toolkit a consumer can reuse and prints its digest', async () => {
    const { repository, destinationParent } = releaseCheckout();
    git(repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    const destination = join(destinationParent, 'toolkit');

    const lines = await releaseToolkit([
      '--tag',
      'wiki-v0.0.1',
      '--destination',
      destination,
      '--repository',
      repository,
    ]);

    const head = git(repository, ['rev-parse', 'HEAD']);
    expect(lines[0]).toBe(`toolkit: wiki-v0.0.1 ${head}`);
    const archiveLine = lines.find((line) => line.startsWith('archive: '));
    if (archiveLine === undefined) throw new Error(`no archive line in: ${lines.join('\n')}`);
    const archivePath = archiveLine.slice('archive: '.length).split(/\s+/)[0];
    const printedDigest = /sha256: ([0-9a-f]{64})/.exec(archiveLine)?.[1];

    expect(archivePath).toBe(join(destinationParent, 'wiki-v0.0.1.tar'));
    // The printed digest is the operator's only handle on these bytes; it must be the file's own.
    expect(printedDigest).toBe(hashBytes(readFileSync(archivePath)));
    expect(printedDigest).toBe(
      Bun.spawnSync(['sha256sum', archivePath], { stdout: 'pipe' })
        .stdout.toString('utf8')
        .slice(0, 64),
    );

    const members = tarMembers(archivePath).filter(
      (member) => !member.startsWith('./trusted-node-modules'),
    );
    // Proof: a toolkit that shipped `selected.json`, a manifest or a review receipt would certify
    // this repository's commit to a consumer whose candidates can never equal it — ADR 0026. The
    // sorted member list is watched here so a role added without a decision fails.
    expect(members.sort()).toEqual([
      './',
      './SHA256SUMS',
      './launcher.sh',
      './prepare-activation.mjs',
      './snapshotter.ts',
      './toolkit.json',
      './validator.mjs',
    ]);
    expect(tarMembers(archivePath)).toContain('./trusted-node-modules/typescript/package.json');

    const descriptor = JSON.parse(readFileSync(join(destination, 'toolkit.json'), 'utf8')) as {
      tag: string;
      sourceRevision: string;
      bunVersion: string;
      roles: Record<string, string>;
      trustedNodeModules: string[];
      trustedNodeModulesIdentity: string;
    };
    expect(descriptor).toMatchObject({
      tag: 'wiki-v0.0.1',
      sourceRevision: head,
      bunVersion: Bun.version,
      trustedNodeModules: ['typescript'],
    });
    // Proof: `SHA256SUMS` lists no file below `trusted-node-modules`, so before this identity the
    // 24 MB the validator loads was authenticated by nothing the consumer could check.
    expect(descriptor.trustedNodeModulesIdentity).toBe(
      hashTrustedModules(join(destination, 'trusted-node-modules')),
    );
    for (const role of toolkitRoles) {
      expect(descriptor.roles[role]).toBe(hashBytes(readFileSync(join(destination, role))));
    }
    expect(readFileSync(join(destination, 'launcher.sh'), 'utf8')).toBe(
      readFileSync(join(workspace, 'bin', 'tool-wiki-lint.sh'), 'utf8'),
    );
    expect(readFileSync(join(destination, 'SHA256SUMS'), 'utf8')).toContain('./toolkit.json');
  });

  test('refuses a checkout whose bytes are not the ones the tag names', async () => {
    const { repository, destinationParent } = releaseCheckout();
    git(repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    write(join(repository, 'bin/tool-wiki-lint.sh'), '#!/usr/bin/env bash\nexit 0\n');

    // Proof: with the dirty-tree refusal removed this packed the edited launcher as the tag's
    // `launcher.sh` and printed an archive path at exit 0, so `toolkit.json` named a commit whose
    // committed launcher was not the one inside the archive.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v0.0.1',
          '--destination',
          join(destinationParent, 'toolkit'),
          '--repository',
          repository,
        ]),
      ),
    ).toContain('checkout is dirty: bin/tool-wiki-lint.sh');
  });

  test('refuses a tag that is not at HEAD, unknown, or malformed', async () => {
    const { repository, destinationParent } = releaseCheckout();
    const parent = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    write(join(repository, 'apps/wiki/cli/src/cli.ts'), 'process.stdout.write("moved\\n");\n');
    git(repository, ['add', '--all']);
    git(repository, ['commit', '--message', 'after the tag']);
    const head = git(repository, ['rev-parse', 'HEAD']);
    const destination = join(destinationParent, 'toolkit');

    // Proof: with the HEAD comparison removed this packed the new commit's `validator.mjs` under a
    // `toolkit.json` naming the tagged parent; the negative received a complete archive at exit 0.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v0.0.1',
          '--destination',
          destination,
          '--repository',
          repository,
        ]),
      ),
    ).toContain(`release tag is not at HEAD: ${parent} != ${head}`);

    // Proof: with the resolution refusal removed an unknown tag reached the HEAD comparison and
    // refused with `release tag is not at HEAD: undefined != <head>`, naming a placement problem
    // for a tag that does not exist.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v9.9.9',
          '--destination',
          destination,
          '--repository',
          repository,
        ]),
      ),
    ).toContain('release tag is unknown: wiki-v9.9.9');

    for (const malformed of ['wiki-v1', 'wiki-v1.2', 'wiki-v1.2.3-rc1', 'v1.2.3']) {
      // Proof: with the tag form unchecked `wiki-v1` packed into `wiki-wiki-v1.tar` under a
      // `toolkit.json` whose tag no release page could carry; the negative exited 0.
      expect(
        await refusalMessage(
          releaseToolkit([
            '--tag',
            malformed,
            '--destination',
            destination,
            '--repository',
            repository,
          ]),
        ),
      ).toContain(`release tag is malformed: ${malformed}`);
    }
  });

  test('refuses an operator runtime and a destination it cannot honestly use', async () => {
    const { repository, destinationParent } = releaseCheckout();
    git(repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    const destination = join(destinationParent, 'toolkit');
    await releaseToolkit([
      '--tag',
      'wiki-v0.0.1',
      '--destination',
      destination,
      '--repository',
      repository,
    ]);

    // Proof: with the destination refusal removed a second run wrote a second `toolkit.json` beside
    // the first run's files and printed a digest for an archive mixing both; the negative exited 0.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v0.0.1',
          '--destination',
          destination,
          '--repository',
          repository,
        ]),
      ),
    ).toContain(`destination already holds a toolkit: ${destination}`);

    const inside = releaseCheckout();
    git(inside.repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    // Proof: with the containment refusal removed the target wrote the whole toolkit, including the
    // vendored TypeScript closure, inside the checkout it had just verified clean; the negative
    // packed an archive at exit 0 and left the release tree dirty for every later run.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v0.0.1',
          '--destination',
          join(inside.repository, 'toolkit'),
          '--repository',
          inside.repository,
        ]),
      ),
    ).toContain('destination must be outside the checkout being released');

    const linked = releaseCheckout();
    git(linked.repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    mkdirSync(linked.destinationParent, { recursive: true });
    // A symlink whose name is outside the checkout but whose target is inside it.
    symlinkSync(
      join(linked.repository, 'inside'),
      join(linked.destinationParent, 'toolkit'),
      'dir',
    );
    mkdirSync(join(linked.repository, 'inside'), { recursive: true });
    // Proof: comparing a realpath'd repository with a merely resolved destination accepted this —
    // the target packed the whole toolkit into the checkout through the link, at exit 0.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v0.0.1',
          '--destination',
          join(linked.destinationParent, 'toolkit'),
          '--repository',
          linked.repository,
        ]),
      ),
    ).toContain('destination must be outside the checkout being released');

    const occupiedArchive = releaseCheckout();
    git(occupiedArchive.repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    write(join(occupiedArchive.destinationParent, 'wiki-v0.0.1.tar'), 'already published\n');
    // Proof: with the archive refusal removed a second run replaced a tar an operator may already
    // have published under its digest; the negative printed a fresh digest at exit 0 for a path
    // whose old bytes no one could recover.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v0.0.1',
          '--destination',
          join(occupiedArchive.destinationParent, 'toolkit'),
          '--repository',
          occupiedArchive.repository,
        ]),
      ),
    ).toContain('toolkit archive already exists');

    const drifted = releaseCheckout();
    write(join(drifted.repository, '.bun-version'), '1.3.9\n');
    git(drifted.repository, ['add', '--all']);
    git(drifted.repository, ['commit', '--message', 'drifted runtime']);
    git(drifted.repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    // Proof: with the runtime refusal removed this packed a bundle built by the running Bun under a
    // `toolkit.json` claiming 1.3.9, so a consumer's pinned runner could not reproduce the digest;
    // the negative received a complete archive at exit 0.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v0.0.1',
          '--destination',
          join(drifted.destinationParent, 'toolkit'),
          '--repository',
          drifted.repository,
        ]),
      ),
    ).toContain(`operator Bun differs from .bun-version: ${Bun.version} != 1.3.9`);
  });

  test('refuses an installed TypeScript that is not the one the tag pins', async () => {
    const { repository, destinationParent } = releaseCheckout();
    git(repository, ['tag', '--annotate', 'wiki-v0.0.1', '--message', 'toolkit']);
    // `node_modules/` is git-ignored, so this drift leaves the checkout clean: `git status
    // --porcelain` is empty and T4 sees nothing.
    write(
      join(repository, 'node_modules/typescript/package.json'),
      '{"name":"@typescript/typescript6","version":"5.9.9"}\n',
    );
    expect(git(repository, ['status', '--porcelain'])).toBe('');

    // Proof: with the pin join removed the target packed a `trusted-node-modules` built from this
    // stale install under a `toolkit.json` claiming the tag's commit, at exit 0 — and every
    // consumer preparing from that toolkit would load a TypeScript the tag never pinned.
    expect(
      await refusalMessage(
        releaseToolkit([
          '--tag',
          'wiki-v0.0.1',
          '--destination',
          join(destinationParent, 'toolkit'),
          '--repository',
          repository,
        ]),
      ),
    ).toContain('installed typescript is not the pinned one: 5.9.9 != 6.0.2');
  });

  test('the toolkit descriptor is a pure function of the bytes it describes', () => {
    const request = {
      tag: 'wiki-v1.2.3',
      sourceRevision: 'a'.repeat(40),
      bunVersion: '1.4.2',
      roleBytes: Object.fromEntries(
        toolkitRoles.map((role) => [role, new TextEncoder().encode(`${role}\n`)]),
      ) as Record<(typeof toolkitRoles)[number], Uint8Array>,
      trustedNodeModules: ['typescript', '@typescript/old'],
      trustedNodeModulesIdentity: 'c'.repeat(64),
    };
    const first = planToolkit(request);
    const second = planToolkit({
      ...request,
      trustedNodeModules: ['@typescript/old', 'typescript'],
    });

    expect(first.descriptor).toEqual(second.descriptor);
    expect(first.checksums).toEqual(second.checksums);
    const changed = planToolkit({
      ...request,
      roleBytes: { ...request.roleBytes, 'launcher.sh': new TextEncoder().encode('other\n') },
    });
    expect(changed.digests['launcher.sh']).not.toBe(first.digests['launcher.sh']);
  });
});

/**
 * Builds a toolkit directory of the shape {@link planToolkit} produces, carrying the real launcher,
 * snapshotter and validator bundle so the preparer's self-check runs the reviewed bytes.
 */
async function realToolkit(): Promise<string> {
  const directory = join(scratch('tool-wiki-toolkit-'), 'toolkit');
  mkdirSync(directory, { recursive: true });
  const roleBytes = {
    'launcher.sh': readFileSync(join(workspace, 'bin/tool-wiki-lint.sh')),
    'snapshotter.ts': readFileSync(
      join(workspace, 'apps/wiki/cli/src/policy/snapshot-validator.ts'),
    ),
    'validator.mjs': await buildValidatorBundle(join(workspace, 'apps/wiki/cli/src/cli.ts')),
    'prepare-activation.mjs': new TextEncoder().encode('// not executed by this test\n'),
  };
  for (const role of toolkitRoles) writeBytes(join(directory, role), roleBytes[role]);
  chmodSync(join(directory, 'launcher.sh'), 0o555);
  // A real closure, copied rather than symlinked, so `hashTrustedModules` pins the bytes the
  // preparer will read — the toolkit a consumer extracts carries files, not a link.
  const closure = join(directory, 'trusted-node-modules');
  const names = trustedModuleNames(join(workspace, 'node_modules'));
  copyTrustedModules(closure, join(workspace, 'node_modules'), names);
  const plan = planToolkit({
    tag: 'wiki-v0.0.1',
    sourceRevision: 'b'.repeat(40),
    bunVersion: Bun.version,
    roleBytes,
    trustedNodeModules: names,
    trustedNodeModulesIdentity: hashTrustedModules(closure),
  });
  writeBytes(join(directory, 'toolkit.json'), plan.descriptor);
  writeBytes(join(directory, 'SHA256SUMS'), plan.checksums);
  return directory;
}

describe('consumer activation from a toolkit', () => {
  test('a consumer prepares and certifies its own first activation with no base activation', async () => {
    const fixture = createRelocationCandidate();
    const toolkit = await realToolkit();
    const out = scratch('tool-wiki-consumer-');
    const strata = join(out, 'audit-strata.json');
    write(
      strata,
      `${JSON.stringify({
        strata: [
          {
            stratumId: 'risk.public-admission',
            sampleRateBps: 10000,
            disagreementTriggerBps: 10000,
          },
        ],
        obligations: { 'review.fixture.module': 'risk.public-admission' },
      })}\n`,
    );
    const review = join(out, 'review.json');
    write(
      review,
      `${JSON.stringify(
        auditReview(
          'review.fixture.module',
          fixture.candidateRevision,
          candidateIdentityAt(fixture.repository, fixture.candidateRevision),
        ),
      )}\n`,
    );

    const lines = prepareToolkitActivation([
      '--candidate-repository',
      fixture.repository,
      '--candidate-sha',
      fixture.candidateRevision,
      '--toolkit',
      toolkit,
      '--candidate-policy',
      'docs/wiki-policy/policy.json',
      '--candidate-mapping',
      'docs/wiki-policy/modules.json',
      '--review-record',
      review,
      '--audit-strata',
      strata,
      '--destination',
      join(out, 'activation'),
      '--work',
      join(out, 'work'),
      '--resource-lane',
      'lane.consumer-fixture',
      '--cwd-identity',
      'cwd.consumer-fixture',
    ]);

    expect(lines[0]).toBe(`toolkit activation: ${fixture.candidateRevision}`);
    expect(lines[1]).toContain('wiki-v0.0.1');
    const versionDirectory = lines
      .find((line) => line.startsWith('version directory: '))
      ?.slice('version directory: '.length);
    if (versionDirectory === undefined) throw new Error(lines.join('\n'));
    // The self-check inside the command already ran the toolkit's own launcher to
    // `certified: true`; this re-verifies the package an operator would publish.
    const verified = verifyActivation(versionDirectory);
    expect(verified.manifest.sourceRevision).toBe(fixture.candidateRevision);
    expect(lines.find((line) => line.startsWith('self-check: '))).toContain('"certified":true');

    // The command's own self-check scrubs `TOOL_WIKI_TRUSTED_NODE_MODULES`, so the launcher had to
    // default the closure to `<root>/trusted-node-modules`. Re-run the produced launcher here with
    // an environment that carries only `PATH`, so the default is the only thing that can resolve
    // it — this is the production proof of the launcher default, on a real archive.
    // Proof: with the default removed from `bin/tool-wiki-lint.sh` this exits 78 naming
    // `trusted-node-modules`; with the self-check's old explicit override it proved nothing.
    const defaulted = Bun.spawnSync(
      [
        'bash',
        join(out, 'activation', 'bootstrap-launcher.sh'),
        'committed',
        fixture.repository,
        fixture.candidateRevision,
      ],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          TOOL_WIKI_ACTIVATION_ROOT: join(out, 'activation'),
          TOOL_WIKI_REQUIRE_CERTIFIED: '1',
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    expect(defaulted.exitCode, defaulted.stderr.toString('utf8')).toBe(0);
    expect(JSON.parse(defaulted.stdout.toString('utf8'))).toMatchObject({ certified: true });
    expect(readFileSync(join(out, 'activation', 'toolkit-release'), 'utf8')).toContain(
      'wiki-v0.0.1 ',
    );
  }, 300_000);

  test('the bundled preparer runs standalone from a neutral cwd', async () => {
    const fixture = createRelocationCandidate();
    const toolkit = await realToolkit();
    const out = scratch('tool-wiki-bundled-preparer-');
    const neutral = scratch('tool-wiki-neutral-cwd-');
    write(
      join(out, 'audit-strata.json'),
      `${JSON.stringify({
        strata: [
          {
            stratumId: 'risk.public-admission',
            sampleRateBps: 10000,
            disagreementTriggerBps: 10000,
          },
        ],
        obligations: { 'review.fixture.module': 'risk.public-admission' },
      })}\n`,
    );
    write(
      join(out, 'review.json'),
      `${JSON.stringify(
        auditReview(
          'review.fixture.module',
          fixture.candidateRevision,
          candidateIdentityAt(fixture.repository, fixture.candidateRevision),
        ),
      )}\n`,
    );
    // The toolkit ships `prepare-activation.mjs`, and a consumer runs THAT, not this source tree.
    // Proof: `assertStandaloneValidator` only scans the bundle's imports; a bundle that resolved
    // anything at runtime — a workspace alias, a relative sibling, a bare package — would pass that
    // scan and fail only in the consumer's hands. Executing it is the check that cannot be faked.
    const bundle = join(out, 'prepare-activation.mjs');
    writeBytes(
      bundle,
      await buildValidatorBundle(
        join(workspace, 'apps/wiki/cli/src/policy/prepare-activation-cli.ts'),
      ),
    );

    const invocation = Bun.spawnSync(
      [
        'bun',
        bundle,
        '--candidate-repository',
        fixture.repository,
        '--candidate-sha',
        fixture.candidateRevision,
        '--toolkit',
        toolkit,
        '--candidate-policy',
        'docs/wiki-policy/policy.json',
        '--candidate-mapping',
        'docs/wiki-policy/modules.json',
        '--review-record',
        join(out, 'review.json'),
        '--audit-strata',
        join(out, 'audit-strata.json'),
        '--destination',
        join(out, 'activation'),
        '--work',
        join(out, 'work'),
        '--resource-lane',
        'lane.consumer-fixture',
        '--cwd-identity',
        'cwd.consumer-fixture',
      ],
      {
        // A neutral cwd and an environment with nothing but `PATH` and `HOME`: no workspace root,
        // no `node_modules` above it, no `TOOL_WIKI_*` left over from this repository's own gates.
        cwd: neutral,
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );

    const output = `${invocation.stdout.toString('utf8')}${invocation.stderr.toString('utf8')}`;
    expect(invocation.exitCode, output).toBe(0);
    expect(output).toContain(`toolkit activation: ${fixture.candidateRevision}`);
    expect(output).toContain('"certified":true');
  }, 300_000);

  test('a strata file that stratifies no policy review refuses by name', async () => {
    const fixture = createRelocationCandidate();
    const toolkit = await realToolkit();
    const out = scratch('tool-wiki-consumer-strata-');
    const strata = join(out, 'audit-strata.json');
    write(
      strata,
      `${JSON.stringify({
        strata: [
          {
            stratumId: 'risk.public-admission',
            sampleRateBps: 10000,
            disagreementTriggerBps: 10000,
          },
        ],
        obligations: { 'review.other.module': 'risk.public-admission' },
      })}\n`,
    );
    const review = join(out, 'review.json');
    write(
      review,
      `${JSON.stringify(
        auditReview(
          'review.fixture.module',
          fixture.candidateRevision,
          candidateIdentityAt(fixture.repository, fixture.candidateRevision),
        ),
      )}\n`,
    );

    // Proof: replacing this refusal with a default stratum invented the risk a review was audited
    // at, for a review the operator never stratified; the negative received a prepared activation.
    expect(() =>
      prepareToolkitActivation([
        '--candidate-repository',
        fixture.repository,
        '--candidate-sha',
        fixture.candidateRevision,
        '--toolkit',
        toolkit,
        '--candidate-policy',
        'docs/wiki-policy/policy.json',
        '--candidate-mapping',
        'docs/wiki-policy/modules.json',
        '--review-record',
        review,
        '--audit-strata',
        strata,
        '--destination',
        join(out, 'activation'),
        '--work',
        join(out, 'work'),
        '--resource-lane',
        'lane.consumer-fixture',
        '--cwd-identity',
        'cwd.consumer-fixture',
      ]),
    ).toThrow('audit strata name no stratum for review: review.fixture.module');
  }, 300_000);

  test('a toolkit whose runtime closure or Bun drifted refuses before anything is prepared', async () => {
    const out = scratch('tool-wiki-consumer-closure-');
    const candidate = join(out, 'candidate');
    mkdirSync(candidate, { recursive: true });
    const preparerArguments = (toolkit: string): string[] => [
      '--candidate-repository',
      candidate,
      '--candidate-sha',
      'a'.repeat(40),
      '--toolkit',
      toolkit,
      '--candidate-policy',
      'policy.json',
      '--candidate-mapping',
      'modules.json',
      '--review-record',
      join(out, 'absent-review.json'),
      '--audit-strata',
      join(out, 'absent-strata.json'),
      '--destination',
      join(out, 'activation'),
      '--work',
      join(out, 'work'),
      '--resource-lane',
      'lane.consumer-fixture',
      '--cwd-identity',
      'cwd.consumer-fixture',
    ];

    const altered = await realToolkit();
    const victim = join(altered, 'trusted-node-modules', 'typescript', 'package.json');
    chmodSync(victim, 0o644);
    writeFileSync(victim, `${readFileSync(victim, 'utf8')}\n`, 'utf8');
    // Proof: with the closure identity removed, the preparer copied the altered TypeScript out of
    // the toolkit into the consumer's archive as the validator's runtime and prepared a
    // self-certified activation at exit 0 — nothing else in the chain reads those bytes.
    expect(() => prepareToolkitActivation(preparerArguments(altered))).toThrow(
      'toolkit runtime closure differs from toolkit.json',
    );

    const drifted = await realToolkit();
    const descriptorPath = join(drifted, 'toolkit.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({ ...descriptor, bunVersion: '1.3.9' })}\n`,
      'utf8',
    );
    // Proof: with the runtime comparison removed the preparer bound a `validator.mjs` digest that
    // the consumer's own pinned Bun could not reproduce, and prepared at exit 0.
    expect(() => prepareToolkitActivation(preparerArguments(drifted))).toThrow(
      'toolkit was built with another Bun: 1.3.9',
    );
  }, 300_000);

  test('toolkit mode keeps the refusals that measure the candidate alone', async () => {
    const toolkit = await realToolkit();

    const uncovered = createRelocationCandidate();
    const uncoveredOut = scratch('tool-wiki-consumer-r14-');
    write(
      join(uncoveredOut, 'audit-strata.json'),
      `${JSON.stringify({
        strata: [
          {
            stratumId: 'risk.public-admission',
            sampleRateBps: 10000,
            disagreementTriggerBps: 10000,
          },
        ],
        obligations: { 'review.fixture.module': 'risk.public-admission' },
      })}\n`,
    );
    write(
      join(uncoveredOut, 'review.json'),
      `${JSON.stringify(
        auditReview(
          'review.fixture.module',
          uncovered.candidateRevision,
          candidateIdentityAt(uncovered.repository, uncovered.candidateRevision),
        ),
      )}\n`,
    );
    // The consumer's mapping still names the pre-move prefix, so it covers no boundary of its own
    // policy. Nothing about that needs an earlier activation to see.
    const strandedMapping = join(uncoveredOut, 'stranded-modules.json');
    write(
      strandedMapping,
      new TextDecoder().decode(
        encodeJson(fixtureMapping(uncovered.reviewedRevision, 'src/old', 'v2')),
      ),
    );
    git(uncovered.repository, ['config', 'user.email', 'consumer@example.test']);
    git(uncovered.repository, ['config', 'user.name', 'Consumer Fixture']);
    cpSync(strandedMapping, join(uncovered.repository, 'docs/wiki-policy/modules.json'));
    git(uncovered.repository, ['add', '--all']);
    git(uncovered.repository, ['commit', '--message', 'mapping that covers no boundary']);
    const strandedRevision = git(uncovered.repository, ['rev-parse', 'HEAD']);

    // Proof: with `assertMappingOwnership` guarded behind the base arm, toolkit mode skipped R14
    // entirely and this mapping — which owns nothing in the candidate's own tree — reached
    // `prepareActivation` and the self-check. R14 compares the candidate's mapping with its own
    // policy and tree, so a consumer's first activation needs it exactly as a relocation does.
    expect(() =>
      prepareToolkitActivation([
        '--candidate-repository',
        uncovered.repository,
        '--candidate-sha',
        strandedRevision,
        '--toolkit',
        toolkit,
        '--candidate-policy',
        'docs/wiki-policy/policy.json',
        '--candidate-mapping',
        'docs/wiki-policy/modules.json',
        '--review-record',
        join(uncoveredOut, 'review.json'),
        '--audit-strata',
        join(uncoveredOut, 'audit-strata.json'),
        '--destination',
        join(uncoveredOut, 'activation'),
        '--work',
        join(uncoveredOut, 'work'),
        '--resource-lane',
        'lane.consumer-fixture',
        '--cwd-identity',
        'cwd.consumer-fixture',
      ]),
    ).toThrow('module membership selects no candidate input: module.fixture.module');
  }, 300_000);

  test('a review record binding another candidate refuses through the toolkit preparer', async () => {
    const fixture = createRelocationCandidate();
    const toolkit = await realToolkit();
    const out = scratch('tool-wiki-consumer-review-');
    write(
      join(out, 'audit-strata.json'),
      `${JSON.stringify({
        strata: [
          {
            stratumId: 'risk.public-admission',
            sampleRateBps: 10000,
            disagreementTriggerBps: 10000,
          },
        ],
        obligations: { 'review.fixture.module': 'risk.public-admission' },
      })}\n`,
    );
    // A well-formed review of a DIFFERENT candidate identity: the shape passes, only the join fails.
    write(
      join(out, 'review.json'),
      `${JSON.stringify(
        auditReview('review.fixture.module', fixture.candidateRevision, 'a'.repeat(64)),
      )}\n`,
    );

    // Proof: admission checks a review only for shape and joins, so a consistent record for
    // another tree would certify. Removing this join let the preparer bind someone else's review
    // to this candidate's authority.
    expect(() =>
      prepareToolkitActivation([
        '--candidate-repository',
        fixture.repository,
        '--candidate-sha',
        fixture.candidateRevision,
        '--toolkit',
        toolkit,
        '--candidate-policy',
        'docs/wiki-policy/policy.json',
        '--candidate-mapping',
        'docs/wiki-policy/modules.json',
        '--review-record',
        join(out, 'review.json'),
        '--audit-strata',
        join(out, 'audit-strata.json'),
        '--destination',
        join(out, 'activation'),
        '--work',
        join(out, 'work'),
        '--resource-lane',
        'lane.consumer-fixture',
        '--cwd-identity',
        'cwd.consumer-fixture',
      ]),
    ).toThrow('review');
  }, 300_000);

  test('a toolkit role altered after packing refuses before anything is prepared', async () => {
    const fixture = createRelocationCandidate();
    const toolkit = await realToolkit();
    const out = scratch('tool-wiki-consumer-altered-');
    chmodSync(join(toolkit, 'launcher.sh'), 0o644);
    write(join(toolkit, 'launcher.sh'), '#!/usr/bin/env bash\nexit 0\n');

    // Proof: with the digest check removed this prepared an activation whose launcher role was the
    // altered file while `toolkit.json` still named the reviewed digest, so the self-check ran the
    // replacement and certified it.
    expect(() =>
      prepareToolkitActivation([
        '--candidate-repository',
        fixture.repository,
        '--candidate-sha',
        fixture.candidateRevision,
        '--toolkit',
        toolkit,
        '--candidate-policy',
        'docs/wiki-policy/policy.json',
        '--candidate-mapping',
        'docs/wiki-policy/modules.json',
        '--review-record',
        join(out, 'absent-review.json'),
        '--audit-strata',
        join(out, 'absent-strata.json'),
        '--destination',
        join(out, 'activation'),
        '--work',
        join(out, 'work'),
        '--resource-lane',
        'lane.consumer-fixture',
        '--cwd-identity',
        'cwd.consumer-fixture',
      ]),
    ).toThrow('toolkit role differs from toolkit.json: launcher.sh');
  });
});
