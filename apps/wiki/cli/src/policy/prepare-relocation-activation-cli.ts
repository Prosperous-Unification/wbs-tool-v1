import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseOrThrow, type } from '@shared/validation';

import { RelativePath } from '../contracts/records';
import { hashBytes } from '../evidence/content-manifest';
import { readCandidate } from '../inventory/read-candidate';
import { prepareActivation, selectActivation, verifyActivation } from './activation';
import {
  assertPinnedRuntime,
  type CandidateFile,
  type CheckRun,
  deriveToolIdentity,
  planRelocationActivation,
  planRelocationChecks,
  readRelocationPolicy,
  RelocationRefusal,
  type RelocationSources,
} from './relocation-activation';
import {
  buildValidatorBundle,
  copyTrustedModules,
  trustedModuleNames,
  writeBytes,
} from './trusted-modules';

const flags = [
  'candidate-repository',
  'candidate-sha',
  'base-activation',
  'review-record',
  'destination',
  'work',
  'candidate-policy',
  'candidate-launcher',
  'validator-entry',
  'resource-lane',
  'cwd-identity',
] as const;
type Flag = (typeof flags)[number];

/**
 * A flag with no default is required; the candidate's own layout supplies the rest. `resource-lane`
 * and `cwd-identity` deliberately have no default: they are operator attestation the check receipts
 * carry, and a tool that invented them would be attesting on the operator's behalf.
 */
const defaults: Partial<Record<Flag, string>> = {
  'candidate-policy': 'docs/wiki-policy/bootstrap-policy.json',
  'candidate-launcher': 'bin/tool-wiki-lint.sh',
  'validator-entry': 'apps/wiki/cli/src/cli.ts',
};

function readArguments(argv: readonly string[]): Record<Flag, string> {
  const selected = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || index + 1 >= argv.length) {
      const usage = flags
        .map((flag) => (flag in defaults ? `[--${flag} <value>]` : `--${flag} <value>`))
        .join(' ');
      throw new Error(`usage: prepare-relocation-activation ${usage}`);
    }
    const flag = name.slice(2);
    // Proof: forcing this refusal false let `--candidate-revision` pass unread and the command
    // prepared a whole activation from the defaults; the usage negative expected this message and
    // received `relocation activation: ...` at exit 0.
    if (!(flags as readonly string[]).includes(flag)) throw new Error(`unknown flag: ${name}`);
    if (selected.has(flag)) throw new Error(`repeated flag: ${name}`);
    selected.set(flag, value);
  }
  // The empty object is not yet a `Record<Flag, string>`; the loop below assigns every member
  // of `flags` or throws, and `flags` is the key set of that record, so the cast is discharged
  // before the value escapes this function.
  const resolved = {} as Record<Flag, string>;
  for (const flag of flags) {
    const value = selected.get(flag) ?? defaults[flag];
    // Proof: forcing this refusal false let an absent flag stay undefined; the missing-flag
    // negative observed `The "paths[0]" property must be of type string, got undefined`.
    if (value === undefined) throw new Error(`missing required flag: --${flag}`);
    resolved[flag] = value;
  }
  return resolved;
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

function showFile(repository: string, sha: string, path: string): Uint8Array {
  return git(repository, ['show', `${sha}:${path}`], `candidate file is absent at ${sha}: ${path}`);
}

