import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { hashBytes } from '../evidence/content-manifest';
import { assertStandaloneValidator } from './activation';
import {
  assertCleanCheckout,
  assertDestinationFree,
  assertDestinationOutside,
  assertPinnedTypeScript,
  assertReleaseRuntime,
  assertReleaseTag,
  assertTagAtHead,
  planToolkit,
  ReleaseRefusal,
  type ToolkitRole,
  toolkitRoles,
} from './release';
import {
  buildValidatorBundle,
  copyTrustedModules,
  hashTrustedModules,
  packageDirectory,
  trustedModuleNames,
  writeBytes,
} from './trusted-modules';

const flags = ['tag', 'destination', 'repository'] as const;
type Flag = (typeof flags)[number];

/**
 * `--repository` defaults to the git work tree containing the process's cwd, not to `.`: the Nx
 * target runs with `cwd: apps/wiki/cli`, and every role path this command reads is relative to the
 * repository root.
 */
function defaultRepository(): string {
  const invocation = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    throw new Error(
      `cannot locate the repository to release: ${invocation.stderr.toString('utf8').trim()}`,
    );
  }
  return invocation.stdout.toString('utf8').trim();
}

function readArguments(argv: readonly string[]): Record<Flag, string> {
  const selected = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(
        'usage: release --tag wiki-vMAJOR.MINOR.PATCH --destination <dir> [--repository <path>]',
      );
    }
    const flag = name.slice(2);
    if (!(flags as readonly string[]).includes(flag)) throw new Error(`unknown flag: ${name}`);
    if (selected.has(flag)) throw new Error(`repeated flag: ${name}`);
    selected.set(flag, value);
  }
  // The loop below assigns every member of `flags` or throws, and `flags` is the key set of that
  // record, so the cast is discharged before the value escapes this function.
  const resolved = {} as Record<Flag, string>;
  for (const flag of flags) {
    const value = selected.get(flag) ?? (flag === 'repository' ? defaultRepository() : undefined);
    if (value === undefined) throw new Error(`missing required flag: --${flag}`);
    resolved[flag] = value;
  }
  return resolved;
}

/**
 * The canonical path of `path`'s nearest existing ancestor, with the not-yet-created tail appended.
 * A destination that does not exist yet still has to be judged against the checkout, and a symlink
 * anywhere along the existing part would otherwise hide where it really lands.
 */
function existingRealPath(path: string): string {
  let ancestor = path;
  const tail: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return path;
    tail.unshift(ancestor.slice(parent.length + 1));
    ancestor = parent;
  }
  return [realpathSync(ancestor), ...tail].join('/');
}

function git(repository: string, argv: string[], subject: string): Uint8Array {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    throw new Error(`${subject}: ${invocation.stderr.toString('utf8').trim()}`);
  }
  return invocation.stdout;
}

function gitText(repository: string, argv: string[], subject: string): string {
  return new TextDecoder().decode(git(repository, argv, subject)).trim();
}

