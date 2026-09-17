import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseOrThrow, type } from '@shared/validation';

import { OpaqueId } from '../contracts/records';
import { hashBytes } from '../evidence/content-manifest';
import { readCandidate } from '../inventory/read-candidate';
import { AuditStratum } from '../review/audit';
import { prepareActivation, selectActivation } from './activation';
import { toolkitRoles } from './release';
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
import { copyTrustedModules, hashTrustedModules, writeBytes } from './trusted-modules';

const flags = [
  'candidate-repository',
  'candidate-sha',
  'toolkit',
  'candidate-policy',
  'candidate-mapping',
  'review-record',
  'audit-strata',
  'destination',
  'work',
  'resource-lane',
  'cwd-identity',
] as const;
type Flag = (typeof flags)[number];

/**
 * Nothing defaults. A consumer's layout is its own: the policy and mapping paths, the review
 * record and the audit strata are all operator input, and a tool that guessed any of them would be
 * attesting on the operator's behalf.
 */
function readArguments(argv: readonly string[]): Record<Flag, string> {
  const selected = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(
        `usage: prepare-activation ${flags.map((flag) => `--${flag} <value>`).join(' ')}`,
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
    const value = selected.get(flag);
    if (value === undefined) throw new Error(`missing required flag: --${flag}`);
    resolved[flag] = value;
  }
  return resolved;
}

/** The operator's audit stratum table: the risk this repository accepts, never derived from code. */
const AuditStrataFile = type({
  strata: AuditStratum.array(),
  obligations: type({ '[string]': OpaqueId }),
}).onUndeclaredKey('reject');

