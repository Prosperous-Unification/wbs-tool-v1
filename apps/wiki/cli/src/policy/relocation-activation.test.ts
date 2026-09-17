import { Buffer } from 'node:buffer';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { verifyActivation } from './activation';
import {
  assertPinnedRuntime,
  type CheckRun,
  deriveToolIdentity,
  planRelocationActivation,
  planRelocationChecks,
  type RelocationSources,
} from './relocation-activation';
import {
  auditReview,
  type BaseActivation,
  candidateIdentityAt,
  createRelocationCandidate,
  disposeRelocationFixtures,
  encodeJson,
  entriesAt,
  fixtureMapping,
  fixturePolicy,
  prepareBaseActivation,
  type RelocationFixture,
  relocationSources,
  write,
} from './relocation-fixtures';

const cliPath = join(import.meta.dir, 'prepare-relocation-activation-cli.ts');

interface CommandInvocation {
  exitCode: number;
  output: string;
}

interface PolicyShape {
  minimumMode: string;
  boundaries: {
    boundaryId: string;
    selector: { kind: string; value: string };
    sourceSelector?: { kind: string; value: string };
    baselineEntries: { path: string; mode: string; blob: string }[];
  }[];
  obligations: {
    obligationId: string;
    boundaryId: string;
    checkIds: string[];
    reviewIds: string[];
  }[];
  pilot: { sourceRevision: string };
}

interface MappingShape {
  sourceRevision: string;
  modules: {
    moduleId: string;
    name: string;
    memberships: { kind: string; prefix?: string; path?: string; exclusions?: string[] }[];
    predecessorModuleIds: string[];
    indexPath: string;
    externalConsumers: { kind: string };
  }[];
}

interface AuthorityShape {
  audit: { obligations: { obligationId: string; riskStratum: string; subject: unknown }[] };
}

function decodePolicy(bytes: Uint8Array): PolicyShape {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as PolicyShape;
}

function decodeAuthority(bytes: Uint8Array): AuthorityShape {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as AuthorityShape;
}