function assertCommittedCandidate(repository: string, sha: string): void {
  try {
    // Proof: removing this resolution let an unknown revision reach the HEAD comparison; the R1
    // negative observed `candidate checkout is not at the candidate revision: HEAD <head> !=
    // 9999...` instead of the named refusal.
    gitText(
      repository,
      ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`],
      'unknown',
    );
  } catch (cause) {
    throw new RelocationRefusal('R1', `candidate revision is unknown: ${sha}`, { cause });
  }
  // An unreadable repository or an unborn HEAD is not an unknown revision, and saying so would
  // send the operator to the wrong fix; this failure keeps its own cause.
  const head = gitText(repository, ['rev-parse', 'HEAD'], 'cannot resolve candidate HEAD');
  // Proof: forcing this refusal false let the command read a checkout whose working files were
  // the parent commit's while every role came from the named SHA; the R2 negative observed
  // `ENOENT: failed to open root directory: <candidate>/src/new` from the validator rebuild.
  if (head !== sha) {
    throw new RelocationRefusal(
      'R2',
      `candidate checkout is not at the candidate revision: HEAD ${head} != ${sha}`,
    );
  }
  const porcelain = new TextDecoder()
    .decode(git(repository, ['status', '--porcelain'], 'cannot read candidate status'))
    .split('\n')
    .filter((line) => line.length > 0);
  // Proof: forcing this refusal false ran the candidate's checks against edited working files
  // while the receipts claimed the committed manifest, and the command prepared, certified and
  // tarred the activation; the R3 negative expected exit 1 and received 0.
  if (porcelain.length > 0) {
    const paths = porcelain
      .slice(0, 3)
      .map((line) => line.slice(3))
      .join(', ');
    throw new RelocationRefusal('R3', `candidate checkout is dirty: ${paths}`);
  }
}

/**
 * Keeps this command's own writes out of the tree it is about to measure: the rebuilt validator
 * lands in `--work` before the checks spawn, so a `--work` inside the candidate would make every
 * receipt describe a tree that is no longer the committed one.
 * @throws {@link RelocationRefusal} `R3`, the refusal a dirtied candidate would earn anyway.
 */
function assertOutsideCandidate(repository: string, path: string, flag: string): string {
  const resolved = resolve(path);
  const existing = ((): string => {
    let ancestor = resolved;
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return ancestor;
      ancestor = parent;
    }
    return realpathSync(ancestor);
  })();
  const offset = relative(repository, existing);
  const escapes = offset === '..' || offset.startsWith(`..${sep}`);
  // Proof: forcing this refusal false wrote the rebuilt validator and every JSON role into the
  // candidate tree and ran the checks against it; the refusal only arrived afterwards, from
  // `prepareActivation`'s own role-source guard — the negative observed `activation authority
  // source must be outside the candidate repository`.
  if (offset === '' || (!escapes && !isAbsolute(offset))) {
    throw new RelocationRefusal('R3', `${flag} must be outside the candidate repository: ${path}`);
  }
  return resolved;
}

function runCheck(
  repository: string,
  check: { checkId: string; command: string[] },
  work: string,
): CheckRun {
  const startedAt = new Date().toISOString();
  const invocation = Bun.spawnSync(check.command, {
    cwd: repository,
    env: process.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const endedAt = new Date().toISOString();
  const stdoutPath = writeBytes(join(work, 'checks', `${check.checkId}.stdout`), invocation.stdout);
  const stderrPath = writeBytes(join(work, 'checks', `${check.checkId}.stderr`), invocation.stderr);
  return {
    checkId: check.checkId,
    command: check.command,
    startedAt,
    endedAt,
    exitCode: invocation.exitCode,
    stdout: invocation.stdout,
    stderr: invocation.stderr,
    stdoutPath,
    stderrPath,
  };
}

interface BaseActivation {
  directory: string;
  policyBytes: Uint8Array;
  mappingBytes: Uint8Array;
  authorityBytes: Uint8Array;
  launcherBytes: Uint8Array;
  validatorIdentity: string;
  mappingPath: string;
  sourceRevision: string;
  identity: string;
}

/** The one field this command reads out of the base activation's own CI binding. */
const BaseBindingMapping = type({
  pilotModuleMapping: type({ candidatePath: RelativePath }),
});

function readBaseActivation(directory: string): BaseActivation {
  const verified = verifyActivation(directory);
  const roleBytes = (role: keyof typeof verified.manifest.roles): Uint8Array =>
    readFileSync(join(verified.directory, verified.manifest.roles[role]));
  // The base binding is trusted bytes `verifyActivation` has just re-hashed, but the candidate
  // mapping path it names selects a candidate file, so it is decoded rather than cast.
  const binding = parseOrThrow(
    BaseBindingMapping,
    JSON.parse(new TextDecoder().decode(roleBytes('ciBinding'))) as unknown,
  );
  return {
    directory: verified.directory,
    policyBytes: roleBytes('policy'),
    mappingBytes: roleBytes('mapping'),
    authorityBytes: roleBytes('authority'),
    launcherBytes: roleBytes('launcher'),
    validatorIdentity: verified.manifest.validatorIdentity,
    mappingPath: binding.pilotModuleMapping.candidatePath,
    sourceRevision: verified.manifest.sourceRevision,
    identity: verified.identity,
  };
}

function assembleArchiveRoot(
  destination: string,
  launcherBytes: Uint8Array,
  modulesRoot: string,
  names: readonly string[],
): void {
  const launcherPath = join(destination, 'bootstrap-launcher.sh');
  writeBytes(launcherPath, launcherBytes);
  chmodSync(launcherPath, 0o555);
  writeBytes(join(destination, 'launcher-path'), 'bootstrap-launcher.sh\n');
  writeBytes(join(destination, 'active-v1'), 'tool-wiki-active-v1\n');
  copyTrustedModules(join(destination, 'trusted-node-modules'), modulesRoot, names);
}

function selfCheck(destination: string, repository: string, sha: string): string {
  const invocation = Bun.spawnSync(
    ['bash', join(destination, 'bootstrap-launcher.sh'), 'committed', repository, sha],
    {
      env: {
        // The toolkit preparer scrubs this variable so its self-check exercises the launcher's
        // archive-root default. Here it stays: W5's proof table was written against this exact
        // environment, and changing it would retire negatives this change cannot re-witness. The
        // archive root carries the same directory either way, so the two agree on what is loaded.
        ...process.env,
        TOOL_WIKI_ACTIVATION_ROOT: destination,
        TOOL_WIKI_TRUSTED_NODE_MODULES: join(destination, 'trusted-node-modules'),
        TOOL_WIKI_REQUIRE_CERTIFIED: '1',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const stdout = invocation.stdout.toString('utf8');
  const stderr = invocation.stderr.toString('utf8');
  const certified = ((): boolean => {
    try {
      return (JSON.parse(stdout) as { certified?: unknown }).certified === true;
    } catch {
      return false;
    }
  })();
  // Proof: forcing this refusal false tarred an activation whose own observe-mode policy the
  // launcher had just refused to certify; the R20 negative expected exit 1 and received 0.
  if (invocation.exitCode !== 0 || !certified) {
    throw new RelocationRefusal(
      'R20',
      `prepared activation is not certified by its own launcher: ${stdout.trim() || stderr.trim()}`,
    );
  }
  return stdout.trim();
}

function archive(
  destination: string,
  sha: string,
  committerEpoch: string,
): { path: string; digest: string } {
  const path = resolve(destination, '..', `tool-wiki-activation-${sha.slice(0, 8)}.tar`);
  const invocation = Bun.spawnSync(
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
  if (invocation.exitCode !== 0) {
    throw new Error(
      `cannot write the activation archive: ${invocation.stderr.toString('utf8').trim()}`,
    );
  }
  return { path, digest: hashBytes(readFileSync(path)) };
}

/**
 * Prepares one Tool Wiki trusted activation from a candidate commit whose policy relocates
 * boundaries: it runs the candidate's own checks, derives every per-candidate role by hash,
 * records the operator's review record as the attestation it is, and proves the result by
 * running the produced launcher to `certified: true` before it writes the archive.
 *
 * A refusal before `prepareActivation` leaves only `--work`; a refusal at or after it (`R20`, a
 * failed `tar`) leaves the version directory and `selected.json` under `--destination`. That
 * destination is then poisoned on purpose: re-running against it refuses, so an operator picks a
 * fresh destination rather than publishing a root whose selection was never certified.
 * @throws {@link RelocationRefusal} `R1`-`R21`.
 */
export async function prepareRelocationActivation(argv: readonly string[]): Promise<string[]> {
  const options = readArguments(argv);
  const repository = realpathSync(resolve(options['candidate-repository']));
  const sha = options['candidate-sha'];
  const destination = assertOutsideCandidate(repository, options.destination, '--destination');
  const work = assertOutsideCandidate(repository, options.work, '--work');
  // Proof: forcing this refusal false prepared a second version into a root that already carried
  // `selected.json`, silently repointing it; the destination negative expected this message and
  // received `relocation activation: ...` at exit 0.
  if (existsSync(join(destination, 'selected.json'))) {
    throw new Error(`activation destination already selects a version: ${destination}`);
  }
  const base = readBaseActivation(resolve(options['base-activation']));
  assertCommittedCandidate(repository, sha);
  const policyBytes = showFile(repository, sha, options['candidate-policy']);
  const policy = readRelocationPolicy(policyBytes);
  const mappingBytes = showFile(repository, sha, base.mappingPath);
  const launcherBytes = showFile(repository, sha, options['candidate-launcher']);
  const entry = options['validator-entry'];
  const snapshotterPath = `${dirname(entry)}/policy/snapshot-validator.ts`;
  const snapshotterBytes = showFile(repository, sha, snapshotterPath);
  assertPinnedRuntime(
    Bun.version,
    new TextDecoder().decode(showFile(repository, sha, '.bun-version')),
  );
  const toolIdentity = deriveToolIdentity(showFile(repository, sha, 'package.json'), Bun.version);
  const declarations: CandidateFile[] = (policy.relationshipRequest?.declarationPaths ?? []).map(
    (path) => ({ path, bytes: showFile(repository, sha, path) }),
  );
  const tree = readCandidate(repository, { kind: 'committed', revision: sha });
  const reviewed = readCandidate(repository, {
    kind: 'committed',
    revision: policy.pilot.sourceRevision,
  });
  const roles = join(work, 'roles');
  const validatorBytes = await buildValidatorBundle(join(repository, entry), entry);
  writeBytes(join(roles, 'validator.mjs'), validatorBytes);
  const sources: RelocationSources = {
    base: {
      kind: 'base',
      policyBytes: base.policyBytes,
      mappingBytes: base.mappingBytes,
      authorityBytes: base.authorityBytes,
      validatorIdentity: base.validatorIdentity,
      validatorEntry: entry,
    },
    candidate: {
      sha,
      tree,
      reviewed,
      policyBytes,
      mappingBytes,
      mappingPath: base.mappingPath,
      declarations,
      validatorIdentity: hashBytes(validatorBytes),
    },
  };
  // Resolved before the checks run: a missing or linked runtime package refuses in a second
  // rather than after the candidate's whole test target.
  const modulesRoot = join(repository, 'node_modules');
  const trustedModules = trustedModuleNames(modulesRoot);
  const checks = planRelocationChecks(sources);
  const runs = checks.checks.map((check) => runCheck(repository, check, work));
  const plan = planRelocationActivation(
    sources,
    runs,
    JSON.parse(readFileSync(resolve(options['review-record']), 'utf8')) as unknown,
    {
      resourceLane: options['resource-lane'],
      cwdIdentity: options['cwd-identity'],
      toolIdentity,
    },
  );
  const roleSources = {
    authority: writeBytes(join(roles, 'authority.json'), plan.roles.authority),
    ciBinding: writeBytes(join(roles, 'ci-binding.json'), plan.roles.ciBinding),
    evidence: writeBytes(join(roles, 'evidence.json'), plan.roles.evidence),
    launcher: writeBytes(join(roles, 'launcher.sh'), launcherBytes),
    localBinding: writeBytes(join(roles, 'local-binding.json'), plan.roles.localBinding),
    mapping: writeBytes(join(roles, 'mapping.json'), plan.roles.mapping),
    policy: writeBytes(join(roles, 'policy.json'), plan.roles.policy),
    reviewReceipt: writeBytes(join(roles, 'review-receipt.json'), plan.roles.reviewReceipt),
    snapshotter: writeBytes(join(roles, 'snapshotter.ts'), snapshotterBytes),
    validator: join(roles, 'validator.mjs'),
  };
  mkdirSync(destination, { recursive: true });
  const prepared = prepareActivation({
    candidateRepository: repository,
    destination: join(destination, `activation-${sha}`),
    roleSources,
    sourceRevision: sha,
    policyIdentity: plan.identities.policy,
    mappingIdentity: plan.identities.mapping,
    validatorIdentity: plan.identities.validator,
    reviewReceiptIdentity: plan.identities.reviewReceipt,
  });
  selectActivation(destination, prepared.directory, prepared.identity);
  assembleArchiveRoot(destination, launcherBytes, modulesRoot, trustedModules);
  const report = selfCheck(destination, repository, sha);
  const committerEpoch = gitText(
    repository,
    ['show', '--no-patch', '--format=%ct', sha],
    'cannot read candidate committer time',
  );
  const tarball = archive(destination, sha, committerEpoch);
  const checksums = hashBytes(readFileSync(join(prepared.directory, 'checksums.sha256')));
  const sha8 = sha.slice(0, 8);
  const url = `https://github.com/Prosperous-Unification/wbs-tool-v1/releases/download/tool-wiki-activation-${sha8}/tool-wiki-activation-${sha8}.tar`;
  return [
    `relocation activation: ${sha}`,
    `base activation: ${base.sourceRevision} (${base.identity})`,
    `version directory: ${prepared.directory}`,
    `manifest identity: ${prepared.identity}            checksums identity: ${checksums}`,
    `validator identity: ${plan.identities.validator} (${plan.changedValidator ? 'changed' : 'unchanged'} vs base)   launcher: ${hashBytes(launcherBytes) === hashBytes(base.launcherBytes) ? 'unchanged' : 'changed'}`,
    `review: ${plan.ids.receiptId} scope ${plan.ids.trustScope} journal ${plan.ids.journalId} — operator attestation, not re-derived`,
    `checks: ${runs.map((run) => `${run.checkId} exit ${String(run.exitCode)} ${String(Date.parse(run.endedAt) - Date.parse(run.startedAt))}ms`).join('; ') || '(none)'}`,
    `self-check: ${report}`,
    `archive: ${tarball.path}   sha256: ${tarball.digest}`,
    `gh release create tool-wiki-activation-${sha8} ${tarball.path} --target ${sha} \\`,
    `  --title 'Tool Wiki activation ${sha8}' \\`,
    `  --notes 'Immutable Tool Wiki trusted activation archive for exact commit ${sha}. SHA-256: ${tarball.digest}. Relocation activation; base ${base.sourceRevision.slice(0, 8)}.'`,
    `gh variable set TOOL_WIKI_ACTIVATION_VERSION --body ${sha}`,
    `gh variable set TOOL_WIKI_ACTIVATION_ARCHIVE_URL --body ${url}`,
    `gh variable set TOOL_WIKI_ACTIVATION_ARCHIVE_SHA256 --body ${tarball.digest}`,
  ];
}

if (import.meta.main) {
  try {
    const lines = await prepareRelocationActivation(process.argv.slice(2));
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