/** The toolkit descriptor, read only to digest-check the roles beside it. */
const ToolkitDescriptor = type({
  schemaVersion: '1',
  tag: 'string>=1',
  sourceRevision: /^[0-9a-f]{40}$/,
  bunVersion: 'string>=1',
  roles: type({ '[string]': /^[0-9a-f]{64}$/ }),
  trustedNodeModules: 'string[]',
  trustedNodeModulesIdentity: /^[0-9a-f]{64}$/,
}).onUndeclaredKey('reject');

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
    gitText(
      repository,
      ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`],
      'unknown',
    );
  } catch (cause) {
    throw new RelocationRefusal('R1', `candidate revision is unknown: ${sha}`, { cause });
  }
  const head = gitText(repository, ['rev-parse', 'HEAD'], 'cannot resolve candidate HEAD');
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
  if (porcelain.length > 0) {
    throw new RelocationRefusal(
      'R3',
      `candidate checkout is dirty: ${porcelain
        .slice(0, 3)
        .map((line) => line.slice(3))
        .join(', ')}`,
    );
  }
}

function assertOutsideCandidate(repository: string, path: string, flag: string): string {
  const resolved = resolve(path);
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const existing = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
  const offset = relative(repository, existing);
  const escapes = offset === '..' || offset.startsWith(`..${sep}`);
  if (offset === '' || (!escapes && !isAbsolute(offset))) {
    throw new RelocationRefusal('R3', `${flag} must be outside the candidate repository: ${path}`);
  }
  return resolved;
}

interface Toolkit {
  readonly directory: string;
  readonly tag: string;
  readonly sourceRevision: string;
  readonly digest: string;
  readonly roleBytes: Readonly<Record<string, Uint8Array>>;
  readonly trustedNodeModules: readonly string[];
}

/**
 * Reads a released toolkit and joins everything it will hand a consumer back to its own
 * `toolkit.json`: each role's bytes, the whole runtime closure's digest, and the Bun that built
 * the bundles. `SHA256SUMS` covers the roles and the descriptor but no file below
 * `trusted-node-modules/`, so the closure digest is the only thing that pins those 24 MB.
 * @throws {@link RelocationRefusal} `R19` naming the role whose bytes differ, the closure whose
 * digest differs, or the Bun version the toolkit was built with.
 */
function readToolkit(directory: string): Toolkit {
  const canonical = realpathSync(directory);
  const descriptorBytes = readFileSync(join(canonical, 'toolkit.json'));
  const descriptor = parseOrThrow(
    ToolkitDescriptor,
    JSON.parse(new TextDecoder().decode(descriptorBytes)) as unknown,
  );
  const digests = new Map(Object.entries(descriptor.roles));
  const roleBytes: Record<string, Uint8Array> = {};
  for (const role of toolkitRoles) {
    const bytes = readFileSync(join(canonical, role));
    const expected = digests.get(role);
    // Proof: forcing this refusal false prepared an activation whose `launcher.sh` had been
    // replaced after packing while `toolkit.json` still named the reviewed digest; the altered-role
    // negative expected this message and received a prepared activation at exit 0.
    if (expected === undefined || hashBytes(bytes) !== expected) {
      throw new RelocationRefusal(
        'R19',
        `toolkit role differs from toolkit.json: ${role} (${hashBytes(bytes)} != ${expected ?? 'absent'})`,
      );
    }
    roleBytes[role] = bytes;
  }
  // Proof: forcing this refusal false prepared an activation whose Bun was not the one that built
  // the toolkit's `validator.mjs`, so the bundle digest the consumer binds could not be reproduced
  // by its own runner; the drifted-toolkit negative expected this message and received a prepared
  // activation at exit 0.
  if (descriptor.bunVersion !== Bun.version) {
    throw new RelocationRefusal(
      'R19',
      `toolkit was built with another Bun: ${descriptor.bunVersion} != ${Bun.version}`,
    );
  }
  const closure = join(canonical, 'trusted-node-modules');
  const closureIdentity = hashTrustedModules(closure);
  // Proof: forcing this refusal false copied an altered `typescript/package.json` out of the
  // toolkit into the consumer's archive as the validator's runtime; `SHA256SUMS` lists no file
  // below `trusted-node-modules`, so nothing else in the chain would have noticed. The negative
  // expected this message and received a prepared, self-certified activation at exit 0.
  if (closureIdentity !== descriptor.trustedNodeModulesIdentity) {
    throw new RelocationRefusal(
      'R19',
      `toolkit runtime closure differs from toolkit.json: ${closureIdentity} != ${descriptor.trustedNodeModulesIdentity}`,
    );
  }
  return {
    directory: canonical,
    tag: descriptor.tag,
    sourceRevision: descriptor.sourceRevision,
    digest: hashBytes(descriptorBytes),
    roleBytes,
    trustedNodeModules: descriptor.trustedNodeModules,
  };
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
  return {
    checkId: check.checkId,
    command: check.command,
    startedAt,
    endedAt,
    exitCode: invocation.exitCode,
    stdout: invocation.stdout,
    stderr: invocation.stderr,
    stdoutPath: writeBytes(join(work, 'checks', `${check.checkId}.stdout`), invocation.stdout),
    stderrPath: writeBytes(join(work, 'checks', `${check.checkId}.stderr`), invocation.stderr),
  };
}

function selfCheck(destination: string, repository: string, sha: string): string {
  // The runtime override is scrubbed, not set: a consumer's `trusted-wiki.yml` sets only the
  // activation root and lets the launcher default the closure to `<root>/trusted-node-modules`, so
  // a self-check that supplied the path would prove a configuration no consumer ever runs. The
  // operator's own environment is scrubbed too, because it may carry one from an unrelated gate.
  const inherited = { ...process.env };
  delete inherited['TOOL_WIKI_TRUSTED_NODE_MODULES'];
  const invocation = Bun.spawnSync(
    ['bash', join(destination, 'bootstrap-launcher.sh'), 'committed', repository, sha],
    {
      env: {
        ...inherited,
        TOOL_WIKI_ACTIVATION_ROOT: destination,
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
  // Proof: forcing this refusal false tarred an activation the toolkit's own launcher had just
  // refused to certify; the R20 negative expected exit 1 and received 0.
  if (invocation.exitCode !== 0 || !certified) {
    throw new RelocationRefusal(
      'R20',
      `prepared activation is not certified by the toolkit launcher: ${stdout.trim() || stderr.trim()}`,
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
 * Prepares a consumer repository's FIRST Tool Wiki activation from a released toolkit and the
 * consumer's own commit. The toolkit supplies launcher, snapshotter, validator and the TypeScript
 * runtime closure; this commit supplies policy, mapping and declarations; the operator supplies
 * the review record and the audit strata. Everything else is derived and then proved by running
 * the toolkit's own launcher to `certified: true` before any archive is written.
 *
 * A release certifies nothing for a consumer — see
 * `docs/adr/0026-a-wiki-release-is-a-toolkit-not-a-certification.md`.
 * @throws {@link RelocationRefusal} `R1`-`R3`, `R10`, `R14`-`R17` and `R19`-`R21`.
 */
export function prepareToolkitActivation(argv: readonly string[]): string[] {
  const options = readArguments(argv);
  const repository = realpathSync(resolve(options['candidate-repository']));
  const sha = options['candidate-sha'];
  const destination = assertOutsideCandidate(repository, options.destination, '--destination');
  const work = assertOutsideCandidate(repository, options.work, '--work');
  if (existsSync(join(destination, 'selected.json'))) {
    throw new Error(`activation destination already selects a version: ${destination}`);
  }
  const toolkit = readToolkit(resolve(options.toolkit));
  assertCommittedCandidate(repository, sha);
  assertPinnedRuntime(
    Bun.version,
    new TextDecoder().decode(showFile(repository, sha, '.bun-version')),
  );
  const policyBytes = showFile(repository, sha, options['candidate-policy']);
  const policy = readRelocationPolicy(policyBytes);
  const mappingBytes = showFile(repository, sha, options['candidate-mapping']);
  const declarations: CandidateFile[] = (policy.relationshipRequest?.declarationPaths ?? []).map(
    (path) => ({ path, bytes: showFile(repository, sha, path) }),
  );
  const strataFile = parseOrThrow(
    AuditStrataFile,
    JSON.parse(readFileSync(resolve(options['audit-strata']), 'utf8')) as unknown,
  );
  const sources: RelocationSources = {
    base: {
      kind: 'toolkit',
      validatorIdentity: hashBytes(toolkit.roleBytes['validator.mjs']),
      strata: strataFile.strata,
      obligationStrata: strataFile.obligations,
    },
    candidate: {
      sha,
      tree: readCandidate(repository, { kind: 'committed', revision: sha }),
      reviewed: readCandidate(repository, {
        kind: 'committed',
        revision: policy.pilot.sourceRevision,
      }),
      policyBytes,
      mappingBytes,
      mappingPath: options['candidate-mapping'],
      declarations,
      validatorIdentity: hashBytes(toolkit.roleBytes['validator.mjs']),
    },
  };
  const checks = planRelocationChecks(sources);
  const runs = checks.checks.map((check) => runCheck(repository, check, work));
  const plan = planRelocationActivation(
    sources,
    runs,
    JSON.parse(readFileSync(resolve(options['review-record']), 'utf8')) as unknown,
    {
      resourceLane: options['resource-lane'],
      cwdIdentity: options['cwd-identity'],
      toolIdentity: deriveToolIdentity(showFile(repository, sha, 'package.json'), Bun.version),
    },
  );
  const roles = join(work, 'roles');
  const roleSources = {
    authority: writeBytes(join(roles, 'authority.json'), plan.roles.authority),
    ciBinding: writeBytes(join(roles, 'ci-binding.json'), plan.roles.ciBinding),
    evidence: writeBytes(join(roles, 'evidence.json'), plan.roles.evidence),
    launcher: writeBytes(join(roles, 'launcher.sh'), toolkit.roleBytes['launcher.sh']),
    localBinding: writeBytes(join(roles, 'local-binding.json'), plan.roles.localBinding),
    mapping: writeBytes(join(roles, 'mapping.json'), plan.roles.mapping),
    policy: writeBytes(join(roles, 'policy.json'), plan.roles.policy),
    reviewReceipt: writeBytes(join(roles, 'review-receipt.json'), plan.roles.reviewReceipt),
    snapshotter: writeBytes(join(roles, 'snapshotter.ts'), toolkit.roleBytes['snapshotter.ts']),
    validator: writeBytes(join(roles, 'validator.mjs'), toolkit.roleBytes['validator.mjs']),
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
  const launcherPath = join(destination, 'bootstrap-launcher.sh');
  writeBytes(launcherPath, toolkit.roleBytes['launcher.sh']);
  chmodSync(launcherPath, 0o555);
  writeBytes(join(destination, 'launcher-path'), 'bootstrap-launcher.sh\n');
  writeBytes(join(destination, 'active-v1'), 'tool-wiki-active-v1\n');
  // Provenance only. Nothing on the admission path reads this descriptor; the transport digest
  // authenticates it exactly as it authenticates every other root file.
  writeBytes(join(destination, 'toolkit-release'), `${toolkit.tag} ${toolkit.digest}\n`);
  // The names come from `toolkit.json`, not from walking the directory: re-deriving them would let
  // an added package into the copy that the descriptor never named. `readToolkit` has already
  // proven the closure's bytes against that same descriptor.
  copyTrustedModules(
    join(destination, 'trusted-node-modules'),
    join(toolkit.directory, 'trusted-node-modules'),
    toolkit.trustedNodeModules,
  );
  const report = selfCheck(destination, repository, sha);
  const tarball = archive(
    destination,
    sha,
    gitText(
      repository,
      ['show', '--no-patch', '--format=%ct', sha],
      'cannot read candidate committer time',
    ),
  );
  // The origin only phrases the instruction below. It is an explicitly optional convenience, not
  // trusted state: a checkout with no remote still gets a complete, certified archive.
  const originInvocation = Bun.spawnSync(['git', '-C', repository, 'remote', 'get-url', 'origin'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const origin =
    originInvocation.exitCode === 0
      ? originInvocation.stdout.toString('utf8').trim()
      : 'your repository (no origin remote is configured)';
  const sha8 = sha.slice(0, 8);
  return [
    `toolkit activation: ${sha}`,
    `toolkit: ${toolkit.tag} ${toolkit.sourceRevision} (${toolkit.digest})`,
    `version directory: ${prepared.directory}`,
    `manifest identity: ${prepared.identity}`,
    `review: ${plan.ids.receiptId} journal ${plan.ids.journalId} — operator attestation, not re-derived`,
    `checks: ${runs.map((run) => `${run.checkId} exit ${String(run.exitCode)}`).join('; ') || '(none)'}`,
    `self-check: ${report}`,
    `archive: ${tarball.path}   sha256: ${tarball.digest}`,
    `publish this archive as a release of ${origin}, then in THAT repository:`,
    `gh variable set TOOL_WIKI_ACTIVATION_VERSION --body ${sha}`,
    `gh variable set TOOL_WIKI_ACTIVATION_ARCHIVE_URL --body <asset URL of tool-wiki-activation-${sha8}.tar>`,
    `gh variable set TOOL_WIKI_ACTIVATION_ARCHIVE_SHA256 --body ${tarball.digest}`,
  ];
}

if (import.meta.main) {
  try {
    const lines = prepareToolkitActivation(process.argv.slice(2));
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