function tagCommit(repository: string, tag: string): string | undefined {
  const invocation = Bun.spawnSync(
    [
      'git',
      '-C',
      repository,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `refs/tags/${tag}^{commit}`,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  if (invocation.exitCode !== 0) return undefined;
  return invocation.stdout.toString('utf8').trim();
}

/**
 * Packs one Tool Wiki toolkit release: the roles that are identical for every repository and every
 * commit, plus the standalone preparer a consumer runs to produce its own per-commit activation.
 * The toolkit certifies nothing — see
 * `docs/adr/0026-a-wiki-release-is-a-toolkit-not-a-certification.md`.
 *
 * Every role is read from, or rebuilt out of, the checkout the tag names, and the tag must be at
 * HEAD of a clean tree, so `toolkit.json` describes exactly the commit it claims.
 * @throws {@link ReleaseRefusal} `T1`-`T8`.
 */
export async function releaseToolkit(argv: readonly string[]): Promise<string[]> {
  const options = readArguments(argv);
  const repository = realpathSync(resolve(options.repository));
  const tag = options.tag;
  assertReleaseTag(tag);
  const head = gitText(repository, ['rev-parse', 'HEAD'], 'cannot resolve HEAD');
  assertTagAtHead(tag, tagCommit(repository, tag), head);
  assertCleanCheckout(
    new TextDecoder()
      .decode(git(repository, ['status', '--porcelain'], 'cannot read repository status'))
      .split('\n'),
  );
  assertReleaseRuntime(Bun.version, readFileSync(join(repository, '.bun-version'), 'utf8'));
  const destination = resolve(options.destination);
  assertDestinationOutside(repository, existingRealPath(destination));
  // The design wrote `wiki-<tag>.tar`; the tag already starts with `wiki-`, so the archive is
  // `<tag>.tar` rather than `wiki-wiki-v0.0.1.tar`.
  const path = resolve(destination, '..', `${tag}.tar`);
  assertDestinationFree(
    destination,
    existsSync(join(destination, 'toolkit.json')),
    path,
    existsSync(path),
  );

  const roleBytes = {
    'launcher.sh': readFileSync(join(repository, 'bin/tool-wiki-lint.sh')),
    'snapshotter.ts': readFileSync(
      join(repository, 'apps/wiki/cli/src/policy/snapshot-validator.ts'),
    ),
    'validator.mjs': await buildValidatorBundle(join(repository, 'apps/wiki/cli/src/cli.ts')),
    'prepare-activation.mjs': await buildValidatorBundle(
      join(repository, 'apps/wiki/cli/src/policy/prepare-activation-cli.ts'),
    ),
  } satisfies Record<ToolkitRole, Uint8Array>;

  mkdirSync(destination, { recursive: true });
  for (const role of toolkitRoles) writeBytes(join(destination, role), roleBytes[role]);
  chmodSync(join(destination, 'launcher.sh'), 0o555);
  for (const role of ['validator.mjs', 'prepare-activation.mjs'] as const) {
    try {
      assertStandaloneValidator(join(destination, role));
    } catch (cause) {
      // No observed negative: `Bun.build` with no `external` configuration either inlines every
      // bare specifier or fails the build, so this repository cannot currently emit a bundle that
      // reaches here — see docs/findings/checks-that-cannot-fail.md. The guard stays because an
      // `external` entry or a loader change would reintroduce one silently, and a consumer would
      // then load unreviewed bytes at admission. `prepareActivation` applies the same rule to the
      // activation it builds, where it does have an observed negative (activation.ts).
      throw new ReleaseRefusal(
        'T6',
        `toolkit bundle is not standalone: ${role} (${cause instanceof Error ? cause.message : String(cause)})`,
        { cause },
      );
    }
  }
  const modulesRoot = join(repository, 'node_modules');
  // `node_modules/` is git-ignored, so the clean-tree check above never saw it. Join the closure
  // the toolkit is about to ship to the pin the tag committed, before copying 24 MB of it.
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const installed = JSON.parse(
    readFileSync(join(packageDirectory(modulesRoot, 'typescript'), 'package.json'), 'utf8'),
  ) as { version?: string };
  assertPinnedTypeScript(
    manifest.devDependencies?.['typescript'] ?? manifest.dependencies?.['typescript'],
    installed.version ?? '(absent)',
  );
  const trustedNodeModules = trustedModuleNames(modulesRoot);
  const closure = join(destination, 'trusted-node-modules');
  copyTrustedModules(closure, modulesRoot, trustedNodeModules);

  const plan = planToolkit({
    tag,
    sourceRevision: head,
    bunVersion: Bun.version,
    roleBytes,
    trustedNodeModules,
    // Hashed after the copy, so the descriptor pins the bytes the archive actually carries.
    trustedNodeModulesIdentity: hashTrustedModules(closure),
  });
  writeBytes(join(destination, 'toolkit.json'), plan.descriptor);
  writeBytes(join(destination, 'SHA256SUMS'), plan.checksums);

  const committerEpoch = gitText(
    repository,
    ['show', '--no-patch', '--format=%ct', head],
    'cannot read committer time',
  );
  const packed = Bun.spawnSync(
    [
      'tar',
      '--create',
      '--sort=name',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      `--mtime=@${committerEpoch}`,
      '--directory',
      destination,
      '--file',
      path,
      '.',
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  if (packed.exitCode !== 0) {
    throw new Error(`cannot write the toolkit archive: ${packed.stderr.toString('utf8').trim()}`);
  }
  const digest = hashBytes(readFileSync(path));
  return [
    `toolkit: ${tag} ${head}`,
    `bun: ${Bun.version}   trusted node modules: ${String(trustedNodeModules.length)}`,
    `archive: ${path}   sha256: ${digest}`,
    `a toolkit certifies no commit; each consumer runs prepare-activation.mjs for its own`,
  ];
}

if (import.meta.main) {
  try {
    const lines = await releaseToolkit(process.argv.slice(2));
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