function runCommand(argv: readonly string[]): CommandInvocation {
  const invocation = Bun.spawnSync([process.execPath, 'run', cliPath, ...argv], {
    env: { ...process.env, NX_DAEMON: 'false' },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exitCode: invocation.exitCode,
    output: `${Buffer.from(invocation.stdout).toString('utf8')}${Buffer.from(invocation.stderr).toString('utf8')}`,
  };
}

let shared: { fixture: RelocationFixture; base: BaseActivation } | undefined;

function sharedRelocation(): { fixture: RelocationFixture; base: BaseActivation } {
  if (shared === undefined) {
    const fixture = createRelocationCandidate();
    shared = { fixture, base: prepareBaseActivation(fixture) };
  }
  return shared;
}

function sources(overrides: Parameters<typeof relocationSources>[2] = {}): RelocationSources {
  const { fixture, base } = sharedRelocation();
  return relocationSources(fixture, base, overrides);
}

function checkRun(exitCode = 0): CheckRun {
  return {
    checkId: 'check.fixture.module',
    command: ['bunx', 'nx', 'run', 'fixture:check', '--skip-nx-cache'],
    startedAt: '2026-09-16T10:00:00.000Z',
    endedAt: '2026-09-16T10:00:01.000Z',
    exitCode,
    stdout: new TextEncoder().encode('ok\n'),
    stderr: new Uint8Array(),
    stdoutPath: '/work/checks/check.fixture.module.stdout',
    stderrPath: '/work/checks/check.fixture.module.stderr',
  };
}

const attestation = {
  resourceLane: 'fixture.lane',
  cwdIdentity: 'fixture.repository',
  toolIdentity: 'a'.repeat(64),
};

function planWithReview(
  reviewMutation: (review: Record<string, unknown>) => void = () => undefined,
  exitCode = 0,
): void {
  const { fixture } = sharedRelocation();
  const identity = candidateIdentityAt(fixture.repository, fixture.candidateRevision);
  const review = auditReview(
    'review.fixture.module',
    fixture.candidateRevision,
    identity,
  ) as Record<string, unknown>;
  reviewMutation(review);
  planRelocationActivation(sources(), [checkRun(exitCode)], review, attestation);
}

interface CommandFixture {
  fixture: RelocationFixture;
  base: BaseActivation;
  destination: string;
  reviewPath: string;
}

function commandFixture(options: { fixture?: RelocationFixture } = {}): CommandFixture {
  const fixture = options.fixture ?? createRelocationCandidate();
  const base = prepareBaseActivation(fixture);
  const destination = join(fixture.workspace, 'relocation-root');
  const reviewPath = join(fixture.workspace, 'review.json');
  write(
    reviewPath,
    `${JSON.stringify(
      auditReview(
        'review.fixture.module',
        fixture.candidateRevision,
        candidateIdentityAt(fixture.repository, fixture.candidateRevision),
      ),
    )}\n`,
  );
  return { fixture, base, destination, reviewPath };
}

function runPreparation(
  prepared: CommandFixture,
  overrides: readonly string[] = [],
  sha = prepared.fixture.candidateRevision,
  entry = 'src/new/cli.ts',
): CommandInvocation {
  return runCommand(
    withOverrides(
      [
        '--candidate-repository',
        prepared.fixture.repository,
        '--candidate-sha',
        sha,
        '--base-activation',
        prepared.base.directory,
        '--review-record',
        prepared.reviewPath,
        '--destination',
        prepared.destination,
        '--work',
        join(prepared.fixture.workspace, 'relocation-work'),
        '--candidate-policy',
        'docs/wiki-policy/policy.json',
        '--validator-entry',
        entry,
        '--resource-lane',
        'fixture.lane',
        '--cwd-identity',
        'fixture.repository',
      ],
      overrides,
    ),
  );
}

/** Applies `--flag value` pairs over the default argv, replacing a flag rather than repeating it. */
function withOverrides(argv: readonly string[], overrides: readonly string[]): string[] {
  const applied = [...argv];
  for (let index = 0; index < overrides.length; index += 2) {
    const flag = overrides[index];
    const at = applied.indexOf(flag);
    if (at < 0) applied.push(flag, overrides[index + 1]);
    else applied[at + 1] = overrides[index + 1];
  }
  return applied;
}

function archivePath(fixture: RelocationFixture): string {
  return join(
    fixture.workspace,
    `tool-wiki-activation-${fixture.candidateRevision.slice(0, 8)}.tar`,
  );
}

afterAll(disposeRelocationFixtures);

describe('relocation activation prepared from a candidate SHA', () => {
  test('prepares an activation the candidate certifies through its own launcher', () => {
    const prepared = commandFixture();
    const invocation = runPreparation(prepared);

    expect(invocation.exitCode, invocation.output).toBe(0);
    const directory = join(
      prepared.destination,
      `activation-${prepared.fixture.candidateRevision}`,
    );
    const verified = verifyActivation(directory);
    expect(verified.manifest.sourceRevision).toBe(prepared.fixture.candidateRevision);
    expect(invocation.output).toContain(`version directory: ${directory}`);
    expect(invocation.output).toContain('check.fixture.module exit 0');
    // The load-bearing assertion: this line is the stdout of the archive root's own
    // `bootstrap-launcher.sh`, run with TOOL_WIKI_REQUIRE_CERTIFIED=1 against the candidate the
    // activation was prepared from. Proof: forcing the self-check's refusal false (see the
    // observe-mode negative below) tarred an activation the same launcher had just refused.
    expect(invocation.output).toContain('"certified":true');
    // Proof: removing the comparison against the base `launcher` role left the output with no
    // launcher disposition at all, and this assertion observed the validator line alone.
    expect(invocation.output).toContain('launcher: unchanged');
    const launcher = join(prepared.destination, 'bootstrap-launcher.sh');
    expect(statSync(launcher).mode & 0o777).toBe(0o555);
    expect(
      existsSync(join(prepared.destination, 'trusted-node-modules', 'typescript', 'package.json')),
    ).toBe(true);
    expect(
      existsSync(join(prepared.destination, 'trusted-node-modules', '@typescript', 'old')),
    ).toBe(true);
    const archive = archivePath(prepared.fixture);
    expect(existsSync(archive)).toBe(true);
    const digest = Buffer.from(Bun.spawnSync(['sha256sum', archive], { stdout: 'pipe' }).stdout)
      .toString('utf8')
      .slice(0, 64);
    // Proof: hashing the archive's path instead of its bytes printed a digest this comparison
    // did not match — the digest an operator pastes into the release notes and the
    // TOOL_WIKI_ACTIVATION_ARCHIVE_SHA256 variable.
    expect(invocation.output).toContain(`sha256: ${digest}`);
  }, 300_000);

  test('refuses a boundary the candidate moved without a source selector', () => {
    const { fixture } = sharedRelocation();

    // Proof: forcing the R5 refusal false planned a complete activation for a boundary that moved
    // with no recorded source selector; this negative received `Received function did not throw`.
    expect(() =>
      planRelocationChecks(sources({ policyBytes: encodeJson(fixturePolicy(fixture, 'src/new')) })),
    ).toThrow(
      'boundary moved without sourceSelector: boundary.fixture.module (prefix src/old -> prefix src/new)',
    );
  }, 300_000);

  test('refuses a candidate revision the repository does not carry', () => {
    const prepared = commandFixture({ fixture: sharedRelocation().fixture });
    const destination = join(prepared.fixture.workspace, 'unknown-destination');
    mkdirSync(destination, { recursive: true });

    const invocation = runCommand([
      '--candidate-repository',
      prepared.fixture.repository,
      '--candidate-sha',
      '9'.repeat(40),
      '--base-activation',
      prepared.base.directory,
      '--review-record',
      prepared.reviewPath,
      '--destination',
      destination,
      '--work',
      join(prepared.fixture.workspace, 'unknown-work'),
      '--candidate-policy',
      'docs/wiki-policy/policy.json',
      '--validator-entry',
      'src/new/cli.ts',
      '--resource-lane',
      'fixture.lane',
      '--cwd-identity',
      'fixture.repository',
    ]);

    expect(invocation.exitCode, invocation.output).toBe(1);
    // Proof: removing the revision resolution let the unknown SHA reach the HEAD comparison; this
    // negative observed `candidate checkout is not at the candidate revision: HEAD <head> !=
    // 9999...` instead of the refusal.
    expect(invocation.output).toContain(`candidate revision is unknown: ${'9'.repeat(40)}`);
    expect(readdirSync(destination)).toEqual([]);
  }, 300_000);

  test('refuses a candidate whose selector still names the pre-move directory', () => {
    const { fixture } = sharedRelocation();

    // Proof: forcing the R10 refusal false planned an activation whose policy still selected
    // `src/old`; this negative then observed `module memberships do not equal any boundary's
    // selected members: module.fixture.module`.
    expect(() =>
      planRelocationChecks(
        sources({ policyBytes: encodeJson(fixturePolicy(fixture, 'src/old', 'src/old')) }),
      ),
    ).toThrow(
      'trusted boundary selector selects no candidate input: boundary.fixture.module ' +
        '(selector prefix src/old); if the candidate moved these files, prepare a relocation ' +
        'activation from the candidate SHA: see docs/runbook-tool-wiki-activation.md#relocation',
    );
  }, 300_000);

  test('refuses a candidate policy that changes anything but its selectors', () => {
    const { fixture } = sharedRelocation();
    const policy = fixturePolicy(fixture, 'src/new', 'src/old') as unknown as PolicyShape;
    policy.obligations.push({
      obligationId: 'obligation.fixture.injected',
      boundaryId: 'boundary.fixture.module',
      checkIds: [],
      reviewIds: [],
    });

    // Proof: forcing the R4 comparison false let the added obligation ride into the plan; this
    // negative received `Received function did not throw`.
    expect(() => planRelocationChecks(sources({ policyBytes: encodeJson(policy) }))).toThrow(
      'candidate policy is not a relocation of the base policy: obligations[1]',
    );
  }, 300_000);

  test('refuses a source selector that names neither the base selector nor its baseline', () => {
    const { fixture, base } = sharedRelocation();
    const moved = decodePolicy(readFileSync(join(base.directory, 'artifacts/policy.json')));
    const third = fixturePolicy(fixture, 'src/new', 'src/old') as unknown as PolicyShape;
    third.boundaries[0].sourceSelector = { kind: 'prefix', value: 'src/third' };

    // Proof: forcing the R6 comparison false let the boundary claim `src/third`; this negative
    // then observed `boundary sourceSelector selects nothing in the base baseline:
    // boundary.fixture.module`.
    expect(() => planRelocationChecks(sources({ policyBytes: encodeJson(third) }))).toThrow(
      'boundary sourceSelector differs from the base selector: boundary.fixture.module',
    );

    const rebased = (target: PolicyShape): PolicyShape => {
      target.boundaries[0].baselineEntries = entriesAt(
        fixture.repository,
        fixture.reviewedRevision,
      ).filter(({ path }) => path === 'nx.json');
      return target;
    };
    const candidate = rebased(
      fixturePolicy(fixture, 'src/new', 'src/old') as unknown as PolicyShape,
    );
    // Proof: forcing the R7 refusal false let a boundary relocate a baseline outside the base
    // selector entirely; this negative received `Received function did not throw`.
    expect(() =>
      planRelocationChecks(
        sources({
          basePolicyBytes: encodeJson(rebased(moved)),
          policyBytes: encodeJson(candidate),
        }),
      ),
    ).toThrow(
      'boundary sourceSelector selects nothing in the base baseline: boundary.fixture.module',
    );
  }, 300_000);

  test('refuses a pilot source revision bumped past the move', () => {
    const { fixture, base } = sharedRelocation();
    const bump = (policy: PolicyShape): PolicyShape => {
      policy.pilot.sourceRevision = fixture.candidateRevision;
      return policy;
    };
    const basePolicy = bump(
      decodePolicy(readFileSync(join(base.directory, 'artifacts/policy.json'))),
    );
    const candidatePolicy = bump(
      fixturePolicy(fixture, 'src/new', 'src/old') as unknown as PolicyShape,
    );

    // Proof: forcing the R8 reconciliation false planned an activation whose `reviewed` inputs
    // held none of the boundary's baselines, so admission's `reviewedBinds` would silently fail;
    // this negative then observed `mapping source revision differs from pilot policy`.
    expect(() =>
      planRelocationChecks(
        sources({
          basePolicyBytes: encodeJson(basePolicy),
          policyBytes: encodeJson(candidatePolicy),
          reviewedRevision: fixture.candidateRevision,
        }),
      ),
    ).toThrow(
      `boundary baseline is absent from the reviewed snapshot ${fixture.candidateRevision}: ` +
        'boundary.fixture.module src/old/README.md',
    );
  }, 300_000);

  test('refuses a mapping pinned to another source revision', () => {
    const { fixture } = sharedRelocation();
    const mapping = fixtureMapping(
      fixture.candidateRevision,
      'src/new',
      'relocation-fixture-v2',
    ) as unknown as MappingShape;

    // Proof: forcing the R9 comparison false planned an activation admission would refuse at
    // `trusted pilot module mapping source does not match pilot policy`; this negative received
    // `Received function did not throw`.
    expect(() => planRelocationChecks(sources({ mappingBytes: encodeJson(mapping) }))).toThrow(
      `mapping source revision differs from pilot policy: ${fixture.candidateRevision} != ${fixture.reviewedRevision}`,
    );
  }, 300_000);

  test('refuses a module lineage the base activation cannot resolve', () => {
    const { fixture } = sharedRelocation();
    const mapping = (): MappingShape =>
      fixtureMapping(
        fixture.reviewedRevision,
        'src/new',
        'relocation-fixture-v2',
      ) as unknown as MappingShape;
    const unresolved = mapping();
    unresolved.modules[0].predecessorModuleIds = ['module.fixture.absent'];
    // Proof: forcing the R11 resolution false let a module name a predecessor no base activation
    // ever carried; this negative received `Received function did not throw`.
    expect(() => planRelocationChecks(sources({ mappingBytes: encodeJson(unresolved) }))).toThrow(
      'module names unresolved predecessor: module.fixture.module -> module.fixture.absent',
    );

    const added = mapping();
    added.modules.push({
      moduleId: 'module.fixture.added',
      name: 'Added with no lineage',
      memberships: [{ kind: 'path', path: 'nx.json' }],
      predecessorModuleIds: [],
      indexPath: 'nx.json',
      externalConsumers: { kind: 'none' },
    });
    // Proof: forcing the R12 refusal false let `module.fixture.added` appear with no lineage; this
    // negative then observed `module memberships do not equal any boundary's selected members:
    // module.fixture.added`.
    expect(() => planRelocationChecks(sources({ mappingBytes: encodeJson(added) }))).toThrow(
      'module is new to the mapping and names no predecessor: module.fixture.added',
    );

    const dropped = mapping();
    dropped.modules = [];
    // Proof: forcing the R13 refusal false let the candidate silently retire the reviewed
    // boundary's module; this negative then observed `boundary has no module:
    // boundary.fixture.module`.
    expect(() => planRelocationChecks(sources({ mappingBytes: encodeJson(dropped) }))).toThrow(
      'base module has no successor in the candidate mapping: module.fixture.module',
    );
  }, 300_000);

  test('refuses memberships that do not land on exactly one boundary', () => {
    const { fixture } = sharedRelocation();
    const mapping = fixtureMapping(
      fixture.reviewedRevision,
      'src/new',
      'relocation-fixture-v2',
    ) as unknown as MappingShape;
    mapping.modules[0].memberships = [
      { kind: 'directory-prefix', prefix: 'src/new', exclusions: ['src/new/project.json'] },
    ];
    // Proof: forcing the R14 ownership comparison false let a mapping that excluded a boundary
    // member reach `boundaries[0]`; this negative observed `undefined is not an object (evaluating
    // 'boundaries[0].boundaryId')`.
    expect(() => planRelocationChecks(sources({ mappingBytes: encodeJson(mapping) }))).toThrow(
      "module memberships do not equal any boundary's selected members: module.fixture.module",
    );

    const empty = fixtureMapping(
      fixture.reviewedRevision,
      'src/new',
      'relocation-fixture-v2',
    ) as unknown as MappingShape;
    empty.modules = [];
    // Proof: forcing the R14 completeness check false let a boundary with no module at all plan
    // an activation; this negative received `Received function did not throw`.
    expect(() =>
      planRelocationChecks(
        sources({
          baseMappingBytes: encodeJson({ ...empty, mappingVersion: 'relocation-fixture-v1' }),
          mappingBytes: encodeJson(empty),
        }),
      ),
    ).toThrow('boundary has no module: boundary.fixture.module');
  }, 300_000);

  test('refuses a check the candidate declares no executable target for', () => {
    const declarations = {
      schemaVersion: 1,
      declarationId: 'declaration.relocation-fixture',
      selectorVersion: 1,
      coverage: 'selected-facts-only',
      facts: [],
      edges: [],
    };
    const base = sources();
    const withoutFacts: RelocationSources = {
      base: base.base,
      candidate: {
        ...base.candidate,
        declarations: [
          { path: 'docs/wiki-policy/relationships.json', bytes: encodeJson(declarations) },
        ],
      },
    };

    // Proof: forcing the R15 refusal false let a check with no declared target reach command
    // derivation; this negative observed `undefined is not an object (evaluating 'fact.project')`.
    expect(() => planRelocationChecks(withoutFacts)).toThrow(
      'check has no executable nx-target fact: check.fixture.module',
    );
    // The same derivation with the fact present: one check, the Nx command the candidate declares,
    // and no skip channel, because `printf` reports none.
    expect(planRelocationChecks(sources()).checks).toEqual([
      {
        checkId: 'check.fixture.module',
        command: ['bunx', 'nx', 'run', 'fixture:check', '--skip-nx-cache'],
        skipChannel: 'none',
      },
    ]);
  }, 300_000);

  test('refuses a membership that selects nothing at the candidate revision', () => {
    const { fixture } = sharedRelocation();
    const mapping = fixtureMapping(
      fixture.reviewedRevision,
      'src/new',
      'relocation-fixture-v2',
    ) as unknown as MappingShape;
    mapping.modules[0].memberships = [
      { kind: 'directory-prefix', prefix: 'src/old', exclusions: [] },
    ];

    // Proof: forcing this refusal false let a mapping left at the pre-move prefix own nothing at
    // all; this negative then observed `module memberships do not equal any boundary's selected
    // members: module.fixture.module`.
    expect(() => planRelocationChecks(sources({ mappingBytes: encodeJson(mapping) }))).toThrow(
      'module membership selects no candidate input: module.fixture.module (src/old)',
    );
  }, 300_000);

  test('refuses a validator entry the candidate cannot rebuild', () => {
    const prepared = commandFixture({ fixture: sharedRelocation().fixture });

    const invocation = runPreparation(
      prepared,
      [],
      prepared.fixture.candidateRevision,
      'src/new/absent.ts',
    );

    expect(invocation.exitCode, invocation.output).toBe(1);
    // Proof: rethrowing Bun's build failure unwrapped named neither the entry nor the candidate;
    // this negative observed `Bundle failed`.
    expect(invocation.output).toContain(
      'cannot rebuild the candidate validator from src/new/absent.ts',
    );
  }, 300_000);

  test('refuses a validator entry the policy does not select', () => {
    // Proof: forcing the R18 refusal false let the repository-root `nx.json` become the
    // activation's validator entry; this negative received `Received function did not throw`.
    expect(() => planRelocationChecks(sources({ validatorEntry: 'nx.json' }))).toThrow(
      'validator entry is outside the enforced boundary: nx.json',
    );
  }, 300_000);

  test('refuses an operator runtime other than the candidate pin', () => {
    // Proof: forcing this refusal false accepted Bun 1.4.1 against the candidate's pinned 1.4.2;
    // the negative received `Received function did not throw`.
    expect(() => {
      assertPinnedRuntime('1.4.1', '1.4.2\n');
    }).toThrow("operator Bun differs from the candidate's .bun-version: 1.4.1 != 1.4.2");
    expect(() => {
      assertPinnedRuntime('1.4.2', '1.4.2\n');
    }).not.toThrow();
  });

  test('refuses a candidate package manifest with no toolchain pin', () => {
    // Proof: forcing this refusal false let an absent pin reach the identity hash; the negative
    // observed `canonical JSON cannot serialize undefined` instead of this named refusal.
    expect(() =>
      deriveToolIdentity(encodeJson({ devDependencies: { nx: '23.2.0' } }), '1.4.2'),
    ).toThrow('candidate package manifest has no typescript pin');
    expect(
      deriveToolIdentity(
        encodeJson({ devDependencies: { nx: '23.2.0', typescript: 'npm:x@1' } }),
        '1.4.2',
      ),
    ).toHaveLength(64);
  });

  test('refuses a failed check instead of recording it', () => {
    const prepared = commandFixture({ fixture: createRelocationCandidate({ failingCheck: true }) });
    const invocation = runPreparation(prepared);

    expect(invocation.exitCode, invocation.output).toBe(1);
    // Proof: forcing the R16 refusal false recorded the failing Nx target as `status: passed`,
    // and the command prepared, certified and tarred the whole activation; this negative expected
    // exit 1 and received 0.
    expect(invocation.output).toContain('check failed: check.fixture.module exit 1; stdout ');
    expect(existsSync(archivePath(prepared.fixture))).toBe(false);

    // Proof: the same injection observed through the planner: with the refusal forced false, an
    // `exit 3` run produced a `status: passed` receipt instead of this refusal.
    expect(() => {
      planWithReview(() => undefined, 3);
    }).toThrow(
      'check failed: check.fixture.module exit 3; stdout /work/checks/check.fixture.module.stdout ' +
        'stderr /work/checks/check.fixture.module.stderr',
    );
  }, 300_000);

  test('refuses a review record that does not bind this candidate', () => {
    const { fixture } = sharedRelocation();
    const identity = candidateIdentityAt(fixture.repository, fixture.candidateRevision);
    const baseIdentity = candidateIdentityAt(fixture.repository, fixture.baseRevision);
    const cases: [string, (review: Record<string, unknown>) => void, string][] = [
      [
        'obligation',
        (review) => {
          review['obligationId'] = 'review.fixture.other';
        },
        'obligationId expected review.fixture.module received review.fixture.other',
      ],
      [
        'candidate identity',
        (review) => {
          review['candidateIdentity'] = baseIdentity;
        },
        `candidateIdentity expected ${identity} received ${baseIdentity}`,
      ],
      [
        'source base',
        (review) => {
          review['sourceBase'] = fixture.baseRevision;
        },
        `sourceBase expected ${fixture.candidateRevision} received ${fixture.baseRevision}`,
      ],
      [
        'generation',
        (review) => {
          review['generation'] = 2;
        },
        'generation expected 1 received 2',
      ],
    ];
    for (const [, mutate, expected] of cases) {
      // Proof: forcing each join false in turn let a review of another obligation, of the base
      // candidate identity, of the base source base and of generation 2 bind this candidate; every
      // negative received `Received function did not throw`.
      expect(() => {
        planWithReview(mutate);
      }).toThrow(`review record does not bind the candidate: ${expected}`);
    }
  }, 300_000);

  test('refuses a review whose subject, phases or trust scope do not bind the candidate', () => {
    const { fixture } = sharedRelocation();
    const identity = candidateIdentityAt(fixture.repository, fixture.candidateRevision);
    // Proof: forcing the subject comparison false let a review whose subject named all-`f`
    // content bind this candidate; this negative received `Received function did not throw`.
    expect(() => {
      planWithReview((review) => {
        const evidence = review['evidence'] as {
          protocolEvidence: { subject: { contentIdentity: string } };
        };
        evidence.protocolEvidence.subject.contentIdentity = 'f'.repeat(64);
      });
    }).toThrow(
      `review record does not bind the candidate: subject.contentIdentity expected ${identity} received ${'f'.repeat(64)}`,
    );

    // Proof: forcing the phase comparison false let a `censored` informed phase discharge the
    // review; this negative received `Received function did not throw`.
    expect(() => {
      planWithReview((review) => {
        const evidence = review['evidence'] as {
          phaseReceipts: { informed: { receipt: { status: string } } };
        };
        evidence.phaseReceipts.informed.receipt.status = 'censored';
      });
    }).toThrow('review record does not bind the candidate: phaseReceipts.informed.status');

    // Proof: forcing the scope comparison false let `local-cooperative` reach the authority trust
    // scope; this negative received `Received function did not throw`.
    expect(() => {
      planWithReview((review) => {
        const evidence = review['evidence'] as {
          receipt: { trust: { scope: string } };
        };
        evidence.receipt.trust.scope = 'local-cooperative';
      });
    }).toThrow('review record does not bind the candidate: trust.scope');
    // The unmutated record of the same fixture binds, so the refusals above are the mutations
    // rather than the fixture.
    expect(() => {
      planWithReview();
    }).not.toThrow();
  }, 300_000);

  test('refuses a review the base authority never stratified', () => {
    const { fixture, base } = sharedRelocation();
    const authority = decodeAuthority(
      readFileSync(join(base.directory, 'artifacts/authority.json')),
    );
    authority.audit.obligations = [];
    const identity = candidateIdentityAt(fixture.repository, fixture.candidateRevision);

    // Proof: replacing the R21 refusal with `previous?.riskStratum ?? 'risk.public-admission'`
    // invented a stratum for a review the base activation never stratified; this negative received
    // `Received function did not throw`.
    expect(() =>
      planRelocationActivation(
        sources({ baseAuthorityBytes: encodeJson(authority) }),
        [checkRun()],
        auditReview('review.fixture.module', fixture.candidateRevision, identity),
        attestation,
      ),
    ).toThrow('base authority has no obligation for review: review.fixture.module');
  }, 300_000);

  test('refuses a checkout that is not at the candidate revision, or is dirty', () => {
    const prepared = commandFixture();
    const parent = Bun.spawnSync(
      ['git', '-C', prepared.fixture.repository, 'rev-parse', 'HEAD~1'],
      { stderr: 'pipe', stdout: 'pipe' },
    );
    const head = Buffer.from(parent.stdout).toString('utf8').trim();
    Bun.spawnSync(['git', '-C', prepared.fixture.repository, 'checkout', '--quiet', head]);

    const detached = runPreparation(prepared);
    expect(detached.exitCode, detached.output).toBe(1);
    // Proof: forcing the R2 refusal false let the command read a checkout whose working files
    // were the parent commit's while every role came from the named SHA; this negative observed
    // `ENOENT: failed to open root directory: <candidate>/src/new`.
    expect(detached.output).toContain(
      `candidate checkout is not at the candidate revision: HEAD ${head} != ${prepared.fixture.candidateRevision}`,
    );

    Bun.spawnSync([
      'git',
      '-C',
      prepared.fixture.repository,
      'checkout',
      '--quiet',
      prepared.fixture.candidateRevision,
    ]);
    writeFileSync(join(prepared.fixture.repository, 'nx.json'), '{"targetDefaults":{},"x":1}\n');
    const dirty = runPreparation(prepared);
    expect(dirty.exitCode, dirty.output).toBe(1);
    // Proof: forcing the R3 refusal false ran the candidate's checks against the edited
    // `nx.json` while the receipts claimed the committed manifest, and the command prepared,
    // certified and tarred the activation; this negative expected exit 1 and received 0.
    expect(dirty.output).toContain('candidate checkout is dirty: nx.json');
    expect(existsSync(archivePath(prepared.fixture))).toBe(false);
  }, 300_000);

  test('refuses a trusted node module that is a symlink', () => {
    const prepared = commandFixture();
    const modules = join(prepared.fixture.workspace, 'linked-modules');
    mkdirSync(modules, { recursive: true });
    const installed = realpathSync(join(prepared.fixture.repository, 'node_modules'));
    for (const name of readdirSync(installed)) {
      symlinkSync(join(installed, name), join(modules, name));
    }
    Bun.spawnSync(['rm', join(prepared.fixture.repository, 'node_modules')]);
    symlinkSync(modules, join(prepared.fixture.repository, 'node_modules'), 'dir');

    const invocation = runPreparation(prepared);

    expect(invocation.exitCode, invocation.output).toBe(1);
    // Proof: forcing the R19 refusal false copied symlinked packages into the archive's
    // `trusted-node-modules`; this negative expected exit 1 and received 0 with a complete
    // archive.
    expect(invocation.output).toContain('trusted node module is absent or a symlink:');
    expect(existsSync(archivePath(prepared.fixture))).toBe(false);
  }, 300_000);

  test('refuses an activation its own launcher cannot certify', () => {
    const prepared = commandFixture({
      fixture: createRelocationCandidate({ minimumMode: 'observe' }),
    });

    const invocation = runPreparation(prepared);

    expect(invocation.exitCode, invocation.output).toBe(1);
    // Proof: forcing the R20 refusal false tarred an activation whose own observe-mode policy
    // the launcher had just refused to certify; this negative expected exit 1 and received 0.
    expect(invocation.output).toContain('prepared activation is not certified by its own launcher');
    expect(existsSync(archivePath(prepared.fixture))).toBe(false);
  }, 300_000);

  test('measures the skips a bun test check reports instead of claiming none', () => {
    const prepared = commandFixture({
      fixture: createRelocationCandidate({ skippingCheck: true }),
    });

    const invocation = runPreparation(prepared);

    expect(invocation.exitCode, invocation.output).toBe(1);
    // Proof: deriving the skip channel as `'none'` for every command left this Nx `bun test`
    // target's one skipped test unmeasured and the command prepared, certified and tarred a
    // complete activation (`Expected: 1 / Received: 0`); recording the measured skips but not
    // refusing them moved the failure to `prepared activation is not certified by its own
    // launcher`, which is admission refusing the same receipt later.
    expect(invocation.output).toContain(
      'check skipped work: check.fixture.module (bun test: 1 skip); stdout ',
    );
    expect(existsSync(archivePath(prepared.fixture))).toBe(false);
  }, 300_000);

  test('refuses a reviewed snapshot that is not a committed selection', () => {
    const { base, fixture } = sharedRelocation();
    const committed = relocationSources(fixture, base);
    const working: RelocationSources = {
      base: committed.base,
      candidate: {
        ...committed.candidate,
        reviewed: {
          ...committed.candidate.reviewed,
          selection: {
            kind: 'working',
            base: fixture.reviewedRevision,
            trackedSnapshot: 'a'.repeat(64),
            untrackedSnapshot: 'b'.repeat(64),
          },
        },
      },
    };

    // Proof: forcing the committed-selection refusal false read `revision` off a working
    // selection that has none; this negative observed `canonical JSON cannot serialize undefined`
    // instead of the named refusal.
    expect(() =>
      planRelocationActivation(
        working,
        [checkRun()],
        auditReview(
          'review.fixture.module',
          fixture.candidateRevision,
          candidateIdentityAt(fixture.repository, fixture.candidateRevision),
        ),
        attestation,
      ),
    ).toThrow('reviewed snapshot is not a committed selection: working');
  }, 300_000);

  test('refuses a work or destination path inside the candidate repository', () => {
    const prepared = commandFixture({ fixture: sharedRelocation().fixture });
    const inside = join(prepared.fixture.repository, 'relocation-inside');

    const work = runPreparation(prepared, ['--work', inside]);
    expect(work.exitCode, work.output).toBe(1);
    // Proof: forcing the containment refusal false wrote the rebuilt validator and every role
    // into the candidate tree and ran the checks against it; the refusal arrived only afterwards
    // from `prepareActivation`'s role-source guard — this negative observed `activation authority
    // source must be outside the candidate repository`.
    expect(work.output).toContain(`--work must be outside the candidate repository: ${inside}`);

    const destination = runPreparation(prepared, ['--destination', inside]);
    expect(destination.exitCode, destination.output).toBe(1);
    expect(destination.output).toContain(
      `--destination must be outside the candidate repository: ${inside}`,
    );
    expect(existsSync(inside)).toBe(false);
  }, 300_000);

  test('refuses a trusted node module the candidate has not installed', () => {
    const prepared = commandFixture();
    const empty = join(prepared.fixture.workspace, 'empty-modules');
    mkdirSync(empty, { recursive: true });
    Bun.spawnSync(['rm', join(prepared.fixture.repository, 'node_modules')]);
    symlinkSync(empty, join(prepared.fixture.repository, 'node_modules'), 'dir');

    const invocation = runPreparation(prepared);

    expect(invocation.exitCode, invocation.output).toBe(1);
    // Proof: rethrowing the lstat failure unwrapped reported a bare `ENOENT: no such file or
    // directory, lstat '<candidate>/node_modules/typescript'`, naming neither the refusal nor why
    // the archive wanted that package.
    expect(invocation.output).toContain('trusted node module is absent or a symlink:');
    expect(invocation.output).toContain('typescript');
    expect(existsSync(archivePath(prepared.fixture))).toBe(false);
  }, 300_000);

  test('refuses a preparation that attests to no resource lane or cwd identity', () => {
    const prepared = commandFixture({ fixture: sharedRelocation().fixture });
    const complete = [
      '--candidate-repository',
      prepared.fixture.repository,
      '--candidate-sha',
      prepared.fixture.candidateRevision,
      '--base-activation',
      prepared.base.directory,
      '--review-record',
      prepared.reviewPath,
      '--destination',
      prepared.destination,
      '--work',
      join(prepared.fixture.workspace, 'attestation-work'),
      '--candidate-policy',
      'docs/wiki-policy/policy.json',
      '--validator-entry',
      'src/new/cli.ts',
      '--resource-lane',
      'fixture.lane',
      '--cwd-identity',
      'fixture.repository',
    ];
    const without = (flag: string): string[] => {
      const index = complete.indexOf(flag);
      return [...complete.slice(0, index), ...complete.slice(index + 2)];
    };

    // Proof: restoring the `operator.tool-wiki-bootstrap` and `repository.candidate-checkout`
    // defaults let the tool write the operator's own attestation into every check receipt; each
    // negative observed `relocation activation: ...` at exit 0 instead of this refusal.
    expect(runCommand(without('--resource-lane')).output).toContain(
      'missing required flag: --resource-lane',
    );
    expect(runCommand(without('--cwd-identity')).output).toContain(
      'missing required flag: --cwd-identity',
    );
  }, 300_000);

  test('refuses unknown flags, missing flags and an already selected destination', () => {
    const prepared = commandFixture({ fixture: sharedRelocation().fixture });
    // Proof: forcing the unknown-flag refusal false let `--candidate-revision` pass unread and
    // the command prepared a whole activation from the defaults; this negative observed
    // `relocation activation: ...` at exit 0.
    expect(runPreparation(prepared, ['--candidate-revision', 'x']).output).toContain(
      'unknown flag: --candidate-revision',
    );
    // Proof: forcing the missing-flag refusal false let an absent flag stay undefined; this
    // negative observed `The "paths[0]" property must be of type string, got undefined`.
    expect(runCommand(['--candidate-repository', prepared.fixture.repository]).output).toContain(
      'missing required flag: --candidate-sha',
    );
    const destination = join(prepared.fixture.workspace, 'selected-destination');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'selected.json'), '{}\n');
    const invocation = runCommand([
      '--candidate-repository',
      prepared.fixture.repository,
      '--candidate-sha',
      prepared.fixture.candidateRevision,
      '--base-activation',
      prepared.base.directory,
      '--review-record',
      prepared.reviewPath,
      '--destination',
      destination,
      '--work',
      join(prepared.fixture.workspace, 'selected-work'),
      '--candidate-policy',
      'docs/wiki-policy/policy.json',
      '--validator-entry',
      'src/new/cli.ts',
      '--resource-lane',
      'fixture.lane',
      '--cwd-identity',
      'fixture.repository',
    ]);
    // Proof: forcing this refusal false prepared a second version into a root that already
    // carried `selected.json`, silently repointing it; this negative observed
    // `relocation activation: ...` at exit 0.
    expect(invocation.output).toContain(
      `activation destination already selects a version: ${destination}`,
    );
  }, 300_000);
});
